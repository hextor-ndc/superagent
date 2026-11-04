/**
 * `superagent_new_project`: starts a new project in the operator's catalogue (`SUPERAGENT_CATALOGUE`). It makes the folder
 * under the catalogue's workspace, a git repository on `main` with a README.md and a REPO_MAP.md stub in one commit, adds the
 * folder as a T3 Code project with the t3 CLI (the super agent's own token is refused `t3_project_create`), then adds the
 * entry to repositories.json and a row to the REPOSITORIES.md next to it, and reads the projects again.
 *
 * Everything that can be refused is refused before anything is written. Each step checks what is there before it acts, and
 * a job file in `<stateDir>/new-projects/` records the arguments, so a second call with the same arguments after a crash or
 * a failure part way finishes the job instead of failing on its own folder or adding anything twice.
 *
 * repositories.json and REPOSITORIES.md are shared with other tools and people: each is copied to
 * `<stateDir>/catalogue-backups/` first, read again right before the write, changed by one entry or row only, written to a
 * temporary file and renamed over the original, and only when it did not change since it was read. A file of an unexpected
 * shape is not written at all; the result says so.
 */
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { accessSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync,
  rmSync, statSync, writeFileSync, type Stats } from 'node:fs'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { T3Client } from '../t3/client.ts'
import { slug, type ProjectRegistry } from './projects.ts'
import { goodName, NAME_RULE, PART_WAY } from './folder-name.ts'

export { goodName, NAME_RULE, PART_WAY, SEGMENT } from './folder-name.ts'

const run = promisify(execFile)

/** What the operator gives `superagent_new_project`. */
export interface NewProjectInput {
  /** The folder, relative to the catalogue's workspace, such as `PERSONAL/garden`. */
  folder: string
  /** One sentence: what the project is for. It goes into the catalogue, the README and the index row. */
  purpose: string
  /** The T3 Code project's title; the folder's name by default. */
  title?: string
  /** How work or data moves through the project, for the catalogue's `flow`; a sentence saying nothing is built yet by default. */
  flow?: string
  notes?: string
  /** Catalogue paths of related projects. */
  related?: string[]
  /** A first request to file in the new project; filed by the console tool, and kept here so a repeated call can be compared. */
  request?: string
}

/** The t3 CLI that adds a folder as a T3 Code project (`t3 project add`), or a stand-in in tests. */
export interface T3Cli {
  /** Why it cannot run, such as a binary that is not there; undefined when it can. Asked before anything is written. */
  problem(): string | undefined
  /** Adds the folder as a project and returns what the CLI printed. Throws with the CLI's own message when it fails. */
  addProject(root: string, title: string): Promise<string>
}

/**
 * `t3 project add --title=<title> [--base-dir <dir>] <root>`. t3code 0.1.6 takes it while the server runs: the project is in
 * `t3_project_list` at once, and the CLI prints `Added project <id> (<title>) at <root>.`; a folder registered already, or
 * one that does not exist, exits 1 with the error on stdout (tests/live/two-projects.spec.ts). The title goes in the same
 * argument as `--title`: given separately, a title that starts with a dash is read as an option (`--help` prints the help
 * and exits 0, adding nothing). A run that does not print `Added project` fails with what it printed.
 */
export function t3Cli({ bin, baseDir }: { bin: string; baseDir?: string }): T3Cli {
  return {
    problem: () => executable(bin) ? undefined
      : `The T3 Code CLI ${bin} cannot be run here: set T3_BIN to the t3 binary, which superagent_new_project and superagent_add_project `
        + 'need to add a project.',
    async addProject(root, title) {
      const args = ['project', 'add', `--title=${title}`, ...baseDir ? ['--base-dir', baseDir] : [], root]
      let out: string
      try {
        out = (await run(bin, args, { timeout: 60_000, maxBuffer: 1024 * 1024 })).stdout.trim()
      } catch (error) {
        // The line that names an error (`ProjectAlreadyExistsError: ...`) before any other line with the word in it, such
        // as the help's `--log-level <...|error|...>`.
        const failure = error as { stdout?: string; stderr?: string; message?: string }
        const lines = `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`.split('\n')
        const said = (lines.find(line => /\w+Error:/.test(line)) ?? lines.find(line => /error/i.test(line)))?.replace(/^\[[^\]]*\]\s*/, '').trim()
        throw new Error(`t3 project add failed: ${said || failure.message || String(error)}`)
      }
      if (!/Added project /.test(out)) throw new Error(`t3 project add did not say it added the project; it printed: ${out.split('\n')[0] || 'nothing'}`)
      return out
    },
  }
}
/** Why a project the CLI added is not in T3 Code's list: the CLI wrote to another server's data directory. */
export const notListed = (said: string, root: string): string => `The t3 CLI said "${said.split('\n')[0]}", but T3 Code does not list ${root}: `
  + 'SUPERAGENT_T3_BASE_DIR must be the data directory of the t3code T3_MCP_URL names (T3 Code\'s default, ~/.t3, when it is not set).'
