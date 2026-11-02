/** Configuration from the environment. Point 5: the only credential is t3code's `mcp-client` token. */
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

export interface Config {
  t3Url: string
  t3Token: string
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
  /**
   * The Router: `claude`, the model-backed Router, whenever Anthropic credentials are set; otherwise `rules`, which only accepts
   * explicit requests. `acceptMode` is the Policy's accept mode for proactive work (prototype docs/002).
   */
  router: { kind: 'claude' | 'rules'; model: string; effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; acceptMode: 'off' | 'observe' | 'auto' }
  /** The GitHub Source; off without an agent account. */
  github?: { login: string; allowed: string[]; gh: string; pollMs: number; commitEmail?: string }
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
    t3Token: need('T3_MCP_TOKEN'),
    projectId: env.SUPERAGENT_PROJECT_ID || undefined,
    projectRoot,
    worktreeRoot: resolve(env.SUPERAGENT_WORKTREE_ROOT ?? join(dirname(projectRoot), `${basename(projectRoot)}-superagent`)),
    baseRef: env.SUPERAGENT_BASE_REF ?? 'HEAD',
    repository: env.SUPERAGENT_REPOSITORY || undefined,
    port,
    publicUrl: (env.SUPERAGENT_PUBLIC_URL ?? `http://127.0.0.1:${port}`).replace(/\/+$/, ''),
    consoleToken: env.SUPERAGENT_CONSOLE_TOKEN || randomBytes(24).toString('base64url'),
    database: join(resolve(env.SUPERAGENT_STATE_DIR ?? join(homedir(), '.superagent-t3')), 'state.sqlite'),
    operator: env.SUPERAGENT_OPERATOR ?? 'operator',
    maxWorkers: Number(env.SUPERAGENT_MAX_WORKERS ?? 3),
    runtimeMode: env.SUPERAGENT_RUNTIME_MODE || undefined,
    router: {
      kind: (env.SUPERAGENT_ROUTER ?? (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_PROFILE ? 'claude' : 'rules')) === 'claude' ? 'claude' : 'rules',
      model: env.SUPERAGENT_ROUTER_MODEL ?? 'claude-opus-5-5',
      effort: oneOf(env.SUPERAGENT_ROUTER_EFFORT, ['low', 'medium', 'high', 'xhigh', 'max'] as const, 'medium'),
      acceptMode: oneOf(env.SUPERAGENT_ACCEPT_MODE, ['off', 'observe', 'auto'] as const, 'observe'),
    },
    ...env.SUPERAGENT_GITHUB_LOGIN ? { github: {
      login: env.SUPERAGENT_GITHUB_LOGIN,
      allowed: (env.SUPERAGENT_GITHUB_ALLOWED ?? '').split(',').map(login => login.trim()).filter(Boolean),
      gh: env.SUPERAGENT_GH || 'gh',
      pollMs: Number(env.SUPERAGENT_GITHUB_POLL_SECONDS ?? 30) * 1000,
      ...env.SUPERAGENT_GITHUB_COMMIT_EMAIL ? { commitEmail: env.SUPERAGENT_GITHUB_COMMIT_EMAIL } : {},
    } } : {},
    log: (message, error) => console.error(`[superagent] ${message}${error ? `: ${error instanceof Error ? error.message : String(error)}` : ''}`),
  }
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  if (value === undefined || value === '') return fallback
  if (!(allowed as readonly string[]).includes(value)) throw new Error(`Expected one of ${allowed.join(', ')}, got ${value}`)
  return value as T
}
