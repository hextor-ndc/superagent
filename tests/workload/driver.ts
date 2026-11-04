/**
 * Phase 4 (research/workload.md, sections 7.2 to 7.4): plays a workload against the whole Runtime with FakeGitHub and a real
 * git checkout. The t3code side is one of two `Workers`:
 * - `MemoryWorkers` (Tiers A and B): FakeT3, with each ticket's worker played here by tests/workload/worker-plan.mjs over the
 *   worker MCP server, through HTTP, as a t3code agent would; a turn ends when the driver finishes its run;
 * - `LiveWorkers` (Tier C, tests/live/workload.spec.ts): a real, isolated `t3 serve` whose scripted ACP agent
 *   (tests/live/scripted-agent.mjs) plays each worker with the same worker-plan.mjs, inside t3code; turns start and end for
 *   real, and the driver only tells a worker when its simulated work is over and reads what it did.
 *
 * Simulated time: the workload's events are processed in time order. GitHub is polled every 30 simulated seconds while
 * something changed there, so messages that arrive together are read together, as in production. After each step the
 * driver waits until the system settles (no Eval, Router turn, outgoing message, launch, delivery or worker turn in
 * flight). `Date` is faked (and only `Date`), so the Engine's and the GitHub Source's clocks follow simulated time, which
 * keeps the Source's one-minute poll overlap meaningful; timers stay real. A worker's simulated work runs from its first
 * turn for the plan's minutes, during which its t3code run stays `running` and holds a worker slot.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { vi } from 'vitest'
import { latestAssignment, waitsForPerson, type Ticket, type TicketInput } from '../../vendor/dsh/src/core/index.ts'
import { SettingsSchema } from '../../vendor/dsh/src/policy.ts'
import { shortId } from '../../src/executor/render.ts'
import { ClaudeRouter } from '../../src/router/claude-router.ts'
import type { LaunchInput, LaunchResult, PendingRequest, ProjectSummary, ScratchLaunchInput, SendResult, T3Client, T3Status, ThreadRead,
  WaitResult } from '../../src/t3/client.ts'
import { FakeGitHub } from '../fake-github.ts'
import { FakeT3 } from '../fake-t3.ts'
import { checkout, harness, mcp, removeCheckout, type Harness, type Timing } from '../harness.ts'
import { workloadRouter, type RouterCall } from './router-script.ts'
import { labelsOf, newWorkerState, runWorkerTurn, type TurnResult, type WorkerState } from './worker-plan.mjs'
import { MINUTE, PEOPLE, POLL_MS, type Anchor, type Workload, type WorkloadEvent } from './workload.ts'

/** A worker thread as the checks see it: its link and the messages the super agent put in it. */
export interface SimThread { id: string; link: string; messages: { text: string; clientRequestId: string }[] }
/** The t3code the Runtime talks to, with what the checks read: every call made, and the worker threads. */
export interface SimT3 extends T3Client {
  readonly calls: { tool: string; args: unknown }[]
  /** How many worker threads ran when each new worker thread launched. */
  readonly atLaunch: number[]
  workerThreads(): SimThread[]
}

/** Where the workers run, and how the driver plays or follows them. */
export interface Workers {
  readonly t3: SimT3
  /** The executor timing the Runtime gets; the harness's fast default when undefined. */
  readonly timing?: Timing
  /** How long the driver pauses between looks while it waits for the system to settle, and how long it waits at most. */
  readonly pauseMs: number
  readonly settleMs: number
  /**
   * Whether the faked clock also moves on with real time between the driver's looks. Against a real t3code the driver looks
   * less often, and the executor reports a turn end a millisecond after the reads recorded with it, which needs a clock that moves.
   */
  readonly realClock: boolean
  /** The t3code project and the checkout the Runtime works in. */
  open(): Promise<{ project: string; dir: string; root: string }>
  /** Plays or follows worker turns; what is still going on there, or undefined once the workers are quiet. */
  step(sim: Simulation): Promise<string | undefined>
  /** Whether a thread's latest run is active (it holds a worker slot), as last seen. */
  active(threadId: string): boolean
  /** How many worker threads run, as last seen. */
  running(): number
  /** The simulated work of a request is over: its worker's held turn goes on to ask, or to report ready. */
  done(label: string, sim: Simulation): Promise<void>
  /** Brings the threads' messages up to date for the checks. */
  collect(): Promise<void>
  close(): Promise<void>
}

type Step = { kind: 'event'; event: WorkloadEvent } | { kind: 'done'; label: string }

export interface SimulationOptions {
  workload: Workload
  router: 'claude' | 'rules'
  maxWorkers: number
  /** The t3code side; in memory by default. */
  workers?: Workers
}

