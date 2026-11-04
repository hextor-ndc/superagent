/**
 * Point 1: each Ticket runs as a native t3code thread. `T3Executor` implements the core's `Executor` port (start, deliver,
 * stop) on t3code's outside-agent MCP tools, and reports back through the Engine's executor callbacks.
 *
 * The Engine calls the port inside its transactions, so every method only queues a job; jobs run on a later tick.
 */
import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { latestAssignment, liveTicket, runningAssignment, waitsForPerson, type AssessmentOutcome, type Assignment, type EngineForExecutor,
  type Executor, type Repositories, type Ticket, type TicketInput } from '../../vendor/dsh/src/core/index.ts'
import type { Settings } from '../../vendor/dsh/src/policy.ts'
import type { Health } from '../app/health.ts'
import { Jobs, Later } from '../app/jobs.ts'
import type { ProjectBinding, ProjectRegistry } from '../app/projects.ts'
import { T3Error, TERMINAL, type PendingRequest, type T3Client, type T3Status } from '../t3/client.ts'
import { assignmentMessage, BRANCH_DELIVERABLE, inputMessage, threadTitle, ticketName, type ExecutionVariables } from './render.ts'
import { WorkerSlots } from './slots.ts'
import { prepareWorktree, type Prepared } from './workspace.ts'

/** What the executor keeps per Ticket: its t3code thread, worktree and worker capability token. Phase 2 persists it. */
export interface TicketThread {
  ticketId: string
  threadId?: string
  link?: string
  /**
   * The T3 Code project the thread was launched under, as a cross-check of the Ticket's binding (which stays in its own kv
   * row, since this record is first saved when the worktree is made, or after the launch). Absent on records saved before projects
   * were kept per ticket.
   */
  projectId?: string
  worktreePath: string
  branch: string
  /** The commit the worktree started from, when this service made it, and the note on the checkout's uncommitted changes. */
  baseSha?: string
  baseNote?: string
  /** The capability in the Ticket's worker MCP URL; only this Ticket's worker holds it. */
  token: string
  /** The latest run whose end was reported to the Engine. */
  endedRunId?: string
  /** Turns that failed in a row; reset by a turn that ends well. */
  failures?: number
  /**
   * The failed run whose handling (`failedTurn`) has not finished, saved with the failure it counts: the worker has not been
   * told to go on yet, or the turn end that follows the Ticket's failed report has not been reported (`reported` says that
   * report was made). A restart picks the handling up from here. Entries saved before it was kept have none. `requestId` is
   * the request id the message telling the worker to go on goes under when it is not the run's (`continueRequestId`):
   * an entry saved before `failing` was kept sent that message under the failure count.
   */
  failing?: { runId: string; reported?: boolean; requestId?: string }
  /**
   * Inputs handed to the thread that its worker has not read yet. One sent into a running or a new run is read at once, so
   * only those t3code queued behind another message wait here (see `queued`), and those that carried no message or were saved
   * before reads were tracked this way, which count as read at the next turn end.
   */
  unread: string[]
  /** The unread Inputs t3code queued, by the run it queued them in: they count as read once that run is seen started. */
  queued?: Record<string, string[]>
}

export interface T3ExecutorOptions {
  t3: T3Client
  engine: () => Pick<EngineForExecutor, 'assignmentStarted' | 'inputsDelivered' | 'inputsRead' | 'turnEnded' | 'deliveryFailed' | 'report'
    | 'assignmentInterrupted'>
  repo: Pick<Repositories, 'tickets' | 'triggers'>
  settings: () => Settings
  /**
   * The registry, read before a new thread launches: the project must still be registered at the root its Ticket was bound to.
   * It never chooses a Ticket's project; `bindings` does.
   */
  projects: Pick<ProjectRegistry, 'fresh' | 'byId'>
  /** Each Ticket's project, as `bindProject` recorded it at the accept: the only place a launch takes its project from (D3). */
  bindings: { of(ticketId: string): ProjectBinding | undefined }
  /** How old the registry may be before a new thread's launch reads it again; 60 s by default. */
  projectsMaxAgeMs?: number
  /** The first pause before a failed launch is tried again; it doubles each time. 5 s by default. */
  launchRetryMs?: number
  branchPrefix?: string
  /** Builds a Ticket's worker MCP URL from its capability token. */
  workerUrl: (token: string) => string
  /** The most worker threads that may run at once. */
  maxWorkers: () => number
  /** Runtime mode for worker threads; t3code caps it at the outside agent's granted ceiling. */
  runtimeMode?: string
  account?: { login?: string; commitEmail?: string }
  /** How long one `t3_thread_wait` call waits, and the pause between looks at an idle thread. */
  waitMs?: number
  idlePollMs?: number
  /** The first pause before a worker whose turn failed is told to go on; it doubles each time. */
  continueAfterMs?: number
  /**
   * The shortest pause between two looks at what a busy worker's thread waits on (`T3Client.pendingRequests`). A thread blocked
   * on an approval or a question still reports `running`, so the wait loop alone cannot tell it from a long turn.
   */
  pendingCheckMs?: number
  log?: (message: string, error?: unknown) => void
  /** Where t3code's reachability is reported, for the Watchdog. */
  health?: Health
  /** Where each Ticket's thread record survives a restart. */
  state?: { load(): TicketThread[]; save(entry: TicketThread): void }
  /** Queues work once the Engine's transaction commits (`Store.afterCommit`); at once without one. */
  defer?: (run: () => void) => void
}

