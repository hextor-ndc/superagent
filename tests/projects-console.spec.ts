/**
 * Phases 1 to 3a of docs/multi-project-plan.md in the Runtime: the console's `superagent_projects`, a console-only start with
 * no project configured, the refusal of unnamed requests when no project is the default (D21), tickets that keep their
 * project across a start without one, and the Watchdog's `projects` part.
 */
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { threadKey } from '../vendor/dsh/src/core/index.ts'
import { consoleTrigger } from '../src/app/console-source.ts'
import { ProjectRegistry } from '../src/app/projects.ts'
import { Runtime } from '../src/app/runtime.ts'
import type { Config } from '../src/config.ts'
import { unregistered } from '../src/executor/t3-executor.ts'
import { watchdogCheck } from '../src/mcp/watchdog-tools.ts'
import { FakeT3, SCRATCH_PROJECT } from './fake-t3.ts'
import { checkout, data, harness, mcp, until, type Harness } from './harness.ts'

/** A Runtime with no project configured, on a registry loaded from `t3` and the catalogue in `dir`. */
async function consoleOnly(t3: FakeT3, dir: string, overrides: Partial<Config> = {}) {
  const stateDir = join(dir, 'state')
  const projects = await ProjectRegistry.load({ t3, stateDir, catalogue: join(dir, 'repositories.json'), projectsFile: join(stateDir, 'projects.json') })
  return harness(t3, { dir, root: join(dir, 'unused') }, ':memory:', { legacy: undefined, ...overrides }, { projects })
}
const catalogue = (dir: string, repositories: { path: string; purpose?: string; notes?: string }[]) =>
  writeFileSync(join(dir, 'repositories.json'), JSON.stringify({ workspace: dir, repositories }))

