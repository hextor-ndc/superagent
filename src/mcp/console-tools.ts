/**
 * Point 2: the console tools, which the agent of the Superagent thread in t3code uses to run the super agent for the
 * operator. `superagent_attention` also carries the MCP App of point 3.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { liveTicket, reasonText, threadKey, type Decision, type Ticket, type Trigger } from '../../vendor/dsh/src/core/index.ts'
import { CONSOLE, consoleThread, consoleTrigger, type ConsoleHint } from '../app/console-source.ts'
import type { Runtime } from '../app/runtime.ts'
import { shortId } from '../executor/render.ts'
import { BINDING_PREFIX, denied, rerouteKey, STATUSES, type ProjectBinding, type ProjectEntry, type ProjectStatus, type Rerouted } from '../app/projects.ts'
import type { PendingQuestion, PendingRequest } from '../t3/client.ts'
import { ATTENTION_URI, MCP_APP_MIME, attentionPage } from './attention-app.ts'
import { ok } from './result.ts'
import { alerts, dismissAlert, lastCheck } from './watchdog-tools.ts'

/** The console actions, shared by the MCP tools and the panel's HTTP API. */
export function consoleActions(runtime: Runtime) {
  const { engine } = runtime
  const ticket = (id: string) => {
    const found = runtime.findTicket(id)
    if (!found) throw new Error(`No ticket ${id}`)
    return found
  }
  /** One ticket in detail, for `superagent_ticket`. */
  const detail = (found: Ticket) => ({ ...runtime.view(found), scope: found.mandate.scope, strength: found.mandate.strength,
    assignments: found.assignments.map(item => ({ id: item.id, state: item.state, report: item.report })),
    inputs: found.inputs.length, undelivered: found.undelivered.length,
    messages: runtime.outbox.list(record => record.message.ticketId === found.id).map(record => ({ kind: record.message.kind, status: record.status,
      text: record.message.text })) })
  return {
    superagent_status: () => {
      const tickets = runtime.tickets()
      const open = tickets.filter(view => !view.outcome)
      return { paused: runtime.settings.paused, workers: runtime.executor.load(), open: open.length,
        waiting_for_a_person: open.filter(view => view.stage.startsWith('person/')).length,
        console: runtime.console?.link, panel: runtime.panelUrl(), failing: runtime.health.failing(),
        watchdog: runtime.watchdog ? { thread: runtime.watchdog.link ?? runtime.watchdog.threadId, last_check: lastCheck(runtime) ?? null } : null,
        alerts: alerts(runtime).length, recent: tickets.slice(0, 15) }
    },
    superagent_attention: async () => ({ tickets: runtime.attention(), ignored: runtime.ignoredRequests(), to_review: await runtime.toReview(),
      alerts: alerts(runtime) }),
    superagent_dismiss_alert: ({ alert_id }: { alert_id: string }) => ({ dismissed: dismissAlert(runtime, alert_id) }),
    superagent_ticket: ({ ticket_id }: { ticket_id: string }) => {
      const found = runtime.findTicket(ticket_id)
      if (found) return detail(found)
      // The trigger id superagent_request returned: its ticket once there is one, else what became of the request.
      const trigger = runtime.repo.triggers.get(ticket_id.trim())
      if (!trigger) throw new Error(`No ticket or request ${ticket_id}`)
      const made = runtime.repo.tickets.list().find(item => item.origin.triggerIds.includes(trigger.id))
      if (made) return { trigger_id: trigger.id, ...detail(made) }
      const outcome = requestOutcome(runtime, trigger)
      return { trigger_id: trigger.id, text: trigger.text, ...outcome }
    },
    superagent_projects: async ({ query, status, limit = 25, refresh }: { query?: string; status?: ProjectStatus; limit?: number; refresh?: boolean }) => {
      let refreshError: string | undefined
      if (refresh) await runtime.projects.refresh().catch(error => { refreshError = error instanceof Error ? error.message : String(error) })
      return projectRows(runtime, { query, status, limit, refreshError })
    },
    superagent_request: async ({ text, project, wait_seconds = WAIT_SECONDS }: { text: string; project?: string; wait_seconds?: number }) => {
      // The project is checked before anything is stored, by the rules its binding applies; a refused request leaves nothing.
      const { entry, hint } = await runtime.requestProject(project)
      const trigger = consoleTrigger(runtime.config.operator, text, undefined, hint)
      engine.receive(trigger)
      return { trigger_id: trigger.id, filed_in: hint ? entry.key : `${entry.key}, the default for requests that name no project`,
        ...await awaitOutcome(runtime, trigger, wait_seconds * 1000) }
    },
    superagent_reroute: async ({ ticket_id, project, wait_seconds = WAIT_SECONDS }: { ticket_id: string; project: string; wait_seconds?: number }) => {
      const found = ticket(ticket_id)
      const binding = runtime.binding(found.id)
      const origin = runtime.repo.triggers.get(found.origin.triggerId)
      if (!origin) throw new Error(`${found.title} has no request to file again.`)
      const thread = runtime.executor.thread(found.id)
      const root = binding?.root
      const report = (stopped: Ticket, filed: { trigger_id: string; filed_in: string } & RequestOutcome) => ({
        stopped: { ticket_id: stopped.id, short: shortId(stopped.id), outcome: stopped.ended?.outcome ?? null, ...binding ? { project: binding.key } : {},
          ...thread?.link ? { link: thread.link } : {} },
        filed,
        ...thread?.branch && root ? { leftover: { branch: thread.branch, worktree: thread.worktreePath,
          cleanup: [`git -C ${quote(root)} worktree remove ${quote(thread.worktreePath)}`, `git -C ${quote(root)} branch -D ${quote(thread.branch)}`],
          note: 'The stopped ticket\'s branch and worktree stay. The super agent deletes nothing: run these when nothing in them is wanted '
            + '(branch -D also drops commits that are not merged).' } } : {},
      })
      // A repeated call (an agent whose call timed out tries again) gets the first filing back rather than a second ticket.
      const earlier = runtime.repo.kv.get<Rerouted>(rerouteKey(found.id))
      if (earlier) {
        const same = runtime.projects.resolve(project).found?.id === earlier.projectId
        if (!same) {
          throw new Error(`${found.title} was rerouted to ${earlier.key} already, as request ${earlier.triggerId}. To move the work again, `
            + 'reroute the ticket that request made.')
        }
        const trigger = runtime.repo.triggers.get(earlier.triggerId)!
        return { repeated: true, ...report(found, { trigger_id: trigger.id, filed_in: earlier.key, ...await awaitOutcome(runtime, trigger, wait_seconds * 1000) }) }
      }
      const { entry, hint } = await runtime.requestProject(project)
      if (binding?.projectId === entry.id) throw new Error(`${found.title} is in ${entry.key} already.`)
      // The new request is checked first, so a reroute that cannot be filed leaves the ticket running.
      const stopped = liveTicket(found) ? engine.stopTicket(found.id, `Rerouted to ${entry.key}`) : found
      const trigger = consoleTrigger(runtime.config.operator, origin.text, undefined, hint)
      engine.receive(trigger)
      runtime.repo.kv.set(rerouteKey(found.id), { triggerId: trigger.id, projectId: entry.id!, key: entry.key } satisfies Rerouted)
      return report(stopped, { trigger_id: trigger.id, filed_in: entry.key, ...await awaitOutcome(runtime, trigger, wait_seconds * 1000) })
    },
    superagent_answer: async ({ ticket_id, text, answers }: { ticket_id: string; text: string; answers?: Answers }) => {
      const found = ticket(ticket_id)
      // A rerouted ticket's work goes on in the new ticket. An answer here would be filed again in the old project, or resume
      // the old ticket there when it had ended before the reroute.
      const moved = runtime.rerouted(found.id)
      if (moved) throw new Error(`${moved} Answer that ticket instead.`)
      let pending = liveTicket(found) ? runtime.executor.pending(found.id) : []
      const isQuestion = (request: PendingRequest): request is QuestionRequest => request.kind === 'question'
      // `answers` names t3code questions: when the last look saw none, ask t3code now rather than send the text as a chat message.
      if (answers && liveTicket(found) && !pending.some(isQuestion)) pending = await runtime.executor.lookPending(found.id)
      const questions = pending.filter(isQuestion)
      const thread = runtime.executor.thread(found.id)
      if (answers && !(questions.length && thread?.threadId)) {
        throw new Error(`${found.title} waits on no question in T3 Code; \`answers\` is only for those. To answer the worker, pass \`text\` alone.`)
      }
      if (questions.length && thread?.threadId) {
        // The worker's thread waits in t3code on a question it asked there: the answer goes straight to it.
        const { request, given } = chooseAnswers(found, questions, text, answers)
        await runtime.t3.answerQuestion(thread.threadId, request.requestId, given)
        runtime.executor.dropPending(found.id, request.requestId)
        return { delivered: 't3-question' as const, request_id: request.requestId }
      }
      const approvals = pending.filter(request => request.kind === 'approval')
      if (approvals.length && !found.attention) throw new Error(approvalOnly(found, approvals, thread?.link))
      const origin = runtime.repo.triggers.get(found.origin.triggerId)
      if (origin?.source === CONSOLE) {
        // A message on the Ticket's own console thread reaches its worker through its Subscription, as a reply in a chat would.
        // It carries the ticket's project as an inherited hint, which a Router may override if a worker hands it back (D6).
        const project = runtime.binding(found.id)?.projectId ?? (typeof origin.meta.project === 'string' ? origin.meta.project : undefined)
        // SourceScope lets an inherited hint through, so a running ticket gets its answer. An ended one would be resumed, and its
        // Mandate names no project when it was filed unnamed, so a resume in a project denied since is refused here.
        const deniedNow = !liveTicket(found) && project ? denied(runtime.projects, project) : undefined
        if (deniedNow) {
          throw new Error(`${found.title} has ended, and its project ${deniedNow.key} is denied now, so it is not resumed. `
            + 'File the work as a new request in a project that may take it.')
        }
        const hint: ConsoleHint | undefined = project ? { project, projectBy: 'inherited' } : undefined
        const trigger = consoleTrigger(runtime.config.operator, text, consoleThread(origin.threads[0]!.id), hint)
        return { delivered: engine.receive(trigger), trigger_id: trigger.id, ...approvals.length ? { approval: approvalOnly(found, approvals, thread?.link) } : {} }
      }
      // Tickets from GitHub or chat are answered where they were asked; from here, the answer reaches the worker as a note.
      engine.note(found.id, `The operator answered in T3 Code: ${text}`)
      return { delivered: 'note' as const, ...approvals.length ? { approval: approvalOnly(found, approvals, thread?.link) } : {} }
    },
    superagent_stop: ({ ticket_id, reason }: { ticket_id: string; reason?: string }) => {
      const stopped = engine.stopTicket(ticket(ticket_id).id, reason ?? 'Stopped by the operator in T3 Code')
      return { stopped: !liveTicket(stopped), outcome: stopped.ended?.outcome }
    },
    superagent_retry: ({ ticket_id }: { ticket_id: string }) => ({ retried: runtime.view(engine.retryTicket(ticket(ticket_id).id)) }),
    superagent_note: ({ ticket_id, text }: { ticket_id: string; text: string }) => { engine.note(ticket(ticket_id).id, text); return { noted: true } },
    superagent_pause: ({ paused }: { paused: boolean }) => { runtime.setPaused(paused); return { paused } },
    superagent_messages: () => ({ messages: runtime.outbox.list().slice(0, 30).map(record => ({ ticket: record.message.ticketId,
      kind: record.message.kind, status: record.status, at: record.at, text: record.message.text })) }),
  }
}
export type ConsoleAction = keyof ReturnType<typeof consoleActions>

