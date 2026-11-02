/**
 * Recovery: the super agent's state survives its restart, and it owns recovery of the workers' runs (PLAN.md, ground rule
 * 3): a run t3code interrupted restarts with a recovery note, and a failed turn is told to go on before the Ticket fails.
 */
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { consoleTrigger } from '../src/app/console-source.ts'
import { FakeT3 } from './fake-t3.ts'
import { checkout, harness, until, type Harness } from './harness.ts'

describe('restart and recovery', () => {
  let open: Harness[] = []
  afterEach(async () => { for (const item of open) await item.close().catch(() => {}); open = [] })
  const start = async (...args: Parameters<typeof harness>) => { const made = await harness(...args); open.push(made); return made }

  it('picks up a running worker after the super agent restarts, without launching it again', async () => {
    const place = checkout()
    const t3 = new FakeT3([{ id: 'project-1', workspaceRoot: place.root }])
    const database = join(place.dir, 'state.sqlite')
    const first = await start(t3, place, database)
    first.runtime.engine.receive(consoleTrigger('hector', 'Update the changelog'))
    const thread = await until(() => t3.workerThreads()[0], 'the worker thread')
    const ticketId = first.runtime.repo.tickets.list()[0]!.id
    const token = first.runtime.executor.thread(ticketId)!.token
    await first.close(); open = []

    // t3code kept running; only the super agent restarted.
    const second = await start(t3, place, database)
    expect(second.runtime.executor.ticketOfToken(token)).toBe(ticketId)
    expect(second.runtime.view(second.runtime.repo.tickets.get(ticketId)!).link).toBe(thread.link)
    t3.finishRun(thread.id)
    await until(() => second.runtime.repo.tickets.get(ticketId)!.assignments.at(-1)!.idleAt, 'the turn end after the restart')
    expect(t3.workerThreads()).toHaveLength(1)
    expect(t3.calls.filter(call => call.tool === 't3_thread_launch')).toHaveLength(1)
  })

  it('restarts an Assignment whose run t3code interrupted, in the same thread, with a recovery note', async () => {
    const place = checkout()
    const t3 = new FakeT3([{ id: 'project-1', workspaceRoot: place.root }])
    const { runtime } = await start(t3, place)
    runtime.engine.receive(consoleTrigger('hector', 'Refactor the parser'))
    const thread = await until(() => t3.workerThreads()[0], 'the worker thread')
    const ticketId = runtime.repo.tickets.list()[0]!.id

    t3.finishRun(thread.id, 'interrupted')
    await until(() => runtime.repo.tickets.get(ticketId)!.assignments.length === 2, 'a new Assignment')
    await until(() => thread.messages.find(message => message.text.includes('The host restarted during this ticket')), 'the recovery note')
    expect(thread.messages.some(message => message.text.includes('This is a new assignment of the same ticket'))).toBe(true)
    expect(runtime.repo.tickets.get(ticketId)!.assignments[0]!).toMatchObject({ state: 'ended', endedReason: 'hostRestarted' })
    expect(t3.workerThreads()).toHaveLength(1)
  })

  it('tells a worker whose turn failed to go on, and fails the Ticket after repeated failures', async () => {
    const place = checkout()
    const t3 = new FakeT3([{ id: 'project-1', workspaceRoot: place.root }])
    const { runtime } = await start(t3, place)
    runtime.engine.receive(consoleTrigger('hector', 'Fix the flaky test'))
    const thread = await until(() => t3.workerThreads()[0], 'the worker thread')
    const ticketId = runtime.repo.tickets.list()[0]!.id
    const continuations = () => thread.messages.filter(message => message.text.startsWith('Your previous turn failed')).length

    for (let attempt = 1; attempt <= 3; attempt++) {
      t3.finishRun(thread.id, 'failed')
      await until(() => continuations() === attempt, `continuation ${attempt}`)
    }
    t3.finishRun(thread.id, 'failed')
    await until(() => runtime.view(runtime.repo.tickets.get(ticketId)!).stage === 'person/failed', 'the failed Ticket')
    expect(continuations()).toBe(3)
  })
})
