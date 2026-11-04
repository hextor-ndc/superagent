/**
 * The contract with t3code's `/mcp`: the tool names and arguments `McpT3Client` sends, the bearer token, and how a
 * returned `OrchestratorMcpFailure` becomes a `T3Error`. The fake server mirrors the tool definitions and results of t3code
 * 0.1.6 as tests/live/contract.spec.ts pins them against a real `t3 serve` (PLAN.md, ground rule 4).
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
/** Thread `long`: 2500 activity items, approval requests at some positions, of which `waiting` still wait. */
const long = { size: 2500, approvals: new Set([100, 2450]), waiting: new Set<number>() }
/** How many more `tools/call` requests of the `forgetful` token get HTTP 404, as after a t3code restart. */
let forget = 0
/** The sessions each token started (`initialize` requests); the fake keeps none, so this is how a test sees a new one. */
const sessions = new Map<string, number>()

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
  record('link_pull_request', args => ({ host: 'github.com', repository: 'acme/widgets', number: 7, url: args.url, alreadyLinked: false }))
  // Thread `blocked` waits on one approval and one question, as t3code shows them: the count on the thread, the question in
  // `t3_pending_request`, and the approval only as a waiting `approval_request` item of the activity view.
  const approvalId = 'runtime-request:provider:acpRegistry:native-request:call-1'
  record('t3_thread_read', args => {
    const thread = { threadId: args.threadId, title: 'x', status: 'running', activeRunId: 'r1', latestRunId: 'r1', worktreePath: '/w/x', branch: null,
      settled: false, archived: false, pendingRequestCount: args.threadId === 'blocked' ? 2 : args.threadId === 'long' ? long.waiting.size : 0 }
    if (args.view !== 'activity') return { thread, items: [], nextPosition: null, hasMore: false }
    if (args.threadId === 'long') {
      // As t3code pages: up to `limit` items after `afterPosition`, oldest first, contiguous from 0.
      const from = args.afterPosition === undefined ? 0 : Number(args.afterPosition) + 1
      const items = Array.from({ length: Math.max(0, Math.min(Number(args.limit), long.size - from)) }, (_, index) => from + index).map(position =>
        long.approvals.has(position)
          ? { position, itemId: `turn-item:runtime-request:call-${position}`, type: 'approval_request', status: long.waiting.has(position) ? 'waiting' : 'accepted',
            text: `approve ${position}` }
          : { position, itemId: `turn-item:tool:${position}`, type: 'tool_call', status: 'completed', text: 'ls' })
        .map(item => ({ runId: 'r1', messageId: null, createdBy: 'agent', ...item }))
      return { thread, items, nextPosition: items.at(-1)?.position ?? null, hasMore: from + items.length < long.size }
    }
    const items = [
      { position: 0, itemId: 'turn-item:message:m1', type: 'user_message', status: 'completed', text: 'go' },
      { position: 1, itemId: 'turn-item:runtime-request:old', type: 'approval_request', status: 'cancelled', text: 'echo old' },
      { position: 2, itemId: `turn-item:runtime-request:${encodeURIComponent(approvalId)}`, type: 'approval_request', status: 'waiting', text: 'echo hi' },
    ].map(item => ({ runId: 'r1', messageId: null, createdBy: 'agent', ...item }))
    // t3code sets nextPosition on the last page too; hasMore says whether another page exists.
    return args.afterPosition === undefined ? { thread, items: items.slice(0, 2), nextPosition: 1, hasMore: true }
      : { thread, items: items.slice(2), nextPosition: 2, hasMore: false }
  })
  record('t3_pending_request', args => args.action === 'list' ? { requestIds: args.threadId === 'blocked' ? ['q1'] : [] }
    : args.action === 'read' ? { requestId: args.requestId, questions: [{ id: 'choice', header: 'Fixture', question: 'Which?',
      options: [{ label: 'Strict', description: 'Strict' }] }] }
    : { sequence: 9 })
  return server
}