/** How long `superagent_request` waits for the Router's decision by default, and at most. */
const WAIT_SECONDS = 20
const MAX_WAIT_SECONDS = 30
/** After an accept, how long the request waits more for the ticket's thread link, which comes with the launch. */
const LINK_WAIT_MS = 2000

/** What became of a console request so far, as `superagent_request` and `superagent_ticket` report it (D18). */
interface RequestOutcome {
  status: 'accepted' | 'ignored' | 'pending' | 'filtered' | Decision['kind']
  /** One line: `accepted T-xxxxxxxx in <key> (from <base>), <link>`, `ignored: <reason>` or `pending: <trigger id>`. */
  result: string
  ticket_id?: string; short?: string; project?: string; link?: string; reason?: string; at?: string
  next?: string
}

/** The Decision on a Trigger, or its filtering at intake, as a result line. */
function requestOutcome(runtime: Runtime, trigger: Trigger): RequestOutcome {
  const filtered = runtime.repo.triggers.disposition(trigger.id)?.filtered
  if (filtered) {
    const reason = reasonText(filtered)
    return { status: 'filtered', result: `filtered: ${reason}`, reason }
  }
  const decision = runtime.repo.decisions.byThread(threadKey(trigger.threads[0]!)).findLast(item => item.triggerIds.includes(trigger.id))
  if (!decision) {
    return { status: 'pending', result: `pending: ${trigger.id}`, next: 'The Router has not decided yet, which is normal: check superagent_attention, '
      + `or superagent_ticket with ticket_id ${trigger.id}, in a while.` }
  }
  const reason = reasonText(decision.reason)
  if (decision.kind === 'ignore') return { status: 'ignored', result: `ignored: ${reason}`, reason, at: decision.at }
  if (decision.kind !== 'accept' || !decision.ticketId) return { status: decision.kind, result: `${decision.kind}: ${reason}`, reason, at: decision.at }
  const binding = runtime.binding(decision.ticketId)
  const link = runtime.executor.thread(decision.ticketId)?.link
  const short = shortId(decision.ticketId)
  return { status: 'accepted', result: `accepted ${short} in ${binding?.key ?? 'no project'}${binding ? ` (from ${binding.baseRef})` : ''}`
    + `${link ? `, ${link}` : '; its thread opens in the sidebar in a moment'}`, ticket_id: decision.ticketId, short, at: decision.at,
    ...binding ? { project: binding.key } : {}, ...link ? { link } : {} }
}

