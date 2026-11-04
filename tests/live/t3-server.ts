/**
 * An isolated, real `t3 serve` for the live tests (PLAN.md, ground rule 4). Everything lives in a fresh temp folder: the
 * base dir (t3code's `T3CODE_HOME`), a git checkout registered as the project `widgets`, and a scripted ACP agent registered
 * as the provider instance `scripted`. The real codex and Claude instances are turned off, so no test reaches a paid model
 * or the operator's logins. It never touches `~/.t3`'s state or the operator's server on port 3773.
 *
 * The `t3` binary comes from `T3_BIN` or PATH; the suites skip when it is missing or `T3_LIVE` is not `1`.
 *
 * The server runs in its own process group, with the agents it starts, and is taken down as a group. A run that ends without
 * closing it (vitest interrupted, its worker killed) leaves nothing behind either: tests/live/reaper.mjs watches the test
 * process from outside and takes the server and its folder down once that process is gone.
 */
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { connect } from '../../src/t3/connect.ts'
import { McpT3Client } from '../../src/t3/client.ts'

const run = promisify(execFile)

/** The runtime-mode ceilings t3code grants an `mcp-client` session. */
export type Access = 'approval-required' | 'auto-accept-edits' | 'auto' | 'full-access'

/** The `t3` executable: `T3_BIN`, else the first `t3` on PATH; undefined when there is none. */
export const t3Bin: string | undefined = (() => {
  const candidates = process.env.T3_BIN ? [process.env.T3_BIN] : (process.env.PATH ?? '').split(delimiter).filter(Boolean).map(dir => join(dir, 't3'))
  for (const candidate of candidates) {
    try { accessSync(candidate, constants.X_OK); return candidate } catch { /* next */ }
  }
  return undefined
})()
/** Whether the live suites run, and why not when they do not. */
export const live = process.env.T3_LIVE === '1' && !!t3Bin
export const skipReason = process.env.T3_LIVE !== '1' ? 'set T3_LIVE=1 to run the live t3code suites'
  : !t3Bin ? 'no t3 binary on PATH (set T3_BIN)' : ''

/**
 * The t3 runtime itself: `t3Bin` when it is not the npm launcher, else the build the launcher starts,
 * `~/.t3/runtime/versions/<launcher version>/t3`, which is only read and run. Undefined when that build is not installed.
 */
export const t3Runtime: string | undefined = (() => {
  if (!t3Bin) return undefined
  const real = realpathSync(t3Bin)
  if (!real.endsWith('.mjs')) return real
  try {
    const { version } = JSON.parse(readFileSync(join(dirname(real), '..', 'package.json'), 'utf8')) as { version: string }
    const runtime = join(homedir(), '.t3', 'runtime', 'versions', version, 't3')
    accessSync(runtime, constants.X_OK)
    return runtime
  } catch { return undefined }
})()
/** Why a server without credentials (`StartOptions.noCredentials`) cannot start here; empty when it can. */
export const noCredentialsSkipReason = !live ? skipReason : !t3Runtime ? 'the t3 runtime the launcher starts is not installed' : ''

/** The scripted ACP agent the isolated server runs for every thread. */
export const SCRIPTED_AGENT = fileURLToPath(new URL('./scripted-agent.mjs', import.meta.url))
const REAPER = fileURLToPath(new URL('./reaper.mjs', import.meta.url))
/** The provider instance id of the scripted agent. */
export const INSTANCE = 'scripted'
/** Ports the tests must never use: the operator's own t3code. */
const RESERVED = new Set([3773])

export interface T3Server {
  /** The MCP endpoint, such as `http://127.0.0.1:51234/mcp`. */
  url: string
  origin: string
  /** The temp folder that holds everything below; removed on close. */
  dir: string
  baseDir: string
  /** The `widgets` project's id and checkout. */
  projectId: string
  checkout: string
  /** Where the scripted agent logs. */
  agentLog: string
  /** An `mcp-client` access token with this runtime-mode ceiling; cached per ceiling. */
  token(access: Access): Promise<string>
  /** A client on `url` with a token of this ceiling, running the scripted model given. */
  client(access: Access, model?: string): Promise<McpT3Client>
  /** Runs the t3 CLI against this base dir; returns stdout. */
  cli(...args: string[]): Promise<string>
  /** The server's output so far, for failure messages. */
  output(): string
  /** The hosts that requests sent through the refusing proxy were for (`StartOptions.noCredentials`); always empty without it. */
  proxied(): string[]
  /**
   * Answers a pending approval as t3code's web app does, since `/mcp` cannot: with a bearer session the CLI issues from this
   * base dir, a WebSocket ticket for that session, and the `runtime-request.respond` command on the app's RPC socket.
   */
  answerApproval(threadId: string, requestId: string, decision?: ApprovalDecision): Promise<void>
  /** Kills the server outright and starts it again on the same base dir and port, as a crash and restart would. */
  restart(): Promise<void>
  close(): Promise<void>
}

