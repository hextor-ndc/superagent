/**
 * The contract with t3code's `/mcp`: the tool names and arguments `McpT3Client` sends, the bearer token, and how a
 * returned `OrchestratorMcpFailure` becomes a `T3Error`. The fake server mirrors the tool definitions in t3code's
 * apps/server/src/mcp/toolkits; a live check against a real `t3 serve` belongs in tests/t3-contract (PLAN.md, ground rule 4).
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { McpT3Client, T3Error } from '../src/t3/client.ts'

const calls: { tool: string; args: Record<string, unknown>; auth?: string }[] = []
let http: Server, url: string

function fakeT3(auth: string | undefined): McpServer {
  const server = new McpServer({ name: 't3-code', version: 'test' })
  const record = (tool: string, result: (args: Record<string, unknown>) => Record<string, unknown>) =>
    server.registerTool(tool, { inputSchema: z.object({}).passthrough() }, async args => {
      calls.push({ tool, args, auth })
      if (args.threadId === 'missing') {
        const failure = { _tag: 'OrchestratorMcpFailure', code: 'thread_not_found', message: 'No such thread.' }
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(failure) }], structuredContent: failure }
      }
      const value = result(args)
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }
    })
  record('t3_project_list', args => args.cursor === 1
    ? { projects: [{ id: 'p2', title: 'gadgets', workspaceRoot: '/src/gadgets' }], nextCursor: null }
    : { projects: [{ id: 'p1', title: 'widgets', workspaceRoot: '/src/widgets' }], nextCursor: 1 })
  record('t3_thread_launch', () => ({ threadId: 't1', link: 'https://app.t3.codes/t/t1', projectId: 'p1', modelSelection: {}, runId: 'r1', status: 'running' }))
  record('t3_thread_send', () => ({ threadId: 't1', messageId: 'm2', runId: 'r1', status: 'running', delivery: 'steered' }))
  record('t3_thread_wait', () => ({ threadId: 't1', runId: 'r1', status: 'completed', timedOut: false }))
  record('t3_thread_interrupt', () => ({ threadId: 't1' }))
  record('t3_thread_organize', () => ({ sequence: 1 }))
  record('link_pull_requests', () => ({ linked: [] }))
  return server
}

beforeAll(async () => {
  http = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const server = fakeT3(req.headers.authorization)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => { void transport.close(); void server.close() })
    await server.connect(transport)
    await transport.handleRequest(req, res, chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined)
  })
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`
})
afterAll(() => { http.close() })

describe('McpT3Client', () => {
  it('calls t3code tools with the documented arguments and the bearer token', async () => {
    const client = new McpT3Client({ url, token: 'tok' })
    expect(await client.listProjects()).toEqual([{ id: 'p1', title: 'widgets', workspaceRoot: '/src/widgets' },
      { id: 'p2', title: 'gadgets', workspaceRoot: '/src/gadgets' }])
    expect(await client.launch({ projectId: 'p1', title: '[T-1] x', message: 'go', worktreePath: '/w/x', branch: 'agent/x',
      clientRequestId: 'launch:a1', runtimeMode: 'full-access' })).toMatchObject({ threadId: 't1', link: 'https://app.t3.codes/t/t1' })
    expect(await client.send('t1', 'more', 'deliver:a1:i1')).toMatchObject({ delivery: 'steered' })
    expect(await client.wait('t1', 30_000)).toMatchObject({ status: 'completed', timedOut: false })
    await client.interrupt('t1', { stop: true, reason: 'stopped', clientRequestId: 'stop:a1' })
    await client.organize('t1', 'pin')
    await client.linkPullRequests('t1', ['https://github.com/acme/widgets/pull/7'])
    await client.close()

    expect(calls.every(call => call.auth === 'Bearer tok')).toBe(true)
    expect(calls.filter(call => call.tool === 't3_project_list').map(call => call.args)).toEqual([{}, { cursor: 1 }])
    const args = Object.fromEntries(calls.map(call => [call.tool, call.args]))
    expect(args.t3_thread_launch).toEqual({ projectId: 'p1', title: '[T-1] x', message: 'go', clientRequestId: 'launch:a1',
      workspaceStrategy: { type: 'existing_worktree', worktreePath: '/w/x', branch: 'agent/x' }, runtimeMode: 'full-access' })
    expect(args.t3_thread_send).toEqual({ threadId: 't1', message: 'more', clientRequestId: 'deliver:a1:i1', mode: 'auto' })
    expect(args.t3_thread_wait).toEqual({ threadId: 't1', timeoutMs: 30_000 })
    expect(args.t3_thread_interrupt).toEqual({ threadId: 't1', stop: true, reason: 'stopped', clientRequestId: 'stop:a1' })
    expect(args.t3_thread_organize).toEqual({ threadId: 't1', action: 'pin' })
    expect(args.link_pull_requests).toEqual({ threadId: 't1', urls: ['https://github.com/acme/widgets/pull/7'] })
  })

  it('sends the configured model with every launch', async () => {
    const client = new McpT3Client({ url, token: 'tok', modelSelection: { instanceId: 'codex', model: 'gpt-6-astra' } })
    calls.length = 0
    await client.launch({ projectId: 'p1', title: '[T-2] y', message: 'go', worktreePath: '/w/y', clientRequestId: 'launch:a2' })
    await client.launchScratch({ title: 'Superagent', clientRequestId: 'console' })
    await client.close()
    expect(calls.map(call => call.args.modelSelection)).toEqual([{ instanceId: 'codex', model: 'gpt-6-astra' }, { instanceId: 'codex', model: 'gpt-6-astra' }])
  })

  it('turns a returned failure into a T3Error with its code', async () => {
    const client = new McpT3Client({ url, token: 'tok' })
    const error = await client.wait('missing', 10).catch(caught => caught)
    expect(error).toBeInstanceOf(T3Error)
    expect(error).toMatchObject({ code: 'thread_not_found', transient: false })
    await client.close()
  })

  it('reports an unreachable t3code as a transient network error', async () => {
    const client = new McpT3Client({ url: 'http://127.0.0.1:9/mcp', token: 'tok' })
    const error = await client.listProjects().catch(caught => caught)
    expect(error).toMatchObject({ code: 'network', transient: true })
  })
})