/**
 * Waits up to `waitMs` for the Decision on a console request, then a moment more for an accepted ticket's thread link (D18):
 * the core tells the console nothing of an ignore, so the request's own result is where the operator learns of one. The
 * clock is `performance.now()`, which a faked `Date` in tests does not stop.
 */
async function awaitOutcome(runtime: Runtime, trigger: Trigger, waitMs: number): Promise<RequestOutcome> {
  const end = performance.now() + Math.min(waitMs, MAX_WAIT_SECONDS * 1000)
  let outcome = requestOutcome(runtime, trigger)
  while (outcome.status === 'pending' && performance.now() < end) {
    await new Promise(resolve => setTimeout(resolve, 50))
    outcome = requestOutcome(runtime, trigger)
  }
  const linkEnd = Math.min(end, performance.now() + LINK_WAIT_MS)
  while (outcome.status === 'accepted' && !outcome.link && performance.now() < linkEnd) {
    await new Promise(resolve => setTimeout(resolve, 50))
    outcome = requestOutcome(runtime, trigger)
  }
  return outcome
}

/** A path or name as one shell word, for the cleanup commands. */
const quote = (word: string): string => /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`

/** What a request to a project leaves in its repository, and the setup T3 Code needs first (plan, section 1). */
const PROJECT_NOTES = {
  side_effects: 'Each ticket in a project adds a branch agent/<name>, a worktree under the project\'s worktree_root, and the lines .mcp.json '
    + 'and .codex/ in the repository\'s .git/info/exclude. Nothing touches the checkout\'s own files.',
  setup: 'To make a folder a project: add it as a project in T3 Code (the super agent cannot), then in that project\'s settings turn off PR '
    + 'watching and "continue threads after server update". Then call superagent_projects with refresh. Access, aliases, delivery and '
    + 'base ref can be set in projects.json in the super agent\'s state directory.',
}
const clip = (text: string | undefined, chars: number) => text && text.length > chars ? `${text.slice(0, chars - 1)}…` : text

/**
 * The projects for the console: the one a query names exactly, else those whose names, purpose or root contain it, ready
 * ones first. Catalogue text is left out where the operator has not allowed it to reach a model (plan, open question 2).
 */
function projectRows(runtime: Runtime, { query, status, limit, refreshError }: { query?: string; status?: ProjectStatus; limit: number; refreshError?: string }) {
  const registry = runtime.projects
  const all = registry.list()
  const wanted = query?.trim().toLowerCase()
  const exact = query?.trim() ? registry.resolve(query) : undefined
  const text = (entry: ProjectEntry) => [entry.key, entry.title, entry.root, ...entry.aliases,
    ...entry.describe && entry.catalogue && 'path' in entry.catalogue ? [entry.catalogue.purpose ?? '', entry.catalogue.notes ?? ''] : []].join('\n').toLowerCase()
  const matched = (exact?.found ? [exact.found] : wanted ? all.filter(entry => text(entry).includes(wanted)) : all)
    .filter(entry => !status || entry.status === status)
  // Each ticket's project is its binding's, matched by T3 Code id, since the registry's entries are new objects after each refresh.
  const bound = new Map(runtime.repo.kv.list<ProjectBinding>(BINDING_PREFIX).map(binding => [binding.ticketId, binding.projectId]))
  const counts = new Map<string, { open: number; last?: string }>()
  for (const ticket of runtime.repo.tickets.list()) {
    const id = bound.get(ticket.id)
    if (!id) continue
    const count = counts.get(id) ?? { open: 0 }
    if (!ticket.ended) count.open++
    if (!count.last || ticket.createdAt > count.last) count.last = ticket.createdAt
    counts.set(id, count)
  }
  const row = (entry: ProjectEntry) => {
    const catalogue = entry.catalogue
    const described = catalogue && 'path' in catalogue
    return {
      key: entry.key, title: entry.title, status: entry.status, ...entry.reason ? { why: entry.reason } : {}, ...entry.id ? { id: entry.id } : {},
      root: entry.root, ...entry.legacy ? { legacy: true } : {}, ...entry.aliases.length ? { aliases: entry.aliases } : {},
      ...described && entry.describe ? { ...catalogue.purpose ? { purpose: clip(catalogue.purpose, 200) } : {},
        ...catalogue.notes ? { notes: clip(catalogue.notes, 300) } : {}, ...catalogue.related.length ? { related: catalogue.related } : {} } : {},
      ...described && !entry.describe ? { description: 'withheld: catalogue text from this folder is not sent to models unless projects.json sets describe: true' } : {},
      ...catalogue && 'insideCatalogued' in catalogue ? { inside_catalogued: catalogue.insideCatalogued } : {},
      ...entry.worktrees.length ? { worktrees: entry.worktrees } : {},
      access: entry.access, delivery: entry.delivery, base_ref: entry.baseRef, worktree_root: entry.worktreeRoot,
      open_tickets: entry.id ? counts.get(entry.id)?.open ?? 0 : 0, last_ticket: entry.id ? counts.get(entry.id)?.last ?? null : null,
    }
  }
  const refreshed = registry.state()
  return {
    summary: registry.summary(),
    work: unnamedRule(runtime),
    ...refreshed.refreshedAt ? { refreshed_at: refreshed.refreshedAt } : {},
    ...refreshError ?? refreshed.error ? { refresh_failed: refreshError ?? refreshed.error, note: 'The list is the last one read.' } : {},
    total: matched.length,
    projects: matched.slice(0, limit).map(row),
    ...query?.trim() && !matched.length && exact && !exact.found ? { suggestions: exact.suggestions } : {},
    ...PROJECT_NOTES,
  }
}

/** What `superagent_projects` says of requests that name no project. */
function unnamedRule(runtime: Runtime): string {
  const name = 'Name the project on every superagent_request with project=<key>.'
  if (runtime.config.unnamedRequests === 'refuse') return `${name} Requests that name none are refused (SUPERAGENT_UNNAMED_REQUESTS=refuse).`
  const preview = runtime.projectPreview([{ source: CONSOLE, at: new Date().toISOString(), meta: { scope: 'console' } }])
  if ('refused' in preview) return `${name} There is no default for requests that name none: ${preview.refused}`
  return `${name} Requests that name none go to ${preview.key}, the default (${preview.by === 'legacy' ? 'the project SUPERAGENT_PROJECT_ROOT names'
    : 'the only ready project'}).`
}

/** Answers to a t3code question, by question id: one string, or several for a multiple choice. */
type Answers = Record<string, string | string[]>
type QuestionRequest = Extract<PendingRequest, { kind: 'question' }>

/**
 * Which pending t3code question the operator answers, and with what. `answers` names question ids; without it, `text` answers
 * the one question there is. An answer that names an option by its label is sent as the option's value.
 */
function chooseAnswers(ticket: Ticket, requests: QuestionRequest[], text: string, answers?: Answers): { request: QuestionRequest; given: Answers } {
  const ids = requests.map(request => `${request.requestId}: ${request.questions.map(question => question.id).join(', ')}`).join('; ')
  if (!answers) {
    const only = requests.length === 1 && requests[0]!.questions.length === 1 ? requests[0]! : undefined
    if (!only) throw new Error(`${ticket.title} waits on several questions in T3 Code; pass \`answers\` keyed by question id (${ids})`)
    const question = only.questions[0]!
    return { request: only, given: { [question.id]: optionValue(question, text) } }
  }
  const keys = Object.keys(answers)
  const request = requests.find(item => keys.length > 0 && keys.every(key => item.questions.some(question => question.id === key)))
  if (!request) throw new Error(`\`answers\` must name the questions of one pending request (${ids}); got ${keys.join(', ') || 'none'}`)
  const given: Answers = {}
  for (const question of request.questions) {
    const answer = answers[question.id]
    if (answer === undefined) continue
    given[question.id] = Array.isArray(answer) ? answer.map(item => optionValue(question, item)) : optionValue(question, answer)
  }
  return { request, given }
}
function optionValue(question: PendingQuestion, answer: string): string {
  const wanted = answer.trim().toLowerCase()
  const option = question.options.find(item => item.label.trim().toLowerCase() === wanted || item.value?.trim().toLowerCase() === wanted)
  return option ? option.value ?? option.label : answer
}
/** What the operator is told about approvals: only T3 Code grants them. */
function approvalOnly(ticket: Ticket, approvals: PendingRequest[], link?: string): string {
  const texts = approvals.map(request => request.kind === 'approval' ? `"${request.text}"` : '').join(', ')
  return `${ticket.title} waits on an approval in T3 Code (${texts}). Approvals are answered in T3 Code only: open the thread and approve `
    + `or decline it there${link ? `: ${link}` : ''}. To tell the worker something, use superagent_note.`
}

