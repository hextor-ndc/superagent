/**
 * The projects the super agent knows of (docs/multi-project-plan.md, 3.1): every T3 Code project, joined with the operator's
 * catalogue of the folders on this machine (`SUPERAGENT_CATALOGUE`, a repositories.json) and the overrides in
 * `<stateDir>/projects.json`, and checked against git. T3 Code's project list is the only source of projects work can go
 * to; the catalogue only describes them, and its git facts are historical, so git is asked again at every refresh.
 *
 * Reads are synchronous, from the last good refresh, because two of the later callers are (the Router's `tool.run` and the
 * Engine's `prepareTicket`, inside its transaction). A refresh runs outside any transaction; a failed one keeps the last good
 * list and reports the `projects` part as failing.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { Trigger } from '../../vendor/dsh/src/core/index.ts'
import { CONSOLE } from './console-source.ts'
import type { LegacyProject } from '../config.ts'
import type { ProjectSummary, T3Client } from '../t3/client.ts'
import type { Health } from './health.ts'

const run = promisify(execFile)

/**
 * Who may send work to a project. `deny` never routes. `named` and `work` differ only once the Router may choose a project
 * itself (phase 3b): a project the console agent names counts as named.
 */
export type Access = 'work' | 'named' | 'deny'
/** `pr`: push and open a pull request, only for the project `SUPERAGENT_REPOSITORY` maps to; `branch`: commit on the ticket branch only. */
export type Delivery = 'pr' | 'branch'
/**
 * - `ready`: registered in T3 Code, a git checkout whose top level is the root, not denied;
 * - `not-registered`: catalogued only; T3 Code has no project for it;
 * - `no-git`: not a git checkout, or the root is not the checkout's top level;
 * - `denied`: by projects.json, by a default prefix (`ARCHIVE/`, `PERSONAL/`, `FAMILY/`), or because it is a folder of the super agent's own worktrees;
 * - `missing-checkout`: the folder no longer exists;
 * - `ambiguous`: one of several T3 Code projects with the same folder, and not the one projects.json names;
 * - `folded`: a linked worktree registered as a project of its own while its main checkout is registered too. t3code
 *   accepts either one's worktrees under the other's id (phase 0, probe 3), so work for the repository goes to the main checkout.
 */
export type ProjectStatus = 'ready' | 'not-registered' | 'no-git' | 'denied' | 'missing-checkout' | 'ambiguous' | 'folded'
export const STATUSES: readonly ProjectStatus[] = ['ready', 'not-registered', 'no-git', 'denied', 'missing-checkout', 'ambiguous', 'folded']

/** What the catalogue says about a project. Only `path`, `purpose`, `notes`, `kind`, `related`, `modules` and `map` are read. */
export interface CatalogueFacts {
  path: string; kind?: string; purpose?: string; notes?: string; related: string[]; map?: string
  /** The catalogue's module paths (its modules carry a path and a responsibility, no name). */
  modules: string[]
}

export interface ProjectEntry {
  /** The T3 Code project id; absent for a folder that is only catalogued. */
  id?: string
  /** How the console names the project: its catalogue path, or its T3 Code title when it is not catalogued. Unique. */
  key: string
  title: string
  aliases: string[]
  /** The checkout's real path (symlinks followed); the path as given when it does not exist. */
  root: string
  /** The repository's common git dir, shared by all its worktrees. */
  commonDir?: string
  /** `origin/HEAD`'s branch when it exists locally, else local `main`, else `master`. */
  defaultBranch?: string
  /** Where this project's ticket worktrees go: `<stateDir>/worktrees/<slug>` (D13); the legacy project keeps its own. */
  worktreeRoot: string
  /** What new worktrees start from: the default branch (D14); the legacy project keeps `SUPERAGENT_BASE_REF` or `HEAD`. */
  baseRef: string
  delivery: Delivery
  repository?: string
  access: Access
  /** What to do when the base is the branch checked out and the checkout has uncommitted changes (from phase 2). */
  dirty: 'warn' | 'refuse'
  status: ProjectStatus
  /**
   * Why the project is not ready, in a sentence the console can show. A ready project has none, except a legacy project
   * registered at a folder inside its checkout, which says so.
   */
  reason?: string
  /** The project `SUPERAGENT_PROJECT_ROOT` or `SUPERAGENT_PROJECT_ID` names. */
  legacy: boolean
  /** Whether its catalogue purpose and notes may go to model APIs; off under `PERSONAL/` and `FAMILY/` until projects.json allows it. */
  describe: boolean
  /** Its own catalogue entry, or, when it has none, the catalogued folder it sits in; nothing is copied from that one. */
  catalogue?: CatalogueFacts | { insideCatalogued: string }
  /** Catalogued linked worktrees and registered folded projects of this checkout (D10), by key. */
  worktrees: string[]
}

export type Resolved = { found: ProjectEntry } | { found?: undefined; suggestions: string[] }

/**
 * Who chose a ticket's project (plan, 3.2): the operator named it (`operator`), the GitHub mapping did (`github`), the Router
 * chose it (`router`, phase 3b), a follow-up carried it over (`inherited`), or the bind-time default picked it (`legacy`: the
 * legacy project; `single`: the one ready project when there is no legacy project; D21).
 */
export type BoundBy = 'operator' | 'github' | 'router' | 'inherited' | 'legacy' | 'single'

