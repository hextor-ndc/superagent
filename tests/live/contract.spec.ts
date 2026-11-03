/**
 * PLAN.md, ground rule 4: the contract between `McpT3Client` and a real `t3 serve`, pinned before moving to a new t3code
 * release. Every T3Client method runs against an isolated server (tests/live/t3-server.ts) whose threads run the scripted
 * ACP agent (tests/live/scripted-agent.mjs). `link_pull_requests` is only checked against the tool list: linking may
 * reach GitHub with the operator's credentials.
 *
 * Run with `T3_LIVE=1 npx vitest run tests/live`. Comments marked "Observed" record t3code 0.1.6 behaviour that the design
 * or the fake did not expect.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { McpT3Client, T3Error, TERMINAL, type ThreadRead } from '../../src/t3/client.ts'
import { INSTANCE, live, poll, skipReason, startT3, type Access, type T3Server } from './t3-server.ts'

const TEST_MS = 120_000
/** Tool calls the clients of this suite sent, to check against t3code's input schemas. */
const sent: { tool: string; args: Record<string, unknown> }[] = []
const recording: typeof fetch = async (input, init) => {
  if (typeof init?.body === 'string') {
    try {
      const message = JSON.parse(init.body) as { method?: string; params?: { name: string; arguments?: Record<string, unknown> } }
      if (message.method === 'tools/call' && message.params) sent.push({ tool: message.params.name, args: message.params.arguments ?? {} })
    } catch { /* not JSON-RPC */ }
  }
  return fetch(input, init)
}

const error = (promise: Promise<unknown>) => promise.then(() => undefined, (caught: unknown) => caught as T3Error)
const settle = async (client: McpT3Client, threadId: string, ms = 30_000) => {
  const end = Date.now() + ms
  for (;;) {
    const result = await client.wait(threadId, 5000)
    if (!result.timedOut && TERMINAL.has(result.status)) return result
    if (Date.now() > end) throw new Error(`thread ${threadId} still ${result.status}`)
  }
}
const texts = (read: ThreadRead) => read.items.map(item => `${item.type}: ${item.text}`)

