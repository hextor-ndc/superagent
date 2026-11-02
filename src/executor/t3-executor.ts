/**
 * Point 1: each Ticket runs as a native t3code thread. `T3Executor` implements the core's `Executor` port (start, deliver,
 * stop) on t3code's outside-agent MCP tools, and reports back through the Engine's executor callbacks.
 *
 * The Engine calls the port inside its transactions, so every method only queues a job; jobs run on a later tick.
 */
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { latestAssignment, liveTicket, runningAssignment, waitsForPerson, type AssessmentOutcome, type Assignment, type EngineForExecutor,
  type Executor, type Repositories, type Ticket, type TicketInput } from '../../vendor/dsh/src/core/index.ts'
import type { Settings } from '../../vendor/dsh/src/policy.ts'
import { Jobs, Later } from '../app/jobs.ts'
import { T3Error, TERMINAL, type T3Client } from '../t3/client.ts'
import { assignmentMessage, inputMessage, threadTitle, ticketName, type ExecutionVariables } from './render.ts'
import { WorkerSlots } from './slots.ts'
import { prepareWorktree, type Prepared } from './workspace.ts'

/** What the executor keeps per Ticket: its t3code thread, worktree and worker capability token. Phase 2 persists it. */
export interface TicketThread {
  ticketId: string
  threadId?: string
  link?: string
  worktreePath: string
  branch: string
  /** The capability in the Ticket's worker MCP URL; only this Ticket's worker holds it. */
  token: string
  /** The latest run whose end was reported to the Engine. */
  endedRunId?: string
  /** Inputs handed to the thread whose run has not ended yet: they count as read once a run that started after them ends. */
  unread: string[]
}

export interface T3ExecutorOptions {
  t3: T3Client
  engine: () => Pick<EngineForExecutor, 'assignmentStarted' | 'inputsDelivered' | 'inputsRead' | 'turnEnded' | 'deliveryFailed' | 'report'>
  repo: Pick<Repositories, 'tickets' | 'triggers'>
  settings: () => Settings
  /** The t3code project the workers run in, and its checkout on this machine. */
  project: { id: string; root: string; repository?: string }
  worktreeRoot: string
  baseRef?: string
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
  log?: (message: string, error?: unknown) => void
}

const fromPerson = (input?: TicketInput): boolean => input?.kind === 'trigger' ? !!input.human && !input.context : input?.kind === 'text'

export class T3Executor implements Executor {
  readonly jobs: Jobs
  readonly slots: WorkerSlots
  private readonly threads = new Map<string, TicketThread>()
  /** Tickets whose thread runs a turn, which holds a worker slot. */
  private readonly busy = new Set<string>()
  private readonly watching = new Map<string, AbortController>()
  private closed = false

  constructor(private readonly options: T3ExecutorOptions) {
    this.jobs = new Jobs((key, error, final) => options.log?.(`${key} failed${final ? ' for the last time' : ''}`, error))
    this.slots = new WorkerSlots(() => [...this.busy], options.maxWorkers)
  }

  // The Engine's `prepareTicket` hook: what the executor chose for a newly accepted Ticket.
  prepare(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>): Ticket {
    const name = ticketName(outcome.name, ticket.id)
    const ruleIds = ticket.mandate.basis.rules
    const rules = this.options.settings().policy.rules.filter(rule => ruleIds?.includes(rule.id))
      .map(rule => `\n- ${rule.name} (${rule.id}): ${rule.instruction}`).join('')
    const note = outcome.note ? `\nRouting note (not the source request): ${outcome.note}` : ''
    const assignment = ticket.mandate.strength === 'inferred' && ruleIds
      ? `Proactively accepted under ${ruleIds.join(', ')}. Scope: ${outcome.scope}.${rules ? `\nMatched rules; their procedure and `
        + `communication instructions take precedence for this ticket:${rules}` : ''}${note}`
      : `Scope: ${outcome.scope}.${note}`
    return { ...ticket, execution: { name, directory: join(this.options.worktreeRoot, name), assignment } }
  }