/**
 * kv `ticket-project:<ticketId>`: the project a ticket was accepted into, as the registry had it at that moment. It is a
 * snapshot, so a later change in T3 Code, the catalogue or projects.json never moves a ticket, and every launch, retry,
 * restart and resume reads its project from here and nowhere else (D3). `kv.list` returns values only, so it carries its
 * ticket id.
 */
export interface ProjectBinding {
  ticketId: string
  /** The T3 Code project id the worker's thread launches under. */
  projectId: string
  key: string
  title: string
  /** The checkout's real path, where git runs and worktrees are made from. */
  root: string
  /** The repository's common git dir at bind time; a checkout whose common dir differs later is another repository. */
  commonDir?: string
  /** The project's default branch at bind time, which the review list checks merges into. */
  defaultBranch?: string
  /** The folder the ticket's worktree is in. A ticket from before bindings were kept has the folder its worktree is in already. */
  worktreeRoot: string
  baseRef: string
  delivery: Delivery
  repository?: string
  dirty: 'warn' | 'refuse'
  by: BoundBy
  at: string
}
export const BINDING_PREFIX = 'ticket-project:'
export const bindingKey = (ticketId: string): string => `${BINDING_PREFIX}${ticketId}`

/** The binding of a ticket to a registered project; `worktreeRoot` replaces the project's own, as the migration needs. */
export function bindingOf(entry: ProjectEntry, ticketId: string, by: BoundBy, at: string, worktreeRoot = entry.worktreeRoot): ProjectBinding {
  if (!entry.id) throw new Error(`${entry.key} is not a T3 Code project.`)
  return { ticketId, projectId: entry.id, key: entry.key, title: entry.title, root: entry.root, ...entry.commonDir ? { commonDir: entry.commonDir } : {},
    ...entry.defaultBranch ? { defaultBranch: entry.defaultBranch } : {}, worktreeRoot, baseRef: entry.baseRef, delivery: entry.delivery,
    ...entry.repository ? { repository: entry.repository } : {}, dirty: entry.dirty, by, at }
}

/**
 * A project hint a Trigger carries in `meta` (D6): `meta.project` with `meta.projectBy`. `operator` (set by
 * `superagent_request`) and `source` (the GitHub mapping) are explicit; `inherited` (copied to a follow-up) is not. `meta` is
 * untrusted, so anything else is no hint.
 */
export function projectHint(trigger: Pick<Trigger, 'meta'>): { project: string; by: 'operator' | 'source' | 'inherited' } | undefined {
  const { project, projectBy } = trigger.meta
  if (typeof project !== 'string' || !project.trim()) return undefined
  return projectBy === 'operator' || projectBy === 'source' || projectBy === 'inherited' ? { project: project.trim(), by: projectBy } : undefined
}

/**
 * Whether a Trigger is a console request stored before the migration to per-ticket projects (D19): it has no `meta.project`
 * and its `at` is before `schema:projects.migratedAt`. Every such request was made for the project workers used then, the
 * legacy project, so it counts as an inherited hint for it.
 */
export function preUpgrade(trigger: Pick<Trigger, 'meta'> & Partial<Pick<Trigger, 'source' | 'at'>>, migratedAt: string | undefined): boolean {
  return !!migratedAt && trigger.source === CONSOLE && trigger.meta.project === undefined && !!trigger.at && trigger.at < migratedAt
}

/**
 * Which project an accept goes to, by the rules of plan 3.2, in order: an explicit hint on the request's Triggers; a Router
 * choice (not allowed before phase 3b, so any is refused); an inherited hint, which a console request from before the
 * migration is for the legacy project (D19); the bind-time default (D21). The project must be ready and not denied. Throws
 * with the reason otherwise, which rolls the accept back when called in `prepareTicket`. Pure: it reads the registry's last
 * good list and writes nothing.
 *
 * @param triggers - the accept's Triggers, its origin first.
 * @param choice - the Router's `audit.project`, if the accept carries one.
 * @param migratedAt - `schema:projects.migratedAt`, when the migration ran.
 */
export function resolveProject(registry: ProjectRegistry, { triggers, choice, migratedAt }:
  { triggers: (Pick<Trigger, 'meta'> & Partial<Pick<Trigger, 'source' | 'at'>>)[]; choice?: unknown; migratedAt?: string }):
  { entry: ProjectEntry; by: BoundBy } {
  const hints = triggers.flatMap(trigger => projectHint(trigger) ?? [])
  const explicit = [...new Map(hints.filter(hint => hint.by !== 'inherited').map(hint => [hint.project, hint])).values()]
  if (explicit.length > 1) {
    throw new Error(`The request's messages name different projects (${explicit.map(hint => hint.project).join(', ')}): file one request per project.`)
  }
  if (choice !== undefined && choice !== null) {
    const named = explicit[0]?.project
    if (named !== undefined && named !== choice) throw new Error(`The request named ${named}, and the route chose ${String(choice)}.`)
    throw new Error('A Router choice of project is not enabled: the request must name its project, or go to the default one.')
  }
  const hint = explicit[0] ?? hints.find(item => item.by === 'inherited')
  let entry: ProjectEntry, by: BoundBy
  if (!hint && triggers.some(trigger => preUpgrade(trigger, migratedAt))) {
    // Not the D21 default: with no legacy project the one ready project may be another folder than the one it was made for.
    const legacy = registry.configuredLegacy()
    if (!legacy) {
      throw new Error(registry.legacyProblem() ?? 'This request was made before the super agent kept a project per ticket, so it was for the '
        + 'project workers used then, and no such project is set now. Set SUPERAGENT_PROJECT_ROOT to that project and request the work again.')
    }
    entry = legacy; by = 'inherited'
  } else if (hint) {
    const resolved = registry.resolve(hint.project)
    if (!resolved.found) {
      throw new Error(`No project ${hint.project} in T3 Code${resolved.suggestions.length ? `; did you mean ${resolved.suggestions.join(', ')}?` : '.'}`)
    }
    entry = resolved.found
    by = hint.by === 'operator' ? 'operator' : hint.by === 'source' ? 'github' : 'inherited'
  } else if (registry.hasLegacy()) {
    const legacy = registry.configuredLegacy()
    if (!legacy) throw new Error(registry.legacyProblem() ?? 'The project SUPERAGENT_PROJECT_ROOT names is not in T3 Code.')
    entry = legacy; by = 'legacy'
  } else {
    const ready = registry.ready()
    if (ready.length !== 1) {
      throw new Error(`An accept needs a project, and none is the default: no legacy project is set and ${ready.length} project`
        + `${ready.length === 1 ? ' is' : 's are'} ready${ready.length ? ` (${ready.map(item => item.key).join(', ')})` : ''}. `
        + 'Multi-project routing is not enabled yet: set SUPERAGENT_PROJECT_ROOT to the project unnamed requests go to.')
    }
    entry = ready[0]!; by = 'single'
  }
  if (entry.status !== 'ready') throw new Error(`Project ${entry.key} is ${entry.status}: ${entry.reason ?? 'it cannot take work.'}`)
  if (entry.access === 'deny' || !entry.id) throw new Error(`Project ${entry.key} is denied: it never takes work.`)
  return { entry, by }
}

