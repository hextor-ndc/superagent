/**
 * Point 1, stops: a stop frees the Ticket's worker slot at once, and work that was already out when it ran (a delivery's send,
 * the pause before a worker whose turn failed is told to go on, a launch) must not take the slot back. The Engine ends the
 * Assignment in the transaction that queues the stop, so that work finds it ended once it comes back. A launch that comes back
 * to an ended Assignment stops the run it started, which the stop could not reach.
 */
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Assignment, Ticket, TicketInput } from '../vendor/dsh/src/core/index.ts'
import { T3Executor, type TicketThread } from '../src/executor/t3-executor.ts'
import { T3Error, type LaunchInput, type LaunchResult, type SendResult } from '../src/t3/client.ts'
import { FakeT3 } from './fake-t3.ts'
import { checkout, until } from './harness.ts'

/**
 * A FakeT3 whose launches and sends, once made, hold their answer back until `gate` resolves. With `late` the call itself
 * waits at the gate instead, as one t3code takes only after the stop's interrupt. Interrupts and sends can be slowed or made
 * to fail, by request id.
 */
class HeldT3 extends FakeT3 {
  gate?: Promise<void>
  late = false
  /** Launches and sends waiting at the gate. */
  waiting = 0
  /** How long the interrupt under each request id takes before it lands. */
  readonly slow = new Map<string, number>()
  /** Interrupts that fail once as on a network error, by request id; the try after lands. */
  readonly flaky = new Set<string>()
  /** A send t3code refuses, by request id. */
  refuse?: string
  override async interrupt(threadId: string, options: { stop?: boolean; reason?: string; clientRequestId: string }): Promise<void> {
    const ms = this.slow.get(options.clientRequestId)
    if (ms) await new Promise(resolve => setTimeout(resolve, ms))
    if (this.flaky.delete(options.clientRequestId)) throw new T3Error('t3_thread_interrupt', 'network', 'fetch failed')
    return super.interrupt(threadId, options)
  }
  private async held<T>(call: () => Promise<T>): Promise<T> {
    const gate = this.gate
    if (!gate) return call()
    this.waiting++
    try {
      if (this.late) { await gate; return await call() }
      const result = await call()
      await gate
      return result
    } finally { this.waiting-- }
  }
  override send(threadId: string, message: string, clientRequestId: string, mode = 'auto'): Promise<SendResult> {
    return this.held(() => {
      if (clientRequestId === this.refuse) throw new T3Error('t3_thread_send', 'invalid_request', 'The thread refused the message.')
      return super.send(threadId, message, clientRequestId, mode)
    })
  }
  override launch(input: LaunchInput): Promise<LaunchResult> { return this.held(() => super.launch(input)) }
  hold(late = false): () => void {
    let open!: () => void
    this.late = late
    this.gate = new Promise(resolve => { open = resolve })
    return open
  }
}

