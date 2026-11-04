/**
 * The composition root: DeepSeek's Engine with this project's ports. The control plane owns Tickets and decisions, and
 * t3code runs the workers. Holds no domain rules of its own.
 */
import { createHash, randomBytes } from 'node:crypto'
import { Engine, followupOwners, latestReport, liveTicket, threadKey, ticketStage, type DomainEvent, type SourceScope, type Ticket }
  from '../../vendor/dsh/src/core/index.ts'
import { SettingsSchema, settingsPolicy, type Settings } from '../../vendor/dsh/src/policy.ts'
import type { Config } from '../config.ts'
import { T3Executor, type T3ExecutorOptions, type TicketThread } from '../executor/t3-executor.ts'
import { MCP_SERVER_NAME, writeMcpConfig } from '../executor/workspace.ts'
import { shortId } from '../executor/render.ts'
import type { PendingQuestion, PendingRequest, T3Client } from '../t3/client.ts'
import { GITHUB, GithubSource, ghCli, type Gh } from '../sources/github.ts'
import { CONSOLE } from './console-source.ts'
import { InterimRouter } from './interim-router.ts'
import { ClaudeRouter, type ModelCall, type Router } from '../router/claude-router.ts'
import { Jobs } from './jobs.ts'
import { StoredOutbox } from './outbox.ts'
import { Health } from './health.ts'
import { Store } from './store.ts'

export interface TicketView {
  id: string; short: string; title: string; stage: string; question?: string; summary?: string; link?: string
  outcome?: string; updatedAt: string; source: string
  /**
   * What the worker's t3code thread waits on a person for. Approvals are answered in T3 Code only; questions also through
   * `superagent_answer`. While there are any, an open Ticket's stage is `person/approve` or `person/question`.
   */
  pending?: { approvals: { requestId: string; text: string }[]; questions: (PendingQuestion & { requestId: string })[] }
}

/** Timing for the executor and for the look at the Watchdog thread; tests make them short. */
export type RuntimeTiming = Pick<T3ExecutorOptions, 'waitMs' | 'idlePollMs' | 'continueAfterMs' | 'pendingCheckMs'> & {
  /** The pause between looks at what the Watchdog thread waits on; 60 s by default. */
  watchdogPendingMs?: number
}

export class Runtime {
  readonly jobs: Jobs
  readonly repo: Store
  readonly engine: Engine
  readonly executor: T3Executor
  readonly outbox: StoredOutbox
  readonly router: Router
  /** The GitHub Source, when an agent account is configured. */
  readonly github?: GithubSource
  settings: Settings
  /** The Superagent console thread in t3code, once it exists. */
  console?: { threadId: string; link?: string }
  /** The Watchdog thread in t3code, once it exists. */
  watchdog?: { threadId: string; link?: string }
  private watchdogTimer?: NodeJS.Timeout
  private watchdogPendingTimer?: NodeJS.Timeout
  /** What the Watchdog thread waits on a person for, as last seen, and since when; shown as an alert. */
  watchdogPending: { requests: PendingRequest[]; since: string } | undefined
  private readonly watchdogPendingMs: number
  private pass?: NodeJS.Timeout
  readonly events: DomainEvent[] = []
  readonly health = new Health()

