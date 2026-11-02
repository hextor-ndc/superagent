/**
 * The composition root: DeepSeek's Engine with this project's ports. The control plane owns Tickets and decisions, and
 * t3code runs the workers. Holds no domain rules of its own.
 */
import { createHash, randomBytes } from 'node:crypto'
import { Engine, latestReport, threadKey, ticketStage, type DomainEvent, type SourceScope, type Ticket }
  from '../../vendor/dsh/src/core/index.ts'
import { SettingsSchema, settingsPolicy, type Settings } from '../../vendor/dsh/src/policy.ts'
import type { Config } from '../config.ts'
import { T3Executor, type T3ExecutorOptions, type TicketThread } from '../executor/t3-executor.ts'
import { MCP_SERVER_NAME, writeMcpConfig } from '../executor/workspace.ts'
import { shortId } from '../executor/render.ts'
import type { T3Client } from '../t3/client.ts'
import { CONSOLE } from './console-source.ts'
import { InterimRouter } from './interim-router.ts'
import { Jobs } from './jobs.ts'
import { StoredOutbox } from './outbox.ts'
import { Store } from './store.ts'

export interface TicketView {
  id: string; short: string; title: string; stage: string; question?: string; summary?: string; link?: string
  outcome?: string; updatedAt: string; source: string
}

export class Runtime {
  readonly jobs: Jobs
  readonly repo: Store
  readonly engine: Engine
  readonly executor: T3Executor
  readonly outbox: StoredOutbox
  readonly router: InterimRouter
  settings: Settings
  /** The Superagent console thread in t3code, once it exists. */
  console?: { threadId: string; link?: string }
  private pass?: NodeJS.Timeout
  readonly events: DomainEvent[] = []

  constructor(readonly config: Config, readonly t3: T3Client, project: { id: string; root: string },
    timing: Pick<T3ExecutorOptions, 'waitMs' | 'idlePollMs' | 'continueAfterMs'> = {}) {
    const log = config.log
    this.repo = new Store(config.database, error => log('after-commit work failed', error))
    const defer = (run: () => void) => this.repo.afterCommit(run)
    this.jobs = new Jobs((key, error, final) => log(`${key} failed${final ? ' for the last time' : ''}`, error), defer)
    const saved = this.repo.kv.get<{ paused?: boolean }>('settings')
    this.settings = SettingsSchema.parse({
      paused: saved?.paused ?? false,
      policy: { sources: { [CONSOLE]: { allowed: [{ id: config.operator }] } } },
      // Proactive work stays off until the model-backed Router exists (phase 2).
      eval: { mode: 'off' },
      executor: { maxWorkers: config.maxWorkers },
    })
    this.console = this.repo.kv.get('console')
    const scope: SourceScope = {
      scope: ({ source }) => source === CONSOLE ? { listened: true, observed: false, row: 'console' } : { listened: false, reason: 'source_off' },
    }
    this.executor = new T3Executor({
      t3, repo: this.repo, engine: () => this.engine, settings: () => this.settings,
      project: { ...project, repository: config.repository }, worktreeRoot: config.worktreeRoot, baseRef: config.baseRef,
      workerUrl: token => `${config.publicUrl}/mcp/worker/${token}`, maxWorkers: () => this.settings.executor.maxWorkers,
      runtimeMode: config.runtimeMode, log, defer, ...timing,
      state: { load: () => this.repo.kv.list<TicketThread>('ticket-thread:'), save: entry => this.repo.kv.set(`ticket-thread:${entry.ticketId}`, entry) },
    })
    this.outbox = new StoredOutbox(this.repo.kv, this.jobs, ticketId => this.executor.thread(ticketId)?.link)
    // Console messages are kept for the console to show; they never leave this process.
    this.outbox.register(CONSOLE, async () => 'sent')
    this.router = new InterimRouter(this.jobs, () => this.engine, log)
    this.engine = new Engine({
      repo: this.repo, policy: () => settingsPolicy(this.settings, scope), scope, assessor: this.router, executor: this.executor,
      outbox: this.outbox, prepareTicket: (ticket, outcome) => this.executor.prepare(ticket, outcome),
      emit: event => { this.events.push(event); if (this.events.length > 500) this.events.shift() },
    })
  }