const OverrideSchema = z.object({
  access: z.enum(['work', 'named', 'deny']).optional(),
  aliases: z.array(z.string().trim().min(1)).optional(),
  delivery: z.enum(['pr', 'branch']).optional(),
  baseRef: z.string().trim().min(1).optional(),
  worktreeRoot: z.string().trim().min(1).refine(isAbsolute, 'must be an absolute path').optional(),
  dirty: z.enum(['warn', 'refuse']).optional(),
  describe: z.boolean().optional(),
}).strict()
export type ProjectOverride = z.infer<typeof OverrideSchema>
/**
 * projects.json: overrides by key. A key is a T3 Code project id, an absolute path, a catalogue path, or a prefix ending in
 * `/` (absolute, or relative to the catalogue's workspace). Relative keys need a catalogue.
 */
export const OverridesSchema = z.record(z.string().trim().min(1), OverrideSchema)

const CatalogueSchema = z.object({
  workspace: z.string().min(1),
  repositories: z.array(z.object({
    path: z.string().min(1),
    purpose: z.string().nullish(), notes: z.string().nullish(), kind: z.string().nullish(), map: z.string().nullish(),
    related: z.array(z.string()).nullish(),
    modules: z.array(z.object({ path: z.string().nullish(), name: z.string().nullish() })).nullish(),
  })),
})

/**
 * The defaults the operator accepted (plan, open question 2): `ARCHIVE/` is denied; `PERSONAL/` and `FAMILY/` are denied and
 * shown by key only. A projects.json entry with the same key replaces a default, and a more specific one overrides it; a
 * broader prefix in projects.json, such as the whole workspace, does not.
 */
const DEFAULT_OVERRIDES: Record<string, ProjectOverride> = {
  'ARCHIVE/': { access: 'deny' },
  'PERSONAL/': { access: 'deny', describe: false },
  'FAMILY/': { access: 'deny', describe: false },
}

export interface ProjectRegistryOptions {
  t3: Pick<T3Client, 'listProjects'>
  stateDir: string
  legacy?: LegacyProject
  /** A repositories.json; re-read when its modification time changes. */
  catalogue?: string
  /** projects.json; optional. Re-read when its modification time changes. */
  projectsFile?: string
  log?: (message: string, error?: unknown) => void
}

/** How often the list is read again; also on `superagent_projects({ refresh: true })`. */
export const REFRESH_MS = 5 * 60_000

interface Catalogued extends CatalogueFacts { abs: string; exists: boolean }
interface Catalogue { workspace: string; entries: Catalogued[] }
interface Rule { kind: 'id' | 'path' | 'prefix'; key: string; target: string; override: ProjectOverride; rank: number; fromFile: boolean }
interface GitFacts { toplevel: string; commonDir: string; defaultBranch?: string }

export class ProjectRegistry {
  private entries: ProjectEntry[] = []
  private refreshedAt?: string
  private lastError?: string
  private problem?: string
  private inflight?: Promise<ProjectEntry[]>
  private timer?: NodeJS.Timeout
  private health?: Health
  private catalogueRead?: { stamp: string; value: Catalogue }
  private overridesRead?: { stamp: string; value: Record<string, ProjectOverride> }

  private constructor(private readonly options?: ProjectRegistryOptions) {}

  /** Reads T3 Code's projects, the catalogue and projects.json once; throws when that fails, as the start cannot go on without it. */
  static async load(options: ProjectRegistryOptions): Promise<ProjectRegistry> {
    const registry = new ProjectRegistry(options)
    await registry.refresh()
    return registry
  }

