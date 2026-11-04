/**
 * Points 1–4 end to end against a real, isolated `t3 serve` (tests/live/t3-server.ts): the whole Runtime with the rules
 * Router and the console Source, its real HTTP server, and worker threads that run the scripted ACP agent in real
 * worktrees. The agent plays the worker through the `superagent` MCP server its `.mcp.json` names (tests/live/scripted-agent.mjs),
 * following tests/workload/worker-plan.mjs: a request labelled `[R01]` is acknowledged with "Working on R01." and ends with
 * "R01 done.". It also covers approvals and questions that a worker's thread waits on in t3code, which reach the attention queue
 * (an approval is answered as t3code's web app does, `T3Server.answerApproval`), and a worker whose agent process crashes.
 *
 * Run with `T3_LIVE=1 npx vitest run tests/live`.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Runtime, type TicketView } from '../../src/app/runtime.ts'
import { loadConfig } from '../../src/config.ts'
import { startHttp } from '../../src/http/server.ts'
import { McpT3Client, type ThreadRead } from '../../src/t3/client.ts'
import { eventually, live, skipReason, startT3, type Access, type T3Server } from './t3-server.ts'

const TEST_MS = 120_000
const data = (result: unknown) => (result as { structuredContent: Record<string, unknown> }).structuredContent
const texts = (read: ThreadRead) => read.items.map(item => `${item.type}: ${item.text}`)
/** What the scripted agents that ran in a folder were told when their questions were answered, from the agent log. */
const answersIn = (log: string, cwd: string) => readFileSync(log, 'utf8').split('\n').flatMap(line => {
  const at = line.indexOf('] question ')
  if (at < 0) return []
  const seen = JSON.parse(line.slice(at + 11)) as { cwd?: string; answer: unknown }
  return seen.cwd === cwd ? [seen.answer] : []
})

interface Superagent { runtime: Runtime; t3: McpT3Client; http: Server; base: string; console: Client; errors: string[]; close(): Promise<void> }