  /** The t3code thread of a Ticket, for links and the console. */
  thread(ticketId: string): TicketThread | undefined { return this.threads.get(ticketId) }
  /** The Ticket a worker capability token belongs to. */
  ticketOfToken(token: string): string | undefined {
    for (const entry of this.threads.values()) if (entry.token === token) return entry.ticketId
    return undefined
  }
  /** Worker slots in use, for the console. */
  load(): { used: number; max: number } { return { used: this.slots.used(), max: this.options.maxWorkers() } }

  start(ticket: Ticket, assignment: Assignment): void {
    this.jobs.enqueue(`launch:${ticket.id}`, () => this.launch(ticket.id, assignment.id), { retries: 3, firstDelayMs: 5000, maxDelayMs: 300_000 })
  }
  deliver(ticket: Ticket, assignment: Assignment): void {
    this.jobs.enqueue(`deliver:${ticket.id}`, () => this.deliverNow(ticket.id, assignment.id), { retries: 6, firstDelayMs: 2000 })
  }
  stop(ticket: Ticket, assignment: Assignment, reason: string): void {
    this.jobs.enqueue(`stop:${ticket.id}:${assignment.id}`, async () => {
      this.watching.get(ticket.id)?.abort(); this.watching.delete(ticket.id)
      this.busy.delete(ticket.id); this.slots.free(ticket.id); this.slotFreed()
      const entry = this.threads.get(ticket.id)
      if (!entry?.threadId) return
      // A worker that already said its last word keeps its thread as it is; anything still running stops.
      await this.options.t3.interrupt(entry.threadId, { stop: true, reason: reason.slice(0, 2000), clientRequestId: `stop:${assignment.id}` })
        .catch(error => { if (!(error instanceof T3Error && error.code === 'thread_not_interruptible')) throw error })
    })
  }

  async close(): Promise<void> {
    this.closed = true
    for (const controller of this.watching.values()) controller.abort()
    this.watching.clear()
    this.jobs.close()
  }

  private async launch(ticketId: string, assignmentId: string): Promise<void> {
    const ticket = this.options.repo.tickets.get(ticketId)
    const assignment = ticket?.assignments.find(item => item.id === assignmentId)
    if (!ticket || !liveTicket(ticket) || assignment?.state !== 'pending' || waitsForPerson(ticket)) return
    this.slots.reserve(ticketId, 'launch')
    try {
      const entry = this.threads.get(ticketId) ?? this.newEntry(ticket)
      let prepared: Prepared
      try {
        prepared = await prepareWorktree({ projectRoot: this.options.project.root, worktreeRoot: this.options.worktreeRoot,
          name: ticket.execution!.name, branchPrefix: this.options.branchPrefix ?? 'agent/', baseRef: this.options.baseRef ?? 'HEAD',
          mcpUrl: this.options.workerUrl(entry.token) })
      } catch (error) {
        // A failed preparation fails the Ticket at once, as in the prototype: a retry or a person's message prepares again.
        this.fail(ticketId, `Preparing the worktree failed: ${message(error)}`)
        return
      }
      Object.assign(entry, { worktreePath: prepared.worktreePath, branch: prepared.branch })
      this.threads.set(ticketId, entry)
      const variables: ExecutionVariables = { ticketId, name: ticket.execution!.name, directory: prepared.worktreePath, branch: prepared.branch,
        repository: this.options.project.repository, account: this.options.account?.login, commitEmail: this.options.account?.commitEmail }
      const origin = this.options.repo.triggers.get(ticket.origin.triggerId)
      const batch = ticket.origin.triggerIds.filter(id => id !== ticket.origin.triggerId).flatMap(id => this.options.repo.triggers.get(id) ?? [])
      const text = assignmentMessage(ticket, origin, variables, batch)
      let threadId = entry.threadId
      if (threadId) {
        // A new Assignment of a Ticket that has a thread (a retry or a restart) continues in that thread.
        await this.options.t3.send(threadId, `${text}\n\nThis is a new assignment of the same ticket: continue from the worktree's current state.`,
          `assign:${assignmentId}`)
      } else {
        const launched = await this.options.t3.launch({ projectId: this.options.project.id, title: threadTitle(ticket), message: text,
          worktreePath: prepared.worktreePath, branch: prepared.branch, clientRequestId: `launch:${assignmentId}`,
          ...(this.options.runtimeMode ? { runtimeMode: this.options.runtimeMode } : {}) })
        threadId = launched.threadId
        Object.assign(entry, { threadId, link: launched.link })
      }
      this.busy.add(ticketId)
      this.options.engine().assignmentStarted(ticketId, assignmentId)
      this.watch(ticketId, assignmentId)
    } catch (error) {
      if (error instanceof Later) throw error
      if (error instanceof T3Error && !error.transient) { this.fail(ticketId, `Starting the T3 Code thread failed: ${error.message}`); return }
      throw error
    } finally {
      this.slots.free(ticketId)
    }
  }

