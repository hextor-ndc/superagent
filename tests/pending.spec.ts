/**
 * Point 3 for what t3code itself waits on: a worker thread blocked on an approval or a question reaches the attention queue
 * (`person/approve`, `person/question`), questions are answered through `superagent_answer`, approvals are sent to T3 Code,
 * and a Watchdog thread blocked on an approval shows as an alert that cannot be dismissed.
 */
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, describe, expect, it } from 'vitest'
import { consoleTrigger } from '../src/app/console-source.ts'
import { Runtime, type TicketView } from '../src/app/runtime.ts'
import type { Config } from '../src/config.ts'
import { startHttp } from '../src/http/server.ts'
import { attentionPage } from '../src/mcp/attention-app.ts'
import type { Alert } from '../src/mcp/watchdog-tools.ts'
import type { PendingQuestion, PendingRequest } from '../src/t3/client.ts'
import { FakeT3 } from './fake-t3.ts'
import { checkout, until } from './harness.ts'

const data = (result: unknown) => (result as { structuredContent: Record<string, unknown> }).structuredContent
const errorText = (result: unknown) => ((result as { content: { text: string }[] }).content[0]?.text ?? '')
async function mcp(url: string) {
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url)))
  return client
}

/** The question frame of t3code's replay fixture (`acp_elicitation`), as `t3_pending_request read` gives it. */
const fixture: PendingQuestion = { id: 'schema_vs_ui_flexibility', header: 'Fixture', question: 'Should this fixture prefer strict schemas or UI flexibility?',
  options: [{ label: 'Strict schemas (Recommended)', description: '', value: 'strict' }, { label: 'UI flexibility', description: '' }] }

interface Made { runtime: Runtime; t3: FakeT3; base: string; errors: string[]; close(): Promise<void> }

// The shared harness keeps the executor's default look interval (15 s), so this spec builds its own with short ones.
async function made(overrides: Partial<Config> = {}, pendingCheckMs = 20, place = checkout(),
  t3 = new FakeT3([{ id: 'project-1', workspaceRoot: place.root }])): Promise<Made> {
  const errors: string[] = []
  const config: Config = { t3Url: 'unused', t3Token: 'unused', tokenFile: 'unused', projectRoot: place.root, worktreeRoot: join(place.dir, 'worktrees'),
    baseRef: 'HEAD', router: { kind: 'rules', model: 'claude-opus-5-5', effort: 'medium', acceptMode: 'observe' }, repository: 'acme/widgets', port: 0,
    publicUrl: '', consoleToken: 'console-secret', watchdogMinutes: 0, database: ':memory:', operator: 'hector', maxWorkers: 2,
    log: (message, error) => { errors.push(`${message} ${error instanceof Error ? error.message : error ?? ''}`) }, ...overrides }
  const runtime = new Runtime(config, t3, { id: 'project-1', root: place.root },
    { waitMs: 10, idlePollMs: 10, continueAfterMs: 0, pendingCheckMs, watchdogPendingMs: 20 })
  const http = await startHttp(runtime, 0)
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
  config.publicUrl = base
  runtime.start()
  return { runtime, t3, base, errors, close: async () => { http.close(); await runtime.stop() } }
}

/** A console request whose worker thread is running its first turn. */
async function working(made: Made, text = 'Add a dark mode') {
  made.runtime.engine.receive(consoleTrigger('hector', text))
  const thread = await until(() => made.t3.workerThreads()[0], 'the worker thread')
  const ticket = made.runtime.repo.tickets.list()[0]!
  await until(() => made.runtime.executor.busySince(ticket.id), 'the running turn')
  return { thread, ticket }
}
const attention = (made: Made) => made.runtime.attention()
/** The attention list once something is in it. */
const rows = (made: Made) => { const list = made.runtime.attention(); return list.length ? list : undefined }
const stageOf = (made: Made, id: string) => made.runtime.view(made.runtime.repo.tickets.get(id)!).stage

/**
 * The panel page as a browser would run it, with just enough of a DOM: it fetches `superagent_attention` from this service's
 * HTTP API and renders the list, whose HTML is returned.
 */
