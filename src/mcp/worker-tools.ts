/**
 * The tools a Ticket's worker gets from the `superagent` MCP server in its worktree, ported from the prototype's
 * `src/app/tools/executor.ts`. Each server instance is bound to one Ticket by the capability token in its URL, so a worker
 * can only act on its own Ticket.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { liveTicket, type Ticket } from '../../vendor/dsh/src/core/index.ts'
import type { Runtime } from '../app/runtime.ts'
import { ok } from './result.ts'

/** Acknowledgements stay short in every channel, as the paper's multi-channel rules ask. */
const ACK_WORDS = 100
const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length

export function workerServer(runtime: Runtime, ticketId: string): McpServer {
  const server = new McpServer({ name: 'superagent', version: '0.1.0' })
  const { engine, repo } = runtime
  const ticket = (): Ticket => {
    const current = repo.tickets.get(ticketId)
    if (!current) throw new Error('Unknown ticket')
    return current
  }

  server.registerTool('orchestrator_read', {
    description: 'Read one page of a resource of this ticket: `ticket`, `trigger/<id>` for a message that reached it, or `input/<id>`. '
      + 'Follow next_offset for long text.',
    inputSchema: { resource: z.string().min(1), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(8000).default(4000) },
  }, async ({ resource, offset, limit }) => ok(page(readResource(runtime, ticket(), resource), offset, limit)))

  server.registerTool('orchestrator_ack', {
    description: 'Acknowledge one original human request before substantial work; it posts as a reply to that message.',
    inputSchema: { trigger_id: z.string(), text: z.string().trim().min(1).refine(text => words(text) <= ACK_WORDS, `At most ${ACK_WORDS} words.`) },
  }, async ({ trigger_id, text }) => {
    const reply = engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: trigger_id, text })
    return ok({ trigger_id, acknowledgement: reply.status, reused: reply.reused })
  })

  server.registerTool('orchestrator_report', {
    description: 'Report progress, ready, blocked, failed or dropped. Use human_action for one concrete question a person must answer. '
      + 'Pass pr_url once you open this ticket\'s pull request, so T3 Code shows it on this thread.',
    inputSchema: {
      state: z.enum(['progress', 'ready', 'blocked', 'failed', 'dropped']),
      summary: z.string().min(1),
      human_action: z.string().trim().min(1).max(1000).nullish()
        .describe('One concrete question for a person; omit to keep the pending one, null to clear it.'),
      question_for_trigger_id: z.string().optional().describe('With human_action: the human message that raised the question.'),
      reply_to_trigger_id: z.string().optional().describe('The explicit human question this report answers; never for ordinary progress.'),
      pr_url: z.string().url().optional(),
    },
  }, async args => {
    if (!liveTicket(ticket())) throw new Error('Ticket ended (its work finished or a person stopped it); do not resume it')
    const thread = runtime.executor.thread(ticketId)
    if (args.pr_url && thread?.threadId) {
      await runtime.t3.linkPullRequests(thread.threadId, [args.pr_url]).catch(error => runtime.config.log('linking the PR failed', error))
    }
    // Its pull request becomes a Thread the Ticket follows: review comments reach this worker, and its merge ends the Ticket.
    if (args.pr_url && runtime.github) runtime.github.bindPull(ticketId, args.pr_url)
    const report = { state: args.state, summary: args.summary, ...args.human_action !== undefined ? { question: args.human_action } : {},
      ...args.question_for_trigger_id ? { askedBy: args.question_for_trigger_id } : {},
      ...args.reply_to_trigger_id ? { answers: args.reply_to_trigger_id } : {} }
    const updated = engine.report(ticketId, report)
    runtime.router.reported(updated, report)
    return ok({ reported: true, ...updated.attention ? { attention: updated.attention } : {}, ...updated.ended ? { ended: updated.ended.outcome } : {} })
  })

  server.registerTool('orchestrator_thread_unrelated', {
    description: 'Stop following an attached thread that is not about this ticket; its own threads cannot be dropped.',
    inputSchema: { thread: z.string().min(1), reason: z.string().trim().min(1).max(300) },
  }, async ({ thread, reason }) => { engine.markUnrelated(ticketId, thread, reason); return ok({ removed: true, thread }) })

  server.registerTool('orchestrator_thread_follow', {
    description: 'Follow a related thread, such as an Issue or another PR, for context only.',
    inputSchema: { thread: z.string().regex(/^[a-z][a-z0-9-]*:.+$/, 'A thread key is <source>:<id>'), reason: z.string().trim().min(1).max(300) },
  }, async ({ thread }) => {
    const at = thread.indexOf(':')
    return ok({ followed: engine.followForContext(ticketId, { source: thread.slice(0, at), id: thread.slice(at + 1) }), thread })
  })

  server.registerTool('orchestrator_trigger_handback', {
    description: 'Hand back a message that asks for work beyond this ticket or for another one, for a fresh assessment; once per message.',
    inputSchema: { trigger_id: z.string().min(1), reason: z.string().trim().min(1).max(300) },
  }, async ({ trigger_id, reason }) => ok({ trigger_id, queued: engine.handback(ticketId, trigger_id, reason) }))

  return server
}

/** What a worker may read: its own Ticket, the messages that reached it, and its Inputs. */
function readResource(runtime: Runtime, ticket: Ticket, resource: string): string {
  if (resource === 'ticket') {
    const view = runtime.view(ticket)
    return JSON.stringify({ ...view, scope: ticket.mandate.scope, strength: ticket.mandate.strength, channels: ticket.channels.length,
      inputs: ticket.inputs.map(input => ({ id: input.id, kind: input.kind, at: input.at, ...'triggerId' in input ? { trigger_id: input.triggerId } : {} })) }, null, 2)
  }
  const [kind, ...rest] = resource.split('/')
  const id = rest.join('/')
  if (kind === 'trigger') {
    const reached = ticket.origin.triggerIds.includes(id) || ticket.inputs.some(input => 'triggerId' in input && input.triggerId === id)
    const trigger = reached ? runtime.repo.triggers.get(id) : undefined
    if (!trigger) throw new Error(`No message ${id} reached this ticket`)
    return JSON.stringify({ trigger_id: trigger.id, from: trigger.actor.id, at: trigger.at, url: trigger.url, text: trigger.text }, null, 2)
  }
  if (kind === 'input') {
    const input = ticket.inputs.find(item => item.id === id)
    if (!input) throw new Error(`No input ${id} on this ticket`)
    return JSON.stringify(input, null, 2)
  }
  throw new Error('Read `ticket`, `trigger/<id>` or `input/<id>`')
}

function page(text: string, offset: number, limit: number) {
  const end = Math.min(text.length, offset + limit)
  return { text: text.slice(offset, end), ...end < text.length ? { next_offset: end, chars: text.length } : {} }
}
