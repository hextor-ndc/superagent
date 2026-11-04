#!/usr/bin/env node
/**
 * A scripted ACP agent for the live tests (PLAN.md, ground rule 4): t3code runs it through its `acpRegistry` driver with
 * `source: "local"`, one process per thread plus short probe processes. It speaks ACP v1 (it answers `protocolVersion: 1`
 * without `info`, which puts t3code on its v1 path) as NDJSON JSON-RPC on stdio, and exits when stdin closes.
 *
 * Models are scenarios: `plain` (the default) and `alt` behave the same and name themselves in replies, so a test can see
 * which model a thread runs. What a turn does comes from markers in the user's text, run in the order they appear. In a
 * superagent worker's prompt (src/executor/render.ts) only the messages' JSON cards are read, since the assignment repeats
 * the request's text in its title and scope:
 * - none: reply `echo[<model>]: <text>`;
 * - `[slow N]`: stream for N ms; `session/cancel` ends the turn with stopReason `cancelled`;
 * - `[permission <kind>]`: ask `session/request_permission` for a tool call of that kind (execute, edit, read, ...);
 * - `[question]`: ask `elicitation/create` with one multiple-choice question, as t3code's dev replay agent does;
 * - `[fail]`: answer the prompt with a JSON-RPC error, which t3code records as a failed turn;
 * - `[crash]`: say a little, then exit with code 1 in the middle of the turn, as an agent process that dies would;
 * - `[crash once]`: crash as `[crash]` the first time a session's folder sees it, and do nothing at later turns: it leaves
 *   `.scripted-agent-crashed` in the folder, so a new agent process that takes over the thread does not crash again;
 * - `[worker]`: act as a superagent worker: read `.mcp.json` in the session's folder (src/executor/workspace.ts writes it),
 *   connect to its `superagent` server, acknowledge the request, and report ready at the end of the turn, after the turn's
 *   other markers. When tests/workload/worker-plan.mjs exists, its `runWorkerTurn` decides what the worker does instead: at
 *   the marker with `finish: false` (acknowledge, progress), and at the end of the turn with `finish: true` (ask, ready).
 * The reply lists what each marker gave, such as `permission execute: allowed` or `answer: {"choice":"Strict schemas"}`.
 *
 * With `SCRIPTED_AGENT_SIGNALS` set to a folder, a worker plays the synthetic workload's simulated work (tests/live/workload.spec.ts).
 * A worker turn is one whose text has a `[worker]` marker or starts the assignment (a `# Superagent ticket` heading), or any
 * later turn in a folder whose worker has a state file. A turn takes in its messages, then holds its run open until the test
 * writes `<folder>/<worktree name>.done`, as a long tool would. t3code steers a message into the held turn by cancelling the
 * turn (`session/cancel`) and prompting the same session again with only the new message, and the new turn holds in the
 * same way. Once the file is there, the turn does what comes at the end of the plan (ask, ready). The worker's state lives
 * in `<worktree name>.state.json`, in case a new agent process takes over the thread, and what it did in
 * `<worktree name>.json`, which the test reads: each turn's actions, the trigger ids of the message cards it took in, the
 * pull requests it opened (`SCRIPTED_AGENT_PULLS` is the URL prefix), its errors, and whether it holds and since when.
 *
 * Diagnostics go to `$SCRIPTED_AGENT_LOG` (appended) or stderr; stdout carries only protocol messages.
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'

const MODELS = (process.env.SCRIPTED_AGENT_MODELS || 'plain,alt').split(',').map(id => id.trim()).filter(Boolean)
  .map(modelId => ({ modelId, name: `Scripted ${modelId}` }))
const WORKER_PLAN = fileURLToPath(new URL('../workload/worker-plan.mjs', import.meta.url))
const SIGNALS = process.env.SCRIPTED_AGENT_SIGNALS || ''

const log = (...parts) => {
  const line = `[scripted-agent ${process.pid}] ${parts.map(part => typeof part === 'string' ? part : JSON.stringify(part)).join(' ')}\n`
  if (process.env.SCRIPTED_AGENT_LOG) appendFileSync(process.env.SCRIPTED_AGENT_LOG, line)
  else process.stderr.write(line)
}
const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
const notify = (sessionId, update) => send({ method: 'session/update', params: { sessionId, update } })
const say = (sessionId, text) => {
  for (const chunk of text.match(/[\s\S]{1,60}/g) ?? []) notify(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } })
}

let nextId = 1
/** Requests this agent sent to t3code, by id, waiting for their answers. */
const waiting = new Map()
/** sessionId -> { cwd, model, abort?: AbortController, worker?: { client, acked: Set } } */
const sessions = new Map()

