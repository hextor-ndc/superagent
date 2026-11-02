/**
 * Point 5: sign the super agent in to t3code once, as an outside agent, through t3code's documented OAuth flow
 * (docs/user/outside-agents.md, docs/internals/environment-auth.md): discovery, dynamic registration of a public client,
 * PKCE with S256, and a loopback redirect. The owner approves on t3code's page with a pairing code and picks the access,
 * a runtime-mode ceiling that t3code then enforces on every thread the super agent starts.
 *
 * t3code issues no refresh token: the session lasts 30 days, so `connect` runs again before it expires.
 */
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'

const Metadata = z.looseObject({ issuer: z.string(), authorization_endpoint: z.string(), token_endpoint: z.string(), registration_endpoint: z.string() })
const Registered = z.looseObject({ client_id: z.string() })
const Token = z.looseObject({ access_token: z.string(), token_type: z.string(), expires_in: z.number(), scope: z.string().optional() })

export interface SavedToken { url: string; token: string; expiresAt: string; scope?: string }

const b64url = (bytes: Buffer) => bytes.toString('base64url')

export interface ConnectOptions {
  /** The environment's MCP URL, such as `http://127.0.0.1:3773/mcp`. */
  mcpUrl: string
  /** Shows the operator the page to approve on; the default prints it. */
  open?: (url: string) => void | Promise<void>
  /** How long to wait for the approval. */
  timeoutMs?: number
  fetch?: typeof fetch
}

export async function connect(options: ConnectOptions): Promise<SavedToken> {
  const http = options.fetch ?? fetch
  const resource = new URL(options.mcpUrl)
  const origin = resource.origin
  const json = async <S extends z.ZodType>(schema: S, response: Response): Promise<z.infer<S>> => {
    const body = await response.text()
    if (!response.ok) throw new Error(`${response.url}: HTTP ${response.status} ${body.slice(0, 300)}`)
    return schema.parse(JSON.parse(body))
  }
  const metadata = await json(Metadata, await http(`${origin}/.well-known/oauth-authorization-server`))

  // The loopback redirect: t3code accepts http on 127.0.0.1 for agents on the operator's own machine.
  let resolve!: (query: URLSearchParams) => void, reject!: (error: Error) => void
  const callback = new Promise<URLSearchParams>((ok, fail) => { resolve = ok; reject = fail })
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/callback') { res.writeHead(404).end(); return }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><title>Superagent</title><p>The superagent is signed in to T3 Code. You can close this tab.</p>')
    resolve(url.searchParams)
  })
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok))
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`
  const timer = setTimeout(() => reject(new Error('Timed out waiting for the approval in T3 Code')), options.timeoutMs ?? 10 * 60_000)

  try {
    const client = await json(Registered, await http(metadata.registration_endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Superagent', redirect_uris: [redirectUri], grant_types: ['authorization_code'],
        response_types: ['code'], token_endpoint_auth_method: 'none' }),
    }))
    const verifier = b64url(randomBytes(32))
    const state = b64url(randomBytes(16))
    const authorize = new URL(metadata.authorization_endpoint)
    for (const [name, value] of Object.entries({ response_type: 'code', client_id: client.client_id, redirect_uri: redirectUri,
      code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', state, resource: resource.href })) {
      authorize.searchParams.set(name, value)
    }
    await (options.open ?? (url => { console.error(`Open this page and approve the superagent with a pairing code from T3 Code:\n\n  ${url}\n`) }))(authorize.href)

    const query = await callback
    if (query.get('error')) throw new Error(`T3 Code did not approve: ${query.get('error')} ${query.get('error_description') ?? ''}`.trim())
    if (query.get('state') !== state) throw new Error('The approval came back with another state; start again')
    const issuer = query.get('iss')
    if (issuer && issuer !== metadata.issuer) throw new Error(`The approval came from ${issuer}, not ${metadata.issuer}`)
    const code = query.get('code')
    if (!code) throw new Error('The approval came back without a code')

    const token = await json(Token, await http(metadata.token_endpoint, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: client.client_id,
        code_verifier: verifier, resource: resource.href }),
    }))
    return { url: resource.href, token: token.access_token, expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
      ...token.scope ? { scope: token.scope } : {} }
  } finally {
    clearTimeout(timer)
    server.close()
  }
}

export async function saveToken(path: string, token: SavedToken): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 })
  await chmod(path, 0o600)
}
export async function loadToken(path: string): Promise<SavedToken | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) as SavedToken } catch { return undefined }
}
/** Days left before a saved token expires; negative once it has. */
export const daysLeft = (token: SavedToken, now = Date.now()): number => (Date.parse(token.expiresAt) - now) / 86_400_000
