// Web sign-in: first setup with the one-time token, sessions (fixation, cookie scope), CSRF and Origin, rate limit,
// invite and reset links (one use, R9), and the rule that /mcp never accepts a session cookie.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { openDb } from '../src/db'
import { makeCtx } from '../src/session'
import { verifyToken } from '../src/store'
import { handleWeb, makeWebCtx } from '../src/web/server'
import { createLink, issueSetupToken } from '../src/web/auth'
import { ORIGIN, PASSWORD, webSetup, type WebEnv } from './web-helpers'

let e: WebEnv
beforeEach(async () => { e = await webSetup() })
afterEach(() => e.cleanup())

describe('first setup', () => {
  test('only with the one-time setup token; never from "local" requests; used once', async () => {
    e.db.query('DELETE FROM accounts').run() // nobody can sign in yet
    const b = new e.Browser()
    expect((await b.call('GET', '/api/state')).data).toMatchObject({ setup_pending: false, setup_done: false })
    const secret = issueSetupToken(e.db)!
    expect(secret).toStartWith('shelf_setup_')
    expect((await b.call('GET', '/api/state')).data.setup_pending).toBe(true)
    const form = { name: 'dion', email: 'dion@example.com', password: PASSWORD }
    // a loopback-looking request without the token gets nothing
    expect((await b.call('POST', '/api/setup', form, { origin: 'http://127.0.0.1', host: '127.0.0.1' })).status).toBe(403)
    expect((await b.call('POST', '/api/setup', { ...form, setup_token: 'shelf_setup_wrong' })).status).toBe(403)
    const ok = await b.call('POST', '/api/setup', { ...form, setup_token: secret })
    expect(ok.status).toBe(200)
    expect(ok.data.me).toMatchObject({ name: 'dion', admin: true })
    expect((await b.call('GET', '/api/session')).status).toBe(200)
    // used up, and setup is done: no new token can be issued
    expect((await new e.Browser().call('POST', '/api/setup', { ...form, setup_token: secret })).status).toBe(403)
    expect(issueSetupToken(e.db)).toBeNull()
  })

  test('a non-admin name cannot be claimed by setup', async () => {
    e.db.query('DELETE FROM accounts').run()
    const secret = issueSetupToken(e.db)!
    const r = await new e.Browser().call('POST', '/api/setup', { name: 'kim', email: 'k@example.com', password: PASSWORD, setup_token: secret })
    expect(r.status).toBe(409)
  })
})

describe('sessions', () => {
  test('cookie is HttpOnly, SameSite=Strict, scoped to /api; Secure on https', async () => {
    const b = await e.as('kim')
    expect(b.lastSetCookie).toMatch(/HttpOnly/)
    expect(b.lastSetCookie).toMatch(/SameSite=Strict/)
    expect(b.lastSetCookie).toMatch(/Path=\/api/)
    expect(b.lastSetCookie).not.toMatch(/Secure/)
    const s = new e.Browser()
    await s.call('POST', '/api/login', { login: 'kim', password: PASSWORD }, { 'x-forwarded-proto': 'https' })
    expect(s.lastSetCookie).toMatch(/; Secure/)
  })

  test('session fixation: a planted cookie is never adopted, and signing in again gives a new id', async () => {
    const b = new e.Browser()
    b.cookie = 'attacker-chosen-value'
    expect((await b.call('GET', '/api/session')).status).toBe(401)
    await b.login('kim')
    expect(b.cookie).not.toBe('attacker-chosen-value')
    const first = b.cookie!
    await b.login('kim')
    expect(b.cookie).not.toBe(first)
    const old = new e.Browser(); old.cookie = first
    expect((await old.call('GET', '/api/session')).status).toBe(401)
    expect((await b.call('GET', '/api/session')).status).toBe(200)
  })

  test('wrong password and unknown name look the same; rate limited per name', async () => {
    const b = new e.Browser()
    const wrong = await b.call('POST', '/api/login', { login: 'kim', password: 'nope nope nope' })
    const unknown = await b.call('POST', '/api/login', { login: 'nobody', password: 'nope nope nope' })
    expect(wrong.status).toBe(401)
    expect(unknown.status).toBe(401)
    expect(wrong.data).toEqual(unknown.data)
    for (let i = 0; i < 5; i++) await b.call('POST', '/api/login', { login: 'lee', password: 'wrong password' })
    expect((await b.call('POST', '/api/login', { login: 'lee', password: PASSWORD })).status).toBe(429)
    expect((await b.call('POST', '/api/login', { login: 'park', password: PASSWORD })).status).toBe(200)
  })

  test('rate limits survive a restart (kept in SQLite, keys hashed); 429 carries Retry-After; per address too', async () => {
    const b = new e.Browser()
    for (let i = 0; i < 5; i++) await b.call('POST', '/api/login', { login: 'lee', password: 'wrong password' })
    const r = await b.call('POST', '/api/login', { login: 'lee', password: PASSWORD })
    expect(r.status).toBe(429)
    const after = Number(r.headers.get('retry-after'))
    expect(after).toBeGreaterThan(14 * 60)
    expect(after).toBeLessThanOrEqual(15 * 60)
    // "restart": a new server context over the same database file
    const db2 = openDb(e.dir)
    try {
      const w2 = makeWebCtx(makeCtx(db2, e.dir), { mailer: e.mailer, webDir: '/nonexistent' })
      const res = await handleWeb(w2, new Request(ORIGIN + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ login: 'lee', password: PASSWORD }) }), '10.9.9.9')
      expect(res.status).toBe(429)
      expect(res.headers.get('retry-after')).toBeTruthy()
      // the stored keys are hashes, never the typed name (it may be a password typed into the wrong field)
      expect(JSON.stringify(db2.query('SELECT * FROM rate_limits').all())).not.toMatch(/lee|10\.0\.0\.1/)
    } finally { db2.close() }
    // per address: 50 attempts per 15 minutes from one address, whatever the name
    const a = new e.Browser()
    let last = 0
    for (let i = 0; i < 60 && last !== 429; i++) last = (await a.call('POST', '/api/login', { login: `nobody${i}`, password: 'wrong password' })).status
    expect(last).toBe(429)
    expect((await a.call('POST', '/api/login', { login: 'park', password: PASSWORD })).status).toBe(429)
  })

  test('sign-in by mail address works; inactive people cannot sign in', async () => {
    expect((await new e.Browser().call('POST', '/api/login', { login: 'KIM@example.com', password: PASSWORD })).status).toBe(200)
    e.db.query('UPDATE people SET active = 0 WHERE name = ?').run('park')
    expect((await new e.Browser().call('POST', '/api/login', { login: 'park', password: PASSWORD })).status).toBe(401)
  })

  test('logout ends the session', async () => {
    const b = await e.as('kim')
    const cookie = b.cookie
    expect((await b.call('POST', '/api/logout')).status).toBe(200)
    const again = new e.Browser(); again.cookie = cookie
    expect((await again.call('GET', '/api/session')).status).toBe(401)
  })
})

