// OAuth 2.1 authorization server end to end (plan 5.2; MCP authorization 2025-11-25 / 2026-07-28): metadata, the
// authorization code + PKCE flow through the consent page with a fake client whose metadata document a local server
// hosts, refresh rotation and reuse detection, revocation reaching the next call, RFC 8707 audience, and OAuth grants
// obeying the same permission decisions as personal access tokens.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { setFlag } from '../src/store'
import { sha256 } from '../src/store'
import { CALLBACK, ISSUER, oauthSetup, pkce, RESOURCE, type OAuthEnv } from './oauth-helpers'

let o: OAuthEnv
beforeAll(async () => { o = await oauthSetup() })
afterAll(() => o.cleanup())

const challengeOf = (h: Headers) => h.get('www-authenticate') ?? ''

describe('discovery', () => {
  test('protected resource metadata (RFC 9728) at the path-specific and root locations', async () => {
    for (const p of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
      const r = await o.http('GET', p)
      expect(r.status).toBe(200)
      const m = await r.json() as Record<string, unknown>
      expect(m.resource).toBe(RESOURCE)
      expect(m.authorization_servers).toEqual([ISSUER])
      expect(m.scopes_supported).toEqual(['files:read', 'drafts:write'])
      expect(m.scopes_supported).not.toContain('offline_access') // MCP 2026-07-28: not a resource requirement
    }
  })

  test('authorization server metadata (RFC 8414): S256, public clients, CIMD, RFC 9207 iss; no registration by default', async () => {
    const r = await o.http('GET', '/.well-known/oauth-authorization-server')
    expect(r.status).toBe(200)
    const m = await r.json() as Record<string, unknown>
    expect(m).toMatchObject({
      issuer: ISSUER, authorization_endpoint: `${ISSUER}/oauth/authorize`, token_endpoint: `${ISSUER}/oauth/token`, revocation_endpoint: `${ISSUER}/oauth/revoke`,
      code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'], client_id_metadata_document_supported: true, authorization_response_iss_parameter_supported: true,
    })
    expect(m.registration_endpoint).toBeUndefined()
    expect((await o.http('GET', '/.well-known/openid-configuration')).status).toBe(404)
  })

  test('/mcp without a token: 401 with resource_metadata and no error code; with a wrong one: error="invalid_token"', async () => {
    const none = await o.http('POST', '/mcp', { headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' })
    expect(none.status).toBe(401)
    expect(challengeOf(none.headers)).toBe(`Bearer realm="shelf", resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp"`)
    const bad = await o.mcpBash('shelf_oat_nope', 'ls /')
    expect(bad.status).toBe(401)
    expect(challengeOf(bad.headers)).toContain('error="invalid_token"')
    expect(challengeOf(bad.headers)).toContain('resource_metadata=')
  })
})

describe('authorization code + PKCE through the consent page', () => {
  test('kim connects read-only to 프로젝트; the consent page shows the domain, the redirect host and only folders kim reads', async () => {
    const c = await o.connect('kim', { folders: ['프로젝트'] })
    expect(c.details.client).toMatchObject({ name: 'Test Agent', domain: 'client.test', verified: true, kind: 'cimd', redirect_host: 'app.client.test', loopback_only: false })
    expect(c.details.can_write).toBe(true)
    const names = (c.details.folders as { vpath: string }[]).map((f) => f.vpath)
    expect(names).toContain('/프로젝트')
    expect(names).not.toContain('/경영')
    // RFC 9207 iss and the client's state come back on the redirect
    expect(c.back.origin + c.back.pathname).toBe(CALLBACK)
    expect(c.back.searchParams.get('iss')).toBe(ISSUER)
    expect(c.back.searchParams.get('state')).toBe(c.state)
    expect(c.tokens).toMatchObject({ token_type: 'Bearer', scope: 'files:read', expires_in: 3600 })
    expect(c.tokens.access_token.startsWith('shelf_oat_')).toBe(true)
    expect(c.tokens.refresh_token.startsWith('shelf_ort_')).toBe(true)

    const ls = await o.mcpBash(c.tokens.access_token, 'ls /')
    expect(ls.status).toBe(200)
    expect(ls.out).toContain('프로젝트')
    expect(ls.out).not.toContain('공용') // not granted on the consent page
    expect(ls.out).not.toContain('경영')
    const w = await o.mcpBash(c.tokens.access_token, 'echo hi > /drafts/x.md')
    expect(w.out).toMatch(/read-only/i)

    // stored hashed only
    const raw = o.env.db.query<{ n: number }, [string]>('SELECT count(*) AS n FROM oauth_tokens WHERE hash = ?').get(sha256(c.tokens.access_token))!.n
    expect(raw).toBe(1)
    expect(JSON.stringify(o.env.db.query('SELECT * FROM oauth_tokens').all())).not.toContain(c.tokens.access_token)

    // the connection list shows it as an OAuth connection with its client
    const list = await c.browser.call('GET', '/api/tokens')
    const row = (list.data.tokens as { kind: string; client: { domain: string } | null; read_only: boolean }[]).find((t) => t.kind === 'oauth')
    expect(row).toMatchObject({ kind: 'oauth', read_only: true, client: { domain: 'client.test', name: 'Test Agent', verified: true } })
  })

  test('drafts:write granted only when the person unticks read-only, and only if the client asked for it', async () => {
    const rw = await o.connect('kim', { folders: ['프로젝트'], readOnly: false })
    expect(rw.tokens.scope).toBe('files:read drafts:write')
    expect((await o.mcpBash(rw.tokens.access_token, 'echo hi > /drafts/oauth.md && cat /drafts/oauth.md')).out).toContain('hi')
    const ro = await o.connect('kim', { folders: ['프로젝트'], readOnly: false, scope: 'files:read' })
    expect(ro.details.can_write).toBe(false)
    expect(ro.tokens.scope).toBe('files:read')
  })

  test('loopback redirect URIs match with any port (Claude Code), other unregistered redirects get an error page, never a redirect', async () => {
    const c = await o.connect('kim', { redirectUri: 'http://127.0.0.1:53111/cb' })
    expect(c.back.host).toBe('127.0.0.1:53111')
    const { challenge } = pkce()
    for (const ru of ['https://evil.example/callback', 'http://127.0.0.1:53111/other', 'https://app.client.test/callback/../x']) {
      const a = await o.startAuth(challenge, { redirect_uri: ru })
      expect(a.res.status).toBe(400)
      expect(a.res.headers.get('location')).toBeNull()
    }
  })

  test('PKCE: S256 required at authorize; a wrong verifier is refused at the token endpoint', async () => {
    const { challenge } = pkce()
    for (const extra of [{ code_challenge_method: 'plain' }, { code_challenge: undefined }, { code_challenge_method: undefined }, { code_challenge: 'short' }]) {
      const a = await o.startAuth(challenge, extra)
      expect(a.res.status).toBe(302)
      const u = new URL(a.loc)
      expect(u.origin + u.pathname).toBe(CALLBACK)
      expect(u.searchParams.get('error')).toBe('invalid_request')
      expect(u.searchParams.get('iss')).toBe(ISSUER)
    }
    const p = pkce()
    const a = await o.startAuth(p.challenge)
    const b = await o.env.as('kim')
    const ap = await b.call('POST', `/api/oauth/requests/${a.rid}/approve`, { folders: [o.env.fid('프로젝트')] })
    const code = new URL(ap.data.redirect_to).searchParams.get('code')!
    const bad = await o.tokenReq({ grant_type: 'authorization_code', code, redirect_uri: CALLBACK, client_id: o.clientId, code_verifier: pkce().verifier, resource: RESOURCE })
    expect(bad.status).toBe(400)
    expect((await bad.json() as { error: string }).error).toBe('invalid_grant')
  })

  test('a code works once; using it again revokes what the first use made', async () => {
    const p = pkce()
    const a = await o.startAuth(p.challenge)
    const b = await o.env.as('kim')
    const ap = await b.call('POST', `/api/oauth/requests/${a.rid}/approve`, { folders: [o.env.fid('프로젝트')] })
    const code = new URL(ap.data.redirect_to).searchParams.get('code')!
    const form = { grant_type: 'authorization_code', code, redirect_uri: CALLBACK, client_id: o.clientId, code_verifier: p.verifier, resource: RESOURCE }
    const first = await (await o.tokenReq(form)).json() as { access_token: string }
    expect((await o.mcpBash(first.access_token, 'ls /')).status).toBe(200)
    const again = await o.tokenReq(form)
    expect(again.status).toBe(400)
    expect((await o.mcpBash(first.access_token, 'ls /')).status).toBe(401)
  })

  test('the code is bound to client, redirect_uri and resource', async () => {
    for (const change of [{ client_id: 'http://client.test:1/other.json' }, { redirect_uri: 'http://127.0.0.1:9/cb' }, { resource: 'https://other.example/mcp' }]) {
      const p = pkce()
      const a = await o.startAuth(p.challenge)
      const b = await o.env.as('kim')
      const ap = await b.call('POST', `/api/oauth/requests/${a.rid}/approve`, { folders: [o.env.fid('프로젝트')] })
      const code = new URL(ap.data.redirect_to).searchParams.get('code')!
      const r = await o.tokenReq({ grant_type: 'authorization_code', code, redirect_uri: CALLBACK, client_id: o.clientId, code_verifier: p.verifier, resource: RESOURCE, ...change })
      expect(r.status).toBe(400)
    }
  })

  test('a client secret is refused (public clients only); the token endpoint takes form bodies only', async () => {
    expect((await o.tokenReq({ grant_type: 'authorization_code', code: 'x', client_id: o.clientId, client_secret: 's' })).status).toBe(401)
    const j = await o.http('POST', '/oauth/token', { headers: { 'content-type': 'application/json' }, body: '{"grant_type":"refresh_token"}' })
    expect(j.status).toBe(400)
  })

  test('deny goes back with access_denied, state and iss; a request is decided once', async () => {
    const a = await o.startAuth(pkce().challenge)
    const b = await o.env.as('kim')
    const d = await b.call('POST', `/api/oauth/requests/${a.rid}/deny`)
    const u = new URL(d.data.redirect_to)
    expect(u.searchParams.get('error')).toBe('access_denied')
    expect(u.searchParams.get('state')).toBe(a.params.state)
    expect(u.searchParams.get('iss')).toBe(ISSUER)
    expect((await b.call('POST', `/api/oauth/requests/${a.rid}/approve`, { folders: [o.env.fid('프로젝트')] })).status).toBe(404)
    expect((await b.call('GET', `/api/oauth/requests/${a.rid}`)).status).toBe(404)
  })

  test('consent needs a signed-in person, the CSRF token and a same-origin Origin', async () => {
    const a = await o.startAuth(pkce().challenge)
    expect((await o.http('GET', `/api/oauth/requests/${a.rid}`)).status).toBe(401)
    const b = await o.env.as('kim')
    expect((await b.call('POST', `/api/oauth/requests/${a.rid}/approve`, { folders: [o.env.fid('프로젝트')] }, { 'x-csrf-token': 'wrong' })).status).toBe(403)
    expect((await b.call('POST', `/api/oauth/requests/${a.rid}/approve`, { folders: [o.env.fid('프로젝트')] }, { origin: 'https://evil.example' })).status).toBe(403)
    // still undecided after the refusals
    expect((await b.call('GET', `/api/oauth/requests/${a.rid}`)).status).toBe(200)
  })

  test('folders: only ones the person\'s AI reads; admins must pick (no "all folders")', async () => {
    const a = await o.startAuth(pkce().challenge)
    const kim = await o.env.as('kim')
    expect((await kim.call('POST', `/api/oauth/requests/${a.rid}/approve`, { folders: [o.env.fid('경영')] })).status).toBe(400)
    expect((await kim.call('POST', `/api/oauth/requests/${a.rid}/approve`, { folders: [] })).status).toBe(400)
    const b = await o.startAuth(pkce().challenge)
    const dion = await o.env.as('dion')
    const r = await dion.call('POST', `/api/oauth/requests/${b.rid}/approve`, { all: true })
    expect(r.status).toBe(400)
    expect(r.data.error).toBe('pick_folders')
    expect((await dion.call('POST', `/api/oauth/requests/${b.rid}/approve`, { folders: [o.env.fid('공용')] })).status).toBe(200)
  })

  test('resource (RFC 8707) other than this server\'s /mcp is refused at authorize', async () => {
    const a = await o.startAuth(pkce().challenge, { resource: 'https://other.example/mcp' })
    expect(new URL(a.loc).searchParams.get('error')).toBe('invalid_target')
    // upper-case scheme/host and a trailing slash are the same resource
    const b = await o.startAuth(pkce().challenge, { resource: 'HTTPS://FILES.example.test/mcp/' })
    expect(b.rid).not.toBeNull()
  })
})

describe('refresh, revocation, expiry, audience', () => {
  test('refresh rotates; a spent refresh token reused after the grace window revokes the whole grant', async () => {
    const c = await o.connect('kim')
    const r1 = await (await o.tokenReq({ grant_type: 'refresh_token', refresh_token: c.tokens.refresh_token, client_id: o.clientId, resource: RESOURCE })).json() as { access_token: string; refresh_token: string; scope: string }
    expect(r1.refresh_token).not.toBe(c.tokens.refresh_token)
    expect(r1.scope).toBe('files:read')
    expect((await o.mcpBash(r1.access_token, 'ls /')).status).toBe(200)
    // a second refresh with the spent token at once (racing): refused, the grant stays
    const race = await o.tokenReq({ grant_type: 'refresh_token', refresh_token: c.tokens.refresh_token, client_id: o.clientId })
    expect(race.status).toBe(400)
    expect((await o.mcpBash(r1.access_token, 'ls /')).status).toBe(200)
    // later: reuse = two parties hold it → revoke the family
    o.clock.offset += 60_000
    try {
      const reuse = await o.tokenReq({ grant_type: 'refresh_token', refresh_token: c.tokens.refresh_token, client_id: o.clientId })
      expect(reuse.status).toBe(400)
      expect((await reuse.json() as { error: string }).error).toBe('invalid_grant')
      expect((await o.mcpBash(r1.access_token, 'ls /')).status).toBe(401)
      expect((await o.tokenReq({ grant_type: 'refresh_token', refresh_token: r1.refresh_token, client_id: o.clientId })).status).toBe(400)
    } finally { o.clock.offset -= 60_000 }
  })

  test('refresh is bound to its client and cannot widen scope', async () => {
    const c = await o.connect('kim')
    expect((await o.tokenReq({ grant_type: 'refresh_token', refresh_token: c.tokens.refresh_token, client_id: 'http://client.test:1/x.json' })).status).toBe(400)
    expect((await o.tokenReq({ grant_type: 'refresh_token', refresh_token: c.tokens.refresh_token, client_id: o.clientId, scope: 'files:read drafts:write' })).status).toBe(400)
    // missing client_id: refused too (public clients identify themselves)
    expect((await o.tokenReq({ grant_type: 'refresh_token', refresh_token: c.tokens.refresh_token })).status).toBe(400)
  })

  test('revoking the connection on the web stops the very next MCP call and every refresh', async () => {
    const c = await o.connect('kim')
    expect((await o.mcpBash(c.tokens.access_token, 'ls /')).status).toBe(200)
    const list = await c.browser.call('GET', '/api/tokens')
    const id = (list.data.tokens as { id: number; kind: string; status: string }[]).find((t) => t.kind === 'oauth' && t.status === 'active')!.id
    expect((await c.browser.call('DELETE', `/api/tokens/${id}`)).status).toBe(200)
    expect((await o.mcpBash(c.tokens.access_token, 'ls /')).status).toBe(401)
    expect((await o.tokenReq({ grant_type: 'refresh_token', refresh_token: c.tokens.refresh_token, client_id: o.clientId })).status).toBe(400)
  })

  test('RFC 7009: revoking an access token cuts that token; revoking the refresh token cuts the grant', async () => {
    const c = await o.connect('kim')
    const rev = (token: string) => o.http('POST', '/oauth/revoke', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token, client_id: o.clientId }).toString() })
    expect((await rev(c.tokens.access_token)).status).toBe(200)
    expect((await o.mcpBash(c.tokens.access_token, 'ls /')).status).toBe(401)
    const r = await (await o.tokenReq({ grant_type: 'refresh_token', refresh_token: c.tokens.refresh_token, client_id: o.clientId })).json() as { access_token: string; refresh_token: string }
    expect((await o.mcpBash(r.access_token, 'ls /')).status).toBe(200)
    expect((await rev(r.refresh_token)).status).toBe(200)
    expect((await o.mcpBash(r.access_token, 'ls /')).status).toBe(401)
    expect((await rev('unknown-token')).status).toBe(200)
  })

  test('access tokens expire after an hour; deactivating the person cuts them', async () => {
    const c = await o.connect('kim')
    o.clock.offset += 3600_000 + 1000
    try { expect((await o.mcpBash(c.tokens.access_token, 'ls /')).status).toBe(401) } finally { o.clock.offset -= 3600_000 + 1000 }
    const d = await o.connect('park', { folders: ['공용'] })
    expect((await o.mcpBash(d.tokens.access_token, 'ls /')).status).toBe(200)
    o.env.db.query('UPDATE people SET active = 0 WHERE name = ?').run('park')
    try { expect((await o.mcpBash(d.tokens.access_token, 'ls /')).status).toBe(401) } finally { o.env.db.query('UPDATE people SET active = 1 WHERE name = ?').run('park') }
  })

  test('audience (RFC 8707): a token issued for another resource is refused, e.g. after the public address changed', async () => {
    const c = await o.connect('kim')
    const before = o.env.w.oauth
    o.env.w.oauth = o.runtime({ issuer: 'https://new-address.example.test' })
    try {
      const r = await o.mcpBash(c.tokens.access_token, 'ls /')
      expect(r.status).toBe(401)
      expect(r.data.error_description).toContain('another resource')
    } finally { o.env.w.oauth = before }
    // a live grant whose access token row names another resource
    const grant = o.env.db.query<{ grant_id: number }, [string]>('SELECT grant_id FROM oauth_tokens WHERE hash = ?').get(sha256(c.tokens.access_token))!.grant_id
    o.env.db.query(`INSERT INTO oauth_tokens (hash, grant_id, kind, resource, created_at, expires_at) VALUES (?, ?, 'access', ?, ?, ?)`).run(sha256('shelf_oat_forged'), grant, 'https://evil.example/mcp', Date.now(), Date.now() + 3600_000)
    expect((await o.mcpBash('shelf_oat_forged', 'ls /')).status).toBe(401)
    expect((await o.mcpBash(c.tokens.access_token, 'ls /')).status).toBe(200)
  })

  test('PATs keep working on /mcp next to OAuth', async () => {
    const r = await o.mcpBash(o.env.secrets.kim!, 'ls /')
    expect(r.status).toBe(200)
    expect(r.out).toContain('프로젝트')
  })
})