const GITHUB_KINDS = new Set(['issue', 'comment', 'edit', 'review', 'review-comment', 'merge', 'close'])
const fromPerson = (input?: TicketInput): boolean => input?.kind === 'trigger' ? !!input.human && !input.context : input?.kind === 'text'
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

export class Simulation {
  readonly workers: Workers
  readonly github = new FakeGitHub(PEOPLE.repository, PEOPLE.agent)
  made!: Harness
  /** The scripted Router model's requests, with the Rules router undefined. */
  routerCalls?: RouterCall[]
  /** Simulated ms since the start. */
  clock = 0
  readonly anchors = new Map<string, Partial<Record<Anchor, number>>>()
  readonly requestAt = new Map<string, number>()
  readonly resultAt = new Map<string, number>()
  readonly attentionSeen = new Set<string>()
  readonly handbacks: { from: string; label: string }[] = []
  readonly workerErrors: string[] = []
  readonly consoleErrors: string[] = []
  maxRunning = 0
  maxSlots = 0
  /** Request labels whose ticket was seen waiting to launch while every worker slot was taken. */
  readonly queued = new Set<string>()
  steps = 0
  private console!: Client
  private queue: { at: number; seq: number; step: Step }[] = []
  private seq = 0
  private waiting: WorkloadEvent[] = []
  private readonly refs = new Map<string, number>()
  private dirty = false
  /** The real `Date.now()` when the simulation started; simulated ms count from it. */
  private origin = 0
  private real = 0
  private ticker?: ReturnType<typeof setInterval>

  constructor(readonly options: SimulationOptions) { this.workers = options.workers ?? new MemoryWorkers() }
  /** The t3code side's calls and threads, for the checks. */
  get t3(): SimT3 { return this.workers.t3 }

