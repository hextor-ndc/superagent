/**
 * Point 1, failed turns across a restart: a worker whose turn failed is told to go on after a pause, and the handling of that
 * failure is saved with the Ticket's thread. A restart in the pause, or before the message telling the worker to go on came
 * back, takes it up again where it stopped, without counting the same failure twice; one handled to its end is left alone.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { Assignment, Ticket, TicketInput } from '../vendor/dsh/src/core/index.ts'
import { continueRequestId, T3Executor, type TicketThread } from '../src/executor/t3-executor.ts'
import { FakeT3 } from './fake-t3.ts'
import { until } from './harness.ts'

describe('a failed turn across a restart', () => {
  let open: T3Executor[] = []
  afterEach(async () => { for (const executor of open) await executor.close(); open = [] })

  /**
   * An executor started as after a restart, on a Ticket whose thread's latest run ended `status` (failed by default), with
   * the thread record as it was saved: `saved` gets that run's id. A person's message (`input-1`) was queued in that run.
   */
  async function restarted(saved: (runId: string) => Partial<TicketThread>, status: 'failed' | 'completed' = 'failed') {
    const t3 = new FakeT3([{ id: 'project-1', workspaceRoot: '/unused' }])
    const launched = await t3.launch({ projectId: 'project-1', title: '[T-ticket-1] work', message: 'Assignment', worktreePath: '/unused',
      clientRequestId: 'launch:assignment-1' })
    const runId = launched.runId!
    t3.finishRun(launched.threadId, status)
    const at = new Date().toISOString()
    const assignment: Assignment = { id: 'assignment-1', state: 'running', createdAt: at, startedAt: at }
    const ticket = { id: 'ticket-1', title: 'work', assignments: [assignment], undelivered: [] as string[], createdAt: at, updatedAt: at,
      inputs: [{ id: 'input-1', kind: 'trigger', triggerId: 'trigger-1', at, human: true }] as TicketInput[],
      origin: { triggerId: 'trigger-0', triggerIds: ['trigger-0'] } } as unknown as Ticket
    const reports: string[] = []
    const ends: string[] = []
    const read: string[] = []
    const records: TicketThread[] = []
    /** The thread record as saved when each turn end was reported. */
    const atEnds: (TicketThread | undefined)[] = []
    const entry: TicketThread = { ticketId: ticket.id, threadId: launched.threadId, worktreePath: '/unused', branch: 'agent/work', token: 'token',
      unread: [], ...saved(runId) }
    const executor = new T3Executor({
      t3, repo: { tickets: { get: (id: string) => id === ticket.id ? ticket : undefined, active: () => [ticket] }, triggers: { get: () => undefined } } as never,
      engine: () => ({ assignmentStarted: () => {}, deliveryFailed: () => {}, assignmentInterrupted: () => {}, inputsDelivered: () => {},
        report: (_ticketId: string, report: { state: string }) => { reports.push(report.state); return {} as never },
        inputsRead: (_ticketId: string, ids: string[]) => { read.push(...ids) },
        turnEnded: (_ticketId: string, assignmentId: string) => { ends.push(assignmentId); atEnds.push(records.at(-1)) } }),
      settings: () => ({}) as never, project: { id: 'project-1', root: '/unused' }, worktreeRoot: '/unused', workerUrl: token => token,
      maxWorkers: () => 1, waitMs: 5, idlePollMs: 5, pendingCheckMs: 1000, continueAfterMs: 1, log: () => {},
      state: { load: () => [entry], save: record => { records.push(structuredClone(record)) } },
    })
    open.push(executor)
    const sends = () => t3.calls.filter(call => call.tool === 't3_thread_send').map(call => call.args as { clientRequestId: string; message: string })
    return { t3, executor, threadId: launched.threadId, runId, reports, ends, read, records, atEnds, sends, resume: () => executor.resume() }
  }

  it('tells the worker to go on after a restart in the pause, without counting the failure again, and sends its held messages again', async () => {
    const made = await restarted(runId => ({ failures: 1, failing: { runId }, unread: ['input-1'], queued: { [runId]: ['input-1'] } }))
    made.resume()
    await until(() => made.executor.busySince('ticket-1'), 'the worker going on')
    expect(made.sends().map(send => send.clientRequestId)).toEqual([continueRequestId('assignment-1', made.runId, 1)])
    expect(made.sends()[0]!.message).toContain('They are sent again in case it failed before you read them')
    expect(made.read).toEqual(['input-1'])
    expect(made.records.at(-1)).toMatchObject({ endedRunId: made.runId, failures: 1, unread: [] })
    expect(made.records.at(-1)?.failing).toBeUndefined()
    expect(made.reports).toEqual([])
    // The worker's next turn ends well, which clears the count.
    made.t3.finishRun(made.threadId)
    await until(() => made.ends.length, 'the turn end')
    expect(made.ends).toEqual(['assignment-1'])
    expect(made.records.at(-1)).toMatchObject({ failures: 0 })
  })

  it('tells the worker to go on after a restart in the pause, from a record saved before the handling was kept', async () => {
    // As the executor saved it then: the failure counted and the run saved as ended before the worker was told to go on.
    const made = await restarted(runId => ({ endedRunId: runId, failures: 1 }))
    made.resume()
    await until(() => made.executor.busySince('ticket-1'), 'the worker going on')
    expect(made.sends().map(send => send.clientRequestId)).toEqual(['continue:assignment-1:1'])
    expect(made.records.at(-1)).toMatchObject({ endedRunId: made.runId, failures: 1 })
  })

  it('starts no second run when the message telling the worker to go on landed before the restart', async () => {
    const made = await restarted(runId => ({ failures: 1, failing: { runId }, unread: ['input-1'], queued: { [runId]: ['input-1'] } }))
    await made.t3.send(made.threadId, 'Your previous turn failed with an error.', continueRequestId('assignment-1', made.runId, 1))
    made.resume()
    await until(() => made.read.length, 'the held message read')
    await until(() => made.executor.busySince('ticket-1'), 'the worker going on')
    // Sent again under the same request id, which t3code answers with the first answer.
    expect(made.sends().map(send => send.clientRequestId)).toEqual([continueRequestId('assignment-1', made.runId, 1), continueRequestId('assignment-1', made.runId, 1)])
    expect(made.t3.threads.get(made.threadId)!.runs).toHaveLength(2)
    expect(made.read).toEqual(['input-1'])
    expect(made.records.at(-1)?.failing).toBeUndefined()
  })

  it('reports the Ticket failed after a restart when the failure was one too many', async () => {
    const made = await restarted(runId => ({ failures: 4, failing: { runId } }))
    made.resume()
    await until(() => made.ends.length, 'the turn end')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(made.reports).toEqual(['failed'])
    expect(made.ends).toEqual(['assignment-1'])
    expect(made.sends()).toEqual([])
    expect(made.records.at(-1)).toMatchObject({ endedRunId: made.runId, failures: 0 })
    expect(made.records.at(-1)?.failing).toBeUndefined()
  })

  it('reports the Ticket failed after a restart when the failure was one too many, from a record saved before the handling was kept', async () => {
    const made = await restarted(runId => ({ endedRunId: runId, failures: 4 }))
    made.resume()
    await until(() => made.ends.length, 'the turn end')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(made.reports).toEqual(['failed'])
    expect(made.ends).toEqual(['assignment-1'])
    expect(made.sends()).toEqual([])
  })

  it('reports only the turn end after a restart that came once the Ticket was reported failed', async () => {
    const made = await restarted(runId => ({ failures: 4, failing: { runId, reported: true } }))
    made.resume()
    await until(() => made.ends.length, 'the turn end')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(made.reports).toEqual([])
    expect(made.ends).toEqual(['assignment-1'])
    expect(made.sends()).toEqual([])
  })

  it('leaves a failed run handled to its end before the restart alone', async () => {
    const made = await restarted(runId => ({ endedRunId: runId, failures: 0 }))
    made.resume()
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(made.sends()).toEqual([])
    expect(made.reports).toEqual([])
    expect(made.ends).toEqual([])
    expect(made.executor.busySince('ticket-1')).toBeUndefined()
  })

  it('tells the worker to go on in a new run when a turn fails again after one that ended well', async () => {
    // No restart: the first failed run is counted as new, the worker goes on, and its next turn ends well.
    const made = await restarted(() => ({}))
    made.resume()
    const runs = () => made.t3.threads.get(made.threadId)!.runs
    await until(() => runs().length === 2, 'the worker going on')
    made.t3.finishRun(made.threadId)
    await until(() => made.ends.length, 'the turn end')
    // A person's message starts the next turn, which fails too: the count starts again at one.
    await made.t3.send(made.threadId, 'A person writes.', 'deliver:assignment-1:input-2')
    await until(() => made.executor.busySince('ticket-1'), 'the next turn')
    const failed = runs().at(-1)!.id
    made.t3.finishRun(made.threadId, 'failed')
    await until(() => runs().length === 4, 'the worker going on again')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(made.sends().map(send => send.clientRequestId)).toEqual([continueRequestId('assignment-1', made.runId, 1), 'deliver:assignment-1:input-2',
      continueRequestId('assignment-1', failed, 1)])
    expect(runs().at(-1)?.status).toBe('running')
    expect(made.records.at(-1)).toMatchObject({ endedRunId: failed, failures: 1 })
    expect(made.reports).toEqual([])
  })

  it('reports the Ticket failed, instead of going round, when the messages telling the worker to go on start no run', async () => {
    // t3code answers each of them without a run, as a request id it has seen: the wait keeps naming the failed run.
    const made = await restarted(() => ({}))
    const send = made.t3.send.bind(made.t3)
    made.t3.send = async (threadId, text, clientRequestId, mode) => {
      if (!clientRequestId.startsWith('continue:')) return send(threadId, text, clientRequestId, mode)
      made.t3.calls.push({ tool: 't3_thread_send', args: { threadId, message: text, clientRequestId, mode } })
      return { messageId: 'message-0', runId: made.runId, delivery: 'started', status: 'running' }
    }
    made.resume()
    await until(() => made.reports.length, 'the failed report')
    await until(() => made.ends.length, 'the turn end')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(made.reports).toEqual(['failed'])
    expect(made.sends()).toHaveLength(3)
    expect(made.ends).toEqual(['assignment-1'])
  })

  it('saves that the Ticket was reported failed before the turn end that follows', async () => {
    // The failure is the one too many; the turn end that follows saves its end last.
    const made = await restarted(() => ({ failures: 3 }))
    made.resume()
    await until(() => made.ends.length, 'the turn end')
    expect(made.reports).toEqual(['failed'])
    expect(made.atEnds[0]).toMatchObject({ failures: 4, failing: { runId: made.runId, reported: true } })
    expect(made.records.at(-1)?.failing).toBeUndefined()
  })

  it('saves a turn as ended only after its end was reported, so a restart in between reports it again', async () => {
    const made = await restarted(() => ({ unread: ['input-1'] }), 'completed')
    made.resume()
    await until(() => made.ends.length, 'the turn end')
    // The reads were saved before the end was reported, and the run's end only after.
    expect(made.read).toEqual(['input-1'])
    expect(made.atEnds[0]).toMatchObject({ unread: [] })
    expect(made.atEnds[0]?.endedRunId).toBeUndefined()
    expect(made.records.at(-1)).toMatchObject({ endedRunId: made.runId, failures: 0 })
  })

  it('keeps the id of the message telling a worker to go on short, whatever the run id', () => {
    // t3code's run ids hold the thread id; a long request id crowds the history t3code hands a new agent (tests/live/e2e.spec.ts).
    const runId = `run:thread:mcp%3Alaunch%3A${'a'.repeat(64)}:ordinal:1`
    const id = continueRequestId('3512257d212b2d9b1f3205ae5444f3ed', runId, 1)
    expect(id.length).toBeLessThanOrEqual(60)
    expect(id).not.toBe(continueRequestId('3512257d212b2d9b1f3205ae5444f3ed', runId.replace(':1', ':2'), 1))
  })
})
