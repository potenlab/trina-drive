// The public listener (plan 5.2, 7.1 "공개 노출"): only /mcp, /oauth/*, /.well-known/oauth-*, the sign-in and consent
// pages and their API calls; the admin API, files, drafts, audit and /health are 404. Requests are rebuilt on the
// public https URL; forwarded client addresses are believed only from the configured tunnel connector; the listener
// starts only when the public gate passes.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { readPublicSettings, writePublicSettings } from '../src/oauth/settings'
import { admin2faProblem, clientAddress, handlePublic, publicGate, publicPathAllowed, publicUrlProblem, startPublicListener } from '../src/web/public'
import { totpBegin, totpConfirm } from '../src/web/mfa'
import { totpAt } from '../src/web/totp'
import { publicCommand } from '../src/web/public-cli'
import { ISSUER, oauthSetup, pkce, type OAuthEnv } from './oauth-helpers'
import { PASSWORD } from './web-helpers'

let o: OAuthEnv
let webDir: string
beforeAll(async () => {
  o = await oauthSetup()
  webDir = path.join(o.env.dir, 'webdist')
  fs.mkdirSync(path.join(webDir, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><title>app</title>')
  fs.writeFileSync(path.join(webDir, 'assets', 'app.js'), 'console.log(1)')
  o.env.w.opts.webDir = webDir
})
afterAll(() => o.cleanup())

const cfg = { url: ISSUER, trustedProxy: '127.0.0.1' }
/** A request as cloudflared delivers it: plain http to the loopback listener, Host = the public name. */
const pub = (method: string, p: string, init: { headers?: Record<string, string>; body?: string } = {}, peer = '127.0.0.1') =>
  handlePublic(o.env.w, new Request(`http://127.0.0.1:8788${p}`, { method, headers: { host: 'files.example.test', ...init.headers }, body: init.body }), peer, cfg)

describe('allowlist', () => {
  test.each([
    ['GET', '/api/people'], ['GET', '/api/folders'], ['POST', '/api/folders'], ['GET', '/api/tokens'], ['POST', '/api/tokens'], ['GET', '/api/files'],
    ['GET', '/api/files/download'], ['GET', '/api/search'], ['GET', '/api/audit'], ['GET', '/api/drafts'], ['POST', '/api/setup'], ['POST', '/api/links/accept'],
    ['POST', '/api/me/password'], ['GET', '/api/notices'], ['GET', '/health'], ['GET', '/admin'], ['GET', '/folders'], ['GET', '/.well-known/openid-configuration'],
    ['GET', '/.well-known/security.txt'], ['GET', '/oauth/other'], ['GET', '/api'], ['GET', '/api/'], ['GET', '/index.htm'], ['GET', '/assets/../api/people'],
    ['GET', '/%2e%2e/api/people'], ['GET', '/api/oauth/../people'],
  ])('%s %s is 404', async (method, p) => {
    const r = await pub(method, p)
    expect(r.status).toBe(404)
    expect(await r.text()).toBe('{"error":"not_found"}')
  })

  test('what is served: metadata, /mcp, the app shell and its assets, sign-in state', async () => {
    expect((await pub('GET', '/.well-known/oauth-authorization-server')).status).toBe(200)
    expect((await pub('GET', '/.well-known/oauth-protected-resource/mcp')).status).toBe(200)
    expect((await pub('GET', '/.well-known/oauth-protected-resource')).status).toBe(200)
    const mcp = await pub('POST', '/mcp', { headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' })
    expect(mcp.status).toBe(401)
    expect(mcp.headers.get('www-authenticate')).toContain(`resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp"`)
    const index = await pub('GET', '/')
    expect(index.status).toBe(200)
    expect(await index.text()).toContain('<title>app</title>')
    expect((await pub('GET', '/assets/app.js')).status).toBe(200)
    const state = await pub('GET', '/api/state')
    expect(await state.json()).toMatchObject({ public_listener: true })
    expect(state.headers.get('strict-transport-security')).toContain('max-age=')
    expect(state.headers.get('x-frame-options')).toBe('DENY')
  })

  test('the path table itself', () => {
    expect(publicPathAllowed('GET', '/api/oauth/requests/abc')).toBe(true)
    expect(publicPathAllowed('POST', '/api/oauth/requests/abc/approve')).toBe(true)
    expect(publicPathAllowed('GET', '/api/login')).toBe(false) // login is POST only
    expect(publicPathAllowed('POST', '/api/login')).toBe(true)
    expect(publicPathAllowed('DELETE', '/api/tokens/1')).toBe(false)
    // approvals and one's own passkeys happen on the public https domain (passkey RP ID); TOTP setup and the rest do not
    for (const [m, p] of [['GET', '/api/approvals'], ['GET', '/api/approvals/3'], ['POST', '/api/approvals/3/step-up/options'], ['POST', '/api/approvals/3/step-up'],
      ['POST', '/api/approvals/3/approve'], ['POST', '/api/approvals/3/reject'], ['POST', '/api/login/second'], ['GET', '/api/me/2fa'], ['POST', '/api/me/reauth'],
      ['POST', '/api/me/passkeys/options'], ['POST', '/api/me/passkeys'], ['DELETE', '/api/me/passkeys/2']] as const) expect({ m, p, ok: publicPathAllowed(m, p) }).toEqual({ m, p, ok: true })
    for (const [m, p] of [['POST', '/api/me/totp/setup'], ['POST', '/api/me/totp/confirm'], ['DELETE', '/api/me/totp'], ['POST', '/api/me/recovery-codes'], ['POST', '/api/me/password'],
      ['GET', '/api/approvals/3/diff'], ['GET', '/api/approvalsx'], ['GET', '/api/approvals/x'], ['DELETE', '/api/me/passkeys/x'], ['GET', '/api/oauth/requests/a/b']] as const) expect({ m, p, ok: publicPathAllowed(m, p) }).toEqual({ m, p, ok: false })
  })

  test('the approval inbox answers through the public listener (behind sign-in)', async () => {
    expect((await pub('GET', '/api/approvals')).status).toBe(401)
    const login = await pub('POST', '/api/login', { headers: { 'content-type': 'application/json', origin: ISSUER }, body: JSON.stringify({ login: 'boss', password: PASSWORD }) })
    const cookie = /tdrive_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')![1]!
    expect((await pub('GET', '/api/approvals', { headers: { cookie: `tdrive_session=${cookie}` } })).status).toBe(200)
    expect((await pub('GET', '/api/me/2fa', { headers: { cookie: `tdrive_session=${cookie}` } })).status).toBe(200)
    expect((await pub('GET', '/api/drafts', { headers: { cookie: `tdrive_session=${cookie}` } })).status).toBe(404)
  })
})

describe('sign-in and consent through the public address', () => {
  test('requests are rebuilt on the https URL: same-origin checks pass, the cookie is Secure, consent works end to end', async () => {
    const origin = ISSUER
    const login = await pub('POST', '/api/login', { headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ login: 'kim', password: PASSWORD }) }, '127.0.0.1')
    expect(login.status).toBe(200)
    const setCookie = login.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('Secure')
    const cookie = /tdrive_session=([^;]+)/.exec(setCookie)![1]!
    const { csrf } = await login.json() as { csrf: string }
    // a cross-site page cannot sign in
    expect((await pub('POST', '/api/login', { headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ login: 'kim', password: PASSWORD }) })).status).toBe(403)

    const p = pkce()
    const q = new URLSearchParams({ response_type: 'code', client_id: o.clientId, redirect_uri: 'https://app.client.test/callback', code_challenge: p.challenge, code_challenge_method: 'S256', resource: `${ISSUER}/mcp`, state: 'xyz' })
    const auth = await pub('GET', `/oauth/authorize?${q}`)
    expect(auth.status).toBe(302)
    const rid = /#\/oauth\/(.+)$/.exec(auth.headers.get('location')!)![1]!
    const h = { cookie: `tdrive_session=${cookie}`, 'content-type': 'application/json', origin, 'x-csrf-token': csrf }
    const details = await pub('GET', `/api/oauth/requests/${rid}`, { headers: { cookie: h.cookie } })
    expect(details.status).toBe(200)
    // the signed-in person still cannot reach the admin API here
    expect((await pub('GET', '/api/tokens', { headers: { cookie: h.cookie } })).status).toBe(404)
    const ap = await pub('POST', `/api/oauth/requests/${rid}/approve`, { headers: h, body: JSON.stringify({ folders: [o.env.fid('공용')] }) })
    expect(ap.status).toBe(200)
    const code = new URL((await ap.json() as { redirect_to: string }).redirect_to).searchParams.get('code')!
    const tok = await pub('POST', '/oauth/token', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: o.clientId, redirect_uri: 'https://app.client.test/callback', code_verifier: p.verifier, resource: `${ISSUER}/mcp` }).toString() })
    expect(tok.status).toBe(200)
    const { access_token } = await tok.json() as { access_token: string }
    const call = await pub('POST', '/mcp', { headers: { 'content-type': 'application/json', authorization: `Bearer ${access_token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bash', arguments: { command: 'cat /공용/공지.md' } } }) })
    expect(call.status).toBe(200)
    expect(JSON.stringify(await call.json())).toContain('대청소')
  })

  test('sign-in rate limits count the real client (CF-Connecting-IP) when the peer is the tunnel connector', async () => {
    // a different name each time: the per-name limit (5) stays out of the way, the per-address one (50) is what counts
    let n = 0
    const tryLogin = (ip: string, peer = '127.0.0.1') => pub('POST', '/api/login', { headers: { 'content-type': 'application/json', origin: ISSUER, 'cf-connecting-ip': ip }, body: JSON.stringify({ login: `nobody${n++}`, password: 'wrong password!' }) }, peer)
    let last = 0
    for (let i = 0; i < 51; i++) last = (await tryLogin('203.0.113.50')).status
    expect(last).toBe(429)
    // another client behind the same tunnel is not blocked by the first one's failures
    expect((await tryLogin('203.0.113.51')).status).toBe(401)
  })
})

describe('client address', () => {
  const req = (h: Record<string, string>) => new Request('http://x/', { headers: h })
  test('forwarded headers are believed only from the configured connector', () => {
    expect(clientAddress(req({ 'cf-connecting-ip': '198.51.100.1' }), '127.0.0.1', '127.0.0.1')).toBe('198.51.100.1')
    expect(clientAddress(req({ 'x-forwarded-for': '198.51.100.2, 10.0.0.1' }), '127.0.0.1', '127.0.0.1')).toBe('198.51.100.2')
    expect(clientAddress(req({ 'cf-connecting-ip': '198.51.100.1' }), '10.0.0.8', '127.0.0.1')).toBe('10.0.0.8')
    expect(clientAddress(req({ 'cf-connecting-ip': '198.51.100.1' }), '127.0.0.1', null)).toBe('127.0.0.1')
    expect(clientAddress(req({ 'cf-connecting-ip': 'not-an-ip' }), '127.0.0.1', '127.0.0.1')).toBe('127.0.0.1')
  })
})

describe('the public gate', () => {
  test('url rules', () => {
    expect(publicUrlProblem('https://files.example.com')).toBeNull()
    expect(publicUrlProblem('https://files.example.com/')).toBeNull()
    for (const bad of ['http://files.example.com', 'https://files.example.com/drive', 'https://127.0.0.1', 'https://localhost', 'https://intranet', 'https://files.example.com?x=1', null]) {
      expect(publicUrlProblem(bad)).not.toBeNull()
    }
  })

  test('nothing starts until URL, a second factor for every admin and the security gate are in place; then only the allowlist answers', async () => {
    const db = o.env.db
    expect(admin2faProblem(db)).toContain('1 admin without a second factor')
    expect(publicGate(db).ok).toBe(false)
    const out: string[] = []
    expect(() => publicCommand(db, 'enable', ['--url', 'http://files.example.test'], (s) => out.push(s))).toThrow('https')
    publicCommand(db, 'enable', ['--url', ISSUER, '--port', '1'], (s) => out.push(s))
    let g = publicGate(db)
    expect(g.ok).toBe(false)
    expect(g.checks.filter((c) => !c.ok && c.required).map((c) => c.id).sort()).toEqual(['admin_2fa', 'security_gate'])
    expect(startPublicListener(o.env.w).server).toBeNull()
    publicCommand(db, 'enable', ['--confirm-security-gate', '--gate-version', 'v0.2.0', '--trusted-proxy', '127.0.0.1'], (s) => out.push(s))
    expect(publicGate(db).checks.filter((c) => !c.ok && c.required).map((c) => c.id)).toEqual(['admin_2fa'])
    // the admin (dion) sets up an authenticator app: the gate reads it live (web/mfa.ts)
    const { secret } = totpBegin(db, o.env.pid('dion'), 'dion')
    expect(totpConfirm(db, o.env.pid('dion'), totpAt(secret, Date.now()))).toBe(true)
    expect(admin2faProblem(db)).toBeNull()
    g = publicGate(db)
    expect(g.ok).toBe(true)
    expect(out.join('\n')).toContain('Cloudflare tunnel')
    // a real listener on a free port
    writePublicSettings(db, { ...readPublicSettings(db), port: 0 })
    const started = startPublicListener(o.env.w)
    expect(started.server).not.toBeNull()
    const base = `http://127.0.0.1:${started.server!.port}`
    try {
      expect((await fetch(`${base}/api/people`)).status).toBe(404)
      expect((await fetch(`${base}/health`)).status).toBe(404)
      expect((await fetch(`${base}/.well-known/oauth-authorization-server`)).status).toBe(200)
      expect((await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401)
    } finally { started.server!.stop(true) }
    publicCommand(db, 'disable', [], (s) => out.push(s))
    expect(publicGate(db).ok).toBe(false)
    const status: string[] = []
    publicCommand(db, 'status', [], (s) => status.push(s))
    expect(status.join('\n')).toContain('NOT passed')
  })

  test('changing the public URL warns that OAuth connections stop working', () => {
    const out: string[] = []
    publicCommand(o.env.db, 'enable', ['--url', 'https://other.example.test'], (s) => out.push(s))
    expect(out.join('\n')).toContain('stop working')
    publicCommand(o.env.db, 'enable', ['--url', ISSUER, '--client-host', 'Example.COM', '--allow-dcr'], () => {})
    expect(readPublicSettings(o.env.db)).toMatchObject({ dcr: true, clientHosts: ['claude.ai', 'chatgpt.com', 'example.com'] })
  })
})
