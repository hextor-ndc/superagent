/**
 * The Router's tools, ported from the prototype's main-Session tools (src/app/tools/main.ts) with the same names and
 * arguments, so its prompts apply unchanged. Every authorization rule stays in the Engine and the Policy: a tool only turns
 * the model's choice into an Engine command, which may refuse it.
 */
import { z } from 'zod'
import { UserError, reasonText, threadKey, type Decision, type Engine, type Ticket, type Trigger } from '../../vendor/dsh/src/core/index.ts'
import { assessmentOutcome, RuleAssessmentSchema, type Settings } from '../../vendor/dsh/src/policy.ts'
import { CONSOLE } from '../app/console-source.ts'
import { projectHint, type ProjectBinding } from '../app/projects.ts'
import type { ProjectPreview, TicketView } from '../app/runtime.ts'
import type { Store } from '../app/store.ts'

export interface RouterToolHost {
  engine: () => Pick<Engine, 'candidate' | 'decide' | 'attach' | 'reply' | 'requestStatus' | 'note' | 'retryTicket' | 'reevaluate' | 'unsubscribe'>
  store: Pick<Store, 'tickets' | 'triggers' | 'threads' | 'decisions'>
  settings: () => Settings
  view: (ticket: Ticket) => TicketView
  /** A ticket's project, as bound at its accept. */
  projectOf?: (ticketId: string) => ProjectBinding | undefined
  /** Where an accept of these Triggers would be bound now, or why it would be refused (`Runtime.projectPreview`). */
  projectPreview?: (triggers: Trigger[]) => ProjectPreview
  /** Why a ticket takes no more messages after `superagent_reroute`; undefined for a ticket that was not rerouted. */
  rerouted?: (ticketId: string) => string | undefined
}

export interface RouterTool<S extends z.ZodType = z.ZodType> { name: string; description: string; schema: S; run: (args: z.infer<S>) => unknown }
const tool = <S extends z.ZodType>(definition: RouterTool<S>): RouterTool => definition as unknown as RouterTool

const ACK_WORDS = 100
const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length
const fromDecision = (decision: Decision) => ({ decision: decision.kind, reason: reasonText(decision.reason), ticket_id: decision.ticketId })
const WorktreeName = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(40)
  .describe('A short English kebab-case name for the branch and worktree, such as fix-readme-heading.')

const RouteItem = z.object({
  kind: z.enum(['accept', 'attach', 'ignore', 'stop']),
  trigger_id: z.string().describe('The candidate card\'s trigger_id; deciding it decides its batch.'),
  ticket_id: z.string().nullish().describe('attach and stop: the ticket.'),
  title: z.string().max(200).nullish().describe('accept: a short label of the original request; no added requirements.'),
  worktree_name: WorktreeName.nullish(),
  acknowledgement: z.string().nullish().describe(`accept: one brief sentence of at most ${ACK_WORDS} words naming the concrete change and intended result, in the source's language; posted as a reply to the source.`),
  note: z.string().max(1000).nullish().describe('accept and attach: a routing note for the worker; context, not the request.'),
  reason: z.string().max(500).nullish().describe('ignore and stop: why; an ignore needs it.'),
})
type RouteItem = z.infer<typeof RouteItem>
const NEEDS: Record<RouteItem['kind'], (keyof RouteItem)[]> = { accept: ['title', 'worktree_name', 'acknowledgement'], attach: ['ticket_id'],
  stop: ['ticket_id'], ignore: ['reason'] }

const Assessment = z.object({
  trigger_id: z.string().min(1),
  decision: z.enum(['accept', 'ignore', 'unavailable']),
  rule_assessments: z.array(RuleAssessmentSchema).describe('Exactly one judgement for every enabled rule.'),
  direction: z.object({ implementation_requested: z.boolean(), target_basis: z.enum(['specified', 'existing-standard', 'undetermined']),
    requires_design_decision: z.boolean(), evidence: z.string().min(1).max(700) }),
  title: z.string().min(1).max(200),
  scope: z.string().min(1).max(1500),
  reason: z.string().min(1).max(500),
  intent_evidence: z.string().max(700).nullish(),
  acknowledgement: z.string().nullish(),
  worktree_name: WorktreeName.optional(),
})

