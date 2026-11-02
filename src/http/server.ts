/**
 * This service's HTTP surface, which t3code's agents and its browser tab reach:
 * - `/mcp/worker/<ticket token>`: one Ticket's worker tools (point 1);
 * - `/mcp/console/<console token>`: the console tools and the attention app (points 2 and 3);
 * - `/panel/<console token>`: the attention view as a page, and `/panel/<token>/action` for its buttons (point 3).
 * MCP runs in stateless mode: each request gets its own server and transport, so a restart loses no MCP session.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Runtime } from '../app/runtime.ts'
import { attentionPage } from '../mcp/attention-app.ts'
import { consoleActions, consoleServer, type ConsoleAction } from '../mcp/console-tools.ts'
import { watchdogServer } from '../mcp/watchdog-tools.ts'
import { workerServer } from '../mcp/worker-tools.ts'

const MAX_BODY = 1024 * 1024

export function startHttp(runtime: Runtime, port: number, host = '127.0.0.1'): Promise<Server> {
  const server = createServer((req, res) => {
    handle(runtime, req, res).catch(error => {
      runtime.config.log(`HTTP ${req.method} ${req.url?.split('/').slice(0, 3).join('/')} failed`, error)
      if (!res.headersSent) send(res, 500, { error: 'internal error' })
      else res.end()
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve(server))
  })
}

async function handle(runtime: Runtime, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const [, area, kind, token, rest] = url.pathname.split('/')
  if (url.pathname === '/healthz') return send(res, 200, { ok: true })

  if (area === 'mcp' && kind === 'worker' && token) {
    const ticketId = runtime.executor.ticketOfToken(token)
    if (!ticketId) return send(res, 401, { error: 'unknown worker token' })
    return serveMcp(workerServer(runtime, ticketId), req, res)
  }
  if (area === 'mcp' && kind === 'console' && token) {
    if (!same(token, runtime.config.consoleToken)) return send(res, 401, { error: 'unknown console token' })
    return serveMcp(consoleServer(runtime), req, res)
  }
  if (area === 'mcp' && kind === 'watchdog' && token) {
    if (!same(token, runtime.watchdogToken())) return send(res, 401, { error: 'unknown watchdog token' })
    return serveMcp(watchdogServer(runtime), req, res)
  }
  if (area === 'panel' && kind) {
    if (!same(kind, runtime.config.consoleToken)) return send(res, 401, { error: 'unknown console token' })
    if (!token && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      return void res.end(attentionPage('panel', `/panel/${kind}`))
    }
    if (token === 'action' && req.method === 'POST' && rest === undefined) {
      const body = await readJson(req) as { name?: string; arguments?: Record<string, unknown> }
      const actions = consoleActions(runtime) as Record<string, (args: never) => unknown>
      const action = body.name && Object.hasOwn(actions, body.name) ? actions[body.name as ConsoleAction] : undefined
      if (!action) return send(res, 404, { error: 'unknown action' })
      try { return send(res, 200, action((body.arguments ?? {}) as never)) }
      catch (error) { return send(res, 400, { error: error instanceof Error ? error.message : String(error) }) }
    }
  }
  send(res, 404, { error: 'not found' })
}

async function serveMcp(server: McpServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') return send(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null })
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  res.on('close', () => { void transport.close(); void server.close() })
  await server.connect(transport)
  await transport.handleRequest(req, res, await readJson(req))
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) throw new Error('request body too large')
    chunks.push(chunk as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : undefined
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
function same(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}
