/**
 * Worker slots, ported from the prototype's `WorkerSlots` (src/executor/dsh.ts). t3code has no global cap on running threads,
 * so the super agent keeps its own: a Ticket holds a slot while its thread runs a turn and while a launch or wake starts it.
 * A wake for a person's message may use one slot beyond the limit, so new work never makes a person wait.
 */
import { Later } from '../app/jobs.ts'

export class WorkerSlots {
  private readonly starting = new Map<string, 'launch' | 'wake' | 'person'>()
  constructor(private readonly running: () => string[], private readonly max: () => number) {}

  used(): number { return new Set([...this.running(), ...this.starting.keys()]).size }
  /** Reserves a starting slot; idempotent for a Ticket that holds one. @throws Later when none is free. */
  reserve(ticketId: string, by: 'launch' | 'wake' | 'person'): void {
    if (this.starting.has(ticketId) || this.running().includes(ticketId)) return
    if (this.used() >= this.max() + (by === 'person' ? 1 : 0)) throw new Later('No worker slot is free')
    this.starting.set(ticketId, by)
  }
  free(ticketId: string): void { this.starting.delete(ticketId) }
}