beforeAll(async () => {
  http = createServer(async (req, res) => {
    if (req.headers.authorization === 'Bearer expired') {
      res.writeHead(401, { 'content-type': 'application/json' })
      return void res.end(JSON.stringify({ error: 'invalid_mcp_credential', message: 'A valid T3 Code MCP credential is required.' }))
    }
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const method = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString()) as { method?: string }).method : undefined
    if (method === 'initialize') sessions.set(req.headers.authorization ?? '', (sessions.get(req.headers.authorization ?? '') ?? 0) + 1)
    // t3code's own refusal of a malformed request: a JSON-RPC error whose `error` is an object.
    if (req.headers.authorization === 'Bearer malformed') {
      res.writeHead(400, { 'content-type': 'application/json' })
      return void res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32022, message: 'Unsupported protocol version 1999-01-01.' } }))
    }
    // `nowhere` is a URL with no MCP endpoint; `gone` and `forgetful` lose their session, the way t3code answers an id it forgot.
    if (req.headers.authorization === 'Bearer nowhere' || (method === 'tools/call'
      && (req.headers.authorization === 'Bearer gone' || (req.headers.authorization === 'Bearer forgetful' && forget-- > 0)))) {
      return void res.writeHead(404).end()
    }
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
    expect(args.link_pull_request).toEqual({ threadId: 't1', url: 'https://github.com/acme/widgets/pull/7' })
  })

  it('finds pending questions through t3_pending_request and approvals in the activity view', async () => {
    const client = new McpT3Client({ url, token: 'tok' })
    calls.length = 0
    expect(await client.pendingRequests('idle')).toEqual([])
    expect(calls.map(call => call.tool)).toEqual(['t3_thread_read'])
    expect(await client.pendingRequests('blocked')).toEqual([
      { kind: 'question', requestId: 'q1', questions: [{ id: 'choice', header: 'Fixture', question: 'Which?', options: [{ label: 'Strict', description: 'Strict' }] }] },
      { kind: 'approval', requestId: 'runtime-request:provider:acpRegistry:native-request:call-1', text: 'echo hi' },
    ])
    // Two activity pages, then it stops on hasMore: false although nextPosition is set.
    expect(calls.filter(call => call.tool === 't3_thread_read' && call.args.view === 'activity').map(call => call.args.afterPosition)).toEqual([undefined, 1])
    await client.answerQuestion('blocked', 'q1', { choice: 'Strict' })
    expect(calls.at(-1)).toMatchObject({ tool: 't3_pending_request', args: { action: 'respond', threadId: 'blocked', requestId: 'q1', answers: { choice: 'Strict' } } })
    await client.close()
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

  it('reports a refused token as a lasting error, not a network one', async () => {
    const client = new McpT3Client({ url, token: 'expired' })
    const error = await client.listProjects().catch(caught => caught)
    expect(error).toMatchObject({ code: 'invalid_mcp_credential', transient: false })
  })

  it('finds the newest waiting approval on a thread longer than any page budget, and starts the next look near it', async () => {
    const client = new McpT3Client({ url, token: 'tok' })
    long.waiting = new Set([2450])
    calls.length = 0
    const activityReads = () => calls.filter(call => call.tool === 't3_thread_read' && call.args.view === 'activity').map(call => call.args.afterPosition)
    expect(await client.pendingRequests('long')).toEqual([{ kind: 'approval', requestId: 'call-2450', text: 'approve 2450' }])
    expect(activityReads()).toHaveLength(25)
    calls.length = 0
    expect(await client.pendingRequests('long')).toEqual([{ kind: 'approval', requestId: 'call-2450', text: 'approve 2450' }])
    expect(activityReads()).toEqual([2449])
    // When the scan from there finds too few, it goes back to the start.
    long.waiting = new Set([100])
    calls.length = 0
    expect(await client.pendingRequests('long')).toEqual([{ kind: 'approval', requestId: 'call-100', text: 'approve 100' }])
    expect(activityReads().slice(0, 2)).toEqual([2449, undefined])
    long.waiting = new Set()
    expect(await client.pendingRequests('long')).toEqual([])
    await client.close()
  })

  it('keeps the code of a refusal whose body carries a JSON-RPC error object a string', async () => {
    const client = new McpT3Client({ url, token: 'malformed' })
    const error = await client.listProjects().catch(caught => caught)
    expect(error).toMatchObject({ code: 'http_400', transient: false, message: expect.stringContaining('Unsupported protocol version') })
    expect(error.message).not.toContain('[object Object]')
  })

  it('retries once on a new session when t3code has forgotten the old one, and calls a second loss transient', async () => {
    const forgetful = new McpT3Client({ url, token: 'forgetful' })
    expect(await forgetful.listProjects()).toHaveLength(2)
    expect(sessions.get('Bearer forgetful')).toBe(1)
    forget = 1
    calls.length = 0
    expect(await forgetful.listProjects()).toHaveLength(2)
    expect(calls.map(call => call.args)).toEqual([{}, { cursor: 1 }])
    expect(sessions.get('Bearer forgetful')).toBe(2)
    await forgetful.close()
    const gone = new McpT3Client({ url, token: 'gone' })
    expect(await gone.listProjects().catch(caught => caught)).toMatchObject({ code: 'network', transient: true })
    // A 404 to the session's start means the URL is wrong, which retrying cannot fix.
    const nowhere = new McpT3Client({ url, token: 'nowhere' })
    expect(await nowhere.listProjects().catch(caught => caught)).toMatchObject({ code: 'http_404', transient: false })
  })

  it('reports an unreachable t3code as a transient network error', async () => {
    const client = new McpT3Client({ url: 'http://127.0.0.1:9/mcp', token: 'tok' })
    const error = await client.listProjects().catch(caught => caught)
    expect(error).toMatchObject({ code: 'network', transient: true })
  })
})