  /**
   * One legacy project, ready, without reading T3 Code, git or any file: for tests and for callers that already know the
   * project. Its worktree root defaults to `<root>/../<name>-superagent`, as `SUPERAGENT_WORKTREE_ROOT` does.
   */
  static single(project: { id: string; root: string; title?: string; worktreeRoot?: string; baseRef?: string; repository?: string }): ProjectRegistry {
    const registry = new ProjectRegistry()
    registry.entries = [{ id: project.id, key: project.title ?? basename(project.root), title: project.title ?? basename(project.root), aliases: [],
      root: project.root, worktreeRoot: project.worktreeRoot ?? join(dirname(project.root), `${basename(project.root)}-superagent`),
      baseRef: project.baseRef ?? 'HEAD', delivery: project.repository ? 'pr' : 'branch', ...project.repository ? { repository: project.repository } : {},
      access: 'work', dirty: 'warn', status: 'ready', legacy: true, describe: true, worktrees: [] }]
    registry.refreshedAt = new Date().toISOString()
    return registry
  }

  /** Every project, ready ones first. */
  list(): ProjectEntry[] { return this.entries }
  ready(): ProjectEntry[] { return this.entries.filter(entry => entry.status === 'ready') }
  /** The legacy project when it is ready: where unnamed requests go (D21). */
  legacy(): ProjectEntry | undefined { return this.entries.find(entry => entry.legacy && entry.status === 'ready') }
  /** The legacy project whatever its status; undefined when none is configured or it did not resolve (see `legacyProblem`). */
  configuredLegacy(): ProjectEntry | undefined { return this.entries.find(entry => entry.legacy) }
  /** Whether `SUPERAGENT_PROJECT_ROOT` or `SUPERAGENT_PROJECT_ID` names a project, resolved or not. */
  hasLegacy(): boolean { return !!this.options?.legacy || this.entries.some(entry => entry.legacy) }
  /** The T3 Code project with this id, as the last good refresh saw it. */
  byId(id: string): ProjectEntry | undefined { return this.entries.find(entry => entry.id === id) }
  /** Why the configured legacy project is not usable; undefined when none is configured or it is ready. */
  legacyProblem(): string | undefined { return this.problem }
  /** When the list was last read, and the error of the last refresh when it failed. */
  state(): { refreshedAt?: string; error?: string } {
    return { ...this.refreshedAt ? { refreshedAt: this.refreshedAt } : {}, ...this.lastError ? { error: this.lastError } : {} }
  }
  /** Counts by status, such as "2 ready, 3 no-git, 108 not-registered, 2 denied". */
  summary(): string {
    const counts = STATUSES.map(status => [status, this.entries.filter(entry => entry.status === status).length] as const).filter(([, count]) => count)
    return counts.length ? counts.map(([status, count]) => `${count} ${status}`).join(', ') : 'no projects'
  }

  /**
   * The project a name means, in this order: T3 Code id, key, alias, a title only one project has (case ignored), catalogue
   * path (a folded catalogue worktree means its checkout), absolute path (symlinks followed). Anything else is unknown, with
   * up to five suggestions; a near match is never picked.
   */
  resolve(hint: string): Resolved {
    const wanted = hint.trim()
    const lower = wanted.toLowerCase()
    const unique = (found: ProjectEntry[]) => found.length === 1 ? found[0] : undefined
    const found = this.entries.find(entry => entry.id === wanted) ?? this.entries.find(entry => entry.key === wanted)
      ?? unique(this.entries.filter(entry => entry.aliases.some(alias => alias.toLowerCase() === lower)))
      ?? unique(this.entries.filter(entry => entry.title.toLowerCase() === lower))
      ?? this.entries.find(entry => entry.catalogue && 'path' in entry.catalogue && entry.catalogue.path === wanted)
      ?? this.entries.find(entry => entry.worktrees.includes(wanted) && entry.status !== 'folded')
      ?? (isAbsolute(wanted) ? this.entries.find(entry => entry.root === (real(wanted) ?? resolve(wanted))) : undefined)
    if (found) return { found }
    return { suggestions: this.suggest(lower) }
  }
  private suggest(lower: string): string[] {
    if (!lower) return []
    const words = lower.split(/[^a-z0-9]+/).filter(word => word.length > 1)
    const score = (entry: ProjectEntry) => {
      const names = [entry.key, entry.title, ...entry.aliases, basename(entry.root)].map(name => name.toLowerCase())
      if (names.some(name => name.includes(lower) || (lower.includes(name) && name.length > 2))) return 2
      return words.some(word => names.some(name => name.includes(word))) ? 1 : 0
    }
    return this.entries.map(entry => ({ entry, score: score(entry) })).filter(item => item.score)
      .sort((a, b) => b.score - a.score || Number(b.entry.status === 'ready') - Number(a.entry.status === 'ready'))
      .slice(0, 5).map(item => item.entry.key)
  }

  /** Reports refreshes to the Watchdog's health entries under `projects`. */
  reportTo(health: Health): void { this.health = health }
  /** Refreshes on a timer until `stop`. A registry from `single` has nothing to refresh. */
  start(everyMs = REFRESH_MS): void {
    if (!this.options) return
    clearInterval(this.timer)
    this.timer = setInterval(() => { void this.refresh().catch(() => {}) }, everyMs)
    this.timer.unref?.()
  }
  stop(): void { clearInterval(this.timer) }
  /**
   * Refreshes when the last good list is older than `maxAgeMs`, as before a new worker thread launches (plan, 3.3). Throws
   * when that refresh fails, such as when t3code cannot be reached.
   */
  async fresh(maxAgeMs: number): Promise<void> {
    if (!this.options) return
    if (this.refreshedAt && Date.now() - Date.parse(this.refreshedAt) < maxAgeMs) return
    await this.refresh()
  }