async function panelHtml(base: string, until_: (html: string) => boolean): Promise<string> {
  const html = attentionPage('panel', '/panel/console-secret')
  const script = html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'))
  const nodes = { list: { innerHTML: '', textContent: '' }, note: { innerHTML: '', textContent: '' } }
  const document = { getElementById: (id: 'list' | 'note') => nodes[id], addEventListener() {}, documentElement: { dataset: {} } }
  const run = new Function('document', 'window', 'fetch', 'setInterval', 'parent', script)
  run(document, { addEventListener() {} }, (url: string, init: RequestInit) => fetch(base + url, init), () => 0, undefined)
  return until(() => until_(nodes.list.innerHTML) && nodes.list.innerHTML, `the panel list (note: ${nodes.note.textContent})`)
}

/** A t3code whose look at a thread takes its snapshot first and then waits on `hold`, as a slow multi-call read would. */
class SlowLooks extends FakeT3 {
  hold?: Promise<void>
  looks = 0
  /** Called as a held look hands its snapshot back, before the executor uses it. */
  onReturn?: () => void
  override async pendingRequests(threadId: string): Promise<PendingRequest[]> {
    const snapshot = await super.pendingRequests(threadId)
    this.looks++
    if (this.hold) {
      await this.hold
      const done = this.onReturn
      if (done) setImmediate(done)
    }
    return snapshot
  }
}

/**
 * The panel's click handler run against a single question row, with fake elements: `click` presses a button, and each
 * superagent_answer the panel sends is collected.
 */
function panelRow(question: { req: string; qid: string; multi: boolean }) {
  const html = attentionPage('panel', '/panel/console-secret')
  const script = html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'))
  const sent: Record<string, unknown>[] = []
  let onClick!: (event: unknown) => Promise<void>
  const nodes = { list: { innerHTML: '', textContent: '' }, note: { innerHTML: '', textContent: '' } }
  const document = { getElementById: (id: 'list' | 'note') => nodes[id], documentElement: { dataset: {} },
    addEventListener: (type: string, listener: typeof onClick) => { if (type === 'click') onClick = listener } }
  const fetch = async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { name: string; arguments: Record<string, unknown> }
    if (body.name === 'superagent_answer') sent.push(body.arguments)
    return { ok: true, json: async () => ({ tickets: [], alerts: [] }), text: async () => '' }
  }
  const box = { value: '', dataset: {} }
  const q = { dataset: { req: question.req, qid: question.qid, multi: question.multi ? '1' : '' }, nextElementSibling: box }
  const answer = { dataset: { do: 'answer' }, textContent: 'Answer', closest: (selector: string) => selector === '.pq' ? null : selector === '.row' ? row : answer }
  const row = { dataset: { id: 'ticket-1' }, querySelector: (selector: string) => selector === 'textarea' ? box : answer,
    querySelectorAll: () => [q] }
  new Function('document', 'window', 'fetch', 'setInterval', 'parent', script)(document, { addEventListener() {} }, fetch, () => 0, undefined)
  const button = (dataset: Record<string, string>) => {
    const self = { dataset, closest: (selector: string) => selector === '.pq' ? q : selector === '.row' ? row : self }
    return self
  }
  return { box, sent, pick: (value: string) => onClick({ target: button({ do: 'pick', value }) }), send: () => onClick({ target: answer }),
    note: () => nodes.note.textContent }
}

