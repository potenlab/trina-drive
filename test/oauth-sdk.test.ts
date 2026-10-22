// Interop: the official MCP TypeScript SDK's OAuth client (the same discovery, registration choice, PKCE, resource and
// refresh logic many MCP clients use) against this server. Its fetch is routed into the web handler, so nothing leaves
// the process. With CIMD advertised it picks the URL client_id; the full flow runs with dynamic registration (the SDK
// requires an https client metadata URL, which a local fixture cannot serve).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { handleWeb } from '../src/web/server'
import { CALLBACK, ISSUER, oauthSetup, RESOURCE, type OAuthEnv } from './oauth-helpers'

let o: OAuthEnv
beforeAll(async () => { o = await oauthSetup({ dcr: true }) })
afterAll(() => o.cleanup())

const fetchFn = (url: string | URL, init?: RequestInit) => handleWeb(o.env.w, new Request(String(url), init), '10.1.1.1')

class Provider implements OAuthClientProvider {
  info?: OAuthClientInformationMixed
  saved?: OAuthTokens
  verifier = ''
  authUrl?: URL
  constructor(readonly clientMetadataUrl?: string) {}
  get redirectUrl() { return CALLBACK }
  get clientMetadata() { return { client_name: 'SDK test client', redirect_uris: [CALLBACK], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' } }
  state() { return 'sdk-state' }
  clientInformation() { return this.info }
  saveClientInformation(i: OAuthClientInformationMixed) { this.info = i }
  tokens() { return this.saved }
  saveTokens(t: OAuthTokens) { this.saved = t }
  redirectToAuthorization(u: URL) { this.authUrl = u }
  saveCodeVerifier(v: string) { this.verifier = v }
  codeVerifier() { return this.verifier }
}

describe('MCP SDK OAuth client', () => {
  test('sees CIMD support and uses its URL as client_id; sends PKCE S256 and the resource', async () => {
    const p = new Provider('https://claude.ai/oauth/claude-code-client-metadata')
    expect(await auth(p, { serverUrl: RESOURCE, fetchFn })).toBe('REDIRECT')
    const u = p.authUrl!
    expect(u.origin + u.pathname).toBe(`${ISSUER}/oauth/authorize`)
    expect(u.searchParams.get('client_id')).toBe('https://claude.ai/oauth/claude-code-client-metadata')
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
    expect(u.searchParams.get('resource')).toBe(RESOURCE)
  })

  test('full flow with dynamic registration: discovery from the 401, consent, code exchange, tools over MCP, refresh', async () => {
    const p = new Provider()
    // discovery the way a client meets this server: a 401 that names the resource metadata
    const first = await fetchFn(RESOURCE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' })
    expect(first.status).toBe(401)
    const rm = /resource_metadata="([^"]+)"/.exec(first.headers.get('www-authenticate')!)![1]!
    expect(await auth(p, { serverUrl: RESOURCE, resourceMetadataUrl: new URL(rm), fetchFn })).toBe('REDIRECT')
    expect(p.info?.client_id).toMatch(/^dcr_/)
    // the person's side: authorize → consent page → approve
    const a = await o.http('GET', p.authUrl!.pathname + p.authUrl!.search)
    const rid = /#\/oauth\/(.+)$/.exec(a.headers.get('location')!)![1]!
    const kim = await o.env.as('kim')
    const d = await kim.call('GET', `/api/oauth/requests/${rid}`)
    expect(d.data.client).toMatchObject({ kind: 'dcr', verified: false })
    const ap = await kim.call('POST', `/api/oauth/requests/${rid}/approve`, { folders: [o.env.fid('프로젝트')] })
    const back = new URL(ap.data.redirect_to)
    expect(back.searchParams.get('iss')).toBe(ISSUER)
    expect(back.searchParams.get('state')).toBe('sdk-state')
    expect(await auth(p, { serverUrl: RESOURCE, authorizationCode: back.searchParams.get('code')!, fetchFn })).toBe('AUTHORIZED')
    expect(p.saved?.access_token).toMatch(/^shelf_oat_/)

    const client = new Client({ name: 'sdk', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(RESOURCE), { authProvider: p, fetch: fetchFn }))
    const r = await client.callTool({ name: 'bash', arguments: { command: 'ls /' } })
    const text = (r.content as { text: string }[])[0]!.text
    expect(text).toContain('프로젝트')
    expect(text).not.toContain('경영')
    await client.close()

    // with a refresh token stored, auth() refreshes (rotation: a new refresh token comes back)
    const oldRefresh = p.saved!.refresh_token
    expect(await auth(p, { serverUrl: RESOURCE, fetchFn })).toBe('AUTHORIZED')
    expect(p.saved!.refresh_token).not.toBe(oldRefresh)
  })
})