  /** Reads everything again. A failure keeps the last good list, marks `projects` failing, and is thrown to the caller. */
  refresh(): Promise<ProjectEntry[]> {
    const options = this.options
    if (!options) return Promise.resolve(this.entries)
    this.inflight ??= this.build(options).then(({ entries, problem }) => {
      this.entries = entries
      this.problem = problem
      this.refreshedAt = new Date().toISOString()
      this.lastError = undefined
      this.health?.recovered('projects')
      return entries
    }, (error: unknown) => {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.health?.fail('projects', error)
      // At the start there is no list yet, and the caller stops; later the last good list stays.
      if (this.refreshedAt) options.log?.('reading the projects failed; the last list stays', error)
      throw error
    }).finally(() => { this.inflight = undefined })
    return this.inflight
  }

  private async build(options: ProjectRegistryOptions): Promise<{ entries: ProjectEntry[]; problem?: string }> {
    const catalogue = options.catalogue ? this.readCatalogue(options.catalogue) : undefined
    const overrides = options.projectsFile ? this.readOverrides(options.projectsFile) : {}
    const listed = await options.t3.listProjects()
    return assemble({ listed, catalogue, overrides, stateDir: options.stateDir, legacy: options.legacy, log: options.log })
  }

  private readCatalogue(path: string): Catalogue {
    const stamp = fileStamp(path)
    if (!stamp) throw new Error(`The catalogue ${path} (SUPERAGENT_CATALOGUE) does not exist.`)
    if (this.catalogueRead?.stamp === stamp) return this.catalogueRead.value
    let json: unknown
    try { json = JSON.parse(readFileSync(path, 'utf8')) } catch (error) { throw new Error(`The catalogue ${path} is not JSON: ${message(error)}`) }
    const parsed = CatalogueSchema.safeParse(json)
    if (!parsed.success) throw new Error(`The catalogue ${path} is not a repositories.json: ${issues(parsed.error)}`)
    const workspace = real(parsed.data.workspace) ?? resolve(parsed.data.workspace)
    const entries = parsed.data.repositories.map(item => {
      const abs = join(workspace, item.path)
      const resolved = real(abs)
      return { path: item.path, abs: resolved ?? abs, exists: !!resolved, ...item.kind ? { kind: item.kind } : {},
        ...item.purpose ? { purpose: item.purpose } : {}, ...item.notes ? { notes: item.notes } : {}, ...item.map ? { map: item.map } : {},
        related: item.related ?? [], modules: (item.modules ?? []).flatMap(module => module.path ?? module.name ?? []) }
    })
    this.catalogueRead = { stamp, value: { workspace, entries } }
    return this.catalogueRead.value
  }
  private readOverrides(path: string): Record<string, ProjectOverride> {
    const stamp = fileStamp(path)
    if (!stamp) return {}
    if (this.overridesRead?.stamp === stamp) return this.overridesRead.value
    let json: unknown
    try { json = JSON.parse(readFileSync(path, 'utf8')) } catch (error) { throw new Error(`${path} is not JSON: ${message(error)}`) }
    const parsed = OverridesSchema.safeParse(json)
    if (!parsed.success) throw new Error(`${path} is not valid: ${issues(parsed.error)}. See README.md, "Projects".`)
    this.overridesRead = { stamp, value: parsed.data }
    return parsed.data
  }
}

interface AssembleInput {
  listed: ProjectSummary[]
  catalogue?: Catalogue
  overrides: Record<string, ProjectOverride>
  stateDir: string
  legacy?: LegacyProject
  log?: (message: string, error?: unknown) => void
}
interface Draft {
  project: ProjectSummary; given: string; root: string; exists: boolean; legacy: boolean
  override: ProjectOverride; deniedBy?: string; status?: ProjectStatus; reason?: string; git?: GitFacts
}