describe('approvals and questions in the attention queue', () => {
  let current: Made | undefined
  afterEach(async () => { await current?.close(); current = undefined })

  it('shows a worker blocked on an approval as person/approve, links T3 Code for it, and drops it once approved there', async () => {
    current = await made()
    const { thread, ticket } = await working(current)
    expect(stageOf(current, ticket.id)).toBe('working')
    thread.pending.push({ kind: 'approval', requestId: 'runtime-request:provider:codex:1', text: 'Allow the t3-code MCP server to run tool "schedule_task"?' })

    const [row] = await until(() => rows(current!), 'the approval in attention')
    expect(row).toMatchObject({ id: ticket.id, stage: 'person/approve', link: thread.link,
      pending: { approvals: [{ requestId: 'runtime-request:provider:codex:1', text: 'Allow the t3-code MCP server to run tool "schedule_task"?' }], questions: [] } })
    // The run still holds its slot: t3code reports it running while it waits.
    expect(current.runtime.executor.busySince(ticket.id)).toBeTruthy()

    const console = await mcp(`${current.base}/mcp/console/console-secret`)
    expect(data(await console.callTool({ name: 'superagent_status', arguments: {} }))).toMatchObject({ waiting_for_a_person: 1 })
    expect((data(await console.callTool({ name: 'superagent_attention', arguments: {} })).tickets as TicketView[])[0]!.stage).toBe('person/approve')
    // Nothing here can grant an approval, and superagent_answer says where it is granted.
    const refused = await console.callTool({ name: 'superagent_answer', arguments: { ticket_id: row!.short, text: 'yes, allow it' } })
    expect(refused.isError).toBe(true)
    expect(errorText(refused)).toContain('Approvals are answered in T3 Code only')
    expect(errorText(refused)).toContain(thread.link)
    expect(current.t3.calls.filter(call => call.tool === 't3_pending_request')).toEqual([])
    // The Watchdog sees it too.
    const watchdog = await mcp(current.runtime.watchdogUrl())
    expect((data(await watchdog.callTool({ name: 'watchdog_check', arguments: {} })).tickets as TicketView[])[0])
      .toMatchObject({ stage: 'person/approve', pending: { approvals: [{ text: 'Allow the t3-code MCP server to run tool "schedule_task"?' }] } })

    // The panel draws the approval text and a link to approve it in T3 Code, with no Answer button.
    const html = await panelHtml(current.base, list => list.includes('Approve in T3 Code'))
    expect(html).toContain('Allow the t3-code MCP server to run tool &quot;schedule_task&quot;?')
    expect(html).toContain(`href="${thread.link}"`)
    expect(html).toContain('class="stage approve"')
    expect(html).not.toContain('data-do="answer"')

    // The operator approves in T3 Code: the next look finds nothing, and the Ticket is working again.
    thread.pending.splice(0)
    await until(() => !attention(current!).length, 'the approval to leave attention')
    expect(stageOf(current, ticket.id)).toBe('working')
    expect(current.runtime.view(current.runtime.repo.tickets.get(ticket.id)!).pending).toBeUndefined()
    await console.close(); await watchdog.close()
  })

  it('shows a t3code question as person/question and answers it through T3 Code with superagent_answer', async () => {
    current = await made()
    const { thread, ticket } = await working(current)
    thread.pending.push({ kind: 'question', requestId: 'question-1', questions: [fixture] })
    const [row] = await until(() => rows(current!), 'the question in attention')
    expect(row).toMatchObject({ stage: 'person/question', pending: { approvals: [], questions: [{ ...fixture, requestId: 'question-1' }] } })

    // The panel draws the question, its options and an Answer button.
    const html = await panelHtml(current.base, list => list.includes('data-do="answer"'))
    expect(html).toContain('Should this fixture prefer strict schemas or UI flexibility?')
    expect(html).toContain('data-value="strict"')
    expect(html).toContain('UI flexibility')
    expect(html).toContain('class="stage question"')

    // Plain text answers the one question; an option named by its label goes as its value.
    const console = await mcp(`${current.base}/mcp/console/console-secret`)
    const answered = data(await console.callTool({ name: 'superagent_answer', arguments: { ticket_id: row!.short, text: 'strict schemas (recommended)' } }))
    expect(answered).toEqual({ delivered: 't3-question', request_id: 'question-1' })
    expect(current.t3.calls.filter(call => call.tool === 't3_pending_request')).toEqual([{ tool: 't3_pending_request',
      args: { action: 'respond', threadId: thread.id, requestId: 'question-1', answers: { schema_vs_ui_flexibility: 'strict' } } }])
    // It leaves attention at once, without waiting for the next look, and nothing went to the thread as a message.
    expect(attention(current)).toEqual([])
    expect(thread.messages).toHaveLength(1)
    expect(stageOf(current, ticket.id)).toBe('working')
    await console.close()
  })

  it('needs answers by question id when a thread waits on several questions, and takes them from the panel', async () => {
    current = await made()
    const { thread } = await working(current)
    const scope: PendingQuestion = { id: 'scope', header: 'Scope', question: 'Which screens?', options: [{ label: 'All', description: '' }, { label: 'Settings', description: '' }],
      multiSelect: true }
    thread.pending.push({ kind: 'question', requestId: 'question-2', questions: [fixture, scope] })
    const [row] = await until(() => rows(current!), 'the questions in attention')
    expect(row!.pending!.questions.map(question => question.id)).toEqual(['schema_vs_ui_flexibility', 'scope'])

    const console = await mcp(`${current.base}/mcp/console/console-secret`)
    const vague = await console.callTool({ name: 'superagent_answer', arguments: { ticket_id: row!.id, text: 'strict' } })
    expect(vague.isError).toBe(true)
    expect(errorText(vague)).toContain('question-2: schema_vs_ui_flexibility, scope')
    const unknown = await console.callTool({ name: 'superagent_answer', arguments: { ticket_id: row!.id, text: 'x', answers: { colour: 'blue' } } })
    expect(unknown.isError).toBe(true)
    expect(errorText(unknown)).toContain('got colour')
    expect(current.t3.calls.filter(call => call.tool === 't3_pending_request')).toEqual([])

    // The panel sends one call per request, with an answer per question.
    const response = await fetch(`${current.base}/panel/console-secret/action`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'superagent_answer', arguments: { ticket_id: row!.short, text: 'UI flexibility',
        answers: { schema_vs_ui_flexibility: 'UI flexibility', scope: ['all', 'Settings'] } } }) })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ delivered: 't3-question', request_id: 'question-2' })
    expect(current.t3.calls.filter(call => call.tool === 't3_pending_request').map(call => call.args)).toEqual([{ action: 'respond', threadId: thread.id,
      requestId: 'question-2', answers: { schema_vs_ui_flexibility: 'UI flexibility', scope: ['All', 'Settings'] } }])
    expect(attention(current)).toEqual([])
    await console.close()
  })

  it('keeps an answered question out of attention when a look that was already out returns it', async () => {
    const place = checkout()
    const t3 = new SlowLooks([{ id: 'project-1', workspaceRoot: place.root }])
    current = await made({}, 20, place, t3)
    const { thread, ticket } = await working(current)
    thread.pending.push({ kind: 'question', requestId: 'question-1', questions: [fixture] })
    await until(() => rows(current!), 'the question in attention')
    // A look takes its snapshot (the question still pending) and is held while the operator answers.
    let release!: () => void
    t3.hold = new Promise<void>(resolve => { release = resolve })
    const before = t3.looks
    await until(() => t3.looks > before, 'a look in flight')
    const console = await mcp(`${current.base}/mcp/console/console-secret`)
    expect(data(await console.callTool({ name: 'superagent_answer', arguments: { ticket_id: ticket.id, text: 'strict' } })))
      .toEqual({ delivered: 't3-question', request_id: 'question-1' })
    expect(attention(current)).toEqual([])
    // Right after the held look is used, before any later look could hide what it did.
    const used = new Promise<void>(resolve => { t3.onReturn = resolve })
    t3.hold = undefined
    release()
    await used
    expect(current.runtime.executor.pending(ticket.id)).toEqual([])
    expect(attention(current)).toEqual([])
    expect(stageOf(current, ticket.id)).toBe('working')
    // A new question in the same turn still shows.
    thread.pending.push({ kind: 'question', requestId: 'question-2', questions: [fixture] })
    const [row] = await until(() => rows(current!), 'the next question in attention')
    expect(row!.pending!.questions.map(question => question.requestId)).toEqual(['question-2'])
    await console.close()
  })

  it('looks at t3code at once for `answers` the last look has not seen, and refuses them when no question waits', async () => {
    // A look interval far longer than the test: after the first look (which saw nothing) the cache stays empty, as after a restart.
    current = await made({}, 60_000)
    const { thread, ticket } = await working(current)
    await until(() => current!.t3.pendingReads.includes(thread.id), 'the first look')
    const console = await mcp(`${current.base}/mcp/console/console-secret`)
    const refused = await console.callTool({ name: 'superagent_answer', arguments: { ticket_id: ticket.id, text: 'strict',
      answers: { schema_vs_ui_flexibility: 'strict' } } })
    expect(refused.isError).toBe(true)
    expect(errorText(refused)).toContain('waits on no question in T3 Code')
    expect(thread.messages).toHaveLength(1)

    thread.pending.push({ kind: 'question', requestId: 'question-1', questions: [fixture] })
    expect(current.runtime.executor.pending(ticket.id)).toEqual([])
    expect(data(await console.callTool({ name: 'superagent_answer', arguments: { ticket_id: ticket.id, text: 'strict',
      answers: { schema_vs_ui_flexibility: 'Strict schemas (Recommended)' } } }))).toEqual({ delivered: 't3-question', request_id: 'question-1' })
    expect(current.t3.calls.filter(call => call.tool === 't3_pending_request').map(call => call.args)).toEqual([{ action: 'respond',
      threadId: thread.id, requestId: 'question-1', answers: { schema_vs_ui_flexibility: 'strict' } }])
    expect(thread.pending).toEqual([])
    expect(thread.messages).toHaveLength(1)
    await console.close()
  })

  it('sends a multiple-choice pick whose label has a comma as that one option', async () => {
    const panel = panelRow({ req: 'question-3', qid: 'cleanup', multi: true })
    await panel.pick('Yes, delete the cache')
    await panel.pick('Keep the logs')
    await panel.pick('Rebuild, then test')
    await panel.pick('Keep the logs')
    expect(panel.box.value).toBe('Yes, delete the cache\nRebuild, then test')
    await panel.send()
    expect(panel.note()).toBe('Done.')
    expect(panel.sent).toEqual([{ ticket_id: 'ticket-1', text: 'Yes, delete the cache\nRebuild, then test',
      answers: { cleanup: ['Yes, delete the cache', 'Rebuild, then test'] } }])

    const single = panelRow({ req: 'question-4', qid: 'pick', multi: false })
    await single.pick('Yes, delete the cache')
    await single.send()
    expect(single.sent).toEqual([{ ticket_id: 'ticket-1', text: 'Yes, delete the cache', answers: { pick: 'Yes, delete the cache' } }])
  })

  it('keeps the current answer path when the thread waits on no t3code question', async () => {
    current = await made()
    const { thread, ticket } = await working(current)
    current.t3.finishRun(thread.id)
    await until(() => !current!.runtime.executor.busySince(ticket.id), 'the turn end')
    const console = await mcp(`${current.base}/mcp/console/console-secret`)
    const answered = data(await console.callTool({ name: 'superagent_answer', arguments: { ticket_id: ticket.id, text: 'Use the system setting.' } }))
    expect(answered).toMatchObject({ trigger_id: expect.any(String) })
    await until(() => thread.messages.some(message => message.text.includes('Use the system setting.')), 'the answer in the thread')
    expect(current.t3.calls.filter(call => call.tool === 't3_pending_request')).toEqual([])
    await console.close()
  })

  it('forgets what a thread waited on when its turn ends or its Ticket stops', async () => {
    current = await made()
    const { thread, ticket } = await working(current)
    thread.pending.push({ kind: 'approval', requestId: 'a-1', text: 'Run `rm -rf build`?' })
    await until(() => attention(current!).length, 'the approval in attention')
    // The turn ends (t3code declined the approval when the run ended): the Ticket is idle and waits on no one.
    current.t3.finishRun(thread.id)
    await until(() => !attention(current!).length, 'the approval to clear on the turn end')
    expect(current.runtime.executor.pending(ticket.id)).toEqual([])

    // A new turn blocks again, then the operator stops the Ticket.
    const console = await mcp(`${current.base}/mcp/console/console-secret`)
    await console.callTool({ name: 'superagent_note', arguments: { ticket_id: ticket.id, text: 'Go on.' } })
    await until(() => current!.runtime.executor.busySince(ticket.id), 'the next turn')
    await until(() => attention(current!).length, 'the approval in attention again')
    expect(data(await console.callTool({ name: 'superagent_stop', arguments: { ticket_id: ticket.id } }))).toMatchObject({ stopped: true })
    await until(() => !current!.runtime.executor.pending(ticket.id).length, 'the stop to clear it')
    expect(stageOf(current, ticket.id)).toBe('ended')
    expect(attention(current)).toEqual([])
    await console.close()
  })

  it('finds what a thread waits on again after a restart', async () => {
    const place = checkout()
    const database = join(place.dir, 'state.sqlite')
    current = await made({ database }, 20, place)
    const { t3 } = current
    const { thread, ticket } = await working(current)
    thread.pending.push({ kind: 'approval', requestId: 'a-3', text: 'Allow writing outside the worktree?' })
    await until(() => rows(current!), 'the approval before the restart')
    await current.close()

    // The cache is in memory only: the new process sees a working Ticket until its first look.
    current = await made({ database }, 20, place, t3)
    expect(current.runtime.executor.pending(ticket.id)).toEqual([])
    const [row] = await until(() => rows(current!), 'the approval after the restart')
    expect(row).toMatchObject({ id: ticket.id, stage: 'person/approve', pending: { approvals: [{ requestId: 'a-3' }] } })
  })

  it('looks at a busy thread at most once per interval, and lives through a failed look', async () => {
    current = await made({}, 60_000)
    const { thread } = await working(current)
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(current.t3.pendingReads.filter(id => id === thread.id)).toHaveLength(1)
    await current.close()

    current = await made({}, 20)
    current.t3.failPendingReads = 2
    const next = await working(current, 'Fix the flaky test')
    await until(() => current!.errors.some(error => error.includes('fetch failed')), 'the failed look in the log')
    expect(current.errors.find(error => error.includes('fetch failed'))).toMatch(/^reading what .* waits on failed/)
    next.thread.pending.push({ kind: 'approval', requestId: 'a-2', text: 'Allow network access?' })
    await until(() => attention(current!).length, 'the approval after the failures')
    expect(current.runtime.health.failing()).toEqual([])
  })

  it('shows a Watchdog thread blocked on an approval as an alert that cannot be dismissed and clears by itself', async () => {
    current = await made({ watchdogMinutes: 15 })
    await current.runtime.ensureWatchdog()
    const thread = [...current.t3.threads.values()].find(item => item.title === 'Superagent Watchdog')!
    const console = await mcp(`${current.base}/mcp/console/console-secret`)
    expect(data(await console.callTool({ name: 'superagent_attention', arguments: {} })).alerts).toEqual([])

    thread.pending.push({ kind: 'approval', requestId: 'w-1', text: 'Allow the t3-code MCP server to run tool "schedule_task"?' })
    await until(() => current!.runtime.watchdogPending, 'the look at the Watchdog thread')
    const alerts = data(await console.callTool({ name: 'superagent_attention', arguments: {} })).alerts as Alert[]
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toMatchObject({ id: 'pending:watchdog', link: thread.link })
    expect(alerts[0]!.text).toContain('"Allow the t3-code MCP server to run tool "schedule_task"?"')
    expect(alerts[0]!.text).toContain('answered in T3 Code')
    expect(alerts[0]!.text).toContain(thread.link)
    expect(data(await console.callTool({ name: 'superagent_status', arguments: {} }))).toMatchObject({ alerts: 1 })

    // It cannot be dismissed, through the console tool or the panel, and the Watchdog cannot store a copy of it.
    const refused = await console.callTool({ name: 'superagent_dismiss_alert', arguments: { alert_id: 'pending:watchdog' } })
    expect(refused.isError).toBe(true)
    expect(errorText(refused)).toContain('cannot be dismissed')
    const panel = await fetch(`${current.base}/panel/console-secret/action`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'superagent_dismiss_alert', arguments: { alert_id: 'pending:watchdog' } }) })
    expect(panel.status).toBe(400)
    expect(((await panel.json()) as { error: string }).error).toContain('clears itself once that is answered in T3 Code')
    const watchdog = await mcp(current.runtime.watchdogUrl())
    await watchdog.callTool({ name: 'watchdog_alert', arguments: { text: 'The router failed twice.' } })
    expect(current.runtime.repo.kv.get<Alert[]>('watchdog:alerts')!.map(item => item.id)).not.toContain('pending:watchdog')
    // The panel draws it with a link to T3 Code and no Dismiss button; the raised alert keeps its own.
    const html = await panelHtml(current.base, list => list.includes('Answer in T3 Code'))
    expect(html).toContain(`href="${thread.link}"`)
    expect(html.match(/data-do="dismiss"/g)).toHaveLength(1)

    // Approved in T3 Code: the next look clears it.
    thread.pending.splice(0)
    await until(() => !current!.runtime.watchdogPending, 'the alert to clear')
    expect((data(await console.callTool({ name: 'superagent_attention', arguments: {} })).alerts as Alert[]).map(item => item.text)).toEqual(['The router failed twice.'])
    await console.close(); await watchdog.close()
  })
})
