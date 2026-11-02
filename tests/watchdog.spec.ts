/** Phase 3: the Watchdog thread, its tools, its alerts in the console, and re-arming when its check-ins stop. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, describe, expect, it } from 'vitest'
import { consoleTrigger } from '../src/app/console-source.ts'
import type { Gh } from '../src/sources/github.ts'
import { FakeT3 } from './fake-t3.ts'
import { checkout, harness, until, type Harness } from './harness.ts'

const data = (result: unknown) => (result as { structuredContent: Record<string, unknown> }).structuredContent
async function mcp(url: string) {
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url)))
  return client
}

describe('the Watchdog', () => {
  let made: Harness | undefined
  afterEach(async () => { await made?.close(); made = undefined })

  it('sets itself up in its own thread, with its own tools, and asks its agent to schedule the checks', async () => {
    const place = checkout()
    const t3 = new FakeT3([{ id: 'project-1', workspaceRoot: place.root }])
    made = await harness(t3, place, ':memory:', { watchdogMinutes: 15 })
    await made.runtime.ensureWatchdog()
    await made.runtime.ensureWatchdog()
    const threads = [...t3.threads.values()].filter(thread => thread.title === 'Superagent Watchdog')
    expect(threads).toHaveLength(1)
    const setup = threads[0]!.messages
    expect(setup).toHaveLength(1)
    expect(setup[0]!.text).toContain('schedule_task')
    expect(setup[0]!.text).toContain('everyMs: 900000')
    const url = (JSON.parse(readFileSync(join(threads[0]!.worktreePath!, '.mcp.json'), 'utf8')) as { mcpServers: { superagent: { url: string } } }).mcpServers.superagent.url
    expect(url).toBe(made.runtime.watchdogUrl())
    // Its token opens only its own tools.
    expect((await fetch(`${made.base}/mcp/console/${url.split('/').at(-1)}`, { method: 'POST', body: '{}' })).status).toBe(401)
    expect((await fetch(`${made.base}/mcp/watchdog/console-secret`, { method: 'POST', body: '{}' })).status).toBe(401)
    const watchdog = await mcp(url)
    expect((await watchdog.listTools()).tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['watchdog_check', 'watchdog_nudge', 'watchdog_alert']))
    await watchdog.close()
  })

  it('sees a running worker, reads its thread, nudges it, and raises one alert that the console shows and dismisses', async () => {
    const place = checkout()
    const t3 = new FakeT3([{ id: 'project-1', workspaceRoot: place.root }])
    made = await harness(t3, place, ':memory:', { watchdogMinutes: 15 })
    made.runtime.engine.receive(consoleTrigger('hector', 'Speed up the build'))
    const thread = await until(() => t3.workerThreads()[0], 'the worker thread')
    const ticket = made.runtime.repo.tickets.list()[0]!
    await until(() => made!.runtime.executor.busySince(ticket.id), 'the running turn')

    const watchdog = await mcp(made.runtime.watchdogUrl())
    const check = data(await watchdog.callTool({ name: 'watchdog_check', arguments: {} }))
    expect(check.failing).toEqual([])
    expect(check.tickets).toMatchObject([{ id: ticket.id, running_turn: true, minutes_running: 0 }])
    const activity = data(await watchdog.callTool({ name: 'watchdog_thread', arguments: { ticket_id: ticket.id, limit: 5 } }))
    expect((activity.items as { text: string }[])[0]!.text).toContain('Speed up the build')

    await watchdog.callTool({ name: 'watchdog_nudge', arguments: { ticket_id: ticket.id, text: 'You re-ran the same failing test three times; read the error first.' } })
    t3.finishRun(thread.id)
    await until(() => thread.messages.find(message => message.text.includes('From the Watchdog: You re-ran the same failing test')), 'the nudge in the thread')

    const alert = { text: 'The worker on the build ticket loops; consider stopping it.', ticket_id: ticket.id }
    await watchdog.callTool({ name: 'watchdog_alert', arguments: alert })
    await watchdog.callTool({ name: 'watchdog_alert', arguments: alert })
    const console = await mcp(`${made.base}/mcp/console/console-secret`)
    const attention = data(await console.callTool({ name: 'superagent_attention', arguments: {} }))
    const alerts = attention.alerts as { id: string; text: string; ticketId: string }[]
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toMatchObject({ text: alert.text, ticketId: ticket.id })
    expect(data(await console.callTool({ name: 'superagent_dismiss_alert', arguments: { alert_id: alerts[0]!.id } }))).toEqual({ dismissed: true })
    expect(data(await console.callTool({ name: 'superagent_attention', arguments: {} })).alerts).toEqual([])
    await watchdog.close(); await console.close()
  })

  it('reports a failing part, and re-arms a Watchdog whose check-ins stopped', async () => {
    const place = checkout()
    const t3 = new FakeT3([{ id: 'project-1', workspaceRoot: place.root }])
    const down: Gh = async () => { throw new Error('gh: HTTP 503') }
    made = await harness(t3, place, ':memory:', { watchdogMinutes: 15, github: { login: 'widget-bot', allowed: [], gh: 'gh', pollMs: 3_600_000 } }, { gh: down })
    for (let poll = 0; poll < 3; poll++) await made.runtime.github!.poll()
    expect(made.runtime.health.failing()).toContain('github')

    await made.runtime.ensureWatchdog()
    const thread = [...t3.threads.values()].find(item => item.title === 'Superagent Watchdog')!
    const start = Date.now()
    // Within the window, nothing happens; past it without a check-in, the Watchdog is asked to check and re-arm.
    expect(await made.runtime.checkWatchdog(start, start + 30 * 60_000)).toBe(false)
    expect(await made.runtime.checkWatchdog(start, start + 40 * 60_000)).toBe(true)
    expect(thread.messages.at(-1)!.text).toContain('list_scheduled_tasks')
    expect(made.runtime.health.failing()).toContain('github')
    // A check-in resets it.
    const watchdog = await mcp(made.runtime.watchdogUrl())
    expect(data(await watchdog.callTool({ name: 'watchdog_check', arguments: {} })).failing).toContain('github')
    expect(await made.runtime.checkWatchdog(start, Date.now() + 30 * 60_000)).toBe(false)
    await watchdog.close()
  })
})