export function routerTools(host: RouterToolHost): RouterTool[] {
  const engine = host.engine
  const ticket = (id: string) => { const found = host.store.tickets.get(id); if (!found) throw new UserError('unknownTicket'); return found }
  return [
    tool({
      name: 'orchestrator_read',
      description: 'Read one page of a resource: `tickets` (open first), `ticket/<id>`, `trigger/<id>` or `thread/<key>`. Follow next_offset.',
      schema: z.object({ resource: z.string().min(1), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(8000).default(4000) }),
      run: ({ resource, offset, limit }) => page(read(host, resource), offset, limit),
    }),
    tool({
      name: 'orchestrator_route',
      description: 'Route candidates, one item each by the card\'s trigger_id, in one call: accept an explicit request as a new ticket, attach a '
        + 'trigger to an existing ticket, stop a ticket on a person\'s stop message, or ignore a candidate that needs no ticket or stop. Items run '
        + 'in order and each is answered on its own. Accepting an inferred candidate goes through orchestrator_eval_decide.',
      schema: z.object({ decisions: z.array(RouteItem).min(1).max(20) }),
      run: ({ decisions }) => ({ results: decisions.map(item => {
        const head = { trigger_id: item.trigger_id, kind: item.kind }
        const missing = NEEDS[item.kind].find(field => !item[field] || String(item[field]).trim() === '')
        if (missing) return { ...head, refused: `${item.kind} needs ${missing}` }
        if (item.kind === 'accept' && words(item.acknowledgement!) > ACK_WORDS) return { ...head, refused: `acknowledgement has more than ${ACK_WORDS} words` }
        try { return { ...head, ...route(host, item) } }
        catch (error) { return { ...head, refused: error instanceof Error ? error.message : String(error) } }
      }) }),
    }),
    tool({
      name: 'orchestrator_reply',
      description: 'Send a message for a ticket where the rules allow it: `answer` to a person\'s question its worker answered (trigger_id), '
        + '`result` once the ticket is ready, `attention` with its open question copied exactly into human_action.',
      schema: z.object({ purpose: z.enum(['answer', 'result', 'attention']), ticket_id: z.string().optional(), trigger_id: z.string().optional(),
        human_action: z.string().optional(), text: z.string().min(1).max(4000) }),
      run: args => engine().reply({ purpose: args.purpose, text: args.text, ...args.ticket_id ? { ticketId: args.ticket_id } : {},
        ...args.trigger_id ? { triggerId: args.trigger_id } : {}, ...args.human_action ? { question: args.human_action } : {} }),
    }),
    tool({
      name: 'orchestrator_eval',
      description: 'Context for assessing a proactive (inferred) candidate: its batch, the thread\'s tickets and the enabled rules.',
      schema: z.object({ trigger_id: z.string() }),
      run: ({ trigger_id }) => {
        const candidate = engine().candidate(trigger_id)
        if (!candidate) return { error: 'No Eval holds this trigger now; it was decided or requeued.' }
        return { trigger_id, strength: candidate.strength, thread: candidate.thread.key, policy_version: candidate.policyVersion,
          triggers: candidate.triggers.map(trigger => ({ trigger_id: trigger.id, from: trigger.actor.id, at: trigger.at, text: trigger.text.slice(0, 4000) })),
          tickets: candidate.tickets.slice(0, 8).map(host.view),
          rules: host.settings().policy.rules.filter(rule => rule.enabled).map(rule => ({ rule_id: rule.id, name: rule.name, instruction: rule.instruction })) }
      },
    }),
    tool({
      name: 'orchestrator_eval_read',
      description: 'The full text of a trigger an Eval holds or that a card names.',
      schema: z.object({ trigger_id: z.string() }),
      run: ({ trigger_id }) => {
        const trigger = host.store.triggers.get(trigger_id)
        if (!trigger) throw new UserError('unknownTrigger')
        return { trigger_id, from: trigger.actor.id, at: trigger.at, url: trigger.url, text: trigger.text }
      },
    }),
    tool({
      name: 'orchestrator_eval_decide',
      description: 'Decide a proactive candidate after orchestrator_eval: judge every enabled rule once, state the direction, and accept or ignore. '
        + 'The Policy accepts only with a settled direction and a matched rule, and only in auto mode; otherwise it records what you would have done.',
      schema: Assessment,
      run: ({ trigger_id, ...assessment }) => {
        const candidate = engine().candidate(trigger_id)
        if (!candidate) return { error: 'No Eval holds this trigger now; it was decided or requeued.' }
        const outcome = assessmentOutcome({ ...assessment, worktree_name: assessment.worktree_name ?? undefined }, host.settings(), candidate.strength)
        const named = outcome.kind === 'accept' ? { ...outcome, name: assessment.worktree_name ?? assessment.title,
          ...assessment.acknowledgement ? { acknowledgement: acknowledgement(host, candidate.triggers, assessment.acknowledgement) } : {} } : outcome
        return fromDecision(engine().decide(trigger_id, { ...named, evalId: candidate.evalId }))
      },
    }),
    tool({
      name: 'orchestrator_ticket_note',
      description: 'Give a ticket\'s worker a fact from other work, as context that grants nothing.',
      schema: z.object({ ticket_id: z.string(), text: z.string().min(1).max(2000) }),
      run: ({ ticket_id, text }) => ({ noted: !!engine().note(ticket(ticket_id).id, text) }),
    }),
    tool({
      name: 'orchestrator_ticket_retry',
      description: 'Start a blocked or failed ticket again, when a person asked for it.',
      schema: z.object({ ticket_id: z.string() }),
      run: ({ ticket_id }) => host.view(engine().retryTicket(ticket(ticket_id).id)),
    }),
    tool({
      name: 'orchestrator_ticket_request_status',
      description: 'Ask a waiting worker for its status; it reports back.',
      schema: z.object({ ticket_id: z.string() }),
      run: ({ ticket_id }) => ({ asked: engine().requestStatus(ticket(ticket_id).id) }),
    }),
    tool({
      name: 'orchestrator_trigger_requeue',
      description: 'Queue a stored trigger for a fresh Eval.',
      schema: z.object({ trigger_id: z.string() }),
      run: ({ trigger_id }) => ({ queued: engine().reevaluate(trigger_id) }),
    }),
    tool({
      name: 'orchestrator_thread_unsubscribe',
      description: 'Drop every ticket\'s subscription to a thread, when a person asks the agent to stop following it.',
      schema: z.object({ thread: z.string() }),
      run: ({ thread }) => ({ unsubscribed: engine().unsubscribe(thread) }),
    }),
  ]
}

