/**
 * Phase 3: the Watchdog, the paper's external control loop (section 6). Its tools let a separate t3code thread, woken by
 * t3code's own scheduler, see whether the super agent's parts work and whether each worker makes real progress, and act
 * within narrow limits: nudge a worker with a note, retry a failed ticket, ask for a status, or raise an alert for the
 * operator. It cannot accept, stop or reply on anyone's behalf; stopping work stays a person's call.
 */
import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { latestAssignment, latestReport, type Ticket } from '../../vendor/dsh/src/core/index.ts'
import type { Runtime } from '../app/runtime.ts'
import { ok } from './result.ts'

export interface Alert {
  id: string; at: string; text: string; ticketId?: string
  /** Where a person deals with it, for an alert this service computes rather than one the Watchdog raised. */
  link?: string
}
const ALERTS = 'watchdog:alerts', LAST_CHECK = 'watchdog:last-check'
/** The id of the computed alert for a Watchdog thread that waits on a person. */
export const WATCHDOG_PENDING_ALERT = 'pending:watchdog'
const minutes = (since: string | undefined, now: number) => since ? Math.round((now - Date.parse(since)) / 60_000) : undefined

/** The alerts the Watchdog raised, as stored. */
function raised(runtime: Runtime): Alert[] { return runtime.repo.kv.get<Alert[]>(ALERTS) ?? [] }
/** Every open alert: the computed ones first, then those the Watchdog raised. */
export function alerts(runtime: Runtime): Alert[] {
  const waiting = runtime.watchdogPending
  if (!waiting || !runtime.watchdog) return raised(runtime)
  const approvals = waiting.requests.flatMap(request => request.kind === 'approval' ? [request.text] : [])
  const questions = waiting.requests.flatMap(request => request.kind === 'question' ? request.questions.map(question => question.question) : [])
  const where = runtime.watchdog.link ? ` ${runtime.watchdog.link}` : ''
  const text = [
    approvals.length ? `The Watchdog thread waits on ${approvals.length === 1 ? 'an approval' : `${approvals.length} approvals`}: `
      + `${approvals.map(item => `"${item}"`).join(', ')}. Approvals are answered in T3 Code only: open the thread and approve or decline.` : '',
    questions.length ? `The Watchdog thread waits on a question in T3 Code: ${questions.map(item => `"${item}"`).join(', ')}.` : '',
    `No Watchdog check runs until then.${where}`,
  ].filter(Boolean).join(' ')
  return [{ id: WATCHDOG_PENDING_ALERT, at: waiting.since, text, ...runtime.watchdog.link ? { link: runtime.watchdog.link } : {} }, ...raised(runtime)]
}
export function dismissAlert(runtime: Runtime, id: string): boolean {
  if (id === WATCHDOG_PENDING_ALERT) {
    throw new Error('This alert cannot be dismissed: it shows what the Watchdog thread waits on, and clears itself once that is answered '
      + `in T3 Code${runtime.watchdog?.link ? ` (${runtime.watchdog.link})` : ''}.`)
  }
  const all = raised(runtime)
  runtime.repo.kv.set(ALERTS, all.filter(alert => alert.id !== id))
  return all.some(alert => alert.id === id)
}
export const lastCheck = (runtime: Runtime): string | undefined => runtime.repo.kv.get<string>(LAST_CHECK)

/** The facts the Watchdog judges by; it reads a worker's thread itself when these look wrong. */
export function watchdogCheck(runtime: Runtime) {
  const now = Date.now()
  runtime.repo.kv.set(LAST_CHECK, new Date(now).toISOString())
  const open = runtime.repo.tickets.open()
  const working = open.map(ticket => {
    const assignment = latestAssignment(ticket)
    const report = latestReport(ticket)
    const busySince = runtime.executor.busySince(ticket.id)
    const activity = [ticket.updatedAt, assignment?.idleAt, assignment?.deliveredAt, report?.at].filter(Boolean).sort().at(-1)
    return { ...runtime.view(ticket), running_turn: !!busySince, minutes_running: minutes(busySince, now),
      minutes_since_activity: minutes(activity, now), last_report: report ? { state: report.state, minutes_ago: minutes(report.at, now) } : null,
      assignment: assignment ? { state: assignment.state, attempts: ticket.assignments.length } : null,
      ...ticket.delivery ? { delivery_error: ticket.delivery.error } : {} }
  })
  const health = runtime.health.snapshot()
  return {
    at: new Date(now).toISOString(),
    service: { started_at: runtime.health.startedAt, paused: runtime.settings.paused, workers: runtime.executor.load() },
    failing: runtime.health.failing(),
    health,
    router: { kind: runtime.config.router.kind, ...'state' in runtime.router ? { ...(runtime.router as { state(): object }).state() } : {} },
    tickets: working,
    open_alerts: alerts(runtime).length,
  }
}