/** Why a launch of a Ticket that has no binding fails: there is no default at launch time (D3). */
export const NO_BINDING = 'No project is recorded for this ticket, and a launch never picks one: use superagent_reroute to file its request in a project.'
/** Why a new thread cannot launch in a project T3 Code no longer has where the Ticket was bound. */
export const unregistered = (binding: Pick<ProjectBinding, 'key' | 'root'>): string => `Project ${binding.key} is no longer registered in T3 Code at `
  + `${binding.root}. A ticket keeps the project it was accepted into, so a retry fails the same way: use superagent_reroute to file this `
  + 'request in the project\'s current registration.'

/** How many times a worker whose turn failed is told to go on before its Ticket is reported failed, as in the prototype. */
const CONTINUATIONS = 3
/** How many times a stop's interrupt is tried again after a failure. */
const STOP_RETRIES = 2

const fromPerson = (input?: TicketInput): boolean => input?.kind === 'trigger' ? !!input.human && !input.context : input?.kind === 'text'
/**
 * Run statuses that show a queued run took its messages into a turn. A queued run that ended any other way may have been
 * cancelled before it started, so its Inputs stay unread unless it was seen running.
 */
const STARTED: ReadonlySet<T3Status> = new Set(['running', 'waiting', 'completed'])

export class T3Executor implements Executor {
  readonly jobs: Jobs
  readonly slots: WorkerSlots
  private readonly threads = new Map<string, TicketThread>()
  /** Tickets whose thread runs a turn, which holds a worker slot. */
  private readonly busy = new Set<string>()
  /** When each busy Ticket's current turn was first seen running, for the Watchdog. */
  private readonly busyAt = new Map<string, string>()
  private readonly watching = new Map<string, AbortController>()
  /** Stops in flight, by Ticket: a new launch of the same Ticket waits for them, so an interrupt never lands on its new turn. */
  private readonly stopping = new Map<string, Promise<void>>()
  /**
   * The stop jobs not done yet, by job key, with the failures counted so far: one queued again under the same key replaces the
   * job's run function (see `Jobs`), so it keeps the record a launch may already wait on.
   */
  private readonly stops = new Map<string, { done: () => void; failures: number }>()
  /**
   * Tickets whose saved thread record may be one an earlier version saved in the pause after a failed turn (see `watch`). The
   * first look at the thread after this service started settles it.
   */
  private readonly savedInPause = new Set<string>()
  /** What each busy Ticket's thread waits on a person for, as last seen; in memory only, so a restart finds it again on the next look. */
  private readonly waitingOn = new Map<string, PendingRequest[]>()
  /** When each busy Ticket's thread was last asked what it waits on. */
  private readonly pendingCheckedAt = new Map<string, number>()
  /**
   * Requests answered here during each busy Ticket's current turn. A look that was already out when one was answered returns it
   * as still pending, so every look's result leaves these out.
   */
  private readonly answered = new Map<string, Set<string>>()
  /**
   * Turn ends being reported, by Ticket. Reporting one may wait on t3code and on the clock (see `turnEnded`), and a delivery
   * sent meanwhile may start the next run: its reads wait for the end, so they never count as read before it.
   */
  private readonly ending = new Map<string, Promise<void>>()
  private closed = false

  constructor(private readonly options: T3ExecutorOptions) {
    // A kind of job (launch, deliver, stop) counts as failing after three failures in a row; one that then runs clears it.
    this.jobs = new Jobs((key, error, final) => {
      options.log?.(`${key} failed${final ? ' for the last time' : ''}`, error)
      options.health?.fail(`jobs:${key.split(':')[0]}`, error)
    }, options.defer, key => options.health?.recovered(`jobs:${key.split(':')[0]}`))
    this.slots = new WorkerSlots(() => [...this.busy], options.maxWorkers)
    for (const entry of options.state?.load() ?? []) {
      this.threads.set(entry.ticketId, entry)
      if (!entry.failing && entry.failures && entry.endedRunId) this.savedInPause.add(entry.ticketId)
    }
  }

  /**
   * After this service restarts. Workers run in t3code, which may have kept running meanwhile: a running Assignment with a
   * thread is watched again rather than restarted, and its waiting Inputs go out; a pending one launches. A run that t3code
   * itself interrupted is handled by the watch, as any interruption the super agent did not ask for.
   */
  resume(): void {
    const tickets = this.options.repo.tickets.active().sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    for (const ticket of tickets) {
      const assignment = latestAssignment(ticket)
      if (!assignment || !liveTicket(ticket)) continue
      if (assignment.state === 'running' && this.threads.get(ticket.id)?.threadId) {
        this.watch(ticket.id, assignment.id)
        if (ticket.undelivered.length) this.deliver(ticket, assignment)
      } else if (assignment.state === 'running') this.options.engine().assignmentInterrupted(ticket.id, assignment.id)
      else if (assignment.state === 'pending' && !waitsForPerson(ticket)) this.start(ticket, assignment)
    }
  }
  private save(entry: TicketThread): void {
    try { this.options.state?.save(entry) } catch (error) { this.options.log?.(`saving the thread of ${entry.ticketId} failed`, error) }
  }

