/**
 * A small in-process stand-in for the prototype's durable `Effects` queue (phase 2 ports the SQLite one). The Engine calls
 * its ports inside a transaction, so work is only queued there and runs on a later tick, after the transaction returned.
 * One job per key: queueing a key that waits replaces its run function, as the prototype's `enqueue` replaces a payload.
 */

/** Thrown by a job that cannot run yet, such as one waiting for a worker slot: it runs again later without counting a failure. */
export class Later extends Error {}

export interface JobOptions { retries?: number; firstDelayMs?: number; maxDelayMs?: number }
interface Job { run: () => Promise<void>; attempts: number; timer?: NodeJS.Timeout; running: boolean; again: boolean; options: JobOptions }

export class Jobs {
  private readonly jobs = new Map<string, Job>()
  private closed = false
  /**
   * @param defer - runs `enqueue` once the caller's transaction commits (`Store.afterCommit`), so work a rolled-back command
   * queued never runs.
   * @param onDone - called after a job ran without an error, such as to clear the failures `onError` counted.
   */
  constructor(private readonly onError: (key: string, error: unknown, final: boolean) => void = () => {},
    private readonly defer: (run: () => void) => void = run => run(), private readonly onDone: (key: string) => void = () => {}) {}

  /** Queue `run` under `key`; it starts on the next tick. */
  enqueue(key: string, run: () => Promise<void>, options: JobOptions = {}): void {
    this.defer(() => this.add(key, run, options))
  }
  private add(key: string, run: () => Promise<void>, options: JobOptions): void {
    if (this.closed) return
    const existing = this.jobs.get(key)
    if (existing) {
      existing.run = run; existing.options = options
      if (existing.running) existing.again = true
      return
    }
    const job: Job = { run, attempts: 0, running: false, again: false, options }
    this.jobs.set(key, job)
    this.schedule(key, job, 0)
  }
  /** Runs the waiting jobs whose keys start with `prefix` now, such as launches once a worker slot frees. */
  wake(prefix: string): void {
    for (const [key, job] of this.jobs) if (key.startsWith(prefix) && !job.running) this.schedule(key, job, 0)
  }
  /** Whether a job is queued or running under `key`. */
  has(key: string): boolean { return this.jobs.has(key) }
  /** Resolves once no job is queued or running, for tests and shutdown. */
  async idle(timeoutMs = 5000): Promise<void> {
    const until = Date.now() + timeoutMs
    while (this.jobs.size && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5))
  }
  close(): void {
    this.closed = true
    for (const job of this.jobs.values()) clearTimeout(job.timer)
    this.jobs.clear()
  }

  private schedule(key: string, job: Job, delayMs: number): void {
    clearTimeout(job.timer)
    job.timer = setTimeout(() => { void this.execute(key, job) }, delayMs)
  }
  private async execute(key: string, job: Job): Promise<void> {
    if (this.closed || this.jobs.get(key) !== job) return
    job.running = true; job.again = false
    try {
      await job.run()
      job.running = false
      this.onDone(key)
      if (job.again) return this.schedule(key, job, 0)
      this.jobs.delete(key)
    } catch (error) {
      job.running = false
      if (error instanceof Later) return this.schedule(key, job, job.options.firstDelayMs ?? 1000)
      job.attempts++
      const retries = job.options.retries ?? 3
      const final = job.attempts > retries
      this.onError(key, error, final)
      if (final) { this.jobs.delete(key); return }
      const delay = Math.min((job.options.firstDelayMs ?? 2000) * 2 ** (job.attempts - 1), job.options.maxDelayMs ?? 60_000)
      this.schedule(key, job, delay)
    }
  }
}