describe('projects in the console', () => {
  let made: Harness | undefined
  afterEach(async () => { await made?.close(); made = undefined })

  it('starts console-only with no project in T3 Code, opens the console, and refuses requests without storing them', async () => {
    const { dir } = checkout()
    catalogue(dir, [])
    const t3 = new FakeT3([])
    made = await consoleOnly(t3, dir)
    await made.runtime.prepare()
    await made.runtime.ensureConsole()
    expect(t3.threads.get(made.runtime.console!.threadId)).toMatchObject({ title: 'Superagent', pinned: true })
    expect(made.runtime.workProject).toBeUndefined()
    expect(made.runtime.github).toBeUndefined()

    const console = await mcp(`${made.base}/mcp/console/console-secret`)
    const listed = data(await console.callTool({ name: 'superagent_projects', arguments: {} }))
    expect(listed).toMatchObject({ summary: 'no projects', total: 0, projects: [],
      work: expect.stringMatching(/^Name the project on every superagent_request with project=<key>\. There is no default .* 0 projects are ready\./) })
    const refused = await console.callTool({ name: 'superagent_request', arguments: { text: 'Fix the README' } })
    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused.content)).toContain('Name the project: superagent_request with project=<key>')
    const unknown = await console.callTool({ name: 'superagent_request', arguments: { text: 'Fix the README', project: 'widgets' } })
    expect(JSON.stringify(unknown.content)).toContain('No project widgets in T3 Code.')
    expect(made.runtime.repo.threads.list()).toEqual([])
    expect(made.runtime.repo.tickets.list()).toEqual([])
    await console.close()
  })

  it('leaves t3code\'s scratch project, which holds the console and the Watchdog, out of the projects', async () => {
    const place = checkout()
    catalogue(place.dir, [])
    const t3 = new FakeT3([{ id: 'project-1', workspaceRoot: place.root, title: 'Widgets' }])
    made = await consoleOnly(t3, place.dir, { watchdogMinutes: 15 })
    // A start after the console thread exists: T3 Code lists the scratch project from the first load on.
    await t3.launchScratch({ title: 'Earlier thread', clientRequestId: 'earlier' })
    expect((await t3.listProjects()).map(project => project.title)).toEqual(['Widgets', 'No project'])
    await made.runtime.projects.refresh()
    await made.runtime.ensureWatchdog()
    await made.runtime.ensureConsole()
    const console = await mcp(`${made.base}/mcp/console/console-secret`)
    const listed = data(await console.callTool({ name: 'superagent_projects', arguments: { refresh: true } }))
    expect(listed).toMatchObject({ summary: '1 ready', total: 1 })
    expect(made.runtime.projects.list().map(entry => entry.id)).toEqual(['project-1'])
    expect(made.runtime.projects.byId(SCRATCH_PROJECT)).toBeUndefined()
    await console.close()
  })

  it('refuses requests when several projects are ready and none is configured, and lists them with their catalogue purpose', async () => {
    const { dir } = checkout('widgets')
    checkout('gadgets', dir)
    checkout('PERSONAL/diary', dir)
    catalogue(dir, [{ path: 'widgets', purpose: 'Widget shop.', notes: 'Payments in src/pay.' }, { path: 'docs', purpose: 'Docs.' },
      { path: 'PERSONAL/diary', purpose: 'A private diary.' }])
    const t3 = new FakeT3([{ id: 'p-widgets', workspaceRoot: join(dir, 'widgets'), title: 'Widgets' },
      { id: 'p-diary', workspaceRoot: join(dir, 'PERSONAL', 'diary'), title: 'Diary' }])
    made = await consoleOnly(t3, dir)
    const console = await mcp(`${made.base}/mcp/console/console-secret`)
    const call = async (name: string, args: Record<string, unknown> = {}) => data(await console.callTool({ name, arguments: args }))

    t3.addProject({ id: 'p-gadgets', workspaceRoot: join(dir, 'gadgets'), title: 'Gadgets' })
    const refreshed = await call('superagent_projects', { refresh: true })
    expect(refreshed).toMatchObject({ summary: '2 ready, 1 denied, 1 missing-checkout', total: 4 })
    expect(refreshed.projects).toEqual([
      expect.objectContaining({ key: 'Gadgets', status: 'ready', access: 'named', delivery: 'branch', base_ref: 'main', open_tickets: 0, last_ticket: null,
        worktree_root: join(dir, 'state', 'worktrees', 'gadgets') }),
      expect.objectContaining({ key: 'widgets', title: 'Widgets', id: 'p-widgets', status: 'ready', purpose: 'Widget shop.', notes: 'Payments in src/pay.' }),
      expect.objectContaining({ key: 'PERSONAL/diary', status: 'denied', description: expect.stringContaining('withheld') }),
      expect.objectContaining({ key: 'docs', status: 'missing-checkout' }),
    ])
    // Catalogue text from PERSONAL/ is not sent to the console's model.
    expect(JSON.stringify(refreshed)).not.toContain('A private diary')
    expect(refreshed).toMatchObject({ side_effects: expect.stringContaining('.git/info/exclude'), setup: expect.stringContaining('PR watching') })

    const many = await console.callTool({ name: 'superagent_request', arguments: { text: 'Fix the README' } })
    expect(many.isError).toBe(true)
    expect(JSON.stringify(many.content)).toContain('Name the project: superagent_request with project=<key> (superagent_projects lists them). '
      + 'No project is the default: no legacy project is set and 2 projects are ready (Gadgets, widgets).')
    expect(made.runtime.repo.tickets.list()).toEqual([])

    expect(await call('superagent_projects', { query: 'widgets' })).toMatchObject({ total: 1, projects: [{ key: 'widgets' }] })
    expect(await call('superagent_projects', { query: 'payments' })).toMatchObject({ total: 1, projects: [{ key: 'widgets' }] })
    expect(await call('superagent_projects', { query: 'diary' })).toMatchObject({ total: 1, projects: [{ key: 'PERSONAL/diary' }] })
    // Withheld text is not searched either, so a query cannot reveal it.
    expect(await call('superagent_projects', { query: 'a private diary' })).toMatchObject({ total: 0 })
    expect(await call('superagent_projects', { status: 'ready', limit: 1 })).toMatchObject({ total: 2, projects: [{ key: 'Gadgets' }] })
    expect(await call('superagent_projects', { query: 'gadge' })).toMatchObject({ total: 1 })
    expect(await call('superagent_projects', { query: 'zzz' })).toMatchObject({ total: 0, suggestions: [] })

    // A refresh that fails says so, and the list is the last one read.
    const list = t3.listProjects.bind(t3)
    t3.listProjects = async () => { throw new Error('t3_project_list: network: connection refused') }
    expect(await call('superagent_projects', { refresh: true })).toMatchObject({ total: 4, refresh_failed: expect.stringContaining('connection refused'),
      note: 'The list is the last one read.' })
    t3.listProjects = list

    // A request that reaches the Engine some other way takes no ticket: no project is the default, so the rules router ignores it
    // with the reason, as the accept would roll back.
    const other = consoleTrigger('hector', 'Fix the README')
    made.runtime.engine.receive(other)
    const decision = await until(() => made!.runtime.repo.decisions.byThread(threadKey(other.threads[0]!))[0], 'the decision')
    expect(decision).toMatchObject({ kind: 'ignore' })
    expect(JSON.stringify(decision)).toContain('Name the project: superagent_request with project=<key>')
    expect(made.runtime.repo.tickets.list()).toEqual([])
    expect(made.runtime.repo.kv.list('ticket-project:')).toEqual([])
    await console.close()
  })

  it('lists the legacy project as the one requests go to, with its tickets', async () => {
    const place = checkout()
    const t3 = new FakeT3([{ id: 'project-1', workspaceRoot: place.root }])
    const projects = await ProjectRegistry.load({ t3, stateDir: join(place.dir, 'state'),
      legacy: { root: place.root, worktreeRoot: join(place.dir, 'worktrees'), baseRef: 'HEAD', repository: 'acme/widgets' } })
    // The Runtime runs the registry's timed refresh while it runs.
    const start = vi.spyOn(projects, 'start'), stop = vi.spyOn(projects, 'stop')
    made = await harness(t3, place, ':memory:', {}, { projects })
    expect(start).toHaveBeenCalledTimes(1)
    const console = await mcp(`${made.base}/mcp/console/console-secret`)
    await console.callTool({ name: 'superagent_request', arguments: { text: 'Fix the typo in the README heading' } })
    await until(() => t3.workerThreads()[0], 'the worker thread')
    const listed = data(await console.callTool({ name: 'superagent_projects', arguments: {} }))
    expect(listed).toMatchObject({ summary: '1 ready', work: 'Name the project on every superagent_request with project=<key>. Requests that name none go '
      + 'to widgets, the default (the project SUPERAGENT_PROJECT_ROOT names).',
      projects: [{ key: 'widgets', legacy: true, access: 'work', delivery: 'pr', open_tickets: 1, last_ticket: expect.any(String), worktree_root: join(place.dir, 'worktrees') }] })
    // Also after a refresh, which makes new entries.
    expect(data(await console.callTool({ name: 'superagent_projects', arguments: { refresh: true } }))).toMatchObject({ projects: [{ key: 'widgets', open_tickets: 1 }] })
    await console.close()
    await made.close()
    made = undefined
    expect(stop).toHaveBeenCalled()
  })

  it('takes an unnamed request into the one ready project when no legacy project is set (D21), and says so', async () => {
    const { dir } = checkout('widgets')
    catalogue(dir, [{ path: 'widgets', purpose: 'Widget shop.' }])
    const t3 = new FakeT3([{ id: 'p-widgets', workspaceRoot: join(dir, 'widgets'), title: 'Widgets' }])
    made = await consoleOnly(t3, dir)
    const console = await mcp(`${made.base}/mcp/console/console-secret`)
    expect(data(await console.callTool({ name: 'superagent_projects', arguments: {} }))).toMatchObject({
      work: 'Name the project on every superagent_request with project=<key>. Requests that name none go to widgets, the default (the only ready project).' })
    const accepted = await console.callTool({ name: 'superagent_request', arguments: { text: 'Fix the README' } })
    expect(accepted.isError).toBeFalsy()
    expect(data(accepted)).toMatchObject({ status: 'accepted', filed_in: 'widgets, the default for requests that name no project', project: 'widgets' })
    const thread = await until(() => t3.workerThreads()[0], 'the worker thread')
    const ticket = made.runtime.repo.tickets.list()[0]!
    expect(made.runtime.binding(ticket.id)).toMatchObject({ projectId: 'p-widgets', key: 'widgets', by: 'single', delivery: 'branch',
      worktreeRoot: join(dir, 'state', 'worktrees', 'widgets') })
    expect(thread).toMatchObject({ projectId: 'p-widgets', worktreePath: join(dir, 'state', 'worktrees', 'widgets', ticket.execution!.name) })
    expect(data(await console.callTool({ name: 'superagent_projects', arguments: {} }))).toMatchObject({ projects: [{ key: 'widgets', open_tickets: 1 }] })
    await console.close()
  })

  it('starts without a project when the open tickets of the earlier one carry their binding', async () => {
    const place = checkout()
    const database = join(place.dir, 'state.sqlite')
    const t3 = new FakeT3([{ id: 'project-1', workspaceRoot: place.root }])
    made = await harness(t3, place, database)
    made.runtime.engine.receive(consoleTrigger('hector', 'Speed up the build'))
    await until(() => t3.workerThreads()[0], 'the worker thread')
    await made.close()
    made = undefined
    // Started again with no project configured, as main.ts builds it: the ticket keeps the project it was accepted into.
    const projects = await ProjectRegistry.load({ t3: new FakeT3([]), stateDir: join(place.dir, 'state') })
    const config = { ...noProjectConfig(place.dir), database }
    const runtime = new Runtime(config, new FakeT3([]), projects)
    await runtime.prepare()
    expect(runtime.binding(runtime.repo.tickets.list()[0]!.id)).toMatchObject({ projectId: 'project-1', by: 'legacy' })
    await runtime.stop()
  })

  it('fails a ticket that resumes its launch after its project left T3 Code, rather than leaving it waiting', async () => {
    const place = checkout()
    const database = join(place.dir, 'state.sqlite')
    const t3 = new FakeT3([{ id: 'project-1', workspaceRoot: place.root }])
    // The launch never answers, so the Assignment is still pending when the service stops.
    t3.launch = () => new Promise(() => {})
    made = await harness(t3, place, database)
    made.runtime.engine.receive(consoleTrigger('hector', 'Speed up the build'))
    await until(() => made!.runtime.repo.tickets.list()[0]?.execution, 'the accepted ticket')
    await made.close()
    // Started again with no project, and T3 Code no longer has the ticket's: the new thread's launch fails the ticket.
    const projects = await ProjectRegistry.load({ t3: new FakeT3([]), stateDir: join(place.dir, 'state') })
    const empty = new FakeT3([])
    made = await harness(empty, place, database, { legacy: undefined }, { projects })
    const binding = made.runtime.binding(made.runtime.repo.tickets.list()[0]!.id)!
    const failed = await until(() => {
      const ticket = made!.runtime.repo.tickets.list()[0]
      return ticket && JSON.stringify(ticket).includes(JSON.stringify(unregistered(binding)).slice(1, -1)) ? ticket : undefined
    }, 'the failed launch')
    expect(failed.id).toBeDefined()
    expect(empty.calls.filter(call => call.tool === 't3_thread_launch' && !(call.args as { scratch?: boolean }).scratch)).toEqual([])
  })

  it('needs a console token: loadConfig leaves it empty until main.ts reads or makes the saved one', async () => {
    const place = checkout()
    const t3 = new FakeT3([{ id: 'project-1', workspaceRoot: place.root }])
    await expect(harness(t3, place, ':memory:', { consoleToken: '' })).rejects.toThrow(/No console token/)
  })
})