describe('OAuth grants obey the same permission decisions as personal access tokens', () => {
  test('kim via OAuth with "all folders" still cannot see 경영; boss can; boss narrowed to 프로젝트 cannot', async () => {
    const kim = await o.connect('kim', { folders: 'all' })
    expect((await o.mcpBash(kim.tokens.access_token, 'ls /')).out).not.toContain('경영')
    const k = await o.mcpBash(kim.tokens.access_token, 'grep -r 매출 / ; echo "exit $?"; cat /경영/손익.csv')
    expect(k.out).not.toContain('1240000000')
    expect(k.out).toContain('exit 1')
    // hidden == missing: the same answer as for a name that does not exist
    const hidden = await o.mcpBash(kim.tokens.access_token, 'cat /경영/손익.csv')
    const missing = await o.mcpBash(kim.tokens.access_token, 'cat /없는폴더/손익.csv')
    expect(hidden.out.replace('/경영', '/P')).toBe(missing.out.replace('/없는폴더', '/P'))

    const boss = await o.connect('boss', { folders: 'all' })
    expect((await o.mcpBash(boss.tokens.access_token, 'cat /경영/손익.csv')).out).toContain('1240000000')
    const narrow = await o.connect('boss', { folders: ['프로젝트'] })
    const n = await o.mcpBash(narrow.tokens.access_token, 'ls /; grep -r 매출 /; echo "exit $?"')
    expect(n.out).not.toContain('경영')
    expect(n.out).toContain('exit 1')
  })

  test('personal folders stay their owner\'s; "No AI" closes a folder to OAuth connections as to PATs', async () => {
    const kim = await o.connect('kim', { folders: 'all' })
    expect((await o.mcpBash(kim.tokens.access_token, 'ls /')).out).toContain('개인_kim')
    const park = await o.connect('park', { folders: 'all' })
    expect((await o.mcpBash(park.tokens.access_token, 'ls /')).out).not.toContain('개인_kim')
    setFlag(o.env.db, `${o.env.root}/공용`, 'no_ai', true)
    try {
      expect((await o.mcpBash(kim.tokens.access_token, 'cat /공용/공지.md')).out).not.toContain('대청소')
      expect((await o.mcpBash(o.env.secrets.kim!, 'cat /공용/공지.md')).out).not.toContain('대청소')
    } finally { setFlag(o.env.db, `${o.env.root}/공용`, 'no_ai', false) }
    expect((await o.mcpBash(kim.tokens.access_token, 'cat /공용/공지.md')).out).toContain('대청소')
  })

  test('audit rows name the OAuth connection like any token', async () => {
    const c = await o.connect('lee', { folders: ['공용'] })
    await o.mcpBash(c.tokens.access_token, 'cat /공용/공지.md')
    const row = o.env.db.query<{ token_id: number; tool: string }, []>('SELECT token_id, tool FROM audit ORDER BY id DESC LIMIT 1').get()!
    const t = o.env.db.query<{ kind: string; name: string }, [number]>('SELECT kind, name FROM tokens WHERE id = ?').get(row.token_id)!
    expect(t.kind).toBe('oauth')
    expect(t.name).toContain('client.test')
    const consent = o.env.db.query<{ command: string }, []>(`SELECT command FROM audit WHERE command LIKE 'oauth consent%' ORDER BY id DESC LIMIT 1`).get()!
    expect(consent.command).toContain('client.test')
  })
})