function request(method, params, signal) {
  const id = nextId++
  send({ id, method, params })
  return new Promise(resolve => {
    waiting.set(id, resolve)
    signal?.addEventListener('abort', () => { waiting.delete(id); resolve({ cancelledByTurn: true }) }, { once: true })
  })
}

/** The person's text: t3code wraps the first turn in `<user_request>` and appends `<runtime_info>` to every turn. */
function userText(prompt) {
  const text = prompt.filter(block => block.type === 'text').map(block => block.text).join('\n')
  const wrapped = /<user_request>\n?([\s\S]*?)\n?<\/user_request>/.exec(text)
  if (wrapped) return wrapped[1].trim()
  const at = text.indexOf('<runtime_info>')
  return (at >= 0 ? text.slice(0, at) : text).trim()
}
const MARKERS = /\[(slow \d+|permission [a-z_]+|question|fail|crash(?: once)?|worker)\]/g
/** The message cards in a worker's prompt (src/executor/render.ts): JSON objects with a `trigger_id`. */
function cards(text) {
  return [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].flatMap(match => {
    try { const value = JSON.parse(match[1]); return (Array.isArray(value) ? value : [value]).filter(card => typeof card?.trigger_id === 'string') }
    catch { return [] }
  })
}
/** The text markers are read from: the `text` of each message card in a worker's prompt, else the whole text. */
function markerText(text) {
  const found = cards(text).filter(card => typeof card.text === 'string')
  return found.length ? found.map(card => card.text).join('\n') : text
}

const sleep = (ms, signal) => new Promise(resolve => {
  const timer = setTimeout(resolve, ms)
  signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
})