/** Whether `bin` is an executable path, or a name found on PATH. */
function executable(bin: string): boolean {
  const candidates = bin.includes('/') ? [bin] : (process.env.PATH ?? '').split(delimiter).filter(Boolean).map(dir => join(dir, bin))
  return candidates.some(candidate => { try { accessSync(candidate, constants.X_OK); return true } catch { return false } })
}

/** The steps of a job, in order; `NewProjectContext.beforeStep` is called with each. */
export const STEPS = ['mkdir', 'git-init', 'files', 'commit', 'register', 'catalogue', 'index', 'refresh'] as const
export type Step = typeof STEPS[number]

export interface NewProjectContext {
  /** `SUPERAGENT_CATALOGUE`; without it every call is refused. */
  catalogue?: string
  stateDir: string
  projects: ProjectRegistry
  t3: Pick<T3Client, 'listProjects'>
  cli: T3Cli
  /** The environment git runs with; `process.env` by default. Tests give git a config file of their own. */
  env?: NodeJS.ProcessEnv
  /** Called before each step. Tests make it throw to stop a job there; nothing else sets it. */
  beforeStep?: (step: Step) => void
  /** How long to wait for T3 Code to list a project the CLI added; 10 s by default. */
  listWaitMs?: number
  now?: () => Date
}

/** What a job made, as `superagent_new_project` returns it. */
export interface NewProjectResult {
  /** The project's key, as `superagent_request` takes it. */
  key: string
  status: string
  why?: string
  project_id: string
  title: string
  root: string
  head: string
  branch: 'main'
  /** `added`, `already there`, or `not changed: <why>`, for repositories.json and REPOSITORIES.md. */
  catalogue: string
  index: string
  /** What the catalogue's `scope` line now says, or why it was left as it is. */
  scope?: string
  /** The copies made before each write, in `<stateDir>/catalogue-backups/`. */
  backups: string[]
  /** What the operator still has to do in T3 Code. */
  manual_step: string
  /** The job file existed before this call: a repeated call, which finished or confirmed the job. */
  repeated?: true
  /**
   * The job's id, made when the job starts and kept in its job file: the console tool derives the first request's trigger id
   * from it, so a repeated call files it once, and a new job at the same folder, after the project was removed, files its own.
   */
  job: string
}

/** The job file: the arguments a job was started with, and whether it finished. */
interface JobFile {
  /** Random; a job file without one, from before it was kept, has the folder's hash as its id. */
  id?: string
  folder: string; input: Required<Omit<NewProjectInput, 'request'>> & { request: string | null }; started: string; done?: string; projectId?: string
}

/** The fields every git-repository entry of the catalogue gets, in the order the catalogue lists them. */
const ENTRY_FIELDS = ['path', 'purpose', 'flow', 'modules', 'notes', 'related', 'kind', 'checked_on', 'head', 'branch', 'had_local_changes', 'map',
  'manifests', 'existing_docs', 'readme_created', 'git_checked_on'] as const
/** Fields some entries have that a new project has nothing for (hashed source samples, later checks). */
const OPTIONAL_FIELDS = new Set(['source_evidence', 'subprojects', 'retrieval_optimization_update', 'hosted_production_check'])
/** What the operator still has to do in T3 Code for a project the super agent added: it cannot read or change these settings. */
export const manualStep = (title: string): string => `In T3 Code, open the settings of the project "${title}" and turn off PR watching and `
  + '"continue threads after server update". The super agent cannot read or change these settings.'
const DEFAULT_FLOW = 'New project: nothing is built yet.'

/**
 * Runs or finishes a job. Throws, having written nothing, when the call is refused; throws with the step's error and
 * `PART_WAY` when a step fails, and a second call with the same arguments then goes on from there.
 */
export async function newProject(context: NewProjectContext, given: NewProjectInput): Promise<NewProjectResult> {
  const plan = await prepare(context, given)
  try {
    return await carryOut(context, plan)
  } catch (error) {
    throw new Error(`${message(error)} ${PART_WAY}`, { cause: error })
  }
}

