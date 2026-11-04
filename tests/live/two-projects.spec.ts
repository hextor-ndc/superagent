/**
 * Two projects end to end against a real, isolated `t3 serve` (tests/live/t3-server.ts), with superagent run as the operator
 * runs it: `src/main.ts start` in its own process, the rules Router, no model credentials, and a temp state dir.
 *
 * - `widgets` (the server's checkout) is the legacy project (SUPERAGENT_PROJECT_ROOT);
 * - `gadgets` is a second T3 Code project, which gets its worktrees under `<stateDir>/worktrees/gadgets`;
 * - `vault` is a third T3 Code project that projects.json denies.
 *
 * A request naming gadgets and an unnamed one go in through the console MCP server; each worker thread must run in its own
 * project. The gadgets worker's branch gets a commit while its turn runs, so the ended ticket shows in `to_review`. The
 * service is killed (SIGKILL, so the lock is stale) while both workers run, started again, and must finish both tickets.
 * Then a ticket filed in the wrong project is rerouted (an answer on the old ticket is refused), and requests naming a denied
 * or unknown project are refused. t3code's scratch project, which the console thread puts in its list, is not listed.
 * The console's tool list has `superagent_new_project_form` with its MCP App resource, as `superagent_attention` has.
 * Last, `superagent_new_project` starts `PERSONAL/garden` in the temp catalogue (repositories.json and REPOSITORIES.md in the
 * server's folder, which is the catalogue's workspace): the folder, its git repository, the T3 Code project through the t3
 * CLI on this server's base dir, both catalogue entries, and a first request whose worker runs in the new project's worktree.
 * Then `superagent_add_project` adds `NDC/oldshop`, a git checkout that exists already and is catalogued but not in T3 Code:
 * a request there is refused naming the tool, the tool adds it through the CLI on this server's base dir (T3 Code lists it
 * over /mcp, with the catalogue path as its title), it is ready, and a first request's worker runs in its own worktree.
 *
 * Run with `T3_LIVE=1 npx vitest run tests/live/two-projects.spec.ts`; `TWO_PROJECTS_LOGS=1` prints the service's output.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { McpT3Client } from '../../src/t3/client.ts'
import { ATTENTION_URI, MCP_APP_MIME, NEW_PROJECT_URI, newProjectPage } from '../../src/mcp/attention-app.ts'
import { eventually, freePort, live, poll, skipReason, startT3, t3Bin, type T3Server } from './t3-server.ts'

const REPO = fileURLToPath(new URL('../..', import.meta.url))
const TEST_MS = 300_000
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim()
const data = (result: unknown) => (result as { structuredContent: Record<string, unknown> }).structuredContent
/** Diagnostics for a failure, as the live suites print them. */
const say = (...parts: unknown[]) => console.log('[two-projects]', ...parts.map(part => typeof part === 'string' ? part : JSON.stringify(part, null, 1)))

interface Service { child: ChildProcess; output: () => string; console: Client; exited: Promise<number | null> }