  /**
   * The Engine's `prepareTicket` hook, after the Runtime bound the Ticket to `binding`: its worktree goes in the project's
   * worktree folder, and a `branch` project's deliverable is written into the assignment, which the brief reads as the
   * explicit request for another deliverable than a pull request.
   */
  prepare(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>, binding: Pick<ProjectBinding, 'worktreeRoot' | 'delivery'>): Ticket {
    const name = ticketName(outcome.name, ticket.id)
    const ruleIds = ticket.mandate.basis.rules
    const rules = this.options.settings().policy.rules.filter(rule => ruleIds?.includes(rule.id))
      .map(rule => `\n- ${rule.name} (${rule.id}): ${rule.instruction}`).join('')
    const note = outcome.note ? `\nRouting note (not the source request): ${outcome.note}` : ''
    const assignment = ticket.mandate.strength === 'inferred' && ruleIds
      ? `Proactively accepted under ${ruleIds.join(', ')}. Scope: ${outcome.scope}.${rules ? `\nMatched rules; their procedure and `
        + `communication instructions take precedence for this ticket:${rules}` : ''}${note}`
      : `Scope: ${outcome.scope}.${note}`
    const deliverable = binding.delivery === 'branch' ? `\n${BRANCH_DELIVERABLE}` : ''
    return { ...ticket, execution: { name, directory: join(binding.worktreeRoot, name), assignment: `${assignment}${deliverable}` } }
  }

  /** The t3code thread of a Ticket, for links and the console. */
  thread(ticketId: string): TicketThread | undefined { return this.threads.get(ticketId) }
  /** The Ticket a worker capability token belongs to. */
  ticketOfToken(token: string): string | undefined {
    for (const entry of this.threads.values()) if (entry.token === token) return entry.ticketId
    return undefined
  }
  private markBusy(ticketId: string): void {
    this.busy.add(ticketId)
    if (!this.busyAt.has(ticketId)) this.busyAt.set(ticketId, new Date().toISOString())
  }
  /** Since when a Ticket's worker has been running its current turn; undefined while it is idle. */
  busySince(ticketId: string): string | undefined { return this.busy.has(ticketId) ? this.busyAt.get(ticketId) : undefined }
  /** The approvals and questions a Ticket's worker thread waits on, as last seen; empty while it waits on no one. */
  pending(ticketId: string): PendingRequest[] { return this.waitingOn.get(ticketId) ?? [] }
  /** Forgets one request once it is answered here, so the view does not wait for the next look. */
  dropPending(ticketId: string, requestId: string): void {
    const answered = this.answered.get(ticketId) ?? new Set<string>()
    this.answered.set(ticketId, answered.add(requestId))
    const left = this.pending(ticketId).filter(request => request.requestId !== requestId)
    if (left.length) this.waitingOn.set(ticketId, left)
    else this.waitingOn.delete(ticketId)
  }
  private clearPending(ticketId: string): void { this.waitingOn.delete(ticketId); this.pendingCheckedAt.delete(ticketId); this.answered.delete(ticketId) }
  private unanswered(ticketId: string, pending: PendingRequest[]): PendingRequest[] {
    const answered = this.answered.get(ticketId)
    return answered ? pending.filter(request => !answered.has(request.requestId)) : pending
  }
  /**
   * Asks t3code now what a Ticket's thread waits on, without the pause between looks, for an answer that names a question the
   * last look has not seen (after a restart, before the first look). Leaves out requests already answered here.
   */
  async lookPending(ticketId: string): Promise<PendingRequest[]> {
    const threadId = this.threads.get(ticketId)?.threadId
    if (!threadId || !this.busy.has(ticketId)) return []
    return this.unanswered(ticketId, await this.options.t3.pendingRequests(threadId))
  }
  /** Asks t3code what a busy thread waits on, at most once per `pendingCheckMs`. A failure is logged and keeps the last answer. */
  private async checkPending(ticketId: string, threadId: string, signal: AbortSignal): Promise<void> {
    const last = this.pendingCheckedAt.get(ticketId)
    if (last !== undefined && Date.now() - last < (this.options.pendingCheckMs ?? 15_000)) return
    this.pendingCheckedAt.set(ticketId, Date.now())
    try {
      const seen = await this.options.t3.pendingRequests(threadId)
      // A turn that ended or a stop while the look was out has already cleared it.
      if (signal.aborted || !this.busy.has(ticketId)) return
      const pending = this.unanswered(ticketId, seen)
      if (pending.length) this.waitingOn.set(ticketId, pending)
      else this.waitingOn.delete(ticketId)
    } catch (error) { this.options.log?.(`reading what ${ticketId} waits on failed`, error) }
  }
  /** Worker slots in use, for the console. */
  load(): { used: number; max: number } { return { used: this.slots.used(), max: this.options.maxWorkers() } }