/** How the web app answers an approval: once, for the rest of the session, always, or not. */
export type ApprovalDecision = 'accept' | 'acceptForSession' | 'acceptAlways' | 'decline' | 'cancel'

export interface StartOptions {
  /** The ACP agent script; tests/live/scripted-agent.mjs by default. */
  agentScript?: string
  /** The models (scenarios) the agent offers; the first is its default. */
  models?: string[]
  /** How long to wait for the server and the agent's models. */
  timeoutMs?: number
  /**
   * More environment for the agent, such as `SCRIPTED_AGENT_SIGNALS`. As a function it gets the server's temp folder, so a
   * folder the agent writes to can live inside it and go with it.
   */
  environment?: Record<string, string> | ((dir: string) => Record<string, string>)
  /**
   * Runs t3 without any of this machine's credentials, for calls that may look something up on GitHub: the runtime itself
   * (`t3Runtime`; the npm launcher would download one into the new HOME), with HOME and XDG_CONFIG_HOME in the temp folder, no
   * GitHub tokens or SSH agent, and no global or system git config. HTTP(S)_PROXY point at a local proxy that refuses every
   * request and records its host (`T3Server.proxied`), loopback excepted; it sees only clients that honour those variables.
   * The CLI calls run the same way, and the agents the server starts inherit all of it. Telemetry is off for every server,
   * so it never reaches the proxy. See `noCredentialsSkipReason`.
   *
   * macOS `sandbox-exec` cannot hold t3 instead: a sandboxed process may not run a setuid program, and t3 serve runs `/bin/ps`
   * at start and exits when that fails.
   */
  noCredentials?: boolean
}

/** Kills each running server at once; only synchronous work runs on `exit`. A process killed by a signal has the reaper. */
const running = new Map<T3Server, () => void>()
process.once('exit', () => { for (const kill of running.values()) kill() })

