/** Configuration from the environment. Point 5: the only credential is t3code's `mcp-client` token. */
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { AdmissionTableSchema } from '../vendor/dsh/src/policy.ts'
import type { AdmissionRow } from '../vendor/dsh/src/admission.ts'

/** The admission table's rows on GitHub, as the Source's `scope` names them: new Issues, new pull requests, and comments. */
export const GITHUB_ROWS = ['issues', 'pulls', 'comments'] as const
export type GithubRow = typeof GITHUB_ROWS[number]

/**
 * The project `SUPERAGENT_PROJECT_ROOT` or `SUPERAGENT_PROJECT_ID` names: the one project of a single-project install, which
 * keeps its settings when more projects are registered (docs/multi-project-plan.md, 3.1). Workers launch only here for now.
 */
export interface LegacyProject {
  /** `SUPERAGENT_PROJECT_ROOT`, resolved; absent when only the id is given, and then t3code's root for that id is used. */
  root?: string
  /** The t3code project id; found by `root` when not given. */
  id?: string
  /** `SUPERAGENT_WORKTREE_ROOT`, or `<root>/../<name>-superagent`; absent when only the id is given, and then derived the same way from t3code's root. */
  worktreeRoot?: string
  baseRef: string
  /** `SUPERAGENT_REPOSITORY`: the GitHub repository of this project, the only one with pull-request delivery. */
  repository?: string
}

export interface Config {
  t3Url: string
  /** An `mcp-client` token given directly; empty to use the one `superagent connect` saved in `tokenFile`. */
  t3Token: string
  tokenFile: string
  /** Where every file of the service goes: the database, the t3code token, the lock, the console token, projects.json and new projects' worktrees. */
  stateDir: string
  legacy?: LegacyProject
  /** `SUPERAGENT_CATALOGUE`: a repositories.json that describes the projects on this machine; optional. */
  catalogue?: string
  /** The operator's per-project overrides; `<stateDir>/projects.json` unless `SUPERAGENT_PROJECTS_FILE` moves it. Optional. */
  projectsFile: string
  port: number
  /** How t3code's agents reach this service; workers' MCP URLs start with it. */
  publicUrl: string
  /**
   * The secret in the console and panel URLs: `SUPERAGENT_CONSOLE_TOKEN`, or empty until main.ts reads or makes the saved one
   * with `ensureConsoleToken`, since loading the configuration writes nothing.
   */
  consoleToken: string
  /** The SQLite file, or `:memory:` in tests. */
  database: string
  operator: string
  maxWorkers: number
  runtimeMode?: string
  /** The model for every thread the super agent launches; needed when the project has no default model in t3code. */
  model?: { instanceId: string; model: string }
  /**
   * The Router: `claude`, the model-backed Router, whenever Anthropic credentials are set; otherwise `rules`, which only accepts
   * explicit requests. `acceptMode` is the Policy's accept mode for proactive work (prototype docs/002).
   */
  router: { kind: 'claude' | 'rules'; model: string; effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; acceptMode: 'off' | 'observe' | 'auto' }
  /** Minutes between Watchdog checks; 0 turns the Watchdog off. */
  watchdogMinutes: number
  /**
   * The GitHub Source; off without an agent account. `observe` lists the rows whose unaddressed messages the Source reads across
   * the repository, so the admission table can make candidates of them; `admission` is the Policy's admission table for GitHub
   * (prototype docs/002-authorization.md), cells left out keeping the prototype's defaults.
   */
  github?: { login: string; allowed: string[]; gh: string; pollMs: number; commitEmail?: string; observe?: GithubRow[]
    admission?: Partial<Record<GithubRow, AdmissionRow>> }
  log: (message: string, error?: unknown) => void
}