  start(ticket: Ticket, assignment: Assignment): void {
    this.jobs.enqueue(`launch:${ticket.id}`, () => this.launch(ticket.id, assignment.id),
      { retries: 3, firstDelayMs: this.options.launchRetryMs ?? 5000, maxDelayMs: 300_000 })
  }
  deliver(ticket: Ticket, assignment: Assignment): void {
    this.jobs.enqueue(`deliver:${ticket.id}`, () => this.deliverNow(ticket.id, assignment.id), { retries: 6, firstDelayMs: 2000 })
  }
  stop(ticket: Ticket, assignment: Assignment, reason: string): void {
    const ended = !liveTicket(ticket)
    this.stopJob(ticket.id, `stop:${ticket.id}:${assignment.id}`, async () => {
      this.watching.get(ticket.id)?.abort(); this.watching.delete(ticket.id)
      this.busy.delete(ticket.id); this.busyAt.delete(ticket.id); this.clearPending(ticket.id); this.slots.free(ticket.id); this.slotFreed()
      const entry = this.threads.get(ticket.id)
      if (!entry?.threadId) return
      // An ended Ticket's thread stops as its Stop button does. A Ticket that goes on (a retry or a restart) only has its
      // turn interrupted, since a full stop would hold the messages its next Assignment sends.
      await this.options.t3.interrupt(entry.threadId, { ...ended ? { stop: true } : {}, reason: reason.slice(0, 2000),
        clientRequestId: `stop:${assignment.id}` })
        .catch(error => { if (!(error instanceof T3Error && error.code === 'thread_not_interruptible')) throw error })
    })
  }
  /**
   * Queues a stop's job under `key`, which a new launch of the Ticket waits for, together with the stops already in flight.
   * The wait ends once the job ran without an error or failed for the last time, not at a failure it tries again after: the
   * interrupt that try makes would land on the new launch's turn.
   */
  private stopJob(ticketId: string, key: string, run: () => Promise<void>): void {
    let record = this.stops.get(key)
    if (!record) {
      let resolve!: () => void
      const stopped = new Promise<void>(done => { resolve = done })
      const made = { done: () => { if (this.stops.get(key) === made) this.stops.delete(key); resolve() }, failures: 0 }
      this.stops.set(key, record = made)
      const before = this.stopping.get(ticketId)
      this.stopping.set(ticketId, before ? Promise.all([before, stopped]).then(() => {}) : stopped)
    }
    const stop = record
    this.jobs.enqueue(key, async () => {
      try { await run() } catch (error) {
        if (++stop.failures > STOP_RETRIES) stop.done()
        throw error
      }
      stop.done()
    }, { retries: STOP_RETRIES })
  }

  async close(): Promise<void> {
    this.closed = true
    for (const controller of this.watching.values()) controller.abort()
    this.watching.clear()
    this.jobs.close()
  }

