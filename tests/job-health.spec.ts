/**
 * What failed jobs report to the Watchdog: a kind of job counts as failing after three failures in a row and recovers once
 * one runs, and a delivery the ticket's end made moot is no failure at all.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { consoleThread, consoleTrigger } from '../src/app/console-source.ts'
import { T3Error } from '../src/t3/client.ts'
import { FakeT3 } from './fake-t3.ts'
import { checkout, harness, until, type Harness } from './harness.ts'

describe('job health', () => {
  let made: Harness | undefined
  afterEach(async () => { await made?.close(); made = undefined })

  it('counts a kind of job as failing after three failures in a row, and clears it once one runs', async () => {
    const place = checkout()
    const t3 = new FakeT3([{ id: 'project-1', workspaceRoot: place.root }])
    made = await harness(t3, place)
    const { runtime } = made
    const request = consoleTrigger('hector', 'Rework the subscription flow')
    runtime.engine.receive(request)
    const thread = await until(() => t3.workerThreads()[0], 'the worker thread')
    const ticketId = runtime.repo.tickets.list()[0]!.id
    await until(() => runtime.repo.tickets.get(ticketId)!.assignments.at(-1)?.state === 'running', 'the running assignment')

    // t3code is down for the first three sends to the worker; each failed delivery is tried again at once rather than after its backoff.
    const send = t3.send.bind(t3)
    let attempts = 0
    const failing: string[][] = []
    t3.send = async (threadId, ...rest) => {
      if (threadId === thread.id && ++attempts <= 3) {
        setTimeout(() => { failing.push(runtime.health.failing()); runtime.executor.jobs.wake('deliver:') }, 20)
        throw new T3Error('t3_thread_send', 'network', 'fetch failed')
      }
      return send(threadId, ...rest)
    }
    runtime.engine.receive(consoleTrigger('hector', 'Also cover the yearly plan.', consoleThread(request.threads[0]!.id)))
    await until(() => thread.messages.some(message => message.text.includes('yearly plan')), 'the fourth attempt')
    await runtime.executor.jobs.idle()
    expect(failing).toEqual([[], [], ['jobs:deliver']])
    expect(runtime.health.failing()).toEqual([])
    expect(runtime.health.snapshot()['jobs:deliver']).toMatchObject({ ok: true, failures: 0 })
    // A kind that never failed gets no entry.
    expect(runtime.health.snapshot()['jobs:launch']).toBeUndefined()
  })

  it('takes a send refused because the ticket ended while it was out as nothing left to deliver', async () => {
    const place = checkout()
    const t3 = new FakeT3([{ id: 'project-1', workspaceRoot: place.root }])
    made = await harness(t3, place)
    const { runtime, errors } = made
    const request = consoleTrigger('hector', 'Rework the subscription flow')
    runtime.engine.receive(request)
    const thread = await until(() => t3.workerThreads()[0], 'the worker thread')
    const ticketId = runtime.repo.tickets.list()[0]!.id
    await until(() => runtime.repo.tickets.get(ticketId)!.assignments.at(-1)?.state === 'running', 'the running assignment')

    // As a real t3code does when a stop reaches it first: the ticket ends while the send is out, and the send is refused.
    const send = t3.send.bind(t3)
    let refused = 0
    t3.send = async (threadId, ...rest) => {
      if (threadId !== thread.id) return send(threadId, ...rest)
      refused++
      runtime.engine.stopTicket(ticketId, 'stopped while the message was out')
      throw new T3Error('t3_thread_send', 'orchestration_error', `Target run run-1 is stopping and cannot be steered.`)
    }
    runtime.engine.receive(consoleTrigger('hector', 'Also cover the yearly plan.', consoleThread(request.threads[0]!.id)))
    await until(() => refused && runtime.repo.tickets.get(ticketId)!.ended, 'the ticket ended during the send')
    await runtime.executor.jobs.idle()
    expect(refused).toBe(1)
    expect(errors.filter(line => line.startsWith('deliver:'))).toEqual([])
    expect(runtime.health.failing()).toEqual([])
    expect(runtime.health.snapshot()['jobs:deliver']).toBeUndefined()
  })
})