  async start(): Promise<void> {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() })
    this.origin = Date.now()
    this.real = performance.now()
    if (this.workers.realClock) this.ticker = setInterval(() => this.tick(), 1)
    const { project, ...place } = await this.workers.open()
    const claude = this.options.router === 'claude'
    const rules = SettingsSchema.parse({}).policy.rules.filter(rule => rule.enabled).map(rule => rule.id)
    const model = claude ? workloadRouter(() => this.clock, rules) : undefined
    this.routerCalls = model?.calls
    this.made = await harness(this.workers.t3, place, ':memory:', {
      maxWorkers: this.options.maxWorkers,
      router: { kind: this.options.router, model: 'claude-opus-5-5', effort: 'low', acceptMode: 'observe' },
      // With the model-backed Router, the admission table (SUPERAGENT_GITHUB_ADMISSION) admits an unlisted person's mention as a
      // proactive candidate, so observe mode has proactive work to judge from GitHub. The rules Router keeps the defaults.
      github: { login: PEOPLE.agent, allowed: [...PEOPLE.allowed], gh: 'gh', pollMs: 3_600_000,
        ...claude ? { admission: { comments: { unlistedAddressed: 'inferred' }, issues: { unlistedAddressed: 'inferred' } } } : {} },
    }, { gh: this.github.gh, project, ...this.workers.timing ? { timing: this.workers.timing } : {}, ...model ? { model: model.call } : {} })
    this.console = await mcp(`${this.made.base}/mcp/console/${this.made.runtime.config.consoleToken}`)
    await this.made.runtime.github!.poll()
  }
  /** Plays the whole workload. */
  async run(): Promise<void> {
    for (const event of this.options.workload.events) {
      if ('at' in event.when) this.push(event.when.at, { kind: 'event', event })
      else this.waiting.push(event)
    }
    for (const request of this.options.workload.requests) if ('at' in request.when) this.requestAt.set(request.label, request.when.at)
    for (;;) {
      const nextEvent = this.queue[0]?.at ?? Infinity
      const nextPoll = this.dirty ? (Math.floor(this.clock / POLL_MS) + 1) * POLL_MS : Infinity
      const next = Math.min(nextEvent, nextPoll)
      if (next === Infinity) break
      this.advance(next)
      this.steps++
      const batch: Step[] = []
      while (this.queue[0]?.at === next) batch.push(this.queue.shift()!.step)
      for (const step of batch) if (step.kind === 'event' && GITHUB_KINDS.has(step.event.kind)) this.applyGithub(step.event)
      if (next === nextPoll || (this.dirty && next % POLL_MS === 0)) await this.poll()
      for (const step of batch) {
        if (step.kind === 'done') await this.workers.done(step.label, this)
        else if (!GITHUB_KINDS.has(step.event.kind)) await this.applyOther(step.event)
      }
      await this.settle()
      this.observe()
    }
    await this.workers.collect()
  }

  /** Events whose anchor never came, which a correct run leaves none of. */
  unfired(): string[] { return this.waiting.map(event => `${event.id} ${event.label ?? event.kind} after ${'anchor' in event.when ? event.when.anchor : ''}`) }

  /** Polls GitHub twice at once and once more, then lets the system settle; for the duplicate checks. */
  async repoll(): Promise<void> {
    const source = this.made.runtime.github!
    await Promise.all([source.poll(), source.poll()])
    await source.poll()
    await this.settle()
    await this.workers.collect()
  }

  /** Closes the clients, the Runtime and the workers, and restores the real clock; safe after a failed start. */
  async close(): Promise<void> {
    try {
      await this.console?.close().catch(() => {})
      await this.made?.close()
      await this.workers.close()
    } finally {
      clearInterval(this.ticker)
      vi.useRealTimers()
    }
  }

  /** The ticket of a request label: the first label of the message it started from. */
  ticketOf(label: string): Ticket | undefined { return this.made.runtime.repo.tickets.list().find(ticket => this.labelOf(ticket) === label) }
  labelOf(ticket: Ticket): string | undefined { return labelsOf(this.made.runtime.repo.triggers.get(ticket.origin.triggerId)?.text)[0] }
  /** A ticket's t3code thread. */
  threadOf(ticket: Ticket): SimThread | undefined {
    const id = this.made.runtime.executor.thread(ticket.id)?.threadId
    return id ? this.t3.workerThreads().find(thread => thread.id === id) : undefined
  }

  /** What a worker's turn did: its acknowledgement starts the simulated work, and its question and ready report are anchors. */
  took(label: string, did: string[], minutes = 10): void {
    for (const item of did) {
      if (item === 'ack') {
        this.anchor(label, 'ack')
        this.push(this.clock + minutes * MINUTE, { kind: 'done', label })
      } else if (item === 'ask') this.anchor(label, 'asked')
      else if (item === 'ready') this.anchor(label, 'ready')
      else if (item.startsWith('handback:')) this.handbacks.push({ from: label, label: item.slice('handback:'.length) })
    }
  }
  /** A worker opened a pull request. */
  openPull(number: number, title: string): string {
    this.github.open(number, PEOPLE.agent, title, 'Opened by the worker.', true)
    this.dirty = true
    return `https://github.com/${PEOPLE.repository}/pull/${number}`
  }

  private push(at: number, step: Step): void {
    this.queue.push({ at, seq: ++this.seq, step })
    this.queue.sort((a, b) => a.at - b.at || a.seq - b.seq)
  }
  private advance(sim: number): void {
    this.clock = sim
    this.tick()
    vi.setSystemTime(Math.max(Date.now(), this.origin + sim))
  }
  /** The faked clock moves on with real time between steps too, as it would while the service works. */
  private tick(): void {
    const now = performance.now()
    vi.setSystemTime(Date.now() + Math.round(now - this.real))
    this.real = now
  }
  private async poll(): Promise<void> {
    this.dirty = false
    await this.made.runtime.github!.poll()
  }

  private anchor(label: string, kind: Anchor): void {
    const seen = this.anchors.get(label) ?? {}
    if (seen[kind] !== undefined) return
    seen[kind] = this.clock
    this.anchors.set(label, seen)
    const due = this.waiting.filter(event => 'anchor' in event.when && event.when.anchor === kind && event.when.label === label)
    this.waiting = this.waiting.filter(event => !due.includes(event))
    for (const event of due) {
      const at = this.clock + ('anchor' in event.when ? event.when.after : 0)
      if (event.category === 'request' && event.label) this.requestAt.set(event.label, at)
      this.push(at, { kind: 'event', event })
    }
  }

  private applyGithub(event: WorkloadEvent): void {
    const { github } = this
    this.dirty = true
    switch (event.kind) {
      case 'issue': github.open(event.number, event.login, event.title, event.body); break
      case 'comment': { const comment = github.comment(event.number, event.login, event.body); if (event.ref) this.refs.set(event.ref, comment.id); break }
      case 'edit': github.edit(this.refs.get(event.ref)!, event.body); break
      case 'review': github.review(event.number, event.login, event.state, event.body); break
      case 'review-comment': github.reviewComment(event.number, event.login, event.body); break
      case 'merge': github.merge(event.number); break
      case 'close': github.close(event.number); break
    }
  }
  private async applyOther(event: WorkloadEvent): Promise<void> {
    if (event.kind === 'request') await this.consoleCall('superagent_request', { text: event.text })
    else if (event.kind === 'stop' || event.kind === 'answer') {
      const ticket = this.ticketOf(event.request)
      if (!ticket) { this.consoleErrors.push(`${event.id}: no ticket for ${event.request}`); return }
      if (event.kind === 'stop') await this.consoleCall('superagent_stop', { ticket_id: shortId(ticket.id), reason: event.reason })
      else await this.consoleCall('superagent_answer', { ticket_id: shortId(ticket.id), text: event.text })
    } else if (event.kind === 'double-poll') {
      const source = this.made.runtime.github!
      this.dirty = false
      await Promise.all([source.poll(), source.poll()])
      await source.poll()
    }
  }
  private async consoleCall(name: string, args: Record<string, unknown>): Promise<void> {
    const result = await this.console.callTool({ name, arguments: args })
    if (result.isError) this.consoleErrors.push(`${name} ${JSON.stringify(args)}: ${JSON.stringify(result.content).slice(0, 300)}`)
  }

  /** Waits until nothing is in flight, playing or following worker turns meanwhile. */
  async settle(): Promise<void> {
    const deadline = performance.now() + this.workers.settleMs
    let quiet = 0
    for (;;) {
      this.tick()
      try { this.made.runtime.engine.evaluateDue() } catch (error) { this.workerErrors.push(`pass: ${message(error)}`) }
      const working = await this.workers.step(this)
      this.maxRunning = Math.max(this.maxRunning, this.workers.running())
      this.maxSlots = Math.max(this.maxSlots, this.made.runtime.executor.load().used)
      this.noteQueued()
      const busy = working ?? this.busy()
      if (!busy) { if (++quiet >= 2) return } else quiet = 0
      if (performance.now() > deadline) throw new Error(`Nothing settled at minute ${(this.clock / MINUTE).toFixed(1)}: ${busy}`)
      await sleep(this.workers.pauseMs)
    }
  }

  /** Notes each live ticket whose launch waits because every worker slot is taken. */
  private noteQueued(): void {
    const { runtime } = this.made
    const load = runtime.executor.load()
    if (load.used < load.max) return
    for (const ticket of runtime.repo.tickets.list()) {
      if (ticket.ended || latestAssignment(ticket)?.state !== 'pending' || waitsForPerson(ticket)) continue
      const label = this.labelOf(ticket)
      if (label) this.queued.add(label)
    }
  }

  private busy(): string | undefined {
    const { runtime } = this.made
    const evaluating = runtime.repo.threads.active()[0]
    if (evaluating) return `the Eval on ${evaluating.key}`
    if (runtime.router instanceof ClaudeRouter) {
      const state = runtime.router.state()
      if (state.working || state.waiting) return 'the Router'
    }
    const pending = runtime.outbox.list(record => record.status === 'pending')[0]
    if (pending) return `the outbox (${pending.message.kind}${pending.error ? `: ${pending.error}` : ''})`
    const tickets = runtime.repo.tickets.list()
    const load = runtime.executor.load()
    if (load.used > tickets.filter(ticket => runtime.executor.busySince(ticket.id) !== undefined).length) return 'a launch or wake in flight'
    for (const ticket of tickets) {
      const name = this.labelOf(ticket) ?? ticket.id
      const threadId = runtime.executor.thread(ticket.id)?.threadId
      const active = threadId ? this.workers.active(threadId) : undefined
      const assignment = latestAssignment(ticket)
      if (ticket.ended) { if (active) return `the stop of ${name}`; continue }
      if (assignment?.state === 'pending' && !waitsForPerson(ticket) && load.used < load.max) return `the launch of ${name}`
      if (ticket.undelivered.length && assignment?.state === 'running') {
        const person = ticket.undelivered.some(id => fromPerson(ticket.inputs.find(input => input.id === id)))
        if (runtime.executor.busySince(ticket.id) !== undefined || load.used < load.max + (person ? 1 : 0)) return `the delivery to ${name}`
      }
      if (threadId && !active && runtime.executor.busySince(ticket.id) !== undefined) return `the turn end of ${name}`
    }
    return undefined
  }

  /** What the workload's metrics and checks read after each step: who waits for a person, and results that went out. */
  private observe(): void {
    const { runtime } = this.made
    for (const view of runtime.attention()) {
      if (view.stage !== 'person/answer') continue
      const ticket = runtime.repo.tickets.get(view.id)
      const label = ticket && this.labelOf(ticket)
      if (label) this.attentionSeen.add(label)
    }
    for (const record of runtime.outbox.list(item => item.message.text.startsWith('Done:') && !!item.message.ticketId)) {
      const ticket = runtime.repo.tickets.get(record.message.ticketId!)
      const label = ticket && this.labelOf(ticket)
      if (label && !this.resultAt.has(label)) this.resultAt.set(label, this.clock)
    }
  }
}

