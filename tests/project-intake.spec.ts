/**
 * Phase 3a of docs/multi-project-plan.md around the console's intake, with the rules router: `SourceScope` filters only a
 * request for a denied project (D19), a request held from before the migration still goes to the legacy project when unnamed
 * requests are refused, `superagent_reroute` moves a ticket's request to another project, `superagent_ticket` reads a
 * request by its trigger id, and the console thread learns of projects (intro v2).
 *
 * Console-only (no GitHub), with the checkouts `widgets` (the legacy project) and `gadgets`, as in tests/two-projects.ts.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { afterEach, describe, expect, it } from 'vitest'
import { threadKey } from '../vendor/dsh/src/core/index.ts'
import { consoleTrigger } from '../src/app/console-source.ts'
import { SCHEMA_KEY, type ProjectsSchema } from '../src/app/migrate-projects.ts'
import { loadConfig } from '../src/config.ts'
import { FakeT3 } from './fake-t3.ts'
import { data, git, mcp, until } from './harness.ts'
import { commit, named, setup, worktreesOf, type Setup } from './two-projects.ts'

describe('the console\'s intake across projects (phase 3a)', () => {
  let env: Setup | undefined
  let console: Client | undefined
  afterEach(async () => { await console?.close(); console = undefined; await env?.made.close(); env = undefined })
  const open = async (options: Parameters<typeof setup>[0] = {}) => {
    env = await setup(options)
    console = await mcp(`${env.made.base}/mcp/console/console-secret`)
    return { env, call: async (name: string, args: Record<string, unknown>) => console!.callTool({ name, arguments: args }) }
  }

  it('filters only a request whose project is denied, and listens when the project is unknown or not named (D19)', async () => {
    const { env, call } = await open({ projects: { 'p-gadgets': { access: 'deny' } } })
    const { runtime } = env.made
    // The console refuses the denied project before anything is stored.
    const refused = await call('superagent_request', { text: 'Fix the gadgets', project: 'Gadgets' })
    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused.content)).toContain('Project Gadgets is denied')
    expect(runtime.repo.threads.list()).toEqual([])
    // One that reaches the Engine anyway is filtered at intake, and superagent_ticket says so.
    const denied = named('Fix the gadgets', 'p-gadgets')
    expect(runtime.engine.receive(denied)).toBe('filtered')
    expect(runtime.repo.triggers.disposition(denied.id)?.filtered).toEqual({ code: 'project_denied' })
    expect(data(await call('superagent_ticket', { ticket_id: denied.id }))).toMatchObject({ status: 'filtered', result: 'filtered: project_denied' })
    // A console request with no project, as one from before the upgrade, and one naming a project the registry does not know
    // (as when it cannot read T3 Code), are listened to; the second is then ignored with the reason, since no project takes it.
    expect(runtime.engine.receive(consoleTrigger('hector', 'Tidy the widgets'))).toBe('stored')
    const unknown = named('Fix the gizmos', 'p-gizmos')
    expect(runtime.engine.receive(unknown)).toBe('stored')
    const decision = await until(() => runtime.repo.decisions.byThread(threadKey(unknown.threads[0]!))[0], 'the ignore')
    expect(decision).toMatchObject({ kind: 'ignore' })
    expect(JSON.stringify(decision.reason)).toContain('No project p-gizmos in T3 Code')
    // A T3 Code project inside the super agent's worktree folder is denied by its status, not by projects.json.
    const stray = join(env.dir, 'worktrees', 'stray')
    mkdirSync(stray, { recursive: true })
    env.t3.addProject({ id: 'p-stray', workspaceRoot: stray, title: 'Stray' })
    await runtime.projects.refresh()
    expect(runtime.projects.byId('p-stray')).toMatchObject({ status: 'denied', access: expect.not.stringMatching(/^deny$/) })
    const strayRequest = named('Fix the stray', 'p-stray')
    expect(runtime.engine.receive(strayRequest)).toBe('filtered')
    expect(runtime.repo.triggers.disposition(strayRequest.id)?.filtered).toEqual({ code: 'project_denied' })
    // While T3 Code cannot be read, the last list stays, and a request for a project on it is still taken.
    env.t3.listProjects = async () => { throw new Error('t3_project_list: network: connection refused') }
    await runtime.projects.refresh().catch(() => {})
    expect(runtime.engine.receive(named('Fix the widgets', 'p-widgets'))).toBe('stored')
    await until(() => runtime.repo.tickets.list().length === 2, 'the two tickets')
  })

  it('does not resume an ended ticket whose project was denied since', async () => {
    const { env } = await open()
    const { runtime } = env.made
    const trigger = named('Fix the gadget count', 'p-gadgets')
    runtime.engine.receive(trigger)
    const ticketId = await env.ticketOf(trigger)
    await until(() => env.t3.workerThreads()[0], 'the worker thread')
    // A branch ticket ends as completed at its ready report.
    runtime.engine.report(ticketId, { state: 'ready', summary: 'Fixed on the branch.' })
    expect(runtime.repo.tickets.get(ticketId)!.ended).toMatchObject({ outcome: 'completed' })
    writeFileSync(join(env.dir, 'state', 'projects.json'), JSON.stringify({ 'p-gadgets': { access: 'deny' } }))
    await runtime.projects.refresh()
    // A message on its thread with no project of its own is let in, but the ticket's Mandate no longer holds.
    const more = consoleTrigger('hector', 'One more thing', trigger.threads[0]!)
    expect(runtime.engine.receive(more)).toBe('stored')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(runtime.repo.tickets.get(ticketId)!.ended).toMatchObject({ outcome: 'completed' })
    expect(env.t3.workerThreads()[0]!.messages.some(message => message.text.includes('One more thing'))).toBe(false)
  })

  it('delivers an answer to a live ticket whose project was denied since, and refuses one that would resume an ended ticket there', async () => {
    const { env, call } = await open()
    const { runtime } = env.made
    const trigger = named('Fix the gadget count', 'p-gadgets')
    runtime.engine.receive(trigger)
    const ticketId = await env.ticketOf(trigger)
    const worker = await until(() => env.t3.workerThreads()[0], 'the worker thread')
    writeFileSync(join(env.dir, 'state', 'projects.json'), JSON.stringify({ 'p-gadgets': { access: 'deny' }, 'p-widgets': { access: 'deny' } }))
    await runtime.projects.refresh()
    // The answer inherits the ticket's project, which is denied now; a deny stops new work there, not a ticket that runs.
    const answered = data(await call('superagent_answer', { ticket_id: ticketId, text: 'Use 3' }))
    expect(answered.delivered).toBe('stored')
    expect(runtime.repo.triggers.get(answered.trigger_id as string)!.meta).toMatchObject({ project: 'p-gadgets', projectBy: 'inherited' })
    await until(() => worker.messages.some(message => message.text.includes('Use 3')), 'the answer in the worker thread')

    // A ticket filed with no project, in the legacy project, which is denied now too, has ended: its Mandate names no project,
    // so the core would resume it there. The answer is refused instead, and nothing is stored.
    writeFileSync(join(env.dir, 'state', 'projects.json'), JSON.stringify({}))
    await runtime.projects.refresh()
    const unnamed = consoleTrigger('hector', 'Fix the widget count')
    runtime.engine.receive(unnamed)
    const widgetsTicket = await env.ticketOf(unnamed)
    await until(() => env.t3.workerThreads().find(item => item.projectId === 'p-widgets'), 'the widgets worker thread')
    runtime.engine.report(widgetsTicket, { state: 'ready', summary: 'Fixed on the branch.' })
    writeFileSync(join(env.dir, 'state', 'projects.json'), JSON.stringify({ 'p-widgets': { access: 'deny' } }))
    await runtime.projects.refresh()
    const thread = () => JSON.stringify(runtime.repo.threads.get(threadKey(unnamed.threads[0]!)))
    const before = thread()
    const refused = await call('superagent_answer', { ticket_id: widgetsTicket, text: 'One more thing' })
    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused.content)).toContain('Widgets is denied now')
    expect(thread()).toBe(before)
    expect(runtime.repo.tickets.get(widgetsTicket)!.ended).toMatchObject({ outcome: 'completed' })
  })

  it('takes a request held from before the migration into the legacy project, even when unnamed requests are refused', async () => {
    const { env, call } = await open({ config: { unnamedRequests: 'refuse' } })
    const { runtime } = env.made
    expect(runtime.repo.kv.get<ProjectsSchema>(SCHEMA_KEY)?.migratedAt).toBeDefined()
    // The Eval of a console request stored by an earlier version, which had no project.
    const held = { ...consoleTrigger('hector', 'Rename the widget module'), at: '2020-01-01T00:00:00.000Z' }
    runtime.engine.receive(held)
    const ticketId = await env.ticketOf(held)
    expect(runtime.binding(ticketId)).toMatchObject({ projectId: 'p-widgets', by: 'inherited' })
    // Its origin names no project, so an answer takes the ticket's project from the binding; handed back, it would go there too.
    const answered = data(await call('superagent_answer', { ticket_id: ticketId, text: 'Call it widgets-core.' }))
    const followup = runtime.repo.triggers.get(answered.trigger_id as string)!
    expect(followup.meta).toMatchObject({ project: 'p-widgets', projectBy: 'inherited' })
    expect(runtime.projectPreview([followup])).toMatchObject({ id: 'p-widgets', by: 'inherited' })
    // `refuse` is for console requests: a GitHub Trigger stored without a hint keeps the legacy project (D20).
    expect(runtime.projectPreview([{ source: 'github', meta: { number: 3 } }])).toMatchObject({ id: 'p-widgets', by: 'legacy' })
    expect(runtime.projectPreview([{ source: 'console', meta: { scope: 'console' } }])).toMatchObject({ refused: expect.stringMatching(/^Name the project/) })
    // A new one with no project is ignored by the rules router with what to do, and the console refuses it.
    const fresh = consoleTrigger('hector', 'Rename the gadget module')
    runtime.engine.receive(fresh)
    const decision = await until(() => runtime.repo.decisions.byThread(threadKey(fresh.threads[0]!))[0], 'the ignore')
    expect(decision.reason.map(reason => reason.values?.text ?? reason.code).join(' ')).toMatch(/^Name the project: superagent_request with project=<key>/)
    expect((await call('superagent_request', { text: 'Rename the gadget module' })).isError).toBe(true)
    expect(data(await call('superagent_projects', {}))).toMatchObject({ work: expect.stringContaining('Requests that name none are refused') })
  })

  it('reroutes a ticket: stops it, files the same request in the other project, and lists what it left', async () => {
    const { env, call } = await open()
    const { runtime } = env.made
    const first = data(await call('superagent_request', { text: 'Count the gadgets', wait_seconds: 10 }))
    expect(first).toMatchObject({ status: 'accepted', project: 'Widgets', filed_in: 'Widgets, the default for requests that name no project' })
    const old = runtime.executor.thread(first.ticket_id as string)!
    await until(() => env.t3.workerThreads()[0], 'the first worker thread')

    // Unknown or the same project: refused, and the ticket keeps running.
    expect(JSON.stringify((await call('superagent_reroute', { ticket_id: first.short as string, project: 'gizmos' })).content)).toContain('No project gizmos')
    expect(JSON.stringify((await call('superagent_reroute', { ticket_id: first.short as string, project: 'Widgets' })).content)).toContain('is in Widgets already')
    expect(runtime.repo.tickets.get(first.ticket_id as string)!.ended).toBeUndefined()

    const moved = data(await call('superagent_reroute', { ticket_id: first.short as string, project: 'Gadgets', wait_seconds: 10 }))
    expect(moved).toMatchObject({
      stopped: { ticket_id: first.ticket_id, outcome: 'stopped', project: 'Widgets', link: old.link },
      filed: { status: 'accepted', filed_in: 'Gadgets', project: 'Gadgets' },
      leftover: { branch: old.branch, worktree: old.worktreePath,
        cleanup: [`git -C ${realpathSync(env.widgets)} worktree remove ${old.worktreePath}`, `git -C ${realpathSync(env.widgets)} branch -D ${old.branch}`] },
    })
    expect(runtime.repo.tickets.get(first.ticket_id as string)!.ended).toMatchObject({ outcome: 'stopped', by: 'human', reason: 'Rerouted to Gadgets' })
    const filed = moved.filed as { ticket_id: string; trigger_id: string; link: string }
    expect(runtime.repo.triggers.get(filed.trigger_id)).toMatchObject({ text: 'Count the gadgets', meta: { project: 'p-gadgets', projectBy: 'operator' } })
    const thread = await until(() => env.t3.workerThreads().find(item => item.projectId === 'p-gadgets'), 'the gadgets thread')
    expect(filed.link).toBe(thread.link)
    expect(worktreesOf(env.gadgets)).toContain(realpathSync(thread.worktreePath!))
    // The service deleted nothing: the old worktree and branch are still there.
    expect(worktreesOf(env.widgets)).toContain(realpathSync(old.worktreePath))
    expect(git(env.widgets, 'branch', '--list', old.branch!)).toContain(old.branch!)
  })

  it('returns the first filing when a reroute is repeated, and refuses to reroute an already rerouted ticket elsewhere', async () => {
    const { env, call } = await open()
    const { runtime } = env.made
    const first = data(await call('superagent_request', { text: 'Count the gadgets', wait_seconds: 10 }))
    await until(() => env.t3.workerThreads()[0], 'the first worker thread')
    const moved = data(await call('superagent_reroute', { ticket_id: first.ticket_id as string, project: 'Gadgets', wait_seconds: 10 }))
    // An agent whose call timed out calls again: the same filing comes back, and no second ticket is made.
    const again = data(await call('superagent_reroute', { ticket_id: first.ticket_id as string, project: 'gadgets', wait_seconds: 10 }))
    expect(again).toMatchObject({ repeated: true, stopped: moved.stopped, filed: { trigger_id: (moved.filed as { trigger_id: string }).trigger_id,
      status: 'accepted', ticket_id: (moved.filed as { ticket_id: string }).ticket_id }, leftover: moved.leftover })
    expect(runtime.repo.tickets.list().filter(ticket => runtime.binding(ticket.id)?.projectId === 'p-gadgets')).toHaveLength(1)
    // Rerouting it once more, to another project, is the new ticket's reroute.
    const elsewhere = await call('superagent_reroute', { ticket_id: first.ticket_id as string, project: 'Widgets' })
    expect(elsewhere.isError).toBe(true)
    expect(JSON.stringify(elsewhere.content)).toContain(`was rerouted to Gadgets already, as request ${(moved.filed as { trigger_id: string }).trigger_id}`)
    expect(runtime.repo.tickets.list()).toHaveLength(2)
  })

  it('refuses an answer on a rerouted ticket, live or ended, so nothing is filed or resumed in the old project', async () => {
    const { env, call } = await open()
    const { runtime } = env.made
    // A running ticket rerouted: an answer on it would go to Eval and be filed in Widgets again, by its inherited hint.
    const first = data(await call('superagent_request', { text: 'Count the gadgets', wait_seconds: 10 }))
    await until(() => env.t3.workerThreads()[0], 'the first worker thread')
    const moved = data(await call('superagent_reroute', { ticket_id: first.short as string, project: 'Gadgets', wait_seconds: 10 }))
    const filed = moved.filed as { ticket_id: string; short: string }
    const origin = runtime.repo.triggers.get(runtime.repo.tickets.get(first.ticket_id as string)!.origin.triggerId)!
    const thread = () => JSON.stringify(runtime.repo.threads.get(threadKey(origin.threads[0]!)))
    const before = thread()
    const refused = await call('superagent_answer', { ticket_id: first.short as string, text: 'Also count the blue ones' })
    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused.content)).toContain(`was rerouted to Gadgets, and its work goes on there in ticket ${filed.short}`)
    expect(thread()).toBe(before)

    // A ticket that had ended before its reroute: an answer would resume it in Widgets while the Gadgets ticket works.
    const second = data(await call('superagent_request', { text: 'Count the widgets', wait_seconds: 10 }))
    await until(() => env.t3.workerThreads().filter(item => item.projectId === 'p-widgets').length === 2, 'the second widgets worker thread')
    runtime.engine.report(second.ticket_id as string, { state: 'ready', summary: 'Counted.' })
    expect(runtime.repo.tickets.get(second.ticket_id as string)!.ended).toMatchObject({ outcome: 'completed' })
    const rerouted = data(await call('superagent_reroute', { ticket_id: second.short as string, project: 'Gadgets', wait_seconds: 10 }))
    expect(rerouted).toMatchObject({ stopped: { outcome: 'completed' }, filed: { status: 'accepted', project: 'Gadgets' } })
    const assignments = runtime.repo.tickets.get(second.ticket_id as string)!.assignments.length
    const again = await call('superagent_answer', { ticket_id: second.ticket_id as string, text: 'Count the red ones too' })
    expect(again.isError).toBe(true)
    expect(JSON.stringify(again.content)).toContain('was rerouted to Gadgets')
    await new Promise(resolve => setTimeout(resolve, 100))
    const old = runtime.repo.tickets.get(second.ticket_id as string)!
    expect(old.ended).toMatchObject({ outcome: 'completed' })
    expect(old.assignments).toHaveLength(assignments)
    // Two requests, each rerouted once: two tickets in Widgets that ended, two in Gadgets, and nothing more.
    expect(runtime.repo.tickets.list().map(ticket => runtime.binding(ticket.id)?.key).sort()).toEqual(['Gadgets', 'Gadgets', 'Widgets', 'Widgets'])
  })

  it('answers superagent_ticket for a trigger id: the ticket once there is one, else what became of the request', async () => {
    const { env, call } = await open({ config: { unnamedRequests: 'refuse' } })
    const accepted = data(await call('superagent_request', { text: 'Fix the gadget count', project: 'Gadgets', wait_seconds: 10 }))
    expect(accepted.result).toMatch(new RegExp(`^accepted ${accepted.short} in Gadgets \\(from main\\), https://`))
    expect(data(await call('superagent_ticket', { ticket_id: accepted.trigger_id as string }))).toMatchObject({ id: accepted.ticket_id,
      project: { id: 'p-gadgets', key: 'Gadgets', title: 'Gadgets' } })
    const ignored = consoleTrigger('hector', 'No project here')
    env.made.runtime.engine.receive(ignored)
    await until(() => env!.made.runtime.repo.decisions.byThread(threadKey(ignored.threads[0]!))[0], 'the ignore')
    expect(data(await call('superagent_ticket', { ticket_id: ignored.id }))).toMatchObject({ status: 'ignored', text: 'No project here',
      result: expect.stringMatching(/^ignored: Name the project/) })
    expect(data(await call('superagent_attention', {}))).toMatchObject({ ignored: [expect.objectContaining({ trigger_id: ignored.id })] })
    const missing = await call('superagent_ticket', { ticket_id: 'console:nothing' })
    expect(missing.isError).toBe(true)
    expect(JSON.stringify(missing.content)).toContain('No ticket or request console:nothing')
  })

  it('introduces a new console thread with the project rules, and tells one an earlier version introduced, once', async () => {
    const requestId = `superagent-console:${createHash('sha256').update('console-secret').digest('hex').slice(0, 16)}`
    const first = (await open()).env
    await first.made.runtime.ensureConsole()
    await first.made.runtime.ensureConsole()
    const fresh = [...first.t3.threads.values()].find(item => item.title === 'Superagent')!
    expect(fresh.messages.map(message => message.clientRequestId)).toEqual([`${requestId}:intro`])
    expect(fresh.messages[0]!.text).toContain('pass `project` (its key) on every superagent_request')
    expect(fresh.messages[0]!.text).toContain('superagent_reroute')
    expect(first.made.runtime.repo.kv.get('console:intro')).toBe(2)
    await console!.close(); console = undefined; await first.made.close(); env = undefined

    // The thread an earlier version launched and introduced, under the same request id, on a database without the version.
    const t3 = new FakeT3([{ id: 'p-widgets', workspaceRoot: first.widgets, title: 'Widgets' }, { id: 'p-gadgets', workspaceRoot: first.gadgets, title: 'Gadgets' }],
      { checkWorktrees: true })
    await t3.launchScratch({ title: 'Superagent', clientRequestId: requestId, message: 'This is the Superagent console.' })
    const database = join(first.dir, 'state.sqlite')
    const second = await setup({ dir: first.dir, t3, database })
    await second.made.runtime.ensureConsole()
    await second.made.close()
    env = await setup({ dir: first.dir, t3, database })
    await env.made.runtime.ensureConsole()
    const old = [...t3.threads.values()].find(item => item.title === 'Superagent')!
    expect(old.messages.map(message => message.clientRequestId)).toEqual([requestId, `${requestId}:intro-v2`])
    expect(old.messages[1]!.text).toContain('If a ticket went to the wrong project, use superagent_reroute')
  })
})

// The branch of a rerouted ticket can hold commits; `git branch -D` in the cleanup list is what removes it, which is why the
// list says so. Checked here so the note stays true.
describe('the reroute cleanup commands', () => {
  it('remove a worktree and a branch with a commit', async () => {
    const env = await setup()
    try {
      const trigger = named('Fix the gadget count', 'p-gadgets')
      env.made.runtime.engine.receive(trigger)
      const thread = await until(() => env.t3.workerThreads()[0], 'the worker thread')
      commit(thread.worktreePath!, 'count.txt', '3\n')
      const ticketId = await env.ticketOf(trigger)
      const consoleClient = await mcp(`${env.made.base}/mcp/console/console-secret`)
      const moved = data(await consoleClient.callTool({ name: 'superagent_reroute', arguments: { ticket_id: ticketId, project: 'Widgets', wait_seconds: 0 } }))
      await consoleClient.close()
      const { cleanup } = moved.leftover as { cleanup: string[] }
      const path = realpathSync(thread.worktreePath!)
      for (const command of cleanup) git(env.dir, ...command.split(' ').slice(1))
      expect(worktreesOf(env.gadgets)).not.toContain(path)
      expect(git(env.gadgets, 'branch', '--list', thread.branch!)).toBe('')
    } finally { await env.made.close() }
  })
})

describe('SUPERAGENT_UNNAMED_REQUESTS', () => {
  it('is read by loadConfig: default when unset, refuse when set, and anything else is an error', () => {
    const env = { SUPERAGENT_PROJECT_ROOT: '/tmp/widgets', SUPERAGENT_STATE_DIR: '/tmp/superagent-state' }
    expect(loadConfig(env).unnamedRequests).toBe('default')
    expect(loadConfig({ ...env, SUPERAGENT_UNNAMED_REQUESTS: 'refuse' }).unnamedRequests).toBe('refuse')
    expect(() => loadConfig({ ...env, SUPERAGENT_UNNAMED_REQUESTS: 'ask' })).toThrow(/Expected one of default, refuse, got ask/)
  })
})