export function consoleServer(runtime: Runtime): McpServer {
  const server = new McpServer({ name: 'superagent', version: '0.1.0' })
  const actions = consoleActions(runtime)
  const id = { ticket_id: z.string().min(1).describe('A ticket id or its short T-xxxxxxxx form.') }
  const readOnly = { readOnlyHint: true }

  server.registerResource('attention', ATTENTION_URI, { mimeType: MCP_APP_MIME, description: 'What waits for a person.' },
    async () => ({ contents: [{ uri: ATTENTION_URI, mimeType: MCP_APP_MIME, text: attentionPage('app') }] }))

  server.registerTool('superagent_attention', {
    description: 'What waits for a person, first: questions to answer, approvals to give in T3 Code, results to review, blocked or failed tickets, and the '
      + 'Watchdog\'s alerts. `ignored` lists console requests the Router or the rules ignored in the last day, with the reason. `to_review` lists finished tickets of projects without pull requests whose branch is not merged into the project\'s '
      + 'default branch yet, with the commands that remove the worktree and branch afterwards (the super agent deletes nothing). Empty means healthy.',
    annotations: readOnly, _meta: { ui: { resourceUri: ATTENTION_URI }, 'ui/resourceUri': ATTENTION_URI },
  }, async () => ok(await actions.superagent_attention()))
  server.registerTool('superagent_dismiss_alert', { description: 'Dismiss one of the Watchdog\'s alerts once it is dealt with.',
    inputSchema: { alert_id: z.string().min(1) } }, async args => ok(actions.superagent_dismiss_alert(args)))
  server.registerTool('superagent_status', { description: 'Overview: open tickets, worker load, pause state and recent tickets.', annotations: readOnly },
    async () => ok(actions.superagent_status()))
  server.registerTool('superagent_ticket', { description: 'One ticket in detail: stage, project, reports, inputs and messages. Also takes the trigger_id '
    + 'superagent_request returned: its ticket once there is one, else whether the request is still pending or was ignored, and why.',
  inputSchema: { ticket_id: z.string().min(1).describe('A ticket id, its short T-xxxxxxxx form, or a trigger id from superagent_request.') }, annotations: readOnly },
  async args => ok(actions.superagent_ticket(args)))
  server.registerTool('superagent_projects', {
    description: 'The T3 Code projects and catalogued folders: for each, whether work can go there (status, and why not), what it is for, '
      + 'access, delivery and base ref. `query` matches a name, alias, path or purpose; `refresh` reads T3 Code, the catalogue and projects.json again.',
    inputSchema: { query: z.string().trim().max(200).optional(), status: z.enum(STATUSES as [ProjectStatus, ...ProjectStatus[]]).optional(),
      limit: z.number().int().min(1).max(200).optional(), refresh: z.boolean().optional() },
    annotations: readOnly,
  }, async args => ok(await actions.superagent_projects(args)))
  const project = z.string().trim().min(1).max(500)
  const wait = z.number().int().min(0).max(MAX_WAIT_SECONDS).optional()
    .describe(`How long to wait for the Router's decision, in seconds; ${WAIT_SECONDS} by default, 0 to return at once.`)
  server.registerTool('superagent_request', {
    description: 'Start work in one project: the operator\'s request becomes a ticket with its own T3 Code thread and worktree there. Pass the '
      + 'project\'s key from superagent_projects; one request per project. Returns `accepted <ticket> in <project> (from <base>), <link>`, '
      + '`ignored: <reason>`, or `pending: <trigger id>` when the Router has not decided yet (check superagent_attention or superagent_ticket later). '
      + 'A request that names no project goes to the default one, which `filed_in` names, or is refused when there is none.',
    inputSchema: { text: z.string().trim().min(1).max(8000), project: project.optional()
      .describe('The project: its key, alias, title, folder path or T3 Code id, as superagent_projects shows it.'), wait_seconds: wait },
  }, async args => ok(await actions.superagent_request(args)))
  server.registerTool('superagent_reroute', {
    description: 'A ticket went to the wrong project: stop it and file its request again, with the same text, in `project`. Returns the stopped '
      + 'ticket, the new request\'s result as superagent_request gives it, and the branch and worktree the stopped ticket left, for the operator '
      + 'to delete (the super agent deletes nothing).',
    inputSchema: { ...id, project, wait_seconds: wait },
  }, async args => ok(await actions.superagent_reroute(args)))
  server.registerTool('superagent_answer', {
    description: 'Answer the question a ticket waits on: one its worker asked in its report, or one its T3 Code thread waits on (see `pending.questions` '
      + 'in superagent_attention). For several T3 Code questions, pass `answers` keyed by question id. Approvals cannot be answered here, only in T3 Code.',
    inputSchema: { ...id, text: z.string().trim().min(1).max(8000),
      answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional()
        .describe('For a T3 Code question: answer per question id; a string, or a list for a multiple choice.') },
  }, async args => ok(await actions.superagent_answer(args)))
  server.registerTool('superagent_stop', { description: 'Stop a ticket; this withdraws its authorization.', inputSchema: { ...id, reason: z.string().max(300).optional() } },
    async args => ok(actions.superagent_stop(args)))
  server.registerTool('superagent_retry', { description: 'Start a blocked or failed ticket again in the same thread and worktree.', inputSchema: id },
    async args => ok(actions.superagent_retry(args)))
  server.registerTool('superagent_note', { description: 'Give a ticket\'s worker a fact for context; it grants nothing.', inputSchema: { ...id, text: z.string().trim().min(1).max(4000) } },
    async args => ok(actions.superagent_note(args)))
  server.registerTool('superagent_pause', { description: 'Pause or resume processing: no new tickets, deliveries or replies while paused.', inputSchema: { paused: z.boolean() } },
    async args => ok(actions.superagent_pause(args)))
  server.registerTool('superagent_messages', { description: 'Recent messages the super agent sent, newest first.', annotations: readOnly },
    async () => ok(actions.superagent_messages()))
  return server
}