/** The steps of a job that `prepare` let through, each checking what is there before it acts. */
async function carryOut(context: NewProjectContext, plan: Plan): Promise<NewProjectResult> {
  const { abs, folder, input, jobPath } = plan
  const env = context.env ?? process.env
  const now = context.now ?? (() => new Date())
  const step = (name: Step) => context.beforeStep?.(name)
  const git = async (cwd: string, ...args: string[]) => (await run('git', ['-C', cwd, ...args], { env, timeout: 30_000 })).stdout.trim()

  const job: JobFile = plan.job ?? { id: randomBytes(8).toString('hex'), folder, input, started: now().toISOString() }
  writeAtomic(jobPath, `${JSON.stringify(job, null, 2)}\n`)

  step('mkdir')
  mkdirSync(abs, { recursive: true })
  step('git-init')
  if (!existsSync(join(abs, '.git'))) await run('git', ['init', '-q', '-b', 'main', abs], { env, timeout: 30_000 })
  const top = await git(abs, 'rev-parse', '--show-toplevel').then(path => real(path) ?? path, () => undefined)
  if (top !== abs) throw new Error(`${abs} is not the top of a git repository (git says ${top ?? 'none'}); fix or remove the folder, then call again.`)
  step('files')
  const today = day(now())
  if (!existsSync(join(abs, 'README.md'))) writeAtomic(join(abs, 'README.md'), readme(input))
  if (!existsSync(join(abs, 'REPO_MAP.md'))) writeAtomic(join(abs, 'REPO_MAP.md'), repoMap(input, folder, today, relative(abs, real(dirname(plan.catalogue)) ?? dirname(plan.catalogue))))
  step('commit')
  let head = await git(abs, 'rev-parse', '--verify', '-q', 'HEAD').catch(() => '')
  if (!head) {
    if (!await identity(abs, env)) throw new Error(noIdentity(folder))
    await git(abs, 'add', '--', 'README.md', 'REPO_MAP.md')
    await git(abs, 'commit', '-q', '-m', `Start ${folder}`, '-m', `${input.purpose}\n\nREADME.md and REPO_MAP.md, made by superagent_new_project.`)
    head = await git(abs, 'rev-parse', 'HEAD')
  }

  step('register')
  const listed = async () => (await context.t3.listProjects()).find(project => (real(project.workspaceRoot) ?? resolve(project.workspaceRoot)) === abs)
  let project = await listed()
  if (!project) {
    let said: string
    try { said = await context.cli.addProject(abs, input.title) } catch (error) {
      // A project added by an earlier call that T3 Code did not list in time is "already there" now; anything else stops here.
      said = message(error)
      if (!/already exists/i.test(said)) throw error
    }
    const end = Date.now() + (context.listWaitMs ?? 10_000)
    while (!(project = await listed()) && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 250))
    if (!project) throw new Error(notListed(said, abs))
  }
  job.projectId = project.id
  writeAtomic(jobPath, `${JSON.stringify(job, null, 2)}\n`)

  const backups: string[] = []
  const backupDir = join(context.stateDir, 'catalogue-backups')
  step('catalogue')
  const entry = catalogueEntry(input, folder, head, today)
  const catalogued = updateFile(plan.catalogue, backupDir, backups, raw => addEntry(raw, entry))
  step('index')
  const indexFile = join(dirname(plan.catalogue), 'REPOSITORIES.md')
  const indexed = existsSync(indexFile) ? updateFile(indexFile, backupDir, backups, raw => addRow(raw, folder, input.purpose))
    : { result: `not changed: there is no ${indexFile}` }

  step('refresh')
  // A read that runs now, such as the timer's, may have read T3 Code before the CLI added the project.
  await context.projects.reread()
  const made = context.projects.byId(project.id)
  job.done = now().toISOString()
  writeAtomic(jobPath, `${JSON.stringify(job, null, 2)}\n`)
  return {
    key: made?.key ?? folder, status: made?.status ?? 'not listed', ...made?.reason ? { why: made.reason } : {}, project_id: project.id,
    title: input.title, root: abs, head, branch: 'main', catalogue: catalogued.result, index: indexed.result,
    ...catalogued.scope ? { scope: catalogued.scope } : {}, backups, manual_step: manualStep(input.title),
    ...plan.job ? { repeated: true as const } : {}, job: job.id ?? plan.hash,
  }
}

