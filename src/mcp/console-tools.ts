/**
 * Point 2: the console tools, which the agent of the Superagent thread in t3code uses to run the super agent for the
 * operator. `superagent_attention` also carries the MCP App of point 3.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { liveTicket } from '../../vendor/dsh/src/core/index.ts'
import { CONSOLE, consoleThread, consoleTrigger } from '../app/console-source.ts'
import type { Runtime } from '../app/runtime.ts'
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
    superagent_answer: ({ ticket_id, text }: { ticket_id: string; text: string }) => {
      const found = ticket(ticket_id)
      const origin = runtime.repo.triggers.get(found.origin.triggerId)
      if (origin?.source === CONSOLE) {
        // A message on the Ticket's own console thread reaches its worker through its Subscription, as a reply in a chat would.
        const trigger = consoleTrigger(runtime.config.operator, text, consoleThread(origin.threads[0]!.id))
        return { delivered: engine.receive(trigger), trigger_id: trigger.id }
      }
      // Tickets from GitHub or chat are answered where they were asked; from here, the answer reaches the worker as a note.
      engine.note(found.id, `The operator answered in T3 Code: ${text}`)
      return { delivered: 'note' }
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

export function consoleServer(runtime: Runtime): McpServer {
  const server = new McpServer({ name: 'superagent', version: '0.1.0' })
  const actions = consoleActions(runtime)
  const id = { ticket_id: z.string().min(1).describe('A ticket id or its short T-xxxxxxxx form.') }
  const readOnly = { readOnlyHint: true }

  server.registerResource('attention', ATTENTION_URI, { mimeType: MCP_APP_MIME, description: 'What waits for a person.' },
    async () => ({ contents: [{ uri: ATTENTION_URI, mimeType: MCP_APP_MIME, text: attentionPage('app') }] }))

  server.registerTool('superagent_attention', {
    description: 'What waits for a person, first: questions to answer, results to review, blocked or failed tickets, and the Watchdog\'s alerts. Empty means healthy.',
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
  server.registerTool('superagent_answer', { description: 'Answer the question a ticket waits on.', inputSchema: { ...id, text: z.string().trim().min(1).max(8000) } },
    async args => ok(actions.superagent_answer(args)))
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
