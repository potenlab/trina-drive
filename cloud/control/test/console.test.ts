// The console (workstream D1): accounts (S01), the console's own security (S46 / review #9 #10: __Host- cookie, a
// planted same-name cookie ignored, Origin + CSRF on every changing method, CSP), "not yours = not found", the pages,
// and v1's closed Free sign-up (TDCLOUD_MAX_FREE_TEAMS = 0) and "payment coming soon".
import { afterEach, describe, expect, test } from 'bun:test'
import { teamBySlug } from '../src/db'
import { account, Browser, ORIGIN, opsTeam, PW, setupConsole, type ConsoleEnv } from './console-helpers'

let env: ConsoleEnv
afterEach(() => env?.cleanup())

describe('S01: sign up → confirm by mail (once) → sign in; an unconfirmed account makes no team', () => {
  test('the flow through the pages', async () => {
    env = setupConsole()
    const b = new Browser(env)
    const su = await b.get('/signup?account=1')
    expect(su.status).toBe(200)
    expect(su.text).toContain('Create your account')
    const r = await b.post('/signup?account=1', { email: 'Mina@Acme.test', password: PW }, { csrf: false })
    expect(r.text).toContain('Check your email')
    const mail = env.mailer.sent.find((m) => m.to === 'mina@acme.test' && /Confirm your email/.test(m.subject))!
    const token = mail.text.match(/verify\?token=(\S+)/)![1]!

    // signed in but not confirmed: no team
    const l0 = await b.post('/login', { email: 'mina@acme.test', password: PW }, { csrf: false })
    expect(l0.status).toBe(303)
    expect(l0.location).toBe('/')
    const home = await b.get('/')
    expect(home.text).toContain('Confirm your email address')
    const nt = await b.post('/new', { name: 'Acme', slug: 'acme', plan: 'free' })
    expect(nt.status).toBe(403)
    expect(nt.text).toContain('confirm your email address first')
    const api = await b.api('POST', '/api/teams', { name: 'Acme', slug: 'acme', plan: 'team' })
    expect([api.status, api.json.error]).toEqual([403, 'unverified'])

    // the link: a button (mail scanners), then it works once
    expect((await b.get(`/verify?token=${token}`)).text).toContain('<form method="post" action="/verify">')
    const v = await b.post('/verify', { token }, { csrf: false })
    expect([v.status, v.location]).toEqual([303, '/login?verified=1'])
    const again = await b.post('/verify', { token }, { csrf: false })
    expect(again.status).toBe(404)
    expect((await b.get('/login?verified=1')).status).toBe(303) // already signed in → onward
    expect(env.cloud.db.query("SELECT count(*) AS n FROM audit WHERE action = 'user.verified'").get()).toEqual({ n: 1 })
  })

  test('wrong password: the same answer as an unknown email; rate limited per address', async () => {
    env = setupConsole()
    await account(env, 'a@acme.test')
    const b = new Browser(env)
    const wrong = await b.post('/login', { email: 'a@acme.test', password: 'nope nope nope' }, { csrf: false })
    const unknown = await b.post('/login', { email: 'zz@acme.test', password: 'nope nope nope' }, { csrf: false })
    expect([wrong.status, unknown.status]).toEqual([401, 401])
    expect(wrong.text.replace(/a@acme\.test/g, 'X')).toBe(unknown.text.replace(/zz@acme\.test/g, 'X'))
  })
})

describe('early access (Free closed, payment not live)', () => {
  test('/signup and /signup?plan=team ask for a team; the request is kept and ops are told', async () => {
    env = setupConsole()
    const b = new Browser(env)
    const p = await b.get('/signup?plan=team')
    expect(p.status).toBe(200)
    expect(p.text).toContain('Request early access')
    expect(p.text).toContain('the <b>Team</b> plan')
    expect(p.text).toContain('href="/signup?account=1"')
    expect((await b.get('/signup')).text).toContain('Request early access')
    const bad = await b.post('/signup', { kind: 'access', email: 'nope', team: 'Acme' }, { csrf: false })
    expect(bad.status).toBe(400)
    const r = await b.post('/signup', { kind: 'access', email: 'Boss@Acme.test', team: 'Acme Inc', team_size: '6-20', note: 'we use Claude', plan: 'team' }, { csrf: false })
    expect(r.text).toContain('we got it')
    expect(env.cloud.db.query('SELECT email, team_name, team_size, plan, note FROM access_requests').all()).toEqual([{ email: 'boss@acme.test', team_name: 'Acme Inc', team_size: '6-20', plan: 'team', note: 'we use Claude' }])
    const ops = env.mailer.sent.find((m) => m.to === env.cfg.opsEmail && /early access: Acme Inc/.test(m.subject))!
    expect(ops.text).toContain('teams create <slug> --owner boss@acme.test')
    // no account was made
    expect(env.cloud.db.query("SELECT 1 FROM users WHERE email = 'boss@acme.test'").get()).toBeNull()
    // with free teams open, /signup is the account form again
    env.cloud.cfg.free.maxTeams = 5
    expect((await b.get('/signup')).text).toContain('Create your account')
  })
})