  /**
   * Starts a pending Assignment: a new thread, or a new message in the Ticket's thread. The Engine may stop it while the launch
   * is out (the Ticket ends, and its Assignments with it, in the transaction that queues the stop). The stop job then finds no
   * thread, or no run yet, to interrupt, so the launch looks again once its t3code call comes back and stops what it started
   * itself (`stopStarted`); a stop before that call leaves the call out.
   */
  private async launch(ticketId: string, assignmentId: string): Promise<void> {
    const ticket = this.options.repo.tickets.get(ticketId)
    const assignment = ticket?.assignments.find(item => item.id === assignmentId)
    if (!ticket || !liveTicket(ticket) || assignment?.state !== 'pending' || waitsForPerson(ticket)) return
    const stopping = this.stopping.get(ticketId)
    await stopping
    // A stop queued meanwhile stays, for the next launch to wait on: it is a stop of this Assignment, which the looks below see.
    if (this.stopping.get(ticketId) === stopping) this.stopping.delete(ticketId)
    if (!this.waitsToStart(ticketId, assignmentId)) return
    // Every launch, retry, restart and resume takes its project from the binding alone; without one it fails, never defaults.
    const binding = this.options.bindings.of(ticketId)
    if (!binding) { this.fail(ticketId, NO_BINDING); return }
    const known = this.threads.get(ticketId)
    if (known?.projectId && known.projectId !== binding.projectId) {
      this.fail(ticketId, `This ticket's thread is in T3 Code project ${known.projectId}, but the ticket is bound to ${binding.key} (${binding.projectId}): `
        + 'stop it and request the work again.')
      return
    }
    this.slots.reserve(ticketId, 'launch')
    let stopped = false
    try {
      const entry = known ?? this.newEntry(ticket)
      // A retry or a restart with a thread only sends to it. A new thread needs the project registered where it was bound:
      // re-adding a folder in T3 Code gives it a new id, and the binding is a snapshot, so a plain retry would fail again.
      if (!entry.threadId) {
        try { await this.options.projects.fresh(this.options.projectsMaxAgeMs ?? 60_000) } catch (error) {
          if (!(error instanceof T3Error)) {
            // A local file (projects.json, the catalogue) the refresh could not read. It says nothing of T3 Code's ids and roots,
            // so the last list read still answers whether the project is registered there, and t3code checks the launch itself.
            this.options.log?.(`reading the projects before launching ${ticketId} failed; checking its project against the last list read`, error)
          } else if (error.transient) {
            // T3 Code cannot be asked now: the launch is tried again later, and the Ticket does not fail.
            throw new Error(`Reading T3 Code's projects before launching ${ticketId} failed: ${message(error)}`)
          } else {
            // A lasting refusal, such as a token that may not list projects, fails the Ticket where it shows, as a launch's does.
            if (this.waitsToStart(ticketId, assignmentId)) this.fail(ticketId, `Reading T3 Code's projects before the launch failed: ${error.message}`)
            return
          }
        }
        const registered = this.options.projects.byId(binding.projectId)
        if (!registered || registered.root !== binding.root) {
          if (this.waitsToStart(ticketId, assignmentId)) this.fail(ticketId, unregistered(binding))
          return
        }
      }
      let prepared: Prepared
      try {
        prepared = await prepareWorktree({ projectRoot: binding.root, ...binding.commonDir ? { commonDir: binding.commonDir } : {},
          worktreeRoot: binding.worktreeRoot, directory: ticket.execution!.directory, name: ticket.execution!.name,
          branchPrefix: this.options.branchPrefix ?? 'agent/', baseRef: binding.baseRef, dirty: binding.dirty, mcpUrl: this.options.workerUrl(entry.token) })
      } catch (error) {
        // A failed preparation fails the Ticket at once, as in the prototype: a retry or a person's message prepares again.
        if (this.waitsToStart(ticketId, assignmentId)) this.fail(ticketId, `Preparing the worktree failed: ${message(error)}`)
        return
      }
      Object.assign(entry, { worktreePath: prepared.worktreePath, branch: prepared.branch, projectId: binding.projectId })
      this.threads.set(ticketId, entry)
      if (prepared.base) {
        entry.baseSha = prepared.base.sha
        if (prepared.base.note) entry.baseNote = prepared.base.note
        else delete entry.baseNote
        // Only the preparation that made the worktree knows its base: saved now, a restart before the thread exists keeps it.
        this.save(entry)
      }
      if (!this.waitsToStart(ticketId, assignmentId)) { stopped = true; return }
      const described = this.options.projects.byId(binding.projectId)
      const catalogue = described?.describe && described.catalogue && 'path' in described.catalogue ? described.catalogue : undefined
      const variables: ExecutionVariables = { ticketId, name: ticket.execution!.name, directory: prepared.worktreePath, branch: prepared.branch,
        ...binding.delivery === 'pr' && binding.repository ? { repository: binding.repository } : {},
        account: this.options.account?.login, commitEmail: this.options.account?.commitEmail, delivery: binding.delivery,
        ...entry.baseSha ? { base: { ref: binding.baseRef, sha: entry.baseSha, ...entry.baseNote ? { note: entry.baseNote } : {} } } : {},
        project: { title: binding.title, key: binding.key, root: binding.root, ...catalogue?.purpose ? { purpose: catalogue.purpose } : {},
          ...catalogue?.map ? { map: catalogue.map } : {} } }
      const origin = this.options.repo.triggers.get(ticket.origin.triggerId)
      const batch = ticket.origin.triggerIds.filter(id => id !== ticket.origin.triggerId).flatMap(id => this.options.repo.triggers.get(id) ?? [])
      const text = assignmentMessage(ticket, origin, variables, batch)
      let threadId = entry.threadId
      if (threadId) {
        // A new Assignment of a Ticket that has a thread (a retry or a restart) continues in that thread.
        await this.options.t3.send(threadId, `${text}\n\nThis is a new assignment of the same ticket: continue from the worktree's current state.`,
          `assign:${assignmentId}`)
      } else {
        const launched = await this.options.t3.launch({ projectId: binding.projectId, title: threadTitle(ticket), message: text,
          worktreePath: prepared.worktreePath, branch: prepared.branch, clientRequestId: `launch:${assignmentId}`,
          ...(this.options.runtimeMode ? { runtimeMode: this.options.runtimeMode } : {}) })
        threadId = launched.threadId
        Object.assign(entry, { threadId, link: launched.link })
      }
      if (!this.waitsToStart(ticketId, assignmentId)) {
        // Stopped while the call was out: the thread is kept for the Ticket's later Assignments, and the run it started stops.
        // The worker slot stays free, and the Engine hears nothing of an Assignment it has ended.
        stopped = true
        this.save(entry)
        this.stopStarted(ticketId, assignmentId, threadId)
        return
      }
      entry.failures = 0
      delete entry.failing
      this.save(entry)
      this.markBusy(ticketId)
      this.options.engine().assignmentStarted(ticketId, assignmentId)
      this.watch(ticketId, assignmentId)
    } catch (error) {
      if (error instanceof Later) throw error
      // An Assignment stopped meanwhile has nothing left to start; a failure reported now would land on the Ticket's next one.
      if (!this.waitsToStart(ticketId, assignmentId)) { stopped = true; return }
      if (error instanceof T3Error && !error.transient) { this.fail(ticketId, `Starting the T3 Code thread failed: ${error.message}`); return }
      throw error
    } finally {
      // The stop job may have freed this reservation already; freeing it again is harmless, since slots are held by Ticket and
      // no other job of this Ticket holds one while a launch runs (a delivery needs a running Assignment).
      this.slots.free(ticketId)
      if (stopped) this.slotFreed()
    }
  }
  /** Whether an Assignment is still to start: its Ticket is open and the Engine has not ended it. */
  private waitsToStart(ticketId: string, assignmentId: string): boolean {
    const ticket = this.options.repo.tickets.get(ticketId)
    return !!ticket && liveTicket(ticket) && ticket.assignments.find(item => item.id === assignmentId)?.state === 'pending'
  }
  /**
   * Interrupts the run a launch started for an Assignment stopped while the launch was out, fully stopping the thread when the
   * Ticket ended, as the stop job does. Both may interrupt the thread, in either order, and the second finds nothing to
   * interrupt. This one has its own request id: t3code answers a repeated `stop:<assignmentId>` with the first answer, without
   * interrupting again. It runs as a stop's job (`stopJob`), so a failure is tried again, and a new launch of the Ticket waits
   * for it as for a stop.
   */
  private stopStarted(ticketId: string, assignmentId: string, threadId: string): void {
    const ticket = this.options.repo.tickets.get(ticketId)
    const ended = !ticket || !liveTicket(ticket)
    const reason = ticket?.ended ? ticket.ended.reason ?? ticket.ended.outcome
      : ticket?.assignments.find(item => item.id === assignmentId)?.endedReason ?? 'stopped'
    this.stopJob(ticketId, `stop:${ticketId}:${assignmentId}:launch`, () => this.options.t3.interrupt(threadId, { ...ended ? { stop: true } : {},
      reason: reason.slice(0, 2000), clientRequestId: `stop-launch:${assignmentId}` })
      .catch(error => { if (!(error instanceof T3Error && error.code === 'thread_not_interruptible')) throw error }))
  }