/** Reads the configuration from the environment. It writes nothing: the files it names are made by main.ts. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const state = stateDir(env)
  const legacy = legacyProject(env)
  const port = Number(env.SUPERAGENT_PORT ?? 3790)
  return {
    t3Url: env.T3_MCP_URL ?? 'http://127.0.0.1:3773/mcp',
    t3Token: env.T3_MCP_TOKEN?.trim() ?? '',
    tokenFile: join(state, 't3-token.json'),
    stateDir: state,
    ...legacy ? { legacy } : {},
    ...env.SUPERAGENT_CATALOGUE?.trim() ? { catalogue: resolve(env.SUPERAGENT_CATALOGUE.trim()) } : {},
    projectsFile: resolve(env.SUPERAGENT_PROJECTS_FILE?.trim() || join(state, 'projects.json')),
    port,
    publicUrl: (env.SUPERAGENT_PUBLIC_URL ?? `http://127.0.0.1:${port}`).replace(/\/+$/, ''),
    consoleToken: env.SUPERAGENT_CONSOLE_TOKEN?.trim() ?? '',
    database: join(state, 'state.sqlite'),
    operator: env.SUPERAGENT_OPERATOR ?? 'operator',
    maxWorkers: Number(env.SUPERAGENT_MAX_WORKERS ?? 3),
    runtimeMode: env.SUPERAGENT_RUNTIME_MODE || undefined,
    ...env.SUPERAGENT_MODEL ? { model: modelSelection(env.SUPERAGENT_MODEL) } : {},
    router: {
      kind: (env.SUPERAGENT_ROUTER ?? (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_PROFILE ? 'claude' : 'rules')) === 'claude' ? 'claude' : 'rules',
      model: env.SUPERAGENT_ROUTER_MODEL ?? 'claude-opus-5-5',
      effort: oneOf(env.SUPERAGENT_ROUTER_EFFORT, ['low', 'medium', 'high', 'xhigh', 'max'] as const, 'medium'),
      acceptMode: oneOf(env.SUPERAGENT_ACCEPT_MODE, ['off', 'observe', 'auto'] as const, 'observe'),
    },
    watchdogMinutes: Number(env.SUPERAGENT_WATCHDOG_MINUTES ?? 15),
    ...env.SUPERAGENT_GITHUB_LOGIN ? { github: {
      login: env.SUPERAGENT_GITHUB_LOGIN,
      allowed: (env.SUPERAGENT_GITHUB_ALLOWED ?? '').split(',').map(login => login.trim()).filter(Boolean),
      gh: env.SUPERAGENT_GH || 'gh',
      pollMs: Number(env.SUPERAGENT_GITHUB_POLL_SECONDS ?? 30) * 1000,
      ...env.SUPERAGENT_GITHUB_COMMIT_EMAIL ? { commitEmail: env.SUPERAGENT_GITHUB_COMMIT_EMAIL } : {},
      ...env.SUPERAGENT_GITHUB_OBSERVE?.trim() ? { observe: githubRows(env.SUPERAGENT_GITHUB_OBSERVE) } : {},
      ...env.SUPERAGENT_GITHUB_ADMISSION?.trim() ? { admission: githubAdmission(env.SUPERAGENT_GITHUB_ADMISSION) } : {},
    } } : {},
    log: (message, error) => console.error(`[superagent] ${message}${error ? `: ${error instanceof Error ? error.message : String(error)}` : ''}`),
  }
}

/**
 * The legacy project from `SUPERAGENT_PROJECT_ROOT` or `SUPERAGENT_PROJECT_ID`, with the settings that belong to it. Those
 * settings without either variable are refused, since they would silently do nothing.
 */
