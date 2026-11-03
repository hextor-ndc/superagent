/** Configuration from the environment. Point 5: the only credential is t3code's `mcp-client` token. */
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { AdmissionTableSchema } from '../vendor/dsh/src/policy.ts'
import type { AdmissionRow } from '../vendor/dsh/src/admission.ts'

/** The admission table's rows on GitHub, as the Source's `scope` names them: new Issues, new pull requests, and comments. */
export const GITHUB_ROWS = ['issues', 'pulls', 'comments'] as const
export type GithubRow = typeof GITHUB_ROWS[number]

export interface Config {
  t3Url: string
  /** An `mcp-client` token given directly; empty to use the one `superagent connect` saved in `tokenFile`. */
  t3Token: string
  tokenFile: string
  /** The t3code project the workers use; found by `projectRoot` when not given. */
  projectId?: string
  projectRoot: string
  worktreeRoot: string
  baseRef: string
  repository?: string
  port: number
  /** How t3code's agents reach this service; workers' MCP URLs start with it. */
  publicUrl: string
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const need = (name: string): string => {
    const value = env[name]?.trim()
    if (!value) throw new Error(`Set ${name}. See README.md, "Run it".`)
    return value
  }
  const projectRoot = resolve(need('SUPERAGENT_PROJECT_ROOT'))
  const port = Number(env.SUPERAGENT_PORT ?? 3790)
  return {
    t3Url: env.T3_MCP_URL ?? 'http://127.0.0.1:3773/mcp',
    t3Token: env.T3_MCP_TOKEN?.trim() ?? '',
    tokenFile: join(stateDir(env), 't3-token.json'),
    projectId: env.SUPERAGENT_PROJECT_ID || undefined,
    projectRoot,
    worktreeRoot: resolve(env.SUPERAGENT_WORKTREE_ROOT ?? join(dirname(projectRoot), `${basename(projectRoot)}-superagent`)),
    baseRef: env.SUPERAGENT_BASE_REF ?? 'HEAD',
    repository: env.SUPERAGENT_REPOSITORY || undefined,
    port,
    publicUrl: (env.SUPERAGENT_PUBLIC_URL ?? `http://127.0.0.1:${port}`).replace(/\/+$/, ''),
    consoleToken: env.SUPERAGENT_CONSOLE_TOKEN || randomBytes(24).toString('base64url'),
    database: join(stateDir(env), 'state.sqlite'),
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

/** Where the super agent keeps its database and its t3code token. */
export const stateDir = (env: NodeJS.ProcessEnv = process.env): string => resolve(env.SUPERAGENT_STATE_DIR ?? join(homedir(), '.superagent-t3'))