/** A FakeT3 that also notes how many worker threads ran when each new worker thread launched. */
export class SlotT3 extends FakeT3 implements SimT3 {
  readonly atLaunch: number[] = []
  private readonly launched = new Set<string>()
  runningWorkers(): number { return this.workerThreads().filter(thread => thread.runs.at(-1)?.status === 'running').length }
  override async launch(input: LaunchInput): Promise<LaunchResult> {
    if (!this.launched.has(input.clientRequestId)) { this.launched.add(input.clientRequestId); this.atLaunch.push(this.runningWorkers()) }
    return super.launch(input)
  }
}

interface Worker { threadId: string; client: Client; state: WorkerState; seen: number; finish: boolean; holding: boolean
  call: (name: string, args: Record<string, unknown>) => Promise<unknown> }

/** Tiers A and B: FakeT3, with each worker played here; a turn that does not hold ends its run. */
export class MemoryWorkers implements Workers {
  // Off, as before: the project's root is set only in open() (docs/multi-project-plan.md, phase 0).
  readonly t3 = new SlotT3([{ id: 'project-1', workspaceRoot: '' }], { checkWorktrees: false })
  readonly pauseMs = 3
  readonly settleMs = 20_000
  readonly realClock = false
  private readonly workers = new Map<string, Worker>()
  private place?: { dir: string; root: string }