  /** Resumes the work a previous run left (Tickets in t3code threads, messages not yet sent), then starts the passes. */
  start(): void {
    this.executor.resume()
    this.outbox.resume()
    this.pass = setInterval(() => {
      try { this.engine.evaluateDue() } catch (error) { this.config.log('pass failed', error) }
    }, 1000)
  }
  async stop(): Promise<void> {
    clearInterval(this.pass)
    await this.executor.close()
    this.jobs.close()
    this.repo.close()
  }
  /** Pauses or resumes processing, and keeps the choice across restarts. */
  setPaused(paused: boolean): void {
    this.settings = { ...this.settings, paused }
    this.repo.kv.set('settings', { paused })
  }

  /**
   * Point 2: the Superagent console, a t3code thread without a project whose agent has the console tools. Launched once
   * (the same `clientRequestId` returns the same thread), pinned, and given its MCP configuration before its first turn.
   */
  async ensureConsole(): Promise<void> {
    const requestId = `superagent-console:${createHash('sha256').update(this.config.consoleToken).digest('hex').slice(0, 16)}`
    const launched = await this.t3.launchScratch({ title: 'Superagent', clientRequestId: requestId })
    this.console = { threadId: launched.threadId, link: launched.link }
    this.repo.kv.set('console', this.console)
    const detail = await this.t3.read(launched.threadId, { limit: 1 })
    if (detail.thread.worktreePath) await writeMcpConfig(detail.thread.worktreePath, this.consoleUrl())
    else this.config.log(`The console thread has no folder; add the console MCP server by hand: ${MCP_SERVER_NAME} ${this.consoleUrl()}`)
    await this.t3.organize(launched.threadId, 'pin').catch(error => this.config.log('pinning the console failed', error))
    if (!detail.items.length) {
      await this.t3.send(launched.threadId, CONSOLE_INTRO, `${requestId}:intro`, 'queue')
        .catch(error => this.config.log('introducing the console failed', error))
    }
  }
  consoleUrl(): string { return `${this.config.publicUrl}/mcp/console/${this.config.consoleToken}` }
  panelUrl(): string { return `${this.config.publicUrl}/panel/${this.config.consoleToken}` }

  // Reads for the console and the panel.

  view(ticket: Ticket): TicketView {
    const stage = ticketStage(ticket)
    const report = latestReport(ticket)
    const origin = this.repo.triggers.get(ticket.origin.triggerId)
    return { id: ticket.id, short: shortId(ticket.id), title: ticket.title,
      stage: 'action' in stage && stage.action ? `${stage.stage}/${stage.action}` : stage.stage,
      ...ticket.attention ? { question: ticket.attention.question } : {}, ...report ? { summary: report.summary } : {},
      ...this.executor.thread(ticket.id)?.link ? { link: this.executor.thread(ticket.id)!.link } : {},
      ...ticket.ended ? { outcome: ticket.ended.outcome } : {}, updatedAt: ticket.updatedAt, source: origin?.source ?? 'unknown' }
  }
  tickets(): TicketView[] { return this.repo.tickets.list().map(ticket => this.view(ticket)) }
  /** What waits for a person, first; the panel's and the attention app's list. A healthy state is an empty list. */
  attention(): TicketView[] { return this.tickets().filter(view => view.stage.startsWith('person/')) }
  /** The Ticket an id names: its full id, or the short `T-xxxxxxxx` form the console shows. */
  findTicket(id: string): Ticket | undefined {
    const wanted = id.replace(/^\[?T-/, '').replace(/\]$/, '')
    return this.repo.tickets.get(id) ?? this.repo.tickets.list().find(ticket => ticket.id.startsWith(wanted))
  }
  threadKeyOf(ticket: Ticket): string { return threadKey(this.repo.triggers.get(ticket.origin.triggerId)!.threads[0]!) }
}

export const newToken = (): string => randomBytes(24).toString('base64url')

const CONSOLE_INTRO = [
  'This is the Superagent console. You help the operator run the superagent, which works on tickets in their own T3 Code threads.',
  'Use the `superagent` MCP tools: superagent_attention first (what waits for a person), superagent_status, superagent_ticket, '
    + 'superagent_request to start work, superagent_answer to answer a ticket\'s question, superagent_stop, superagent_retry, '
    + 'superagent_note, superagent_pause and superagent_messages.',
  'Keep answers short. Do not do ticket work in this thread: start a request instead, and link each ticket\'s thread when you mention it.',
  'Reply with one line saying you are ready.',
].join('\n')