describe('CSRF and Origin', () => {
  test('state changes need the session CSRF token', async () => {
    const b = await e.as('kim')
    const body = { name: 'laptop', ttl: '7d' }
    expect((await b.call('POST', '/api/tokens', body, { 'x-csrf-token': '' })).status).toBe(403)
    expect((await b.call('POST', '/api/tokens', body, { 'x-csrf-token': 'x'.repeat(32) })).status).toBe(403)
    expect((await b.call('POST', '/api/tokens', body)).status).toBe(200)
  })

  test('a CSRF token of another session does not work', async () => {
    const kim = await e.as('kim'), lee = await e.as('lee')
    expect((await kim.call('POST', '/api/tokens', { name: 'x', ttl: '7d' }, { 'x-csrf-token': lee.csrf! })).status).toBe(403)
  })

  test('cross-site Origin or Sec-Fetch-Site is refused, even with the token', async () => {
    const b = await e.as('kim')
    expect((await b.call('POST', '/api/tokens', { name: 'x', ttl: '7d' }, { origin: 'https://evil.example' })).status).toBe(403)
    expect((await b.call('POST', '/api/tokens', { name: 'x', ttl: '7d' }, { origin: '', 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await new e.Browser().call('POST', '/api/login', { login: 'kim', password: PASSWORD }, { origin: 'https://evil.example' })).status).toBe(403)
  })

  test('form posts (not JSON) are refused', async () => {
    const b = await e.as('kim')
    const r = await b.raw('POST', '/api/tokens', undefined, { 'content-type': 'application/x-www-form-urlencoded', 'x-csrf-token': '' })
    expect(r.status).toBe(403) // no CSRF header on a form post
    const { handleWeb } = await import('../src/web/server')
    const res = await handleWeb(e.w, new Request(ORIGIN + '/api/tokens', {
      method: 'POST', headers: { cookie: `shelf_session=${b.cookie}`, origin: ORIGIN, 'x-csrf-token': b.csrf!, 'content-type': 'text/plain' }, body: 'name=x&ttl=7d' }))
    expect(res.status).toBe(415)
  })
})

describe('/mcp never takes a cookie', () => {
  test('a valid session cookie on /mcp is 401; the session cookie is not sent there anyway (Path=/api)', async () => {
    const b = await e.as('kim')
    const { handleWeb } = await import('../src/web/server')
    const res = await handleWeb(e.w, new Request(ORIGIN + '/mcp', {
      method: 'POST', headers: { cookie: `shelf_session=${b.cookie}`, 'content-type': 'application/json', 'x-csrf-token': b.csrf! },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }))
    expect(res.status).toBe(401)
    const ok = await handleWeb(e.w, new Request(ORIGIN + '/mcp', {
      method: 'POST', headers: { authorization: `Bearer ${e.secrets.kim}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }))
    expect(ok.status).toBe(200)
  })
})

describe('invite links', () => {
  test('one use, then gone; the new person is signed in', async () => {
    const admin = await e.as('dion')
    const r = await admin.call('POST', '/api/people', { name: 'choi', email: 'choi@example.com' })
    expect(r.status).toBe(200)
    const secret = r.data.invite_url.split('/#/invite/')[1]
    expect(e.mailer.read().some((m) => m.to === 'choi@example.com' && m.text.includes(secret))).toBe(true)
    const b = new e.Browser()
    expect((await b.call('POST', '/api/links/check', { kind: 'invite', token: secret })).data).toEqual({ name: 'choi' })
    expect((await b.call('POST', '/api/links/accept', { kind: 'invite', token: secret, password: 'short' })).status).toBe(400)
    const ok = await b.call('POST', '/api/links/accept', { kind: 'invite', token: secret, password: 'choi password 1' })
    expect(ok.status).toBe(200)
    expect(ok.data.me.name).toBe('choi')
    expect((await new e.Browser().call('POST', '/api/links/accept', { kind: 'invite', token: secret, password: 'another password' })).status).toBe(404)
    expect((await new e.Browser().call('POST', '/api/login', { login: 'choi', password: 'choi password 1' })).status).toBe(200)
    // an invite is not a reset link
    expect((await new e.Browser().call('POST', '/api/links/accept', { kind: 'reset', token: secret, password: 'another password' })).status).toBe(404)
  })

  test('expired links do not work; a new invite replaces the old one', async () => {
    const pid = e.pid('lee')
    const old = createLink(e.db, 'invite', pid, null)
    const fresh = createLink(e.db, 'invite', pid, null)
    expect((await new e.Browser().call('POST', '/api/links/check', { kind: 'invite', token: old })).status).toBe(404)
    e.db.query('UPDATE web_links SET expires_at = 1').run()
    expect((await new e.Browser().call('POST', '/api/links/check', { kind: 'invite', token: fresh })).status).toBe(404)
  })

  test('someone who already has a password cannot be re-invited (that would be a takeover)', async () => {
    const admin = await e.as('dion')
    expect((await admin.call('POST', `/api/people/${e.pid('kim')}/invite`, {})).status).toBe(409)
  })
})

describe('password reset (R9)', () => {
  test('admin starts it: link only in the person\'s mail, tokens and sessions cut at once, person told', async () => {
    const admin = await e.as('dion')
    const kim = await e.as('kim')
    expect(verifyToken(e.db, e.secrets.kim!)).not.toBeNull()
    const r = await admin.call('POST', `/api/people/${e.pid('kim')}/reset`, {})
    expect(r.status).toBe(200)
    expect(JSON.stringify(r.data)).not.toMatch(/reset\//) // the admin never gets the link
    expect(r.data.tokens_revoked).toBeGreaterThanOrEqual(1)
    expect(verifyToken(e.db, e.secrets.kim!)).toBeNull()
    expect((await kim.call('GET', '/api/session')).status).toBe(401)
    const mail = e.mailer.read().find((m) => m.to === 'kim@example.com' && m.text.includes('/#/reset/'))!
    expect(mail).toBeDefined()
    const secret = /#\/reset\/(\S+)/.exec(mail.text)![1]
    expect(e.db.query(`SELECT count(*) AS n FROM notices WHERE person_id = ? AND kind = 'password_reset'`).get(e.pid('kim'))).toEqual({ n: 1 })
    // the admin has no endpoint to set it
    expect((await admin.call('PATCH', `/api/people/${e.pid('kim')}`, { password: 'admin chosen pw' })).status).toBe(200)
    expect((await new e.Browser().call('POST', '/api/login', { login: 'kim', password: 'admin chosen pw' })).status).toBe(401)
    const b = new e.Browser()
    expect((await b.call('POST', '/api/links/accept', { kind: 'reset', token: secret, password: 'kim new password' })).status).toBe(200)
    expect((await new e.Browser().call('POST', '/api/login', { login: 'kim', password: 'kim new password' })).status).toBe(200)
    expect((await new e.Browser().call('POST', '/api/links/accept', { kind: 'reset', token: secret, password: 'third password' })).status).toBe(404)
  })

  test('only an admin can start a reset', async () => {
    const kim = await e.as('kim')
    expect((await kim.call('POST', `/api/people/${e.pid('lee')}/reset`, {})).status).toBe(403)
  })

  test('changing an address tells the old address', async () => {
    const admin = await e.as('dion')
    expect((await admin.call('PATCH', `/api/people/${e.pid('lee')}`, { email: 'lee2@example.com' })).status).toBe(200)
    expect(e.mailer.read().some((m) => m.to === 'lee@example.com' && /sign-in address/.test(m.subject))).toBe(true)
  })

  test('own password change needs the current one and ends other sessions', async () => {
    const a = await e.as('kim'), other = await e.as('kim')
    expect((await a.call('POST', '/api/me/password', { current: 'wrong', password: 'new kim password' })).status).toBe(400)
    expect((await a.call('POST', '/api/me/password', { current: PASSWORD, password: 'new kim password' })).status).toBe(200)
    expect((await a.call('GET', '/api/session')).status).toBe(200)
    expect((await other.call('GET', '/api/session')).status).toBe(401)
  })
})