export function watchdogServer(runtime: Runtime): McpServer {
  const server = new McpServer({ name: 'superagent-watchdog', version: '0.1.0' })
  const { engine } = runtime
  const ticket = (id: string): Ticket => {
    const found = runtime.findTicket(id)
    if (!found) throw new Error(`No ticket ${id}`)
    return found
  }
  const id = { ticket_id: z.string().min(1) }

  server.registerTool('watchdog_check', {
    description: 'One check: which parts of the super agent are failing, and every open ticket with how long its worker has run and since '
      + 'its last activity. Call it first in every check.',
    annotations: { readOnlyHint: true },
  }, async () => ok(watchdogCheck(runtime)))

  server.registerTool('watchdog_thread', {
    description: 'The latest activity in a ticket\'s T3 Code thread (messages and tool calls), to judge whether its worker makes real progress '
      + 'toward its assignment or loops or drifts.',
    inputSchema: { ...id, limit: z.number().int().min(1).max(50).default(20) },
    annotations: { readOnlyHint: true },
  }, async ({ ticket_id, limit }) => {
    const found = ticket(ticket_id)
    const thread = runtime.executor.thread(found.id)
    if (!thread?.threadId) return ok({ ticket: runtime.view(found), thread: null })
    // Pages run oldest first: walk to the end, keeping the latest items, within a bound.
    const kept: { position: number; type: string; text: string | null }[] = []
    let after: number | undefined, status = 'idle'
    for (let pages = 0; pages < 20; pages++) {
      const page = await runtime.t3.read(thread.threadId, { view: 'activity', limit: 100, ...after !== undefined ? { afterPosition: after } : {} })
      status = page.thread.status
      kept.push(...page.items.map(item => ({ position: item.position, type: item.type, text: item.text?.slice(0, 600) ?? null })))
      kept.splice(0, Math.max(0, kept.length - limit))
      if (page.nextPosition === null || !page.items.length) break
      after = page.nextPosition
    }
    return ok({ ticket: runtime.view(found), assignment: found.execution?.assignment ?? '', status, items: kept })
  })

  server.registerTool('watchdog_nudge', {
    description: 'Give a drifting or stuck worker one concrete note: what it seems to be doing wrong and what to do instead. Context only; it grants nothing.',
    inputSchema: { ...id, text: z.string().trim().min(1).max(1500) },
  }, async ({ ticket_id, text }) => ok({ noted: !!engine.note(ticket(ticket_id).id, `From the Watchdog: ${text}`) }))

  server.registerTool('watchdog_retry', {
    description: 'Retry a ticket that failed or whose input could not be delivered, when the cause was passing (an outage, a provider error) '
      + 'and is gone now. Never for a ticket that waits on a person\'s answer or review.',
    inputSchema: id,
  }, async ({ ticket_id }) => {
    const found = ticket(ticket_id)
    const stage = runtime.view(found).stage
    if (!['person/failed', 'person/delivery', 'person/blocked'].includes(stage)) throw new Error(`Only failed, blocked or undelivered tickets can be retried; this one is ${stage}`)
    return ok({ retried: runtime.view(engine.retryTicket(found.id)) })
  })

  server.registerTool('watchdog_request_status', {
    description: 'Ask an idle worker to report its status.',
    inputSchema: id,
  }, async ({ ticket_id }) => ok({ asked: engine.requestStatus(ticket(ticket_id).id) }))

  server.registerTool('watchdog_alert', {
    description: 'Raise an alert for the operator: it shows in the Superagent console\'s attention queue and the panel until dismissed. Use it '
      + 'for what needs a person: a part failing for long, a worker looping that a nudge did not fix, a ticket that should probably be stopped.',
    inputSchema: { text: z.string().trim().min(1).max(1000), ticket_id: z.string().optional() },
  }, async ({ text, ticket_id }) => {
    const alert: Alert = { id: randomUUID(), at: new Date().toISOString(), text, ...ticket_id ? { ticketId: ticket(ticket_id).id } : {} }
    // One open alert per ticket and text: a check that sees the same fault again does not repeat it.
    const all = raised(runtime)
    if (!all.some(item => item.text === alert.text && item.ticketId === alert.ticketId)) runtime.repo.kv.set(ALERTS, [...all, alert])
    return ok({ alert })
  })

  server.registerTool('watchdog_alerts', {
    description: 'The open alerts, to avoid raising one again and to see which the operator dismissed.',
    annotations: { readOnlyHint: true },
  }, async () => ok({ alerts: alerts(runtime) }))

  return server
}
