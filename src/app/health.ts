/**
 * What each part of the super agent last reported about itself: the Watchdog reads it to tell an infrastructure fault from a
 * stuck worker. A part counts as failing after three failures in a row, as in the prototype's health entries.
 */
export interface HealthEntry { ok: boolean; lastOk?: string; lastError?: string; error?: string; failures: number }

export class Health {
  private readonly entries = new Map<string, HealthEntry>()
  readonly startedAt = new Date().toISOString()

  ok(name: string): void {
    this.entries.set(name, { ...this.entries.get(name), ok: true, lastOk: new Date().toISOString(), failures: 0, error: undefined })
  }
  /** Clears the failures of a part that has failed before; a part that never failed gets no entry. */
  recovered(name: string): void {
    if (this.entries.get(name)?.failures) this.ok(name)
  }
  fail(name: string, error: unknown): void {
    const entry = this.entries.get(name)
    const failures = (entry?.failures ?? 0) + 1
    this.entries.set(name, { ...entry, ok: failures < 3, failures, lastError: new Date().toISOString(),
      error: (error instanceof Error ? error.message : String(error)).slice(0, 500) })
  }
  snapshot(): Record<string, HealthEntry> { return Object.fromEntries(this.entries) }
  /** The parts failing now. */
  failing(): string[] { return [...this.entries].filter(([, entry]) => !entry.ok).map(([name]) => name) }
}