describe('dynamic client registration (off by default)', () => {
  test('off: /oauth/register is 404; on: public clients registered, shown unverified, rate-limited per address', async () => {
    expect((await o.http('POST', '/oauth/register', { headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(404)
    const before = o.env.w.oauth
    o.env.w.oauth = o.runtime({ dcr: true })
    try {
      const meta = await (await o.http('GET', '/.well-known/oauth-authorization-server')).json() as Record<string, unknown>
      expect(meta.registration_endpoint).toBe(`${ISSUER}/oauth/register`)
      const reg = (addr: string, body: unknown) => o.http('POST', '/oauth/register', { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, addr)
      expect((await reg('10.9.0.1', { redirect_uris: ['http://evil.example/cb'] })).status).toBe(400)
      const r = await reg('10.9.0.1', { client_name: 'Claude', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'client_secret_basic' })
      expect(r.status).toBe(201)
      const c = await r.json() as { client_id: string; token_endpoint_auth_method: string }
      expect(c.token_endpoint_auth_method).toBe('none')
      const a = await o.startAuth(pkce().challenge, { client_id: c.client_id })
      const b = await o.env.as('kim')
      const d = await b.call('GET', `/api/oauth/requests/${a.rid}`)
      expect(d.data.client).toMatchObject({ kind: 'dcr', verified: false, name: 'Claude', domain: 'app.client.test' })
      let last = 0
      for (let i = 0; i < 10; i++) last = (await reg('10.9.0.2', { redirect_uris: [CALLBACK] })).status
      expect(last).toBe(201)
      expect((await reg('10.9.0.2', { redirect_uris: [CALLBACK] })).status).toBe(429)
    } finally { o.env.w.oauth = before }
    // registered clients stop working when registration is off again
    const rows = o.env.db.query<{ client_id: string }, []>(`SELECT client_id FROM oauth_clients WHERE kind = 'dcr' LIMIT 1`).all()
    const a = await o.startAuth(pkce().challenge, { client_id: rows[0]!.client_id })
    expect(a.res.status).toBe(400)
  })
})
