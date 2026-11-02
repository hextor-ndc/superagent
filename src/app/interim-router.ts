/**
 * A rule-based stand-in for the Router until phase 2 brings the model-backed one (the paper's resident Router Session). It
 * keeps to what needs no judgement:
 * - an explicit request (an allowed person addressed the agent) is accepted as one Ticket;
 * - proactive (inferred) candidates are ignored, so nothing proactive happens without the real Router;
 * - a worker's `ready` report goes back to the requester as the result, and its question as the attention message.
 */
import type { Candidate, EngineForMainSession, Ticket, Trigger, WorkerReport } from '../../vendor/dsh/src/core/index.ts'
import type { Router } from '../router/claude-router.ts'
import type { Jobs } from './jobs.ts'

export class InterimRouter implements Router {
  constructor(private readonly jobs: Jobs, private readonly engine: () => Pick<EngineForMainSession, 'candidateDelivered' | 'decide' | 'reply'>,
    private readonly log: (message: string, error?: unknown) => void = () => {}) {}

  request(candidate: Candidate): void {
    this.jobs.enqueue(`assess:${candidate.evalId}`, async () => {
      const engine = this.engine()
      engine.candidateDelivered(candidate.evalId)
      const trigger = candidate.triggers.findLast(item => item.human) ?? candidate.triggers.at(-1)!
      if (candidate.strength !== 'explicit') {
        engine.decide(trigger.id, { kind: 'ignore', evalId: candidate.evalId,
          reason: 'Proactive work needs the model-backed Router, which this deployment does not run yet.' })
        return
      }
      engine.decide(trigger.id, { kind: 'accept', evalId: candidate.evalId, title: titleOf(trigger), scope: scopeOf(candidate.triggers),
        reason: 'Explicit request from an allowed person.', name: titleOf(trigger) })
    })
  }

  /** Relays a worker's report to the people who asked, as the Router would. */
  reported(ticket: Ticket, report: WorkerReport): void {
    try {
      const engine = this.engine()
      if (report.question) engine.reply({ purpose: 'attention', ticketId: ticket.id, question: report.question, text: report.question })
      // Blocked and failed Tickets wait for a person in the console's attention queue; only a result goes out on its own.
      else if (report.state === 'ready') engine.reply({ purpose: 'result', ticketId: ticket.id, text: `Done: ${report.summary}` })
    } catch (error) { this.log(`relaying the report of ${ticket.id} failed`, error) }
  }
}

const titleOf = (trigger: Trigger): string => trigger.text.split('\n').find(line => line.trim())?.trim().slice(0, 80) || 'Request'
const scopeOf = (triggers: Trigger[]): string => triggers.map(trigger => trigger.text.trim()).join('\n').slice(0, 1500)