  private async deliverNow(ticketId: string, assignmentId: string): Promise<void> {
    const ticket = this.options.repo.tickets.get(ticketId)
    const entry = this.threads.get(ticketId)
    if (!ticket || !liveTicket(ticket) || runningAssignment(ticket)?.id !== assignmentId || !entry?.threadId || !ticket.undelivered.length) return
    const inputs = ticket.undelivered.flatMap(id => ticket.inputs.find(input => input.id === id) ?? [])
    const wakes = !this.busy.has(ticketId)
    if (wakes) this.slots.reserve(ticketId, inputs.some(fromPerson) ? 'person' : 'wake')
    try {
      const delivery = this.options.bindings.of(ticketId)?.delivery
      const text = inputs.flatMap(input => inputMessage(input, input.kind === 'trigger' ? this.options.repo.triggers.get(input.triggerId) : undefined, delivery) ?? [])
        .join('\n\n')
      const ids = inputs.map(input => input.id)
      const sent = text ? await this.options.t3.send(entry.threadId, text, deliverRequestId(assignmentId, ids)) : undefined
      await this.ending.get(ticketId)
      // A stop that ran while the send was out (see the catch below) has freed the worker slot; nothing here may take it back.
      const now = this.options.repo.tickets.get(ticketId)
      if (!now || !liveTicket(now) || runningAssignment(now)?.id !== assignmentId) return
      this.markBusy(ticketId)
      // A message steered into the running turn, or one that started a run, is in the turn the worker's model is in, as the
      // prototype's Session taking it into its history: its Inputs are read now, before any report the worker writes after.
      // One t3code queued behind another message is read only once its run is seen started (`takenIn`).
      const inTurn = !!sent && sent.delivery !== 'queued'
      if (!inTurn) {
        entry.unread.push(...ids.filter(id => !entry.unread.includes(id)))
        if (sent) entry.queued = { ...entry.queued, [sent.runId]: [...new Set([...entry.queued?.[sent.runId] ?? [], ...ids])] }
        this.save(entry)
      }
      this.options.engine().inputsDelivered(ticketId, assignmentId, ids)
      if (inTurn) this.markRead(ticketId, entry, ids)
      this.watch(ticketId, assignmentId)
    } catch (error) {
      if (error instanceof Later) throw error
      // The Assignment ended while the send was out, such as a stop typed on the ticket's Issue that the Router acted on while
      // the same message went to the worker: t3code refuses a send to a run it is stopping. Nothing is left to deliver.
      const now = this.options.repo.tickets.get(ticketId)
      if (!now || !liveTicket(now) || runningAssignment(now)?.id !== assignmentId) return
      this.options.engine().deliveryFailed(ticketId, assignmentId, message(error))
      throw error
    } finally {
      if (wakes) this.slots.free(ticketId)
    }
  }

  /** Follows a worker thread's runs until its Assignment ends, telling the Engine when each turn ends. */
  private watch(ticketId: string, assignmentId: string): void {
    if (this.watching.has(ticketId) || this.closed) return
    const controller = new AbortController()
    this.watching.set(ticketId, controller)
    void (async () => {
      const { t3 } = this.options
      while (!controller.signal.aborted) {
        const ticket = this.options.repo.tickets.get(ticketId)
        const entry = this.threads.get(ticketId)
        if (!ticket || !entry?.threadId || latestAssignment(ticket)?.id !== assignmentId || latestAssignment(ticket)?.state === 'ended') break
        try {
          // A failed turn whose handling a restart cut short is taken up again before anything else (see `failedTurn`).
          const result = entry.failing ? { runId: entry.failing.runId, status: 'failed' as const, timedOut: false }
            : await t3.wait(entry.threadId, this.options.waitMs ?? 30_000)
          if (controller.signal.aborted) break
          // An entry saved before `failing` was kept, in the pause after a failed turn: its failure was counted and the run saved
          // as ended before the worker was told to go on, which went under the failure count. Only the first look after this
          // service started can find one: a failed run this version handled is saved the same way, but the message it sent
          // started a later run, which the wait names instead.
          const inPause = this.savedInPause.delete(ticketId)
          if (inPause && !entry.failing && result.status === 'failed' && result.runId && result.runId === entry.endedRunId && entry.failures) {
            entry.failing = { runId: result.runId, requestId: `continue:${assignmentId}:${entry.failures}` }
            delete entry.endedRunId
          }
          if (!result.timedOut && TERMINAL.has(result.status)) {
            this.options.health?.ok('t3code')
            const wasBusy = this.busy.delete(ticketId)
            this.busyAt.delete(ticketId)
            this.clearPending(ticketId)
            if (wasBusy || (result.runId && result.runId !== entry.endedRunId)) {
              this.slotFreed()
              if (controller.signal.aborted || this.stopping.has(ticketId)) break
              if (result.status === 'interrupted') {
                // Nobody here asked for it, so t3code restarted or a person pressed Stop: the Engine restarts the Assignment
                // with a recovery note unless its worker had already said its last word.
                if (result.runId) { entry.endedRunId = result.runId; this.save(entry) }
                this.options.engine().assignmentInterrupted(ticketId, assignmentId)
                break
              }
              if (result.status === 'failed' && await this.failedTurn(ticketId, assignmentId, entry, result.runId, controller.signal)) continue
              if (controller.signal.aborted) break
              const ended = this.turnEnded(ticketId, assignmentId, entry, result)
              this.ending.set(ticketId, ended)
              try { await ended } finally { if (this.ending.get(ticketId) === ended) this.ending.delete(ticketId) }
            }
            await sleep(this.options.idlePollMs ?? 5000, controller.signal)
          } else {
            this.options.health?.ok('t3code')
            this.markBusy(ticketId)
            const read = await this.takenIn(entry, result)
            if (read.length && !controller.signal.aborted) this.markRead(ticketId, entry, read)
            await this.checkPending(ticketId, entry.threadId, controller.signal)
          }
        } catch (error) {
          if (controller.signal.aborted) break
          this.options.log?.(`watching ${ticketId} failed`, error)
          this.options.health?.fail('t3code', error)
          await sleep(5000, controller.signal)
        }
      }
      if (this.watching.get(ticketId) === controller) this.watching.delete(ticketId)
    })()
  }