interface Plan {
  /** The folder relative to the workspace as the disk names it, which the catalogue, the index and the job file get. */
  folder: string
  abs: string; catalogue: string; input: JobFile['input']; jobPath: string
  /** A hash of the folder's real path, which names its job file. */
  hash: string
  /** The job file of an earlier call with the same arguments, which this call finishes. */
  job?: JobFile
}

/** Every check that can refuse the call, before anything is written. */
async function prepare(context: NewProjectContext, given: NewProjectInput): Promise<Plan> {
  const catalogue = context.catalogue
  if (!catalogue) throw new Error('No catalogue is configured: set SUPERAGENT_CATALOGUE to the repositories.json new projects are added to.')
  const read = readCatalogue(catalogue)
  if ('problem' in read) throw new Error(`${catalogue} is not changed by superagent_new_project, so nothing was made: ${read.problem}`)
  const workspace = real(read.data.workspace)
  if (!workspace) throw new Error(`The catalogue's workspace ${read.data.workspace} does not exist.`)

  const typed = given.folder.trim().replace(/\/+$/, '')
  if (!typed || typed === '.') throw new Error('Name the new folder, relative to the catalogue\'s workspace, such as PERSONAL/garden.')
  if (isAbsolute(typed) || typed.startsWith('~')) throw new Error(`${typed} is not relative: give the folder relative to the workspace ${workspace}, such as PERSONAL/garden.`)
  const segments = typed.split('/')
  if (segments.some(part => part === '..' || part === '.')) throw new Error(`${typed} contains "." or "..": give the folder as a plain path inside the workspace.`)
  const bad = segments.find(part => !goodName(part))
  if (bad !== undefined) throw new Error(`"${bad}" cannot be a folder name here: ${NAME_RULE}`)

  // Each part of the path that exists, as it is on disk: a symlink is followed only to something that exists, and the new
  // folder itself is never one. Then the folder resolves inside the workspace: its nearest existing parent's real path, so a
  // symlink cannot lead outside.
  const wanted = join(workspace, ...segments)
  for (let index = 1; index <= segments.length; index++) {
    const part = join(workspace, ...segments.slice(0, index))
    const stat = lstatOf(part)
    if (!stat) break
    if (!stat.isSymbolicLink()) continue
    const shown = segments.slice(0, index).join('/')
    if (index === segments.length) throw new Error(`${shown} is a symlink; a new project needs a folder of its own.`)
    if (!existsSync(part)) throw new Error(`${shown} is a symlink to ${readlinkSync(part)}, which does not exist, so ${typed} cannot be made.`)
  }
  let existing = wanted
  while (!existsSync(existing)) existing = dirname(existing)
  const existingReal = real(existing) ?? existing
  if (!within(existingReal, workspace)) throw new Error(`${typed} resolves to ${existingReal}, outside the workspace ${workspace}.`)
  const abs = existing === wanted ? existingReal : join(existingReal, relative(existing, wanted))
  if (existing === wanted) {
    if (!statSync(abs).isDirectory()) throw new Error(`${wanted} exists and is not a folder.`)
  } else if (!statSync(existingReal).isDirectory()) throw new Error(`${existing} is a file, so ${typed} cannot be made.`)
  // The folder as the disk names it, which the catalogue, the index, the files and the job get: on a file system that ignores
  // case, personal/garden is PERSONAL/garden. A folder reached through a symlink in the workspace is refused, naming its own path.
  const folder = relative(workspace, abs).split(sep).join('/')
  if (folder.toLowerCase() !== typed.toLowerCase()) throw new Error(`${typed} is ${folder} through a symlink: call again with the folder ${folder}.`)

  const purpose = oneLine(given.purpose, 'purpose', 300)
  const title = given.title === undefined ? basename(folder) : oneLine(given.title, 'title', 100)
  const flow = given.flow === undefined ? DEFAULT_FLOW : oneLine(given.flow, 'flow', 500)
  const notes = given.notes?.trim() ?? ''
  const related = [...new Set((given.related ?? []).map(path => path.trim()).filter(Boolean))]
  const known = new Set(read.data.repositories.map(item => item.path))
  const unknown = related.filter(path => !known.has(path))
  if (unknown.length) throw new Error(`related names folders the catalogue does not list: ${unknown.join(', ')}. Use catalogue paths, as superagent_projects shows them.`)
  const input: JobFile['input'] = { folder, purpose, title, flow, notes, related, request: given.request?.trim() || null }

  const hash = createHash('sha256').update(abs).digest('hex').slice(0, 16)
  const jobPath = join(context.stateDir, 'new-projects', `${slug(folder)}-${hash.slice(0, 8)}.json`)
  const earlier = readJob(jobPath)
  const same = !!earlier && JSON.stringify(earlier.input) === JSON.stringify(input)
  if (earlier && !same && !earlier.done) {
    throw new Error(`A new project at ${folder} was started on ${earlier.started} with other arguments (${JSON.stringify(earlier.input)}). Call `
      + `superagent_new_project again with those to finish it, or delete ${jobPath} and the folder to start over.`)
  }
  const job = same ? earlier : undefined

  const denial = context.projects.denial(abs)
  if (denial) throw new Error(`${folder} cannot be a project for work. ${denial}`)
  const problem = context.cli.problem()
  if (problem) throw new Error(problem)
  if (!job) {
    // Paths that differ only in case are one folder on the operator's disk, whether or not that folder exists.
    const catalogued = read.data.repositories.find(item => item.path.toLowerCase() === folder.toLowerCase() || real(join(workspace, item.path)) === abs)
    if (catalogued) throw new Error(`${folder} is in the catalogue already, as ${catalogued.path}. superagent_projects shows whether it can take work.`)
    const registered = (await context.t3.listProjects()).find(project => (real(project.workspaceRoot) ?? resolve(project.workspaceRoot)) === abs)
    if (registered) throw new Error(`${abs} is a T3 Code project already (${registered.title ?? registered.id}). superagent_projects shows it.`)
    if (existing === wanted && readdirSync(abs).length) throw new Error(`${abs} exists and is not empty. A new project starts in a new or empty folder.`)
  }
  const env = context.env ?? process.env
  const top = await run('git', ['-C', existsSync(abs) ? abs : existingReal, 'rev-parse', '--show-toplevel'], { env, timeout: 30_000 })
    .then(result => real(result.stdout.trim()) ?? result.stdout.trim(), () => undefined)
  if (top && !(job && top === abs)) throw new Error(`${folder} would be inside the git checkout ${top}. Choose a folder outside it.`)
  if (!await identity(existsSync(abs) ? abs : existingReal, env)) throw new Error(noIdentity(folder))
  return { folder, abs, catalogue, input, hash, jobPath, ...job ? { job } : {} }
}

