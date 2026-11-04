/**
 * The small files main.ts keeps in the state directory besides the database: a pid lock, so two instances never share one
 * database (both would resume every active ticket), and the console token, so the console and Watchdog threads and the
 * panel URL survive a restart (docs/multi-project-plan.md, D16 and D17). `loadConfig` writes neither; main.ts calls these
 * after it.
 */
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const LOCK_FILE = 'superagent.lock'
export const CONSOLE_TOKEN_FILE = 'console-token'
/** A lock file with no pid in it yet may be one another instance is writing; one older than this is taken as left by a crash. */
const UNWRITTEN_LOCK_MS = 5000
/** How much later than its lock file a process may seem to have started and still be the one that wrote it: `ps` counts whole seconds. */
const START_SLACK_MS = 2000

export interface Lock { path: string; release(): void }

/**
 * Takes `<stateDir>/superagent.lock` by creating it exclusively with this process's pid. A lock whose pid is no longer
 * running is taken over, and so is one whose pid now belongs to a process that started after the lock was written (a pid
 * reused after a crash or a reboot): the process that wrote it was running then, so it started before. Any other running
 * pid (this process included) refuses the start. `release` removes the file if it still holds this pid. The takeover is
 * best effort: the stale file is removed only while it still holds the pid that was found stale, and the new one is read
 * back once written.
 */
export function acquireLock(stateDir: string): Lock {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const path = join(stateDir, LOCK_FILE)
  const mine = String(process.pid)
  const release = () => {
    try { if (readFileSync(path, 'utf8').trim() === mine) unlinkSync(path) } catch { /* already gone */ }
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(path, `${mine}\n`, { flag: 'wx', mode: 0o600 })
      if (readFileSync(path, 'utf8').trim() !== mine) continue
      return { path, release }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    let held: string
    try { held = readFileSync(path, 'utf8').trim() } catch { continue }
    const pid = Number(held)
    if (!/^\d+$/.test(held) || pid <= 0) {
      const age = Date.now() - statSafe(path)
      if (age < UNWRITTEN_LOCK_MS) throw new Error(`${path} is being written by another superagent that is starting; try again in a moment.`)
    } else if (running(pid)) {
      const found = processInfo(pid)
      if (!found || found.startedAt < statSafe(path) + START_SLACK_MS) {
        throw new Error(`Another superagent (pid ${pid}) uses ${stateDir}. Stop it first, or give this one its own SUPERAGENT_STATE_DIR and SUPERAGENT_PORT. `
          + `If pid ${pid}${found?.command ? ` (${found.command.slice(0, 200)})` : ''} is not a superagent, delete ${path}.`)
      }
    }
    try { if (readFileSync(path, 'utf8').trim() === held) unlinkSync(path) } catch { /* taken meanwhile; the next attempt sees it */ }
  }
  throw new Error(`Could not take ${path}: another superagent keeps taking it.`)
}

function statSafe(path: string): number {
  try { return statSync(path).mtimeMs } catch { return 0 }
}
/**
 * When a running process started and its command line, from `ps`; undefined where `ps` cannot say (it is missing, as on
 * Windows, or the process ended meanwhile). The start time is the current time less the elapsed whole seconds.
 */
function processInfo(pid: number): { startedAt: number; command: string } | undefined {
  const result = spawnSync('ps', ['-o', 'etime=', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 })
  const match = result.status === 0 ? /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s+(.*)$/.exec(result.stdout.split('\n')[0] ?? '') : null
  if (!match) return undefined
  const [, days, hours, minutes, seconds, command] = match
  const elapsed = ((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 + Number(seconds)
  return { startedAt: Date.now() - elapsed * 1000, command: command!.trim() }
}
/** Whether a pid runs: `kill(pid, 0)` checks without signalling. EPERM means it runs under another user. */
function running(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

/**
 * The console token: `given` (`SUPERAGENT_CONSOLE_TOKEN`) when set, else the one saved in `<stateDir>/console-token`, else a
 * new random one saved there with mode 0600.
 */
export function ensureConsoleToken(stateDir: string, given?: string): string {
  if (given?.trim()) return given.trim()
  const path = join(stateDir, CONSOLE_TOKEN_FILE)
  const saved = readToken(path)
  if (saved) return saved
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const token = randomBytes(24).toString('base64url')
  try {
    writeFileSync(path, `${token}\n`, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    // An empty file left by a crash is replaced; one written meanwhile is used.
    const now = readToken(path)
    if (now) return now
    writeFileSync(path, `${token}\n`, { mode: 0o600 })
  }
  // The mode given to writeFileSync applies only to a file it creates, not to the empty one it replaced.
  chmodSync(path, 0o600)
  return token
}
function readToken(path: string): string | undefined {
  try { return readFileSync(path, 'utf8').trim() || undefined } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