export async function startT3(options: StartOptions = {}): Promise<T3Server> {
  if (!t3Bin) throw new Error(skipReason)
  if (options.noCredentials && noCredentialsSkipReason) throw new Error(noCredentialsSkipReason)
  const bin = t3Bin
  const models = options.models ?? ['plain', 'alt']
  const timeoutMs = options.timeoutMs ?? 60_000
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'superagent-live-')))
  const baseDir = join(dir, 'base')
  const checkout = join(dir, 'widgets')
  const agentLog = join(dir, 'scripted-agent.log')
  // Detached, so a Ctrl-C to the test's process group does not stop it before it can clean up.
  const reaper = spawn(process.execPath, [REAPER, dir, String(process.pid), String(process.ppid)], { detached: true, stdio: 'ignore' })
  reaper.unref()
  const stopReaper = () => { if (reaper.exitCode === null) reaper.kill('SIGTERM') }
  /** Lists the process group the server now runs in for the reaper, or none once it is gone, so the reaper never signals a dead group. */
  const listGroup = (group?: number) => writeFileSync(join(dir, 'processes.json'), JSON.stringify({ groups: group ? [group] : [] }))
  const env = { ...process.env }
  // The server takes its home from --base-dir only; a stray variable must not point it elsewhere.
  delete env.T3CODE_HOME; delete env.T3CODE_PORT
  // Otherwise t3code sends usage events for these throwaway servers to its telemetry host every 10 s.
  env.T3CODE_TELEMETRY_ENABLED = 'false'
  // t3 leaves a `t3-token-*` folder with a socket in the temp directory; in the server's folder it goes with the folder. Not a
  // subfolder: the socket's path has to stay under macOS's 104 characters.
  env.TMPDIR = dir
  let proxy: RefusingProxy | undefined
  /** The command that runs t3 with these arguments: the binary, or the runtime itself without credentials. */
  const t3 = (args: string[]): [string, string[]] => [options.noCredentials ? t3Runtime! : bin, args]
  // The t3 CLI accepts `--base-dir` after the positional arguments too.
  const cli = async (...args: string[]) => (await run(...t3([...args, '--base-dir', baseDir]), { env, timeout: 60_000 })).stdout.trim()
  let projectId: string, port: number
  // Nothing below has a server yet, so a failure here only has the folder (and the proxy) to remove.
  try {
    if (options.noCredentials) {
      proxy = await refusingProxy()
      const home = join(dir, 'home')
      mkdirSync(join(home, '.config'), { recursive: true })
      Object.assign(env, { HOME: home, XDG_CONFIG_HOME: join(home, '.config'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0', NODE_USE_ENV_PROXY: '1', NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1' })
      for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) env[name] = proxy.url
      for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST', 'GH_CONFIG_DIR', 'SSH_AUTH_SOCK',
        'T3CODE_RELEASE_BASE_URL']) delete env[name]
    }
    mkdirSync(join(baseDir, 'userdata'), { recursive: true })
    writeFileSync(join(baseDir, 'userdata', 'settings.json'), `${JSON.stringify({
      continueThreadsAfterServerUpdate: false,
      enableProviderUpdateChecks: false,
      providerInstances: {
        [INSTANCE]: { driver: 'acpRegistry', displayName: 'Scripted (tests)',
          environment: [{ name: 'SCRIPTED_AGENT_MODELS', value: models.join(',') }, { name: 'SCRIPTED_AGENT_LOG', value: agentLog },
            ...Object.entries(typeof options.environment === 'function' ? options.environment(dir) : options.environment ?? {})
              .map(([name, value]) => ({ name, value }))],
          config: { source: 'local', commandPath: process.execPath, commandArgs: [options.agentScript ?? SCRIPTED_AGENT] } },
        codex: { driver: 'codex', enabled: false },
        claudeAgent: { driver: 'claudeAgent', enabled: false },
      },
    }, null, 2)}\n`)
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: checkout, encoding: 'utf8' })
    execFileSync('git', ['init', '-q', '-b', 'main', checkout])
    writeFileSync(join(checkout, 'README.md'), '# widgets\n')
    git('add', '.')
    git('commit', '-q', '-m', 'init')
    const added = await cli('project', 'add', '--title', 'widgets', checkout)
    const id = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(added)?.[0]
    if (!id) throw new Error(`t3 project add printed no project id: ${added}`)
    projectId = id
    port = await freePort()
  } catch (error) {
    if (process.env.T3_LIVE_KEEP === '1') console.error(`kept ${dir}`)
    else rmSync(dir, { recursive: true, force: true })
    proxy?.close()
    stopReaper()
    throw error
  }

  const origin = `http://127.0.0.1:${port}`
  const url = `${origin}/mcp`
  let output = ''
  let child!: ChildProcess, exited!: Promise<void>
  const spawnServer = () => {
    // Its own process group (the launcher's pid, or the runtime's), which the server and the agents it starts join.
    child = spawn(...t3(['serve', '--base-dir', baseDir, '--port', String(port), '--host', '127.0.0.1', '--no-browser', checkout]),
      { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    listGroup(child.pid)
    child.stdout!.on('data', chunk => { output += String(chunk) })
    child.stderr!.on('data', chunk => { output += String(chunk) })
    const current = child
    exited = new Promise<void>(resolve => current.once('exit', () => resolve()))
  }
  /** Stops the launcher and the server it started: SIGTERM, or SIGKILL at once or after 5 s; then whatever is left of its group. */
  const stopServer = async (signal: NodeJS.Signals) => {
    const pid = runtimePid(baseDir)
    const group = child.pid
    if (child.exitCode === null && child.signalCode === null) {
      if (signal === 'SIGKILL' && group) kill(-group, 'SIGKILL')
      else child.kill(signal)
      const late = setTimeout(() => { if (group) kill(-group, 'SIGKILL'); if (pid) kill(pid, 'SIGKILL') }, 5000)
      await exited
      clearTimeout(late)
    }
    // The launcher normally takes its server and the agents down with it; make sure.
    if (pid) kill(pid, 'SIGKILL')
    if (group) kill(-group, 'SIGKILL')
    listGroup()
  }
  // Ready once the runtime file exists and the OAuth metadata answers.
  const listening = () => poll(async () => {
    if (child.exitCode !== null) throw new Error(`t3 serve exited with ${child.exitCode}:\n${output}`)
    if (!existsSync(join(baseDir, 'userdata', 'server-runtime.json'))) return false
    const response = await fetch(`${origin}/.well-known/oauth-authorization-server`).catch(() => undefined)
    return response?.status === 200
  }, 't3 serve to listen', timeoutMs)
  spawnServer()
  const tokens = new Map<Access, Promise<string>>()
  /** The web app's kind of session, for `answerApproval`: t3code refuses an `mcp-client` session on `/ws`. */
  let appSession: Promise<string> | undefined
  const clients: McpT3Client[] = []
  let closed = false

  const server: T3Server = {
    url, origin, dir, baseDir, projectId, checkout, agentLog, cli,
    output: () => output,
    proxied: () => [...proxy?.hosts ?? []],
    token(access) {
      let token = tokens.get(access)
      if (!token) {
        token = access === 'approval-required'
          // The CLI's session has no ceiling of its own, so t3code caps it at approval-required.
          ? cli('auth', 'session', 'issue', '--subject', 'mcp-client', '--scope', 'orchestration:read', '--scope', 'orchestration:operate', '--token-only')
          : pairedToken(cli, url, access)
        tokens.set(access, token)
        token.catch(() => tokens.delete(access))
      }
      return token
    },
    async client(access, model) {
      const client = new McpT3Client({ url, token: await server.token(access), ...model ? { modelSelection: { instanceId: INSTANCE, model } } : {} })
      clients.push(client)
      return client
    },
    async answerApproval(threadId, requestId, decision = 'accept') {
      if (!appSession) {
        appSession = cli('auth', 'session', 'issue', '--scope', 'orchestration:read', '--scope', 'orchestration:operate', '--label', 'live tests', '--token-only')
        appSession.catch(() => { appSession = undefined })
      }
      await dispatch(origin, await appSession, { type: 'runtime-request.respond', commandId: `live-test:${randomUUID()}`, threadId, requestId, decision })
    },
    async restart() {
      await stopServer('SIGKILL')
      // The runtime file outlives a killed server; readiness waits for the new one to write it.
      rmSync(join(baseDir, 'userdata', 'server-runtime.json'), { force: true })
      spawnServer()
      await listening()
    },
    async close() {
      if (closed) return
      closed = true
      running.delete(server)
      await Promise.allSettled(clients.map(client => client.close()))
      await stopServer('SIGTERM')
      proxy?.close()
      // T3_LIVE_KEEP=1 keeps the folder (server and agent logs, worktrees) for a look after a failure.
      if (process.env.T3_LIVE_KEEP === '1') console.error(`kept ${dir}`)
      else rmSync(dir, { recursive: true, force: true })
      stopReaper()
    },
  }
  // On `exit` the folder is left to the reaper, which sees this process gone.
  running.set(server, () => {
    if (child.pid) kill(-child.pid, 'SIGKILL')
    const pid = runtimePid(baseDir)
    if (pid) kill(pid, 'SIGKILL')
  })

  try {
    await listening()
    // The agent's models appear once t3code's first probe of it ends, a few seconds after start.
    const probe = await server.client('approval-required')
    await poll(async () => {
      const capabilities = await probe.call<{ providers: { providerInstanceId: string; models: { id: string }[] }[] }>('orchestrator_capabilities', {})
      const ids = capabilities.providers.find(provider => provider.providerInstanceId === INSTANCE)?.models.map(model => model.id) ?? []
      return models.every(model => ids.includes(model))
    }, `the ${INSTANCE} instance to list ${models.join(', ')}`, timeoutMs)
  } catch (error) {
    await server.close()
    throw error
  }
  return server
}

/**
 * A token of any ceiling without a person: a pairing code from the CLI, then t3code's OAuth flow (src/t3/connect.ts) with
 * the approval page's decision posted directly, which returns the redirect that carries the code.
 */
async function pairedToken(cli: (...args: string[]) => Promise<string>, mcpUrl: string, access: Access): Promise<string> {
  const pairing = JSON.parse(await cli('auth', 'pairing', 'create', '--json', '--ttl', '10m')) as { credential: string }
  const saved = await connect({ mcpUrl, timeoutMs: 30_000, open: async page => {
    const query = new URL(page).searchParams
    const authorization = Object.fromEntries(['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'resource']
      .map(name => [name, query.get(name)]))
    const response = await fetch(`${new URL(mcpUrl).origin}/oauth/mcp/decision`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ authorization, decision: { _tag: 'pairing-code', access, code: pairing.credential } }) })
    const body = await response.text()
    if (!response.ok) throw new Error(`/oauth/mcp/decision: HTTP ${response.status} ${body}`)
    // The redirect goes to connect()'s own loopback listener, which finishes the flow.
    await fetch((JSON.parse(body) as { redirectTo: string }).redirectTo)
  } })
  return saved.token
}