  constructor(readonly config: Config, readonly t3: T3Client, project: { id: string; root: string },
    { watchdogPendingMs, ...timing }: RuntimeTiming = {}, deps: { gh?: Gh; model?: ModelCall } = {}) {
    const log = config.log
    this.watchdogPendingMs = watchdogPendingMs ?? 60_000
    this.repo = new Store(config.database, error => log('after-commit work failed', error))
    const defer = (run: () => void) => this.repo.afterCommit(run)
    this.jobs = new Jobs((key, error, final) => {
      log(`${key} failed${final ? ' for the last time' : ''}`, error)
      this.health.fail(`jobs:${key.split(':')[0]}`, error)
    }, defer, key => this.health.recovered(`jobs:${key.split(':')[0]}`))
    const saved = this.repo.kv.get<{ paused?: boolean }>('settings')
    this.settings = SettingsSchema.parse({
      paused: saved?.paused ?? false,
      policy: { sources: { [CONSOLE]: { allowed: [{ id: config.operator }] },
        ...config.github ? { [GITHUB]: { allowed: config.github.allowed.map(id => ({ id })),
          ...config.github.admission ? { admission: config.github.admission } : {} } } : {} } },
      // The rule-based Router cannot judge proactive work, so it stays off there.
      eval: { mode: config.router.kind === 'claude' ? config.router.acceptMode : 'off' },
      executor: { maxWorkers: config.maxWorkers },
    })
    this.console = this.repo.kv.get('console')
    this.watchdog = this.repo.kv.get('watchdog')
    if (config.github && config.repository) {
      this.github = new GithubSource({ gh: deps.gh ?? ghCli(config.github.gh), repository: config.repository, login: config.github.login,
        engine: () => this.engine, store: this.repo, pollMs: config.github.pollMs, log, health: this.health,
        // Unaddressed messages can only become candidates while proactive work is on, so with it off they are not read at all.
        observe: this.settings.eval.mode === 'off' ? [] : config.github.observe ?? [] })
    }
    const scope: SourceScope = {
      scope: ({ source, meta }) => source === CONSOLE ? { listened: true, observed: false, row: 'console' }
        : source === GITHUB && this.github ? this.github.scope(meta) : { listened: false, reason: 'source_off' },
    }
    this.executor = new T3Executor({
      t3, repo: this.repo, engine: () => this.engine, settings: () => this.settings,
      project: { ...project, repository: config.repository }, worktreeRoot: config.worktreeRoot, baseRef: config.baseRef,
      workerUrl: token => `${config.publicUrl}/mcp/worker/${token}`, maxWorkers: () => this.settings.executor.maxWorkers,
      runtimeMode: config.runtimeMode, log, defer, health: this.health, ...timing,
      ...config.github ? { account: { login: config.github.login, commitEmail: config.github.commitEmail } } : {},
      state: { load: () => this.repo.kv.list<TicketThread>('ticket-thread:'), save: entry => this.repo.kv.set(`ticket-thread:${entry.ticketId}`, entry) },
    })
    this.outbox = new StoredOutbox(this.repo.kv, this.jobs, ticketId => this.executor.thread(ticketId)?.link)
    // Console messages are kept for the console to show; they never leave this process.
    this.outbox.register(CONSOLE, async () => 'sent')
    if (this.github) { const github = this.github; this.outbox.register(GITHUB, message => github.send(message)) }
    this.router = config.router.kind === 'claude'
      ? new ClaudeRouter({ engine: () => this.engine, store: this.repo, settings: () => this.settings, view: ticket => this.view(ticket),
        model: config.router.model, effort: config.router.effort, defer, log, health: this.health, ...deps.model ? { call: deps.model } : {} })
      : new InterimRouter(this.jobs, () => this.engine, this.repo, log, config.github ? [config.github.login] : [])
    this.engine = new Engine({
      repo: this.repo, policy: () => settingsPolicy(this.settings, scope), scope, assessor: this.router, executor: this.executor,
      outbox: this.outbox, prepareTicket: (ticket, outcome) => this.executor.prepare(ticket, outcome),
      emit: event => {
        this.events.push(event); if (this.events.length > 500) this.events.shift()
        // A person's message that reached an open ticket is its worker's; the Router hears of it in the same transaction, and of
        // those for an ended ticket once it resumes, so it can stop the work when the person asks (the prototype's follow_up notice).
        // A ticket resumes on the first of them; every one still waiting is announced, such as a stop written after it during a pause.
        if (event.type === 'ticket.resumed') for (const triggerId of this.waiting(event.data.ticketId)) this.followup(triggerId)
        else if (event.type === 'trigger.received' || event.type === 'trigger.followup') this.followup(event.data.triggerId)
      },
    })
  }

  /** The people's messages a ticket has not been given yet, oldest first. */
  private waiting(ticketId: string): string[] {
    const ticket = this.repo.tickets.get(ticketId)
    return ticket?.undelivered.flatMap(id => {
      const input = ticket.inputs.find(item => item.id === id)
      return input?.kind === 'trigger' && input.human ? [input.triggerId] : []
    }) ?? []
  }
  /**
   * Tells the Router of a person's follow-up that open tickets own, as the prototype's `followupNotice` does. The owners include
   * ended tickets the message is about to resume, since tickets wake one at a time: a stop that reaches two of them is told with
   * both from the first wake, not with whichever woke first.
   */
  private followup(triggerId: string): void {
    const trigger = this.repo.triggers.get(triggerId)
    if (!trigger) return
    const owners = followupOwners(trigger, this.repo).flatMap(id => this.repo.tickets.get(id) ?? [])
    if (owners.some(ticket => liveTicket(ticket))) this.router.followup?.(trigger, owners)
  }

