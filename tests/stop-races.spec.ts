/**
 * Point 1, stops: a stop frees the Ticket's worker slot at once, and work that was already out when it ran (a delivery's send,
 * the pause before a worker whose turn failed is told to go on) must not take the slot back. The Engine ends the Assignment in
 * the transaction that queues the stop, so that work finds it ended once it comes back.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { Assignment, Ticket, TicketInput } from '../vendor/dsh/src/core/index.ts'
import { T3Executor, type TicketThread } from '../src/executor/t3-executor.ts'
import type { SendResult } from '../src/t3/client.ts'
import { FakeT3 } from './fake-t3.ts'
import { until } from './harness.ts'

/** A FakeT3 whose sends, once made, hold their answer back until `gate` resolves. */
class HeldT3 extends FakeT3 {
  gate?: Promise<void>
  override async send(threadId: string, message: string, clientRequestId: string, mode = 'auto'): Promise<SendResult> {
    const result = await super.send(threadId, message, clientRequestId, mode)
    if (this.gate) await this.gate
    return result
  }
  hold(): () => void {
    let open!: () => void
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
})
