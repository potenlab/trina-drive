// Member sync, console → drive (contract "Member sync", review finding 5), and S02 on the control-plane side:
// an operator-made complimentary team is provisioned with the SSO env, its "ready" mail carries no setup token (finding
// 6), its members reach the drive in order (seq), failures are retried until they succeed (shown red), a team that
// was paused applies the current membership before it counts as running, and usage comes back for Plan & usage.
import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { teamBySlug } from '../src/db'
import { account, Browser, opsTeam, PW, runJobs, setupConsole, type ConsoleEnv } from './console-helpers'

const FIXTURE = JSON.parse(fs.readFileSync(path.resolve(import.meta.dir, '../../../test/fixtures/sso-v1.json'), 'utf8'))

let env: ConsoleEnv
afterEach(() => env?.cleanup())

const inviteLink = (to: string) => env.mailer.sent.filter((m) => m.to === to && /invited/.test(m.subject)).at(-1)!.text.match(/\/invite\/(\S+)/)![1]!
async function addMember(o: Awaited<ReturnType<typeof account>>, teamId: string, email: string) {
  await o.b.api('POST', `/api/teams/${teamId}/invites`, { emails: [email] })
  const m = await account(env, email)
  await m.b.api('POST', '/api/invites/accept', { token: inviteLink(email) })
  return m
}