  async open() {
    const place = this.place = checkout()
    this.t3.projects[0]!.workspaceRoot = place.root
    return { project: 'project-1', ...place }
  }
  active(threadId: string): boolean { return this.t3.threads.get(threadId)?.runs.at(-1)?.status === 'running' }
  running(): number { return this.t3.runningWorkers() }
  async collect(): Promise<void> {}
  async close(): Promise<void> {
    for (const worker of this.workers.values()) await worker.client.close().catch(() => {})
    await this.t3.close()
    if (this.place) removeCheckout(this.place)
  }

  /** Plays a turn for every worker thread that got messages; a turn that does not hold ends its run. */
  async step(sim: Simulation): Promise<string | undefined> {
    let worked = false
    for (const thread of this.t3.workerThreads()) {
      const worker = this.workers.get(thread.id) ?? await this.newWorker(thread.id)
      if (!worker) continue
      let turned = false
      while (thread.messages.length > worker.seen) {
        const fresh = thread.messages.slice(worker.seen)
        worker.seen = thread.messages.length
        if (thread.runs.at(-1)?.status !== 'running') continue
        const result = await this.turn(sim, worker, fresh.map(item => item.text).join('\n\n'), worker.finish)
        worker.holding = result?.holding ?? false
        turned = true
      }
      if (turned) {
        worked = true
        if (!worker.holding && thread.runs.at(-1)?.status === 'running') this.t3.finishRun(thread.id)
      }
    }
    return worked ? 'worker turns' : undefined
  }
  private async newWorker(threadId: string): Promise<Worker | undefined> {
    const thread = this.t3.threads.get(threadId)!
    if (!thread.worktreePath) return undefined
    const config = JSON.parse(readFileSync(join(thread.worktreePath, '.mcp.json'), 'utf8')) as { mcpServers: { superagent: { url: string } } }
    const client = await mcp(config.mcpServers.superagent.url)
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args })
      if (result.isError) throw new Error(`${name}: ${JSON.stringify(result.content).slice(0, 300)}`)
      return result.structuredContent
    }
    const worker: Worker = { threadId, client, state: newWorkerState(), seen: 0, finish: false, holding: false, call }
    this.workers.set(threadId, worker)
    return worker
  }
  private async turn(sim: Simulation, worker: Worker, prompt: string, finish: boolean): Promise<TurnResult | undefined> {
    try {
      const result = await runWorkerTurn({ prompt, callTool: worker.call, state: worker.state, finish,
        openPull: async (number, title) => sim.openPull(number, title) })
      sim.took(result.label, result.did, worker.state.plan?.minutes)
      return result
    } catch (error) {
      sim.workerErrors.push(`${worker.state.label ?? worker.threadId}: ${message(error)}`)
      return undefined
    }
  }
  async done(label: string, sim: Simulation): Promise<void> {
    const worker = [...this.workers.values()].find(item => item.state.label === label)
    if (!worker) return
    worker.finish = true
    const thread = this.t3.threads.get(worker.threadId)!
    if (thread.runs.at(-1)?.status !== 'running' || !worker.state.started || worker.state.done) return
    const result = await this.turn(sim, worker, '', true)
    worker.holding = result?.holding ?? false
    if (!worker.holding && thread.runs.at(-1)?.status === 'running') this.t3.finishRun(thread.id)
  }
}