/**
 * The acknowledgement an accept posts, with the project it goes to in front (`[<key>] `) when the request came from the
 * console, so the operator sees where the work landed (plan, 3.7). GitHub replies are public and get no prefix, since a key
 * can be a local folder's path.
 */
function acknowledgement(host: RouterToolHost, triggers: Trigger[], text: string): string {
  if (!host.projectPreview || !triggers.some(trigger => trigger.source === CONSOLE)) return text
  const preview = host.projectPreview(triggers)
  if ('refused' in preview) return text
  const prefix = `[${preview.key}]`
  return text.trimStart().startsWith(prefix) ? text : `${prefix} ${text}`
}

/**
 * Why `trigger` may not be attached to `ticketId`: the request names a project explicitly (the operator's `project`, or the
 * GitHub repository's), and the ticket is bound to another one. The Engine's attach knows nothing of projects. A hint a
 * follow-up inherited does not count, so a worker's handback can still go to a ticket in another project.
 */
function crossProject(host: RouterToolHost, ticketId: string, trigger: Trigger | undefined): string | undefined {
  const hint = trigger && projectHint(trigger)
  if (!trigger || !hint || hint.by === 'inherited' || !host.projectPreview) return undefined
  const binding = host.projectOf?.(host.store.tickets.get(ticketId)?.id ?? ticketId)
  if (!binding) return undefined
  const preview = host.projectPreview([trigger])
  if ('refused' in preview) return `The request names project ${hint.project}, which cannot take work: ${preview.refused}`
  if (preview.id === binding.projectId) return undefined
  return `The request names project ${preview.key}, and ticket ${ticketId} is in ${binding.key}: a request is never attached to a ticket in `
    + 'another project. Accept it as its own ticket, or ignore it.'
}