/** Joins T3 Code's list with the catalogue, the overrides and git, as the plan's join rule says. */
async function assemble(input: AssembleInput): Promise<{ entries: ProjectEntry[]; problem?: string }> {
  const { catalogue, stateDir } = input
  const rules = overrideRules(input.overrides, catalogue?.workspace, new Set(input.listed.map(project => project.id)), input.log)
  const drafts: Draft[] = input.listed.map(project => {
    const given = resolve(project.workspaceRoot)
    const root = real(given)
    return { project, given, root: root ?? given, exists: !!root, legacy: false, override: {} }
  })

  // The legacy project: by id when given, else by its root. Of two projects on that root, the one registered under the
  // path SUPERAGENT_PROJECT_ROOT gives is taken, as before; otherwise it is left unresolved, not guessed. An id whose
  // project is another folder than SUPERAGENT_PROJECT_ROOT is refused: git would run in one and t3code launch in the other.
  let problem: string | undefined
  const legacy = input.legacy
  if (legacy) {
    const legacyRoot = legacy.root ? real(legacy.root) ?? legacy.root : undefined
    const byRoot = legacyRoot ? drafts.filter(draft => draft.root === legacyRoot) : []
    const asGiven = byRoot.filter(draft => draft.given === legacy.root)
    const chosen = legacy.id ? drafts.find(draft => draft.project.id === legacy.id)
      : byRoot.length === 1 ? byRoot[0] : asGiven.length === 1 ? asGiven[0] : undefined
    if (chosen && legacyRoot && chosen.root !== legacyRoot) {
      problem = `SUPERAGENT_PROJECT_ID ${legacy.id} is the T3 Code project at ${chosen.root}, but SUPERAGENT_PROJECT_ROOT is ${legacy.root}: `
        + 'set them to the same project, or set only one.'
    } else if (chosen) chosen.legacy = true
    else if (byRoot.length > 1) problem = `${byRoot.length} T3 Code projects have the folder ${legacy.root} (${byRoot.map(draft => draft.project.id).join(', ')}): set SUPERAGENT_PROJECT_ID to the one workers use.`
    else problem = `No T3 Code project ${legacy.id ?? `at ${legacy.root}`}. Add the folder as a project in T3 Code first.`
  }
  const legacyDraft = drafts.find(draft => draft.legacy)
  const legacyWorktrees = legacy?.worktreeRoot ?? (legacyDraft ? join(dirname(legacyDraft.given), `${basename(legacyDraft.given)}-superagent`) : undefined)

  // Folders of the super agent's own worktrees are never projects (D13): the legacy worktree root, <stateDir>/worktrees,
  // projects.json's worktree roots, and the old default layout `<root>-superagent/<ticket>`: a folder named `*-superagent`
  // or one directly inside it. A `-superagent` folder further up, such as a temp dir, says nothing about the project.
  const worktreeRoots = [legacyWorktrees, join(stateDir, 'worktrees'), ...rules.flatMap(rule => rule.override.worktreeRoot ?? [])]
    .filter((path): path is string => !!path).map(path => real(path) ?? resolve(path))
  const excluded = (path: string): string | undefined => {
    const inside = worktreeRoots.find(dir => within(path, dir))
    if (inside) return `inside ${inside}, where the super agent keeps ticket worktrees`
    return [basename(path), basename(dirname(path))].some(name => name.endsWith('-superagent'))
      ? 'a "-superagent" folder, where the super agent keeps ticket worktrees' : undefined
  }

  for (const draft of drafts) {
    const matched = rules.filter(rule => matches(rule, draft.project.id, draft.root)).sort(bySpecificity)
    // The legacy project works whatever a prefix says; only an override for it by id or path can deny it.
    for (const rule of draft.legacy ? matched.filter(item => item.kind !== 'prefix') : matched) {
      draft.override = { ...draft.override, ...rule.override }
      if (rule.override.access) draft.deniedBy = rule.override.access === 'deny' ? rule.key : undefined
    }
    if (!draft.exists) {
      draft.status = 'missing-checkout'; draft.reason = `${draft.given} no longer exists; remove the project in T3 Code or restore the folder.`
    } else if (!draft.legacy && excluded(draft.root)) {
      draft.status = 'denied'; draft.reason = `${excluded(draft.root)}; never a project for work.`
    } else if (draft.override.access === 'deny') {
      draft.status = 'denied'
      draft.reason = `Denied by ${input.overrides[draft.deniedBy ?? ''] ? 'projects.json' : 'default'} (${draft.deniedBy}).`
    }
  }

  // One folder registered twice (a symlinked form of a registered root): only the one the legacy settings or projects.json
  // name by id may take work; the others are ambiguous.
  const byRoot = new Map<string, Draft[]>()
  for (const draft of drafts) byRoot.set(draft.root, [...byRoot.get(draft.root) ?? [], draft])
  for (const group of byRoot.values()) {
    if (group.length < 2) continue
    const named = group.filter(draft => draft.legacy || rules.some(rule => rule.kind === 'id' && rule.target === draft.project.id && rule.override.access !== 'deny'))
    const chosen = named.length === 1 ? named[0] : undefined
    for (const draft of group) {
      if (draft === chosen || draft.status) continue
      draft.status = 'ambiguous'
      draft.reason = chosen
        ? `The same folder as T3 Code project ${chosen.project.id}, which takes its work.`
        : `${group.length} T3 Code projects have this folder (${group.map(item => item.project.id).join(', ')}); name one in projects.json by its T3 Code id.`
    }
  }

  await pool(drafts.filter(draft => !draft.status), 8, async draft => { draft.git = await gitFacts(draft.root) })
  for (const draft of drafts) {
    if (draft.status) continue
    if (!draft.git) { draft.status = 'no-git'; draft.reason = `${draft.root} is not a git checkout; workers need one.` }
    else if (draft.git.toplevel !== draft.root && draft.legacy) {
      // Worktrees can be made from a folder inside a checkout, and the legacy project worked there before, so it still does.
      draft.reason = `${draft.root} is inside the git checkout ${draft.git.toplevel}, not its top level; workers get worktrees of the whole checkout.`
    } else if (draft.git.toplevel !== draft.root) {
      draft.status = 'no-git'; draft.reason = `${draft.root} is inside the git checkout ${draft.git.toplevel}, not its top level; register the top level in T3 Code.`
    }
  }
  // A registered linked worktree whose main checkout is registered too is folded into it (phase 0, probe 3).
  const mainOf = (git: GitFacts) => basename(git.commonDir) === '.git' ? dirname(git.commonDir) : undefined
  for (const draft of drafts) {
    if (draft.status || draft.legacy || !draft.git) continue
    const main = mainOf(draft.git)
    const owner = main && main !== draft.root ? drafts.find(other => other.root === main && other.git && other.status !== 'missing-checkout') : undefined
    if (owner) { draft.status = 'folded'; draft.reason = `A linked worktree of ${owner.root}, which takes the repository's work.` }
  }
  if (legacy && legacyDraft && legacyDraft.status) problem = `The legacy project ${legacyDraft.root} is ${legacyDraft.status}: ${legacyDraft.reason}`

  // The catalogue join: the exact real path first; else the longest catalogued folder that holds the root, copying nothing.
  const byPath = new Map((catalogue?.entries ?? []).map(entry => [entry.abs, entry]))
  const joined = new Set<Catalogued>()
  const entries: ProjectEntry[] = drafts.map(draft => {
    const exact = byPath.get(draft.root)
    if (exact) joined.add(exact)
    const parent = exact ? undefined : catalogue?.entries.filter(entry => entry.abs !== draft.root && within(draft.root, entry.abs))
      .sort((a, b) => b.abs.length - a.abs.length)[0]
    const title = draft.project.title?.trim() || basename(draft.root)
    const isLegacy = draft.legacy && !!legacy
    const delivery: Delivery = isLegacy ? draft.override.delivery ?? (legacy!.repository ? 'pr' : 'branch') : 'branch'
    return {
      id: draft.project.id, key: exact?.path ?? title, title, aliases: draft.override.aliases ?? [], root: draft.root,
      ...draft.git ? { commonDir: draft.git.commonDir } : {}, ...draft.git?.defaultBranch ? { defaultBranch: draft.git.defaultBranch } : {},
      worktreeRoot: '',
      baseRef: isLegacy ? legacy!.baseRef : draft.override.baseRef ?? draft.git?.defaultBranch ?? 'HEAD',
      delivery, ...isLegacy && legacy!.repository ? { repository: legacy!.repository } : {},
      access: draft.override.access === 'deny' ? 'deny' : isLegacy ? 'work' : draft.override.access ?? 'named',
      dirty: draft.override.dirty ?? 'warn', status: draft.status ?? 'ready', ...draft.reason ? { reason: draft.reason } : {},
      legacy: isLegacy, describe: draft.override.describe ?? true,
      ...exact ? { catalogue: facts(exact) } : parent ? { catalogue: { insideCatalogued: parent.path } } : {},
      worktrees: [],
    }
  })

  // Catalogued folders T3 Code does not have: catalogued linked worktrees fold into their main checkout (D10), registered or
  // catalogued; the rest show why work cannot go there.
  const unjoined = (catalogue?.entries ?? []).filter(entry => !joined.has(entry) && !excluded(entry.abs))
  const mains = new Map<Catalogued, string>()
  await pool(unjoined.filter(entry => entry.kind === 'git-worktree' && entry.exists), 8, async entry => {
    const git = await gitFacts(entry.abs)
    const main = git && mainOf(git)
    if (main && main !== entry.abs) mains.set(entry, main)
  })
  const hasOwner = (main: string) => entries.some(item => item.root === main) || unjoined.some(item => item.abs === main && !mains.has(item))
  const others = unjoined.filter(entry => !hasOwner(mains.get(entry) ?? '')).map(entry => catalogueOnly(entry, rules, input.overrides))

  // Keys and worktree folders are unique: a second project with the same key gets its T3 Code id added, and a second one
  // with the same folder name a short hash of its id. Which one keeps the plain name depends only on facts that stay the
  // same between refreshes, never on status: the legacy project first, then a catalogue path over a T3 Code title, then
  // by T3 Code id (a catalogued folder by its path).
  const titled = (entry: ProjectEntry) => Number(!(entry.catalogue && 'path' in entry.catalogue))
  const naming = [...entries, ...others].sort((a, b) => Number(b.legacy) - Number(a.legacy) || titled(a) - titled(b)
    || compare(a.id ?? a.root, b.id ?? b.root))
  const taken = new Set<string>(), folders = new Set<string>()
  for (const entry of naming) {
    if (taken.has(entry.key.toLowerCase())) entry.key = `${entry.key} [${entry.id ?? entry.root}]`
    taken.add(entry.key.toLowerCase())
    const override = drafts.find(draft => entry.id !== undefined && draft.project.id === entry.id)?.override
    if (entry.legacy && legacyWorktrees) entry.worktreeRoot = legacyWorktrees
    else if (override?.worktreeRoot) entry.worktreeRoot = override.worktreeRoot
    else {
      let folder = slug(entry.key)
      if (folders.has(folder)) folder = `${folder}-${createHash('sha256').update(entry.id ?? entry.root).digest('hex').slice(0, 8)}`
      folders.add(folder)
      entry.worktreeRoot = join(stateDir, 'worktrees', folder)
    }
  }
  const all = naming.slice().sort((a, b) => Number(b.legacy) - Number(a.legacy) || STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status)
    || a.key.localeCompare(b.key))
  for (const [entry, main] of mains) all.find(item => item.root === main)?.worktrees.push(entry.path)
  for (const [index, draft] of drafts.entries()) {
    if (draft.status === 'folded' && draft.git) all.find(item => item.root === mainOf(draft.git!) && item.status !== 'folded')?.worktrees.push(entries[index]!.key)
  }
  return { entries: all, ...problem ? { problem } : {} }
}

