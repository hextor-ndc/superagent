/**
 * A rule-based stand-in for the Router until phase 2 brings the model-backed one (the paper's resident Router Session). It
 * keeps to what needs no judgement:
 * - a new explicit request (an allowed person addressed the agent) is accepted as one Ticket. A message a ticket's worker
 *   had as a follow-up and that ticket let go when it ended is not new work by these rules, and neither is an unaddressed
 *   comment, such as one on a stopped ticket's Issue: both are ignored. One the worker handed back as beyond its ticket is
 *   accepted, addressed or not, since the worker judged it new work;
 * - a stop on a ticket's own thread: an addressed follow-up from a person whose words start, after mentions of the agent
 *   only, with "stop" (or "cancel", optionally with "please", "it", "now", "this" or "the work", then nothing or punctuation
 *   but no word joined on, as in "stop-gap" or "cancel_order") stops the one open ticket it reached; the Engine takes it only
 *   from a sender on the allowed list. A review's or an inline comment's words are its body, without its decision or the code
 *   it is on (`meta.body`). Anything longer, such as "stop using lodash", a message that starts by mentioning someone else or mentions anyone else after the stop, one that goes on
 *   with "but", "actually", "instead", "keep", "continue" or "resume", and any message while the ticket waits on a person's
 *   answer (it is the answer) stays with the worker. The stop is kept in the store until the Engine took it, so a restart
 *   or a failed attempt does not lose it;
 * - proactive (inferred) candidates are ignored, so nothing proactive happens without the real Router;
 * - a request no project can take now (the legacy project's checkout is gone, say) is ignored with the reason, as binding it
 *   would fail;
 * - a worker's `ready` report goes back to the requester as the result, and its question as the attention message.
 */
import { liveTicket, UserError, type Candidate, type EngineForMainSession, type Ticket, type Trigger, type WorkerReport }
  from '../../vendor/dsh/src/core/index.ts'
import type { Router } from '../router/claude-router.ts'
import type { Jobs } from './jobs.ts'
import type { Store } from './store.ts'

/** A stop the rules read on a ticket's thread, kept in the store until the Engine decided it. */
interface PendingStop { triggerId: string; ticketId: string }
const STOPS = 'interim-stop:'
const STOP_REASON = 'The person asked to stop on the ticket\'s thread.'

export class InterimRouter implements Router {
  /**
   * @param agents - the agent's own account names (its GitHub login); a mention of anyone else is not addressed to it.
   * @param projectRefusal - why an accept of these Triggers would be refused at its binding to a project (`Runtime.projectRefusal`);
   *   undefined when it would bind.
   */
  constructor(private readonly jobs: Jobs, private readonly engine: () => Pick<EngineForMainSession, 'candidateDelivered' | 'decide' | 'reply'>,
    private readonly store: Pick<Store, 'tickets' | 'triggers' | 'kv'>, private readonly log: (message: string, error?: unknown) => void = () => {},
    private readonly agents: string[] = [], private readonly projectRefusal: (triggers: Trigger[]) => string | undefined = () => undefined) {}

  /** Runs the stops a previous run read but did not get to decide. */
  start(): void {
    for (const stop of this.store.kv.list<PendingStop>(STOPS)) this.queueStop(stop)
  }

  request(candidate: Candidate): void {
    this.jobs.enqueue(`assess:${candidate.evalId}`, async () => {
      const engine = this.engine()
      engine.candidateDelivered(candidate.evalId)
      const fallback = candidate.triggers.findLast(item => item.human) ?? candidate.triggers.at(-1)!
      const ignore = (reason: string) => { engine.decide(fallback.id, { kind: 'ignore', evalId: candidate.evalId, reason }) }
      if (candidate.strength !== 'explicit') return ignore('Proactive work needs the model-backed Router, which this deployment does not run yet.')
      // A person's request: one addressed to the agent, or one a worker handed back as new work whether it was addressed or not.
      const asked = candidate.triggers.filter(item => item.human && (item.addressed || this.handedBack(item)))
      const fresh = asked.filter(item => !this.keptBy(candidate, item).length)
      if (!fresh.length) {
        return ignore(asked.length
          ? 'A follow-up its ticket\'s worker had, let go when the ticket ended; the rules router takes only new requests. Ask again, or start it from the console.'
          : 'Not addressed to the agent; the rules router takes only requests addressed to it.')
      }
      const trigger = fresh.at(-1)!
      // The rules cannot judge a project. An accept no project can take would throw in the Engine's prepareTicket and fail this
      // job on every try, with nobody told, so it is ignored with the reason (plan, 3.2).
      const refused = this.projectRefusal(candidate.triggers)
      if (refused) return ignore(`No project can take this request: ${refused}`)
      engine.decide(trigger.id, { kind: 'accept', evalId: candidate.evalId, title: titleOf(trigger), scope: scopeOf(fresh),
        reason: 'Explicit request from an allowed person.', name: titleOf(trigger) })
    })
  }

