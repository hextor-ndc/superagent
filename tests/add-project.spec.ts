/**
 * `superagent_add_project` (src/app/add-project.ts) in memory: a temp workspace with real git checkouts, a catalogue that lists
 * some of them, and a FakeT3 whose `addProject` stands in for the t3 CLI. Adding one and several, every refusal (no CLI run,
 * nothing written), a repeated call, a title that starts with a dash, a first request, a CLI failure for one of several, and
 * the texts superagent_request, the rules router and superagent_projects give for a folder that can be added.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { threadKey } from '../vendor/dsh/src/core/index.ts'
import type { T3Cli } from '../src/app/new-project.ts'
import { checkout, data, git, mcp, until } from './harness.ts'
import { named, setup, workerLaunches, worktreesOf, type Setup } from './two-projects.ts'

const scratch = mkdtempSync(join(tmpdir(), 'superagent-add-project-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

interface Env extends Setup {
  catalogue: string; index: string; client: Client; outside: string
  /** What the stand-in CLI was asked to add, in order. */
  added: { root: string; title: string }[]
  /** The real path of a folder in the workspace. */
  at(path: string): string
  call(args: Record<string, unknown>): Promise<{ isError?: boolean; text: string; data: Record<string, unknown> & { projects: Record<string, unknown>[] } }>
  tool(name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; text: string; data: Record<string, unknown> }>
}
let open: Env | undefined
afterEach(async () => { await open?.client.close(); await open?.made.close(); open = undefined })

/**
 * widgets (the legacy project) and gadgets registered in T3 Code, and a catalogue of the workspace that lists:
 * - widgets (registered), NDC/bardash and NDC/winedb (git checkouts T3 Code does not have; winedb has uncommitted changes);
 * - NDC/bardash-wt, a linked worktree of bardash catalogued as `git-worktree`, and PERSONAL/linked, one of winedb catalogued
 *   as `git-repository`;
 * - PERSONAL/notes (a folder without git), ARCHIVE/old (denied by default), FAMILY/secret (denied by projects.json), gone
 *   (not on disk) and NDC/thing-superagent (a folder of ticket worktrees).
 * NDC/stray is a git checkout on disk that the catalogue does not list, and `escape` a symlink to a checkout outside it.
 *
 * `prepare` makes more folders before the registry first reads them, and returns more catalogue entries (`[path, kind]`).
 * `during` runs inside the stand-in CLI before it adds the project, which, like the t3 CLI, fails with ProjectAlreadyExistsError
 * for a folder T3 Code has. `gitEnv` is the environment git runs with, for superagent_new_project's commit.
 */