/** The run statuses that hold a thread's turn (and a worker slot); a run t3code is ending after a stop shows `waiting`. */
const ACTIVE: ReadonlySet<T3Status | null> = new Set(['preparing', 'queued', 'starting', 'running', 'waiting'])
/** The real wall clock, which the faked `Date` does not show; the scripted agent's timestamps use it. */
const wall = () => Math.round(performance.timeOrigin + performance.now())
/** The trigger ids of the message cards in a worker's message (src/executor/render.ts), as the scripted agent reads them. */
function cardIds(text: string): string[] {
  return [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].flatMap(match => {
    try {
      const value = JSON.parse(match[1]!) as unknown
      return (Array.isArray(value) ? value : [value]).flatMap(card => typeof card?.trigger_id === 'string' ? [card.trigger_id as string] : [])
    } catch { return [] }
  })
}

interface LiveThread extends SimThread {
  worktreePath: string
  status: T3Status | null
  /**
   * When the super agent last gave the worker something to take in (a message in its turn, or the end of its work), taken
   * before the call: the agent may start on it before the call returns.
   */
  pokedAt: number
  /** When the last call that may have changed the run returned; a look that began earlier may show the run as it was. */
  changedAt: number
  /** Whether the next look must read the thread from t3code: something may have changed since it was last seen idle. */
  watch: boolean
  /**
   * The trigger ids of the messages t3code put in the worker's turn (the launch, and each send it did not queue), which the
   * agent must have taken in before its turn is quiet. Holding since after the last poke is not enough on its own: the agent
   * may start holding a turn after a steer's send returned but before t3code's cancel for it reached the agent.
   */
  expect: Set<string>
}

/**
 * A real t3code for the Runtime, which records each call as FakeT3 does and keeps what the driver needs about each worker
 * thread. `link_pull_request` is recorded but not sent: t3code may look the pull request up on GitHub with this machine's
 * credentials, and the workload's pull requests exist only in FakeGitHub.
 */
export class RecordingT3 implements SimT3 {
  readonly calls: { tool: string; args: unknown }[] = []
  readonly atLaunch: number[] = []
  readonly threads = new Map<string, LiveThread>()
  /**
   * Threads the super agent asked to stop (`stop: true`), as it does when a ticket ends, until it next sends to them. The
   * executor gives a stopped thread's worker slot back when it asks, and t3code takes a moment to end the run (it shows
   * `waiting` meanwhile), so such a run holds no slot.
   */
  readonly stopped = new Set<string>()
  /** How t3code took each first send of a clientRequestId: `steered`, `started`, `queued`, `restarted`. */
  readonly deliveries: Record<string, number> = {}
  private readonly launched = new Set<string>()
  private readonly sent = new Set<string>()
  /** Launches whose call is out, by clientRequestId; their threads are not known yet. */
  private readonly opening = new Set<string>()
  /** Threads with a send out, which may be starting a run t3code does not show yet. */
  private readonly sending = new Map<string, number>()
  constructor(readonly inner: T3Client) {}