describe('stop races', () => {
  let open: T3Executor[] = []
  afterEach(async () => { for (const executor of open) await executor.close(); open = [] })

  /** An executor whose Ticket has a thread with a running turn, watched as after a restart. */
  async function setup(continueAfterMs = 1) {
    const t3 = new HeldT3([{ id: 'project-1', workspaceRoot: '/unused' }])
    const launched = await t3.launch({ projectId: 'project-1', title: '[T-ticket-1] work', message: 'Assignment', worktreePath: '/unused',
      clientRequestId: 'launch:1' })
    const at = new Date().toISOString()
    const assignment: Assignment = { id: 'assignment-1', state: 'running', createdAt: at, startedAt: at }
    const ticket = { id: 'ticket-1', title: 'work', assignments: [assignment], inputs: [] as TicketInput[], undelivered: [] as string[], createdAt: at,
      updatedAt: at, origin: { triggerId: 'trigger-0', triggerIds: ['trigger-0'] } } as unknown as Ticket
    const ends: string[] = []
    const entry: TicketThread = { ticketId: ticket.id, threadId: launched.threadId, worktreePath: '/unused', branch: 'agent/work', token: 'token', unread: [] }
    const executor = new T3Executor({
      t3, repo: { tickets: { get: (id: string) => id === ticket.id ? ticket : undefined, active: () => [ticket] }, triggers: { get: () => undefined } } as never,
      engine: () => ({ assignmentStarted: () => {}, deliveryFailed: () => {}, report: () => ({}) as never, assignmentInterrupted: () => {}, inputsRead: () => {},
        turnEnded: (_ticketId: string, assignmentId: string) => { ends.push(assignmentId) }, inputsDelivered: (_ticketId: string, _assignmentId: string, ids: string[]) => {
          ticket.undelivered = ticket.undelivered.filter(id => !ids.includes(id))
        } }),
      settings: () => ({}) as never, project: { id: 'project-1', root: '/unused' }, worktreeRoot: '/unused', workerUrl: token => token,
      maxWorkers: () => 1, waitMs: 5, idlePollMs: 5, pendingCheckMs: 1000, continueAfterMs, log: () => {},
      state: { load: () => [entry], save: () => {} },
    })
    open.push(executor)
    executor.resume()
    /** The Ticket ends and its stop is queued, as the Engine does both in one transaction. */
    const stop = () => {
      assignment.state = 'ended'
      Object.assign(ticket, { ended: { at: new Date().toISOString(), by: 'human', outcome: 'stopped' } })
      executor.stop(ticket, assignment, 'The person asked to stop.')
    }
    const sent = () => t3.calls.filter(call => call.tool === 't3_thread_send').map(call => (call.args as { clientRequestId: string }).clientRequestId)
    const interrupted = () => t3.calls.some(call => call.tool === 't3_thread_interrupt')
    return { t3, executor, ticket, assignment, threadId: launched.threadId, stop, sent, interrupted, ends }
  }

  it('keeps the slot a stop freed when a delivery\'s send comes back after the stop', async () => {
    const made = await setup()
    await until(() => made.executor.busySince('ticket-1'), 'the running turn')
    const release = made.t3.hold()
    made.ticket.inputs.push({ id: 'input-1', kind: 'trigger', triggerId: 'trigger-1', at: new Date().toISOString(), human: true })
    made.ticket.undelivered.push('input-1')
    made.executor.deliver(made.ticket, made.assignment)
    await until(() => made.sent().length, 'the send out')
    // As "@bot stop" on the ticket's Issue: the stop and the delivery of the same message run together, and t3code took the send first.
    made.stop()
    await until(() => made.interrupted(), 'the interrupt')
    expect(made.executor.load().used).toBe(0)
    release()
    await made.executor.jobs.idle()
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(made.executor.load().used).toBe(0)
    expect(made.executor.busySince('ticket-1')).toBeUndefined()
  })

  it('tells no stopped worker to go on after a failed turn, when the stop comes during the pause', async () => {
    const made = await setup(300)
    await until(() => made.executor.busySince('ticket-1'), 'the running turn')
    made.t3.finishRun(made.threadId, 'failed')
    await until(() => !made.executor.busySince('ticket-1'), 'the failed turn seen')
    made.stop()
    await until(() => made.interrupted(), 'the interrupt')
    await made.executor.jobs.idle()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(made.sent()).toEqual([])
    // Nor does the stopped run report a turn end, which would count the Inputs it held as read.
    expect(made.ends).toEqual([])
    expect(made.executor.load().used).toBe(0)
  })

  it('keeps the slot a stop freed when the message telling a worker to go on comes back after the stop', async () => {
    const made = await setup()
    await until(() => made.executor.busySince('ticket-1'), 'the running turn')
    const release = made.t3.hold()
    made.t3.finishRun(made.threadId, 'failed')
    await until(() => made.sent().some(id => id.startsWith('continue:')), 'the continue send out')
    made.stop()
    await until(() => made.interrupted(), 'the interrupt')
    release()
    await made.executor.jobs.idle()
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(made.executor.load().used).toBe(0)
    expect(made.executor.busySince('ticket-1')).toBeUndefined()
  })

  /**
   * An executor with a pending Assignment to launch in a real checkout: in a new thread, or with `existing` in the Ticket's
   * thread from an earlier Assignment, whose run has ended.
   */
  async function launching(existing = false, continueAfterMs = 1) {
    const place = checkout()
    const t3 = new HeldT3([{ id: 'project-1', workspaceRoot: place.root }])
    const earlier = existing ? await t3.launch({ projectId: 'project-1', title: '[T-ticket-1] work', message: 'Assignment', worktreePath: '/unused',
      clientRequestId: 'launch:assignment-0' }) : undefined
    if (earlier) t3.finishRun(earlier.threadId)
    const at = new Date().toISOString()
    const assignment: Assignment = { id: 'assignment-1', state: 'pending', createdAt: at }
    const ticket = { id: 'ticket-1', title: 'work', assignments: [assignment], inputs: [] as TicketInput[], undelivered: [] as string[], createdAt: at,
      updatedAt: at, origin: { triggerId: 'trigger-0', triggerIds: ['trigger-0'] }, mandate: { strength: 'explicit', basis: {} },
      execution: { name: 'work-1', directory: join(place.dir, 'worktrees', 'work-1'), assignment: 'Scope: work.' } } as unknown as Ticket
    const started: string[] = []
    const reports: string[] = []
    const saved: TicketThread[] = []
    const entries: TicketThread[] = earlier
      ? [{ ticketId: ticket.id, threadId: earlier.threadId, worktreePath: '/unused', branch: 'agent/work-1', token: 'token', unread: [] }] : []
    const executor = new T3Executor({
      t3, repo: { tickets: { get: (id: string) => id === ticket.id ? ticket : undefined, active: () => [ticket] }, triggers: { get: () => undefined } } as never,
      engine: () => ({ assignmentStarted: (_ticketId: string, assignmentId: string) => {
        started.push(assignmentId)
        ticket.assignments.find(item => item.id === assignmentId)!.state = 'running'
      }, deliveryFailed: () => {}, report: (_ticketId: string, report: { state: string }) => { reports.push(report.state); return {} as never },
      assignmentInterrupted: () => {}, inputsRead: () => {}, turnEnded: () => {}, inputsDelivered: () => {} }),
      settings: () => ({}) as never, project: { id: 'project-1', root: place.root }, worktreeRoot: join(place.dir, 'worktrees'),
      workerUrl: token => token, maxWorkers: () => 1, waitMs: 5, idlePollMs: 5, pendingCheckMs: 1000, continueAfterMs, log: () => {},
      state: { load: () => entries, save: entry => { saved.push(structuredClone(entry)) } },
    })
    open.push(executor)
    /** The Ticket ends and its stop is queued, as the Engine does both in one transaction. */
    const stop = () => {
      assignment.state = 'ended'
      Object.assign(ticket, { ended: { at: new Date().toISOString(), by: 'human', outcome: 'stopped' } })
      executor.stop(ticket, assignment, 'The person asked to stop.')
    }
    /**
     * The Ticket goes on with a new Assignment, as a retry: the Engine ends the latest one, makes a pending one and queues the
     * stop and the start in one transaction.
     */
    const replace = () => {
      const latest = ticket.assignments.at(-1)!
      Object.assign(latest, { state: 'ended', endedReason: 'retried' })
      const next: Assignment = { id: `assignment-${ticket.assignments.length + 1}`, state: 'pending', createdAt: new Date().toISOString() }
      ticket.assignments.push(next)
      executor.stop(ticket, latest, 'retried')
      executor.start(ticket, next)
      return next
    }
    const interrupts = () => t3.calls.filter(call => call.tool === 't3_thread_interrupt')
      .map(call => call.args as { threadId: string; stop?: boolean; clientRequestId: string })
    /** The request ids of the sends and the interrupts that landed, in order. */
    const order = () => t3.calls.filter(call => call.tool === 't3_thread_send' || call.tool === 't3_thread_interrupt')
      .map(call => (call.args as { clientRequestId: string }).clientRequestId)
    return { t3, executor, ticket, assignment, stop, replace, started, reports, saved, interrupts, order, earlier }
  }

  it('stops the new thread of a launch that comes back after its Ticket was stopped', async () => {
    const made = await launching()
    const release = made.t3.hold()
    made.executor.start(made.ticket, made.assignment)
    await until(() => made.t3.waiting, 'the launch out')
    made.stop()
    // The stop job runs while the launch is out: the Ticket has no thread yet, so it has nothing to interrupt.
    await until(() => !made.executor.jobs.has('stop:ticket-1:assignment-1'), 'the stop job')
    expect(made.interrupts()).toEqual([])
    release()
    await until(() => made.interrupts().length, 'the interrupt')
    await made.executor.jobs.idle()
    const thread = made.t3.workerThreads()[0]!
    expect(made.interrupts()).toEqual([expect.objectContaining({ threadId: thread.id, stop: true, clientRequestId: 'stop-launch:assignment-1' })])
    expect(thread.runs.at(-1)?.status).toBe('interrupted')
    expect(made.started).toEqual([])
    expect(made.executor.load().used).toBe(0)
    expect(made.executor.busySince('ticket-1')).toBeUndefined()
    // The thread is kept for the Ticket's later Assignments.
    expect(made.executor.thread('ticket-1')?.threadId).toBe(thread.id)
    expect(made.saved.at(-1)?.threadId).toBe(thread.id)
  })

  it('stops the new thread of a stopped launch also when the launch comes back before the stop job runs', async () => {
    const made = await launching()
    const release = made.t3.hold()
    made.executor.start(made.ticket, made.assignment)
    await until(() => made.t3.waiting, 'the launch out')
    // The launch looks again before the stop job runs, which then finds the thread too: each interrupts it, under its own id.
    release()
    made.stop()
    await until(() => made.interrupts().length === 2, 'both interrupts')
    await made.executor.jobs.idle()
    expect(made.interrupts().map(call => call.clientRequestId).sort()).toEqual(['stop-launch:assignment-1', 'stop:assignment-1'])
    expect(made.interrupts().every(call => call.stop)).toBe(true)
    expect(made.t3.workerThreads()[0]!.runs.at(-1)?.status).toBe('interrupted')
    expect(made.started).toEqual([])
    expect(made.executor.load().used).toBe(0)
  })

  it('stops the run a new Assignment\'s message starts in the Ticket\'s thread when it lands after the stop', async () => {
    const made = await launching(true)
    // t3code takes the message only after the stop job's interrupt, which finds the thread idle.
    const release = made.t3.hold(true)
    made.executor.start(made.ticket, made.assignment)
    await until(() => made.t3.waiting, 'the send out')
    made.stop()
    await until(() => made.interrupts().length, 'the stop job\'s interrupt')
    await until(() => !made.executor.jobs.has('stop:ticket-1:assignment-1'), 'the stop job')
    const thread = made.t3.threads.get(made.earlier!.threadId)!
    expect(thread.runs.at(-1)?.status).toBe('completed')
    release()
    await until(() => made.interrupts().some(call => call.clientRequestId === 'stop-launch:assignment-1'), 'the launch\'s interrupt')
    await made.executor.jobs.idle()
    expect(made.t3.calls.filter(call => call.tool === 't3_thread_send').map(call => (call.args as { clientRequestId: string }).clientRequestId))
      .toEqual(['assign:assignment-1'])
    expect(thread.runs).toHaveLength(2)
    expect(thread.runs.at(-1)?.status).toBe('interrupted')
    expect(made.interrupts().find(call => call.clientRequestId === 'stop-launch:assignment-1')?.stop).toBe(true)
    expect(made.started).toEqual([])
    expect(made.executor.load().used).toBe(0)
    expect(made.executor.busySince('ticket-1')).toBeUndefined()
  })

  it('starts no thread when the stop comes while the worktree is prepared', async () => {
    const made = await launching()
    made.executor.start(made.ticket, made.assignment)
    // The slot is reserved as the worktree's preparation begins; the t3code call comes only after it.
    await until(() => made.executor.load().used, 'the launch under way')
    made.stop()
    await made.executor.jobs.idle()
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(made.t3.calls.filter(call => call.tool === 't3_thread_launch')).toEqual([])
    expect(made.started).toEqual([])
    expect(made.executor.load().used).toBe(0)
  })

  it('starts a launch that was not stopped as before', async () => {
    const made = await launching()
    const release = made.t3.hold()
    made.executor.start(made.ticket, made.assignment)
    await until(() => made.t3.waiting, 'the launch out')
    release()
    await until(() => made.executor.busySince('ticket-1'), 'the running turn')
    expect(made.started).toEqual(['assignment-1'])
    expect(made.interrupts()).toEqual([])
    expect(made.executor.load().used).toBe(1)
    const thread = made.t3.workerThreads()[0]!
    expect(thread.runs.at(-1)?.status).toBe('running')
    expect(made.executor.thread('ticket-1')?.threadId).toBe(thread.id)
    expect(made.saved.at(-1)?.threadId).toBe(thread.id)
  })

  it('starts a new Assignment only after the run its stopped launch started was interrupted, when the Ticket goes on', async () => {
    const made = await launching(true)
    const release = made.t3.hold(true)
    made.t3.slow.set('stop-launch:assignment-1', 100)
    made.executor.start(made.ticket, made.assignment)
    await until(() => made.t3.waiting, 'the send out')
    made.replace()
    await until(() => !made.executor.jobs.has('stop:ticket-1:assignment-1'), 'the stop job')
    release()
    await until(() => made.started.includes('assignment-2'), 'the new Assignment started')
    await made.executor.jobs.idle()
    // The first Assignment's message landed after its stop; the new one's went only after the interrupt, into a run of its own.
    expect(made.order()).toEqual(['stop:assignment-1', 'assign:assignment-1', 'stop-launch:assignment-1', 'assign:assignment-2'])
    expect(made.interrupts().some(call => call.stop)).toBe(false)
    const thread = made.t3.threads.get(made.earlier!.threadId)!
    expect(thread.runs.map(run => run.status)).toEqual(['completed', 'interrupted', 'running'])
    expect(made.started).toEqual(['assignment-2'])
    expect(made.reports).toEqual([])
  })

  it('waits for the try after a failed one before a new Assignment starts, when a stopped launch\'s interrupt fails', async () => {
    const made = await launching(true)
    const release = made.t3.hold(true)
    made.t3.flaky.add('stop-launch:assignment-1')
    made.executor.start(made.ticket, made.assignment)
    await until(() => made.t3.waiting, 'the send out')
    made.replace()
    await until(() => !made.executor.jobs.has('stop:ticket-1:assignment-1'), 'the stop job')
    release()
    await until(() => made.started.includes('assignment-2'), 'the new Assignment started', 6000)
    await made.executor.jobs.idle()
    expect(made.order()).toEqual(['stop:assignment-1', 'assign:assignment-1', 'stop-launch:assignment-1', 'assign:assignment-2'])
    const thread = made.t3.threads.get(made.earlier!.threadId)!
    expect(thread.runs.map(run => run.status)).toEqual(['completed', 'interrupted', 'running'])
  }, 10_000)

  it('waits for the try after a failed one before a new Assignment starts, when a stop\'s interrupt fails', async () => {
    const made = await launching(true)
    made.executor.start(made.ticket, made.assignment)
    await until(() => made.executor.busySince('ticket-1'), 'the running turn')
    made.t3.flaky.add('stop:assignment-1')
    made.replace()
    await until(() => made.started.includes('assignment-2'), 'the new Assignment started', 6000)
    await made.executor.jobs.idle()
    expect(made.order()).toEqual(['assign:assignment-1', 'stop:assignment-1', 'assign:assignment-2'])
    const thread = made.t3.threads.get(made.earlier!.threadId)!
    expect(thread.runs.map(run => run.status)).toEqual(['completed', 'interrupted', 'running'])
  }, 10_000)

  it('reports no failure for a stopped launch whose call t3code then refuses, when the Ticket goes on', async () => {
    const made = await launching(true)
    const release = made.t3.hold(true)
    made.t3.refuse = 'assign:assignment-1'
    made.executor.start(made.ticket, made.assignment)
    await until(() => made.t3.waiting, 'the send out')
    made.replace()
    await until(() => !made.executor.jobs.has('stop:ticket-1:assignment-1'), 'the stop job')
    release()
    await until(() => made.started.includes('assignment-2'), 'the new Assignment started')
    await made.executor.jobs.idle()
    // A failed report would land on the new Assignment.
    expect(made.reports).toEqual([])
    expect(made.executor.busySince('ticket-1')).toBeDefined()
  })

  it('keeps a stop queued while a launch waited, for the Ticket\'s next launch to wait on', async () => {
    const made = await launching(true)
    made.executor.start(made.ticket, made.assignment)
    await until(() => made.executor.busySince('ticket-1'), 'the running turn')
    made.t3.slow.set('stop:assignment-1', 100)
    made.t3.slow.set('stop:assignment-2', 300)
    made.replace()
    // The second Assignment's launch waits for the first one's stop, and is replaced meanwhile.
    await new Promise(resolve => setTimeout(resolve, 30))
    made.replace()
    await until(() => made.started.includes('assignment-3'), 'the third Assignment started')
    await made.executor.jobs.idle()
    expect(made.order()).toEqual(['assign:assignment-1', 'stop:assignment-1', 'stop:assignment-2', 'assign:assignment-3'])
    const thread = made.t3.threads.get(made.earlier!.threadId)!
    expect(thread.runs.map(run => run.status)).toEqual(['completed', 'interrupted', 'running'])
    expect(made.started).toEqual(['assignment-1', 'assignment-3'])
  })

  it('leaves a failed turn whose handling a stop cut short to the Assignment it failed in', async () => {
    const made = await launching(true, 300)
    made.executor.start(made.ticket, made.assignment)
    await until(() => made.executor.busySince('ticket-1'), 'the running turn')
    made.t3.finishRun(made.earlier!.threadId, 'failed')
    await until(() => !made.executor.busySince('ticket-1'), 'the failed turn seen')
    // Replaced in the pause: the new Assignment's worker is not told that a turn failed.
    made.replace()
    await until(() => made.started.includes('assignment-2'), 'the new Assignment started')
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(made.order().filter(id => !id.startsWith('stop:'))).toEqual(['assign:assignment-1', 'assign:assignment-2'])
    expect(made.saved.at(-1)?.failing).toBeUndefined()
    expect(made.reports).toEqual([])
  })
})