async function runTurn(id, { sessionId, prompt }) {
  const session = sessions.get(sessionId)
  if (!session) return send({ id, error: { code: -32602, message: `unknown session ${sessionId}` } })
  const abort = new AbortController()
  session.abort = abort
  const text = userText(prompt ?? [])
  /** `finish` is what a worker does at the end of the turn, once the turn's other markers are done. */
  const turn = { outcomes: [], cancelled: false, finish: undefined }
  const markers = [...markerText(text).matchAll(MARKERS)].map(match => match[1])
  log('prompt', { sessionId, model: session.model, markers, chars: text.length })
  if (SIGNALS && (markers.includes('worker') || /^# Superagent ticket /m.test(text) || existsSync(signal(session, 'state.json')))) {
    // One turn at a time per session, also when t3code prompts again while a cancelled turn still finishes its tool calls.
    const previous = session.turn ?? Promise.resolve()
    const current = previous.then(() => heldTurn(session, text, abort.signal))
    session.turn = current.catch(() => {})
    try {
      await current
    } catch (error) {
      log('turn failed', String(error?.stack ?? error))
      return send({ id, error: { code: -32603, message: String(error?.message ?? error) } })
    } finally {
      if (session.abort === abort) session.abort = undefined
    }
    if (abort.signal.aborted) return send({ id, result: { stopReason: 'cancelled' } })
    say(sessionId, `worked[${session.model}]`)
    return send({ id, result: { stopReason: 'end_turn' } })
  }
  try {
    for (const marker of markers) {
      if (abort.signal.aborted || turn.cancelled) break
      if (marker === 'fail') return send({ id, error: { code: -32603, message: 'scripted failure' } })
      if (marker === 'crash' || marker === 'crash once') {
        const crashed = join(session.cwd, CRASHED)
        if (marker === 'crash once' && existsSync(crashed)) { turn.outcomes.push('crash once: already crashed'); continue }
        if (marker === 'crash once') writeFileSync(crashed, `${process.pid}\n`)
        await crash(sessionId)
      }
      if (marker.startsWith('slow ')) {
        const end = Date.now() + Number(marker.slice(5))
        while (Date.now() < end && !abort.signal.aborted) { say(sessionId, '.'); await sleep(Math.min(100, end - Date.now()), abort.signal) }
        turn.outcomes.push(abort.signal.aborted ? 'slow: cancelled' : 'slow: done')
      } else if (marker.startsWith('permission ')) {
        const result = await permission(sessionId, marker.slice(11), abort.signal)
        turn.outcomes.push(`permission ${marker.slice(11)}: ${result}`)
        // t3code answers `cancelled` when the turn is interrupted while it waits, as its dev replay agent expects.
        if (result === 'cancelled') turn.cancelled = true
      } else if (marker === 'question') {
        turn.outcomes.push(await question(sessionId, abort.signal))
      } else if (marker === 'worker') {
        turn.outcomes.push(await workerTurn(session, text, turn))
      }
    }
    // A worker reports at the end of its turn, after whatever else the turn waited on.
    if (turn.finish && !abort.signal.aborted && !turn.cancelled) await turn.finish()
  } catch (error) {
    log('turn failed', String(error?.stack ?? error))
    return send({ id, error: { code: -32603, message: String(error?.message ?? error) } })
  } finally {
    if (session.abort === abort) session.abort = undefined
  }
  if (abort.signal.aborted || turn.cancelled) return send({ id, result: { stopReason: 'cancelled' } })
  say(sessionId, markers.length ? `done[${session.model}]: ${turn.outcomes.join('; ')}` : `echo[${session.model}]: ${text}`)
  send({ id, result: { stopReason: 'end_turn' } })
}

/** The file `[crash once]` leaves in a session's folder. */
const CRASHED = '.scripted-agent-crashed'
/** Ends this process mid-turn: some output first, so t3code has seen the turn running, then exit code 1 without an answer. */
async function crash(sessionId) {
  say(sessionId, 'about to crash')
  log('crash', sessionId)
  await new Promise(resolve => setTimeout(resolve, 300))
  process.exit(1)
}

async function permission(sessionId, kind, signal) {
  const toolCallId = `call-${randomUUID()}`
  const title = kind === 'execute' ? 'echo hi' : `${kind} README.md`
  notify(sessionId, { sessionUpdate: 'tool_call', toolCallId, title, kind, status: 'pending',
    rawInput: kind === 'execute' ? { command: 'echo hi' } : { path: 'README.md' } })
  const answer = await request('session/request_permission', {
    sessionId,
    toolCall: { toolCallId, title, kind, status: 'pending' },
    options: [
      { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
      { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
    ],
  }, signal)
  const outcome = answer?.outcome
  const result = answer?.cancelledByTurn || outcome?.outcome !== 'selected' ? 'cancelled' : outcome.optionId.startsWith('allow') ? 'allowed' : 'rejected'
  log('permission', kind, JSON.stringify(answer))
  notify(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: result === 'allowed' ? 'completed' : 'failed',
    content: [{ type: 'content', content: { type: 'text', text: result === 'allowed' ? 'hi' : result } }] })
  return result
}

/** One multiple-choice question, in the frame of t3code's `acp_elicitation` fixture. */
const QUESTION = {
  mode: 'form',
  message: 'Choose the fixture preference.',
  requestedSchema: { type: 'object', title: 'Fixture preference', required: ['choice'],
    properties: { choice: { type: 'string', title: 'Fixture', description: 'Should this fixture prefer strict schemas or UI flexibility?',
      enum: ['Strict schemas', 'UI flexibility'] } } },
}
async function question(sessionId, signal) {
  const answer = await request('elicitation/create', { sessionId, ...QUESTION }, signal)
  // With the session's folder, so a test can tell which thread got which answer.
  log('question', { cwd: sessions.get(sessionId)?.cwd, answer })
  if (answer?.cancelledByTurn) return 'question: cancelled'
  return answer?.action === 'accept' ? `answer: ${JSON.stringify(answer.content ?? {})}` : `question: ${answer?.action ?? 'no answer'}`
}

/** The worker's MCP client, from the `superagent` server in the session folder's `.mcp.json`. */
async function workerClient(session) {
  if (session.worker) return session.worker
  const config = JSON.parse(readFileSync(join(session.cwd, '.mcp.json'), 'utf8'))
  const url = config.mcpServers?.superagent?.url
  if (!url) throw new Error(`no superagent MCP server in ${session.cwd}/.mcp.json`)
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  const client = new Client({ name: 'scripted-worker', version: '0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url)))
  session.worker = { client, acked: new Set() }
  return session.worker
}
async function callTool(worker, name, args) {
  const result = await worker.client.callTool({ name, arguments: args })
  log('tool', name, JSON.stringify(args).slice(0, 300), result.isError ? 'ERROR' : 'ok', JSON.stringify(result.structuredContent ?? result.content).slice(0, 300))
  if (result.isError) throw new Error(`${name}: ${result.content?.[0]?.text ?? 'failed'}`)
  return result.structuredContent
}
let plan
async function workerPlan() {
  if (plan === undefined) plan = existsSync(WORKER_PLAN) ? await import(pathToFileURL(WORKER_PLAN).href).catch(error => { log('worker-plan', String(error)); return null }) : null
  return plan
}
async function workerTurn(session, text, turn) {
  const worker = await workerClient(session)
  const tool = (name, args) => callTool(worker, name, args)
  const module = await workerPlan()
  if (module?.runWorkerTurn) {
    const { did } = await module.runWorkerTurn({ prompt: text, callTool: tool, finish: false })
    turn.finish = async () => { await module.runWorkerTurn({ prompt: text, callTool: tool, finish: true }) }
    return `worker: ${did.join(', ') || 'nothing'}`
  }
  const triggerId = /"trigger_id":\s*"([^"]+)"/.exec(text)?.[1]
  if (triggerId && !worker.acked.has(triggerId)) {
    await tool('orchestrator_ack', { trigger_id: triggerId, text: 'On it.' })
    worker.acked.add(triggerId)
  }
  turn.finish = () => tool('orchestrator_report', { state: 'ready', summary: `Scripted worker finished: ${turn.outcomes.join('; ')}`.slice(0, 1000) })
  return 'worker: acked'
}

/** A file of this worker's in the signals folder, named after its worktree. */
const signal = (session, suffix) => join(SIGNALS, `${basename(session.cwd)}.${suffix}`)
function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return undefined }
}
/** Writes and renames, so the test never reads half a file. */
function writeJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(value))
  renameSync(temporary, path)
}