describe.skipIf(!live)(`t3code /mcp contract${live ? '' : ` (skipped: ${skipReason})`}`, () => {
  let server: T3Server, full: McpT3Client, approval: McpT3Client
  let worktrees = 0
  const client = async (access: Access, model = 'plain') =>
    new McpT3Client({ url: server.url, token: await server.token(access), modelSelection: { instanceId: INSTANCE, model }, fetch: recording })
  /** A real `git worktree add` in the project's checkout, which t3code accepts for `existing_worktree`. */
  const worktree = () => {
    const name = `w${++worktrees}`
    const path = join(server.dir, 'worktrees', name)
    execFileSync('git', ['worktree', 'add', '-q', '-b', `agent/${name}`, path, 'HEAD'], { cwd: server.checkout })
    return { path, branch: `agent/${name}` }
  }
  const launch = async (as: McpT3Client, message: string, extra: { runtimeMode?: string; clientRequestId?: string } = {}) => {
    const { path, branch } = worktree()
    const launched = await as.launch({ projectId: server.projectId, title: `[T-${worktrees}] ${message.slice(0, 30)}`, message, worktreePath: path, branch,
      clientRequestId: extra.clientRequestId ?? `launch:${worktrees}`, ...extra.runtimeMode ? { runtimeMode: extra.runtimeMode } : {} })
    return { ...launched, path, branch }
  }

  beforeAll(async () => {
    server = await startT3()
    full = await client('full-access')
    approval = await client('approval-required')
  }, TEST_MS)
  afterAll(async () => {
    await full?.close(); await approval?.close()
    await server?.close()
  }, 30_000)

  it('offers every tool McpT3Client uses, including link_pull_request in place of link_pull_requests', async () => {
    const raw = new Client({ name: 'contract', version: '0' })
    await raw.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: `Bearer ${await server.token('full-access')}` } } }))
    const { tools } = await raw.listTools()
    await raw.close()
    const names = tools.map(tool => tool.name)
    for (const name of ['t3_project_list', 't3_thread_launch', 't3_thread_send', 't3_thread_wait', 't3_thread_read', 't3_thread_interrupt', 't3_thread_organize',
      't3_pending_request', 'link_pull_request']) expect(names).toContain(name)
    // Observed: there is no plural `link_pull_requests`; the singular tool takes one `url` per call.
    expect(names).not.toContain('link_pull_requests')
    const link = tools.find(tool => tool.name === 'link_pull_request')!
    expect(Object.keys(link.inputSchema.properties ?? {})).toEqual(expect.arrayContaining(['threadId', 'url']))
    // Observed: t3_pending_request advertises no outputSchema (its result is a union), so the client reads structuredContent.
    expect(tools.find(tool => tool.name === 't3_pending_request')!.outputSchema).toBeUndefined()
  }, TEST_MS)

  it('lists every project across pages, so the checkout is found among more than 20', async () => {
    // Creating projects needs a full-access client; the CLI-issued token is refused.
    expect(await error(approval.call('t3_project_create', { title: 'nope', workspaceRoot: server.dir }))).toMatchObject({ code: 'capability_denied', transient: false })
    for (let n = 0; n < 21; n++) {
      const root = join(server.dir, 'projects', `p${String(n).padStart(2, '0')}`)
      mkdirSync(root, { recursive: true })
      await full.call('t3_project_create', { title: `p${n}`, workspaceRoot: root })
    }
    const first = await full.call<{ projects: unknown[]; nextCursor?: number | null }>('t3_project_list', {})
    expect(first.projects).toHaveLength(20)
    expect(first.nextCursor).toBe(20)
    const projects = await full.listProjects()
    expect(projects.length).toBeGreaterThanOrEqual(22)
    // Observed: workspaceRoot is the path as given; the harness passes the checkout's real path, as main.ts compares resolved paths.
    expect(projects.find(project => project.id === server.projectId)).toMatchObject({ title: 'widgets', workspaceRoot: realpathSync(server.checkout) })
  }, TEST_MS)

  it('launches into an existing worktree with the chosen model, once per clientRequestId', async () => {
    const alt = await client('full-access', 'alt')
    const launched = await launch(alt, 'hello from the contract')
    // Observed: a launch answers before the run starts, with status `preparing`, and a link into this server's web app.
    expect(launched.runId).toBeTruthy()
    expect(['preparing', 'queued', 'starting', 'running']).toContain(launched.status)
    expect(launched.link).toMatch(new RegExp(`^${server.origin}/`))
    const again = await alt.launch({ projectId: server.projectId, title: 'another title', message: 'another message', worktreePath: launched.path,
      clientRequestId: `launch:${worktrees}` })
    expect(again.threadId).toBe(launched.threadId)
    expect(await settle(alt, launched.threadId)).toMatchObject({ status: 'completed', runId: launched.runId, timedOut: false })
    const read = await alt.read(launched.threadId)
    expect(read.thread).toMatchObject({ worktreePath: launched.path, branch: launched.branch, status: 'completed', activeRunId: null,
      latestRunId: launched.runId, pendingRequestCount: 0, archived: false, settled: false })
    expect(read.thread).toMatchObject({ providerInstanceId: INSTANCE, model: 'alt', runtimeMode: 'full-access' })
    expect(texts(read)).toEqual(['user_message: hello from the contract', 'assistant_message: echo[alt]: hello from the contract'])

    // A worktree that is not one of the project's, or an unknown project, is refused before anything runs.
    expect(await error(alt.launch({ projectId: server.projectId, title: 'x', message: 'x', worktreePath: server.dir, clientRequestId: 'bad:1' })))
      .toMatchObject({ code: 'invalid_request', transient: false })
    expect(await error(alt.launch({ projectId: 'no-such-project', title: 'x', message: 'x', worktreePath: launched.path, clientRequestId: 'bad:2' })))
      .toMatchObject({ code: 'invalid_request' })
    // Observed: an unknown model is accepted at launch and fails the run.
    const unknown = await client('full-access', 'no-such-model')
    const failing = await launch(unknown, 'x')
    expect(await settle(unknown, failing.threadId)).toMatchObject({ status: 'failed' })
    await alt.close(); await unknown.close()
  }, TEST_MS)

  it('waits until a run ends, or times out with the run still running', async () => {
    const launched = await launch(full, 'slow [slow 2500]')
    expect(await full.wait(launched.threadId, 300)).toMatchObject({ status: 'running', timedOut: true, runId: launched.runId })
    expect(await settle(full, launched.threadId)).toMatchObject({ status: 'completed', timedOut: false })
    // With a runId, the wait is for that run, even after later ones.
    await full.send(launched.threadId, 'second', 'send:wait:2', 'auto')
    await settle(full, launched.threadId)
    expect(await full.wait(launched.threadId, 1000, launched.runId!)).toMatchObject({ runId: launched.runId, status: 'completed', timedOut: false })
    // A thread with no run is idle at once.
    const idle = await full.launchScratch({ title: 'idle', clientRequestId: 'scratch:idle' })
    expect(idle.status).toBeNull()
    expect(await full.wait(idle.threadId, 5000)).toMatchObject({ status: 'idle', timedOut: false, runId: null })
    // A failed turn ends the wait with `failed` and leaves an `error` item in the activity view.
    await full.send(launched.threadId, 'boom [fail]', 'send:wait:3', 'auto')
    expect(await settle(full, launched.threadId)).toMatchObject({ status: 'failed' })
    const activity = await full.read(launched.threadId, { view: 'activity', limit: 100 })
    expect(activity.items.at(-1)).toMatchObject({ type: 'error', status: 'failed', text: 'scripted failure' })
  }, TEST_MS)

  it('reads messages or all activity, in pages after a position', async () => {
    const launched = await launch(full, 'one')
    await settle(full, launched.threadId)
    for (const [n, text] of ['two', 'three'].entries()) { await full.send(launched.threadId, text, `send:read:${n}`, 'auto'); await settle(full, launched.threadId) }
    const messages = await full.read(launched.threadId)
    expect(messages.items.map(item => item.type)).toEqual(['user_message', 'assistant_message', 'user_message', 'assistant_message', 'user_message', 'assistant_message'])
    expect(messages.items.every(item => item.status === 'completed')).toBe(true)
    // Observed: positions count every activity item, so message positions have gaps; nextPosition is the last item's position
    // even on the last page, and hasMore says whether another page exists.
    const positions = messages.items.map(item => item.position)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    expect(messages).toMatchObject({ nextPosition: positions.at(-1), hasMore: false })
    const first = await full.read(launched.threadId, { limit: 2 })
    expect(first.items.map(item => item.position)).toEqual(positions.slice(0, 2))
    expect(first).toMatchObject({ nextPosition: positions[1], hasMore: true })
    // afterPosition is exclusive.
    const second = await full.read(launched.threadId, { limit: 2, afterPosition: first.nextPosition! })
    expect(second.items.map(item => item.position)).toEqual(positions.slice(2, 4))
    expect(await full.read(launched.threadId, { afterPosition: 10_000 })).toMatchObject({ items: [], nextPosition: null, hasMore: false })
    const activity = await full.read(launched.threadId, { view: 'activity', limit: 100 })
    expect(new Set(activity.items.map(item => item.type))).toEqual(new Set(['user_message', 'assistant_message', 'command_execution', 'checkpoint']))
    expect(activity.items.map(item => item.position)).toEqual(activity.items.map((_, index) => index))
  }, TEST_MS)

  it('sends in each mode, once per clientRequestId', async () => {
    const launched = await launch(full, 'long [slow 4000]')
    await poll(async () => (await full.read(launched.threadId, { limit: 1 })).thread.status === 'running', 'the run to start')
    // auto steers a running turn: the message joins the same run.
    const steered = await full.send(launched.threadId, 'steer by auto', 'send:mode:1', 'auto')
    expect(steered).toMatchObject({ delivery: 'steered', runId: launched.runId })
    // queue starts a new run after the current one; the same clientRequestId returns the same message.
    const queued = await full.send(launched.threadId, 'queued', 'send:mode:2', 'queue')
    expect(queued).toMatchObject({ delivery: 'queued', status: 'queued' })
    expect(queued.runId).not.toBe(launched.runId)
    expect(await full.send(launched.threadId, 'queued', 'send:mode:2', 'queue')).toMatchObject({ messageId: queued.messageId, runId: queued.runId })
    // Observed: auto queues here because the steer before it put the run back to `starting`; a send in mode auto
    // while the run is `running` steers, even with a message queued (tests/live/read-tracking.spec.ts).
    expect(await full.send(launched.threadId, 'auto behind the queue', 'send:mode:3', 'auto')).toMatchObject({ delivery: 'queued' })
    await settle(full, launched.threadId, 60_000)
    let read = await full.read(launched.threadId, { limit: 100 })
    expect(read.thread.activeRunId).toBeNull()
    // Each user message got exactly one reply, and the duplicate send added nothing.
    expect(texts(read).filter(text => text.startsWith('user_message'))).toEqual(['user_message: long [slow 4000]', 'user_message: steer by auto',
      'user_message: queued', 'user_message: auto behind the queue'])
    // On an idle thread, auto and queue start a run; steer is refused.
    expect(await full.send(launched.threadId, 'auto on idle', 'send:mode:4', 'auto')).toMatchObject({ delivery: 'started' })
    await settle(full, launched.threadId)
    expect(await full.send(launched.threadId, 'queue on idle', 'send:mode:5', 'queue')).toMatchObject({ delivery: 'started' })
    await settle(full, launched.threadId)
    expect(await error(full.send(launched.threadId, 'steer on idle', 'send:mode:6', 'steer'))).toMatchObject({ code: 'thread_not_sendable', transient: false })
    // restart interrupts a running turn and runs the message instead. Observed in probes: while the run is still `starting`
    // (just after a send, or after a steer) it is refused with thread_not_sendable, "has no running turn that can be restarted";
    // not asserted here because the window is a race. The super agent does not use restart.
    await full.send(launched.threadId, 'long [slow 8000]', 'send:mode:7', 'auto')
    await poll(async () => (await full.read(launched.threadId, { limit: 1 })).thread.status === 'running', 'the run to start')
    const restarted = await full.send(launched.threadId, 'restart', 'send:mode:9', 'restart')
    expect(restarted.delivery).toBe('restarted')
    await settle(full, launched.threadId)
    read = await full.read(launched.threadId, { limit: 100 })
    expect(texts(read).slice(-2)).toEqual(['user_message: restart', 'assistant_message: echo[plain]: restart'])
    expect((await full.read(launched.threadId, { limit: 1 })).thread.status).toBe('completed')
  }, TEST_MS)

  it('interrupts a turn, and a stop holds what was queued before it but not later sends', async () => {
    const launched = await launch(full, 'long [slow 8000]')
    await poll(async () => (await full.read(launched.threadId, { limit: 1 })).thread.status === 'running', 'the run to start')
    await full.interrupt(launched.threadId, { reason: 'test', clientRequestId: 'stop:1' })
    expect(await settle(full, launched.threadId)).toMatchObject({ status: 'interrupted', runId: launched.runId })
    // Observed: interrupting an idle thread is no error (t3code answers `no_active_run`).
    await full.interrupt(launched.threadId, { clientRequestId: 'stop:2' })

    await full.send(launched.threadId, 'long [slow 8000]', 'send:stop:1', 'auto')
    await poll(async () => (await full.read(launched.threadId, { limit: 1 })).thread.status === 'running', 'the run to start')
    const held = await full.send(launched.threadId, 'held', 'send:stop:2', 'queue')
    await full.interrupt(launched.threadId, { stop: true, reason: 'stopped', clientRequestId: 'stop:3' })
    // Observed: after a stop, the run queued before it stays queued, and a wait without runId reports it and times out.
    expect(await full.wait(launched.threadId, 2000)).toMatchObject({ status: 'queued', runId: held.runId, timedOut: true })
    // A later send starts its own run normally and leaves the held one queued.
    const after = await full.send(launched.threadId, 'after the stop', 'send:stop:3', 'auto')
    expect(after.delivery).toBe('started')
    expect(await full.wait(launched.threadId, 20_000, after.runId)).toMatchObject({ status: 'completed' })
    const read = await full.read(launched.threadId, { limit: 100 })
    expect(texts(read)).toContain('assistant_message: echo[plain]: after the stop')
    expect(texts(read)).not.toContain('assistant_message: echo[plain]: held')
    // Interrupting the thread then cancels the held run.
    await full.interrupt(launched.threadId, { clientRequestId: 'stop:4' })
    expect(await full.wait(launched.threadId, 10_000, held.runId)).toMatchObject({ status: 'interrupted', timedOut: false })
  }, TEST_MS)

  it('pins and archives threads, and an archived thread takes no messages', async () => {
    const launched = await launch(full, 'organize me')
    await settle(full, launched.threadId)
    // Observed: pinning is not visible in t3_thread_read; it only has to be accepted.
    await full.organize(launched.threadId, 'pin')
    await full.organize(launched.threadId, 'unpin')
    await full.organize(launched.threadId, 'archive')
    expect((await full.read(launched.threadId, { limit: 1 })).thread.archived).toBe(true)
    expect(await error(full.send(launched.threadId, 'hello', 'send:organize:1'))).toMatchObject({ code: 'thread_not_sendable', transient: false })
    await full.organize(launched.threadId, 'unarchive')
    expect(await full.send(launched.threadId, 'hello', 'send:organize:2')).toMatchObject({ delivery: 'started' })
    await settle(full, launched.threadId)
  }, TEST_MS)

  it('gives a scratch thread its own folder', async () => {
    const scratch = await full.launchScratch({ title: 'Superagent', clientRequestId: 'scratch:1', message: 'console hello' })
    expect((await full.launchScratch({ title: 'Superagent', clientRequestId: 'scratch:1' })).threadId).toBe(scratch.threadId)
    await settle(full, scratch.threadId)
    const read = await full.read(scratch.threadId)
    // Observed: scratch threads belong to a hidden scratch project and get a folder under <base dir>/scratch, without a branch.
    expect(read.thread.worktreePath).toMatch(new RegExp(`^${server.baseDir}/scratch/`))
    expect(existsSync(read.thread.worktreePath!)).toBe(true)
    expect(read.thread.branch).toBeNull()
    expect(texts(read)).toEqual(['user_message: console hello', 'assistant_message: echo[plain]: console hello'])
  }, TEST_MS)

  it('turns refusals into T3Errors with t3code\'s codes', async () => {
    expect(await error(full.wait('no-such-thread', 10))).toMatchObject({ code: 'thread_not_found', transient: false })
    expect(await error(full.read('no-such-thread'))).toMatchObject({ code: 'thread_not_found' })
    expect(await error(full.send('no-such-thread', 'x', 'send:missing'))).toMatchObject({ code: 'thread_not_found' })
    // A bad token is refused by HTTP 401 before any tool runs; retrying cannot help.
    const bogus = new McpT3Client({ url: server.url, token: 'bogus' })
    expect(await error(bogus.listProjects())).toMatchObject({ code: 'invalid_mcp_credential', transient: false })
    const unreachable = new McpT3Client({ url: 'http://127.0.0.1:9/mcp', token: 'x' })
    expect(await error(unreachable.listProjects())).toMatchObject({ code: 'network', transient: true })
  }, TEST_MS)

  it('caps a CLI-issued token at approval-required', async () => {
    const capabilities = await approval.call<{ runtimeMode: string }>('orchestrator_capabilities', {})
    expect(capabilities.runtimeMode).toBe('approval-required')
    expect((await full.call<{ runtimeMode: string }>('orchestrator_capabilities', {})).runtimeMode).toBe('full-access')
    expect(await error(launch(approval, 'x', { runtimeMode: 'full-access' }))).toMatchObject({ code: 'runtime_mode_escalation_denied', transient: false })
    // A launch without a mode inherits the ceiling, and a thread above it cannot be written to by that client.
    const inherited = await launch(approval, 'inherit')
    expect((await approval.read(inherited.threadId, { limit: 1 })).thread.runtimeMode).toBe('approval-required')
    const broader = await launch(full, 'broader')
    expect(await error(approval.send(broader.threadId, 'x', 'send:escalate'))).toMatchObject({ code: 'runtime_mode_escalation_denied' })
    await settle(full, broader.threadId)
    await settle(approval, inherited.threadId)
  }, TEST_MS)

  it('shows an approval as pending, which only t3code itself can answer', async () => {
    const launched = await launch(approval, 'run it [permission execute]')
    // Observed: a run that waits on an approval stays `running`, and t3_thread_wait just times out.
    expect(await approval.wait(launched.threadId, 2000)).toMatchObject({ status: 'running', timedOut: true })
    await poll(async () => (await approval.read(launched.threadId, { limit: 1 })).thread.pendingRequestCount === 1, 'the approval to be pending')
    const pending = await approval.pendingRequests(launched.threadId)
    expect(pending).toEqual([{ kind: 'approval', requestId: expect.stringMatching(/^runtime-request:/), text: 'echo hi' }])
    // t3_pending_request does not list approvals and cannot answer them.
    expect(await approval.call('t3_pending_request', { action: 'list', threadId: launched.threadId })).toEqual({ requestIds: [] })
    expect(await error(approval.answerQuestion(launched.threadId, pending[0]!.requestId, { x: 'y' }))).toMatchObject({ code: 'invalid_request' })
    // An interrupt cancels the approval, and the agent ends its turn.
    await approval.interrupt(launched.threadId, { clientRequestId: 'stop:approval' })
    expect(await settle(approval, launched.threadId)).toMatchObject({ status: 'interrupted' })
    expect(await approval.pendingRequests(launched.threadId)).toEqual([])
    const activity = await approval.read(launched.threadId, { view: 'activity', limit: 100 })
    expect(activity.items.find(item => item.type === 'approval_request')).toMatchObject({ status: 'cancelled' })

    // Reads never ask; under full-access nothing asks.
    const reading = await launch(approval, 'look [permission read]')
    expect(await settle(approval, reading.threadId)).toMatchObject({ status: 'completed' })
    expect(texts(await approval.read(reading.threadId))).toContain('assistant_message: done[plain]: permission read: allowed')
    const allowed = await launch(full, 'run it [permission execute]')
    expect(await settle(full, allowed.threadId)).toMatchObject({ status: 'completed' })
    expect(texts(await full.read(allowed.threadId))).toContain('assistant_message: done[plain]: permission execute: allowed')
    // Observed: an edit under approval-required asks too, and its approval text is t3code's own "Changed files".
    const editing = await launch(approval, 'edit [permission edit]')
    await poll(async () => (await approval.pendingRequests(editing.threadId)).length === 1, 'the edit approval')
    expect(await approval.pendingRequests(editing.threadId)).toMatchObject([{ kind: 'approval', text: 'Changed files' }])
    await approval.interrupt(editing.threadId, { clientRequestId: 'stop:edit' })
    await settle(approval, editing.threadId)
  }, TEST_MS)

  it('answers a pending question through t3_pending_request, and the turn goes on', async () => {
    const launched = await launch(approval, 'ask [question]')
    await poll(async () => (await approval.read(launched.threadId, { limit: 1 })).thread.pendingRequestCount === 1, 'the question to be pending')
    expect(await approval.wait(launched.threadId, 500)).toMatchObject({ status: 'running', timedOut: true })
    const pending = await approval.pendingRequests(launched.threadId)
    // Observed: the elicitation's property becomes the question id, its title the header and its enum the options (label = description).
    expect(pending).toEqual([{ kind: 'question', requestId: expect.stringMatching(/^runtime-request:/), questions: [{ id: 'choice', header: 'Fixture',
      question: 'Should this fixture prefer strict schemas or UI flexibility?',
      options: [{ label: 'Strict schemas', description: 'Strict schemas' }, { label: 'UI flexibility', description: 'UI flexibility' }] }] }])
    const question = pending[0]!
    await approval.answerQuestion(launched.threadId, question.requestId, { choice: 'Strict schemas' })
    expect(await settle(approval, launched.threadId)).toMatchObject({ status: 'completed' })
    expect(texts(await approval.read(launched.threadId))).toContain('assistant_message: done[plain]: answer: {"choice":"Strict schemas"}')
    expect(await approval.pendingRequests(launched.threadId)).toEqual([])
    expect(await error(approval.answerQuestion(launched.threadId, question.requestId, { choice: 'Strict schemas' })))
      .toMatchObject({ code: 'invalid_request', message: expect.stringContaining('already answered') })
    // Observed: for an ACP agent a free-text answer reaches it as given, not as "other".
    await approval.send(launched.threadId, 'again [question]', 'send:question:2')
    await poll(async () => (await approval.pendingRequests(launched.threadId)).length === 1, 'the second question')
    const [again] = await approval.pendingRequests(launched.threadId)
    await approval.answerQuestion(launched.threadId, again!.requestId, { choice: 'Neither, use both' })
    await settle(approval, launched.threadId)
    expect(texts(await approval.read(launched.threadId))).toContain('assistant_message: done[plain]: answer: {"choice":"Neither, use both"}')
  }, TEST_MS)

  it('sent only arguments that t3code declares', async () => {
    const raw = new Client({ name: 'contract', version: '0' })
    await raw.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: `Bearer ${await server.token('full-access')}` } } }))
    const schemas = new Map((await raw.listTools()).tools.map(tool => [tool.name, Object.keys(tool.inputSchema.properties ?? {})]))
    await raw.close()
    expect(sent.length).toBeGreaterThan(20)
    for (const call of sent) {
      expect(schemas.has(call.tool), call.tool).toBe(true)
      for (const key of Object.keys(call.args)) expect(schemas.get(call.tool), `${call.tool}.${key}`).toContain(key)
    }
  }, TEST_MS)
})

