/**
 * The Router (the paper's section 2.1, the prototype's main Session): one resident Claude conversation in the control plane
 * that routes candidates, relays workers' results and questions, and assesses proactive work. It does no ticket work and
 * has no shell.
 *
 * Batching: items that arrive while the model works wait in the inbox and go into the next request together, beside the
 * tool results of the step that was running or as the next turn. The conversation is append-only (preserved thinking), and
 * server-side compaction keeps it within the context window.
 */
import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { threadKey, type Assessor, type Candidate, type Engine, type Ticket, type WorkerReport } from '../../vendor/dsh/src/core/index.ts'
import type { Settings } from '../../vendor/dsh/src/policy.ts'
import type { TicketView } from '../app/runtime.ts'
import type { Health } from '../app/health.ts'
import type { Store } from '../app/store.ts'
import { policySection, routerInstructions } from './prompt.ts'
import { routerTools, type RouterTool } from './tools.ts'

type Params = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming
type Message = Anthropic.Beta.Messages.BetaMessage
type MessageParam = Anthropic.Beta.Messages.BetaMessageParam
type Block = Anthropic.Beta.Messages.BetaContentBlockParam
export type ModelCall = (params: Params) => Promise<Message>

/** What both Routers do: assess candidates, and hear about workers' reports. */
export interface Router extends Assessor {
  reported(ticket: Ticket, report: WorkerReport): void
  start?(): void
  stop?(): Promise<void>
}

export interface ClaudeRouterOptions {
  engine: () => Engine
  store: Store
  settings: () => Settings
  view: (ticket: Ticket) => TicketView
  /** Calls the Messages API; tests pass a scripted model. */
  call?: ModelCall
  model?: string
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** Queues work after the Engine's transaction commits. */
  defer: (run: () => void) => void
  log?: (message: string, error?: unknown) => void
  health?: Health
}

interface Item { id: string; text: string; evalId?: string }
const INBOX = 'router:inbox', MESSAGES = 'router:messages'
/** Tool steps one turn may take before the Router ends it; a batch rarely needs more than two. */
const MAX_STEPS = 12
const REPORT_CHARS = 600

export class ClaudeRouter implements Router {
  private readonly tools: RouterTool[]
  private readonly call: ModelCall
  private running?: Promise<void>
  private closed = false

  constructor(private readonly options: ClaudeRouterOptions) {
    this.tools = routerTools({ engine: options.engine, store: options.store, settings: options.settings, view: options.view })
    this.call = options.call ?? defaultCall()
  }

  start(): void { this.kick() }
  /** How many items wait for the Router, and whether it is working on a batch now. */
  state(): { waiting: number; working: boolean } { return { waiting: this.inbox().length, working: !!this.running } }
  async stop(): Promise<void> { this.closed = true; await this.running?.catch(() => {}) }

  // The Assessor port: called inside the Engine's transaction, so only the inbox changes here.
  request(candidate: Candidate): void {
    this.add({ id: `candidate:${candidate.evalId}`, text: JSON.stringify(this.candidateCard(candidate)), evalId: candidate.evalId })
  }
  release(evalId: string): void {
    this.save(this.inbox().filter(item => item.evalId !== evalId))
  }

  /** A worker's question goes to the Router at once; a result, blocker or failure too. Ordinary progress stays on its ticket. */
  reported(ticket: Ticket, report: WorkerReport): void {
    const kind = report.question ? 'worker_attention' : ['ready', 'blocked', 'failed'].includes(report.state) ? 'worker_report' : undefined
    if (!kind) return
    const summary = report.summary.length > REPORT_CHARS ? `${report.summary.slice(0, REPORT_CHARS)}…` : report.summary
    this.add({ id: `${kind}:${ticket.id}:${Date.now()}`, text: JSON.stringify({ type: kind, ticket: this.options.view(ticket), state: report.state,
      summary, ...report.question ? { attention: { question: report.question } } : {},
      ...report.answers ? { answers_trigger_id: report.answers } : {},
      next: kind === 'worker_attention' ? 'Ask the person with orchestrator_reply purpose=attention, copying the question into human_action.'
        : report.state === 'ready' ? 'Tell the requester the result with orchestrator_reply purpose=result, unless a matched rule says otherwise.'
          : 'Nothing to send unless a person must act; the ticket waits for a person in the console.' }) })
  }

  private add(item: Item): void {
    const inbox = this.inbox()
    if (inbox.some(queued => queued.id === item.id)) return
    this.save([...inbox, item])
    this.options.defer(() => this.kick())
  }
  private inbox(): Item[] { return this.options.store.kv.get<Item[]>(INBOX) ?? [] }
  private save(items: Item[]): void { this.options.store.kv.set(INBOX, items) }
  private messages(): MessageParam[] { return this.options.store.kv.get<MessageParam[]>(MESSAGES) ?? [] }

  /** Starts a turn unless one runs; a running turn takes what arrives meanwhile. */
  private kick(): void {
    if (this.running || this.closed || this.options.settings().paused || !this.inbox().length) return
    this.running = this.turn().then(() => this.options.health?.ok('router'), error => {
      this.options.log?.('the Router turn failed', error)
      this.options.health?.fail('router', error)
    }).finally(() => {
      this.running = undefined
      if (this.inbox().length) setTimeout(() => this.kick(), 1000)
    })
  }

  /** Takes the queued items into the conversation, telling the Engine each candidate reached the Router. */
  private take(): Block[] {
    const items = this.inbox()
    this.save([])
    for (const item of items) if (item.evalId) {
      try { this.options.engine().candidateDelivered(item.evalId) } catch (error) { this.options.log?.(`delivering ${item.id} failed`, error) }
    }
    return items.map(item => ({ type: 'text', text: item.text }))
  }

