/**
 * Point 1, watching turns: when T3Executor tells the Engine that a worker read the Inputs it delivered (`inputsRead`). The
 * core keeps a person's message with the ticket only when its worker read it before its latest report or turn end, so a
 * read recorded at the turn's end, in the same millisecond, is too late. What t3code 0.1.6 does with a send in mode `auto`
 * decides it (tests/live/contract.spec.ts, tests/live/read-tracking.spec.ts): `steered` joins the running turn and `started`
 * begins one, so their Inputs are read at once; `queued` waits for the run before it, so its Inputs are read once that run is
 * seen started.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { Assignment, Ticket, TicketInput } from '../vendor/dsh/src/core/index.ts'
import { T3Executor, type TicketThread } from '../src/executor/t3-executor.ts'
import type { SendResult, T3Status, WaitResult } from '../src/t3/client.ts'
import { FakeT3 } from './fake-t3.ts'
import { until } from './harness.ts'

/**
 * A FakeT3 whose sends in mode `auto` act as t3code's: one sent while the active run is still starting queues a run, and a
 * finished run starts the next queued one. `wait` follows `runId` when it is given.
 */
class QueueingT3 extends FakeT3 {
  /**
   * The next send finds the active run still starting, so it queues. Observed in t3code 0.1.6: a steer puts the run back to
   * `starting`, and until it is running again a send in mode auto queues; one sent while it runs steers, even with a message
   * queued.
   */
  queueNext = false
  /** The runs a wait asked about by id. */
  readonly waitedFor: string[] = []
  override async send(threadId: string, message: string, clientRequestId: string, mode = 'auto'): Promise<SendResult> {
    this.calls.push({ tool: 't3_thread_send', args: { threadId, message, clientRequestId, mode } })
    const thread = this.threads.get(threadId)!
    const id = `message-${thread.messages.length + 1}`
    thread.messages.push({ id, text: message, clientRequestId })
    const active = thread.runs.find(run => run.status === 'running')
    const queue = active && this.queueNext
    this.queueNext = false
    if (active && !queue) return { messageId: id, runId: active.id, delivery: 'steered', status: 'running' }
    const run = { id: `run-${threadId}-${thread.runs.length + 1}`, status: (queue ? 'queued' : 'running') as T3Status }
    thread.runs.push(run)
    return { messageId: id, runId: run.id, delivery: queue ? 'queued' : 'started', status: run.status }
  }
  override async wait(threadId: string, timeoutMs: number, runId?: string): Promise<WaitResult> {
    const thread = this.threads.get(threadId)!
    if (runId) this.waitedFor.push(runId)
    const run = runId ? thread.runs.find(item => item.id === runId) : thread.runs.at(-1)
    if (!run) return { runId: null, status: 'idle', timedOut: false }
    const busy = (status: T3Status) => status === 'running' || status === 'queued'
    if (busy(run.status)) await new Promise(resolve => setTimeout(resolve, Math.min(timeoutMs, 5)))
    return { runId: run.id, status: run.status, timedOut: busy(run.status) }
  }
  /** The running run ends; the first queued one starts. */
  override finishRun(threadId: string, status: T3Status = 'completed'): void {
    const runs = this.threads.get(threadId)!.runs
    const active = runs.find(run => run.status === 'running')
    if (active) active.status = status
    const next = runs.find(run => run.status === 'queued')
    if (next) next.status = 'running'
  }
  /** A queued run is cancelled before it starts, as a plain interrupt cancels a held one. */
  cancelQueued(threadId: string): void {
    for (const run of this.threads.get(threadId)!.runs) if (run.status === 'queued') run.status = 'cancelled'
  }
}

type Call = { name: 'delivered' | 'read' | 'turnEnded'; ids?: string[]; at: string }