  workerThreads(): LiveThread[] { return [...this.threads.values()] }
  listProjects(): Promise<ProjectSummary[]> { return this.inner.listProjects() }
  async launch(input: LaunchInput): Promise<LaunchResult> {
    this.calls.push({ tool: 't3_thread_launch', args: input })
    if (!this.launched.has(input.clientRequestId)) {
      this.launched.add(input.clientRequestId)
      // What holds a slot at this moment: the runs t3code shows active, read afresh for each thread that was active or that
      // the super agent has acted on since it was seen idle, other than those being stopped (the executor gives a slot back
      // as it sends the stop); and the launches and sends still out, which reserved a slot and may start a run t3code does
      // not show yet.
      await this.refresh([...this.threads.values()].filter(thread => (ACTIVE.has(thread.status) || thread.watch) && !this.stopped.has(thread.id)))
      const counted = new Set([...this.threads.values()].filter(thread => ACTIVE.has(thread.status) && !this.stopped.has(thread.id)).map(thread => thread.id))
      const waking = [...this.sending.keys()].filter(id => !counted.has(id) && !this.stopped.has(id))
      this.atLaunch.push(counted.size + waking.length + this.opening.size)
    }
    const before = wall()
    this.opening.add(input.clientRequestId)
    let result: LaunchResult
    try { result = await this.inner.launch(input) } finally { this.opening.delete(input.clientRequestId) }
    const thread = this.threads.get(result.threadId) ?? { id: result.threadId, link: result.link ?? '', messages: [], worktreePath: input.worktreePath ?? '',
      status: result.status, pokedAt: before, changedAt: wall(), watch: true, expect: new Set<string>() }
    for (const id of cardIds(input.message)) thread.expect.add(id)
    this.threads.set(result.threadId, thread)
    return result
  }
  launchScratch(input: ScratchLaunchInput): Promise<LaunchResult> {
    this.calls.push({ tool: 't3_thread_launch', args: { scratch: true, ...input } })
    return this.inner.launchScratch(input)
  }
  async send(threadId: string, text: string, clientRequestId: string, mode: 'auto' | 'queue' | 'steer' | 'restart' = 'auto'): Promise<SendResult> {
    this.calls.push({ tool: 't3_thread_send', args: { threadId, message: text, clientRequestId, mode } })
    const before = wall()
    this.sending.set(threadId, (this.sending.get(threadId) ?? 0) + 1)
    let result: SendResult
    try {
      result = await this.inner.send(threadId, text, clientRequestId, mode)
    } finally {
      const left = (this.sending.get(threadId) ?? 1) - 1
      if (left) this.sending.set(threadId, left)
      else this.sending.delete(threadId)
    }
    this.stopped.delete(threadId)
    if (!this.sent.has(clientRequestId)) { this.sent.add(clientRequestId); this.deliveries[result.delivery] = (this.deliveries[result.delivery] ?? 0) + 1 }
    const thread = this.threads.get(threadId)
    // A queued message reaches the worker only after its held turn ends, so it is nothing the worker must take in now.
    if (thread) {
      Object.assign(thread, { watch: true, changedAt: wall(), status: result.status })
      if (result.delivery !== 'queued') {
        thread.pokedAt = Math.max(thread.pokedAt, before)
        for (const id of cardIds(text)) thread.expect.add(id)
      }
    }
    return result
  }
  wait(threadId: string, timeoutMs: number, runId?: string): Promise<WaitResult> { return this.inner.wait(threadId, timeoutMs, runId) }
  read(threadId: string, options?: { afterPosition?: number; limit?: number; view?: 'messages' | 'activity' }): Promise<ThreadRead> {
    return this.inner.read(threadId, options)
  }
  async interrupt(threadId: string, options: { stop?: boolean; reason?: string; clientRequestId: string }): Promise<void> {
    this.calls.push({ tool: 't3_thread_interrupt', args: { threadId, ...options } })
    if (options.stop) this.stopped.add(threadId)
    await this.inner.interrupt(threadId, options)
    const thread = this.threads.get(threadId)
    if (thread) Object.assign(thread, { watch: true, changedAt: wall() })
  }
  async organize(threadId: string, action: Parameters<T3Client['organize']>[1]): Promise<void> {
    this.calls.push({ tool: 't3_thread_organize', args: { threadId, action } })
    await this.inner.organize(threadId, action)
  }
  async linkPullRequests(threadId: string, urls: string[]): Promise<void> { this.calls.push({ tool: 'link_pull_requests', args: { threadId, urls } }) }
  pendingRequests(threadId: string): Promise<PendingRequest[]> { return this.inner.pendingRequests(threadId) }
  answerQuestion(threadId: string, requestId: string, answers: Record<string, string | string[]>): Promise<void> {
    this.calls.push({ tool: 't3_pending_request', args: { action: 'respond', threadId, requestId, answers } })
    return this.inner.answerQuestion(threadId, requestId, answers)
  }
  close(): Promise<void> { return this.inner.close() }

  /** Worker threads whose run is active, as last seen, other than those being stopped. */
  running(): number { return [...this.threads.values()].filter(thread => ACTIVE.has(thread.status) && !this.stopped.has(thread.id)).length }
  /** Reads these threads' status from t3code. A thread seen idle is not read again until the super agent next acts on it. */
  async refresh(threads: LiveThread[]): Promise<void> {
    await Promise.all(threads.map(async thread => {
      const lookedAt = wall()
      const read = await this.inner.read(thread.id, { limit: 1 })
      thread.status = read.thread.status
      if (!ACTIVE.has(thread.status) && lookedAt > thread.changedAt) thread.watch = false
    }))
  }
  /** Each thread's user messages, as t3code has them; the message id is t3code's, made from the send's clientRequestId. */
  async collect(): Promise<void> {
    for (const thread of this.threads.values()) {
      const messages: SimThread['messages'] = []
      let after: number | undefined
      for (;;) {
        const page = await this.inner.read(thread.id, { limit: 100, ...after === undefined ? {} : { afterPosition: after } })
        for (const item of page.items) if (item.type === 'user_message') messages.push({ text: item.text ?? '', clientRequestId: item.messageId ?? item.itemId })
        if (!page.hasMore || !page.items.length || page.nextPosition === null) break
        after = page.nextPosition
      }
      thread.messages = messages
    }
  }
}