  private async turn(): Promise<void> {
    const store = this.options.store
    let messages = this.messages()
    // A turn cut off by a restart left tool calls without results: answer them, so the conversation stays valid.
    const last = messages.at(-1)
    const open = last?.role === 'assistant' && Array.isArray(last.content) ? last.content.filter(block => block.type === 'tool_use') : []
    const recovered: Block[] = open.map(block => ({ type: 'tool_result', tool_use_id: (block as { id: string }).id, is_error: true,
      content: 'The host restarted before this tool ran. Check the current state with orchestrator_read before repeating it.' }))
    messages = [...messages, { role: 'user', content: [...recovered, ...this.take()] }]
    store.kv.set(MESSAGES, messages)

    for (let step = 0; step < MAX_STEPS && !this.closed; step++) {
      const response = await this.withRetries(() => this.call(this.params(messages)))
      messages = [...messages, { role: 'assistant', content: response.content as Block[] }]
      store.kv.set(MESSAGES, messages)
      if (response.stop_reason === 'refusal') { this.options.log?.(`the Router declined a batch: ${response.stop_details?.category ?? 'no category'}`); return }
      const uses = response.content.filter((block): block is Anthropic.Beta.Messages.BetaToolUseBlock => block.type === 'tool_use')
      if (response.stop_reason !== 'tool_use' || !uses.length) {
        if (!this.inbox().length) return
        messages = [...messages, { role: 'user', content: this.take() }]
        store.kv.set(MESSAGES, messages)
        continue
      }
      const results: Block[] = uses.map(use => this.runTool(use))
      messages = [...messages, { role: 'user', content: [...results, ...this.take()] }]
      store.kv.set(MESSAGES, messages)
    }
    this.options.log?.('the Router ended a turn at its step limit')
  }

  private runTool(use: { id: string; name: string; input: unknown }): Block {
    const tool = this.tools.find(item => item.name === use.name)
    const fail = (text: string): Block => ({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: text })
    if (!tool) return fail(`Unknown tool ${use.name}`)
    const args = tool.schema.safeParse(use.input)
    if (!args.success) return fail(`Invalid arguments: ${args.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`)
    try { return { type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(tool.run(args.data) ?? { ok: true }) } }
    catch (error) { return fail(error instanceof Error ? error.message : String(error)) }
  }

  private params(messages: MessageParam[]): Params {
    return {
      model: this.options.model ?? 'claude-opus-5-5',
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01', 'compact-2026-01-12'],
      fallbacks: 'default',
      context_management: { edits: [{ type: 'compact_20260112' }] },
      thinking: { type: 'adaptive' },
      output_config: { effort: this.options.effort ?? 'medium' },
      cache_control: { type: 'ephemeral' },
      system: [{ type: 'text', text: routerInstructions(), cache_control: { type: 'ephemeral' } },
        { type: 'text', text: policySection(this.options.settings()) }],
      tools: this.tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: jsonSchema(tool.schema) })),
      messages,
    }
  }

  /** Retries rate limits, overload and connection failures; refuses to retry a bad request. */
  private async withRetries<T>(work: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try { return await work() }
      catch (error) {
        const retryable = error instanceof Anthropic.RateLimitError || error instanceof Anthropic.InternalServerError
          || error instanceof Anthropic.APIConnectionError || (error instanceof Anthropic.APIError && (error.status ?? 0) >= 500)
        if (!retryable || attempt >= 4 || this.closed) throw error
        await new Promise(resolve => setTimeout(resolve, Math.min(2000 * 2 ** attempt, 60_000)))
      }
    }
  }

  /** A candidate as the Router reads it: its batch, its Thread's tickets, and what to do next. */
  private candidateCard(candidate: Candidate) {
    const primary = candidate.triggers.findLast(trigger => trigger.human) ?? candidate.triggers.at(-1)!
    const disposition = this.options.store.triggers.disposition(primary.id)
    const handedBack = disposition?.handbacks?.map(item => ({ ticket_id: item.ticketId, reason: item.reason }))
    return { type: 'candidate', trigger_id: primary.id, strength: candidate.strength, thread: candidate.thread.key,
      triggers: candidate.triggers.map(trigger => ({ trigger_id: trigger.id, from: trigger.actor.id, source: trigger.source, at: trigger.at,
        thread: threadKey(trigger.threads[0]!), text: trigger.text.length > 1500 ? `${trigger.text.slice(0, 1500)}… (orchestrator_eval_read)` : trigger.text,
        ...trigger.url ? { url: trigger.url } : {} })),
      related_tickets: candidate.tickets.slice(0, 8).map(this.options.view), tickets_total: candidate.tickets.length,
      ...disposition?.fanout?.length ? { delivered_to: disposition.fanout } : {}, ...handedBack?.length ? { handed_back: handedBack } : {},
      next: candidate.strength === 'explicit' ? 'Route it with orchestrator_route: accept, attach, stop or ignore.'
        : 'Proactive: ignore it from this card if it touches no enabled rule, else orchestrator_eval then orchestrator_eval_decide.' }
  }
}

function jsonSchema(schema: z.ZodType): Anthropic.Beta.Messages.BetaTool.InputSchema {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>
  return rest as Anthropic.Beta.Messages.BetaTool.InputSchema
}

/** The Messages API through the SDK, with credentials from the environment (ANTHROPIC_API_KEY or an `ant auth login` profile). */
function defaultCall(): ModelCall {
  const client = new Anthropic()
  return params => client.beta.messages.create(params)
}