  /**
   * A turn that failed, such as on a provider error: the worker is told to go on, up to `CONTINUATIONS` times in a row with a
   * growing pause; after that the Ticket reports failed and waits for a person. Answers whether the worker goes on.
   *
   * A failed run that t3code had queued with Inputs may have failed before its model read them, and the wait cannot tell. Its
   * messages go again with the message that tells the worker to go on, and are read as that message is (see `deliverNow`).
   *
   * The handling survives a restart through `failing`, saved with the failure it counts. Until it is cleared the run is not
   * saved as ended, and the watch of a resumed Ticket takes the handling up again from that record, by crash point:
   * - before the count is saved, nothing is saved: the wait finds the run failed and not ended, and counts it as new;
   * - in the pause, or with the message telling the worker to go on out (sent or not), the failure is not counted again, the
   *   pause runs again, and the message goes again under the same request id, which t3code answers with the first answer if
   *   the first send landed: the held Inputs are then handled from that answer as they would have been. The request id is made
   *   from the failed run (`continueRequestId`), not the count: the count starts again after a turn that ends well, and a second failure of the same
   *   Assignment under a used id would be answered without a new run;
   * - once the message was sent and handled, `failing` is cleared and the run saved as ended, in one save;
   * - over `CONTINUATIONS`, before the failed report, it is made; after it (`reported`), it is not made again;
   * - in `turnEnded`, which follows the failed report, the turn end is reported again, since that saves its end last.
   * A failed run handled to its end is saved as ended with `failing` cleared, and is never taken up again.
   */
  private async failedTurn(ticketId: string, assignmentId: string, entry: TicketThread, runId: string | null, signal: AbortSignal): Promise<boolean> {
    if (!runId || entry.failing?.runId !== runId) {
      entry.failures = (entry.failures ?? 0) + 1
      if (runId) entry.failing = { runId }
      this.save(entry)
    }
    const failures = entry.failures ?? 1
    if (failures > CONTINUATIONS) {
      if (!entry.failing?.reported) {
        this.fail(ticketId, `The worker's turn failed ${CONTINUATIONS + 1} times in a row in T3 Code. Open its thread to see the error.`)
        if (entry.failing) { entry.failing.reported = true; this.save(entry) }
      }
      return false
    }
    await sleep((this.options.continueAfterMs ?? 15_000) * 2 ** (failures - 1), signal)
    // A stop during the pause (the Ticket ended, or its Assignment was replaced) leaves the worker stopped.
    if (signal.aborted) return false
    const held = runId ? entry.queued?.[runId] ?? [] : []
    const ticket = this.options.repo.tickets.get(ticketId)
    const again = held.flatMap(id => ticket?.inputs.find(input => input.id === id) ?? [])
      .flatMap(input => inputMessage(input, input.kind === 'trigger' ? this.options.repo.triggers.get(input.triggerId) : undefined,
        this.options.bindings.of(ticketId)?.delivery) ?? [])
    try {
      const sent = await this.options.t3.send(entry.threadId!, 'Your previous turn failed with an error. Go on with the assignment from where it stopped.'
        + (again.length ? `\n\nThe messages below came for the turn that failed. They are sent again in case it failed before you read them:\n\n${again.join('\n\n')}` : ''),
        (runId && entry.failing?.runId === runId ? entry.failing.requestId : undefined) ?? continueRequestId(assignmentId, runId, failures))
      // A stop while the send was out has freed the worker slot.
      if (signal.aborted) return false
      this.markBusy(ticketId)
      // The handling is done: the next save, below or in `markRead`, records it with what became of the held Inputs.
      if (runId) entry.endedRunId = runId
      delete entry.failing
      this.forget(entry, held)
      if (held.length && sent.delivery !== 'queued') this.markRead(ticketId, entry, held)
      else {
        if (held.length) {
          entry.unread.push(...held)
          entry.queued = { ...entry.queued, [sent.runId]: held }
        }
        this.save(entry)
      }
      return true
    } catch (error) {
      this.options.log?.(`telling ${ticketId} to go on failed`, error)
      return false
    }
  }