async function start(options: { cli?: T3Cli; failFor?: string; catalogue?: false; prepare?: (dir: string, outside: string) => [string, string?][]
  during?: (env: Env, root: string) => void | Promise<void>; gitEnv?: NodeJS.ProcessEnv } = {}): Promise<Env> {
  const { dir } = checkout('widgets')
  checkout('gadgets', dir)
  for (const path of ['NDC/bardash', 'NDC/winedb', 'ARCHIVE/old', 'FAMILY/secret', 'NDC/stray', 'NDC/thing-superagent']) checkout(path, dir)
  writeFileSync(join(dir, 'NDC', 'winedb', 'WIP.md'), 'not committed\n')
  git(join(dir, 'NDC', 'bardash'), 'worktree', 'add', '-q', '-b', 'side', join(dir, 'NDC', 'bardash-wt'))
  git(join(dir, 'NDC', 'winedb'), 'worktree', 'add', '-q', '-b', 'linked', join(dir, 'PERSONAL', 'linked'))
  mkdirSync(join(dir, 'PERSONAL', 'notes'), { recursive: true })
  writeFileSync(join(dir, 'PERSONAL', 'notes', 'ideas.txt'), 'ideas\n')
  const outside = mkdtempSync(join(scratch, 'outside-'))
  checkout('repo', outside)
  symlinkSync(join(outside, 'repo'), join(dir, 'escape'))
  const more = options.prepare?.(dir, outside) ?? []
  const catalogue = join(dir, 'repositories.json')
  const entry = (path: string, kind = 'git-repository') => ({ path, purpose: `The ${path} project.`, kind })
  writeFileSync(catalogue, `${JSON.stringify({ workspace: dir, repositories: [entry('ARCHIVE/old'), entry('FAMILY/secret'), entry('NDC/bardash'),
    entry('NDC/bardash-wt', 'git-worktree'), entry('NDC/thing-superagent'), entry('NDC/winedb'), entry('PERSONAL/linked'),
    entry('PERSONAL/notes', 'project-folder'), entry('gone'), entry('widgets'), ...more.map(([path, kind]) => entry(path, kind))] }, null, 2)}\n`)
  const index = join(dir, 'REPOSITORIES.md')
  writeFileSync(index, '# Coding repository index\n\n## Repository and project catalog\n')
  const added: Env['added'] = []
  let env!: Env
  const cli: T3Cli = options.cli ?? {
    problem: () => undefined,
    async addProject(root, title) {
      added.push({ root, title })
      await options.during?.(env, root)
      if (options.failFor && root.endsWith(options.failFor)) throw new Error('t3 project add failed: SomethingError: the disk is full.')
      // What the t3 CLI wrapper throws for a folder T3 Code has a project for (tests/new-project.spec.ts, the t3 CLI runner).
      if (env.t3.projects.some(project => project.workspaceRoot === root)) {
        throw new Error(`t3 project add failed: ERROR (#2): ProjectAlreadyExistsError: An active project already exists for '${root}'.`)
      }
      const id = `p-added-${added.length}`
      env.t3.addProject({ id, workspaceRoot: root, title })
      return `Added project ${id} (${title}) at ${root}.`
    },
  }
  const made = await setup({ dir, ...options.catalogue === false ? {} : { catalogue }, projects: { 'FAMILY/': { access: 'deny' } },
    newProject: { cli, listWaitMs: 200, ...options.gitEnv ? { env: options.gitEnv } : {} } })
  const client = await mcp(`${made.made.base}/mcp/console/console-secret`)
  const tool = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args })
    const text = (result.content as { type: string; text?: string }[]).map(item => item.text ?? '').join('\n')
    return { ...result.isError ? { isError: true } : {}, text, data: data(result) ?? {} }
  }
  env = Object.assign(made, { catalogue, index, client, outside, added, at: (path: string) => join(realpathSync(dir), path), tool,
    call: (args: Record<string, unknown>) => tool('superagent_add_project', args) }) as Env
  open = env
  return env
}

/** Every file under the workspace but the state dir, git's own files included, with its content. */
function snapshot(env: Env): Record<string, string> {
  const files: Record<string, string> = {}
  const walk = (dir: string) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, item.name)
      const key = relative(env.dir, path)
      if (key === 'state') continue
      if (item.isSymbolicLink()) files[key] = 'link'
      else if (item.isDirectory()) { files[key] = 'dir'; walk(path) } else files[key] = readFileSync(path, 'latin1')
    }
  }
  walk(env.dir)
  return files
}
const one = (project: string, more: Record<string, unknown> = {}) => ({ projects: [{ project, ...more }] })