describe('the Watchdog and projects', () => {
  let made: Harness | undefined
  afterEach(async () => { await made?.close(); made = undefined })
  const requestId = (token: string) => `superagent-watchdog:${createHash('sha256').update(token).digest('hex').slice(0, 16)}`

  it('lists projects among the parts it checks, and reports their summary', async () => {
    const place = checkout()
    const t3 = new FakeT3([{ id: 'project-1', workspaceRoot: place.root }])
    made = await harness(t3, place, ':memory:', { watchdogMinutes: 15 })
    await made.runtime.ensureWatchdog()
    await made.runtime.ensureWatchdog()
    const thread = [...t3.threads.values()].find(item => item.title === 'Superagent Watchdog')!
    expect(thread.messages.map(message => message.clientRequestId)).toEqual([`${requestId('console-secret')}:setup`])
    expect(thread.messages[0]!.text).toContain('(t3code, github, router, watchdog, projects, jobs:*)')
    expect(made.runtime.repo.kv.get('watchdog:setup')).toBe(2)
    expect(watchdogCheck(made.runtime).projects).toMatchObject({ summary: '1 ready', refreshedAt: expect.any(String) })
  })

  it('tells a Watchdog thread set up by an earlier version about the projects part, once', async () => {
    const place = checkout()
    const t3 = new FakeT3([{ id: 'project-1', workspaceRoot: place.root }])
    // The thread an earlier version launched and set up, under the same request id.
    await t3.launchScratch({ title: 'Superagent Watchdog', clientRequestId: requestId('console-secret'), message: 'You are the Watchdog of the superagent.' })
    made = await harness(t3, place, ':memory:', { watchdogMinutes: 15 })
    await made.runtime.ensureWatchdog()
    await made.runtime.ensureWatchdog()
    const thread = [...t3.threads.values()].find(item => item.title === 'Superagent Watchdog')!
    expect(thread.messages.map(message => message.clientRequestId)).toEqual([requestId('console-secret'), `${requestId('console-secret')}:setup-v2`])
    expect(thread.messages[1]!.text).toContain('`projects`')
    expect(made.runtime.repo.kv.get('watchdog:setup')).toBe(2)
  })
})

/** A configuration with no project, for a Runtime built without the harness. */
function noProjectConfig(dir: string): Config {
  return { t3Url: 'unused', t3Token: 'unused', tokenFile: 'unused', stateDir: join(dir, 'state'), projectsFile: join(dir, 'state', 'projects.json'),
    router: { kind: 'rules', model: 'claude-opus-5-5', effort: 'medium', acceptMode: 'observe' }, port: 0, publicUrl: '', consoleToken: 'console-secret',
    watchdogMinutes: 0, database: ':memory:', operator: 'hector', maxWorkers: 2, log: () => {} }
}