describe.skipIf(!live)(`superagent on a real t3code${live ? '' : ` (skipped: ${skipReason})`}`, () => {
  let server: T3Server
  let made: Superagent | undefined
  let n = 0

  /** The super agent as main.ts builds it, from the environment, with this suite's t3code and a fresh database. */
  async function superagent(access: Access): Promise<Superagent> {
    const errors: string[] = []
    const id = ++n
    const token = await server.token(access)
    const config = { ...loadConfig({ SUPERAGENT_PROJECT_ROOT: server.checkout, SUPERAGENT_MODEL: 'scripted/plain', SUPERAGENT_ROUTER: 'rules',
      SUPERAGENT_WATCHDOG_MINUTES: '0', SUPERAGENT_OPERATOR: 'hector', SUPERAGENT_CONSOLE_TOKEN: `console-${id}`, SUPERAGENT_STATE_DIR: join(server.dir, `state-${id}`),
      SUPERAGENT_WORKTREE_ROOT: join(server.dir, `worktrees-${id}`), T3_MCP_URL: server.url, T3_MCP_TOKEN: token }),
    database: ':memory:', port: 0, log: (message: string, error?: unknown) => { errors.push(`${message} ${error instanceof Error ? error.message : error ?? ''}`) } }
    const t3 = new McpT3Client({ url: config.t3Url, token: config.t3Token, ...config.model ? { modelSelection: config.model } : {} })
    const project = (await t3.listProjects()).find(item => resolve(item.workspaceRoot) === config.projectRoot)
    expect(project?.id).toBe(server.projectId)
    const runtime = new Runtime(config, t3, { id: project!.id, root: config.projectRoot },
      { waitMs: 2000, idlePollMs: 500, continueAfterMs: 1000, pendingCheckMs: 1000 })
    const http = await startHttp(runtime, 0)
    const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
    // The public URL is known once the server listens; the scripted agents reach it on loopback.
    config.publicUrl = base
    runtime.start()
    const console = new Client({ name: 'console', version: '0' })
    await console.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/console/${config.consoleToken}`)))
    return { runtime, t3, http, base, console, errors, close: async () => {
      await console.close(); http.close(); await runtime.stop(); await t3.close()
    } }
  }
  const call = async (agent: Superagent, name: string, args: Record<string, unknown> = {}) => {
    const result = await agent.console.callTool({ name, arguments: args })
    if (result.isError) throw new Error(`${name}: ${JSON.stringify(result.content)}`)
    return data(result)
  }
  /** The one Ticket of a request, once its worker's thread exists. */
  const ticketOf = async (agent: Superagent) => eventually(async () => {
    const ticket = agent.runtime.repo.tickets.list()[0]
    return ticket && agent.runtime.executor.thread(ticket.id)?.threadId ? ticket : undefined
  }, 'the worker thread', 60_000)
  const attention = async (agent: Superagent) => (await call(agent, 'superagent_attention')).tickets as TicketView[]

  beforeAll(async () => { server = await startT3() }, TEST_MS)
  afterEach(async () => { await made?.close(); made = undefined }, 30_000)
  afterAll(async () => { await server?.close() }, 30_000)

  it('runs a console request in a real worktree until its worker reports ready', async () => {
    const agent = made = await superagent('full-access')
    // Point 2: the console is a scratch thread with a folder, which gets the console MCP server.
    await agent.runtime.ensureConsole()
    const consoleThread = await agent.t3.read(agent.runtime.console!.threadId, { limit: 1 })
    expect(readFileSync(join(consoleThread.thread.worktreePath!, '.mcp.json'), 'utf8')).toContain(`/mcp/console/console-${n}`)

    await call(agent, 'superagent_request', { text: '[R01] Tidy the README [worker]' })
    const ticket = await ticketOf(agent)
    const entry = agent.runtime.executor.thread(ticket.id)!
    // Point 1: its own thread in a real worktree of the checkout, on the scripted model.
    expect(execFileSync('git', ['worktree', 'list'], { cwd: server.checkout, encoding: 'utf8' })).toContain(entry.worktreePath)
    expect(existsSync(join(entry.worktreePath, '.mcp.json'))).toBe(true)
    const done = await eventually(async () => agent.runtime.repo.tickets.get(ticket.id)?.ended, 'the ticket to end', 60_000)
    expect(done.outcome).toBe('completed')
    const read = await agent.t3.read(entry.threadId!)
    expect(read.thread).toMatchObject({ title: `[T-${ticket.id.slice(0, 8)}] ${ticket.title}`, worktreePath: entry.worktreePath, branch: entry.branch,
      providerInstanceId: 'scripted', model: 'plain' })
    // The worker acknowledged the request and reported ready through its MCP tools.
    const messages = agent.runtime.outbox.list(record => record.message.ticketId === ticket.id).map(record => record.message.text)
    expect(messages.some(text => text.startsWith('Working on R01.'))).toBe(true)
    // Point 4: the console gets the result with the thread link.
    const result = await eventually(async () => ((await call(agent, 'superagent_messages')).messages as { text: string }[])
      .find(message => message.text.startsWith('Done: R01 done.')), 'the Done reply')
    expect(result.text).toContain(`[Open in T3 Code](${entry.link})`)
    expect(entry.link).toMatch(new RegExp(`^${server.origin}/`))
    expect(await attention(agent)).toEqual([])
    expect(agent.errors).toEqual([])
  }, TEST_MS)

  it('shows a worker that waits on an approval as person/approve, until it is stopped', async () => {
    // The CLI-issued token caps every thread at approval-required, so the agent's command needs a person's approval.
    const agent = made = await superagent('approval-required')
    await call(agent, 'superagent_request', { text: '[R02] Run the build [worker] [permission execute]' })
    const ticket = await ticketOf(agent)
    const entry = agent.runtime.executor.thread(ticket.id)!
    const waiting = await eventually(async () => (await attention(agent)).find(view => view.id === ticket.id && view.stage === 'person/approve'),
      'person/approve in the attention queue', 60_000)
    expect(waiting.pending).toMatchObject({ approvals: [{ text: 'echo hi' }], questions: [] })
    expect(waiting.link).toBe(entry.link)
    expect(((await call(agent, 'superagent_status')).waiting_for_a_person)).toBe(1)
    // Approvals are not answered from the console; the refusal names T3 Code and links the thread.
    const refused = await agent.console.callTool({ name: 'superagent_answer', arguments: { ticket_id: ticket.id, text: 'yes' } })
    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused.content)).toContain('T3 Code')
    // t3code agrees: the thread runs on, and waits on one request.
    expect((await agent.t3.read(entry.threadId!, { limit: 1 })).thread).toMatchObject({ status: 'running', pendingRequestCount: 1 })

    expect(await call(agent, 'superagent_stop', { ticket_id: ticket.id })).toMatchObject({ stopped: true, outcome: 'stopped' })
    await eventually(async () => (await agent.t3.read(entry.threadId!, { limit: 1 })).thread.status === 'interrupted', 'the thread to stop')
    expect(await agent.t3.pendingRequests(entry.threadId!)).toEqual([])
    expect(await attention(agent)).toEqual([])
  }, TEST_MS)

  it('answers a question the worker\'s thread waits on through t3code, and the turn completes', async () => {
    const agent = made = await superagent('full-access')
    await call(agent, 'superagent_request', { text: '[R03] Pick a fixture style [worker] [question]' })
    const ticket = await ticketOf(agent)
    const entry = agent.runtime.executor.thread(ticket.id)!
    const waiting = await eventually(async () => (await attention(agent)).find(view => view.id === ticket.id && view.stage === 'person/question'),
      'person/question in the attention queue', 60_000)
    expect(waiting.pending!.questions).toMatchObject([{ id: 'choice', options: [{ label: 'Strict schemas' }, { label: 'UI flexibility' }] }])
    // Typed in lower case: superagent sends the option's label, and the agent gets exactly that.
    expect(await call(agent, 'superagent_answer', { ticket_id: ticket.id, text: 'strict schemas' }))
      .toMatchObject({ delivered: 't3-question', request_id: waiting.pending!.questions[0]!.requestId })
    await eventually(async () => answersIn(server.agentLog, entry.worktreePath).length > 0, 'the agent to get the answer')
    expect(answersIn(server.agentLog, entry.worktreePath)).toEqual([{ action: 'accept', content: { choice: 'Strict schemas' } }])
    // The agent gets the answer in the same turn and only then reports ready, so the Ticket completes.
    const done = await eventually(async () => agent.runtime.repo.tickets.get(ticket.id)?.ended, 'the ticket to end', 60_000)
    expect(done.outcome).toBe('completed')
    expect(agent.runtime.outbox.list(record => record.message.ticketId === ticket.id).map(record => record.message.text)
      .find(text => text.startsWith('Done:'))).toContain('R03 done.')
    const asked = (await agent.t3.read(entry.threadId!, { view: 'activity', limit: 100 })).items.find(item => item.type === 'user_input_request')
    expect(asked).toMatchObject({ status: 'completed' })
    // The ended Ticket's stop may land before the agent's last words, so only the end of the run is checked.
    await eventually(async () => (await agent.t3.read(entry.threadId!, { limit: 1 })).thread.activeRunId === null, 'the turn to end')
    expect(texts(await agent.t3.read(entry.threadId!))[0]).toContain('[R03] Pick a fixture style [worker] [question]')
    expect(await attention(agent)).toEqual([])
  }, TEST_MS)

  it('lets a person approve in t3code\'s web app, and the worker goes on to its ready report', async () => {
    const agent = made = await superagent('approval-required')
    await call(agent, 'superagent_request', { text: '[R05] Run the build [worker] [permission execute]' })
    const ticket = await ticketOf(agent)
    const entry = agent.runtime.executor.thread(ticket.id)!
    const waiting = await eventually(async () => (await attention(agent)).find(view => view.id === ticket.id && view.stage === 'person/approve'),
      'person/approve in the attention queue', 60_000)
    const [approval] = waiting.pending!.approvals
    expect(approval).toMatchObject({ text: 'echo hi' })
    // A person approves in T3 Code; superagent has no part in it and learns of it from the thread.
    await server.answerApproval(entry.threadId!, approval!.requestId, 'accept')
    const done = await eventually(async () => agent.runtime.repo.tickets.get(ticket.id)?.ended, 'the ticket to end', 60_000)
    expect(done.outcome).toBe('completed')
    expect(agent.runtime.outbox.list(record => record.message.ticketId === ticket.id).map(record => record.message.text)
      .find(text => text.startsWith('Done:'))).toContain('R05 done.')
    const activity = (await agent.t3.read(entry.threadId!, { view: 'activity', limit: 100 })).items
    expect(activity.find(item => item.type === 'approval_request')).toMatchObject({ status: 'completed' })
    expect(await agent.t3.pendingRequests(entry.threadId!)).toEqual([])
    expect(await attention(agent)).toEqual([])
    expect(agent.runtime.executor.pending(ticket.id)).toEqual([])
    expect(agent.errors).toEqual([])
  }, TEST_MS)

  it('tells a worker whose agent process crashed to go on, until t3code starts a new agent and it reports ready', async () => {
    const agent = made = await superagent('full-access')
    // The agent acknowledges, reports progress, and exits in the middle of the turn; the agent t3code starts later does not crash.
    await call(agent, 'superagent_request', { text: '[R04] Survive a crash [worker] [crash once]' })
    const ticket = await ticketOf(agent)
    const entry = agent.runtime.executor.thread(ticket.id)!
    // Never stuck: the Ticket ends, or its worker is reported failed for a person.
    const settled = await eventually(async () => {
      const now = agent.runtime.repo.tickets.get(ticket.id)
      return now?.ended || now?.assignments.at(-1)?.report?.state === 'failed' ? now : undefined
    }, 'the ticket to end or fail', 90_000)
    expect(settled.ended?.outcome, settled.assignments.at(-1)?.report?.summary).toBe('completed')
    expect(agent.runtime.outbox.list(record => record.message.ticketId === ticket.id).map(record => record.message.text)
      .find(text => text.startsWith('Done:'))).toContain('R04 done.')
    // t3code reports the crash as a failed run, and the next two runs fail to start (tests/live/contract.spec.ts): superagent
    // told the worker to go on three times, the most it does, and the third reached a new agent process.
    const sent = (await agent.t3.read(entry.threadId!, { limit: 100 })).items.filter(item => item.type === 'user_message').map(item => item.text)
    expect(sent.filter(text => text?.startsWith('Your previous turn failed with an error.'))).toHaveLength(3)
    const errors = (await agent.t3.read(entry.threadId!, { view: 'activity', limit: 100 })).items.filter(item => item.type === 'error').map(item => item.text)
    expect(errors).toEqual(['Provider turn failed.', expect.stringContaining('could not start this turn'), expect.stringContaining('could not start this turn')])
    expect(readFileSync(server.agentLog, 'utf8').split('\n').filter(line => line.includes(`session/new {"cwd":"${entry.worktreePath}"`))).toHaveLength(2)
    expect(await attention(agent)).toEqual([])
    expect(agent.errors).toEqual([])
  }, TEST_MS)

  it('reports a worker whose agent keeps crashing as failed, for a person, after telling it to go on three times', async () => {
    const agent = made = await superagent('full-access')
    // Every agent process crashes: the new one t3code starts gets the request again in the thread's history.
    await call(agent, 'superagent_request', { text: '[R06] Crash every time [worker] [crash]' })
    const ticket = await ticketOf(agent)
    const failed = await eventually(async () => (await attention(agent)).find(view => view.id === ticket.id && view.stage === 'person/failed'),
      'person/failed in the attention queue', 90_000)
    expect(failed.summary).toBe('The worker\'s turn failed 4 times in a row in T3 Code. Open its thread to see the error.')
    expect(agent.runtime.repo.tickets.get(ticket.id)?.ended).toBeUndefined()
    const entry = agent.runtime.executor.thread(ticket.id)!
    const errors = (await agent.t3.read(entry.threadId!, { view: 'activity', limit: 100 })).items.filter(item => item.type === 'error').map(item => item.text)
    expect(errors).toEqual(['Provider turn failed.', expect.stringContaining('could not start this turn'), expect.stringContaining('could not start this turn'),
      'Provider turn failed.'])
    expect(agent.runtime.executor.busySince(ticket.id)).toBeUndefined()
    expect(agent.errors).toEqual([])
  }, TEST_MS)
})
