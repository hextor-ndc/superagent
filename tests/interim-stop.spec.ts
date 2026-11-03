/**
 * The rules router's stop on a ticket's own thread is kept in the store until the Engine decided it, as the model-backed
 * Router keeps its follow_up notice in its inbox: a shutdown before it ran, or a failed attempt, does not lose it.
 */
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { consoleThread, consoleTrigger } from '../src/app/console-source.ts'
import { FakeT3 } from './fake-t3.ts'
import { checkout, harness, until, type Harness } from './harness.ts'

describe('the rules router\'s stop', () => {
  let open: Harness[] = []
  afterEach(async () => { for (const item of open) await item.close().catch(() => {}); open = [] })
  const start = async (...args: Parameters<typeof harness>) => { const made = await harness(...args); open.push(made); return made }

  it('runs after a restart when the service stopped before it ran', async () => {
    const place = checkout()
    const t3 = new FakeT3([{ id: 'project-1', workspaceRoot: place.root }])
    const database = join(place.dir, 'state.sqlite')
    const first = await start(t3, place, database)
    const request = consoleTrigger('hector', 'Rework the subscription flow')
    first.runtime.engine.receive(request)
    await until(() => t3.workerThreads()[0], 'the worker thread')
    const ticketId = first.runtime.repo.tickets.list()[0]!.id

    // The stop commits, and the service shuts down before its job's tick.
    first.runtime.engine.receive(consoleTrigger('hector', 'stop', consoleThread(request.threads[0]!.id)))
    first.runtime.jobs.close()
    await first.close(); open = []
    expect(first.errors.join('\n')).not.toContain('stop')

    const second = await start(t3, place, database)
    expect(await until(() => second.runtime.repo.tickets.get(ticketId)!.ended, 'the stop after the restart'))
      .toMatchObject({ outcome: 'stopped', by: 'human' })
    await until(() => !second.runtime.repo.kv.list('interim-stop:').length, 'the stored stop forgotten')
  })

  it('reads a stop that waited behind another message on an ended ticket while processing was paused', async () => {
    const place = checkout()
    const t3 = new FakeT3([{ id: 'project-1', workspaceRoot: place.root }])
    const { runtime } = await start(t3, place)
    const request = consoleTrigger('hector', 'Rework the subscription flow')
    runtime.engine.receive(request)
    await until(() => t3.workerThreads()[0], 'the worker thread')
    const ticketId = runtime.repo.tickets.list()[0]!.id
    await until(() => runtime.repo.tickets.get(ticketId)!.assignments.at(-1)?.state === 'running', 'the running assignment')
    runtime.engine.report(ticketId, { state: 'ready', summary: 'Done.' })
    await until(() => runtime.repo.tickets.get(ticketId)!.ended, 'the ticket done')

    // Both wait for the ended ticket; the first resumes it after the pause, and the stop behind it must still be read.
    runtime.setPaused(true)
    runtime.engine.receive(consoleTrigger('hector', 'Also cover the yearly plan.', consoleThread(request.threads[0]!.id)))
    runtime.engine.receive(consoleTrigger('hector', 'stop', consoleThread(request.threads[0]!.id)))
    runtime.setPaused(false)
    runtime.engine.evaluateDue()
    expect(await until(() => runtime.repo.tickets.get(ticketId)!.ended?.by === 'human' && runtime.repo.tickets.get(ticketId)!.ended, 'the stop'))
      .toMatchObject({ outcome: 'stopped', by: 'human' })
  })

  it('tries again when deciding it failed', async () => {
    const place = checkout()
    const t3 = new FakeT3([{ id: 'project-1', workspaceRoot: place.root }])
    const { runtime, errors } = await start(t3, place)
    const request = consoleTrigger('hector', 'Rework the subscription flow')
    runtime.engine.receive(request)
    await until(() => t3.workerThreads()[0], 'the worker thread')
    const ticketId = runtime.repo.tickets.list()[0]!.id

    const decide = runtime.engine.decide.bind(runtime.engine)
    let failures = 1
    runtime.engine.decide = (...args) => {
      if (args[1].kind === 'stop' && failures-- > 0) throw new Error('database is locked')
      return decide(...args)
    }
    runtime.engine.receive(consoleTrigger('hector', 'please stop.', consoleThread(request.threads[0]!.id)))
    expect(await until(() => runtime.repo.tickets.get(ticketId)!.ended, 'the stop on the second attempt', 6000))
      .toMatchObject({ outcome: 'stopped', by: 'human' })
    expect(errors.some(line => line.includes('database is locked'))).toBe(true)
    expect(runtime.repo.kv.list('interim-stop:')).toEqual([])
  }, 10_000)
})