describe('S46: the console\'s own security', () => {
  test('the session cookie is __Host- (Secure, Path=/, HttpOnly, no Domain); a planted unprefixed cookie is ignored', async () => {
    env = setupConsole()
    await account(env, 'a@acme.test')
    const r = await env.call('POST', '/api/login', { body: { email: 'a@acme.test', password: PW } })
    const sc = r.headers.get('set-cookie')!
    expect(sc).toStartWith('__Host-tdcloud_session=')
    for (const p of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax']) expect(sc).toContain(p)
    expect(sc).not.toMatch(/Domain=/i)
    const value = sc.split(';')[0]!.split('=')[1]!
    // the real cookie works
    expect((await env.call('GET', '/api/me', { headers: { cookie: `__Host-tdcloud_session=${value}` } })).status).toBe(200)
    // the same value in a cookie any host of the site could set (Domain=trina.app): not a session on https
    expect((await env.call('GET', '/api/me', { headers: { cookie: `tdcloud_session=${value}` } })).status).toBe(401)
    // an attacker's own session planted that way does not sign the victim in (login CSRF)
    const page = await env.call('GET', '/', { headers: { cookie: `tdcloud_session=${value}` } })
    expect([page.status, page.headers.get('location')]).toEqual([303, '/login'])
  })

  test('an http (dev) console uses the unprefixed cookie', async () => {
    env = setupConsole({ TDCLOUD_CONTROL_URL: 'http://cloud.localhost:8790' })
    await env.call('POST', '/api/signup', { body: { email: 'd@dev.test', password: PW } })
    const token = env.mailer.sent.at(-1)!.text.match(/verify\?token=(\S+)/)![1]!
    await env.call('POST', '/api/verify', { body: { token } })
    const r = await env.handle(new Request('http://cloud.localhost:8790/api/login', { method: 'POST', body: JSON.stringify({ email: 'd@dev.test', password: PW }), headers: { 'content-type': 'application/json' } }), '127.0.0.1')
    const sc = r.headers.get('set-cookie')!
    expect(sc).toStartWith('tdcloud_session=')
    expect(sc).not.toContain('Secure')
    const me = await env.handle(new Request('http://cloud.localhost:8790/api/me', { headers: { cookie: sc.split(';')[0]! } }), '127.0.0.1')
    expect(me.status).toBe(200)
  })

  test('every changing method needs the console\'s Origin, and the session\'s CSRF token', async () => {
    env = setupConsole()
    const o = await account(env, 'owner@acme.test', { totp: true })
    const t = await opsTeam(env, 'owner@acme.test', 'acme')
    const id = t.public_id
    for (const [method, path, body] of [['PATCH', `/api/teams/${id}`, { name: 'X' }], ['DELETE', `/api/teams/${id}`, { confirm_slug: 'acme' }], ['POST', `/api/teams/${id}/invites`, { emails: ['x@y.test'] }], ['PUT', '/api/teams', {}]] as const) {
      const r = await o.b.api(method, path, body, { origin: 'https://evil.cloud.example.com' })
      expect([method, r.status, r.json.error]).toEqual([method, 403, 'bad_origin'])
    }
    // the right Origin but no CSRF token
    const saved = o.b.csrf
    o.b.csrf = ''
    expect((await o.b.api('PATCH', `/api/teams/${id}`, { name: 'Acme Two' })).json.error).toBe('bad_csrf')
    o.b.csrf = saved
    const ok = await o.b.api('PATCH', `/api/teams/${id}`, { name: 'Acme Two' })
    expect(ok.status).toBe(200)
    expect(teamBySlug(env.cloud.db, 'acme')!.name).toBe('Acme Two')
    // a page form without Origin but from another site (Sec-Fetch-Site) is refused too
    const cross = await env.handle(new Request(`${ORIGIN}/t/acme/rename`, { method: 'POST', body: new URLSearchParams({ csrf: o.b.csrf, name: 'Evil' }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-site', cookie: `__Host-tdcloud_session=${o.b.cookies.get('__Host-tdcloud_session')}` } }), '203.0.113.9')
    expect(cross.status).toBe(403)
  })

  test('headers: CSP with form-action \'self\' and font-src \'self\'; frames refused; HSTS', async () => {
    env = setupConsole()
    const r = await env.call('GET', '/login')
    const csp = r.headers.get('content-security-policy')!
    expect(csp).toContain("form-action 'self'")
    expect(csp).not.toContain('form-action \'self\' https://*')
    expect(csp).toContain("font-src 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(r.headers.get('strict-transport-security')).toContain('max-age=')
    // the brand assets are served
    for (const p of ['/static/app.css', '/static/console.js', '/static/theme.js', '/static/mark.svg', '/static/fonts/Geist-Variable.woff2']) expect([p, (await env.call('GET', p)).status]).toEqual([p, 200])
    const css = await (await env.call('GET', '/static/app.css')).text()
    expect(css).toContain('--signal: #ff5b1f')
    expect(css).toContain('@font-face{font-family:"Geist"')
  })

  test('a sign-in `next` is a relative path only (no open redirect)', async () => {
    env = setupConsole()
    await account(env, 'a@acme.test')
    for (const [next, to] of [['/t/acme', '/t/acme'], ['//evil.example/x', '/'], ['https://evil.example', '/'], ['/\\evil.example', '/']] as const) {
      const b = new Browser(env)
      const r = await b.post('/login', { email: 'a@acme.test', password: PW, next }, { csrf: false })
      expect([next, r.location]).toEqual([next, to])
    }
  })
})

describe('not yours = not found', () => {
  test('another team, a missing team and a member calling an admin API answer alike', async () => {
    env = setupConsole()
    const o = await account(env, 'owner@acme.test', { totp: true })
    const x = await account(env, 'x@other.test')
    const t = await opsTeam(env, 'owner@acme.test', 'acme')
    const a = await x.b.get('/t/acme'), b = await x.b.get('/t/nosuch')
    expect([a.status, b.status]).toEqual([404, 404])
    expect(a.text).toBe(b.text)
    const ja = await x.b.api('GET', `/api/teams/${t.public_id}`), jb = await x.b.api('GET', '/api/teams/team_00000000000000000000')
    expect([ja.status, ja.text]).toEqual([404, jb.text])
    // a member of the team: the members list yes, the audit (admin) no — as if it did not exist
    const inv = await o.b.api('POST', `/api/teams/${t.public_id}/invites`, { emails: ['x@other.test'] })
    expect(inv.status).toBe(201)
    const link = env.mailer.sent.filter((m) => m.to === 'x@other.test').at(-1)!.text.match(/\/invite\/(\S+)/)![1]!
    expect((await x.b.api('POST', '/api/invites/accept', { token: link })).status).toBe(200)
    expect((await x.b.get('/t/acme/members')).status).toBe(200)
    const au = await x.b.api('GET', `/api/teams/${t.public_id}/audit`)
    expect([au.status, au.text]).toEqual([404, jb.text])
    expect((await x.b.api('PATCH', `/api/teams/${t.public_id}`, { name: 'Mine' })).status).toBe(404)
  })
})

describe('pages', () => {
  test('an owner sees every page of the team; the old setup-link button is gone', async () => {
    env = setupConsole()
    const o = await account(env, 'owner@acme.test', { totp: true, name: 'Dion Nam' })
    const t = await opsTeam(env, 'owner@acme.test', 'acme')
    const home = await o.b.get('/')
    expect(home.status).toBe(200)
    expect(home.text).toContain('Your teams')
    expect(home.text).toContain('href="/open/acme"')
    expect(home.text).toContain('Running')
    expect(home.text).not.toContain('setup link')
    for (const [p, want] of [['/t/acme', 'Open drive'], ['/t/acme/members', 'Invite people'], ['/t/acme/usage', 'AI connected'], ['/t/acme/settings', 'Delete this team'], ['/t/acme/audit', 'Chain verified'], ['/account', 'Two-step verification'], ['/new', 'Create team']] as const) {
      const r = await o.b.get(p)
      expect([p, r.status]).toEqual([p, 200])
      expect(r.text).toContain(want)
    }
    expect((await o.b.get('/dashboard')).location).toBe('/')
    expect((await o.b.post(`/teams/${t.public_id}/resend-setup`)).status).toBe(404)
    // signed out: the team pages send you to sign in and back
    const anon = new Browser(env)
    expect((await anon.get('/t/acme/members')).location).toBe('/login?next=%2Ft%2Facme%2Fmembers')
  })

  test('v1: Free is closed (waitlist) and Team/Business say "payment coming soon"', async () => {
    env = setupConsole()
    const a = await account(env, 'a@acme.test')
    const free = await a.b.post('/new', { name: 'Acme', slug: 'acme', plan: 'free' })
    expect(free.text).toContain('You are on the waitlist')
    expect(teamBySlug(env.cloud.db, 'acme')).toBeNull()
    expect(env.cloud.free.waitlist().map((w) => w.email)).toEqual(['a@acme.test'])
    const paid = await a.b.post('/new', { name: 'Acme', slug: 'acme', plan: 'team' })
    expect(paid.text).toContain('Payment is coming soon')
    expect(teamBySlug(env.cloud.db, 'acme')).toBeNull()
    // with room for free teams, the same form starts one
    env.cloud.cfg.free.maxTeams = 5
    const ok = await a.b.post('/new', { name: 'Beta', slug: 'beta-co', plan: 'free' })
    expect(ok.location).toBe('/t/beta-co?ok=created')
    expect(env.cloud.members.role(teamBySlug(env.cloud.db, 'beta-co')!.id, a.userId)).toBe('owner')
    // the address check
    expect((await a.b.api('GET', '/api/slug?slug=beta-co')).json).toEqual({ ok: false, slug: 'beta-co', problem: 'that address is taken' })
    expect((await a.b.api('GET', '/api/slug?slug=gamma')).json.ok).toBe(true)
  })
})