describe('S02: an operator-made team, opened through the console', () => {
  test('provisioned with the SSO env, a "ready" mail without a token, members synced, the owner sets up 2FA and opens it', async () => {
    env = setupConsole()
    await env.call('POST', '/api/signup', { body: { email: 'contact@trina.test', password: PW } })
    const vt = env.mailer.sent.at(-1)!.text.match(/verify\?token=(\S+)/)![1]!
    await env.call('POST', '/api/verify', { body: { token: vt } })
    const t = await opsTeam(env, 'contact@trina.test', 'trina')
    expect([t.status, t.plan, t.sub_status]).toEqual(['active', 'team', 'complimentary'])
    const ready = env.mailer.sent.find((m) => m.to === 'contact@trina.test' && /Your Trina Drive is ready/.test(m.subject))!
    expect(ready.text).toContain('https://cloud.example.com/open/trina')
    expect(ready.text).not.toMatch(/#token=|tdrive_setup_/)
    expect(env.cloud.db.query("SELECT count(*) AS n FROM audit WHERE action = 'team.setup_link_sent'").get()).toEqual({ n: 0 })
    // the owner reached the drive with the first sync
    const d = env.drive('trina')
    expect(d.applied).toBeGreaterThan(0)
    expect(d.member('contact@trina.test')).toMatchObject({ admin: true, active: true })
    // the owner signs in; Open drive asks for two-step verification first, then hands over
    const b = new Browser(env)
    await b.post('/login', { email: 'contact@trina.test', password: PW }, { csrf: false })
    const open1 = await b.get('/open/trina')
    expect(open1.location).toStartWith('/account?required=1')
    const acct = await b.get(open1.location!)
    expect(acct.text).toContain('Set up two-step verification to continue')
    const begin = await b.post('/account/totp/begin', { next: '/open/trina' })
    const secret = /<p class="secret">([^<]+)<\/p>/.exec(begin.text)![1]!.replace(/\s/g, '')
    const { totpAt } = await import('../src/totp')
    const conf = await b.post('/account/totp/confirm', { code: totpAt(secret, Date.now()), next: '/open/trina' })
    expect(conf.text).toContain('Save your recovery codes')
    expect(conf.text).toContain('href="/open/trina"')
    const open2 = await b.get('/open/trina')
    expect(open2.location).toBe('https://trina.cloud.example.com/api/sso/start?return=%2F')
  })

  test('TDCLOUD_SSO=0 (an older product image): the setup link as before, no SSO env', async () => {
    env = setupConsole({ TDCLOUD_SSO: '0' })
    await env.cloud.adminCreateTeam({ email: 'o@acme.test', slug: 'acme', actor: 'admin:test' })
    await runJobs(env)
    expect(env.mailer.sent.find((m) => /ready/.test(m.subject))!.text).toContain('#token=tdrive_setup_')
    expect(env.driver.instances.get('acme')!.spec.env.TDRIVE_SSO_ONLY).toBeUndefined()
    expect(env.driver.calls.some((c) => c.includes('sync-members'))).toBe(false)
  })
})

describe('the payload', () => {
  test('version 2, the contract\'s fields in order, the whole desired state, seq strictly increasing', async () => {
    env = setupConsole()
    const o = await account(env, 'owner@acme.test', { totp: true, name: 'Dion Nam' })
    const t = await opsTeam(env, 'owner@acme.test', 'acme')
    await addMember(o, t.public_id, 'mina@acme.test')
    await o.b.api('POST', `/api/teams/${t.public_id}/invites`, { emails: ['jae@partner.test'] })
    await runJobs(env)
    const p = env.drive('acme').payloads.at(-1)!
    expect(Object.keys(p)).toEqual(Object.keys(FIXTURE.member_sync.payload))
    expect(Object.keys(p.members[0]!)).toEqual(Object.keys(FIXTURE.member_sync.payload.members[0]))
    expect(p).toMatchObject({ version: 2, team: t.public_id })
    expect(p.members.map((m) => [m.email, m.role, m.status, m.cloud_user ? 'usr' : null])).toEqual([
      ['owner@acme.test', 'owner', 'active', 'usr'], ['mina@acme.test', 'member', 'active', 'usr'], ['jae@partner.test', 'member', 'invited', null]])
    const seqs = env.drive('acme').payloads.map((x) => x.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)
    // an older payload arriving late is refused by the drive (stale) and changes nothing
    const old = { ...env.drive('acme').payloads[0]! }
    expect(env.drive('acme').apply(old).out).toMatchObject({ applied: false, reason: 'stale' })
  })

  test('a drive ahead of the console (a restored control database): the console jumps past it and sends again', async () => {
    env = setupConsole()
    await account(env, 'owner@acme.test', { totp: true })
    const t = await opsTeam(env, 'owner@acme.test', 'acme')
    env.drive('acme').applied = 500
    env.cloud.sync.changed(t.id)
    await runJobs(env)
    const now = teamBySlug(env.cloud.db, 'acme')!
    expect(now.sync_seq).toBeGreaterThan(500)
    expect(now.sync_applied_seq).toBe(env.drive('acme').applied)
    expect(env.cloud.db.query("SELECT count(*) AS n FROM audit WHERE action = 'sync.seq_jumped'").get()).toEqual({ n: 1 })
  })
})

describe('failures (finding 5)', () => {
  test('a removal the drive cannot take is retried until it can (red in Members, ops told once), then applied', async () => {
    env = setupConsole()
    const o = await account(env, 'owner@acme.test', { totp: true })
    const t = await opsTeam(env, 'owner@acme.test', 'acme')
    const m = await addMember(o, t.public_id, 'mina@acme.test')
    await runJobs(env)
    const sub = env.cloud.db.query<{ public_id: string }, []>("SELECT public_id FROM users WHERE email = 'mina@acme.test'").get()!.public_id
    env.drive('acme').fail = 'people_limit'
    await o.b.api('DELETE', `/api/teams/${t.public_id}/members/${sub}`, {})
    for (let i = 0; i < 8; i++) await runJobs(env)
    const job = env.cloud.db.query<{ attempts: number; done_at: number | null; run_at: number }, []>("SELECT attempts, done_at, run_at FROM jobs WHERE kind = 'sync_members' ORDER BY id DESC").get()!
    expect(job.done_at).toBeNull()
    expect(job.attempts).toBeGreaterThan(5)
    expect(env.mailer.sent.filter((x) => /member sync for team acme keeps failing/.test(x.subject))).toHaveLength(1)
    const page = await o.b.get('/t/acme/members')
    expect(page.text).toContain('Removal pending')
    expect(page.text).toContain('has not taken the latest changes')
    expect((await o.b.api('GET', `/api/teams/${t.public_id}/members`)).json.sync.in_sync).toBe(false)
    expect(env.drive('acme').people.get(sub)!.active).toBe(true)
    // the drive recovers
    env.drive('acme').fail = null
    await runJobs(env)
    expect(env.drive('acme').people.get(sub)!.active).toBe(false)
    const after = await o.b.get('/t/acme/members')
    expect(after.text).not.toContain('Removal pending')
    expect(teamBySlug(env.cloud.db, 'acme')!.sync_failing_since).toBeNull()
    void m
  })

  test('wake: removed while paused → the drive applies it before the team counts as running; if it cannot, it stays paused', async () => {
    env = setupConsole({ TDCLOUD_MAX_FREE_TEAMS: '5' })
    const o = await account(env, 'owner@free.test', { totp: true })
    const t = await opsTeam(env, 'owner@free.test', 'freeco', 'free')
    await addMember(o, t.public_id, 'mina@free.test')
    await runJobs(env)
    const sub = env.cloud.db.query<{ public_id: string }, []>("SELECT public_id FROM users WHERE email = 'mina@free.test'").get()!.public_id
    // paused (inactive): the container stops
    await env.cloud.suspend(teamBySlug(env.cloud.db, 'freeco')!, 'inactive', 'system')
    expect(env.driver.instances.get('freeco')!.state).toBe('stopped')
    await o.b.api('DELETE', `/api/teams/${t.public_id}/members/${sub}`, {})
    await runJobs(env) // nothing to send to a stopped team
    expect(env.drive('freeco').people.get(sub)!.active).toBe(true)
    // the wake fails while the drive refuses the sync: stopped again, still paused
    env.drive('freeco').fail = 'bad_json'
    await expect(env.cloud.free.wake(teamBySlug(env.cloud.db, 'freeco')!)).rejects.toThrow(/member sync/)
    expect(env.driver.instances.get('freeco')!.state).toBe('stopped')
    expect(env.cloud.free.isPaused(teamBySlug(env.cloud.db, 'freeco')!)).toBe(true)
    // then it works: applied first, running after
    env.drive('freeco').fail = null
    await env.cloud.free.wake(teamBySlug(env.cloud.db, 'freeco')!)
    expect(env.drive('freeco').people.get(sub)!.active).toBe(false)
    expect(teamBySlug(env.cloud.db, 'freeco')!.status).toBe('active')
    const calls = env.driver.calls.slice(env.driver.calls.lastIndexOf('start freeco'))
    expect(calls[1]).toBe('exec freeco cloud sync-members')
  })

  test('a console password change signs the person out of the drives too (member.sessions_revoked)', async () => {
    env = setupConsole()
    const o = await account(env, 'owner@acme.test', { totp: true })
    await opsTeam(env, 'owner@acme.test', 'acme')
    const r = await o.b.post('/account/password', { password: 'a brand new password' })
    expect(r.location).toBe('/account?ok=password')
    await runJobs(env)
    expect(env.drive('acme').payloads.at(-1)!.events).toEqual([expect.objectContaining({ type: 'member.sessions_revoked', reason: 'console_password_changed' })])
  })
})

describe('usage', () => {
  test('hourly `cloud usage --json` fills Plan & usage', async () => {
    env = setupConsole()
    const o = await account(env, 'owner@acme.test', { totp: true })
    await opsTeam(env, 'owner@acme.test', 'acme')
    env.drive('acme').usage = { people: 7, ai_people_30d: 4, files_bytes: 3 * 1024 ** 3, trash_bytes: 1024 ** 2, versions_bytes: 512 * 1024 ** 2, quota_bytes: 100 * 1024 ** 3, last_activity_at: Date.now() - 60_000 }
    env.cloud.scheduleBackups()
    await runJobs(env)
    const page = await o.b.get('/t/acme/usage')
    expect(page.text).toContain('Files 3.0 GB')
    expect(page.text).toContain('Earlier versions 512 MB')
    expect(page.text).toMatch(/<b>4<\/b><span>people whose AI/)
    // an older drive without the command: no error, no retry storm
    env.drive('acme').usage = null
    env.cloud.db.query('UPDATE teams SET usage_checked_at = 0').run()
    env.cloud.scheduleBackups()
    await runJobs(env)
    expect(env.cloud.db.query("SELECT count(*) AS n FROM jobs WHERE kind = 'usage' AND done_at IS NULL").get()).toEqual({ n: 0 })
  })
})