  /**
   * A turn ended. What the worker read in it counts as read before the end: Inputs from before reads were tracked at sending,
   * and queued ones whose run has started. The core counts an Input read before a turn end only when its read time is earlier
   * (`readBefore`), so the end is reported in a later millisecond than the reads.
   */
  private async turnEnded(ticketId: string, assignmentId: string, entry: TicketThread, result: { runId: string | null; status: T3Status }): Promise<void> {
    const queued = new Set(Object.values(entry.queued ?? {}).flat())
    const read = [...entry.unread.filter(id => !queued.has(id)), ...await this.takenIn(entry, result)]
    if (read.length) {
      this.markRead(ticketId, entry, read)
      // Taken after the reads are recorded: a clock read before them may be a millisecond behind the read time they get.
      await nextMillisecond(Date.now())
    }
    try { this.options.engine().turnEnded(ticketId, assignmentId) } catch (error) { this.options.log?.(`reporting the turn end of ${ticketId} failed`, error) }
    // Saved last, so a restart before this reports the turn end again rather than never: the reads it records are kept once,
    // and a turn end reported twice only moves the Assignment's idle time to the later one.
    if (result.runId) entry.endedRunId = result.runId
    entry.failures = 0
    delete entry.failing
    this.save(entry)
  }

  /**
   * The queued Inputs whose run has started, given what a wait just saw. A run the wait did not name is asked about by id:
   * t3code's wait follows a run into the run that continues it, and a later run means the queued one ran before it. A queued
   * run that ended cancelled, failed or interrupted without having been seen running is forgotten here; its Inputs stay unread
   * in the Engine, which gives them to the next Assignment or lets them go when the ticket ends. A failed one that the wait
   * named has had its messages sent again first (see `failedTurn`).
   */
  private async takenIn(entry: TicketThread, seen: { runId: string | null; status: T3Status }): Promise<string[]> {
    const read: string[] = []
    const gone: string[] = []
    for (const [runId, ids] of Object.entries(entry.queued ?? {})) {
      try {
        const status = seen.runId === runId ? seen.status : (await this.options.t3.wait(entry.threadId!, 0, runId)).status
        if (STARTED.has(status)) read.push(...ids)
        else if (TERMINAL.has(status)) gone.push(...ids)
      } catch (error) { this.options.log?.(`reading the queued run ${runId} of ${entry.ticketId} failed`, error) }
    }
    if (gone.length) { this.forget(entry, gone); this.save(entry) }
    return read
  }
  /** Tells the Engine that the worker read `ids`, and forgets them as unread. */
  private markRead(ticketId: string, entry: TicketThread, ids: string[]): void {
    this.forget(entry, ids)
    this.save(entry)
    try { this.options.engine().inputsRead(ticketId, ids) } catch (error) { this.options.log?.(`recording what ${ticketId} read failed`, error) }
  }
  private forget(entry: TicketThread, ids: string[]): void {
    entry.unread = entry.unread.filter(id => !ids.includes(id))
    if (entry.queued) {
      const left = Object.entries(entry.queued).flatMap(([runId, queued]) => {
        const rest = queued.filter(id => !ids.includes(id))
        return rest.length ? [[runId, rest] as const] : []
      })
      if (left.length) entry.queued = Object.fromEntries(left)
      else delete entry.queued
    }
  }

  /** Launches and wakes held back by full slots try again at once. */
  private slotFreed(): void { this.jobs.wake('launch:'); this.jobs.wake('deliver:') }

  private fail(ticketId: string, summary: string): void {
    try { this.options.engine().report(ticketId, { state: 'failed', summary: summary.slice(0, 2000) }) }
    catch (error) { this.options.log?.(`recording the failure of ${ticketId} failed`, error) }
  }

  private newEntry(ticket: Ticket): TicketThread {
    return { ticketId: ticket.id, worktreePath: ticket.execution!.directory, branch: '', token: randomBytes(24).toString('base64url'), unread: [] }
  }
}

/**
 * The request id of the message that tells a worker to go on after its failed run `runId`: one per failed run, and short. t3code
 * puts each message's request id, escaped again at every level, in the header of every history item it hands a new agent after
 * a crash, under a size limit; with the full run id (which holds the thread id) the Assignment's first message fell out of it.
 */
export const continueRequestId = (assignmentId: string, runId: string | null, failures: number): string =>
  `continue:${assignmentId}:${runId ? createHash('sha256').update(runId).digest('hex').slice(0, 10) : failures}`

/** The request id of a delivery: its one Input's id, or a short hash of several, kept short for the same reason. */
export const deliverRequestId = (assignmentId: string, ids: string[]): string =>
  `deliver:${assignmentId}:${ids.length === 1 ? ids[0] : createHash('sha256').update(ids.join(',')).digest('hex').slice(0, 10)}`

const message = (error: unknown): string => error instanceof Error ? error.message : String(error)
/** Waits, briefly, until the clock has passed the millisecond `at`. */
async function nextMillisecond(at: number): Promise<void> {
  for (let tries = 0; Date.now() <= at && tries < 5; tries++) await new Promise(resolve => setTimeout(resolve, 1))
}
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  const timer = setTimeout(resolve, ms)
  signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
})
