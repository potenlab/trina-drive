// Sign-in with Trina Cloud end to end on the drive (src/tdcloud/sso.ts with auth-routes.ts, people-ops.ts, hosted.ts):
// S03 (sign in again: no drive password, admins still pass the drive's second factor), S04 (back to where you were,
// no open redirect), S05 (attacks), S45 (re-authentication through the console, promotion mid-session, no setup),
// the emergency way in, the drive → console invite, and a self-hosted install that is not touched by any of it.
import { describe, expect, test } from 'bun:test'
import { cloudCommands } from '../src/tdcloud/cli'
import { setCloudConfig } from '../src/tdcloud/config'
import { setConsoleFetch } from '../src/tdcloud/invite'
import { applySync } from '../src/tdcloud/sync'
import { issueSetupToken, setupDone, setupPending } from '../src/web/auth'
import { OutboxMailer } from '../src/web/mail'
import { totpBegin, totpConfirm } from '../src/web/mfa'
import { metaGet, metaSet } from '../src/web/schema'
import { handleWeb } from '../src/web/server'
import { totpAt } from '../src/web/totp'
import { cloudSetup, claimsFor, payload, sign, USERS, type CloudEnv } from './sso-helpers'
import { PASSWORD } from './web-helpers'

const MINA = { sub: USERS.mina, email: 'mina@trina.app', name: 'Mina Kim' }
const OWNER = { sub: USERS.dion, email: 'dion@trina.app', name: 'Dion Nam', role: 'owner' as const }
const sync = (e: CloudEnv, p: unknown) => applySync({ db: e.db, cfg: e.cfg, mailer: new OutboxMailer(e.dir, true), baseUrl: 'https://trina.cloud.trina.app' }, p)
const members = (seq: number, extra: Parameters<typeof payload>[1] = []) => payload(seq, [
  { cloud_user: USERS.dion, email: 'dion@trina.app', name: 'Dion Nam', role: 'owner' }, { cloud_user: USERS.mina, email: 'mina@trina.app', name: 'Mina Kim' }, ...extra])
/** Make this session look `minutes` old (and its console sign-in too). */
const age = (e: CloudEnv, minutes: number) => {
  const t = Date.now() - minutes * 60_000
  e.db.query('UPDATE web_sessions SET created_at = ?, auth_at = ?').run(t, t)
  e.db.query('DELETE FROM web_reauth').run()
}
const audit = (e: CloudEnv, like: string) => e.db.query<{ command: string; outcome: string }, [string]>('SELECT command, outcome FROM audit WHERE command LIKE ? ORDER BY id DESC').get(like)

