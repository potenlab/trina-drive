// The console side of the SSO contract (docs/SSO-CONTRACT.md, test/fixtures/sso-v1.json): the signer reproduces the
// fixture's assertions byte for byte (Ed25519 is deterministic), keys rotate and are published in each team's env, and
// "Open drive" → /sso/authorize hands a correct, single-audience assertion to the drive with form_post (review #9).
import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { keyFromSeed, publicX, signAssertion, stateHash, verifySignature, type Claims } from '../src/sso'
import { teamBySlug } from '../src/db'
import { account, Browser, opsTeam, PW, runJobs, setupConsole, type ConsoleEnv } from './console-helpers'

const FIXTURE = JSON.parse(fs.readFileSync(path.resolve(import.meta.dir, '../../../test/fixtures/sso-v1.json'), 'utf8'))
const seed = (k: string) => Buffer.from(FIXTURE.test_keys[k].seed, 'base64url')

let env: ConsoleEnv
afterEach(() => env?.cleanup())

describe('contract vectors', () => {
  test('the fixture\'s valid assertions are exactly what this signer makes', () => {
    const keys = { k1: keyFromSeed(seed('k1')), k2: keyFromSeed(seed('k2')) }
    expect(publicX(keys.k1)).toBe(FIXTURE.test_keys.k1.x)
    const valid = FIXTURE.vectors.filter((v: { expect: { ok: boolean } }) => v.expect.ok)
    expect(valid.length).toBeGreaterThanOrEqual(5)
    for (const v of valid) {
      const claims = v.expect.claims as Claims
      expect([v.name, signAssertion(claims, keys[claims.kid as 'k1' | 'k2'])]).toEqual([v.name, v.assertion])
      expect(claims.state_hash).toBe(stateHash(v.state))
    }
    // and the fixture's published keys verify them
    const pub = JSON.parse(FIXTURE.env.TDRIVE_CLOUD_SSO_KEYS)
    for (const v of valid) expect(verifySignature(v.assertion, pub)).not.toBeNull()
    const tampered = FIXTURE.vectors.find((v: { name: string }) => v.name === 'bad_signature')
    expect(verifySignature(tampered.assertion, pub)).toBeNull()
  })

  test('the claim set is the contract\'s, in its order', () => {
    const c = FIXTURE.vectors[0].expect.claims
    const mine = JSON.parse(Buffer.from(signAssertion(c, keyFromSeed(seed('k1'))).split('.')[1]!, 'base64url').toString())
    expect(Object.keys(mine)).toEqual(FIXTURE.assertion.required)
  })
})

describe('keys', () => {
  test('made on first use and wrapped; rotate publishes, activate signs, retire unpublishes; each team\'s env lists them', async () => {
    env = setupConsole()
    const k1 = await env.cloud.sso.ensure()
    expect(k1).toBe('k1')
    const row = env.cloud.db.query<{ private_key_enc: string }, []>('SELECT private_key_enc FROM sso_keys').get()!
    expect(row.private_key_enc).toStartWith('l1.') // wrapped by the key wrapper (KMS in production)
    await account(env, 'owner@acme.test', { totp: true })
    const t = await opsTeam(env, 'owner@acme.test', 'acme')
    const e = env.driver.instances.get('acme')!.spec.env
    expect(e).toMatchObject({ TDRIVE_CLOUD_ISSUER: 'https://cloud.example.com', TDRIVE_CLOUD_TEAM: t.public_id, TDRIVE_CLOUD_CONSOLE_URL: 'https://cloud.example.com', TDRIVE_SSO_ONLY: '1' })
    expect(JSON.parse(e.TDRIVE_CLOUD_SSO_KEYS!).map((k: { kid: string }) => k.kid)).toEqual(['k1'])
    const k2 = await env.cloud.sso.rotate('admin:test')
    expect(env.cloud.sso.published().map((k) => k.kid)).toEqual(['k1', 'k2'])
    env.cloud.sso.activate(k2, 'admin:test')
    expect(env.cloud.sso.published().map((k) => k.kid)).toEqual(['k2', 'k1'])
    expect(() => env.cloud.sso.retire('k2', 'admin:test')).toThrow(/activate another/)
    env.cloud.sso.retire('k1', 'admin:test')
    expect(env.cloud.sso.published().map((k) => k.kid)).toEqual(['k2'])
    expect(env.cloud.spec(teamBySlug(env.cloud.db, 'acme')!).env.TDRIVE_CLOUD_SSO_KEYS).toBe(JSON.stringify(env.cloud.sso.published()))
  })
})