describe.skipIf(!live)(`superagent with two projects on a real t3code${live ? '' : ` (skipped: ${skipReason})`}`, () => {
  let server: T3Server
  let probe: McpT3Client
  let gadgets: { id: string; root: string }
  let vault: { id: string; root: string }
  let stateDir: string, port: number
  let service: Service | undefined
  const consoleToken = 'console-two-projects'
  const logs: string[] = []

  async function addProject(title: string): Promise<{ id: string; root: string }> {
    const root = join(server.dir, title)
    execFileSync('git', ['init', '-q', '-b', 'main', root])
    writeFileSync(join(root, 'README.md'), `# ${title}\n`)
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'init')
    const added = await server.cli('project', 'add', '--title', title, root)
    const id = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(added)?.[0]
    if (!id) throw new Error(`t3 project add printed no id: ${added}`)
    return { id, root: realpathSync(root) }
  }

  /** `src/main.ts start` as its own process, with only the environment this test gives it. */
  async function startService(): Promise<Service> {
    const token = await server.token('full-access')
    const env: NodeJS.ProcessEnv = {}
    for (const [name, value] of Object.entries(process.env)) {
      if (/^(SUPERAGENT_|ANTHROPIC_|T3_MCP_|T3CODE_|GH_|GITHUB_)/.test(name)) continue
      env[name] = value
    }
    Object.assign(env, {
      SUPERAGENT_PROJECT_ROOT: server.checkout, SUPERAGENT_STATE_DIR: stateDir, SUPERAGENT_ROUTER: 'rules', SUPERAGENT_MODEL: 'scripted/plain',
      SUPERAGENT_WATCHDOG_MINUTES: '0', SUPERAGENT_OPERATOR: 'hector', SUPERAGENT_CONSOLE_TOKEN: consoleToken, SUPERAGENT_PORT: String(port),
      SUPERAGENT_PUBLIC_URL: `http://127.0.0.1:${port}`, T3_MCP_URL: server.url, T3_MCP_TOKEN: token,
      // superagent_new_project: the temp catalogue, the t3 CLI on this server's base dir only, and git with an identity of the test's own.
      SUPERAGENT_CATALOGUE: join(server.dir, 'repositories.json'), T3_BIN: t3Bin, SUPERAGENT_T3_BASE_DIR: server.baseDir,
      T3CODE_TELEMETRY_ENABLED: 'false', TMPDIR: server.dir, GIT_CONFIG_GLOBAL: join(server.dir, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    })
    let output = ''
    const child = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', '--import', 'tsx', 'src/main.ts', 'start'],
      { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout!.on('data', chunk => { output += String(chunk) })
    child.stderr!.on('data', chunk => { output += String(chunk) })
    const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)))
    await poll(() => {
      if (child.exitCode !== null) throw new Error(`superagent exited with ${child.exitCode}:\n${output}`)
      return output.includes('[superagent] ready:')
    }, 'superagent to be ready', 60_000)
    const client = new Client({ name: 'console', version: '0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/console/${consoleToken}`)))
    return { child, output: () => output, console: client, exited }
  }
  async function stopService(signal: NodeJS.Signals): Promise<void> {
    if (!service) return
    const { child, console, exited, output } = service
    service = undefined
    await console.close().catch(() => {})
    if (child.exitCode === null) child.kill(signal)
    await exited
    logs.push(output())
  }
  const raw = (name: string, args: Record<string, unknown> = {}) => service!.console.callTool({ name, arguments: args })
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await raw(name, args)
    if (result.isError) throw new Error(`${name}: ${JSON.stringify(result.content)}`)
    return data(result)
  }
  /** What t3code itself says of a ticket's thread: found by its `[T-xxxxxxxx]` title in the project's thread list. */
  type Seen = { threadId: string; projectId: string; worktreePath: string; branch: string; status: string }
  async function threadOf(short: string): Promise<Seen> {
    return eventually<Seen>(async () => {
      const listed = await probe.call<{ threads: { threadId: string; projectId: string; title: string }[] }>('t3_thread_list', { allProjects: true, limit: 100 })
      const found = listed.threads.find(thread => thread.title.startsWith(`[${short}]`))
      if (!found) return undefined
      const read = await probe.call<{ thread: { projectId: string; worktreePath: string | null; branch: string | null; status: string } }>('t3_thread_read',
        { threadId: found.threadId, limit: 1 })
      return read.thread.worktreePath ? { threadId: found.threadId, ...read.thread } as Seen : undefined
    }, `the thread of ${short}`, 60_000)
  }
  const ticket = (id: string) => call('superagent_ticket', { ticket_id: id }) as Promise<Record<string, unknown> & { outcome?: string; stage: string }>
  const ended = (id: string, ms = 90_000) => eventually(async () => { const view = await ticket(id); return view.outcome ? view : undefined }, `${id} to end`, ms)
  const triggerCount = () => {
    const db = new DatabaseSync(join(stateDir, 'state.sqlite'), { readOnly: true })
    try { return (db.prepare('SELECT count(*) AS n FROM trigger').get() as { n: number }).n } finally { db.close() }
  }

  beforeAll(async () => {
    server = await startT3()
    probe = await server.client('full-access')
    gadgets = await addProject('gadgets')
    vault = await addProject('vault')
    stateDir = join(server.dir, 'state')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'projects.json'), JSON.stringify({ [vault.root]: { access: 'deny' } }, null, 2))
    // An empty catalogue of the server's folder, and the index next to it, for superagent_new_project.
    writeFileSync(join(server.dir, 'repositories.json'), `${JSON.stringify({ schema_version: 1, workspace: server.dir,
      scope: '0 mapped entries: 0 Git repositories, 0 linked worktrees and 0 additional project or reference folders.', repositories: [] }, null, 2)}\n`)
    writeFileSync(join(server.dir, 'REPOSITORIES.md'), ['# Index', '', '## Repository and project catalog', '', '### PERSONAL', '',
      '| Project guide | Kind | Function | Main modules / where to look |', '|---|---|---|---|', '', '## Maintain this index', ''].join('\n'))
    writeFileSync(join(server.dir, 'gitconfig'), '[user]\n\tname = Live Test\n\temail = live@example.test\n')
    port = await freePort()
    service = await startService()
  }, TEST_MS)
  afterAll(async () => {
    await stopService('SIGTERM').catch(() => {})
    if (process.env.TWO_PROJECTS_LOGS === '1') for (const log of logs) console.log(log)
    await server?.close()
  }, 60_000)

  it('lists the three projects with their status and worktree folders, and not t3code\'s scratch project', async () => {
    const listed = await call('superagent_projects', { refresh: true }) as { projects: Record<string, unknown>[]; summary: string; work: string }
    // The console thread made t3code's scratch project ("No project"); T3 Code lists it, the registry does not.
    const registered = await probe.listProjects()
    expect(registered.map(project => project.title)).toContain('No project')
    expect(listed.summary).toBe('2 ready, 1 denied')
    expect(listed.projects.map(row => row.key).sort()).toEqual(['gadgets', 'vault', 'widgets'])
    expect(service!.output()).not.toContain('project No project')
    const byKey = Object.fromEntries(listed.projects.map(row => [row.key, row]))
    expect(byKey.widgets).toMatchObject({ id: server.projectId, status: 'ready', legacy: true, access: 'work', delivery: 'branch' })
    expect(byKey.gadgets).toMatchObject({ id: gadgets.id, status: 'ready', access: 'named', delivery: 'branch', base_ref: 'main',
      worktree_root: join(stateDir, 'worktrees', 'gadgets') })
    expect(byKey.vault).toMatchObject({ id: vault.id, status: 'denied', access: 'deny' })
    expect(listed.work).toContain('go to widgets')
  }, TEST_MS)

  let gadgetsTicket: string, widgetsTicket: string
  let gadgetsThread: Awaited<ReturnType<typeof threadOf>>, widgetsThread: Awaited<ReturnType<typeof threadOf>>

  it('runs a request naming gadgets in gadgets and an unnamed one in widgets, each in its own worktree', async () => {
    const named = await call('superagent_request', { text: '[R01] Add a gadget note [worker] [slow 25000]', project: 'gadgets' })
    expect(named).toMatchObject({ status: 'accepted', filed_in: 'gadgets', project: 'gadgets' })
    expect(named.result).toMatch(/^accepted T-[0-9a-f]{8} in gadgets \(from main\)/)
    const unnamed = await call('superagent_request', { text: '[R02] Tidy the widgets README [worker] [slow 25000]' })
    expect(unnamed).toMatchObject({ status: 'accepted', filed_in: 'widgets, the default for requests that name no project', project: 'widgets' })
    gadgetsTicket = named.ticket_id as string
    widgetsTicket = unnamed.ticket_id as string

    gadgetsThread = await threadOf(named.short as string)
    widgetsThread = await threadOf(unnamed.short as string)
    expect(gadgetsThread.projectId).toBe(gadgets.id)
    expect(widgetsThread.projectId).toBe(server.projectId)
    // D13: a non-legacy project's worktrees go under the state dir; the legacy project keeps `<root>/../<name>-superagent`.
    expect(gadgetsThread.worktreePath.startsWith(`${realpathSync(join(stateDir, 'worktrees', 'gadgets'))}${sep}`)).toBe(true)
    expect(widgetsThread.worktreePath.startsWith(`${realpathSync(join(server.dir, 'widgets-superagent'))}${sep}`)).toBe(true)
    // Each worktree belongs to its own repository.
    expect(git(gadgets.root, 'worktree', 'list')).toContain(gadgetsThread.worktreePath)
    expect(git(server.checkout, 'worktree', 'list')).toContain(widgetsThread.worktreePath)
    expect(git(server.checkout, 'worktree', 'list')).not.toContain(gadgetsThread.worktreePath)
    expect(git(gadgetsThread.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(gadgetsThread.branch)
    expect(gadgetsThread.branch).toMatch(/^agent\//)
    for (const id of [gadgetsTicket, widgetsTicket]) expect((await ticket(id)).project).toMatchObject({ key: id === gadgetsTicket ? 'gadgets' : 'widgets' })
    // The worker's assignment carries the branch delivery rule.
    const first = (await probe.call<{ items: { text: string }[] }>('t3_thread_read', { threadId: gadgetsThread.threadId, maxCharsPerItem: 100_000 })).items[0]!.text
    expect(first).toContain('Deliverable: commit your change on the ticket branch in this worktree.')
    // The gadgets worker "commits" while its turn runs.
    writeFileSync(join(gadgetsThread.worktreePath, 'NOTE.md'), 'a gadget note\n')
    git(gadgetsThread.worktreePath, 'add', 'NOTE.md')
    git(gadgetsThread.worktreePath, 'commit', '-q', '-m', 'Add a gadget note')
  }, TEST_MS)

  it('resumes both running tickets after a kill and a restart, and lists the gadgets branch to review', async () => {
    // Both workers have acknowledged (their first MCP call), so the kill lands while each one holds its turn open.
    for (const id of [gadgetsTicket, widgetsTicket]) {
      await eventually(async () => ((await ticket(id)).messages as { kind: string }[]).some(message => message.kind === 'acknowledgement'), `${id} to ack`)
    }
    const before = service!.child.pid
    await stopService('SIGKILL')
    // The lock of the killed process is still there; the new start must replace it.
    expect(readFileSync(join(stateDir, 'superagent.lock'), 'utf8')).toContain(String(before))
    service = await startService()
    expect(readFileSync(join(stateDir, 'superagent.lock'), 'utf8')).toContain(String(service.child.pid))
    // Both tickets are still open right after the restart, and they end once their workers report ready.
    const done = await Promise.all([ended(gadgetsTicket), ended(widgetsTicket)]).catch(async error => {
      for (const id of [gadgetsTicket, widgetsTicket]) say('ticket after restart', await ticket(id))
      for (const thread of [gadgetsThread, widgetsThread]) {
        say('thread', thread.threadId, (await probe.call<{ thread: unknown; items: unknown[] }>('t3_thread_read', { threadId: thread.threadId, limit: 50 })))
      }
      say('agent log', readFileSync(server.agentLog, 'utf8'))
      throw error
    })
    expect(done.map(view => view.outcome)).toEqual(['completed', 'completed'])
    const attention = await call('superagent_attention') as { to_review: Record<string, unknown>[]; tickets: unknown[] }
    expect(attention.to_review).toEqual([expect.objectContaining({ id: gadgetsTicket, project: 'gadgets', branch: gadgetsThread.branch, into: 'main',
      worktree: gadgetsThread.worktreePath })])
    // Only one thread each: the restart did not launch a second one.
    const listed = await probe.call<{ threads: { title: string; projectId: string }[] }>('t3_thread_list', { allProjects: true, limit: 100 })
    for (const id of [gadgetsTicket, widgetsTicket]) expect(listed.threads.filter(thread => thread.title.startsWith(`[T-${id.slice(0, 8)}]`))).toHaveLength(1)
  }, TEST_MS)

  it('refuses a second instance on the same state dir while one runs', async () => {
    const second = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', '--import', 'tsx', 'src/main.ts', 'start'],
      { cwd: REPO, env: { ...process.env, SUPERAGENT_STATE_DIR: stateDir, SUPERAGENT_PROJECT_ROOT: server.checkout, SUPERAGENT_ROUTER: 'rules',
        SUPERAGENT_PORT: String(await freePort()), T3_MCP_URL: server.url, T3_MCP_TOKEN: 'x' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    second.stderr!.on('data', chunk => { output += String(chunk) })
    const code = await new Promise<number | null>(resolve => second.once('exit', resolve))
    expect(code).toBe(1)
    expect(output).toContain(`Another superagent (pid ${service!.child.pid}) uses ${stateDir}`)
  }, TEST_MS)

  it('reroutes a ticket filed in the wrong project', async () => {
    const wrong = await call('superagent_request', { text: '[R03] Belongs in gadgets [worker] [slow 30000]' })
    expect(wrong).toMatchObject({ status: 'accepted', project: 'widgets' })
    const wrongThread = await threadOf(wrong.short as string)
    expect(wrongThread.projectId).toBe(server.projectId)
    const moved = await call('superagent_reroute', { ticket_id: wrong.ticket_id, project: 'gadgets' }) as Record<string, Record<string, unknown>>
    expect(moved.stopped).toMatchObject({ ticket_id: wrong.ticket_id, outcome: 'stopped', project: 'widgets' })
    expect(moved.filed).toMatchObject({ status: 'accepted', filed_in: 'gadgets', project: 'gadgets' })
    expect(moved.leftover).toMatchObject({ branch: wrongThread.branch, worktree: wrongThread.worktreePath })
    const newThread = await threadOf(moved.filed!.short as string)
    expect(newThread.projectId).toBe(gadgets.id)
    expect(newThread.worktreePath.startsWith(`${realpathSync(join(stateDir, 'worktrees', 'gadgets'))}${sep}`)).toBe(true)
    await eventually(async () => (await probe.call<{ thread: { status: string } }>('t3_thread_read', { threadId: wrongThread.threadId, limit: 1 }))
      .thread.status !== 'running', 'the stopped thread to stop')
    // A repeat returns the first filing; a reroute elsewhere is refused.
    expect(await call('superagent_reroute', { ticket_id: wrong.ticket_id, project: 'gadgets', wait_seconds: 0 })).toMatchObject({ repeated: true })
    const elsewhere = await raw('superagent_reroute', { ticket_id: wrong.ticket_id, project: 'widgets' })
    expect(elsewhere.isError).toBe(true)
    // An answer on the old ticket would file the work in widgets again: it is refused, and names the new ticket.
    const answer = await raw('superagent_answer', { ticket_id: wrong.ticket_id, text: 'Also the blue ones' })
    expect(answer.isError).toBe(true)
    expect(JSON.stringify(answer.content)).toContain(`was rerouted to gadgets, and its work goes on there in ticket ${moved.filed!.short}`)
    // A reroute to a denied project is refused and leaves the ticket running.
    const toVault = await raw('superagent_reroute', { ticket_id: moved.filed!.ticket_id, project: 'vault' })
    expect(toVault.isError).toBe(true)
    expect((await ticket(moved.filed!.ticket_id as string)).outcome).toBeUndefined()
    await call('superagent_stop', { ticket_id: moved.filed!.ticket_id })
  }, TEST_MS)

  it('refuses requests naming a denied or unknown project with the reason, and stores nothing', async () => {
    const count = triggerCount()
    const denied = await raw('superagent_request', { text: '[R04] Look in the vault', project: 'vault' })
    const unknown = await raw('superagent_request', { text: '[R05] Somewhere else', project: 'gizmos' })
    const near = await raw('superagent_request', { text: '[R06] Near miss', project: 'gadget' })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toMatch(/vault is denied/)
    expect(unknown.isError).toBe(true)
    expect(JSON.stringify(unknown.content)).toContain('No project gizmos in T3 Code')
    expect(near.isError).toBe(true)
    expect(JSON.stringify(near.content)).toContain('did you mean gadgets')
    expect(triggerCount()).toBe(count)
    // By path and by T3 Code id the same project resolves.
    expect(await call('superagent_projects', { query: gadgets.root })).toMatchObject({ projects: [expect.objectContaining({ key: 'gadgets' })] })
    expect(existsSync(join(stateDir, 'worktrees', 'vault'))).toBe(false)
  }, TEST_MS)

  it('offers the New project form as an MCP App in the console tool list, next to the attention queue', async () => {
    const { tools } = await service!.console.listTools()
    const form = tools.find(tool => tool.name === 'superagent_new_project_form')
    expect(form?._meta).toEqual({ ui: { resourceUri: NEW_PROJECT_URI }, 'ui/resourceUri': NEW_PROJECT_URI })
    expect(tools.find(tool => tool.name === 'superagent_attention')?._meta).toEqual({ ui: { resourceUri: ATTENTION_URI }, 'ui/resourceUri': ATTENTION_URI })
    const page = await service!.console.readResource({ uri: NEW_PROJECT_URI })
    expect(page.contents).toEqual([{ uri: NEW_PROJECT_URI, mimeType: MCP_APP_MIME, text: newProjectPage('app') }])
    // With the temp catalogue, which files nothing under a folder yet, new projects are on and only the top level is offered.
    expect(await call('superagent_new_project_form')).toMatchObject({ enabled: true, workspace: realpathSync(server.dir), groups: [], top_level: true })
  }, TEST_MS)

  it('starts a new project in the catalogue and runs its first request in the new project\'s own worktree', async () => {
    const args = { folder: 'PERSONAL/garden', purpose: 'Plan the vegetable garden by season.', request: '[R07] Write the spring plan [worker]', wait_seconds: 20 }
    const made = await call('superagent_new_project', args) as Record<string, unknown> & { request: Record<string, unknown> }
    const root = join(server.dir, 'PERSONAL', 'garden')
    expect(made).toMatchObject({ key: 'PERSONAL/garden', status: 'ready', root, branch: 'main', catalogue: 'added', index: 'added',
      scope: 'updated: 1 mapped entries: 1 Git repositories, 0 linked worktrees and 0 additional project or reference folders.',
      request: { status: 'accepted', filed_in: 'PERSONAL/garden', project: 'PERSONAL/garden' } })
    // The repository: main, one commit with the README and the map, by the identity in git's config.
    expect(git(root, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
    expect(git(root, 'rev-list', '--count', 'HEAD')).toBe('1')
    expect(git(root, 'ls-files').split('\n')).toEqual(['README.md', 'REPO_MAP.md'])
    expect(execFileSync('git', ['log', '-1', '--format=%an <%ae>'], { cwd: root, encoding: 'utf8' }).trim()).toBe('Live Test <live@example.test>')
    // T3 Code itself lists the project the CLI added, under the id the tool returned.
    const registered = await probe.listProjects()
    expect(registered.filter(project => project.workspaceRoot === root)).toEqual([{ id: made.project_id, workspaceRoot: root, title: 'garden' }])
    // The catalogue entries.
    const catalogue = JSON.parse(readFileSync(join(server.dir, 'repositories.json'), 'utf8')) as { repositories: Record<string, unknown>[] }
    expect(catalogue.repositories).toEqual([expect.objectContaining({ path: 'PERSONAL/garden', kind: 'git-repository', head: made.head, branch: 'main',
      map: 'PERSONAL/garden/REPO_MAP.md' })])
    expect(readFileSync(join(server.dir, 'REPOSITORIES.md'), 'utf8')).toContain('| [PERSONAL/garden](PERSONAL/garden/REPO_MAP.md) | git-repository |')
    // The first request's worker runs in a worktree of the new repository, under the state dir, and finishes.
    const thread = await threadOf(made.request.short as string)
    expect(thread.projectId).toBe(made.project_id)
    expect(thread.worktreePath.startsWith(`${realpathSync(join(stateDir, 'worktrees', 'personal-garden'))}${sep}`)).toBe(true)
    expect(git(root, 'worktree', 'list')).toContain(thread.worktreePath)
    expect(git(server.checkout, 'worktree', 'list')).not.toContain(thread.worktreePath)
    expect((await ended(made.request.ticket_id as string)).outcome).toBe('completed')
    // A repeated call finds everything done and adds nothing.
    const again = await call('superagent_new_project', { ...args, wait_seconds: 0 }) as Record<string, unknown> & { request: Record<string, unknown> }
    expect(again).toMatchObject({ repeated: true, catalogue: 'already there', index: 'already there', request: { repeated: true, trigger_id: made.request.trigger_id } })
    expect((await probe.listProjects()).filter(project => project.workspaceRoot === root)).toHaveLength(1)
    // A title that starts with a dash is the title, not an option of the CLI: it goes in one argument with --title.
    const notes = join(server.dir, 'PERSONAL', 'notes')
    const dashed = await call('superagent_new_project', { folder: 'PERSONAL/notes', purpose: 'Notes on the garden.', title: '--help' }) as Record<string, unknown>
    expect(dashed).toMatchObject({ key: 'PERSONAL/notes', status: 'ready', title: '--help', root: notes })
    expect((await probe.listProjects()).filter(project => project.workspaceRoot === notes)).toEqual([{ id: dashed.project_id, workspaceRoot: notes, title: '--help' }])
    // ARCHIVE/ stays denied: refused, and nothing is made.
    const archived = await raw('superagent_new_project', { folder: 'ARCHIVE/old-idea', purpose: 'An old idea.' })
    expect(archived.isError).toBe(true)
    expect(JSON.stringify(archived.content)).toContain('It is denied by default (ARCHIVE/).')
    expect(existsSync(join(server.dir, 'ARCHIVE'))).toBe(false)
  }, TEST_MS)

  it('adds a catalogued checkout that exists already, and runs a request there in its own worktree', async () => {
    // An existing repository with a commit and an uncommitted file, catalogued but not in T3 Code.
    const root = join(server.dir, 'NDC', 'oldshop')
    mkdirSync(join(server.dir, 'NDC'), { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main', root])
    writeFileSync(join(root, 'README.md'), '# oldshop\n')
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'init')
    writeFileSync(join(root, 'WIP.md'), 'not committed\n')
    const file = join(server.dir, 'repositories.json')
    const catalogue = JSON.parse(readFileSync(file, 'utf8')) as { repositories: { path: string }[] }
    catalogue.repositories.unshift({ path: 'NDC/oldshop', purpose: 'The old shop.', kind: 'git-repository' } as { path: string })
    writeFileSync(file, `${JSON.stringify(catalogue, null, 2)}\n`)
    const head = git(root, 'rev-parse', 'HEAD')
    const status = git(root, 'status', '--porcelain')

    const listed = await call('superagent_projects', { refresh: true, status: 'not-registered' }) as { projects: Record<string, unknown>[]; to_add: string }
    expect(listed.projects).toEqual([expect.objectContaining({ key: 'NDC/oldshop', status: 'not-registered',
      why: expect.stringContaining('call superagent_add_project with project NDC/oldshop') })])
    expect(listed.to_add).toContain('superagent_add_project')
    const refused = await raw('superagent_request', { text: '[R08] Fix the old shop', project: 'NDC/oldshop' })
    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused.content)).toContain('call superagent_add_project with project NDC/oldshop')
    expect((await probe.listProjects()).filter(project => project.workspaceRoot === root)).toEqual([])

    const added = await call('superagent_add_project', { projects: [{ project: 'NDC/oldshop' }], request: '[R09] Fix the old shop [worker]', wait_seconds: 20 }) as
      { summary: string; projects: Record<string, unknown>[]; request: Record<string, unknown> }
    expect(added.summary).toBe('1 added')
    expect(added.projects).toEqual([expect.objectContaining({ outcome: 'added', key: 'NDC/oldshop', status: 'ready', title: 'NDC/oldshop', root,
      warnings: [expect.stringContaining('has 1 uncommitted change')], manual_step: expect.stringContaining('the project "NDC/oldshop"') })])
    // T3 Code itself lists it, at the real path, under the id the tool returned and with the catalogue path as its title.
    expect((await probe.listProjects()).filter(project => project.workspaceRoot === root))
      .toEqual([{ id: added.projects[0]!.project_id, workspaceRoot: root, title: 'NDC/oldshop' }])
    // The repository is as it was: same commit, same uncommitted file.
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head)
    expect(git(root, 'status', '--porcelain')).toBe(status)
    // The first request runs in a worktree of this repository, under the state dir, and finishes.
    expect(added.request).toMatchObject({ status: 'accepted', filed_in: 'NDC/oldshop', project: 'NDC/oldshop' })
    const thread = await threadOf(added.request.short as string)
    expect(thread.projectId).toBe(added.projects[0]!.project_id)
    expect(thread.worktreePath.startsWith(`${realpathSync(join(stateDir, 'worktrees', 'ndc-oldshop'))}${sep}`)).toBe(true)
    expect(git(root, 'worktree', 'list')).toContain(thread.worktreePath)
    expect(git(server.checkout, 'worktree', 'list')).not.toContain(thread.worktreePath)
    expect((await ended(added.request.ticket_id as string)).outcome).toBe('completed')
    // A repeat finds it registered, runs nothing, and files the request once.
    const again = await call('superagent_add_project', { projects: [{ project: 'NDC/oldshop' }], request: '[R09] Fix the old shop [worker]', wait_seconds: 0 }) as
      { summary: string; request: Record<string, unknown> }
    expect(again).toMatchObject({ summary: '1 registered already', request: { repeated: true, trigger_id: added.request.trigger_id } })
    expect((await probe.listProjects()).filter(project => project.workspaceRoot === root)).toHaveLength(1)
  }, TEST_MS)
})