/**
 * A worker turn of the synthetic workload: take in the messages (worker-plan.mjs with `finish: false`), hold the run until the
 * test says the simulated work is over or t3code cancels the turn, then finish (`finish: true`). Each step is written to the
 * worker's status file for the test.
 */
async function heldTurn(session, text, cancelled) {
  const statusFile = signal(session, 'json')
  const stateFile = signal(session, 'state.json')
  const done = signal(session, 'done')
  const status = readJson(statusFile) ?? { cwd: session.cwd, turns: [], pulls: [], errors: [], busy: false, holding: false, holdingSince: 0 }
  const report = changes => { Object.assign(status, changes, { at: Date.now() }); writeJson(statusFile, status) }
  report({ busy: true, holding: false })
  try {
    const module = await workerPlan()
    if (!module?.runWorkerTurn) throw new Error(`no worker plan at ${WORKER_PLAN}`)
    const worker = await workerClient(session)
    const state = readJson(stateFile) ?? module.newWorkerState()
    const openPull = async (number, title) => {
      status.pulls.push({ number, title })
      return `${process.env.SCRIPTED_AGENT_PULLS ?? 'https://github.com/acme/widgets/pull/'}${number}`
    }
    const step = async finish => {
      const result = await module.runWorkerTurn({ prompt: text, callTool: (name, args) => callTool(worker, name, args), state, finish, openPull })
      writeJson(stateFile, state)
      status.label = result.label
      status.minutes = state.plan?.minutes
      if (result.did.length) status.turns.push({ at: Date.now(), did: result.did })
      report({})
    }
    await step(false)
    status.taken = [...new Set([...status.taken ?? [], ...cards(text).map(card => card.trigger_id)])]
    report({})
    if (!existsSync(done) && !cancelled.aborted) {
      report({ holding: true, holdingSince: Date.now() })
      while (!existsSync(done) && !cancelled.aborted) await sleep(20, cancelled)
      report({ holding: false })
    }
    if (!cancelled.aborted) await step(true)
  } catch (error) {
    status.errors.push(String(error?.message ?? error))
    throw error
  } finally {
    report({ busy: false, holding: false })
  }
}

const handlers = {
  initialize: () => ({
    protocolVersion: 1,
    agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: false },
      mcpCapabilities: { http: false, sse: false } },
    authMethods: [],
    agentInfo: { name: 'superagent-scripted-agent', version: '1' },
  }),
  'session/new': params => {
    const sessionId = `scripted-${randomUUID()}`
    sessions.set(sessionId, { cwd: params.cwd ?? process.cwd(), model: MODELS[0].modelId })
    log('session/new', { cwd: params.cwd, mcpServers: (params.mcpServers ?? []).map(server => server.name) })
    return { sessionId, models: { currentModelId: MODELS[0].modelId, availableModels: MODELS } }
  },
  'session/set_model': params => {
    if (!MODELS.some(model => model.modelId === params.modelId)) throw Object.assign(new Error(`unknown model ${params.modelId}`), { code: -32602 })
    const session = sessions.get(params.sessionId)
    if (session) session.model = params.modelId
    return {}
  },
  'session/set_mode': () => ({}),
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  if (!line.trim()) return
  let message
  try { message = JSON.parse(line) } catch { return log('not JSON', line.slice(0, 200)) }
  if (message.method === undefined) {
    const resolve = waiting.get(message.id)
    waiting.delete(message.id)
    return resolve?.(message.result ?? (message.error ? { error: message.error } : null))
  }
  if (message.method === 'session/cancel') {
    log('session/cancel', message.params?.sessionId)
    return sessions.get(message.params?.sessionId)?.abort?.abort()
  }
  if (message.id === undefined || message.id === null) return
  if (message.method === 'session/prompt') {
    return void runTurn(message.id, message.params)
  }
  const handler = handlers[message.method]
  if (!handler) return send({ id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } })
  try { send({ id: message.id, result: handler(message.params ?? {}) }) }
  catch (error) { send({ id: message.id, error: { code: error.code ?? -32603, message: String(error.message ?? error) } }) }
}).on('close', () => process.exit(0))