describe('S03: signing in again through the console', () => {
  test('a member: no drive password, a new session (the old one ends), amr in the audit', async () => {
    const e = await cloudSetup()
    await sync(e, members(1))
    const b = new e.SsoBrowser()
    const first = await b.sso(MINA, { amr: ['link'] })
    expect(first.location).toBe('/#/files')
    const old = b.cookie
    const me = (await b.call('GET', '/api/session')).data.me
    expect(me).toMatchObject({ name: 'mina', admin: false, cloud: { managed: true, has_password: false, sso_only: true, display_name: 'Mina Kim', reauth_url: '/api/sso/start?reauth=1' } })
    expect(audit(e, 'signed in with Trina Cloud (link)%')).not.toBeNull()
    // again in the same browser: the session it came with is revoked (no fixation), a new one is made
    await b.sso(MINA)
    expect(b.cookie).not.toBe(old)
    const stale = new e.Browser(); stale.cookie = old
    expect((await stale.call('GET', '/api/session')).status).toBe(401)
  })

  test('an admin with a drive second factor: the console pass leads to the second factor, then back to where they were going', async () => {
    const e = await cloudSetup({ hosted: true, publicUrl: 'https://trina.cloud.trina.app' })
    await sync(e, members(1))
    const owner = e.db.query<{ person_id: number }, []>("SELECT person_id FROM accounts WHERE email = 'dion@trina.app'").get()!.person_id
    const { secret } = totpBegin(e.db, owner, 'dion')
    expect(totpConfirm(e.db, owner, totpAt(secret, Date.now()))).toBe(true)
    const b = new e.SsoBrowser()
    const r = await b.sso(OWNER, { query: '?return=%2F%23%2Fpeople', amr: ['pwd', 'totp'] })
    const m = /^\/#\/sso-second\/([A-Za-z0-9_-]+)$/.exec(r.location)
    expect(m).not.toBeNull()
    expect(b.cookie).toBeUndefined() // no session before the second factor
    const ch = await b.call('POST', '/api/sso/second', { ticket: m![1] })
    expect(ch.status).toBe(200)
    expect(ch.data.second_factor.methods).toContain('totp')
    const done = await b.call('POST', '/api/login/second', { ticket: m![1], method: 'totp', code: totpAt(secret, Date.now() + 30_000) })
    expect(done.status).toBe(200)
    expect(done.data).toMatchObject({ me: { admin: true }, return_to: '/#/people' })
    expect((await b.call('GET', '/api/folders')).status).toBe(200)
    // the ticket was used up
    expect((await b.call('POST', '/api/sso/second', { ticket: m![1] })).status).toBe(401)
  })

  test('an owner whose console sign-in had no TOTP: signed in, and a warning in the audit', async () => {
    const e = await cloudSetup()
    await sync(e, members(1))
    await new e.SsoBrowser().sso(OWNER, { amr: ['pwd'] })
    expect(audit(e, 'warning: owner % signed in without a console TOTP%')).toMatchObject({ outcome: 'warning' })
    await new e.SsoBrowser().sso(OWNER, { amr: ['pwd', 'totp'] })
    expect(e.db.query<{ n: number }, []>("SELECT count(*) AS n FROM audit WHERE command LIKE 'warning: owner%'").get()!.n).toBe(1)
  })

  test('hosted: an admin without a drive second factor gets a session that reaches only enrolment', async () => {
    const e = await cloudSetup({ hosted: true })
    await sync(e, members(1))
    const b = new e.SsoBrowser()
    expect((await b.sso(OWNER)).location).toBe('/#/files')
    expect((await b.call('GET', '/api/folders')).data.error).toBe('second_factor_required')
    expect((await b.call('GET', '/api/session')).data.me.second_factor_required).toBe(true)
  })
})

