/**
 * `superagent_add_project`: adds folders of the operator's catalogue (`SUPERAGENT_CATALOGUE`) as T3 Code projects, with the t3
 * CLI (`t3 project add`, the runner in new-project.ts), since the super agent's own token is refused `t3_project_create`. Only
 * a folder the registry lists as `not-registered` is added: catalogued, on disk, a git checkout, not denied. git is asked
 * again before the CLI runs, so a linked worktree is refused with its main checkout named, and a folder inside another
 * checkout too.
 *
 * It writes nothing into the repository (git is only read, without its optional index lock) and nothing to the catalogue
 * files, whose entry exists already; T3 Code's project list is the only thing it changes. Each project is decided and added
 * on its own, so a refusal or a failure of one does not stop the others. A project T3 Code has already is returned as it is,
 * without running the CLI, so a repeated call adds nothing.
 */
import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { T3Client } from '../t3/client.ts'
import { manualStep, notListed, type T3Cli } from './new-project.ts'
import { outsideReason, type ProjectEntry, type ProjectRegistry } from './projects.ts'

const run = promisify(execFile)

/** One project `superagent_add_project` is asked to add. */
export interface AddProjectInput {
  /** A catalogue path (`NDC/bardash`), a folder relative to the catalogue's workspace or absolute, or a key or alias the registry resolves. */
  project: string
  /** The T3 Code project's title; the catalogue path by default. */
  title?: string
}

export interface AddProjectContext {
  /** `SUPERAGENT_CATALOGUE`; without it every call is refused. */
  catalogue?: string
  projects: ProjectRegistry
  t3: Pick<T3Client, 'listProjects'>
  cli: T3Cli
  /** The environment git runs with; `process.env` by default. */
  env?: NodeJS.ProcessEnv
  /** How long to wait for T3 Code to list a project the CLI added; 10 s by default. */
  listWaitMs?: number
}

/** What became of one project, as `superagent_add_project` returns it. */
export interface AddProjectResult {
  /** The name as it was given. */
  project: string
  /**
   * `added`: the CLI added it now; `registered already`: T3 Code had it, and nothing ran; `refused`: nothing ran, `why` says
   * why; `failed`: the CLI failed, or T3 Code did not list what it added.
   */
  outcome: 'added' | 'registered already' | 'refused' | 'failed'
  /** The project's key, as `superagent_request` takes it. */
  key?: string
  status?: string
  why?: string
  project_id?: string
  title?: string
  root?: string
  /** Things to know that did not stop the add, such as uncommitted changes in the checkout. */
  warnings?: string[]
  /** What the operator still has to do in T3 Code, for a project added now. */
  manual_step?: string
}

/** What a checkout is when git reads it now; `problem` when it is not one superagent can work in. */
type Inspected = { problem: string } | { main: string } | { changes: number; head: boolean }

/** Adds each project in turn, then reads the projects again once. Throws only when nothing can be decided at all. */
export async function addProjects(context: AddProjectContext, inputs: AddProjectInput[]): Promise<AddProjectResult[]> {
  if (!context.catalogue) {
    throw new Error('No catalogue is configured: set SUPERAGENT_CATALOGUE to the repositories.json that lists the folders superagent_add_project may add.')
  }
  // The registry's last list may be minutes old, and the operator may have just catalogued a folder: a read that runs now may
  // have read the catalogue before that, so this one starts after it.
  await context.projects.reread()
  const workspace = context.projects.workspace()
  if (!workspace) throw new Error('The projects are read without a catalogue, so there is nothing superagent_add_project may add.')
  const env = context.env ?? process.env
  const results: AddProjectResult[] = []
  const counted = new Map<AddProjectResult, { changes: number; head: boolean }>()
  for (const input of inputs) {
    const decided = await decide(context, workspace, input, env)
    if ('result' in decided) { results.push(decided.result); continue }
    const result = await add(context, input, decided)
    if (result.outcome === 'added' || result.outcome === 'registered already') counted.set(result, decided)
    results.push(result)
  }

  if (!results.some(result => result.project_id)) return results
  // A read that runs now, such as the timer's, may have read T3 Code before the CLI added the projects.
  let refreshError: string | undefined
  await context.projects.reread().catch((error: unknown) => { refreshError = message(error) })
  for (const result of results) {
    if (!result.project_id) continue
    if (refreshError) { Object.assign(result, { status: 'not known', why: `Reading the projects again failed: ${refreshError}` }); continue }
    const entry = context.projects.byId(result.project_id)
    if (!entry) { Object.assign(result, { status: 'not listed', why: 'The registry does not list it after reading T3 Code again.' }); continue }
    Object.assign(result, { key: entry.key, status: entry.status, ...entry.reason ? { why: entry.reason } : {}, title: entry.title, root: entry.root })
    const checked = counted.get(result)
    const warnings = checked ? [...checked.head ? [] : [`${entry.root} has no commit yet: ticket worktrees start from a commit, so requests `
      + 'there fail until it has one.'], ...checked.changes ? [dirtyWarning(entry, checked.changes)] : []] : []
    if (warnings.length) result.warnings = warnings
  }
  return results
}