/** What the panel's New project form offers, as `superagent_new_project_options` returns it. */
export interface NewProjectOptions {
  /** Whether `superagent_new_project` can run at all: a catalogue is configured and it can be changed. */
  enabled: boolean
  /** Why it cannot, and how to change that; only when `enabled` is false. */
  why?: string
  enable?: string
  /** The catalogue's workspace (its real path), which a new project's folder is relative to. */
  workspace?: string
  /**
   * The top-level folders of the workspace the catalogue files projects under, that a new project may go in: on disk, not a
   * symlink, not catalogued themselves, not inside a git checkout, and not denied (`ARCHIVE/`, projects.json, ticket worktrees).
   */
  groups: string[]
  /** Whether a new project may go at the top of the workspace itself, by the same rules. */
  top_level: boolean
  /** The rule for the new folder's name; the tool checks it again. */
  name_rule: string
  /** Why every call would be refused for now (the t3 CLI cannot run, git has no identity), though the form is shown. */
  warning?: string
}

/**
 * What the panel's New project form needs, read only: whether new projects are enabled, the workspace, the folders a new
 * project can go in, and the folder name rule. `superagent_new_project` stays the authority: it checks everything again.
 */
export async function newProjectOptions(context: Pick<NewProjectContext, 'catalogue' | 'projects' | 'cli' | 'env'>): Promise<NewProjectOptions> {
  const name_rule = `A folder name must ${NAME_RULE}`
  const off = (why: string, enable: string): NewProjectOptions => ({ enabled: false, why, enable, groups: [], top_level: false, name_rule })
  const catalogue = context.catalogue
  if (!catalogue) {
    return off('No catalogue is configured, and new projects are added to it.', 'Set SUPERAGENT_CATALOGUE to the repositories.json that '
      + 'lists the folders on this machine, and start the super agent again.')
  }
  const read = readCatalogue(catalogue)
  if ('problem' in read) return off(`${catalogue} cannot be changed by superagent_new_project: ${read.problem}.`, 'Fix the file, then reload this page.')
  const workspace = real(read.data.workspace)
  if (!workspace) return off(`The catalogue's workspace ${read.data.workspace} does not exist.`, 'Fix "workspace" in the catalogue, then reload this page.')
  const env = context.env ?? process.env
  const inGit = (dir: string) => run('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { env, timeout: 10_000 }).then(() => true, () => false)
  const catalogued = new Set(read.data.repositories.map(item => item.path.toLowerCase()))
  const tops = [...new Set(read.data.repositories.flatMap(item => item.path.includes('/') ? [item.path.split('/')[0]!] : []))]
  let groups: string[]
  let topLevel: boolean
  try {
    const open = async (name: string) => {
      const abs = join(workspace, name)
      if (!goodName(name) || catalogued.has(name.toLowerCase()) || !lstatOf(abs)?.isDirectory()) return false
      return !context.projects.denial(abs) && !await inGit(abs)
    }
    groups = (await Promise.all(tops.map(async name => await open(name) ? [name] : []))).flat().sort(compare)
    topLevel = !context.projects.denial(workspace) && !await inGit(workspace)
  } catch (error) {
    // projects.json or the catalogue cannot be read by the registry, which refuses every call the same way.
    return off(message(error), 'Fix the file, then reload this page.')
  }
  const warning = context.cli.problem() ?? (await identity(workspace, env) ? undefined : noIdentity('a new project'))
  return { enabled: true, workspace, groups, top_level: topLevel, name_rule, ...warning ? { warning } : {} }
}

/** Whether git has a name and an email to commit with, from the operator's own git config. None is ever made up. */
async function identity(cwd: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const get = (key: string) => run('git', ['-C', cwd, 'config', '--get', key], { env, timeout: 10_000 }).then(result => result.stdout.trim(), () => '')
  return !!(await get('user.name') && await get('user.email'))
}
const noIdentity = (folder: string) => `git has no user.name and user.email to make the first commit of ${folder} with. Set them in your git config `
  + '(git config --global user.name "..." and user.email "..."), then call again.'

function oneLine(value: string, name: string, max: number): string {
  const text = value.trim()
  if (!text) throw new Error(`The ${name} is empty.`)
  if (/[\r\n]/.test(text)) throw new Error(`The ${name} must be one line.`)
  if (text.length > max) throw new Error(`The ${name} is longer than ${max} characters.`)
  return text
}

function readJob(path: string): JobFile | undefined {
  try { return JSON.parse(readFileSync(path, 'utf8')) as JobFile } catch { return undefined }
}

// The catalogue.

interface CatalogueData { workspace: string; scope?: unknown; repositories: ({ path: string; kind?: string } & Record<string, unknown>)[] }
type CatalogueRead = { raw: string; data: CatalogueData; indent: string; newline: boolean } | { problem: string }

/**
 * repositories.json as superagent_new_project may change it: an object with `workspace` and a `repositories` list of entries
 * with a `path`, whose git-repository entries all have only fields it can fill, and whose text is exactly what
 * `JSON.stringify` writes with the file's own indent, so a write changes nothing but the new entry.
 */
function readCatalogue(file: string): CatalogueRead {
  let raw: string
  try { raw = readFileSync(file, 'utf8') } catch (error) { return { problem: `it cannot be read: ${message(error)}` } }
  return parseCatalogue(raw)
}
function parseCatalogue(raw: string): CatalogueRead {
  let data: unknown
  try { data = JSON.parse(raw) } catch (error) { return { problem: `it is not JSON: ${message(error)}` } }
  const value = data as Partial<CatalogueData>
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.workspace !== 'string' || !Array.isArray(value.repositories)
    || value.repositories.some(item => !item || typeof item !== 'object' || typeof item.path !== 'string')) {
    return { problem: 'it is not an object with a "workspace" and a "repositories" list of entries with a "path"' }
  }
  const indent = /^\{\n([ \t]+)"/.exec(raw)?.[1] ?? '  '
  const newline = raw.endsWith('\n')
  if (`${JSON.stringify(data, null, indent)}${newline ? '\n' : ''}` !== raw) {
    return { problem: 'its text is not what JSON.stringify writes for it (spacing, escapes or line ends differ), so a write would change more than one entry' }
  }
  const git = value.repositories.filter(item => item.kind === 'git-repository')
  const common = git.length ? Object.keys(git[0]!).filter(key => git.every(item => key in item)) : []
  const unfilled = common.filter(key => !(ENTRY_FIELDS as readonly string[]).includes(key) && !OPTIONAL_FIELDS.has(key))
  if (unfilled.length) return { problem: `every git-repository entry has ${unfilled.join(', ')}, which a new project has no value for` }
  return { raw, data: value as CatalogueData, indent, newline }
}

function catalogueEntry(input: JobFile['input'], folder: string, head: string, today: string): { path: string } & Record<string, unknown> {
  const notes = input.notes || `Started on ${today} with superagent_new_project; no code yet.`
  const entry: Record<(typeof ENTRY_FIELDS)[number], unknown> = { path: folder, purpose: input.purpose, flow: input.flow, modules: [], notes,
    related: input.related, kind: 'git-repository', checked_on: today, head, branch: 'main', had_local_changes: false, map: `${folder}/REPO_MAP.md`,
    manifests: [], existing_docs: [], readme_created: true, git_checked_on: today }
  return { path: folder, ...Object.fromEntries(ENTRY_FIELDS.map(key => [key, entry[key]])) }
}

/** One change to a file's text: the new text, or undefined with the result when nothing is to be written. */
type Change = { text?: string; result: string; scope?: string }

/**
 * The entry added to the catalogue's text: in path order when the list is sorted (by code point, as it is), else at the end.
 * The `scope` line's counts go up by one when they match the list exactly; otherwise it is left as it is.
 */
export function addEntry(raw: string, entry: { path: string } & Record<string, unknown>): Change {
  const read = parseCatalogue(raw)
  if ('problem' in read) return { result: `not changed: ${read.problem}. Add the entry by hand: ${JSON.stringify(entry)}` }
  const list = read.data.repositories
  const path = entry.path
  if (list.some(item => item.path === path)) return { result: 'already there' }
  const sorted = list.every((item, index) => index === 0 || compare(list[index - 1]!.path, item.path) <= 0)
  const at = sorted ? list.findIndex(item => compare(item.path, path) > 0) : -1
  list.splice(at < 0 ? list.length : at, 0, entry)
  let scope: string
  const counted = typeof read.data.scope === 'string'
    ? /^(\d+) mapped entries: (\d+) Git repositories, (\d+) linked worktrees and (\d+) additional project or reference folders\.$/.exec(read.data.scope) : null
  const count = (kind: string) => list.filter(item => item.kind === kind).length
  if (counted && Number(counted[1]) === list.length - 1 && Number(counted[2]) === count('git-repository') - 1
    && Number(counted[3]) === count('git-worktree') && Number(counted[4]) === count('project-folder')) {
    read.data.scope = `${list.length} mapped entries: ${count('git-repository')} Git repositories, ${counted[3]} linked worktrees and ${counted[4]} `
      + 'additional project or reference folders.'
    scope = `updated: ${read.data.scope as string}`
  } else {
    scope = 'left as it is: its counts are not the list\'s own, or it has none, so they cannot be updated exactly'
  }
  return { text: `${JSON.stringify(read.data, null, read.indent)}${read.newline ? '\n' : ''}`, result: 'added', scope }
}

/**
 * The project's row in REPOSITORIES.md: in the "Repository and project catalog" section, in the table under the heading of
 * its top folder (`### PERSONAL`, `### LARA (retired ...)`; `### Top level` for a folder at the top), in path order when that
 * table is sorted, else at its end. A file without that section, heading or table is not changed.
 */
export function addRow(raw: string, folder: string, purpose: string): Change {
  const cell = (text: string) => text.replace(/\|/g, '\\|')
  const link = folder.split('/').map(part => encodeURI(part)).join('/')
  const row = `| [${folder}](${link}/REPO_MAP.md) | git-repository | ${cell(purpose)} | \`README.md\`: what the project is for; no modules yet |`
  const byHand = `Add this row by hand: ${row}`
  if (raw.includes('\r')) return { result: `not changed: it has Windows line ends. ${byHand}` }
  const lines = raw.split('\n')
  const start = lines.indexOf('## Repository and project catalog')
  if (start < 0) return { result: `not changed: it has no "## Repository and project catalog" section. ${byHand}` }
  const after = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  const end = after < 0 ? lines.length : after
  if (lines.slice(start, end).some(line => line.startsWith(`| [${folder}](`))) return { result: 'already there' }
  const top = folder.includes('/') ? folder.split('/')[0]! : undefined
  const heading = lines.findIndex((line, index) => index > start && index < end
    && (top ? line === `### ${top}` || line.startsWith(`### ${top} `) : line === '### Top level'))
  if (heading < 0) return { result: `not changed: the section has no "### ${top ?? 'Top level'}" heading. ${byHand}` }
  const next = lines.findIndex((line, index) => index > heading && (line.startsWith('### ') || line.startsWith('## ')))
  const stop = next < 0 || next > end ? end : next
  const header = lines.findIndex((line, index) => index > heading && index < stop && line.startsWith('| Project guide |'))
  if (header < 0 || !lines[header + 1]?.startsWith('|---')) return { result: `not changed: "### ${top ?? 'Top level'}" has no project table. ${byHand}` }
  let last = header + 1
  while (lines[last + 1]?.startsWith('| [')) last++
  const rows = lines.slice(header + 2, last + 1)
  const pathOf = (line: string) => /^\| \[([^\]]*)\]/.exec(line)?.[1] ?? ''
  const sorted = rows.every((line, index) => index === 0 || compare(pathOf(rows[index - 1]!), pathOf(line)) <= 0)
  const before = sorted ? rows.findIndex(line => compare(pathOf(line), folder) > 0) : -1
  lines.splice(before < 0 ? last + 1 : header + 2 + before, 0, row)
  return { text: lines.join('\n'), result: 'added' }
}

