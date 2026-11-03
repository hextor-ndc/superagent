#!/usr/bin/env node
/**
 * Takes down a live test's isolated t3 server (tests/live/t3-server.ts) when the test process goes away without closing it,
 * as when vitest is interrupted: the worker that started the server may be killed outright, or outlive the vitest it ran
 * for, and neither runs its `afterAll` or its `exit` handler. The harness starts this script detached, so a Ctrl-C to the
 * test's process group does not reach it.
 *
 * Arguments: the server's temp folder, then the process ids to watch (the test worker first, then its parent). Once any of
 * them is gone, it sends SIGTERM to the process group listed in `<folder>/processes.json` (the server runs in its own group,
 * its scripted agents with it), SIGKILL two seconds later, and removes the folder unless `T3_LIVE_KEEP=1`. It exits at once
 * when the folder is gone, which is how a normal close ends it.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const [dir, ...watched] = process.argv.slice(2)
const pids = watched.map(Number).filter(pid => pid > 1)
const alive = pid => {
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}
const signal = (pid, name) => { try { process.kill(pid, name) } catch { /* already gone */ } }
const groups = () => {
  try { return JSON.parse(readFileSync(join(dir, 'processes.json'), 'utf8')).groups.filter(group => group > 1) } catch { return [] }
}

const timer = setInterval(() => {
  if (!dir || !existsSync(dir)) process.exit(0)
  // The worker's own ppid check catches a worker that is gone but whose pid was reused.
  if (pids.every(alive) && process.ppid === pids[0]) return
  clearInterval(timer)
  for (const group of groups()) signal(-group, 'SIGTERM')
  setTimeout(() => {
    for (const group of groups()) signal(-group, 'SIGKILL')
    if (process.env.T3_LIVE_KEEP !== '1') rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    process.exit(0)
  }, 2000)
}, 500)