  /**
   * Stops the one open ticket a person's "stop" on its own thread reached; any other follow-up is its worker's alone. Called
   * inside the Engine's transaction, so the stop is stored with the trigger and runs once that commits.
   */
  followup(trigger: Trigger, tickets: Ticket[]): void {
    // A review's text starts with its decision and an inline comment's with its file and diff; the person's words are the body.
    const said = typeof trigger.meta.body === 'string' ? trigger.meta.body : trigger.text
    if (!trigger.human || !trigger.addressed || !isStop(said, this.agents)) return
    if (tickets.length !== 1) {
      this.log(`a stop on ${trigger.id} reached ${tickets.length} tickets; stop the right one from the console`)
      return
    }
    // A ticket that waits on a person's answer takes this message as the answer ("stop" to "Should I go on?"); its worker decides.
    if (tickets[0]!.attention) return
    const stop = { triggerId: trigger.id, ticketId: tickets[0]!.id }
    this.store.kv.set(`${STOPS}${trigger.id}`, stop)
    this.queueStop(stop)
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

  /** Decides a stored stop, and forgets it once the Engine took it or refused it; any other error leaves it to retry. */
  private queueStop({ triggerId, ticketId }: PendingStop): void {
    this.jobs.enqueue(`stop:${triggerId}`, async () => {
      const ticket = this.store.tickets.get(ticketId)
      // A ticket that ended meanwhile, or a stop decided before a restart, needs nothing more.
      if (ticket && liveTicket(ticket)) {
        // The Engine refuses a stop from a sender off the allowed list (an ignore Decision); a UserError is a lasting refusal.
        try { this.engine().decide(triggerId, { kind: 'stop', ticketId, reason: STOP_REASON }) }
        catch (error) {
          if (!(error instanceof UserError)) throw error
          this.log(`stopping ${ticketId} on ${triggerId} was refused`, error)
        }
      }
      this.store.kv.delete(`${STOPS}${triggerId}`)
    })
  }

  /** Whether a ticket's worker handed `trigger` back as beyond its ticket. */
  private handedBack(trigger: Trigger): boolean { return !!this.store.triggers.disposition(trigger.id)?.handbacks?.length }

  /** The tickets on the candidate's thread that had `trigger` as their own follow-up (not for context) and did not hand it back. */
  private keptBy(candidate: Candidate, trigger: Trigger): Ticket[] {
    const returned = new Set(this.store.triggers.disposition(trigger.id)?.handbacks?.map(item => item.ticketId))
    return candidate.tickets.flatMap(item => this.store.tickets.get(item.id) ?? []).filter(ticket => !returned.has(ticket.id)
      && ticket.inputs.some(input => input.kind === 'trigger' && input.triggerId === trigger.id && !input.context))
  }
}

/** The stop phrase, then no further word: not one after spaces, nor one joined on ("stop-gap", "stop/start", "cancel_order", "stop's"). */
const STOP = /^(?:please\s+)?(?:stop|cancel)(?:\s+(?:it|now|this|that|the work|work|working|please))?(?![ \t]*[\p{L}\p{N}])(?![-_/'’][\p{L}\p{N}])/iu
const LEADING_MENTIONS = /^(?:\s*@[\w-]+(?:\[bot\])?[,:]?)+/
const MENTION = /(?<![\w@])@([\w-]+)(?:\[bot\])?/g
/** Words after a stop that take it back or narrow it: "stop. Actually keep going", "stop, but leave the tests". */
const UNLESS = /\b(?:but|actually|instead|keep|continue|resume)\b/i
const accountName = (name: string): string => name.replace(/\[bot\]$/i, '').toLowerCase()

/**
 * Whether a message asks the agent only to stop: "@bot stop", "@bot please stop.", "@bot stop, we changed plans", "stop @bot".
 * `agents` are the agent's account names; a message that starts by mentioning anyone else, or mentions anyone else after the
 * stop, is not one ("@bob stop! @bot rebase please").
 */
export function isStop(text: string, agents: string[] = []): boolean {
  const names = new Set(agents.map(accountName))
  const ours = (mentions: string) => [...mentions.matchAll(MENTION)].every(match => names.has(accountName(match[1]!)))
  const leading = LEADING_MENTIONS.exec(text)?.[0] ?? ''
  if (!ours(leading)) return false
  const rest = text.slice(leading.length).trim()
  const stop = STOP.exec(rest)
  if (!stop) return false
  const tail = rest.slice(stop[0].length)
  return ours(tail) && !UNLESS.test(tail)
}

const titleOf = (trigger: Trigger): string => trigger.text.split('\n').find(line => line.trim())?.trim().slice(0, 80) || 'Request'
const scopeOf = (triggers: Trigger[]): string => triggers.map(trigger => trigger.text.trim()).join('\n').slice(0, 1500)