function legacyProject(env: NodeJS.ProcessEnv): LegacyProject | undefined {
  const root = env.SUPERAGENT_PROJECT_ROOT?.trim() ? resolve(env.SUPERAGENT_PROJECT_ROOT.trim()) : undefined
  const id = env.SUPERAGENT_PROJECT_ID?.trim() || undefined
  if (!root && !id) {
    const orphans = ['SUPERAGENT_WORKTREE_ROOT', 'SUPERAGENT_BASE_REF', 'SUPERAGENT_REPOSITORY'].filter(name => env[name]?.trim())
    if (orphans.length) {
      throw new Error(`${orphans.join(', ')} ${orphans.length === 1 ? 'belongs' : 'belong'} to the project SUPERAGENT_PROJECT_ROOT names: set it too, `
        + 'or leave them out. See README.md, "Run it".')
    }
    return undefined
  }
  const worktreeRoot = env.SUPERAGENT_WORKTREE_ROOT?.trim() ? resolve(env.SUPERAGENT_WORKTREE_ROOT.trim())
    : root ? join(dirname(root), `${basename(root)}-superagent`) : undefined
  return { ...root ? { root } : {}, ...id ? { id } : {}, ...worktreeRoot ? { worktreeRoot } : {}, baseRef: env.SUPERAGENT_BASE_REF?.trim() || 'HEAD',
    ...env.SUPERAGENT_REPOSITORY?.trim() ? { repository: env.SUPERAGENT_REPOSITORY.trim() } : {} }
}

/** `<provider instance>/<model>`, such as `codex/gpt-6-astra`; `orchestrator_capabilities` lists both. */
function modelSelection(value: string): { instanceId: string; model: string } {
  const [instanceId, ...rest] = value.trim().split('/')
  const model = rest.join('/')
  if (!instanceId || !model) throw new Error(`Set SUPERAGENT_MODEL as <provider instance>/<model>, such as codex/gpt-6-astra; got "${value}".`)
  return { instanceId, model }
}

/** `issues,pulls,comments`, any of them, or `all`; `none` for none. */
function githubRows(value: string): GithubRow[] {
  const names = value.split(',').map(name => name.trim().toLowerCase()).filter(Boolean)
  if (names.length === 1 && (names[0] === 'all' || names[0] === '1')) return [...GITHUB_ROWS]
  if (names.length === 1 && (names[0] === 'none' || names[0] === '0')) return []
  const unknown = names.filter(name => !(GITHUB_ROWS as readonly string[]).includes(name))
  if (unknown.length) throw new Error(`Set SUPERAGENT_GITHUB_OBSERVE to all, none, or some of ${GITHUB_ROWS.join(', ')}; got "${value}".`)
  return [...new Set(names)] as GithubRow[]
}

/** The admission table as JSON, such as `{"comments":{"unlistedAddressed":"inferred"}}`, checked against the prototype's schema. */
function githubAdmission(value: string): Partial<Record<GithubRow, AdmissionRow>> {
  const fail = (detail: string) => new Error(`SUPERAGENT_GITHUB_ADMISSION is not a valid admission table: ${detail}. See README.md, "Run it".`)
  let json: unknown
  try { json = JSON.parse(value) } catch (error) { throw fail(error instanceof Error ? error.message : String(error)) }
  const parsed = AdmissionTableSchema.safeParse(json)
  if (!parsed.success) throw fail(parsed.error.issues.map(issue => `${issue.path.join('.') || 'value'}: ${issue.message}`).join('; '))
  const unknown = Object.keys(parsed.data).filter(row => !(GITHUB_ROWS as readonly string[]).includes(row))
  if (unknown.length) throw fail(`unknown rows ${unknown.join(', ')}; the rows are ${GITHUB_ROWS.join(', ')}`)
  return parsed.data
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  if (value === undefined || value === '') return fallback
  if (!(allowed as readonly string[]).includes(value)) throw new Error(`Expected one of ${allowed.join(', ')}, got ${value}`)
  return value as T
}

/** Where the super agent keeps its database, its t3code token and its other files. */
export const stateDir = (env: NodeJS.ProcessEnv = process.env): string => resolve(env.SUPERAGENT_STATE_DIR ?? join(homedir(), '.superagent-t3'))