/** The checks that can refuse one project, before anything runs; the folder to add when none does. */
async function decide(context: AddProjectContext, workspace: string, input: AddProjectInput, env: NodeJS.ProcessEnv):
  Promise<{ result: AddProjectResult } | { root: string; key: string; title: string; changes: number; head: boolean }> {
  const given = input.project
  const refuse = (why: string, entry?: ProjectEntry) => ({ result: { project: given, outcome: 'refused' as const, why,
    ...entry ? { key: entry.key, status: entry.status, root: entry.root } : {} } })
  const name = given.trim().replace(/(?<=.)\/+$/, '')
  if (!name) return refuse('Name the project: a catalogue path such as NDC/bardash, as superagent_projects shows it.')
  let title: string | undefined
  if (input.title !== undefined) {
    title = input.title.trim()
    if (!title) return refuse('The title is empty.')
    if (/[\r\n]/.test(title)) return refuse('The title must be one line.')
    if (title.length > 100) return refuse('The title is longer than 100 characters.')
  }
  if (name.startsWith('~')) return refuse(`${name} is not a path superagent can read: give the folder relative to the workspace ${workspace}, such as NDC/bardash.`)

  const registry = context.projects
  // A name the registry resolves (key, alias, title, catalogue path, absolute path), else a folder by its real path, which
  // is how the registry lists it: on a disk that ignores case, ndc/bardash is NDC/bardash.
  const resolved = registry.resolve(name)
  const path = isAbsolute(name) ? resolve(name) : join(workspace, name)
  const abs = real(path)
  const entry = resolved.found ?? (abs ? registry.list().find(item => item.root === abs) : undefined)
  if (entry && entry.key !== name && !entry.aliases.includes(name) && entry.worktrees.includes(name)) {
    // A catalogued linked worktree: the registry shows it under its main checkout.
    return refuse(linkedWorktree(registry, workspace, name, entry.root), entry)
  }
  if (entry?.id) {
    return { result: { project: given, outcome: 'registered already', key: entry.key, status: entry.status, ...entry.reason ? { why: entry.reason } : {},
      project_id: entry.id, title: entry.title, root: entry.root } }
  }
  if (!entry) {
    if (!abs) {
      const suggestions = resolved.found ? [] : resolved.suggestions
      const near = suggestions.length ? ` Did you mean ${suggestions.join(', ')}?` : ''
      return refuse(`There is no folder ${path}, and no catalogued folder or project ${name}.${near} superagent_projects with status not-registered `
        + 'lists the catalogued folders superagent_add_project can add; to start a folder that does not exist yet, use superagent_new_project.')
    }
    if (!within(abs, workspace)) return refuse(outsideReason(name, abs, workspace))
    const denial = registry.denial(abs)
    if (denial) return refuse(`${relative(workspace, abs).split(sep).join('/')} cannot be a project for work. ${denial}`)
    const inspected = await inspect(abs, env)
    if ('main' in inspected) return refuse(linkedWorktree(registry, workspace, abs, inspected.main))
    return refuse(`${relative(workspace, abs).split(sep).join('/') || abs} is not in the catalogue, so superagent_add_project does not add it. Add it to `
      + `the catalogue (${context.catalogue}) first, then call again; to start a new folder, use superagent_new_project.`)
  }
  // A catalogue path through a symlink, or with ../, leads out of the workspace, where the deny rules never apply.
  if (!within(entry.root, workspace)) return refuse(outsideReason(entry.key, entry.root, workspace), entry)
  if (entry.status === 'no-git') {
    return refuse(`${entry.reason ?? `${entry.root} is not a git checkout.`} superagent works only in git checkouts, and it does not run git init in a `
      + 'folder that exists: make it a git repository yourself if it should be one, then call again.', entry)
  }
  if (entry.status !== 'not-registered') return refuse(`${entry.key} is ${entry.status}: ${entry.reason ?? 'it cannot take work.'}`, entry)

  const inspected = await inspect(entry.root, env)
  if ('problem' in inspected) return refuse(inspected.problem, entry)
  if ('main' in inspected) return refuse(linkedWorktree(registry, workspace, entry.root, inspected.main), entry)
  return { root: entry.root, key: entry.key, title: title ?? entry.key, ...inspected }
}