/**
 * Changes a shared file safely: a copy in `backupDir` first, then the file read again, changed, written to a temporary file
 * beside it and renamed over it, but only when it still holds what was read; otherwise it is read and changed again, up to
 * three times. Another writer's edit made in between is kept, since the change is made to the text read last. There is no
 * lock: an edit that lands in the instant between that last check and the rename is still lost.
 */
export function updateFile(file: string, backupDir: string, backups: string[], change: (raw: string) => Change): { result: string; scope?: string } {
  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = readFileSync(file, 'utf8')
    const next = change(raw)
    if (next.text === undefined) return next
    if (attempt === 0) {
      mkdirSync(backupDir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      let backup = join(backupDir, `${basename(file)}.${stamp}`)
      for (let n = 2; existsSync(backup); n++) backup = join(backupDir, `${basename(file)}.${stamp}-${n}`)
      copyFileSync(file, backup)
      backups.push(backup)
    }
    const temp = join(dirname(file), `.${basename(file)}.superagent-${process.pid}-${randomBytes(4).toString('hex')}.tmp`)
    writeFileSync(temp, next.text, { mode: statSync(file).mode & 0o777 })
    if (readFileSync(file, 'utf8') === raw) {
      renameSync(temp, file)
      return next
    }
    rmSync(temp, { force: true })
  }
  throw new Error(`${file} kept changing while superagent_new_project wrote to it; call again with the same arguments.`)
}

