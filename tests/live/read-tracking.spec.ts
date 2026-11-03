/**
 * Read tracking (tests/read-tracking.spec.ts) against a real, isolated `t3 serve` (tests/live/t3-server.ts): what t3code 0.1.6
 * does with a run it queued, which the unit tests' QueueingT3 copies. A send in mode auto queues while the active run is
 * starting, a wait for a queued run with a 0 ms timeout answers at once, and T3Executor counts a follow-up t3code queued as
 * read only once its run is seen started, before the turn end it reports for that run.
 *
 * Run with `T3_LIVE=1 npx vitest run tests/live`.
 */
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Assignment, Ticket, TicketInput } from '../../vendor/dsh/src/core/index.ts'
import { T3Executor, type TicketThread } from '../../src/executor/t3-executor.ts'
import type { McpT3Client } from '../../src/t3/client.ts'
import { eventually, live, poll, skipReason, startT3, type T3Server } from './t3-server.ts'

const TEST_MS = 120_000

describe.skipIf(!live)(`read tracking on a real t3code${live ? '' : ` (skipped: ${skipReason})`}`, () => {
  let server: T3Server, t3: McpT3Client
  let worktrees = 0
  const launch = async (message: string) => {
    const name = `r${++worktrees}`
    const path = join(server.dir, 'worktrees', name)
    execFileSync('git', ['worktree', 'add', '-q', '-b', `agent/${name}`, path, 'HEAD'], { cwd: server.checkout })
    return await t3.launch({ projectId: server.projectId, title: `[T-${name}] ${message.slice(0, 30)}`, message, worktreePath: path,
      branch: `agent/${name}`, clientRequestId: `launch:${name}` })
  }
  const running = (threadId: string) => poll(async () => (await t3.read(threadId, { limit: 1 })).thread.status === 'running', 'the run to start')

  beforeAll(async () => {
    server = await startT3()
    t3 = await server.client('full-access', 'plain')
  }, TEST_MS)
  afterAll(async () => {
    await t3?.close()
    await server?.close()
  }, 30_000)

  it('answers a wait for a queued run with a 0 ms timeout at once, and follows that run by id once it starts', async () => {
    const launched = await launch('long [slow 3000]')
    await running(launched.threadId)
    const queued = await t3.send(launched.threadId, 'queued [slow 1500]', 'send:queued:1', 'queue')
    expect(queued).toMatchObject({ delivery: 'queued', status: 'queued' })
    const started = Date.now()
    expect(await t3.wait(launched.threadId, 0, queued.runId)).toMatchObject({ runId: queued.runId, status: 'queued', timedOut: true })
    expect(Date.now() - started).toBeLessThan(2000)
    // Once the run before it ends, the queued run starts and then ends like any other.
    await eventually(async () => {
      const seen = await t3.wait(launched.threadId, 0, queued.runId)
      return seen.status === 'running' || seen.status === 'waiting' || seen.status === 'completed'
    }, 'the queued run to start')
    expect(await t3.wait(launched.threadId, 20_000, queued.runId)).toMatchObject({ runId: queued.runId, status: 'completed', timedOut: false })
  }, TEST_MS)

  it('counts a follow-up t3code queued as read once its run is seen started, before the turn end of that run', async () => {
    const launched = await launch('long [slow 6000]')
    await running(launched.threadId)
    const at = new Date().toISOString()
    const assignment: Assignment = { id: 'assignment-1', state: 'running', createdAt: at, startedAt: at }
    const ticket = { id: 'ticket-1', title: 'work', assignments: [assignment], inputs: [] as TicketInput[], undelivered: [] as string[], createdAt: at,
      updatedAt: at, origin: { triggerId: 'trigger-0', triggerIds: ['trigger-0'] } } as unknown as Ticket
    const calls: { name: string; ids?: string[]; at: string }[] = []
    const logged: string[] = []
    const record = (name: string, ids?: string[]) => { calls.push({ name, ...ids ? { ids } : {}, at: new Date().toISOString() }) }
    const entry: TicketThread = { ticketId: ticket.id, threadId: launched.threadId, worktreePath: '/unused', branch: 'agent/work', token: 'token', unread: [] }
    const executor = new T3Executor({
      t3, repo: { tickets: { get: (id: string) => id === ticket.id ? ticket : undefined }, triggers: { get: () => undefined } } as never,
      engine: () => ({
        assignmentStarted: () => {}, deliveryFailed: () => {}, report: () => ({}) as never, assignmentInterrupted: () => {},
        inputsDelivered: (_ticketId: string, _assignmentId: string, ids: string[]) => {
          record('delivered', ids)
          ticket.undelivered = ticket.undelivered.filter(id => !ids.includes(id))
        },
        inputsRead: (_ticketId: string, ids: string[]) => record('read', ids),
        turnEnded: () => record('turnEnded'),
      }),
      settings: () => ({}) as never, project: { id: server.projectId, root: server.checkout }, worktreeRoot: server.dir, workerUrl: token => `http://worker/${token}`,
      maxWorkers: () => 2, waitMs: 1000, idlePollMs: 200, pendingCheckMs: 60_000, log: (text, error) => { logged.push(`${text}: ${String(error)}`) },
      state: { load: () => [entry], save: () => {} },
    })
    try {
      ticket.inputs.push({ id: 'input-1', kind: 'text', text: 'the follow-up', at: new Date().toISOString() })
      ticket.undelivered.push('input-1')
      // Observed: a steer puts the run back to `starting`, and until it is running again a send in mode auto queues.
      expect(await t3.send(launched.threadId, 'steered [slow 3000]', 'send:steer:1', 'auto')).toMatchObject({ delivery: 'steered', status: 'starting' })
      executor.deliver(ticket, assignment)
      await eventually(async () => calls.find(call => call.name === 'delivered'), 'the delivery')
        .catch(error => { throw new Error(`${error}; log ${logged.join(' | ')}`) })
      expect(entry.queued).toBeDefined()
      const runId = Object.keys(entry.queued!)[0]
      // While the run that holds it waits, the follow-up is not read.
      expect(calls.filter(call => call.name === 'read')).toEqual([])
      expect((await t3.wait(launched.threadId, 0, runId)).status).toBe('queued')

      await eventually(async () => calls.find(call => call.name === 'read'), 'the read', 60_000)
      const read = calls.find(call => call.name === 'read')!
      expect(read.ids).toEqual(['input-1'])
      expect(entry.queued).toBeUndefined()
      expect(entry.unread).toEqual([])
      // A turn end follows the read in a later millisecond, so the core counts the follow-up read before it (readBefore is
      // strict). A run that ends quickly is read and ended in one look, which once gave both the same millisecond.
      await eventually(async () => {
        const seen = await t3.wait(launched.threadId, 0, runId)
        return seen.status === 'completed' && calls.some(call => call.name === 'turnEnded' && call.at > read.at)
      }, 'the turn end after the read', 20_000).catch(async error => {
        const runs = (await t3.read(launched.threadId, { limit: 1 }) as unknown as { recentRuns: unknown }).recentRuns
        throw new Error(`${error}; calls ${JSON.stringify(calls)}; runs ${JSON.stringify(runs)}; log ${logged.join(' | ')}`)
      })
      const items = await t3.read(launched.threadId, { limit: 100 })
      expect(items.items.map(item => `${item.type}: ${item.text}`)).toContain('assistant_message: echo[plain]: the follow-up')
    } finally { await executor.close() }
  }, TEST_MS)
})