function route(host: RouterToolHost, item: RouteItem) {
  const engine = host.engine()
  const note = item.note ? { note: item.note } : {}
  switch (item.kind) {
    case 'accept': {
      const triggers = engine.candidate(item.trigger_id)?.triggers ?? [host.store.triggers.get(item.trigger_id) ?? []].flat()
      const decision = engine.decide(item.trigger_id, { kind: 'accept', title: item.title!, scope: item.title!, reason: { code: 'explicitRouted' },
        acknowledgement: acknowledgement(host, triggers, item.acknowledgement!), name: item.worktree_name!, ...note })
      if (decision.kind !== 'accept' || !decision.ticketId) return { refused: `Ticket was not created: ${reasonText(decision.reason)}` }
      return fromDecision(decision)
    }
    case 'attach': {
      // An attach would resume a rerouted ticket that had ended, in the project it was moved out of.
      const moved = host.rerouted?.(host.store.tickets.get(item.ticket_id!)?.id ?? item.ticket_id!)
      if (moved) return { refused: `${moved} Attach the message to that ticket, or accept it as its own.` }
      const refused = crossProject(host, item.ticket_id!, host.store.triggers.get(item.trigger_id))
      if (refused) return { refused }
      const ticket = engine.attach(item.ticket_id!, item.trigger_id, item.note ?? undefined)
      return { reason: 'Attached: the ticket follows the trigger\'s thread and receives it', ticket_id: ticket.id }
    }
    case 'stop':
      return fromDecision(engine.decide(item.trigger_id, { kind: 'stop', ticketId: item.ticket_id!, reason: item.reason || { code: 'humanStop' } }))
    case 'ignore':
      return fromDecision(engine.decide(item.trigger_id, { kind: 'ignore', reason: item.reason! }))
  }
}

function read(host: RouterToolHost, resource: string): string {
  const json = (value: unknown) => JSON.stringify(value, null, 2)
  if (resource === 'tickets') {
    const tickets = host.store.tickets.list().map(host.view)
    return json([...tickets.filter(view => !view.outcome), ...tickets.filter(view => view.outcome)].slice(0, 50))
  }
  const slash = resource.indexOf('/')
  const kind = resource.slice(0, slash), id = resource.slice(slash + 1)
  if (kind === 'ticket') {
    const ticket = host.store.tickets.get(id)
    if (!ticket) throw new UserError('unknownTicket')
    return json({ ...host.view(ticket), scope: ticket.mandate.scope, strength: ticket.mandate.strength, origin: ticket.origin,
      follows: ticket.follows ?? [], assignments: ticket.assignments.slice(-3).map(item => ({ state: item.state, report: item.report })) })
  }
  if (kind === 'trigger') {
    const trigger = host.store.triggers.get(id)
    if (!trigger) throw new UserError('unknownTrigger')
    return json({ trigger_id: trigger.id, from: trigger.actor.id, at: trigger.at, thread: threadKey(trigger.threads[0]!), url: trigger.url,
      text: trigger.text, disposition: host.store.triggers.disposition(id) })
  }
  if (kind === 'thread') {
    const thread = host.store.threads.get(id)
    if (!thread) throw new Error(`No thread ${id}`)
    return json({ thread: thread.key, tickets: thread.subscriptions.flatMap(ticketId => host.store.tickets.get(ticketId) ?? []).map(host.view),
      decisions: host.store.decisions.byThread(id).slice(-10).map(decision => ({ kind: decision.kind, reason: reasonText(decision.reason), ticket_id: decision.ticketId })) })
  }
  throw new Error('Read `tickets`, `ticket/<id>`, `trigger/<id>` or `thread/<key>`')
}

function page(text: string, offset: number, limit: number) {
  const end = Math.min(text.length, offset + limit)
  return { text: text.slice(offset, end), ...end < text.length ? { next_offset: end } : {} }
}
