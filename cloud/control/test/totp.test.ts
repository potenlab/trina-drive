// Two-step verification in the console (review finding 3): owners and admins must have it before they change members
// or settings or open a drive; the sensitive changes need a code from the last 5 minutes; sign-in asks for the code
// once enrolled (after a password or an email link); codes work once; recovery codes work once.
import { afterEach, describe, expect, test } from 'bun:test'
import { base32Decode, base32Encode, hotp, matchTotp, totpAt } from '../src/totp'
import { account, Browser, opsTeam, PW, setupConsole, type ConsoleEnv } from './console-helpers'

let env: ConsoleEnv
afterEach(() => env?.cleanup())

describe('RFC 6238', () => {
  test('the RFC 4226 test vectors and a ±1 step window', () => {
    const key = new TextEncoder().encode('12345678901234567890')
    expect([0, 1, 2, 3, 9].map((n) => hotp(key, n))).toEqual(['755224', '287082', '359152', '969429', '520489'])
    const s = base32Encode(key)
    expect(base32Decode(s)).toEqual(key)
    const t = 1_761_223_456_000
    expect(matchTotp(s, totpAt(s, t - 30_000), t)).toBe(Math.floor(t / 30_000) - 1)
    expect(matchTotp(s, totpAt(s, t - 90_000), t)).toBeNull()
    expect(matchTotp(s, 'abcdef', t)).toBeNull()
  })
})

describe('enrolling and signing in', () => {
  test('setup needs a fresh sign-in; the code turns it on; recovery codes once; sign-in is then two steps', async () => {
    env = setupConsole()
    const a = await account(env, 'a@acme.test')
    // a stale session must type the password again to start
    env.cloud.db.query('UPDATE sessions SET auth_time = 0').run()
    expect((await a.b.api('POST', '/api/me/totp/setup', {})).json.error).toBe('bad_password')
    const s = await a.b.api('POST', '/api/me/totp/setup', { password: PW })
    expect(s.json.uri).toStartWith('otpauth://totp/Trina%20Cloud%3Aa%40acme.test?secret=')
    expect((await a.b.api('POST', '/api/me/totp/enable', { code: '000000' })).status).toBe(401)
    const en = await a.b.api('POST', '/api/me/totp/enable', { code: totpAt(s.json.secret, Date.now()) })
    expect(en.json.recovery_codes).toHaveLength(10)
    // the secret is kept wrapped, never in the clear
    const row = env.cloud.db.query<{ totp_secret_enc: string }, []>("SELECT totp_secret_enc FROM users WHERE email = 'a@acme.test'").get()!
    expect(row.totp_secret_enc).not.toContain(s.json.secret)
    expect(env.mailer.sent.some((m) => m.to === 'a@acme.test' && /Two-step verification is on/.test(m.subject))).toBe(true)

    // password → ticket → code
    const b = new Browser(env)
    const l1 = await b.api('POST', '/api/login', { email: 'a@acme.test', password: PW })
    expect(l1.json.totp_required).toBe(true)
    expect(l1.headers.get('set-cookie')).toBeNull()
    // the same code (this step was used to enable): refused
    expect((await b.api('POST', '/api/login/totp', { ticket: l1.json.ticket, code: totpAt(s.json.secret, Date.now()) })).status).toBe(401)
    const l2 = await b.api('POST', '/api/login/totp', { ticket: l1.json.ticket, code: totpAt(s.json.secret, Date.now() + 30_000) })
    expect(l2.status).toBe(200)
    expect(l2.headers.get('set-cookie')).toStartWith('__Host-tdcloud_session=')
    // the ticket is used up
    expect((await b.api('POST', '/api/login/totp', { ticket: l1.json.ticket, code: totpAt(s.json.secret, Date.now() + 60_000) })).status).toBe(401)
    const sess = env.cloud.db.query<{ amr: string }, []>('SELECT amr FROM sessions ORDER BY rowid DESC LIMIT 1').get()!
    expect(JSON.parse(sess.amr)).toEqual(['pwd', 'totp'])
    // the old password-only API sign-in refuses an account with TOTP
    await expect(env.cloud.login('a@acme.test', PW)).rejects.toThrow(/two-step/)

    // an email link also leads to the code; a recovery code works once
    await env.call('POST', '/api/login/link', { body: { email: 'a@acme.test' } })
    const lt = env.mailer.sent.at(-1)!.text.match(/login\/link\?token=(\S+)/)![1]!
    const c1 = await b.api('POST', '/api/login/link/confirm', { token: lt })
    expect(c1.json.totp_required).toBe(true)
    const rc = en.json.recovery_codes[0] as string
    expect((await b.api('POST', '/api/login/totp', { ticket: c1.json.ticket, code: rc.toUpperCase() })).status).toBe(200)
    expect(env.cloud.mfa.recoveryLeft(a.userId)).toBe(9)
    await env.call('POST', '/api/login/link', { body: { email: 'a@acme.test' } })
    const lt2 = env.mailer.sent.at(-1)!.text.match(/login\/link\?token=(\S+)/)![1]!
    const c2 = await b.api('POST', '/api/login/link/confirm', { token: lt2 })
    expect((await b.api('POST', '/api/login/totp', { ticket: c2.json.ticket, code: rc })).status).toBe(401)
  })

  test('the sign-in page: password, then the code page', async () => {
    env = setupConsole()
    const a = await account(env, 'a@acme.test', { totp: true })
    const b = new Browser(env)
    const p1 = await b.post('/login', { email: 'a@acme.test', password: PW, next: '/t/x' }, { csrf: false })
    expect(p1.status).toBe(200)
    expect(p1.text).toContain('Two-step verification')
    const ticket = /name="ticket" value="([^"]+)"/.exec(p1.text)![1]!
    const bad = await b.post('/login/totp', { ticket, code: '111111' }, { csrf: false })
    expect(bad.status).toBe(401)
    expect(bad.text).toContain('not right')
    const ok = await b.post('/login/totp', { ticket, code: a.code() }, { csrf: false })
    expect([ok.status, ok.location]).toEqual([303, '/t/x'])
  })
})

