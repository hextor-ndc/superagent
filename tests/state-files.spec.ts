/** The configuration without a project, and the state files main.ts keeps: the pid lock and the console token. */
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { acquireLock, ensureConsoleToken } from '../src/app/state-files.ts'
import { loadConfig } from '../src/config.ts'

const made: string[] = []
afterAll(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'superagent-state-')); made.push(dir); return dir }

describe('the configuration', () => {
  it('needs no project, writes nothing, and keeps the project\'s settings in a legacy block', () => {
    const state = join(temp(), 'not-made-yet')
    const config = loadConfig({ SUPERAGENT_STATE_DIR: state })
    expect(config).toMatchObject({ stateDir: state, database: join(state, 'state.sqlite'), tokenFile: join(state, 't3-token.json'),
      projectsFile: join(state, 'projects.json'), consoleToken: '' })
    expect(config.legacy).toBeUndefined()
    expect(config.catalogue).toBeUndefined()
    expect(existsSync(state)).toBe(false)

    expect(loadConfig({ SUPERAGENT_STATE_DIR: state, SUPERAGENT_PROJECT_ROOT: '/work/widgets', SUPERAGENT_REPOSITORY: 'acme/widgets',
      SUPERAGENT_CONSOLE_TOKEN: ' secret ', SUPERAGENT_CATALOGUE: '/work/repositories.json', SUPERAGENT_PROJECTS_FILE: '/etc/projects.json' }))
      .toMatchObject({ legacy: { root: '/work/widgets', worktreeRoot: '/work/widgets-superagent', baseRef: 'HEAD', repository: 'acme/widgets' },
        consoleToken: 'secret', catalogue: '/work/repositories.json', projectsFile: '/etc/projects.json' })
    expect(loadConfig({ SUPERAGENT_STATE_DIR: state, SUPERAGENT_PROJECT_ID: 'project-1', SUPERAGENT_BASE_REF: 'main' }).legacy)
      .toEqual({ id: 'project-1', baseRef: 'main' })
    expect(() => loadConfig({ SUPERAGENT_STATE_DIR: state, SUPERAGENT_REPOSITORY: 'acme/widgets' }))
      .toThrow('SUPERAGENT_REPOSITORY belongs to the project SUPERAGENT_PROJECT_ROOT names')
    expect(existsSync(state)).toBe(false)
  })
})

describe('the state files', () => {
  it('keeps one console token in a file only its owner reads, unless one is given', () => {
    const dir = temp()
    const first = ensureConsoleToken(dir)
    expect(first).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(ensureConsoleToken(dir)).toBe(first)
    expect(readFileSync(join(dir, 'console-token'), 'utf8').trim()).toBe(first)
    expect(statSync(join(dir, 'console-token')).mode & 0o777).toBe(0o600)
    expect(ensureConsoleToken(dir, 'given')).toBe('given')
    const other = temp()
    expect(ensureConsoleToken(other, 'given')).toBe('given')
    expect(existsSync(join(other, 'console-token'))).toBe(false)
    // An empty file, as a crash between creating and writing it leaves, gets a new token, readable by its owner only.
    writeFileSync(join(other, 'console-token'), '', { mode: 0o644 })
    chmodSync(join(other, 'console-token'), 0o644)
    expect(ensureConsoleToken(other)).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(statSync(join(other, 'console-token')).mode & 0o777).toBe(0o600)
  })

  it('refuses a second lock while the first holder runs, and takes over one whose process is gone or whose pid was reused', () => {
    const dir = temp()
    const lock = acquireLock(dir)
    expect(readFileSync(lock.path, 'utf8').trim()).toBe(String(process.pid))
    expect(() => acquireLock(dir)).toThrow(`Another superagent (pid ${process.pid}) uses ${dir}`)
    expect(() => acquireLock(dir)).toThrow(new RegExp(`If pid ${process.pid} \\(.*node.*\\) is not a superagent, delete ${lock.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.$`))
    lock.release()
    expect(existsSync(lock.path)).toBe(false)
    acquireLock(dir).release()

    const gone = spawnSync(process.execPath, ['-e', '']).pid!
    writeFileSync(join(dir, 'superagent.lock'), `${gone}\n`)
    const taken = acquireLock(dir)
    expect(readFileSync(taken.path, 'utf8').trim()).toBe(String(process.pid))
    taken.release()

    // A lock with no pid yet belongs to an instance that is starting; an old one was left by a crash.
    writeFileSync(join(dir, 'superagent.lock'), '')
    expect(() => acquireLock(dir)).toThrow(/being written by another superagent/)
    utimesSync(join(dir, 'superagent.lock'), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
    acquireLock(dir).release()
    // A pid that runs, but in a process that started after the lock was written, was reused (after a crash or a reboot):
    // the lock is taken over, and that process is left alone.
    const other = spawn('sleep', ['30'], { stdio: 'ignore' })
    try {
      if (!other.pid) throw new Error('sleep did not start')
      writeFileSync(join(dir, 'superagent.lock'), `${other.pid}\n`)
      utimesSync(join(dir, 'superagent.lock'), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
      const reused = acquireLock(dir)
      expect(readFileSync(reused.path, 'utf8').trim()).toBe(String(process.pid))
      expect(other.exitCode).toBeNull()
      reused.release()
      // The same process, with a lock written after it started, is taken as the holder.
      writeFileSync(join(dir, 'superagent.lock'), `${other.pid}\n`)
      expect(() => acquireLock(dir)).toThrow(`Another superagent (pid ${other.pid})`)
    } finally { other.kill() }

    // Release leaves a lock another process holds alone.
    writeFileSync(join(dir, 'superagent.lock'), '1\n')
    lock.release()
    expect(readFileSync(join(dir, 'superagent.lock'), 'utf8')).toBe('1\n')
  })
})