/** A catalogued folder T3 Code has no project for. */
function catalogueOnly(entry: Catalogued, rules: Rule[], overrides: Record<string, ProjectOverride>): ProjectEntry {
  let override: ProjectOverride = {}, deniedBy: string | undefined
  for (const rule of rules.filter(item => item.kind !== 'id' && matches(item, undefined, entry.abs)).sort(bySpecificity)) {
    override = { ...override, ...rule.override }
    if (rule.override.access) deniedBy = rule.override.access === 'deny' ? rule.key : undefined
  }
  const [status, reason]: [ProjectStatus, string] = !entry.exists ? ['missing-checkout', `${entry.abs} no longer exists.`]
    : override.access === 'deny' ? ['denied', `Denied by ${overrides[deniedBy ?? ''] ? 'projects.json' : 'default'} (${deniedBy}).`]
    : notCheckout(entry.abs) ? ['no-git', notCheckout(entry.abs)!]
    : ['not-registered', `Add ${entry.abs} as a project in T3 Code, then run superagent_projects with refresh.`]
  return { key: entry.path, title: basename(entry.path), aliases: override.aliases ?? [], root: entry.abs, worktreeRoot: '',
    baseRef: override.baseRef ?? 'HEAD', delivery: 'branch', access: override.access ?? 'named', dirty: override.dirty ?? 'warn', status, reason,
    legacy: false, describe: override.describe ?? true, catalogue: facts(entry), worktrees: [] }
}

