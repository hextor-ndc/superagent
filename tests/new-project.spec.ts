/**
 * `superagent_new_project` (src/app/new-project.ts) in memory: a temp workspace with a catalogue and a REPOSITORIES.md in the
 * shape of the operator's, a FakeT3 whose `addProject` stands in for the t3 CLI, and git with a config file of the test's own.
 * The happy path, every refusal (nothing written), a repeated call after a failure at each step, another writer's edits to
 * the shared files, the files' formatting, and a first request that runs in the new project's own repository.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { addEntry, STEPS, t3Cli, updateFile, type Step, type T3Cli } from '../src/app/new-project.ts'
import { checkout, data, mcp, until } from './harness.ts'
import { setup, workerLaunches, worktreesOf, type Setup } from './two-projects.ts'

/** Whether the temp folder's file system ignores case, as macOS's does by default. */
const CASE_INSENSITIVE = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'superagent-case-'))
  mkdirSync(join(dir, 'Upper'))
  const insensitive = existsSync(join(dir, 'upper'))
  rmSync(dir, { recursive: true, force: true })
  return insensitive
})()
const TODAY = (() => { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}` })()
/** Git's environment for the tool: a global config of the test's own (with or without an identity) and no system config. */
const scratch = mkdtempSync(join(tmpdir(), 'superagent-new-project-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
function gitEnv(identity = true): NodeJS.ProcessEnv {
  const config = join(scratch, identity ? 'with-identity' : 'without-identity')
  writeFileSync(config, identity ? '[user]\n\tname = Test Operator\n\temail = operator@example.test\n' : '')
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' }
  for (const name of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) delete env[name]
  return env
}

/** A catalogue entry of a git repository as the operator's catalogue has them. */
const gitEntry = (path: string, purpose: string) => ({ path, purpose, flow: 'Things happen.', modules: [{ path: 'README.md', responsibility: 'Overview' }],
  notes: 'Notes.', related: [], kind: 'git-repository', checked_on: '2026-10-04', head: 'abc', branch: 'main', had_local_changes: true,
  map: `${path}/REPO_MAP.md`, manifests: [], existing_docs: [], readme_created: false, source_evidence: { file: 'repository-evidence.json', key: path, sampled_files: 1 },
  git_checked_on: '2026-10-31' })
const folderEntry = (path: string, purpose: string) => ({ path, purpose, flow: 'Notes.', modules: [], notes: '', related: [], kind: 'project-folder',
  checked_on: '2026-10-04', head: null, branch: null, had_local_changes: null, map: `${path}/REPO_MAP.md`, manifests: [], existing_docs: [], readme_created: true })

function catalogueText(dir: string, entries: Record<string, unknown>[], scope?: string): string {
  const git = entries.filter(entry => entry.kind === 'git-repository').length
  return `${JSON.stringify({ schema_version: 1, checked_on: '2026-10-31', workspace: dir,
    scope: scope ?? `${entries.length} mapped entries: ${git} Git repositories, 0 linked worktrees and ${entries.length - git} additional project or reference folders.`,
    verification: 'Checked by hand.', repositories: entries }, null, 2)}\n`
}
const INDEX = [
  '# Coding repository index', '', 'Scanned **2026-10-31**. **3 mapped entries**.', '',
  '## Repository and project catalog', '',
  '### PERSONAL', '', '| Project guide | Kind | Function | Main modules / where to look |', '|---|---|---|---|',
  '| [PERSONAL/automix](PERSONAL/automix/REPO_MAP.md) | git-repository | DJ mixes. | `src`: Code |',
  '| [PERSONAL/votes](PERSONAL/votes/REPO_MAP.md) | project-folder | Votes. | `verify.py`: Checks |', '',
  '### NDC', '', '| Project guide | Kind | Function | Main modules / where to look |', '|---|---|---|---|',
  '| [NDC/winedb](NDC/winedb/REPO_MAP.md) | git-repository | Wines. | `src`: Code |',
  '| [NDC/bardash](NDC/bardash/REPO_MAP.md) | git-repository | Bars. | `app`: Code |', '',
  '### Top level', '', '| Project guide | Kind | Function | Main modules / where to look |', '|---|---|---|---|',
  '| [widgets](widgets/REPO_MAP.md) | git-repository | Widget shop. | `README.md`: Overview |', '',
  '## Maintain this index', '', 'Keep it current.', '',
].join('\n')

interface Env extends Setup {
  catalogue: string; index: string; client: Client
  /** Roots the stand-in CLI was asked to add, in order. */
  added: string[]
  call(args: Record<string, unknown>): Promise<{ isError?: boolean; text: string; data: Record<string, unknown> }>
}
let open: Env | undefined
afterEach(async () => { await open?.client.close(); await open?.made.close(); open = undefined })

/**
 * widgets and gadgets as in tests/two-projects.ts, in a workspace with a catalogue of widgets, PERSONAL/automix and
 * PERSONAL/votes, and the REPOSITORIES.md above. `cli` replaces the stand-in, `during` runs inside the stand-in's add.
 */
async function start(options: { identity?: boolean; cli?: T3Cli; during?: (env: Env) => void; beforeStep?: (step: Step) => void
  catalogue?: string | false; projects?: Record<string, unknown> } = {}): Promise<Env> {
  const { dir } = checkout('widgets')
  checkout('gadgets', dir)
  mkdirSync(join(dir, 'PERSONAL'))
  mkdirSync(join(dir, 'ARCHIVE'))
  mkdirSync(join(dir, 'NDC'))
  const catalogue = join(dir, 'repositories.json')
  const index = join(dir, 'REPOSITORIES.md')
  writeFileSync(catalogue, typeof options.catalogue === 'string' ? options.catalogue : catalogueText(dir, [
    folderEntry('PERSONAL/automix', 'DJ mixes.'), folderEntry('PERSONAL/votes', 'Votes.'), gitEntry('widgets', 'Widget shop.')]))
  writeFileSync(index, INDEX)
  const added: string[] = []
  let env!: Env
  const cli: T3Cli = options.cli ?? {
    problem: () => undefined,
    async addProject(root, title) {
      added.push(root)
      options.during?.(env)
      const id = `p-new-${added.length}`
      env.t3.addProject({ id, workspaceRoot: root, title })
      return `Added project ${id} (${title}) at ${root}.`
    },
  }
  const made = await setup({ dir, ...options.catalogue === false ? {} : { catalogue }, ...options.projects ? { projects: options.projects } : {},
    newProject: { cli, env: gitEnv(options.identity ?? true), listWaitMs: 200, ...options.beforeStep ? { beforeStep: options.beforeStep } : {} } })
  const client = await mcp(`${made.made.base}/mcp/console/console-secret`)
  env = Object.assign(made, { catalogue, index, client, added, call: async (args: Record<string, unknown>) => {
    const result = await client.callTool({ name: 'superagent_new_project', arguments: args })
    const text = (result.content as { type: string; text?: string }[]).map(item => item.text ?? '').join('\n')
    return { ...result.isError ? { isError: true } : {}, text, data: data(result) ?? {} }
  } }) as Env
  open = env
  return env
}

/** Every file and folder under the workspace but the state dir, with each file's content. */
function snapshot(env: Env): Record<string, string> {
  const files: Record<string, string> = {}
  const walk = (dir: string) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, item.name)
      const key = relative(env.dir, path)
      if (key === 'state' || key.endsWith('.git')) { files[key] = 'dir'; continue }
      if (item.isDirectory()) { files[key] = 'dir'; walk(path) } else files[key] = item.isSymbolicLink() ? 'link' : readFileSync(path, 'utf8')
    }
  }
  walk(env.dir)
  return files
}
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv() }).trim()
const entriesOf = (env: Env) => (JSON.parse(readFileSync(env.catalogue, 'utf8')) as { repositories: { path: string }[] }).repositories

describe('superagent_new_project', () => {
  it('makes the folder, a git repository, the T3 Code project and both catalogue entries, then runs a first request there', async () => {
    const env = await start()
    const beforeCatalogue = readFileSync(env.catalogue, 'utf8')
    const { data: made, isError, text } = await env.call({ folder: 'PERSONAL/garden', purpose: 'Plan the vegetable garden by season.',
      notes: 'Beds are numbered from the gate.', related: ['widgets'], request: 'Write a planting plan for spring', wait_seconds: 10 })
    expect(isError, text).toBeUndefined()
    const root = join(realpathSync(env.dir), 'PERSONAL', 'garden')
    expect(made).toMatchObject({ key: 'PERSONAL/garden', status: 'ready', project_id: 'p-new-1', title: 'garden', root, branch: 'main',
      catalogue: 'added', index: 'added', scope: 'updated: 4 mapped entries: 2 Git repositories, 0 linked worktrees and 2 additional project or reference folders.',
      manual_step: expect.stringContaining('turn off PR watching and "continue threads after server update"') })
    expect(made.repeated).toBeUndefined()

    // The repository: main, one commit with the two files, by the operator's own git identity.
    expect(git(root, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
    expect(git(root, 'rev-list', '--count', 'HEAD')).toBe('1')
    expect(git(root, 'rev-parse', 'HEAD')).toBe(made.head)
    expect(git(root, 'log', '-1', '--format=%an <%ae>')).toBe('Test Operator <operator@example.test>')
    expect(git(root, 'ls-files').split('\n')).toEqual(['README.md', 'REPO_MAP.md'])
    expect(git(root, 'status', '--porcelain')).toBe('')
    const map = readFileSync(join(root, 'REPO_MAP.md'), 'utf8')
    expect(map).toMatch(/^# garden — repository guide and code map\n\nPlan the vegetable garden by season\.\n/)
    expect(map).toContain('Workspace path: `PERSONAL/garden`.')
    expect(map).toContain('[Workspace repository index](../../REPOSITORIES.md)')
    expect(map).toContain('- `widgets`')
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toContain('Start with [REPO_MAP.md](REPO_MAP.md)')

    // T3 Code: added once, at the real path, with the folder's name as its title.
    expect(env.added).toEqual([root])
    expect(env.t3.projects.filter(project => project.workspaceRoot === root)).toEqual([{ id: 'p-new-1', workspaceRoot: root, title: 'garden' }])

    // repositories.json: one entry, in path order, with the fields of the other git-repository entries; nothing else changed
    // but the scope line, and the formatting is the file's own.
    const after = readFileSync(env.catalogue, 'utf8')
    const parsed = JSON.parse(after) as { scope: string; repositories: Record<string, unknown>[] }
    expect(parsed.repositories.map(item => item.path)).toEqual(['PERSONAL/automix', 'PERSONAL/garden', 'PERSONAL/votes', 'widgets'])
    expect(parsed.repositories[1]).toEqual({ path: 'PERSONAL/garden', purpose: 'Plan the vegetable garden by season.', flow: 'New project: nothing is built yet.',
      modules: [], notes: 'Beds are numbered from the gate.', related: ['widgets'], kind: 'git-repository', checked_on: TODAY, head: made.head, branch: 'main',
      had_local_changes: false, map: 'PERSONAL/garden/REPO_MAP.md', manifests: [], existing_docs: [], readme_created: true, git_checked_on: TODAY })
    expect(Object.keys(parsed.repositories[1]!)).toEqual(Object.keys(gitEntry('x', 'y')).filter(key => key !== 'source_evidence'))
    expect(after).toBe(`${JSON.stringify(parsed, null, 2)}\n`)
    const without = { ...parsed, repositories: parsed.repositories.filter(item => item.path !== 'PERSONAL/garden'),
      scope: '3 mapped entries: 1 Git repositories, 0 linked worktrees and 2 additional project or reference folders.' }
    expect(`${JSON.stringify(without, null, 2)}\n`).toBe(beforeCatalogue)

    // REPOSITORIES.md: one row, in the PERSONAL table in path order; every other line as it was.
    const index = readFileSync(env.index, 'utf8').split('\n')
    const row = '| [PERSONAL/garden](PERSONAL/garden/REPO_MAP.md) | git-repository | Plan the vegetable garden by season. | `README.md`: what the project is for; no modules yet |'
    expect(index.indexOf(row)).toBe(INDEX.split('\n').indexOf('| [PERSONAL/votes](PERSONAL/votes/REPO_MAP.md) | project-folder | Votes. | `verify.py`: Checks |'))
    expect(index.filter(line => line !== row)).toEqual(INDEX.split('\n'))

    // The copies made first hold the files as they were.
    const backups = made.backups as string[]
    expect(backups.map(path => relative(join(env.dir, 'state', 'catalogue-backups'), path))).toEqual([
      expect.stringMatching(/^repositories\.json\.\d{4}-\d\d-\d\dT[\d-]+Z$/), expect.stringMatching(/^REPOSITORIES\.md\.\d{4}-\d\d-\d\dT[\d-]+Z$/)])
    expect(readFileSync(backups[0]!, 'utf8')).toBe(beforeCatalogue)
    expect(readFileSync(backups[1]!, 'utf8')).toBe(INDEX)
    // No temporary files are left beside the shared files.
    expect(readdirSync(env.dir).filter(name => name.endsWith('.tmp'))).toEqual([])

    // The first request: accepted in the new project, with a worktree of its own repository.
    expect(made.request).toMatchObject({ status: 'accepted', filed_in: 'PERSONAL/garden', project: 'PERSONAL/garden',
      trigger_id: `console:new-project:${made.job as string}` })
    const launch = await until(() => workerLaunches(env.t3)[0], 'the worker launch')
    const args = launch.args as { projectId: string; worktreePath: string }
    expect(args.projectId).toBe('p-new-1')
    expect(worktreesOf(root)).toContain(realpathSync(args.worktreePath))
    expect(realpathSync(args.worktreePath).startsWith(realpathSync(join(env.dir, 'state', 'worktrees', 'personal-garden')))).toBe(true)
    expect(worktreesOf(env.widgets)).not.toContain(realpathSync(args.worktreePath))

    // The project lists like any other, and takes requests by its key.
    const listed = data(await env.client.callTool({ name: 'superagent_projects', arguments: { query: 'PERSONAL/garden' } }))
    expect(listed).toMatchObject({ projects: [expect.objectContaining({ key: 'PERSONAL/garden', status: 'ready', purpose: 'Plan the vegetable garden by season.' })] })
  })

  it('takes an existing empty folder, and a folder at the top of the workspace, and leaves a scope line it cannot count', async () => {
    const env = await start({ catalogue: undefined })
    // A scope line whose counts are not the list's own is left as it is.
    const text = readFileSync(env.catalogue, 'utf8').replace(/"scope": "[^"]*"/, '"scope": "Some folders."')
    writeFileSync(env.catalogue, text)
    mkdirSync(join(env.dir, 'NDC', 'empty'))
    const empty = await env.call({ folder: 'NDC/empty', purpose: 'An empty start.', title: 'Empty start' })
    expect(empty.isError, empty.text).toBeUndefined()
    expect(empty.data).toMatchObject({ key: 'NDC/empty', status: 'ready', title: 'Empty start',
      scope: expect.stringMatching(/^left as it is/) })
    expect(env.t3.projects.at(-1)).toMatchObject({ title: 'Empty start' })
    // NDC's table is not sorted, so the row goes at its end.
    const index = readFileSync(env.index, 'utf8').split('\n')
    expect(index[index.indexOf('| [NDC/bardash](NDC/bardash/REPO_MAP.md) | git-repository | Bars. | `app`: Code |') + 1]).toMatch(/^\| \[NDC\/empty\]/)
    expect(JSON.parse(readFileSync(env.catalogue, 'utf8')).scope).toBe('Some folders.')

    const top = await env.call({ folder: 'toolbox', purpose: 'Small scripts.' })
    expect(top.isError, top.text).toBeUndefined()
    const after = readFileSync(env.index, 'utf8').split('\n')
    expect(after[after.indexOf('| [widgets](widgets/REPO_MAP.md) | git-repository | Widget shop. | `README.md`: Overview |') - 1]).toMatch(/^\| \[toolbox\]\(toolbox\/REPO_MAP\.md\)/)
  })

  it('refuses, writing nothing, outside the workspace, when denied, catalogued, registered, not empty, nested, unnamed or without git identity', async () => {
    const env = await start({ projects: { 'FAMILY/': { access: 'deny' } } })
    const outside = mkdtempSync(join(scratch, 'outside-'))
    symlinkSync(outside, join(env.dir, 'escape'))
    mkdirSync(join(env.dir, 'NDC', 'full'))
    writeFileSync(join(env.dir, 'NDC', 'full', 'notes.txt'), 'kept\n')
    mkdirSync(join(env.dir, 'NDC', 'registered'))
    env.t3.addProject({ id: 'p-registered', workspaceRoot: join(env.dir, 'NDC', 'registered'), title: 'Registered' })
    symlinkSync(join(env.dir, 'NDC', 'registered'), join(env.dir, 'NDC', 'linked'))
    writeFileSync(join(env.dir, 'NDC', 'file'), 'a file\n')
    // A symlink to nothing, and a symlinked folder inside the workspace that leads to another one.
    symlinkSync(join(outside, 'missing'), join(env.dir, 'PERSONAL', 'dangling'))
    symlinkSync(join(env.dir, 'NDC'), join(env.dir, 'PERSONAL', 'alias'))
    const before = snapshot(env)
    const projects = env.t3.projects.length
    const refused: [Record<string, unknown>, RegExp][] = [
      [{ folder: '../outside' }, /contains "\." or "\.\."/],
      [{ folder: 'PERSONAL/../../outside' }, /contains "\." or "\.\."/],
      [{ folder: '/tmp/elsewhere' }, /is not relative/],
      [{ folder: '~/elsewhere' }, /is not relative/],
      [{ folder: 'escape/new' }, /resolves to .*outside-.*, outside the workspace/],
      [{ folder: 'ARCHIVE/old-idea' }, /ARCHIVE\/old-idea cannot be a project for work\. It is denied by default \(ARCHIVE\/\)\./],
      [{ folder: 'FAMILY/trip' }, /It is denied by projects\.json \(FAMILY\/\)\./],
      [{ folder: 'state/worktrees/new' }, /where the super agent keeps ticket worktrees/],
      [{ folder: 'NDC/thing-superagent' }, /where the super agent keeps ticket worktrees/],
      [{ folder: 'PERSONAL/automix' }, /PERSONAL\/automix is in the catalogue already/],
      [{ folder: 'widgets' }, /widgets is in the catalogue already/],
      [{ folder: 'NDC/registered' }, /is a T3 Code project already \(Registered\)/],
      [{ folder: 'NDC/linked' }, /is a symlink/],
      [{ folder: 'PERSONAL/dangling' }, /PERSONAL\/dangling is a symlink/],
      [{ folder: 'PERSONAL/dangling/sub' }, /PERSONAL\/dangling is a symlink to .*missing, which does not exist/],
      [{ folder: 'PERSONAL/alias/new' }, /PERSONAL\/alias\/new is NDC\/new through a symlink: call again with the folder NDC\/new/],
      [{ folder: 'PERSONAL/Automix' }, /PERSONAL\/Automix is in the catalogue already, as PERSONAL\/automix/],
      [{ folder: 'NDC/full' }, /exists and is not empty/],
      [{ folder: 'NDC/file' }, /exists and is not a folder/],
      [{ folder: 'NDC/file/sub' }, /is a file/],
      [{ folder: 'gadgets/sub' }, /would be inside the git checkout .*gadgets/],
      [{ folder: 'PERSONAL/.hidden' }, /"\.hidden" cannot be a folder name/],
      [{ folder: 'PERSONAL/-dash' }, /"-dash" cannot be a folder name/],
      [{ folder: 'PERSONAL/a:b' }, /"a:b" cannot be a folder name/],
      [{ folder: 'PERSONAL/name.lock' }, /"name\.lock" cannot be a folder name/],
      [{ folder: 'PERSONAL/ends.' }, /"ends\." cannot be a folder name/],
      [{ folder: '.' }, /Name the new folder/],
      [{ folder: 'PERSONAL/garden', purpose: 'Two\nlines.' }, /The purpose must be one line/],
      [{ folder: 'PERSONAL/garden', related: ['nowhere'] }, /related names folders the catalogue does not list: nowhere/],
    ]
    for (const [args, expected] of refused) {
      const result = await env.call({ purpose: 'Something new.', ...args })
      expect(result.isError, JSON.stringify(args)).toBe(true)
      expect(result.text, JSON.stringify(args)).toMatch(expected)
    }
    expect(snapshot(env)).toEqual(before)
    expect(env.t3.projects).toHaveLength(projects)
    expect(env.added).toEqual([])
    expect(existsSync(join(env.dir, 'state', 'new-projects'))).toBe(false)
    expect(existsSync(join(env.dir, 'state', 'catalogue-backups'))).toBe(false)
    expect(readdirSync(outside)).toEqual([])
  })

  it('refuses without a catalogue, git identity, a usable catalogue or the t3 CLI, writing nothing', async () => {
    for (const [options, expected] of [
      [{ catalogue: false }, /No catalogue is configured: set SUPERAGENT_CATALOGUE/],
      [{ identity: false }, /git has no user\.name and user\.email to make the first commit of PERSONAL\/garden with/],
      [{ cli: { problem: () => 'The T3 Code CLI t3 cannot be run here: set T3_BIN.', addProject: () => Promise.reject(new Error('never')) } }, /set T3_BIN/],
    ] as const) {
      const env = await start(options)
      const before = snapshot(env)
      const result = await env.call({ folder: 'PERSONAL/garden', purpose: 'Plan the garden.' })
      expect(result.isError).toBe(true)
      expect(result.text).toMatch(expected)
      expect(snapshot(env)).toEqual(before)
      expect(existsSync(join(env.dir, 'state', 'new-projects'))).toBe(false)
      await env.client.close(); await env.made.close(); open = undefined
    }
    // A catalogue whose text JSON.stringify would not give back: writing it would change more than one entry.
    const compact = JSON.stringify({ workspace: scratch, repositories: [] })
    const env = await start({ catalogue: compact })
    const result = await env.call({ folder: 'PERSONAL/garden', purpose: 'Plan the garden.' })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('is not changed by superagent_new_project, so nothing was made: its text is not what JSON.stringify writes')
    expect(readFileSync(env.catalogue, 'utf8')).toBe(compact)
    expect(existsSync(join(env.dir, 'PERSONAL', 'garden'))).toBe(false)
  })

  it('finishes the job when called again with the same arguments after a failure at any step, adding nothing twice', async () => {
    let failAt: Step | undefined
    const env = await start({ beforeStep: step => { if (step === failAt) { failAt = undefined; throw new Error(`stopped before ${step}`) } } })
    for (const [index, step] of STEPS.entries()) {
      const args = { folder: `NDC/step-${step}`, purpose: `Stopped before ${step}.`, request: `First work in ${step}`, wait_seconds: 5 }
      failAt = step
      const failed = await env.call(args)
      expect(failed.isError, step).toBe(true)
      expect(failed.text).toContain(`stopped before ${step}`)
      // Other arguments are refused while the job is unfinished.
      const other = await env.call({ ...args, purpose: 'Something else.' })
      expect(other.isError, step).toBe(true)
      expect(other.text).toContain(`A new project at NDC/step-${step} was started on`)
      const done = await env.call(args)
      expect(done.isError, `${step}: ${done.text}`).toBeUndefined()
      expect(done.data).toMatchObject({ key: `NDC/step-${step}`, status: 'ready', repeated: true, request: { status: 'accepted', project: `NDC/step-${step}` } })
      // And once more: nothing changes.
      const again = await env.call(args)
      expect(again.data).toMatchObject({ key: `NDC/step-${step}`, repeated: true, catalogue: 'already there', index: 'already there',
        request: { repeated: true, trigger_id: (done.data.request as { trigger_id: string }).trigger_id } })
      const root = done.data.root as string
      expect(git(root, 'rev-list', '--count', 'HEAD'), step).toBe('1')
      expect(env.t3.projects.filter(project => project.workspaceRoot === root), step).toHaveLength(1)
      expect(env.added.filter(path => path === root), step).toHaveLength(1)
      expect(entriesOf(env).filter(item => item.path === `NDC/step-${step}`), step).toHaveLength(1)
      expect(readFileSync(env.index, 'utf8').split('\n').filter(line => line.startsWith(`| [NDC/step-${step}](`)), step).toHaveLength(1)
      const tickets = env.made.runtime.repo.tickets.list().filter(ticket => ticket.title.includes(`First work in ${step}`))
      expect(tickets, step).toHaveLength(1)
      expect(entriesOf(env)).toHaveLength(4 + index)
    }
  }, 60_000)

  it.runIf(CASE_INSENSITIVE)('catalogues the folder as the disk names it when it is given in another case', async () => {
    const env = await start()
    const made = await env.call({ folder: 'personal/garden', purpose: 'Plan the garden.' })
    expect(made.isError, made.text).toBeUndefined()
    expect(made.data).toMatchObject({ key: 'PERSONAL/garden', status: 'ready', root: join(realpathSync(env.dir), 'PERSONAL', 'garden'),
      catalogue: 'added', index: 'added' })
    expect(entriesOf(env).map(item => item.path)).toEqual(['PERSONAL/automix', 'PERSONAL/garden', 'PERSONAL/votes', 'widgets'])
    expect(entriesOf(env)[1]).toMatchObject({ map: 'PERSONAL/garden/REPO_MAP.md' })
    expect(readFileSync(env.index, 'utf8')).toContain('| [PERSONAL/garden](PERSONAL/garden/REPO_MAP.md) |')
    expect(readFileSync(join(made.data.root as string, 'REPO_MAP.md'), 'utf8')).toContain('Workspace path: `PERSONAL/garden`.')
    // A catalogued folder that is not on disk, given in another case, is the catalogued one.
    const before = snapshot(env)
    const again = await env.call({ folder: 'personal/automix', purpose: 'DJ mixes again.' })
    expect(again.isError).toBe(true)
    expect(again.text).toMatch(/PERSONAL\/automix is in the catalogue already, as PERSONAL\/automix/)
    expect(snapshot(env)).toEqual(before)
  })

  it('files the first request of a project started again at the same folder with another request', async () => {
    const env = await start()
    const first = await env.call({ folder: 'PERSONAL/garden', purpose: 'Plan the garden.', request: 'Write plan A', wait_seconds: 10 })
    expect(first.isError, first.text).toBeUndefined()
    expect(first.data.request).toMatchObject({ status: 'accepted' })
    // The operator removes the project everywhere, then starts it again with another first request.
    rmSync(first.data.root as string, { recursive: true, force: true })
    env.t3.removeProject(first.data.project_id as string)
    writeFileSync(env.catalogue, readFileSync((first.data.backups as string[])[0]!, 'utf8'))
    writeFileSync(env.index, INDEX)
    await env.made.runtime.projects.refresh()
    const second = await env.call({ folder: 'PERSONAL/garden', purpose: 'Plan the garden.', request: 'Write plan B', wait_seconds: 10 })
    expect(second.isError, second.text).toBeUndefined()
    expect(second.data.repeated).toBeUndefined()
    const request = second.data.request as { trigger_id: string; status: string; repeated?: true; ticket_id: string }
    expect(request.repeated).toBeUndefined()
    expect(request.trigger_id).not.toBe((first.data.request as { trigger_id: string }).trigger_id)
    expect(request.status).toBe('accepted')
    expect(env.made.runtime.repo.triggers.get(request.trigger_id)?.text).toBe('Write plan B')
    expect(env.made.runtime.repo.tickets.list().filter(ticket => ticket.title.includes('Write plan B'))).toHaveLength(1)
  })

  it('keeps another writer\'s edits to repositories.json and REPOSITORIES.md made while it works', async () => {
    const env = await start({ during: current => {
      // Another tool adds an entry and a row, formatted as the files are, between the tool's first read and its write.
      const parsed = JSON.parse(readFileSync(current.catalogue, 'utf8')) as { repositories: Record<string, unknown>[] }
      parsed.repositories.push(gitEntry('zeta', 'Added by another tool.'))
      writeFileSync(current.catalogue, `${JSON.stringify(parsed, null, 2)}\n`)
      writeFileSync(current.index, INDEX.replace('## Maintain this index', '## Maintain this index\n\nEdited by another tool.'))
    } })
    const result = await env.call({ folder: 'PERSONAL/garden', purpose: 'Plan the garden.' })
    expect(result.isError, result.text).toBeUndefined()
    expect(entriesOf(env).map(item => item.path)).toEqual(['PERSONAL/automix', 'PERSONAL/garden', 'PERSONAL/votes', 'widgets', 'zeta'])
    // The scope line counted three entries, but the list had four when it was written: it is left as it is.
    expect(result.data.scope).toMatch(/^left as it is/)
    const index = readFileSync(env.index, 'utf8')
    expect(index).toContain('Edited by another tool.')
    expect(index).toContain('| [PERSONAL/garden](PERSONAL/garden/REPO_MAP.md)')
    // The backups are of the files as the other tool left them, read right before the write.
    expect(readFileSync((result.data.backups as string[])[0]!, 'utf8')).toContain('"path": "zeta"')
  })

  it('writes nothing to a shared file whose shape changed, finishes the rest, and says so', async () => {
    const env = await start({ during: current => {
      writeFileSync(current.catalogue, JSON.stringify(JSON.parse(readFileSync(current.catalogue, 'utf8'))))
      writeFileSync(current.index, INDEX.replace('### PERSONAL', '### Personal things'))
    } })
    const compact = () => readFileSync(env.catalogue, 'utf8')
    const result = await env.call({ folder: 'PERSONAL/garden', purpose: 'Plan the garden.' })
    expect(result.isError, result.text).toBeUndefined()
    expect(result.data.catalogue).toMatch(/^not changed: its text is not what JSON\.stringify writes .* Add the entry by hand: \{"path":"PERSONAL\/garden"/)
    expect(result.data.index).toMatch(/^not changed: the section has no "### PERSONAL" heading\. Add this row by hand: \| \[PERSONAL\/garden\]/)
    expect(compact()).not.toContain('PERSONAL/garden')
    expect(readFileSync(env.index, 'utf8')).toBe(INDEX.replace('### PERSONAL', '### Personal things'))
    expect(result.data.backups).toEqual([])
    // Not catalogued, the project is known by its T3 Code title, and it is ready.
    expect(result.data).toMatchObject({ key: 'garden', status: 'ready' })
  })

  it('keeps a catalogue indented with four spaces as it is', async () => {
    const env = await start()
    writeFileSync(env.catalogue, `${JSON.stringify(JSON.parse(readFileSync(env.catalogue, 'utf8')), null, 4)}\n`)
    const result = await env.call({ folder: 'NDC/four', purpose: 'Four spaces.' })
    expect(result.isError, result.text).toBeUndefined()
    const after = readFileSync(env.catalogue, 'utf8')
    expect(after).toBe(`${JSON.stringify(JSON.parse(after), null, 4)}\n`)
    expect(entriesOf(env).map(item => item.path)).toEqual(['NDC/four', 'PERSONAL/automix', 'PERSONAL/votes', 'widgets'])
  })

  it('reads the projects after its own changes, not by joining a read that started while the CLI ran', async () => {
    // As the timer's read would: it reads T3 Code before the project is added, and the catalogue before the entry is written.
    const env = await start({ during: current => { void current.made.runtime.projects.refresh().catch(() => {}) } })
    const result = await env.call({ folder: 'NDC/timed', purpose: 'Timed.' })
    expect(result.isError, result.text).toBeUndefined()
    expect(result.data).toMatchObject({ key: 'NDC/timed', status: 'ready', project_id: 'p-new-1' })
    expect(result.data.why).toBeUndefined()
  })
})

describe('the t3 CLI runner', () => {
  it('passes the title as one argument, the base dir when set, and the path, and reports the CLI\'s own error', async () => {
    const bin = join(scratch, 'fake-t3')
    const log = join(scratch, 'fake-t3.log')
    // Prints what t3 0.1.6 prints. Like t3, it reads a separate argument after --title as an option when it starts with a dash
    // (--help prints the help and exits 0, anything else fails with the help's text); --title=<title> is taken as it is.
    writeFileSync(bin, ['#!/bin/sh', `printf '%s\\n' "$@" > '${log}'`, 'title=""; next=""',
      'for arg in "$@"; do',
      '  if [ "$next" = 1 ]; then next=""; case "$arg" in --help) echo DESCRIPTION; exit 0;; -*) echo "  --log-level <all|trace|debug|info|warning|error|fatal|none>"; exit 1;; esac; title="$arg"; fi',
      '  case "$arg" in --title) next=1;; --title=*) title="${arg#--title=}";; esac; last="$arg"',
      'done',
      'if [ "$title" = "taken" ]; then echo "  --log-level <all|trace|debug|info|warning|error|fatal|none>"; '
        + 'echo "[12:00:00.000] ERROR (#2): ProjectAlreadyExistsError: An active project already exists for \'$last\'."; exit 1; fi',
      'if [ "$title" = "quiet" ]; then echo DESCRIPTION; exit 0; fi',
      'echo "Added project 11111111-2222-3333-4444-555555555555 ($title) at $last."', ''].join('\n'))
    chmodSync(bin, 0o755)
    const withBase = t3Cli({ bin, baseDir: '/isolated/base' })
    expect(withBase.problem()).toBeUndefined()
    expect(await withBase.addProject('/work/garden', 'garden')).toBe('Added project 11111111-2222-3333-4444-555555555555 (garden) at /work/garden.')
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['project', 'add', '--title=garden', '--base-dir', '/isolated/base', '/work/garden'])
    // A title that starts with a dash is the title, not an option.
    for (const title of ['--help', '-x', '--base-dir']) {
      expect(await withBase.addProject('/work/dash', title)).toBe(`Added project 11111111-2222-3333-4444-555555555555 (${title}) at /work/dash.`)
      expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['project', 'add', `--title=${title}`, '--base-dir', '/isolated/base', '/work/dash'])
    }
    // The error is the line that names one, not the first line that has the word "error" in it.
    await expect(withBase.addProject('/work/taken', 'taken')).rejects.toThrow(/^t3 project add failed: ERROR \(#2\): ProjectAlreadyExistsError: An active project already exists/)
    // A run that exits 0 without saying it added the project is a failure, with what it printed.
    await expect(withBase.addProject('/work/quiet', 'quiet')).rejects.toThrow('t3 project add did not say it added the project; it printed: DESCRIPTION')
    // Without a base dir the CLI uses T3 Code's own default; the argument is left out.
    const plain = t3Cli({ bin })
    await plain.addProject('/work/garden', 'garden')
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['project', 'add', '--title=garden', '/work/garden'])
    expect(t3Cli({ bin: join(scratch, 'no-such-t3') }).problem()).toMatch(/cannot be run here: set T3_BIN/)
  })
})

describe('a shared file\'s update', () => {
  const file = () => {
    const dir = mkdtempSync(join(scratch, 'shared-'))
    const path = join(dir, 'shared.txt')
    writeFileSync(path, 'one\n')
    return { dir, path, backups: join(dir, 'backups') }
  }
  const append = (line: string) => (raw: string) => ({ text: `${raw}${line}\n`, result: 'added' })

  it('keeps another writer\'s edit made between its read and its write, backing the file up once', () => {
    const { dir, path, backups } = file()
    const made: string[] = []
    let calls = 0
    const result = updateFile(path, backups, made, raw => {
      // The other writer's edit lands after this read and before the write.
      if (calls++ === 0) writeFileSync(path, `${raw}other\n`)
      return append('mine')(raw)
    })
    expect(result).toEqual({ text: 'one\nother\nmine\n', result: 'added' })
    expect(calls).toBe(2)
    expect(readFileSync(path, 'utf8')).toBe('one\nother\nmine\n')
    // One copy, made before the first write was tried: the file as it was then, without this call's line.
    expect(made).toHaveLength(1)
    expect(readFileSync(made[0]!, 'utf8')).toBe('one\nother\n')
    expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('gives up after three tries on a file that keeps changing, leaving the other writer\'s text', () => {
    const { dir, path, backups } = file()
    const made: string[] = []
    let calls = 0
    expect(() => updateFile(path, backups, made, raw => { writeFileSync(path, `${raw}other ${++calls}\n`); return append('mine')(raw) }))
      .toThrow(/shared\.txt kept changing while superagent_new_project wrote to it/)
    expect(calls).toBe(3)
    expect(readFileSync(path, 'utf8')).toBe('one\nother 1\nother 2\nother 3\n')
    expect(made).toHaveLength(1)
    expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('leaves the scope line when only its count of linked worktrees is not the list\'s own', () => {
    const entries = [folderEntry('PERSONAL/automix', 'DJ mixes.'), gitEntry('widgets', 'Widget shop.')]
    const raw = catalogueText(scratch, entries, '2 mapped entries: 1 Git repositories, 1 linked worktrees and 1 additional project or reference folders.')
    const change = addEntry(raw, { path: 'toolbox', kind: 'git-repository' })
    expect(change.result).toBe('added')
    expect(change.scope).toMatch(/^left as it is/)
    expect(JSON.parse(change.text!).scope).toBe('2 mapped entries: 1 Git repositories, 1 linked worktrees and 1 additional project or reference folders.')
  })
})
