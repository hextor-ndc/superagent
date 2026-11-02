/**
 * Points 1–5 end to end, with a fake t3code and a real git checkout: a request from the console becomes a Ticket with its
 * own t3code thread and worktree; the worker uses its MCP tools; questions reach the attention queue; results carry the
 * thread link.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Runtime } from '../src/app/runtime.ts'
import type { Config } from '../src/config.ts'
import { startHttp } from '../src/http/server.ts'
import { ATTENTION_URI, MCP_APP_MIME } from '../src/mcp/attention-app.ts'
import { FakeT3 } from './fake-t3.ts'

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

async function until<T>(check: () => T | undefined | false, what: string, ms = 4000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = check()
    if (value) return value
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
async function mcp(url: string) {
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url)))
  return client
}
const data = (result: unknown) => (result as { structuredContent: Record<string, unknown> }).structuredContent

describe('superagent on t3code', () => {
  let root: string, t3: FakeT3, runtime: Runtime, http: Server, base: string
  const errors: string[] = []

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'superagent-'))
    root = join(dir, 'widgets')
    execFileSync('git', ['init', '-q', '-b', 'main', root])
    writeFileSync(join(root, 'README.md'), '# widgets\n')
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.')
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init')
    t3 = new FakeT3([{ id: 'project-1', workspaceRoot: root }])
    const config: Config = { t3Url: 'unused', t3Token: 'unused', projectRoot: root, worktreeRoot: join(dir, 'worktrees'), baseRef: 'HEAD',
      repository: 'acme/widgets', port: 0, publicUrl: '', consoleToken: 'console-secret', operator: 'hector', maxWorkers: 2,
      log: (message, error) => { errors.push(`${message} ${error instanceof Error ? error.message : error ?? ''}`) } }
    // The public URL is known only once the server listens; the runtime reads it when it builds URLs.
    runtime = new Runtime(config, t3, { id: 'project-1', root }, { waitMs: 10, idlePollMs: 10 })
    http = await startHttp(runtime, 0)
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
    config.publicUrl = base
    runtime.start()
  })
  afterEach(async () => { http.close(); await runtime.stop() })

  it('runs a console request as a t3code thread, end to end', async () => {
    // Point 2: the console thread exists, is pinned, and has the console MCP server in its folder.
    await runtime.ensureConsole()
    const consoleThread = t3.threads.get(runtime.console!.threadId)!
    expect(consoleThread.pinned).toBe(true)
    expect(readFileSync(join(consoleThread.worktreePath!, '.mcp.json'), 'utf8')).toContain('/mcp/console/console-secret')
    await runtime.ensureConsole()
    expect(t3.threads.size).toBe(1)

    const consoleClient = await mcp(`${base}/mcp/console/console-secret`)
    const tools = await consoleClient.listTools()
    const attentionTool = tools.tools.find(tool => tool.name === 'superagent_attention')!
    expect(attentionTool._meta).toMatchObject({ ui: { resourceUri: ATTENTION_URI } })
    const app = await consoleClient.readResource({ uri: ATTENTION_URI })
    expect(app.contents[0]).toMatchObject({ mimeType: MCP_APP_MIME })

    // Point 1: a request becomes a Ticket with its own thread, worktree and worker MCP configuration.
    await consoleClient.callTool({ name: 'superagent_request', arguments: { text: 'Fix the typo in the README heading' } })
    const thread = await until(() => t3.workerThreads()[0], 'the worker thread')
    expect(thread.title).toMatch(/^\[T-[0-9a-f]{8}\] Fix the typo in the README heading$/)
    expect(thread.branch).toMatch(/^agent\/fix-the-typo-in-the-readme-heading-[0-9a-f]{8}$/)
    expect(existsSync(join(thread.worktreePath!, 'README.md'))).toBe(true)
    expect(git(root, 'worktree', 'list')).toContain(thread.worktreePath!)
    expect(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8')).toContain('.mcp.json')
    expect(git(thread.worktreePath!, 'status', '--porcelain')).toBe('')
    expect(thread.messages[0]!.text).toContain('Fix the typo in the README heading')
    expect(thread.messages[0]!.text).toContain('orchestrator_report')
    const ticket = runtime.repo.tickets.list()[0]!
    expect(runtime.view(ticket).link).toBe(thread.link)

    // The worker's own tools, from the URL in its worktree.
    const workerUrl = (JSON.parse(readFileSync(join(thread.worktreePath!, '.mcp.json'), 'utf8')) as { mcpServers: { superagent: { url: string } } })
      .mcpServers.superagent.url
    expect(readFileSync(join(thread.worktreePath!, '.codex', 'config.toml'), 'utf8')).toContain(workerUrl)
    const worker = await mcp(workerUrl)
    expect(data(await worker.callTool({ name: 'orchestrator_read', arguments: { resource: 'ticket' } })).text).toContain(ticket.id)
    await worker.callTool({ name: 'orchestrator_ack', arguments: { trigger_id: ticket.origin.triggerId, text: 'On it: fixing the heading.' } })

    // A question goes to the attention queue (point 3), and the message about it carries the thread link (point 4).
    await worker.callTool({ name: 'orchestrator_report', arguments: { state: 'progress', summary: 'Two headings could be meant.',
      human_action: 'Should I fix the H1 or the H2?' } })
    const attention = data(await consoleClient.callTool({ name: 'superagent_attention', arguments: {} })).tickets as { question?: string; stage: string }[]
    expect(attention).toMatchObject([{ question: 'Should I fix the H1 or the H2?', stage: 'person/answer' }])
    await until(() => runtime.outbox.list(record => record.message.kind === 'reply' && record.status === 'sent')[0], 'the attention message')
    expect(runtime.outbox.list(record => record.message.kind === 'reply')[0]!.message.text).toContain(`[Open in T3 Code](${thread.link})`)

    // The turn ends; the answer from the panel reaches the worker in its thread.
    t3.finishRun(thread.id)
    await until(() => ticket && runtime.repo.tickets.get(ticket.id)!.assignments.at(-1)!.idleAt, 'the turn end')
    const panel = await fetch(`${base}/panel/console-secret/action`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'superagent_answer', arguments: { ticket_id: runtime.view(ticket).short, text: 'The H1, please.' } }) })
    expect(panel.status).toBe(200)
    await until(() => thread.messages.find(message => message.text.includes('The H1, please.')), 'the answer in the worker thread')
    expect(thread.runs.at(-1)!.status).toBe('running')

    // Ready with a PR: t3code shows the PR on the thread, the Ticket completes, and the result links the thread.
    await worker.callTool({ name: 'orchestrator_report', arguments: { state: 'ready', summary: 'Fixed the H1.', human_action: null,
      pr_url: 'https://github.com/acme/widgets/pull/7' } })
    expect(thread.pullRequests).toEqual(['https://github.com/acme/widgets/pull/7'])
    expect(runtime.repo.tickets.get(ticket.id)!.ended?.outcome).toBe('completed')
    const result = await until(() => runtime.outbox.list(record => record.message.text.startsWith('Done: Fixed the H1.'))[0], 'the result')
    expect(result.message.text).toContain(thread.link)
    expect(data(await consoleClient.callTool({ name: 'superagent_attention', arguments: {} })).tickets).toEqual([])

    // The ended Ticket's worker can no longer report.
    const late = await worker.callTool({ name: 'orchestrator_report', arguments: { state: 'progress', summary: 'more' } })
    expect(late.isError).toBe(true)
    await worker.close(); await consoleClient.close()
  })

  it('refuses unknown tokens and serves the panel', async () => {
    expect((await fetch(`${base}/mcp/worker/nope`, { method: 'POST', body: '{}' })).status).toBe(401)
    expect((await fetch(`${base}/mcp/console/nope`, { method: 'POST', body: '{}' })).status).toBe(401)
    expect((await fetch(`${base}/panel/nope`)).status).toBe(401)
    const page = await fetch(`${base}/panel/console-secret`)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('Needs a person')
  })

  it('stops a Ticket: its thread is interrupted and it waits for nothing more', async () => {
    runtime.engine.receive((await import('../src/app/console-source.ts')).consoleTrigger('hector', 'Rename the widget module'))
    const thread = await until(() => t3.workerThreads()[0], 'the worker thread')
    const ticket = runtime.repo.tickets.list()[0]!
    const consoleClient = await mcp(`${base}/mcp/console/console-secret`)
    await consoleClient.callTool({ name: 'superagent_stop', arguments: { ticket_id: ticket.id } })
    await until(() => t3.calls.find(call => call.tool === 't3_thread_interrupt'), 'the interrupt')
    expect(t3.calls.find(call => call.tool === 't3_thread_interrupt')!.args).toMatchObject({ threadId: thread.id, stop: true })
    expect(runtime.repo.tickets.get(ticket.id)!.ended?.outcome).toBe('stopped')
    await consoleClient.close()
  })

  it('keeps to the worker limit and launches the next Ticket when a slot frees', async () => {
    const { consoleTrigger } = await import('../src/app/console-source.ts')
    for (const text of ['First task', 'Second task', 'Third task']) runtime.engine.receive(consoleTrigger('hector', text))
    await until(() => t3.workerThreads().length === 2, 'two worker threads')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(t3.workerThreads()).toHaveLength(2)
    t3.finishRun(t3.workerThreads()[0]!.id)
    await until(() => t3.workerThreads().length === 3, 'the third worker thread', 8000)
  })
})
