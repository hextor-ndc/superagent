/**
 * Point 2: the console tools, which the agent of the Superagent thread in t3code uses to run the super agent for the
 * operator. `superagent_attention` also carries the MCP App of point 3.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { liveTicket, type Ticket } from '../../vendor/dsh/src/core/index.ts'
import { CONSOLE, consoleThread, consoleTrigger } from '../app/console-source.ts'
import type { Runtime } from '../app/runtime.ts'
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
    superagent_attention: () => ({ tickets: runtime.attention(), alerts: alerts(runtime) }),
    superagent_dismiss_alert: ({ alert_id }: { alert_id: string }) => ({ dismissed: dismissAlert(runtime, alert_id) }),
    superagent_ticket: ({ ticket_id }: { ticket_id: string }) => {
      const found = ticket(ticket_id)
      return { ...runtime.view(found), scope: found.mandate.scope, strength: found.mandate.strength,
        assignments: found.assignments.map(item => ({ id: item.id, state: item.state, report: item.report })),
        inputs: found.inputs.length, undelivered: found.undelivered.length,
        messages: runtime.outbox.list(record => record.message.ticketId === found.id).map(record => ({ kind: record.message.kind, status: record.status,
          text: record.message.text })) }
    },
    superagent_request: ({ text }: { text: string }) => {
      const trigger = consoleTrigger(runtime.config.operator, text)
      const result = engine.receive(trigger)
      return { trigger_id: trigger.id, result, next: 'The ticket appears in superagent_status within seconds; its thread opens in the sidebar.' }
    },
    superagent_answer: async ({ ticket_id, text, answers }: { ticket_id: string; text: string; answers?: Answers }) => {
      const found = ticket(ticket_id)
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
        const trigger = consoleTrigger(runtime.config.operator, text, consoleThread(origin.threads[0]!.id))
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
      + 'Watchdog\'s alerts. Empty means healthy.',
    annotations: readOnly, _meta: { ui: { resourceUri: ATTENTION_URI }, 'ui/resourceUri': ATTENTION_URI },
  }, async () => ok(actions.superagent_attention()))
  server.registerTool('superagent_dismiss_alert', { description: 'Dismiss one of the Watchdog\'s alerts once it is dealt with.',
    inputSchema: { alert_id: z.string().min(1) } }, async args => ok(actions.superagent_dismiss_alert(args)))
  server.registerTool('superagent_status', { description: 'Overview: open tickets, worker load, pause state and recent tickets.', annotations: readOnly },
    async () => ok(actions.superagent_status()))
  server.registerTool('superagent_ticket', { description: 'One ticket in detail: stage, reports, inputs and messages.', inputSchema: id, annotations: readOnly },
    async args => ok(actions.superagent_ticket(args)))
  server.registerTool('superagent_request', {
    description: 'Start work: the operator\'s request becomes a ticket with its own T3 Code thread and worktree.',
    inputSchema: { text: z.string().trim().min(1).max(8000) },
  }, async args => ok(actions.superagent_request(args)))
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