// The files in the new repository, in the shape of the catalogue's other README.md and REPO_MAP.md files.

function readme(input: JobFile['input']): string {
  return [`# ${basename(input.folder)}`, '', input.purpose, '', ...input.notes ? [input.notes, ''] : [],
    'Start with [REPO_MAP.md](REPO_MAP.md) for modules, related projects and how the catalogue entry is kept.', ''].join('\n')
}
function repoMap(input: JobFile['input'], folder: string, today: string, toCatalogue: string): string {
  const up = toCatalogue.split(sep).join('/') || '.'
  return [
    `# ${basename(folder)} — repository guide and code map`, '',
    input.purpose, '',
    `Started on **${today}** with superagent_new_project. Kind: **git-repository**.`,
    `Workspace path: \`${folder}\`.`,
    'Branch: `main`. The first commit holds this map and the README only.', '',
    '## What happens here', '', input.flow, '',
    '## Code map', '', '| Path | Responsibility |', '|---|---|', '| [README.md](README.md) | What the project is for |', '',
    '## Current scope and cautions', '', input.notes || 'New project: no code, build or modules yet.', '',
    ...input.related.length ? ['## Related projects', '', ...input.related.map(path => `- \`${path}\``), ''] : [],
    '## Finding and maintaining context', '',
    `- [Workspace repository index](${up}/REPOSITORIES.md) routes by function and distinguishes related checkouts.`,
    `- [Machine-readable catalog](${up}/repositories.json) records modules, manifests and source evidence.`,
    '- When entry points, module boundaries or operational scope change, update this guide and the corresponding catalog/index entry together.',
    '',
  ].join('\n')
}

/** Writes a file whole or not at all: a temporary file beside it, renamed over it. */
function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`)
  writeFileSync(temp, text)
  renameSync(temp, path)
}

/** The local date as YYYY-MM-DD, as the catalogue writes its dates. */
const day = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0
const real = (path: string): string | undefined => { try { return realpathSync.native(path) } catch { return undefined } }
const lstatOf = (path: string): Stats | undefined => { try { return lstatSync(path) } catch { return undefined } }
const within = (path: string, dir: string): boolean => path === dir || path.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`)
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