describe.skipIf(!live)(`t3code restarts${live ? '' : ` (skipped: ${skipReason})`}`, () => {
  let server: T3Server
  beforeAll(async () => { server = await startT3() }, TEST_MS)
  afterAll(async () => { await server?.close() }, 30_000)

  it('keeps a client working across a t3code restart, which forgets its MCP sessions', async () => {
    const client = await server.client('full-access', 'plain')
    expect((await client.listProjects()).map(project => project.id)).toContain(server.projectId)
    // Observed: t3code keeps MCP sessions in memory and answers a forgotten session id with HTTP 404 and an empty body.
    // Tokens live in the base dir and survive. The client starts a new session and sends the call again.
    const groups = () => (JSON.parse(readFileSync(join(server.dir, 'processes.json'), 'utf8')) as { groups: number[] }).groups
    const before = groups()
    await server.restart()
    expect((await client.listProjects()).map(project => project.id)).toContain(server.projectId)
    // The reaper (tests/live/reaper.mjs) signals only the group the server now runs in, never the one the restart ended.
    expect(groups()).toHaveLength(1)
    expect(groups()).not.toEqual(before)
    const raw = await fetch(server.url, { method: 'POST', headers: { authorization: `Bearer ${await server.token('full-access')}`, 'content-type': 'application/json',
      accept: 'application/json, text/event-stream', 'mcp-session-id': 'forgotten', 'mcp-protocol-version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
    expect(raw.status).toBe(404)
  }, TEST_MS)
})
