/** `superagent connect` against a fake t3code OAuth server that checks PKCE, the redirect and the resource as t3code does. */
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connect, daysLeft, loadToken, saveToken } from '../src/t3/connect.ts'

let server: Server, origin: string
const pending = new Map<string, { challenge: string; redirect: string; resource: string; client: string }>()
const registered: unknown[] = []

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', origin)
    const body = await new Promise<string>(resolve => { let text = ''; req.on('data', chunk => { text += chunk }); req.on('end', () => resolve(text)) })
    const send = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return send(200, { issuer: origin, authorization_endpoint: `${origin}/oauth/mcp/authorize`, token_endpoint: `${origin}/oauth/mcp/token`,
        registration_endpoint: `${origin}/oauth/mcp/register`, code_challenge_methods_supported: ['S256'] })
    }
    if (url.pathname === '/oauth/mcp/register') {
      const metadata = JSON.parse(body) as { client_name: string; redirect_uris: string[] }
      registered.push(metadata)
      if (!metadata.redirect_uris.every(uri => uri.startsWith('http://127.0.0.1:'))) return send(400, { error: 'invalid_redirect_uri' })
      return send(201, { client_id: `client:${metadata.client_name}` })
    }
    if (url.pathname === '/oauth/mcp/token') {
      const form = new URLSearchParams(body)
      const entry = pending.get(form.get('code') ?? '')
      const verified = entry && createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') === entry.challenge
      if (!entry || !verified || form.get('redirect_uri') !== entry.redirect || form.get('resource') !== entry.resource
        || form.get('client_id') !== entry.client || form.get('grant_type') !== 'authorization_code') return send(400, { error: 'invalid_grant' })
      return send(200, { access_token: 'mcp-session-token', token_type: 'Bearer', expires_in: 30 * 86_400, scope: 'orchestration:read orchestration:operate' })
    }
    send(404, {})
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => { server.close() })

/** The owner approving on t3code's page: t3code redirects back with a code, the state and its issuer. */
function approve(tamper?: (query: URLSearchParams) => void) {
  return async (authorizeUrl: string) => {
    const url = new URL(authorizeUrl)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('response_type')).toBe('code')
    const code = `code-${pending.size + 1}`
    pending.set(code, { challenge: url.searchParams.get('code_challenge')!, redirect: url.searchParams.get('redirect_uri')!,
      resource: url.searchParams.get('resource')!, client: url.searchParams.get('client_id')! })
    const back = new URLSearchParams({ code, state: url.searchParams.get('state')!, iss: origin })
    tamper?.(back)
    await fetch(`${url.searchParams.get('redirect_uri')}?${back}`)
  }
}

describe('superagent connect', () => {
  it('signs in with PKCE and a loopback redirect, and saves the token privately', async () => {
    const saved = await connect({ mcpUrl: `${origin}/mcp`, open: approve() })
    expect(saved).toMatchObject({ url: `${origin}/mcp`, token: 'mcp-session-token', scope: 'orchestration:read orchestration:operate' })
    expect(Math.round(daysLeft(saved))).toBe(30)
    expect(registered.at(-1)).toMatchObject({ client_name: 'Superagent', token_endpoint_auth_method: 'none' })

    const dir = mkdtempSync(join(tmpdir(), 'token-'))
    const file = join(dir, 'state', 't3-token.json')
    try {
      await saveToken(file, saved)
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(await loadToken(file)).toEqual(saved)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('refuses an approval that comes back with another state', async () => {
    await expect(connect({ mcpUrl: `${origin}/mcp`, open: approve(query => query.set('state', 'forged')) })).rejects.toThrow(/another state/)
  })
})
