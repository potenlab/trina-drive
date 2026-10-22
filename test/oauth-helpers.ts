// OAuth test kit: the web demo (web-helpers) with the authorization server switched on, a local Client ID Metadata
// Document server standing in for claude.ai / chatgpt.com (plain http on 127.0.0.1, reached through an injected SSRF
// guard that allows only that address for the test host name), a clock the tests can move, and a fake OAuth client
// that runs authorize → consent → token → /mcp the way claude.ai does.
import crypto from 'node:crypto'
import { makeOAuthRuntime, type OAuthOptions } from '../src/oauth'
import type { FetchGuard } from '../src/oauth/ssrf'
import { handleWeb } from '../src/web/server'
import { ORIGIN, webSetup } from './web-helpers'

export const ISSUER = 'https://files.example.test'
export const RESOURCE = `${ISSUER}/mcp`
export const CALLBACK = 'https://app.client.test/callback'

type Handler = (req: Request) => Response | Promise<Response>

/** A local "internet" for client metadata: path -> handler, with hit counts. */
export function metadataFixture() {
  const routes = new Map<string, Handler>()
  const hits = new Map<string, number>()
  const server = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    fetch: (req) => {
      const p = new URL(req.url).pathname
      hits.set(p, (hits.get(p) ?? 0) + 1)
      const h = routes.get(p)
      return h ? h(req) : new Response('not found', { status: 404 })
    },
  })
  const base = (host = 'client.test') => `http://${host}:${server.port}`
  const json = (body: unknown, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', ...headers } })
  return { server, routes, hits, base, json, stop: () => server.stop(true) }
}
export type Fixture = ReturnType<typeof metadataFixture>

/** The test guard: http allowed, client.test (and *.client.test) resolve to 127.0.0.1, only 127.0.0.1 may be reached. */
export function testGuard(extra: Partial<FetchGuard> = {}): Partial<FetchGuard> {
  return {
    allowHttp: true,
    resolve: async (h) => (h === 'client.test' || h.endsWith('.client.test') ? [{ address: '127.0.0.1', family: 4 }] : []),
    allowAddress: (ip) => ip === '127.0.0.1',
    ...extra,
  }
}

export const pkce = () => {
  const verifier = crypto.randomBytes(48).toString('base64url')
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') }
}

export async function oauthSetup(o: Partial<OAuthOptions> = {}) {
  const env = await webSetup()
  const fx = metadataFixture()
  const clientId = `${fx.base()}/client.json`
  fx.routes.set('/client.json', fx.json({ client_id: clientId, client_name: 'Test Agent', redirect_uris: [CALLBACK, 'http://127.0.0.1/cb'], token_endpoint_auth_method: 'none' }))
  const clock = { offset: 0 }
  const now = () => Date.now() + clock.offset
  const runtime = (extra: Partial<OAuthOptions> = {}) => makeOAuthRuntime({ issuer: ISSUER, clientHosts: ['client.test'], guard: testGuard(), now, ...o, ...extra }, env.db)
  env.w.oauth = runtime()

  /** A request straight into the web handler (no cookies), from address `addr`. */
  const http = (method: string, path: string, init: { headers?: Record<string, string>; body?: string } = {}, addr = '10.0.0.9') =>
    handleWeb(env.w, new Request((path.startsWith('http') ? '' : ORIGIN) + path, { method, headers: init.headers, body: init.body }), addr)

  const authorizeUrl = (p: Record<string, string | undefined>) => {
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries(p)) if (v !== undefined) q.set(k, v)
    return `/oauth/authorize?${q}`
  }
  const defaults = (challenge: string, extra: Record<string, string | undefined> = {}) => ({
    response_type: 'code', client_id: clientId, redirect_uri: CALLBACK, state: 'st-' + crypto.randomBytes(4).toString('hex'),
    code_challenge: challenge, code_challenge_method: 'S256', resource: RESOURCE, scope: 'files:read drafts:write', ...extra,
  })

  /** Start an authorization: returns the consent request id (from the #/oauth/<id> redirect). */
  async function startAuth(challenge: string, extra: Record<string, string | undefined> = {}) {
    const params = defaults(challenge, extra)
    const res = await http('GET', authorizeUrl(params))
    const loc = res.headers.get('location') ?? ''
    const m = /#\/oauth\/([A-Za-z0-9_-]+)$/.exec(loc)
    return { res, loc, rid: m?.[1] ?? null, params }
  }

  const tokenReq = (form: Record<string, string | undefined>, headers: Record<string, string> = {}) => {
    const f = new URLSearchParams()
    for (const [k, v] of Object.entries(form)) if (v !== undefined) f.set(k, v)
    return http('POST', '/oauth/token', { headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: f.toString() })
  }

  /**
   * The whole connection the way claude.ai does it: authorize, the person signs in and approves on the consent page,
   * the client exchanges the code with its PKCE verifier. `folders` are folder names (top level) or 'all'.
   */
  async function connect(who: string, opts: { folders?: string[] | 'all'; readOnly?: boolean; ttl?: string; scope?: string; redirectUri?: string } = {}) {
    const { verifier, challenge } = pkce()
    const a = await startAuth(challenge, { scope: opts.scope ?? 'files:read drafts:write', redirect_uri: opts.redirectUri ?? CALLBACK })
    if (!a.rid) throw new Error(`authorize did not reach consent: ${a.res.status} ${a.loc} ${await a.res.text()}`)
    const browser = await env.as(who)
    const details = await browser.call('GET', `/api/oauth/requests/${a.rid}`)
    if (details.status !== 200) throw new Error(`consent details: ${details.status} ${JSON.stringify(details.data)}`)
    const folders = opts.folders === 'all' ? undefined : (opts.folders ?? ['프로젝트']).map((n) => env.fid(n))
    const approve = await browser.call('POST', `/api/oauth/requests/${a.rid}/approve`, { ...(opts.folders === 'all' ? { all: true } : { folders }), read_only: opts.readOnly ?? true, ttl: opts.ttl ?? '30d' })
    if (approve.status !== 200) throw new Error(`approve: ${approve.status} ${JSON.stringify(approve.data)}`)
    const back = new URL(approve.data.redirect_to as string)
    const tok = await tokenReq({ grant_type: 'authorization_code', code: back.searchParams.get('code')!, redirect_uri: a.params.redirect_uri, client_id: clientId, code_verifier: verifier, resource: RESOURCE })
    const tokens = await tok.json() as { access_token: string; refresh_token: string; expires_in: number; scope: string; token_type: string }
    if (tok.status !== 200) throw new Error(`token: ${tok.status} ${JSON.stringify(tokens)}`)
    return { tokens, details: details.data, back, state: a.params.state, browser, verifier }
  }

  /** One MCP call (tools/call bash) with a bearer token. */
  async function mcpBash(bearer: string, command: string) {
    const res = await http('POST', '/mcp', {
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bash', arguments: { command } } }),
    })
    const text = await res.text()
    let data: any = null
    try { data = JSON.parse(text) } catch { data = text }
    const out = data?.result?.content?.map((c: { text: string }) => c.text).join('\n') ?? ''
    return { status: res.status, data, out, headers: res.headers }
  }

  const cleanup = () => { fx.stop(); env.cleanup() }
  return { env, fx, clientId, clock, now, runtime, http, authorizeUrl, startAuth, tokenReq, connect, mcpBash, cleanup }
}
export type OAuthEnv = Awaited<ReturnType<typeof oauthSetup>>
