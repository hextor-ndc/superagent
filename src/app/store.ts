/**
 * Durable state in one SQLite file, modelled on the prototype's `src/app/store.ts`: the core's `Repositories` (Triggers,
 * Threads, Tickets, Decisions as JSON rows, with generated columns for the working sets a pass reads) and a key-value table
 * for this project's own records: each Ticket's t3code thread, outbox receipts, settings and the console thread.
 *
 * `atomic` nests through savepoints, and `afterCommit` runs work only once the outermost transaction commits, so a job
 * queued by a command that rolls back never runs.
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Decision, Repositories, Thread, Ticket, Trigger, TriggerDisposition } from '../../vendor/dsh/src/core/index.ts'

const SCHEMA = `
PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
CREATE TABLE IF NOT EXISTS trigger (id TEXT PRIMARY KEY, value TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS disposition (id TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS thread (key TEXT PRIMARY KEY, value TEXT NOT NULL,
  active INTEGER GENERATED ALWAYS AS (CASE WHEN json_array_length(value, '$.pending') > 0 OR json_type(value, '$.evaluating') IS NOT NULL THEN 1 END) VIRTUAL);
CREATE TABLE IF NOT EXISTS ticket (id TEXT PRIMARY KEY, value TEXT NOT NULL,
  open INTEGER GENERATED ALWAYS AS (CASE WHEN json_type(value, '$.ended') IS NULL THEN 1 END) VIRTUAL,
  active INTEGER GENERATED ALWAYS AS (CASE WHEN json_array_length(value, '$.undelivered') > 0
    OR value ->> '$.assignments[#-1].state' IN ('pending', 'running') THEN 1 END) VIRTUAL);
CREATE TABLE IF NOT EXISTS decision (id TEXT PRIMARY KEY, thread TEXT NOT NULL, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS thread_active ON thread(active) WHERE active IS NOT NULL;
CREATE INDEX IF NOT EXISTS ticket_open ON ticket(open) WHERE open IS NOT NULL;
CREATE INDEX IF NOT EXISTS ticket_active ON ticket(active) WHERE active IS NOT NULL;
CREATE INDEX IF NOT EXISTS decision_thread ON decision(thread);
`

export class Store implements Repositories {
  private readonly db: DatabaseSync
  private depth = 0
  private readonly committed: (() => void)[][] = []

  /** @param path a file, or `:memory:` for tests. */
  constructor(path: string, private readonly report: (error: unknown) => void = () => {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec(SCHEMA)
  }
  close(): void { this.db.close() }
  /**
   * Copies the whole database to `path` with `VACUUM INTO`, which gives a consistent copy in WAL mode. Must run outside any
   * transaction; throws when the copy fails or `path` exists.
   */
  backup(path: string): void {
    if (this.depth) throw new Error('A backup cannot run inside a transaction.')
    mkdirSync(dirname(path), { recursive: true })
    this.db.prepare('VACUUM INTO ?').run(path)
  }

  atomic<T>(work: () => T): T {
    const level = this.depth++
    const name = `atomic_${level}`
    this.committed[level] = []
    this.db.exec(`SAVEPOINT ${name}`)
    let value: T
    try { value = work(); this.db.exec(`RELEASE ${name}`) }
    catch (error) { this.db.exec(`ROLLBACK TO ${name}`); this.db.exec(`RELEASE ${name}`); throw error }
    finally { this.depth-- }
    const actions = this.committed.splice(level)[0] ?? []
    if (level) this.committed[level - 1]!.push(...actions)
    else for (const action of actions) { try { action() } catch (error) { this.report(error) } }
    return value
  }
  /** Runs `action` once the outermost transaction commits, or at once outside one; dropped when it rolls back. */
  afterCommit(action: () => void): void {
    if (this.depth) this.committed[this.depth - 1]!.push(action)
    else action()
  }

  private one<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    const row = this.db.prepare(sql).get(...params)
    return row ? JSON.parse(String(row.value)) as T : undefined
  }
  private all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params).map(row => JSON.parse(String(row.value)) as T)
  }
  private put(sql: string, ...params: SQLInputValue[]): void { this.db.prepare(sql).run(...params) }

  readonly triggers = {
    get: (id: string) => this.one<Trigger>('SELECT value FROM trigger WHERE id=?', id),
    save: (trigger: Trigger) => this.put('INSERT INTO trigger VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value, at=excluded.at',
      trigger.id, JSON.stringify(trigger), trigger.at),
    disposition: (id: string) => this.one<TriggerDisposition>('SELECT value FROM disposition WHERE id=?', id),
    saveDisposition: (id: string, value: TriggerDisposition) =>
      this.put('INSERT INTO disposition VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value', id, JSON.stringify(value)),
  }
  readonly threads = {
    get: (key: string) => this.one<Thread>('SELECT value FROM thread WHERE key=?', key),
    save: (thread: Thread) => this.put('INSERT INTO thread (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      thread.key, JSON.stringify(thread)),
    list: () => this.all<Thread>('SELECT value FROM thread ORDER BY rowid'),
    active: () => this.all<Thread>('SELECT value FROM thread WHERE active = 1 ORDER BY rowid'),
  }
  readonly tickets = {
    get: (id: string) => this.one<Ticket>('SELECT value FROM ticket WHERE id=?', id),
    save: (ticket: Ticket) => this.put('INSERT INTO ticket (id, value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
      ticket.id, JSON.stringify(ticket)),
    /** Newest first, as the core expects. */
    list: () => this.all<Ticket>('SELECT value FROM ticket ORDER BY rowid DESC'),
    open: () => this.all<Ticket>('SELECT value FROM ticket WHERE open = 1 ORDER BY rowid DESC'),
    active: () => this.all<Ticket>('SELECT value FROM ticket WHERE active = 1 ORDER BY rowid DESC'),
  }
  readonly decisions = {
    get: (id: string) => this.one<Decision>('SELECT value FROM decision WHERE id=?', id),
    save: (decision: Decision) => this.put('INSERT INTO decision VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value, thread=excluded.thread',
      decision.id, decision.threadKey, JSON.stringify(decision)),
    byThread: (key: string) => this.all<Decision>('SELECT value FROM decision WHERE thread=? ORDER BY rowid', key),
  }

  /** This project's own records, by key; `prefix` lists a family such as `ticket-thread:`. */
  readonly kv = {
    get: <T>(key: string) => this.one<T>('SELECT value FROM kv WHERE key=?', key),
    set: (key: string, value: unknown) => this.put('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value)),
    delete: (key: string) => this.put('DELETE FROM kv WHERE key=?', key),
    list: <T>(prefix: string) => this.all<T>("SELECT value FROM kv WHERE key LIKE ? ESCAPE '\\' ORDER BY rowid",
      `${prefix.replace(/[\\%_]/g, match => `\\${match}`)}%`),
  }
}