const STATE = 'Q2hvb3NlIGEgbmV3IHN0YXRlIGV2ZXJ5IHRpbWUhIQ'
const assertionOf = (html: string) => {
  const a = /name="assertion" value="([^"]+)"/.exec(html)?.[1]
  return a ? { assertion: a, claims: JSON.parse(Buffer.from(a.split('.')[1]!, 'base64url').toString()) as Claims, action: /<form method="post" action="([^"]+)" data-autosubmit/.exec(html)![1]! } : null
}

describe('Open drive → /sso/authorize → form_post', () => {
  test('a member gets a one-time assertion for this team only, posted to the team\'s own callback', async () => {
    env = setupConsole()
    const o = await account(env, 'owner@acme.test', { totp: true, name: 'Dion Nam' })
    const t = await opsTeam(env, 'owner@acme.test', 'acme')
    await opsTeam(env, 'owner@acme.test', 'globex')
    const open = await o.b.get('/open/acme')
    expect(open.location).toBe('https://acme.cloud.example.com/api/sso/start?return=%2F')

    const az = await o.b.get(`/sso/authorize?team=${t.public_id}&state=${STATE}`)
    expect(az.status).toBe(200)
    const csp = az.headers.get('content-security-policy')!
    expect(csp).toContain("form-action 'self' https://*.cloud.example.com")
    expect(az.text).toContain('src="/static/console.js"') // auto-submits
    const got = assertionOf(az.text)!
    expect(got.action).toBe('https://acme.cloud.example.com/api/sso/callback')
    expect(az.text).toContain(`name="state" value="${STATE}"`)
    const sub = env.cloud.db.query<{ public_id: string }, []>("SELECT public_id FROM users WHERE email = 'owner@acme.test'").get()!.public_id
    const now = Math.floor(Date.now() / 1000)
    expect(got.claims).toMatchObject({ iss: 'https://cloud.example.com', aud: t.public_id, kid: 'k1', sub, email: 'owner@acme.test', name: 'Dion Nam', role: 'owner', state_hash: stateHash(STATE), amr: ['pwd', 'totp'] })
    expect(got.claims.exp - got.claims.iat).toBe(60)
    expect(got.claims.nbf).toBe(got.claims.iat)
    expect(Math.abs(got.claims.iat - now)).toBeLessThan(5)
    expect(got.claims.jti).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(got.claims.sync_seq).toBe(teamBySlug(env.cloud.db, 'acme')!.sync_seq)
    // the drive's env verifies it
    expect(verifySignature(got.assertion, JSON.parse(env.driver.instances.get('acme')!.spec.env.TDRIVE_CLOUD_SSO_KEYS!))).not.toBeNull()
    // each one is new
    const again = assertionOf((await o.b.get(`/sso/authorize?team=${t.public_id}&state=${STATE}`)).text)!
    expect(again.claims.jti).not.toBe(got.claims.jti)
    // the audit names who and where only
    const row = env.cloud.db.query<{ detail: string }, []>("SELECT detail FROM audit WHERE action = 'sso.issued' ORDER BY id DESC").get()!
    expect(row.detail).not.toContain(got.claims.jti)
    expect(row.detail).not.toContain(STATE)
    expect(JSON.parse(row.detail)).toMatchObject({ sub, aud: t.public_id })
  })

  test('signed out → sign in and back; not a member → the same 404 as no team; a broken state → 400', async () => {
    env = setupConsole()
    const own = await account(env, 'owner@acme.test', { totp: true })
    const t = await opsTeam(env, 'owner@acme.test', 'acme')
    const anon = new Browser(env)
    const r = await anon.get(`/sso/authorize?team=${t.public_id}&state=${STATE}`)
    expect(r.location).toBe(`/login?next=${encodeURIComponent(`/sso/authorize?team=${t.public_id}&state=${STATE}`)}`)
    // and the sign-in comes back there
    const x = await account(env, 'x@other.test')
    const nm = await x.b.get(`/sso/authorize?team=${t.public_id}&state=${STATE}`)
    const none = await x.b.get(`/sso/authorize?team=team_00000000000000000000&state=${STATE}`)
    expect([nm.status, none.status]).toEqual([404, 404])
    expect(nm.text).toBe(none.text)
    expect((await x.b.get('/open/acme')).text).toBe(none.text)
    const o = new Browser(env)
    const l = await o.post('/login', { email: 'owner@acme.test', password: PW, next: `/sso/authorize?team=${t.public_id}&state=${STATE}` }, { csrf: false })
    expect(l.text).toContain('Two-step verification')
    expect((await own.b.get(`/sso/authorize?team=${t.public_id}&state=bad!`)).status).toBe(400)
  })

  test('max_age=0 (the drive\'s re-authentication): password and code again, then a fresh auth_time', async () => {
    env = setupConsole()
    const o = await account(env, 'owner@acme.test', { totp: true })
    const t = await opsTeam(env, 'owner@acme.test', 'acme')
    env.cloud.db.query('UPDATE sessions SET auth_time = ?').run(Date.now() - 3600_000)
    const q = `team=${t.public_id}&state=${STATE}&max_age=0`
    const page = await o.b.get(`/sso/authorize?${q}`)
    expect(page.text).toContain('Confirm it')
    expect(assertionOf(page.text)).toBeNull()
    const bad = await o.b.post('/sso/authorize', { team: t.public_id, state: STATE, max_age: '0', password: PW, code: '000000' })
    expect(bad.status).toBe(401)
    const ok = await o.b.post('/sso/authorize', { team: t.public_id, state: STATE, max_age: '0', password: PW, code: o.code() })
    const got = assertionOf(ok.text)!
    expect(Math.abs(got.claims.auth_time - Math.floor(Date.now() / 1000))).toBeLessThan(5)
    expect(got.claims.amr).toEqual(['pwd', 'totp'])
  })

  test('a member (no TOTP needed) gets role member; a paused free team goes to its wake page', async () => {
    env = setupConsole({ TDCLOUD_MAX_FREE_TEAMS: '5' })
    const o = await account(env, 'owner@acme.test', { totp: true })
    const t = await opsTeam(env, 'owner@acme.test', 'acme', 'free')
    await o.b.api('POST', `/api/teams/${t.public_id}/invites`, { emails: ['m@acme.test'] })
    const m = await account(env, 'm@acme.test')
    const token = env.mailer.sent.filter((x) => x.to === 'm@acme.test' && /invited/.test(x.subject)).at(-1)!.text.match(/\/invite\/(\S+)/)![1]!
    await m.b.api('POST', '/api/invites/accept', { token })
    await runJobs(env)
    const got = assertionOf((await m.b.get(`/sso/authorize?team=${t.public_id}&state=${STATE}`)).text)!
    expect([got.claims.role, got.claims.amr]).toEqual(['member', ['pwd']])
    env.cloud.db.query("UPDATE teams SET status = 'suspended', suspend_reason = 'inactive' WHERE id = ?").run(t.id)
    expect((await m.b.get('/open/acme')).location).toBe('/wake/acme')
  })
})