/**
 * Sends one orchestration command as t3code's web app does: a WebSocket ticket for the session's bearer token
 * (`/api/auth/websocket-ticket/rpc`), then `orchestration.dispatchCommand` on `/ws`, which speaks Effect RPC as JSON. The
 * socket needs `orchestrationProtocol=2`, or t3code answers HTTP 426.
 */
async function dispatch(origin: string, sessionToken: string, command: { type: string } & Record<string, unknown>): Promise<void> {
  const response = await fetch(`${origin}/api/auth/websocket-ticket/rpc`, { method: 'POST', headers: { authorization: `Bearer ${sessionToken}` } })
  const body = await response.text()
  if (!response.ok) throw new Error(`/api/auth/websocket-ticket/rpc: HTTP ${response.status} ${body}`)
  const { ticket } = JSON.parse(body) as { ticket: string }
  const socket = new WebSocket(`${origin.replace(/^http/, 'ws')}/ws?orchestrationProtocol=2&wsTicket=${encodeURIComponent(ticket)}`)
  try {
    const exit = await new Promise<{ _tag: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${command.type}: no answer on /ws within 10 s`)), 10_000)
      const end = (error?: Error, value?: { _tag: string }) => { clearTimeout(timer); if (error) reject(error); else resolve(value!) }
      socket.addEventListener('open', () => socket.send(JSON.stringify({ _tag: 'Request', id: '1', tag: 'orchestration.dispatchCommand', payload: command, headers: [] })))
      socket.addEventListener('message', event => {
        const message = JSON.parse(String(event.data)) as { _tag: string; requestId?: string; exit?: { _tag: string }; defect?: unknown }
        if (message._tag === 'Exit' && message.requestId === '1') end(undefined, message.exit)
        else if (message._tag === 'Defect') end(new Error(`${command.type}: ${JSON.stringify(message.defect)}`))
      })
      socket.addEventListener('error', () => end(new Error(`${command.type}: /ws refused the connection`)))
    })
    if (exit._tag !== 'Success') throw new Error(`${command.type} failed: ${JSON.stringify(exit)}`)
  } finally { socket.close() }
}

interface RefusingProxy { url: string; hosts: string[]; close(): void }
/** An HTTP proxy on loopback that answers every request 403 and records the host it was for. */
async function refusingProxy(): Promise<RefusingProxy> {
  const hosts: string[] = []
  const server = createServer(socket => {
    socket.on('error', () => {})
    socket.once('data', chunk => {
      // `CONNECT host:443 HTTP/1.1` for HTTPS, `GET http://host/path HTTP/1.1` for plain HTTP.
      const target = /^[A-Z]+ (\S+)/.exec(String(chunk))?.[1] ?? '?'
      let host = target
      try { if (target.includes('://')) host = new URL(target).host } catch { /* keep the raw target */ }
      hosts.push(host)
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  return { url: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`, hosts, close: () => { server.close() } }
}

/** A port nothing listens on, found by binding port 0; never the operator's own t3code port. */
export async function freePort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer()
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        server.close(() => resolve(typeof address === 'object' && address ? address.port : 0))
      })
    })
    if (port && !RESERVED.has(port)) return port
  }
}

function runtimePid(baseDir: string): number | undefined {
  try { return (JSON.parse(readFileSync(join(baseDir, 'userdata', 'server-runtime.json'), 'utf8')) as { pid?: number }).pid } catch { return undefined }
}
function kill(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(pid, signal) } catch { /* already gone */ }
}

/** Polls an async check every 250 ms until it holds. */
export async function poll(check: () => Promise<boolean | undefined> | boolean | undefined, what: string, ms = 30_000): Promise<void> {
  const end = Date.now() + ms
  let last: unknown
  for (;;) {
    try { if (await check()) return } catch (error) { last = error; if (String(error).includes('exited with')) throw error }
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}${last ? `: ${last instanceof Error ? last.message : String(last)}` : ''}`)
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}
/** Polls an async value until it is truthy, and returns it. */
export async function eventually<T>(get: () => Promise<T | undefined | null | false>, what: string, ms = 30_000): Promise<T> {
  let value: T | undefined | null | false
  await poll(async () => !!(value = await get()), what, ms)
  return value as T
}