/** What the scripted agent writes about a worker (tests/live/scripted-agent.mjs, `SCRIPTED_AGENT_SIGNALS`). */
interface AgentStatus {
  label?: string; minutes?: number; busy: boolean; holding: boolean; holdingSince: number
  turns: { at: number; did: string[] }[]; pulls: { number: number; title: string }[]; errors: string[]
  /** The trigger ids of the message cards the worker's turns took in. */
  taken?: string[]
}

export interface LiveWorkersOptions {
  /** The Runtime's client on the isolated t3code, with the scripted model selected. */
  t3: T3Client
  project: string
  /** The folder for the Runtime's worktrees, and the checkout registered as the project. */
  dir: string
  root: string
  /** The scripted agent's `SCRIPTED_AGENT_SIGNALS` folder. */
  signals: string
  timing: Timing
  settleMs?: number
}

/**
 * Tier C: a real t3code, whose scripted ACP agent plays each worker. The driver tells a worker its simulated work is over
 * with a signal file, and follows what it did through the status file the agent writes. Turns are quiet once every worker
 * thread whose run is active is held by its agent, after taking in whatever it was last given.
 */
export class LiveWorkers implements Workers {
  readonly t3: RecordingT3
  readonly timing: Timing
  readonly pauseMs = 50
  readonly settleMs: number
  readonly realClock = true
  /** How much of each agent status the driver has taken in. */
  private readonly seen = new Map<string, { turns: number; pulls: number; errors: number }>()

  constructor(private readonly options: LiveWorkersOptions) {
    this.t3 = new RecordingT3(options.t3)
    this.timing = options.timing
    this.settleMs = options.settleMs ?? 120_000
  }
  async open() { return { project: this.options.project, dir: this.options.dir, root: this.options.root } }
  active(threadId: string): boolean { return ACTIVE.has(this.t3.threads.get(threadId)?.status ?? null) }
  running(): number { return this.t3.running() }
  collect(): Promise<void> { return this.t3.collect() }
  async close(): Promise<void> {}

  private file(thread: LiveThread, suffix: string): string { return join(this.options.signals, `${basename(thread.worktreePath)}.${suffix}`) }
  private status(thread: LiveThread): AgentStatus | undefined {
    try { return JSON.parse(readFileSync(this.file(thread, 'json'), 'utf8')) as AgentStatus } catch { return undefined }
  }

  async step(sim: Simulation): Promise<string | undefined> {
    const threads = this.t3.workerThreads()
    await this.t3.refresh(threads.filter(thread => thread.watch))
    let busy: string | undefined
    for (const thread of threads) {
      const status = this.status(thread)
      const name = status?.label ?? basename(thread.worktreePath)
      if (status) this.take(sim, thread, status)
      if (busy || !ACTIVE.has(thread.status)) continue
      if (thread.status !== 'running' && thread.status !== 'waiting') busy = `the start of a turn of ${name} (${thread.status})`
      else if (!status?.holding) busy = `the turn of ${name}`
      else if (status.holdingSince < thread.pokedAt || [...thread.expect].some(id => !status.taken?.includes(id))) busy = `${name} taking in a message`
    }
    return busy
  }
  /** Takes in what the agent did since the last look: turns (anchors), pull requests and errors. */
  private take(sim: Simulation, thread: LiveThread, status: AgentStatus): void {
    const seen = this.seen.get(thread.id) ?? { turns: 0, pulls: 0, errors: 0 }
    this.seen.set(thread.id, seen)
    for (const pull of status.pulls.slice(seen.pulls)) sim.openPull(pull.number, pull.title)
    for (const turn of status.turns.slice(seen.turns)) sim.took(status.label ?? 'work', turn.did, status.minutes)
    for (const error of status.errors.slice(seen.errors)) sim.workerErrors.push(`${status.label ?? thread.id}: ${error}`)
    Object.assign(seen, { turns: status.turns.length, pulls: status.pulls.length, errors: status.errors.length })
  }
  async done(label: string, sim: Simulation): Promise<void> {
    const ticket = sim.ticketOf(label)
    const threadId = ticket && sim.made.runtime.executor.thread(ticket.id)?.threadId
    const thread = threadId ? this.t3.threads.get(threadId) : undefined
    if (!thread) return
    const done = this.file(thread, 'done')
    if (existsSync(done)) return
    thread.pokedAt = wall()
    writeFileSync(done, `${label}\n`)
    Object.assign(thread, { watch: true, changedAt: wall() })
  }
}

/** Builds, starts and plays a simulation; on a failure it closes the simulation before rethrowing. */
export async function simulate(options: SimulationOptions): Promise<Simulation> {
  const simulation = new Simulation(options)
  try {
    await simulation.start()
    await simulation.run()
  } catch (error) {
    await simulation.close().catch(() => {})
    throw error
  }
  return simulation
}
