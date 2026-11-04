/** A super agent wired to a t3code (the in-memory fake, or any `T3Client`) and a real git checkout, for the tests. */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { afterAll } from 'vitest'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { bindingOf, ProjectRegistry, type ProjectBinding } from '../src/app/projects.ts'
import { Runtime } from '../src/app/runtime.ts'
import type { Config } from '../src/config.ts'
import { serve } from '../src/http/server.ts'
import type { Gh } from '../src/sources/github.ts'
import type { ModelCall } from '../src/router/claude-router.ts'
import type { T3Client } from '../src/t3/client.ts'
import { FakeT3 } from './fake-t3.ts'

export const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

/** Checkouts made by this module, removed after the spec file (and, failing that, when the process exits). */
const made = new Set<string>()
const removeAll = () => { for (const dir of made) removeCheckout({ dir }) }
afterAll(removeAll)
process.once('exit', removeAll)

/** Removes a checkout made by `checkout()`, with its worktrees and anything else under its directory. */
export function removeCheckout(place: { dir: string }): void {
  made.delete(place.dir)
  try { rmSync(place.dir, { recursive: true, force: true, maxRetries: 3 }) } catch { /* left for the OS to clear */ }
}

/**
 * A temporary git repository `name` with one commit; the worktrees of a harness on it go beside it, in the same directory.
 * With `dir`, the directory of an earlier checkout, the repository goes there instead of a new directory, so several
 * repositories share one temp dir and are removed with it.
 */
export function checkout(name = 'widgets', dir?: string): { dir: string; root: string } {
  if (dir === undefined) made.add(dir = mkdtempSync(join(tmpdir(), 'superagent-')))
  const root = join(dir, name)
  if (existsSync(root)) throw new Error(`${root} exists`)
  execFileSync('git', ['init', '-q', '-b', 'main', root])
  writeFileSync(join(root, 'README.md'), `# ${name}\n`)
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.')
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init')
  return { dir, root }
}

/**
 * The `projects` and `bindings` of a T3Executor built without a Runtime: one ready project, `{ id, root }`, that every ticket is
 * bound to, as the legacy project.
 */
export function singleProject(project: { id: string; root: string; worktreeRoot?: string }):
  { projects: ProjectRegistry; bindings: { of(ticketId: string): ProjectBinding } } {
  const projects = ProjectRegistry.single(project)
  const entry = projects.list()[0]!
  return { projects, bindings: { of: ticketId => bindingOf(entry, ticketId, 'legacy', '2026-01-01T00:00:00.000Z') } }
}

/** The executor timing a Runtime takes; tests use short waits. */
export type Timing = NonNullable<ConstructorParameters<typeof Runtime>[3]>

export interface Harness { runtime: Runtime; http: Server; base: string; errors: string[]; close(): Promise<void> }

/**
 * Starts a Runtime on `t3` with its HTTP server on a free port. `deps.timing` replaces the fast default timing, and
 * `deps.project` the t3code project, for a live t3code; `deps.projects` gives a loaded registry instead of the one legacy
 * project on `place`. The state directory is `<place.dir>/state`, so nothing is written under the real one. `runtime.prepare()`
 * runs before HTTP opens, as in main.ts. A FakeT3 that leaves `checkWorktrees` unset gets it turned on, so
 * a launch with the wrong project id or a path that is not one of the project's worktrees fails as it would in t3code.
 */
export async function harness(t3: T3Client, place: { dir: string; root: string }, database = ':memory:', overrides: Partial<Config> = {},
  deps: { gh?: Gh; model?: ModelCall; timing?: Timing; project?: string; projects?: ProjectRegistry } = {}): Promise<Harness> {
  const errors: string[] = []
  if (t3 instanceof FakeT3) t3.checkWorktrees ??= true
  const stateDir = join(place.dir, 'state')
  const config: Config = { t3Url: 'unused', t3Token: 'unused', tokenFile: 'unused', stateDir, projectsFile: join(stateDir, 'projects.json'),
    legacy: { root: place.root, worktreeRoot: join(place.dir, 'worktrees'), baseRef: 'HEAD', repository: 'acme/widgets' },
    router: { kind: 'rules', model: 'claude-opus-5-5', effort: 'medium', acceptMode: 'observe' },
    port: 0, publicUrl: '', consoleToken: 'console-secret', watchdogMinutes: 0, database, operator: 'hector', maxWorkers: 2,
    log: (message, error) => { errors.push(`${message} ${error instanceof Error ? error.message : error ?? ''}`) }, ...overrides }
  const { timing = { waitMs: 10, idlePollMs: 10, continueAfterMs: 0 }, project = 'project-1', projects, ...rest } = deps
  const runtime = new Runtime(config, t3, projects ?? { id: project, root: place.root }, timing, rest)
  // As main.ts: the migration runs before HTTP opens. A failed one leaves nothing open.
  const http = await serve(runtime, 0).catch(async error => { await runtime.stop(); throw error })
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
  // The public URL is known once the server listens; the runtime reads it whenever it builds a URL.
  config.publicUrl = base
  runtime.start()
  return { runtime, http, base, errors, close: async () => { http.close(); await runtime.stop() } }
}

export async function until<T>(check: () => T | undefined | false | null, what: string, ms = 4000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = check()
    if (value) return value
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** An MCP client connected to one of the service's MCP URLs. */
export async function mcp(url: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url)))
  return client
}
/** A tool result's structured content. */
export const data = (result: unknown) => (result as { structuredContent: Record<string, unknown> }).structuredContent