describe('S04: back to where you were, never somewhere else', () => {
  test('return is kept on the drive (not sent to the console) and must be a path here', async () => {
    const e = await cloudSetup()
    await sync(e, members(1))
    const b = new e.SsoBrowser()
    const s = await b.start('?return=%2F%23%2Foauth%2Fabcdefghijklmnopqrstuvwx')
    expect(s.status).toBe(303)
    expect(s.location).toStartWith(`${e.cfg.issuer}/sso/authorize?team=${e.cfg.team}&state=`)
    expect(s.location).not.toContain('oauth')
    expect(s.location).not.toContain('max_age')
    const c = claimsFor(MINA, { nowS: e.nowS(), state: s.state, syncSeq: 1 })
    expect((await b.post({ assertion: sign(c as never), state: s.state })).location).toBe('/#/oauth/abcdefghijklmnopqrstuvwx')
    for (const evil of ['//evil.example/x', 'https://evil.example/', '/\\evil.example', '/%0d%0aSet-Cookie:x', 'files']) {
      const x = new e.SsoBrowser()
      expect((await x.sso(MINA, { query: `?return=${encodeURIComponent(decodeURIComponent(evil))}` })).location).toBe('/#/files')
    }
  })

  test('https: the state cookie is __Host- (Secure); a same-named cookie another subdomain could set is not read', async () => {
    const e = await cloudSetup()
    await sync(e, members(1))
    const res = await handleWeb(e.w, new Request('https://trina.cloud.trina.app/api/sso/start'), '10.0.0.1')
    const set = res.headers.get('set-cookie')!
    expect(set).toMatch(/^__Host-tdrive_sso=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/)
    const state = new URL(res.headers.get('location')!).searchParams.get('state')!
    const c = sign(claimsFor(MINA, { nowS: e.nowS(), state, syncSeq: 1 }) as never)
    const post = (cookie: string) => handleWeb(e.w, new Request('https://trina.cloud.trina.app/api/sso/callback', {
      method: 'POST', body: new URLSearchParams({ assertion: c, state }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://cloud.trina.app', cookie } }), '10.0.0.1')
    expect((await post(`tdrive_sso=${state}`)).headers.get('location')).toBe('/#/sso-error/bad_state')
    const ok = await post(`__Host-tdrive_sso=${state}`)
    expect(ok.headers.get('location')).toBe('/#/files')
    expect(ok.headers.getSetCookie().some((x) => /^tdrive_session=[^;]+; Path=\/api; HttpOnly; SameSite=Strict; Max-Age=\d+; Secure$/.test(x))).toBe(true)
  })
})

describe('S05: attacks on the callback', () => {
  test('login CSRF: an attacker\'s own valid pass posted into the victim\'s browser is refused (state is the victim\'s)', async () => {
    const e = await cloudSetup()
    await sync(e, members(1))
    const attacker = new e.SsoBrowser(), victim = new e.SsoBrowser()
    const a = await attacker.start(), v = await victim.start()
    const pass = sign(claimsFor(MINA, { nowS: e.nowS(), state: a.state, syncSeq: 1 }) as never)
    expect((await victim.post({ assertion: pass, state: a.state })).location).toBe('/#/sso-error/bad_state')
    expect((await victim.post({ assertion: pass, state: v.state })).location).toBe('/#/sso-error/bad_state')
    expect(victim.cookie).toBeUndefined()
    expect(audit(e, 'sso sign-in refused: bad_state')).toMatchObject({ outcome: 'denied' })
  })

  test('another team\'s pass, a forged role, an expired pass, a reused one: refused, nothing else said', async () => {
    const e = await cloudSetup()
    await sync(e, members(1))
    const go = async (over: Record<string, unknown>, tamper?: (a: string) => string) => {
      const b = new e.SsoBrowser()
      const s = await b.start()
      let a = sign({ ...claimsFor(MINA, { nowS: e.nowS(), state: s.state, syncSeq: 1 }), ...over })
      if (tamper) a = tamper(a)
      return (await b.post({ assertion: a, state: s.state })).location
    }
    expect(await go({ aud: 'team_00000000000000000000' })).toBe('/#/sso-error/bad_audience')
    expect(await go({}, (a) => { const [v, p, s] = a.split('.'); const c = JSON.parse(Buffer.from(p!, 'base64url').toString()); c.role = 'owner'; return [v, Buffer.from(JSON.stringify(c)).toString('base64url'), s].join('.') })).toBe('/#/sso-error/bad_signature')
    expect(await go({ iat: e.nowS() - 300, nbf: e.nowS() - 300, exp: e.nowS() - 240 })).toBe('/#/sso-error/expired')
    expect(await go({ iss: 'https://evil.example' })).toBe('/#/sso-error/bad_issuer')
    expect(await go({ kid: 'k9' })).toBe('/#/sso-error/unknown_kid')
    // too big or not a form: malformed
    const b = new e.SsoBrowser()
    const s = await b.start()
    expect((await b.post({ assertion: 'v1.' + 'a'.repeat(5000) + '.b', state: s.state })).location).toBe('/#/sso-error/malformed')
  })

  test('an office behind one address: good sign-ins are not limited like guesses; refusals still are', async () => {
    const e = await cloudSetup()
    await sync(e, members(1))
    // a 20-person office's morning from 10.0.0.1: 60 Open drives (start + callback each), more than the 50 refusals allowed
    for (let i = 0; i < 60; i++) expect((await new e.SsoBrowser().sso(MINA)).location).toBe('/#/files')
    // starting is limited on its own (300 per 15 minutes per address), not with the one-time links (30)
    const starts = e.db.query<{ n: number }, [string]>('SELECT n FROM rate_limits WHERE scope = ?').get('sso_addr')
    expect(starts?.n).toBe(60)
    expect(e.db.query('SELECT 1 FROM rate_limits WHERE scope = ?').get('login_addr')).toBeNull()
    // refused passes count: after 50 the address waits, even with a good one
    const b = new e.SsoBrowser()
    let last = ''
    for (let i = 0; i < 50; i++) { const s = await b.start(); last = (await b.post({ assertion: 'v1.bad.sig', state: s.state })).location }
    expect(last).toBe('/#/sso-error/malformed')
    expect((await new e.SsoBrowser().sso(MINA)).location).toBe('/#/sso-error/rate_limited')
  })

  test('the callback needs no Origin (the console posts it) but GET is not a way in', async () => {
    const e = await cloudSetup()
    expect((await handleWeb(e.w, new Request('http://drive.test/api/sso/callback?assertion=x&state=y'), '10.0.0.1')).status).toBe(405)
  })
})

describe('S45: re-authentication through the console', () => {
  test('six minutes later: app password and 2FA enrolment need a fresh login; the console round trip (max_age=0) gives one', async () => {
    const e = await cloudSetup()
    await sync(e, members(1))
    const b = new e.SsoBrowser()
    await b.sso(MINA)
    age(e, 6)
    const app = await b.call('POST', '/api/me/app-passwords', { name: 'Mac' })
    expect([app.status, app.data.error]).toEqual([403, 'reauth_required'])
    expect((await b.call('POST', '/api/me/totp/setup')).data.error).toBe('reauth_required')
    // a password does not exist for her
    expect((await b.call('POST', '/api/me/reauth', { password: PASSWORD })).data.error).toBe('wrong_password')
    const opts = await b.call('POST', '/api/me/reauth/options')
    expect(opts.data).toMatchObject({ methods: ['sso'], sso_url: '/api/sso/start?reauth=1' })
    // a "re-authentication" the console did not really do (auth_time old): still not fresh
    const s1 = await b.sso(MINA, { query: '?reauth=1&return=%2F%23%2Fsettings', authTime: e.nowS() - 600 })
    expect(s1.location).toBe('/#/settings')
    age(e, 6)
    expect((await b.call('POST', '/api/me/app-passwords', { name: 'Mac' })).status).toBe(403)
    const st = await b.start('?reauth=1&return=%2F%23%2Fsettings')
    expect(st.location).toEndWith('&max_age=0')
    const c = claimsFor(MINA, { nowS: e.nowS(), state: st.state, syncSeq: 1, authTime: e.nowS() - 3 })
    expect((await b.post({ assertion: sign(c as never), state: st.state })).location).toBe('/#/settings')
    await b.call('GET', '/api/session')
    expect((await b.call('POST', '/api/me/app-passwords', { name: 'Mac' })).status).toBe(200)
    expect((await b.call('POST', '/api/me/totp/setup')).status).toBe(200)
    expect(audit(e, '%re-authentication)')).not.toBeNull()
  })

  test('a passkey or authenticator code also counts as typing it again', async () => {
    const e = await cloudSetup()
    await sync(e, members(1))
    const b = new e.SsoBrowser()
    await b.sso(MINA)
    const pid = (await b.call('GET', '/api/session')).data.me.id
    const { secret } = totpBegin(e.db, pid, 'mina')
    totpConfirm(e.db, pid, totpAt(secret, Date.now()))
    age(e, 6)
    expect((await b.call('POST', '/api/me/reauth/options')).data.methods).toEqual(['totp', 'sso'])
    expect((await b.call('POST', '/api/me/reauth', { method: 'totp', code: '000000' })).data.error).toBe('bad_code')
    expect((await b.call('POST', '/api/me/reauth', { method: 'totp', code: totpAt(secret, Date.now() + 30_000) })).status).toBe(200)
    expect((await b.call('POST', '/api/me/app-passwords', { name: 'Mac' })).status).toBe(200)
  })

  test('promoted to admin mid-session on a hosted drive: told, sent to enrolment, and able to enrol via the console', async () => {
    const e = await cloudSetup({ hosted: true })
    await sync(e, members(1))
    const b = new e.SsoBrowser()
    await b.sso(MINA)
    expect((await b.call('GET', '/api/files')).status).not.toBe(403)
    age(e, 30)
    await sync(e, payload(2, [{ cloud_user: USERS.dion, email: 'dion@trina.app', role: 'owner' }, { cloud_user: USERS.mina, email: 'mina@trina.app', role: 'admin' }]))
    const me = (await b.call('GET', '/api/session')).data.me
    expect([me.admin, me.second_factor_required, me.unread_notices]).toEqual([true, true, 1])
    expect(e.db.query<{ kind: string }, [number]>('SELECT kind FROM notices WHERE person_id = ?').all(me.id).map((n) => n.kind)).toEqual(['admin_added'])
    expect((await b.call('GET', '/api/folders')).data.error).toBe('second_factor_required')
    expect((await b.call('POST', '/api/me/totp/setup')).data.error).toBe('reauth_required')
    // the enrolment screen can still ask how to re-authenticate and go to the console
    expect((await b.call('POST', '/api/me/reauth/options')).data.methods).toEqual(['sso'])
    const st = await b.start('?reauth=1&return=%2F%23%2F')
    const c = claimsFor({ ...MINA, role: 'admin' }, { nowS: e.nowS(), state: st.state, syncSeq: 2, authTime: e.nowS(), amr: ['pwd', 'totp'] })
    await b.post({ assertion: sign(c as never), state: st.state })
    await b.call('GET', '/api/session')
    const setup = await b.call('POST', '/api/me/totp/setup')
    expect(setup.status).toBe(200)
    expect((await b.call('POST', '/api/me/totp/confirm', { code: totpAt(setup.data.secret, Date.now()) })).status).toBe(200)
    expect((await b.call('GET', '/api/folders')).status).toBe(200)
  })

  test('no setup under SSO-only: /api/setup 404, no setup token, setup counted done once a console admin exists', async () => {
    const e = await cloudSetup()
    metaSet(e.db, 'web_setup_token', JSON.stringify({ hash: 'x', expires: Date.now() + 3600_000 }))
    const b = new e.SsoBrowser()
    expect((await b.call('POST', '/api/setup', { setup_token: 'tdrive_setup_x', name: 'dion', email: 'evil@example.com', password: 'a long password' })).status).toBe(404)
    expect(issueSetupToken(e.db)).toBeNull()
    const st = (await b.call('GET', '/api/state')).data
    expect(st).toMatchObject({ setup_pending: false, sso: { only: true, console_url: 'https://cloud.trina.app' } })
    // in cloud mode a password admin (the demo's dion) does not make setup "done"; a console admin does
    expect(setupDone(e.db)).toBe(false)
    await sync(e, members(1))
    expect(setupDone(e.db)).toBe(true)
    expect(metaGet(e.db, 'web_setup_token')).toBeUndefined()
  })

  test('cloud mode before SSO-only: the setup token is withdrawn when the first console admin signs in', async () => {
    const e = await cloudSetup({ ssoOnly: false })
    e.db.query('UPDATE people SET admin = 0').run() // nobody can sign in as admin yet
    const token = issueSetupToken(e.db)
    expect(token).toStartWith('tdrive_setup_')
    expect(setupPending(e.db)).toBe(true)
    await new e.SsoBrowser().sso(OWNER, { syncSeq: 1 })
    expect(setupPending(e.db)).toBe(false)
    const b = new e.Browser()
    expect((await b.call('POST', '/api/setup', { setup_token: token, name: 'mallory', email: 'm@example.com', password: 'a long password' })).data.error).toBe('bad_setup_token')
  })
})

describe('password sign-in and the emergency way in', () => {
  test('SSO-only: a console person\'s password sign-in is 409 use_sso; someone the console does not know still signs in', async () => {
    const e = await cloudSetup()
    await sync(e, members(1))
    e.bind('kim', USERS.kim)
    const r = await new e.Browser().call('POST', '/api/login', { login: 'kim', password: PASSWORD })
    expect([r.status, r.data.error]).toEqual([409, 'use_sso'])
    expect((await new e.Browser().call('POST', '/api/login', { login: 'lee', password: PASSWORD })).status).toBe(200)
    expect((await (await e.as('lee')).call('POST', '/api/me/password', { current: PASSWORD, password: 'another long one' })).status).toBe(200)
  })

  test('`people reset-link --break-glass`: a printed link, everyone told, password sign-in allowed for a day', async () => {
    const e = await cloudSetup()
    await sync(e, members(1))
    const run = async (args: string[]) => {
      const out: string[] = [], err: string[] = []
      const code = await cloudCommands.find((c) => c.name === 'people reset-link')!.run({ db: e.db, dataDir: e.dir, args, out: (s) => out.push(s), err: (s) => err.push(s) })
      return { code: code ?? 0, out: out.join('\n'), err: err.join('\n') }
    }
    expect((await run(['nobody@x.io'])).code).toBe(1)
    const r = await run(['dion@trina.app', '--break-glass', '--url', 'https://trina.cloud.trina.app'])
    expect(r.code).toBe(0)
    const link = /https:\/\/trina\.cloud\.trina\.app\/#\/reset\/([A-Za-z0-9_-]+)/.exec(r.out)![1]!
    const owner = e.db.query<{ person_id: number }, []>("SELECT person_id FROM accounts WHERE email = 'dion@trina.app'").get()!.person_id
    expect(e.db.query<{ n: number }, []>("SELECT count(*) AS n FROM notices WHERE kind = 'break_glass'").get()!.n).toBe(2) // the owner and the demo admin
    expect(audit(e, 'people reset-link dion% --break-glass%')).not.toBeNull()
    const b = new e.Browser()
    const acc = await b.call('POST', '/api/links/accept', { kind: 'reset', token: link, password: 'console is down today' })
    expect(acc.status).toBe(200)
    expect(acc.data.me.id).toBe(owner)
    expect((await new e.Browser().call('POST', '/api/login', { login: 'dion@trina.app', password: 'console is down today' })).status).toBe(200)
    // without --break-glass the window closes: sign-in says "use Trina Cloud" again
    e.db.query('UPDATE accounts SET password_ok_until = ? WHERE person_id = ?').run(Date.now() - 1, owner)
    expect((await new e.Browser().call('POST', '/api/login', { login: 'dion@trina.app', password: 'console is down today' })).data.error).toBe('use_sso')
  })
})

describe('invite from the drive (drive → console)', () => {
  test('member only, by the admin\'s console id, with the callback token; the console\'s refusals come back', async () => {
    const e = await cloudSetup()
    await sync(e, members(1))
    const seen: { url: string; auth: string | null; body: unknown }[] = []
    let answer: Response = new Response(JSON.stringify({ status: 'invited', invite: 'inv_000000000099' }), { status: 201 })
    setConsoleFetch(async (url, init) => { seen.push({ url, auth: new Headers(init.headers).get('authorization'), body: JSON.parse(String(init.body)) }); return answer })
    try {
      const owner = new e.SsoBrowser()
      await owner.sso(OWNER)
      const r = await owner.call('POST', '/api/cloud/invite', { email: 'new@partner.example', role: 'admin' })
      expect(r.data).toEqual({ status: 'invited', invite: 'inv_000000000099' })
      expect(seen[0]).toEqual({ url: 'https://cloud.trina.app/api/team-callback/invites', auth: `Bearer ${e.cfg.callbackToken}`, body: { email: 'new@partner.example', role: 'member', by_cloud_user: USERS.dion } })
      const mina = new e.SsoBrowser()
      await mina.sso(MINA)
      expect((await mina.call('POST', '/api/cloud/invite', { email: 'x@y.io' })).status).toBe(403)
      // an admin the console does not know (the demo's dion) cannot ask
      expect((await (await e.as('lee')).call('POST', '/api/cloud/invite', { email: 'x@y.io' })).status).toBe(403)
      answer = new Response(JSON.stringify({ error: 'not_admin' }), { status: 403 })
      expect((await owner.call('POST', '/api/cloud/invite', { email: 'x@y.io' })).data.error).toBe('not_admin')
      expect(seen).toHaveLength(2)
    } finally { setConsoleFetch(null) }
  })
})

describe('a self-hosted install (no TDRIVE_CLOUD_* environment) is untouched', () => {
  test('no SSO routes, password sign-in and setup as before, no cloud field', async () => {
    const e = await cloudSetup()
    setCloudConfig(e.db, null)
    const b = new e.SsoBrowser()
    expect((await b.start()).status).toBe(404)
    expect((await b.post({ assertion: 'x', state: 'y' })).status).toBe(404)
    expect((await b.call('POST', '/api/cloud/invite', { email: 'x@y.io' })).status).toBe(401)
    const dion = await e.as('dion')
    expect((await dion.call('POST', '/api/cloud/invite', { email: 'x@y.io' })).status).toBe(404)
    const me = (await dion.call('GET', '/api/session')).data.me
    expect('cloud' in me).toBe(false)
    expect((await dion.call('GET', '/api/state')).data.sso).toBeUndefined()
    expect(setupDone(e.db)).toBe(true)
    expect((await dion.call('POST', '/api/people', { name: 'newbie', email: 'n@example.com' })).status).toBe(200)
    expect((await dion.call('POST', '/api/me/reauth/options')).data.methods).toEqual(['password'])
    expect((await dion.call('POST', '/api/me/reauth', { password: PASSWORD })).status).toBe(200)
  })
})
