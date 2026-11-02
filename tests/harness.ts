/** A super agent wired to a fake t3code and a real git checkout, for the tests. */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Runtime } from '../src/app/runtime.ts'
import type { Config } from '../src/config.ts'
import { startHttp } from '../src/http/server.ts'
import { FakeT3 } from './fake-t3.ts'

export const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

export function checkout(): { dir: string; root: string } {
  const dir = mkdtempSync(join(tmpdir(), 'superagent-'))
  const root = join(dir, 'widgets')
  execFileSync('git', ['init', '-q', '-b', 'main', root])
  writeFileSync(join(root, 'README.md'), '# widgets\n')
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.')
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init')
  return { dir, root }
}

export interface Harness { runtime: Runtime; http: Server; base: string; errors: string[]; close(): Promise<void> }

export async function harness(t3: FakeT3, place: { dir: string; root: string }, database = ':memory:', overrides: Partial<Config> = {}): Promise<Harness> {
  const errors: string[] = []
  const config: Config = { t3Url: 'unused', t3Token: 'unused', projectRoot: place.root, worktreeRoot: join(place.dir, 'worktrees'), baseRef: 'HEAD',
    repository: 'acme/widgets', port: 0, publicUrl: '', consoleToken: 'console-secret', database, operator: 'hector', maxWorkers: 2,
    log: (message, error) => { errors.push(`${message} ${error instanceof Error ? error.message : error ?? ''}`) }, ...overrides }
  const runtime = new Runtime(config, t3, { id: 'project-1', root: place.root }, { waitMs: 10, idlePollMs: 10, continueAfterMs: 0 })
  const http = await startHttp(runtime, 0)
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