  private async deliverNow(ticketId: string, assignmentId: string): Promise<void> {
    const ticket = this.options.repo.tickets.get(ticketId)
    const entry = this.threads.get(ticketId)
    if (!ticket || !liveTicket(ticket) || runningAssignment(ticket)?.id !== assignmentId || !entry?.threadId || !ticket.undelivered.length) return
    const inputs = ticket.undelivered.flatMap(id => ticket.inputs.find(input => input.id === id) ?? [])
    const wakes = !this.busy.has(ticketId)
    if (wakes) this.slots.reserve(ticketId, inputs.some(fromPerson) ? 'person' : 'wake')
    try {
      const text = inputs.flatMap(input => inputMessage(input, input.kind === 'trigger' ? this.options.repo.triggers.get(input.triggerId) : undefined) ?? [])
        .join('\n\n')
      const ids = inputs.map(input => input.id)
      if (text) await this.options.t3.send(entry.threadId, text, `deliver:${assignmentId}:${ids.join(',')}`.slice(0, 256))
      this.busy.add(ticketId)
      entry.unread.push(...ids.filter(id => !entry.unread.includes(id)))
      this.options.engine().inputsDelivered(ticketId, assignmentId, ids)
      this.watch(ticketId, assignmentId)
    } catch (error) {
      if (error instanceof Later) throw error
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
          const result = await t3.wait(entry.threadId, this.options.waitMs ?? 30_000)
          if (controller.signal.aborted) break
          if (!result.timedOut && TERMINAL.has(result.status)) {
            if (this.busy.delete(ticketId) || (result.runId && result.runId !== entry.endedRunId)) {
              this.turnEnded(ticketId, assignmentId, entry, result.runId)
              this.slotFreed()
            }
            await sleep(this.options.idlePollMs ?? 5000, controller.signal)
          } else this.busy.add(ticketId)
        } catch (error) {
          if (controller.signal.aborted) break
          this.options.log?.(`watching ${ticketId} failed`, error)
          await sleep(5000, controller.signal)
        }
      }
      if (this.watching.get(ticketId) === controller) this.watching.delete(ticketId)
    })()
  }

  private turnEnded(ticketId: string, assignmentId: string, entry: TicketThread, runId: string | null): void {
    if (runId) entry.endedRunId = runId
    const engine = this.options.engine()
    try {
      if (entry.unread.length) engine.inputsRead(ticketId, entry.unread.splice(0))
      engine.turnEnded(ticketId, assignmentId)
    } catch (error) { this.options.log?.(`reporting the turn end of ${ticketId} failed`, error) }
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

const message = (error: unknown): string => error instanceof Error ? error.message : String(error)
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  const timer = setTimeout(resolve, ms)
  signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
})