describe('superagent_add_project', () => {
  it('adds a catalogued checkout to T3 Code, writing nothing in it or the catalogue, and a repeat adds nothing', async () => {
    const env = await start()
    // A tracked file newer than the index makes a plain `git status` write the index again; superagent must not.
    const later = new Date(Date.now() + 60_000)
    utimesSync(join(env.dir, 'NDC', 'bardash', 'README.md'), later, later)
    const before = snapshot(env)
    const projects = env.t3.projects.length
    const { data: made, isError, text } = await env.call(one('NDC/bardash'))
    expect(isError, text).toBeUndefined()
    const root = env.at('NDC/bardash')
    expect(made).toEqual({ summary: '1 added', projects: [{ project: 'NDC/bardash', outcome: 'added', key: 'NDC/bardash', status: 'ready',
      project_id: 'p-added-1', title: 'NDC/bardash', root,
      manual_step: 'In T3 Code, open the settings of the project "NDC/bardash" and turn off PR watching and "continue threads after server update". '
        + 'The super agent cannot read or change these settings.' }] })
    // The CLI ran once, with the real root and the catalogue path as the title; T3 Code has one more project.
    expect(env.added).toEqual([{ root, title: 'NDC/bardash' }])
    expect(env.t3.projects).toHaveLength(projects + 1)
    // Nothing in the workspace changed: the repository, its git files, the catalogue and the index are as they were.
    expect(snapshot(env)).toEqual(before)
    // The project lists as ready, and the registry takes it by key.
    const listed = await env.tool('superagent_projects', { query: 'NDC/bardash' })
    expect(listed.data).toMatchObject({ projects: [expect.objectContaining({ key: 'NDC/bardash', id: 'p-added-1', status: 'ready', base_ref: 'main',
      worktree_root: join(env.dir, 'state', 'worktrees', 'ndc-bardash') })] })

    // A repeat, also by its absolute path, finds it registered and runs nothing.
    for (const name of ['NDC/bardash', root, 'NDC/bardash/']) {
      const again = await env.call(one(name))
      expect(again.isError, again.text).toBeUndefined()
      expect(again.data).toEqual({ summary: '1 registered already', projects: [{ project: name, outcome: 'registered already', key: 'NDC/bardash', status: 'ready',
        project_id: 'p-added-1', title: 'NDC/bardash', root }] })
    }
    expect(env.added).toHaveLength(1)

    // A request naming it lands there, in a worktree of its own repository.
    const filed = await env.tool('superagent_request', { text: 'Fix the bar totals', project: 'NDC/bardash', wait_seconds: 10 })
    expect(filed.isError, filed.text).toBeUndefined()
    expect(filed.data).toMatchObject({ status: 'accepted', filed_in: 'NDC/bardash', project: 'NDC/bardash' })
    const launch = await until(() => workerLaunches(env.t3)[0], 'the worker launch')
    const args = launch.args as { projectId: string; worktreePath: string }
    expect(args.projectId).toBe('p-added-1')
    expect(worktreesOf(root)).toContain(realpathSync(args.worktreePath))
    expect(realpathSync(args.worktreePath).startsWith(realpathSync(join(env.dir, 'state', 'worktrees', 'ndc-bardash')))).toBe(true)
    expect(worktreesOf(env.widgets)).not.toContain(realpathSync(args.worktreePath))
  })

  it('adds several at once, each with its own result, and says what a dirty checkout means', async () => {
    const env = await start()
    const { data: made, isError, text } = await env.call({ projects: [{ project: 'NDC/bardash' }, { project: 'ndc/winedb', title: 'Wine DB' },
      { project: 'PERSONAL/notes' }, { project: 'widgets' }, { project: 'NDC/nowhere' }, { project: 'NDC/bardash' }] })
    expect(isError, text).toBeUndefined()
    const insensitive = (() => { try { return realpathSync.native(join(env.dir, 'ndc')) === env.at('NDC') } catch { return false } })()
    expect(made.summary).toBe(insensitive ? '2 added, 2 registered already, 2 refused' : '1 added, 2 registered already, 3 refused')
    const [bardash, winedb, notes, widgets, nowhere, twice] = made.projects
    expect(bardash).toMatchObject({ outcome: 'added', key: 'NDC/bardash', status: 'ready' })
    expect(bardash!.warnings).toBeUndefined()
    // A name in another case is the folder as the disk names it, on a disk that ignores case; elsewhere it is no folder.
    if (insensitive) {
      expect(winedb).toMatchObject({ project: 'ndc/winedb', outcome: 'added', key: 'NDC/winedb', status: 'ready', title: 'Wine DB', root: env.at('NDC/winedb'),
        manual_step: expect.stringContaining('the project "Wine DB"'), warnings: [`${env.at('NDC/winedb')} has 1 uncommitted change. That does not stop it `
          + 'being a project: ticket worktrees start from the last commit of main, and when that is the branch checked out, each worker is told the '
          + 'changes are not in its worktree (dirty: warn; projects.json can set dirty: refuse).'] })
    } else {
      expect(winedb).toMatchObject({ outcome: 'refused' })
    }
    expect(notes).toMatchObject({ outcome: 'refused', key: 'PERSONAL/notes', status: 'no-git', why: expect.stringContaining('does not run git init') })
    expect(widgets).toMatchObject({ outcome: 'registered already', key: 'widgets', project_id: 'p-widgets', status: 'ready' })
    expect(nowhere).toMatchObject({ outcome: 'refused', why: expect.stringContaining('There is no folder') })
    // The same folder twice: the second finds the first's project.
    expect(twice).toMatchObject({ outcome: 'registered already', key: 'NDC/bardash', project_id: bardash!.project_id })
    expect(env.added.map(item => item.title)).toEqual(['NDC/bardash', ...insensitive ? ['Wine DB'] : []])
  })

  it('refuses, running no CLI and writing nothing, every folder that is not a catalogued main checkout, with the reason', async () => {
    const env = await start()
    const before = snapshot(env)
    const projects = env.t3.projects.length
    const refused: [Record<string, unknown>, RegExp][] = [
      [one('ARCHIVE/old'), /ARCHIVE\/old is denied: Denied by default \(ARCHIVE\/\)\./],
      [one('FAMILY/secret'), /FAMILY\/secret is denied: Denied by projects\.json \(FAMILY\/\)\./],
      [one('PERSONAL/notes'), /is not a git checkout; workers need one\. superagent works only in git checkouts, and it does not run git init in a folder that exists/],
      [one('NDC/bardash-wt'), /NDC\/bardash-wt is a linked worktree of .*NDC\/bardash, not a project of its own\. Add its main checkout instead: superagent_add_project with project NDC\/bardash\./],
      [one('PERSONAL/linked'), /PERSONAL\/linked is a linked worktree of .*NDC\/winedb, not a project of its own\. Add its main checkout instead: superagent_add_project with project NDC\/winedb\./],
      [one('gone'), /gone is missing-checkout: .*gone no longer exists\./],
      [one('escape'), /escape is .*outside-.*repo, outside the catalogue's workspace/],
      [one(join(env.outside, 'repo')), /outside the catalogue's workspace/],
      [one('NDC/stray'), /NDC\/stray is not in the catalogue, so superagent_add_project does not add it\. Add it to the catalogue \(.*repositories\.json\) first, then call again; to start a new folder, use superagent_new_project\./],
      [one('NDC/nothing'), /There is no folder .*NDC\/nothing, and no catalogued folder or project NDC\/nothing\..*superagent_new_project/],
      [one('NDC/thing-superagent'), /NDC\/thing-superagent cannot be a project for work\. It is a "-superagent" folder/],
      [one('~/elsewhere'), /is not a path superagent can read/],
      [one('NDC/bardash', { title: 'Two\nlines' }), /The title must be one line/],
    ]
    for (const [args, expected] of refused) {
      const result = await env.call(args)
      expect(result.isError, JSON.stringify(args)).toBe(true)
      expect(result.data.projects, JSON.stringify(args)).toEqual([expect.objectContaining({ outcome: 'refused', why: expect.stringMatching(expected) })])
    }
    // A first request goes with one project only; refused before anything runs.
    const two = await env.call({ projects: [{ project: 'NDC/bardash' }, { project: 'NDC/winedb' }], request: 'Fix both' })
    expect(two.isError).toBe(true)
    expect(two.text).toContain('A first request goes with one project, and 2 were given')
    expect(snapshot(env)).toEqual(before)
    expect(env.added).toEqual([])
    expect(env.t3.projects).toHaveLength(projects)
    expect(env.made.runtime.repo.threads.list()).toEqual([])
  })

  it('refuses without a catalogue, and refuses an addable folder when the t3 CLI cannot run, running nothing', async () => {
    const env = await start({ catalogue: false })
    const result = await env.call(one('NDC/bardash'))
    expect(result.isError).toBe(true)
    expect(result.text).toContain('No catalogue is configured: set SUPERAGENT_CATALOGUE')
    await env.client.close(); await env.made.close(); open = undefined

    let ran = false
    const without = await start({ cli: { problem: () => 'The T3 Code CLI t3 cannot be run here: set T3_BIN.', addProject: async () => { ran = true; return '' } } })
    const before = snapshot(without)
    const refused = await without.call({ projects: [{ project: 'NDC/bardash' }, { project: 'widgets' }] })
    expect(refused.isError, refused.text).toBeUndefined()
    expect(refused.data.projects).toEqual([expect.objectContaining({ outcome: 'refused', why: expect.stringContaining('set T3_BIN') }),
      expect.objectContaining({ outcome: 'registered already', key: 'widgets' })])
    expect(ran).toBe(false)
    expect(snapshot(without)).toEqual(before)
  })

  it('keeps a title that starts with a dash as the title', async () => {
    const env = await start()
    const made = await env.call(one('NDC/bardash', { title: '--help' }))
    expect(made.isError, made.text).toBeUndefined()
    expect(made.data.projects).toEqual([expect.objectContaining({ outcome: 'added', key: 'NDC/bardash', title: '--help', status: 'ready',
      manual_step: expect.stringContaining('the project "--help"') })])
    expect(env.added).toEqual([{ root: env.at('NDC/bardash'), title: '--help' }])
    expect(env.t3.projects.at(-1)).toMatchObject({ workspaceRoot: env.at('NDC/bardash'), title: '--help' })
  })

  it('reports a CLI failure for one project and adds the others', async () => {
    const env = await start({ failFor: 'bardash' })
    const result = await env.call({ projects: [{ project: 'NDC/bardash' }, { project: 'NDC/winedb' }] })
    expect(result.isError, result.text).toBeUndefined()
    expect(result.data.projects).toEqual([
      { project: 'NDC/bardash', outcome: 'failed', key: 'NDC/bardash', root: env.at('NDC/bardash'), why: 't3 project add failed: SomethingError: the disk is full.' },
      expect.objectContaining({ project: 'NDC/winedb', outcome: 'added', key: 'NDC/winedb', status: 'ready' })])
    // All failed or refused: the call is an error.
    const again = await env.call(one('NDC/bardash'))
    expect(again.isError).toBe(true)
    expect(again.data.projects).toEqual([expect.objectContaining({ outcome: 'failed' })])
  })

  it('files a first request in the project it adds, once however often the call is repeated', async () => {
    const env = await start()
    const args = { ...one('NDC/winedb'), request: 'Fix the wine labels', wait_seconds: 10 }
    const made = await env.call(args)
    expect(made.isError, made.text).toBeUndefined()
    const request = made.data.request as { trigger_id: string; status: string; filed_in: string; project: string }
    expect(request).toMatchObject({ status: 'accepted', filed_in: 'NDC/winedb', project: 'NDC/winedb', trigger_id: expect.stringMatching(/^console:add-project:[0-9a-f]{16}$/) })
    const launch = await until(() => workerLaunches(env.t3)[0], 'the worker launch')
    expect(worktreesOf(env.at('NDC/winedb'))).toContain(realpathSync((launch.args as { worktreePath: string }).worktreePath))
    const again = await env.call(args)
    expect(again.data).toMatchObject({ summary: '1 registered already', request: { repeated: true, trigger_id: request.trigger_id, status: 'accepted' } })
    expect(env.made.runtime.repo.tickets.list().filter(ticket => ticket.title.includes('Fix the wine labels'))).toHaveLength(1)
    // Its linked worktree, once its main checkout is registered, is refused naming that project, here and in the list.
    const linked = await env.call(one('PERSONAL/linked'))
    expect(linked.data.projects).toEqual([expect.objectContaining({ outcome: 'refused',
      why: expect.stringMatching(/is a linked worktree of .*NDC\/winedb, not a project of its own\. Its main checkout is the T3 Code project NDC\/winedb: file the work there\./) })])
    expect(env.made.runtime.projects.resolve('PERSONAL/linked').found).toMatchObject({ status: 'not-registered',
      reason: `${env.at('PERSONAL/linked')} is a linked worktree of ${env.at('NDC/winedb')}, not a project of its own, which is the T3 Code project NDC/winedb: file its work there.` })
    // A refused project files nothing, and says so.
    const notes = await env.call({ ...one('PERSONAL/notes'), request: 'Tidy the notes' })
    expect(notes.isError).toBe(true)
    expect(notes.data.request).toEqual({ not_filed: 'PERSONAL/notes was refused, so the request was not filed.' })
  })
})

describe('superagent_add_project, at the edges', () => {
  it('refuses a catalogued folder whose real path is outside the workspace, through a symlink or ../, and the list does not offer it', async () => {
    let up = ''
    const env = await start({ prepare: (dir, outside) => {
      checkout('repo2', outside)
      up = relative(dir, join(outside, 'repo2'))
      return [['escape'], [up]]
    } })
    const before = snapshot(env)
    const listed = await env.tool('superagent_projects', { status: 'not-registered' })
    const rows = listed.data.projects as { key: string; why: string; root: string }[]
    for (const key of ['escape', up]) {
      const row = rows.find(item => item.key === key)!
      expect(row.why).toBe(`${key} is ${row.root}, outside the catalogue's workspace ${env.at('').replace(/\/$/, '')}: superagent_add_project adds only folders `
        + 'inside it. Add it as a project in T3 Code itself if it should be one.')
      const result = await env.call(one(key))
      expect(result.isError, key).toBe(true)
      expect(result.data.projects).toEqual([expect.objectContaining({ outcome: 'refused', key, why: row.why })])
    }
    // By its absolute path too, as the registry resolves it.
    const byPath = await env.call(one(join(env.outside, 'repo')))
    expect(byPath.data.projects).toEqual([expect.objectContaining({ outcome: 'refused', why: expect.stringContaining("outside the catalogue's workspace") })])
    expect(env.added).toEqual([])
    expect(snapshot(env)).toEqual(before)
  })

  it('never offers to add, or to file work in, the denied main checkout of a linked worktree', async () => {
    const env = await start({ prepare: dir => {
      checkout('ARCHIVE/hidden', dir)
      git(join(dir, 'ARCHIVE', 'old'), 'worktree', 'add', '-q', '-b', 'wt', join(dir, 'NDC', 'oldwt'))
      git(join(dir, 'ARCHIVE', 'old'), 'worktree', 'add', '-q', '-b', 'wt2', join(dir, 'NDC', 'oldwt2'))
      git(join(dir, 'ARCHIVE', 'hidden'), 'worktree', 'add', '-q', '-b', 'wt', join(dir, 'NDC', 'hiddenwt'))
      return [['NDC/oldwt'], ['NDC/oldwt2', 'git-worktree'], ['NDC/hiddenwt']]
    } })
    const old = env.at('ARCHIVE/old')
    const why = async (key: string) => ((await env.tool('superagent_projects', { query: key })).data.projects as { key: string; why: string }[])
      .find(row => row.key === key)?.why
    // Catalogued and denied by default; not catalogued and under ARCHIVE/.
    expect(await why('NDC/oldwt')).toBe(`${env.at('NDC/oldwt')} is a linked worktree of ${old}, not a project of its own, so work cannot go to it `
      + 'or to its main checkout ARCHIVE/old, which is denied: Denied by default (ARCHIVE/).')
    expect(await why('NDC/hiddenwt')).toBe(`${env.at('NDC/hiddenwt')} is a linked worktree of ${env.at('ARCHIVE/hidden')}, not a project of its own, `
      + 'so work cannot go to it or to its main checkout, which is denied: Denied by default (ARCHIVE/).')
    const request = await env.tool('superagent_request', { text: 'Fix it', project: 'NDC/oldwt' })
    expect(request.isError).toBe(true)
    expect(request.text).toContain('which is denied: Denied by default (ARCHIVE/).')
    const refusals = async () => Promise.all(['NDC/oldwt', 'NDC/oldwt2', 'NDC/hiddenwt'].map(async key => (await env.call(one(key))).data.projects[0]))
    for (const result of await refusals()) {
      expect(result).toMatchObject({ outcome: 'refused' })
      expect(result!.why).not.toMatch(/superagent_add_project with project|file the work there/)
    }
    const [oldwt, oldwt2, hiddenwt] = await refusals()
    expect(oldwt!.why).toBe(`${env.at('NDC/oldwt')} is a linked worktree of ${old}, not a project of its own. Its main checkout ARCHIVE/old is denied: `
      + 'Denied by default (ARCHIVE/).')
    expect(oldwt2!.why).toBe(`NDC/oldwt2 is a linked worktree of ${old}, not a project of its own. Its main checkout ARCHIVE/old is denied: Denied by default (ARCHIVE/).`)
    expect(hiddenwt!.why).toBe(`${env.at('NDC/hiddenwt')} is a linked worktree of ${env.at('ARCHIVE/hidden')}, not a project of its own. Its main checkout `
      + 'cannot be a project for work. It is denied by default (ARCHIVE/).')

    // Registered in T3 Code, and denied all the same: no work goes there either.
    env.t3.addProject({ id: 'p-archive', workspaceRoot: old, title: 'old' })
    await env.tool('superagent_projects', { refresh: true })
    expect(await why('NDC/oldwt')).toBe(`${env.at('NDC/oldwt')} is a linked worktree of ${old}, not a project of its own, so work cannot go to it `
      + 'or to its main checkout, the T3 Code project ARCHIVE/old, which is denied: Denied by default (ARCHIVE/).')
    const [registeredWt, registeredWt2] = await refusals()
    for (const [result, name] of [[registeredWt, env.at('NDC/oldwt')], [registeredWt2, 'NDC/oldwt2']] as const) {
      expect(result!.why).toBe(`${name} is a linked worktree of ${old}, not a project of its own. Its main checkout is the T3 Code project ARCHIVE/old, `
        + 'which is denied: Denied by default (ARCHIVE/).')
    }
    expect(env.added).toEqual([])
  })

  it('reads the projects after the CLI ran, even while another read is running, and a folder catalogued just before', async () => {
    const env = await start({ during: made => { void made.made.runtime.projects.refresh().catch(() => {}) } })
    const result = await env.call(one('NDC/bardash'))
    expect(result.data.projects).toEqual([expect.objectContaining({ outcome: 'added', key: 'NDC/bardash', status: 'ready', project_id: 'p-added-1' })])
    expect(result.data.projects[0]!.why).toBeUndefined()

    // A read that started before the catalogue lists NDC/stray does not decide the call.
    const registry = env.made.runtime.projects
    const stale = registry.refresh()
    const listed = JSON.parse(readFileSync(env.catalogue, 'utf8')) as { repositories: unknown[] }
    listed.repositories.push({ path: 'NDC/stray', purpose: 'Strays.', kind: 'git-repository' })
    writeFileSync(env.catalogue, `${JSON.stringify(listed, null, 2)}\n`)
    const added = await env.made.runtime.addProjects([{ project: 'NDC/stray' }])
    await stale
    expect(added).toEqual([expect.objectContaining({ outcome: 'added', key: 'NDC/stray', status: 'ready' })])
  })

  it('returns a project T3 Code got between its list and the CLI as registered already, with no manual step', async () => {
    const env = await start({ during: (made, root) => { made.t3.addProject({ id: 'p-operator', workspaceRoot: root, title: 'Bar dash' }) } })
    const result = await env.call(one('NDC/bardash'))
    expect(result.isError, result.text).toBeUndefined()
    expect(result.data.projects).toEqual([{ project: 'NDC/bardash', outcome: 'registered already', key: 'NDC/bardash', status: 'ready', project_id: 'p-operator',
      title: 'Bar dash', root: env.at('NDC/bardash') }])
  })

  it('adds a checkout with no commit yet, with a warning, and reports a failed read of the projects after the CLI', async () => {
    const env = await start({ prepare: dir => {
      execFileSync('git', ['init', '-q', '-b', 'main', join(dir, 'NDC', 'fresh')])
      return [['NDC/fresh']]
    } })
    const fresh = await env.call(one('NDC/fresh'))
    expect(fresh.data.projects).toEqual([expect.objectContaining({ outcome: 'added', key: 'NDC/fresh', status: 'ready',
      warnings: [`${env.at('NDC/fresh')} has no commit yet: ticket worktrees start from a commit, so requests there fail until it has one.`] })])
    await env.client.close(); await env.made.close(); open = undefined

    const broken = await start({ during: made => writeFileSync(made.catalogue, 'not json\n') })
    const result = await broken.call(one('NDC/bardash'))
    expect(result.isError, result.text).toBeUndefined()
    expect(result.data.projects).toEqual([expect.objectContaining({ outcome: 'added', key: 'NDC/bardash', project_id: 'p-added-1', status: 'not known',
      why: expect.stringMatching(/^Reading the projects again failed: The catalogue .*repositories\.json is not JSON/),
      manual_step: expect.stringContaining('the project "NDC/bardash"') })])
  })

  it('waits for a superagent_new_project call that runs the CLI before it runs its own, and the other way round', async () => {
    const identity = join(scratch, 'identity')
    writeFileSync(identity, '[user]\n\tname = Test Operator\n\temail = operator@example.test\n')
    let release!: () => void
    const held = new Promise<void>(done => { release = done })
    const env = await start({ gitEnv: { ...process.env, GIT_CONFIG_GLOBAL: identity, GIT_CONFIG_NOSYSTEM: '1' },
      during: async (_, root) => { if (root.endsWith('garden')) await held } })
    const making = env.tool('superagent_new_project', { folder: 'PERSONAL/garden', purpose: 'Plan the garden.' })
    await until(() => env.added.length === 1, 'the new project\'s CLI run')
    const adding = env.call(one('NDC/bardash'))
    await new Promise(done => setTimeout(done, 300))
    expect(env.added.map(item => item.root)).toEqual([env.at('PERSONAL/garden')])
    release()
    const [made, added] = await Promise.all([making, adding])
    expect(made.isError, made.text).toBeUndefined()
    expect(added.data.projects).toEqual([expect.objectContaining({ outcome: 'added', key: 'NDC/bardash' })])
    expect(env.added.map(item => item.root)).toEqual([env.at('PERSONAL/garden'), env.at('NDC/bardash')])
  })
})

describe('a folder that can be added, before it is', () => {
  it('is refused by superagent_request and the rules router with the tool to call, and listed by superagent_projects as one to add', async () => {
    const env = await start()
    const request = await env.tool('superagent_request', { text: 'Fix the bar totals', project: 'NDC/bardash' })
    expect(request.isError).toBe(true)
    expect(request.text).toContain('Project NDC/bardash is not-registered: Not a T3 Code project yet: call superagent_add_project with project NDC/bardash to add it')
    // Nothing is registered by the request: T3 Code has no project for it, and no CLI ran.
    expect(env.added).toEqual([])
    expect(env.t3.projects.some(project => project.workspaceRoot === env.at('NDC/bardash'))).toBe(false)

    // A request that reaches the rules router naming it is ignored with the same reason.
    const trigger = named('Fix the bar totals', 'NDC/bardash')
    env.made.runtime.engine.receive(trigger)
    const decision = await until(() => env.made.runtime.repo.decisions.byThread(threadKey(trigger.threads[0]!))[0], 'the decision')
    expect(decision.kind).toBe('ignore')
    expect(JSON.stringify(decision.reason)).toContain('call superagent_add_project with project NDC/bardash')
    expect(env.made.runtime.projectRefusal([trigger])).toContain('call superagent_add_project with project NDC/bardash')

    // The list of not-registered folders says how to add them, and which cannot be added.
    const listed = await env.tool('superagent_projects', { status: 'not-registered' })
    const rows = listed.data.projects as { key: string; why: string }[]
    expect(rows.map(row => row.key).sort()).toEqual(['NDC/bardash', 'NDC/winedb', 'PERSONAL/linked'])
    expect(rows.find(row => row.key === 'NDC/winedb')!.why).toContain('call superagent_add_project with project NDC/winedb')
    expect(rows.find(row => row.key === 'PERSONAL/linked')!.why).toContain('so add its main checkout instead: superagent_add_project with project NDC/winedb.')
    expect(listed.data.to_add).toContain('superagent_add_project with projects [{ project: <key> }]')
    expect(listed.data.setup).toContain('superagent_add_project adds one that is a git checkout')
  })
})