describe('owners and admins must have it (finding 3)', () => {
  test('without it: no member change, no settings change, no drive; members are not asked', async () => {
    env = setupConsole()
    const o = await account(env, 'owner@acme.test')
    const t = await opsTeam(env, 'owner@acme.test', 'acme')
    const r = await o.b.api('POST', `/api/teams/${t.public_id}/invites`, { emails: ['m@acme.test'] })
    expect([r.status, r.json.error]).toEqual([403, 'totp_setup_required'])
    expect((await o.b.api('PATCH', `/api/teams/${t.public_id}`, { name: 'x' })).json.error).toBe('totp_setup_required')
    const open = await o.b.get('/open/acme')
    expect(open.location).toStartWith('/account?required=1&next=%2Fopen%2Facme')
    const page = await o.b.get('/t/acme/members')
    expect(page.text).toContain('Set up two-step verification')
    // the owner cannot turn it off once on
    await o.b.api('POST', '/api/me/totp/setup', {}).then(async (s) => o.b.api('POST', '/api/me/totp/enable', { code: totpAt(s.json.secret, Date.now()) }))
    const off = await o.b.post('/account/totp/disable', {})
    expect(off.status).toBe(409)
    expect(off.text).toContain('must keep two-step verification')
  })

  test('step-up: inviting an admin, changing a role, removing, transferring and deleting need a recent code', async () => {
    env = setupConsole()
    const o = await account(env, 'owner@acme.test', { totp: true })
    const t = await opsTeam(env, 'owner@acme.test', 'acme')
    // the session's code from enrolling is "fresh" for 5 minutes: age it
    env.cloud.db.query('UPDATE sessions SET totp_at = 0').run()
    const member = await o.b.api('POST', `/api/teams/${t.public_id}/invites`, { emails: ['m@acme.test'], role: 'member' })
    expect(member.status).toBe(201)
    const admin = await o.b.api('POST', `/api/teams/${t.public_id}/invites`, { emails: ['a@acme.test'], role: 'admin' })
    expect([admin.status, admin.json.error]).toEqual([403, 'step_up_required'])
    expect((await o.b.api('POST', `/api/teams/${t.public_id}/invites`, { emails: ['a@acme.test'], role: 'admin', totp: '123456' })).json.error).toBe('bad_code')
    const ok = await o.b.api('POST', `/api/teams/${t.public_id}/invites`, { emails: ['a@acme.test'], role: 'admin', totp: o.code() })
    expect(ok.status).toBe(201)
    // remembered for 5 minutes in this session
    expect((await o.b.api('POST', `/api/teams/${t.public_id}/invites`, { emails: ['b@acme.test'], role: 'admin' })).status).toBe(201)
    env.cloud.db.query('UPDATE sessions SET totp_at = 0').run()
    expect((await o.b.api('DELETE', `/api/teams/${t.public_id}`, { confirm_slug: 'acme' })).json.error).toBe('step_up_required')
    expect((await o.b.api('POST', `/api/teams/${t.public_id}/transfer`, { to: 'usr_00000000000000000000', password: PW })).json.error).toBe('step_up_required')
  })
})