  /** Resumes the work a previous run left (Tickets in t3code threads, messages not yet sent), then starts the passes. */
  start(): void {
    this.executor.resume()
    this.outbox.resume()
    this.github?.start()
    this.router.start?.()
    if (this.watchdog && this.config.watchdogMinutes) this.watchWatchdogPending()
    this.pass = setInterval(() => {
      try { this.engine.evaluateDue() } catch (error) { this.config.log('pass failed', error) }
    }, 1000)
  }
  async stop(): Promise<void> {
    clearInterval(this.pass)
    clearInterval(this.watchdogTimer)
    clearInterval(this.watchdogPendingTimer)
    this.github?.stop()
    await this.router.stop?.()
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
  /** The Watchdog's own token, derived from the console's so it never opens the console's tools. */
  watchdogToken(): string { return createHash('sha256').update(`watchdog:${this.config.consoleToken}`).digest('base64url').slice(0, 32) }
  watchdogUrl(): string { return `${this.config.publicUrl}/mcp/watchdog/${this.watchdogToken()}` }

  /**
   * Phase 3: the Watchdog thread. Its first message tells its agent to schedule its own checks with t3code's `schedule_task`,
   * bound to its thread, so t3code wakes it whether or not this service runs: a check that cannot reach the super agent is
   * itself the alarm. In the other direction, when check-ins stop, this service asks the Watchdog to check and re-arm.
   */
  async ensureWatchdog(): Promise<void> {
    const minutes = this.config.watchdogMinutes
    if (!minutes) return
    const requestId = `superagent-watchdog:${createHash('sha256').update(this.config.consoleToken).digest('hex').slice(0, 16)}`
    const launched = await this.t3.launchScratch({ title: 'Superagent Watchdog', clientRequestId: requestId })
    this.watchdog = { threadId: launched.threadId, link: launched.link }
    this.repo.kv.set('watchdog', this.watchdog)
    const detail = await this.t3.read(launched.threadId, { limit: 1 })
    if (detail.thread.worktreePath) await writeMcpConfig(detail.thread.worktreePath, this.watchdogUrl())
    else this.config.log(`The Watchdog thread has no folder; add its MCP server by hand: ${MCP_SERVER_NAME} ${this.watchdogUrl()}`)
    if (!detail.items.length) {
      await this.t3.send(launched.threadId, watchdogSetup(minutes), `${requestId}:setup`, 'queue')
        .catch(error => this.config.log('setting up the Watchdog failed', error))
    }
    const since = Date.now()
    clearInterval(this.watchdogTimer)
    this.watchdogTimer = setInterval(() => { void this.checkWatchdog(since).catch(error => this.config.log('checking the Watchdog failed', error)) },
      minutes * 60_000)
    this.watchWatchdogPending()
  }

  /**
   * The Watchdog thread can itself wait on an approval, such as for a T3 Code tool its agent calls, and then no check runs.
   * Nothing else would notice, so its thread is looked at on a slow timer and shown as an alert while it waits.
   */
  private watchWatchdogPending(): void {
    clearInterval(this.watchdogPendingTimer)
    this.watchdogPendingTimer = setInterval(() => { void this.checkWatchdogPending() }, this.watchdogPendingMs)
  }
  /** Looks once at what the Watchdog thread waits on; a failure is logged and keeps the last answer. */
  async checkWatchdogPending(): Promise<PendingRequest[]> {
    if (!this.watchdog) return []
    try {
      const requests = await this.t3.pendingRequests(this.watchdog.threadId)
      this.watchdogPending = requests.length ? { requests, since: this.watchdogPending?.since ?? new Date().toISOString() } : undefined
    } catch (error) { this.config.log('reading what the Watchdog thread waits on failed', error) }
    return this.watchdogPending?.requests ?? []
  }

  /** Re-arms a Watchdog whose check-ins stopped for more than two and a half intervals. */
  async checkWatchdog(since: number, now = Date.now()): Promise<boolean> {
    const window = this.config.watchdogMinutes * 60_000 * 2.5
    const last = this.repo.kv.get<string>('watchdog:last-check')
    const quiet = now - Math.max(last ? Date.parse(last) : 0, since)
    if (!this.watchdog || quiet <= window) { this.health.ok('watchdog'); return false }
    this.health.fail('watchdog', `no check-in for ${Math.round(quiet / 60_000)} minutes`)
    await this.t3.send(this.watchdog.threadId, WATCHDOG_REARM, `superagent-watchdog:rearm:${Math.floor(now / window)}`, 'auto')
    return true
  }
  panelUrl(): string { return `${this.config.publicUrl}/panel/${this.config.consoleToken}` }

  // Reads for the console and the panel.

  view(ticket: Ticket): TicketView {
    const stage = ticketStage(ticket)
    const report = latestReport(ticket)
    const origin = this.repo.triggers.get(ticket.origin.triggerId)
    const requests = ticket.ended ? [] : this.executor.pending(ticket.id)
    const approvals = requests.flatMap(request => request.kind === 'approval' ? [{ requestId: request.requestId, text: request.text }] : [])
    const questions = requests.flatMap(request => request.kind === 'question'
      ? request.questions.map(question => ({ ...question, requestId: request.requestId })) : [])
    let named = 'action' in stage && stage.action ? `${stage.stage}/${stage.action}` : stage.stage
    // A worker that waits on t3code for a person needs one as much as a worker that asked through its report.
    if (stage.stage !== 'person' && stage.stage !== 'ended' && requests.length) named = approvals.length ? 'person/approve' : 'person/question'
    return { id: ticket.id, short: shortId(ticket.id), title: ticket.title, stage: named,
      ...requests.length ? { pending: { approvals, questions } } : {},
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

function watchdogSetup(minutes: number): string {
  return [
    'You are the Watchdog of the superagent: the external control loop that keeps it healthy over long runs. You are not part of it,',
    'and you do no ticket work.',
    '',
    `First, schedule your own checks: call the T3 Code tool schedule_task with title "Superagent watchdog check", schedule {type: "interval", everyMs: ${minutes * 60_000}},`,
    'bindToCurrentThread true, and the prompt "Run the superagent watchdog check." Check list_scheduled_tasks first and do not create a second one.',
    '',
    'In every check:',
    '1. Call watchdog_check (superagent MCP server). If the server cannot be reached at all, the superagent is down: say so in one line',
    '   in this thread, which is the operator’s alarm, and stop.',
    '2. Infrastructure: for each part in `failing` (t3code, github, router, watchdog, jobs:*), tell a passing fault from a lasting one.',
    '   Raise watchdog_alert once for a part failing across two checks.',
    '3. Progress: for each open ticket with running_turn and minutes_running above 30, or minutes_since_activity above 60 while working,',
    '   read watchdog_thread and judge whether the worker makes real progress toward its assignment, or loops (the same failing',
    '   command, the same edit back and forth) or drifts beyond its scope. Nudge a looping or drifting worker once with watchdog_nudge,',
    '   naming what it repeats and what to do instead. If an earlier nudge did not help, raise watchdog_alert recommending a stop:',
    '   never stop a ticket yourself.',
    '4. Failed or undelivered tickets: watchdog_retry only when the cause was passing and is gone, and only once per ticket.',
    '5. Check watchdog_alerts so you never raise the same alert twice.',
    '',
    'End each check with one line. When everything is healthy, the line is "All healthy." and nothing else. The operator may also ask',
    'you questions in this thread; answer them from these tools.',
    '',
    'Now schedule your checks, then run the first one.',
  ].join('\n')
}

const WATCHDOG_REARM = 'The superagent has not seen a Watchdog check for a while. Run the check now, then confirm with list_scheduled_tasks that '
  + 'your interval task exists and is enabled; create it again as your first message says if not.'

const CONSOLE_INTRO = [
  'This is the Superagent console. You help the operator run the superagent, which works on tickets in their own T3 Code threads.',
  'Use the `superagent` MCP tools: superagent_attention first (what waits for a person), superagent_status, superagent_ticket, '
    + 'superagent_request to start work, superagent_answer to answer a ticket\'s question, superagent_stop, superagent_retry, '
    + 'superagent_note, superagent_pause, superagent_messages and superagent_dismiss_alert (for the Watchdog\'s alerts).',
  'A ticket at person/approve waits on an approval in its T3 Code thread: only T3 Code can grant it, so link the thread and say so.',
  'Keep answers short. Do not do ticket work in this thread: start a request instead, and link each ticket\'s thread when you mention it.',
  'Reply with one line saying you are ready.',
].join('\n')