/**
 * Why a catalogued folder is not a git checkout, from the file system alone (no git call): it has no `.git`, or its `.git`
 * file names a git dir that does not exist here, as a checkout copied from another machine has. Undefined when it may be one.
 */
function notCheckout(abs: string): string | undefined {
  const dotGit = join(abs, '.git')
  let stat
  try { stat = statSync(dotGit) } catch { return `${abs} is not a git checkout; workers need one.` }
  if (stat.isDirectory()) return undefined
  let gitdir: string | undefined
  try { gitdir = readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+?)\s*$/m)?.[1] } catch { /* unreadable: as if empty */ }
  if (!gitdir) return `${dotGit} is a file with no gitdir line, so ${abs} is not a git checkout; workers need one.`
  return existsSync(resolve(abs, gitdir)) ? undefined
    : `${abs} is not a git checkout here: its .git file points at ${gitdir}, which does not exist on this machine.`
}

function facts(entry: Catalogued): CatalogueFacts {
  return { path: entry.path, ...entry.kind ? { kind: entry.kind } : {}, ...entry.purpose ? { purpose: entry.purpose } : {},
    ...entry.notes ? { notes: entry.notes } : {}, related: entry.related, ...entry.map ? { map: entry.map } : {}, modules: entry.modules }
}

/**
 * The overrides as rules. Applied in `bySpecificity` order, so a later one wins: prefixes from the shortest folder (a default
 * and a projects.json prefix alike; on the same folder projects.json's comes later), then paths, then ids.
 */
function overrideRules(overrides: Record<string, ProjectOverride>, workspace: string | undefined, ids: Set<string>,
  log?: (message: string) => void): Rule[] {
  const rules: Rule[] = []
  const add = (key: string, override: ProjectOverride, fromFile: boolean) => {
    if (fromFile && ids.has(key)) return rules.push({ kind: 'id', key, target: key, override, rank: 3, fromFile })
    const relative = !isAbsolute(key)
    if (relative && !workspace) {
      if (fromFile) log?.(`projects.json key "${key}" is relative and no catalogue gives a workspace; it applies only as a T3 Code id`)
      return rules.push({ kind: 'id', key, target: key, override, rank: 3, fromFile })
    }
    const path = relative ? join(workspace!, key) : key
    const target = real(path) ?? resolve(path)
    if (key.endsWith('/')) return rules.push({ kind: 'prefix', key, target, override, rank: 0, fromFile })
    return rules.push({ kind: 'path', key, target, override, rank: 2, fromFile })
  }
  if (workspace) for (const [key, override] of Object.entries(DEFAULT_OVERRIDES)) if (!overrides[key]) add(key, override, false)
  for (const [key, override] of Object.entries(overrides)) add(key, override, true)
  return rules
}
/** The order rules apply in, the most general first. */
const bySpecificity = (a: Rule, b: Rule): number => a.rank - b.rank || a.target.length - b.target.length || Number(a.fromFile) - Number(b.fromFile)
function matches(rule: Rule, id: string | undefined, root: string): boolean {
  return rule.kind === 'id' ? rule.target === id : rule.kind === 'path' ? rule.target === root : within(root, rule.target)
}

/** The git facts of a folder, or undefined when git cannot read it as a checkout. */
async function gitFacts(root: string): Promise<GitFacts | undefined> {
  let toplevel: string, commonDir: string
  try {
    const [top, common] = (await git(root, 'rev-parse', '--show-toplevel', '--path-format=absolute', '--git-common-dir')).split('\n')
    if (!top || !common) return undefined
    toplevel = real(top) ?? top
    commonDir = real(common) ?? common
  } catch { return undefined }
  const origin = (await git(root, 'symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD').catch(() => '')).replace(/^origin\//, '')
  const heads = (await git(root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').catch(() => '')).split('\n')
  const defaultBranch = [origin, 'main', 'master'].find(name => name && heads.includes(name))
  return { toplevel, commonDir, ...defaultBranch ? { defaultBranch } : {} }
}
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...args], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 })
  return stdout.trim()
}
/** Runs `work` on every item, at most `size` at a time. */
async function pool<T>(items: T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await work(items[next++]!)
  }))
}

const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0
const real = (path: string): string | undefined => { try { return realpathSync.native(path) } catch { return undefined } }
const within = (path: string, dir: string): boolean => path === dir || path.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`)
/** A file's identity for re-reading: its modification time and size; undefined when it does not exist. */
function fileStamp(path: string): string | undefined {
  try { const stat = statSync(path); return `${stat.mtimeMs}:${stat.size}` } catch { return undefined }
}
/** A folder name for a project's worktrees under `<stateDir>/worktrees`. */
export const slug = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'project'
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const issues = (error: z.ZodError) => error.issues.map(issue => `${issue.path.join('.') || 'value'}: ${issue.message}`).join('; ')