/** Runs the CLI for one folder, unless T3 Code lists it already, and waits for T3 Code to list it. */
async function add(context: AddProjectContext, input: AddProjectInput, plan: { root: string; key: string; title: string }): Promise<AddProjectResult> {
  const { root, key, title } = plan
  const failed = (why: string): AddProjectResult => ({ project: input.project, outcome: 'failed', key, root, why })
  const listed = async () => (await context.t3.listProjects()).find(project => (real(project.workspaceRoot) ?? resolve(project.workspaceRoot)) === root)
  try {
    // Added meanwhile, such as by the same name given twice in one call, or by the operator in T3 Code.
    const there = await listed()
    if (there) return { project: input.project, outcome: 'registered already', key, project_id: there.id, title: there.title ?? title, root }
    const problem = context.cli.problem()
    if (problem) return { project: input.project, outcome: 'refused', key, root, why: problem }
    let said: string, existed = false
    try { said = await context.cli.addProject(root, title) } catch (error) {
      // T3 Code has a project there already: added since the list above, by the operator or an earlier call that T3 Code did
      // not list in time. The CLI added nothing, so it is returned as registered already; anything else fails.
      said = message(error)
      existed = /already exists/i.test(said)
      if (!existed) return failed(said)
    }
    let project = await listed()
    const end = Date.now() + (context.listWaitMs ?? 10_000)
    while (!project && Date.now() < end) {
      await new Promise(done => setTimeout(done, 250))
      project = await listed()
    }
    if (!project) return failed(notListed(said, root))
    if (existed) return { project: input.project, outcome: 'registered already', key, project_id: project.id, title: project.title ?? title, root }
    return { project: input.project, outcome: 'added', key, project_id: project.id, title, root, manual_step: manualStep(title) }
  } catch (error) { return failed(message(error)) }
}

/** What git says of a folder now: not a checkout's top level, a linked worktree (its main checkout), or its state. */
async function inspect(root: string, env: NodeJS.ProcessEnv): Promise<Inspected> {
  const git = async (...args: string[]) => (await run('git', ['--no-optional-locks', '-C', root, ...args], { env, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 })).stdout.trim()
  let top: string, gitDir: string, common: string
  try {
    const lines = (await git('rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir')).split('\n')
    ;[top, gitDir, common] = lines.map(line => real(line) ?? line) as [string, string, string]
  } catch (error) {
    const said = (error as { stderr?: string }).stderr?.trim().split('\n')[0] ?? message(error)
    return { problem: `git cannot read ${root} as a checkout (${said}). superagent works only in git checkouts, and it does not run git init in a folder `
      + 'that exists: make it a git repository yourself if it should be one, then call again.' }
  }
  if (top !== root) return { problem: `${root} is inside the git checkout ${top}, not its top level; only a checkout's top level can be a project.` }
  if (gitDir !== common) {
    // A linked worktree: its git dir is one of the repository's worktrees. The first worktree git lists is the main one.
    const first = (await git('worktree', 'list', '--porcelain').catch(() => '')).split('\n').find(line => line.startsWith('worktree '))
    const main = first ? first.slice('worktree '.length) : common
    return { main: real(main) ?? main }
  }
  const changes = (await git('status', '--porcelain').catch(() => '')).split('\n').filter(Boolean).length
  const head = await git('rev-parse', '--verify', '-q', 'HEAD').then(() => true, () => false)
  return { changes, head }
}

/**
 * The refusal for a linked worktree, naming its main checkout and what to do with it: file the work in it when it is a ready
 * project, add it when it can be added, and otherwise say why neither takes work, such as a main checkout that is denied.
 */
function linkedWorktree(registry: ProjectRegistry, workspace: string, name: string, main: string): string {
  const owners = registry.list().filter(item => item.root === main)
  const owner = owners.find(item => item.status === 'ready') ?? owners[0]
  const denial = owner ? undefined : registry.denial(main)
  const next = owner?.id && owner.status === 'ready' ? `Its main checkout is the T3 Code project ${owner.key}: file the work there.`
    : owner && !owner.id && owner.status === 'not-registered' && within(main, workspace)
      ? `Add its main checkout instead: superagent_add_project with project ${owner.key}.`
      : owner ? `Its main checkout ${owner.id ? `is the T3 Code project ${owner.key}, which` : owner.key} is ${owner.status}: ${owner.reason ?? 'it cannot take work.'}`
        : denial ? `Its main checkout cannot be a project for work. ${denial}`
          : `Its main checkout is not in the catalogue: add ${main} to the catalogue, then add that with superagent_add_project.`
  return `${name} is a linked worktree of ${main}, not a project of its own. ${next}`
}

/** What a project's uncommitted changes mean for its tickets, by its base and its `dirty` setting. */
function dirtyWarning(entry: ProjectEntry, changes: number): string {
  const count = `${changes} uncommitted change${changes === 1 ? '' : 's'}`
  return `${entry.root} has ${count}. That does not stop it being a project: ticket worktrees start from the last commit of ${entry.baseRef}, and `
    + `when that is the branch checked out, ${entry.dirty === 'refuse' ? 'each ticket is refused while there are changes (projects.json sets dirty: refuse).'
      : 'each worker is told the changes are not in its worktree (dirty: warn; projects.json can set dirty: refuse).'}`
}

const real = (path: string): string | undefined => { try { return realpathSync.native(path) } catch { return undefined } }
const within = (path: string, dir: string): boolean => path === dir || path.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`)
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