describe('read tracking', () => {
  let open: T3Executor[] = []
  afterEach(async () => { for (const executor of open) await executor.close(); open = [] })

  /** An executor whose Ticket already has a thread with a running turn, as after a launch, and an Engine that records its calls. */
  async function setup(saved: Partial<TicketThread> = {}, options: { tickOnRead?: boolean } = {}) {
    const t3 = new QueueingT3([{ id: 'project-1', workspaceRoot: '/unused' }])
    const launched = await t3.launch({ projectId: 'project-1', title: '[T-ticket-1] work', message: 'Assignment', worktreePath: '/unused',
      clientRequestId: 'launch:1' })
    const at = new Date().toISOString()
    const assignment: Assignment = { id: 'assignment-1', state: 'running', createdAt: at, startedAt: at }
    const ticket = { id: 'ticket-1', title: 'work', assignments: [assignment], inputs: [] as TicketInput[], undelivered: [] as string[], createdAt: at,
      updatedAt: at, origin: { triggerId: 'trigger-0', triggerIds: ['trigger-0'] } } as unknown as Ticket
    const calls: Call[] = []
    const record = (name: Call['name'], ids?: string[]) => { calls.push({ name, ...ids ? { ids } : {}, at: new Date().toISOString() }) }
    const saves: TicketThread[] = []
    const logged: string[] = []
    const entry: TicketThread = { ticketId: ticket.id, threadId: launched.threadId, worktreePath: '/unused', branch: 'agent/work', token: 'token',
      unread: [], ...saved }
    const executor = new T3Executor({
      t3, repo: { tickets: { get: (id: string) => id === ticket.id ? ticket : undefined }, triggers: { get: () => undefined } } as never,
      engine: () => ({
        assignmentStarted: () => {}, deliveryFailed: () => {}, report: () => ({}) as never, assignmentInterrupted: () => {},
        inputsDelivered: (_ticketId: string, _assignmentId: string, ids: string[]) => {
          record('delivered', ids)
          ticket.undelivered = ticket.undelivered.filter(id => !ids.includes(id))
        },
        inputsRead: (_ticketId: string, ids: string[]) => {
          // The Engine's clock may pass a millisecond between the executor's last look at it and the read time it records.
          if (options.tickOnRead) for (const start = Date.now(); Date.now() === start;) { /* spin */ }
          record('read', ids)
        },
        turnEnded: () => record('turnEnded'),
      }),
      settings: () => ({}) as never, project: { id: 'project-1', root: '/unused' }, worktreeRoot: '/unused', workerUrl: token => `http://worker/${token}`,
      maxWorkers: () => 2, waitMs: 5, idlePollMs: 5, pendingCheckMs: 1000, continueAfterMs: 1, log: message => { logged.push(message) },
      state: { load: () => [entry], save: item => { saves.push(structuredClone(item)) } },
    })
    open.push(executor)
    /** A person's follow-up reaches the Ticket and goes to its worker. */
    const followUp = (id: string) => {
      ticket.inputs.push({ id, kind: 'trigger', triggerId: `trigger-${id}`, at: new Date().toISOString(), human: true })
      ticket.undelivered.push(id)
      executor.deliver(ticket, assignment)
    }
    const threadId = launched.threadId
    return { t3, executor, ticket, entry, calls, saves, logged, followUp, threadId,
      reads: () => calls.filter(call => call.name === 'read').flatMap(call => call.ids!),
      ended: () => calls.find(call => call.name === 'turnEnded') }
  }

  it('counts a follow-up steered into the running turn as read when it is sent, before the turn ends', async () => {
    const made = await setup()
    made.followUp('input-1')
    await until(() => made.reads().includes('input-1'), 'the read')
    const send = made.t3.calls.find(call => call.tool === 't3_thread_send')
    expect(send).toBeDefined()
    // Read right after its delivery, while the run it joined still runs.
    expect(made.calls.map(call => call.name)).toEqual(['delivered', 'read'])
    expect(made.t3.threads.get(made.threadId)!.runs.at(-1)!.status).toBe('running')
    expect(made.entry.unread).toEqual([])
    made.t3.finishRun(made.threadId)
    await until(() => made.ended(), 'the turn end')
    // The turn end reads nothing more.
    expect(made.reads()).toEqual(['input-1'])
  })

  it('counts a follow-up that starts a run on an idle thread as read when it is sent', async () => {
    const made = await setup()
    made.t3.finishRun(made.threadId)
    made.followUp('input-1')
    await until(() => made.reads().includes('input-1'), 'the read')
    const runs = made.t3.threads.get(made.threadId)!.runs
    expect(runs).toHaveLength(2)
    expect(runs.at(-1)!.status).toBe('running')
    expect(made.ended()).toBeUndefined()
  })

  it('counts a queued follow-up as read only once its run is seen running, and reports the turn end after', async () => {
    const made = await setup()
    made.t3.queueNext = true
    made.followUp('input-1')
    await until(() => made.calls.some(call => call.name === 'delivered'), 'the delivery')
    // The run it waits in has not started: nothing is read, and the executor remembers which run holds it.
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(made.reads()).toEqual([])
    expect(made.entry.unread).toEqual(['input-1'])
    expect(Object.values(made.entry.queued ?? {})).toEqual([['input-1']])
    expect(made.saves.at(-1)!.queued).toEqual(made.entry.queued)

    // The running turn ends and the queued run starts with the follow-up.
    made.t3.finishRun(made.threadId)
    await until(() => made.reads().includes('input-1'), 'the read')
    expect(made.entry.unread).toEqual([])
    expect(made.entry.queued).toBeUndefined()
    made.t3.finishRun(made.threadId)
    await until(() => made.ended(), 'the turn end')
    const read = made.calls.find(call => call.name === 'read')!
    expect(read.at < made.ended()!.at).toBe(true)
  })

  it('counts a queued follow-up read at the end of its run, in an earlier millisecond, when its run was never seen running', async () => {
    const made = await setup()
    made.t3.queueNext = true
    made.followUp('input-1')
    await until(() => made.entry.queued, 'the queued delivery')
    // Both runs end before the next look: the queued one started and finished in between.
    made.t3.finishRun(made.threadId); made.t3.finishRun(made.threadId)
    await until(() => made.ended(), 'the turn end')
    const read = made.calls.find(call => call.name === 'read')
    expect(read?.ids).toEqual(['input-1'])
    // The core counts it read before the turn end only with an earlier read time (readBefore is strict).
    expect(read!.at < made.ended()!.at).toBe(true)
  })

  it('asks t3code about a queued run the wait does not name, such as one with another queued run behind it', async () => {
    const made = await setup()
    made.t3.queueNext = true
    made.followUp('input-1')
    await until(() => made.entry.queued, 'the first queued delivery')
    // A second follow-up queues behind the first; the wait now names that newer run.
    made.t3.queueNext = true
    made.followUp('input-2')
    await until(() => Object.keys(made.entry.queued ?? {}).length === 2, 'the second queued delivery')
    // Once the first queued run is asked about by id, a wait that names the newer run has come back, so no wait still out
    // names the first one and could see it running before the look by id.
    const first = Object.keys(made.saves.find(item => item.queued)!.queued!)[0]!
    await until(() => made.t3.waitedFor.includes(first), 'a look at the first queued run by id')
    made.t3.finishRun(made.threadId)
    await until(() => made.reads().includes('input-1'), 'the first read')
    expect(made.reads()).toEqual(['input-1'])
    made.t3.finishRun(made.threadId)
    await until(() => made.reads().includes('input-2'), 'the second read')
  })

  it('leaves a queued follow-up unread when its run is cancelled before it starts', async () => {
    const made = await setup()
    made.t3.queueNext = true
    made.followUp('input-1')
    await until(() => made.entry.queued, 'the queued delivery')
    made.t3.cancelQueued(made.threadId)
    made.t3.finishRun(made.threadId)
    await until(() => made.ended(), 'the turn end')
    await new Promise(resolve => setTimeout(resolve, 30))
    // The core then gives it back to the next Assignment, or lets it go when the ticket ends; the executor stops asking.
    expect(made.reads()).toEqual([])
    expect(made.entry.unread).toEqual([])
    expect(made.entry.queued).toBeUndefined()
  })

  it('counts Inputs saved unread before this tracking, with no queued run, as read at the next turn end', async () => {
    const made = await setup({ unread: ['input-0'] })
    // Watching starts with the next delivery; the saved Input is read at the turn end, before it is reported.
    made.followUp('input-1')
    await until(() => made.reads().includes('input-1'), 'the steered read')
    expect(made.reads()).toEqual(['input-1'])
    made.t3.finishRun(made.threadId)
    await until(() => made.ended(), 'the turn end')
    const read = made.calls.filter(call => call.name === 'read').at(-1)!
    expect(read.ids).toEqual(['input-0'])
    expect(read.at < made.ended()!.at).toBe(true)
    expect(made.entry.unread).toEqual([])
  })

  it('reports a turn end in a later millisecond than the reads before it, even when the clock ticks while they are recorded', async () => {
    const made = await setup({ unread: ['input-0'] }, { tickOnRead: true })
    made.followUp('input-1')
    await until(() => made.reads().includes('input-1'), 'the steered read')
    made.t3.finishRun(made.threadId)
    await until(() => made.ended(), 'the turn end')
    const read = made.calls.filter(call => call.name === 'read').at(-1)!
    expect(read.ids).toEqual(['input-0'])
    expect(read.at < made.ended()!.at).toBe(true)
  })

  it('counts a follow-up that starts the next run while a turn end is being reported as read only after that end', async () => {
    // A queued run saved from before, which the turn end asks t3code about; the follow-up goes out while that look is out.
    const made = await setup({ unread: ['input-0'], queued: { 'run-saved': ['input-0'] } })
    const wait = made.t3.wait.bind(made.t3)
    let armed = false
    made.t3.wait = async (threadId: string, timeoutMs: number, runId?: string) => {
      if (runId !== 'run-saved') return wait(threadId, timeoutMs, runId)
      // While the turn runs, the saved run reads as still queued.
      if (!armed) return { runId, status: 'queued', timedOut: true }
      armed = false
      made.followUp('input-2')
      await until(() => made.t3.calls.some(call => (call.args as { clientRequestId?: string }).clientRequestId?.includes('input-2')), 'the send')
      await new Promise(resolve => setTimeout(resolve, 10))
      return { runId, status: 'completed', timedOut: false }
    }
    made.followUp('input-1')
    await until(() => made.reads().includes('input-1'), 'the steered read')
    armed = true
    made.t3.finishRun(made.threadId)
    await until(() => made.reads().includes('input-2'), 'the read of the follow-up')
    // It started a new run, which has not run yet when the turn before it ends.
    expect(made.t3.threads.get(made.threadId)!.runs.at(-1)!.status).toBe('running')
    expect(made.calls.map(call => call.name + (call.ids ? `:${call.ids.join(',')}` : ''))).toEqual(
      ['delivered:input-1', 'read:input-1', 'read:input-0', 'turnEnded', 'delivered:input-2', 'read:input-2'])
    const read = made.calls.at(-1)!
    // The core counts it read before the turn end only with an earlier read time, which it is not.
    expect(read.at >= made.ended()!.at).toBe(true)
  })

  it('sends the messages of a queued run that failed before it was seen running again, and counts them read with that send', async () => {
    const made = await setup()
    made.t3.queueNext = true
    made.followUp('input-1')
    await until(() => made.entry.queued, 'the queued delivery')
    // The running turn ends and the queued run fails, both before the next look, so nothing tells whether its model read it.
    made.t3.finishRun(made.threadId); made.t3.finishRun(made.threadId, 'failed')
    const isContinue = (call: { args: unknown }) => !!(call.args as { clientRequestId?: string }).clientRequestId?.startsWith('continue:')
    await until(() => made.t3.calls.some(isContinue), 'the message to go on')
    const text = (made.t3.calls.find(isContinue)!.args as { message: string }).message
    expect(text).toMatch(/^Your previous turn failed/)
    expect(text).toContain('sent again')
    expect(text).toContain('trigger-input-1')
    // The message to go on started a run, which holds the follow-up again.
    expect(made.reads()).toEqual(['input-1'])
    expect(made.entry.unread).toEqual([])
    expect(made.entry.queued).toBeUndefined()
    made.t3.finishRun(made.threadId)
    await until(() => made.ended(), 'the turn end')
    expect(made.calls.find(call => call.name === 'read')!.at < made.ended()!.at).toBe(true)
  })
})
