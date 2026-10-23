// Members and invites (plan 2.3; S06, S08; review findings 5 and 7): invites are bound to the invited address, the
// same answer whether or not an account exists, roles and their rules, removal → member sync with revocation, the
// Free people limit, and invites from the drive through the team callback (members only, by a console admin).
import { afterEach, describe, expect, test } from 'bun:test'
import { teamBySlug } from '../src/db'
import { account, Browser, opsTeam, PW, runJobs, setupConsole, type ConsoleEnv } from './console-helpers'

let env: ConsoleEnv
afterEach(() => env?.cleanup())

const inviteLink = (to: string) => env.mailer.sent.filter((m) => m.to === to && /invited/.test(m.subject)).at(-1)!.text.match(/\/invite\/(\S+)/)![1]!

describe('S06: invite → mail → sign up (address fixed) → accept → on the drive', () => {
  test('the whole way, once', async () => {
    env = setupConsole()
    const o = await account(env, 'owner@acme.test', { totp: true, name: 'Dion' })
    const t = await opsTeam(env, 'owner@acme.test', 'acme')
    await account(env, 'has@acme.test')
    // the same answer for an address with and without an account
    const r = await o.b.api('POST', `/api/teams/${t.public_id}/invites`, { emails: ['mina@acme.test', 'has@acme.test'] })
    expect(r.status).toBe(201)
    const [a, b] = r.json.invites
    expect(Object.keys(a)).toEqual(Object.keys(b))
    expect([a.id, b.id].every((x: string) => /^inv_\d{12}$/.test(x))).toBe(true)
    const mail = env.mailer.sent.find((m) => m.to === 'mina@acme.test')!
    expect(mail.subject).toBe("You're invited to Acme on Trina Cloud")
    expect(mail.text).toContain('Dion invited you')
    expect(mail.text).toContain('only for mina@acme.test')
    // invited people go to the drive too (an invited row, so they can be shared with before they sign up)
    await runJobs(env)
    const drive = env.drive('acme')
    expect(drive.member('mina@acme.test')).toMatchObject({ active: true, cloud_user: null })

    const token = inviteLink('mina@acme.test')
    const mina = new Browser(env)
    const pg = await mina.get(`/invite/${token}`)
    expect(pg.text).toContain('Join Acme')
    expect(pg.text).toContain('value="mina@acme.test" readonly')
    const su = await mina.post(`/invite/${token}/signup`, { name: 'Mina Kim', password: PW }, { csrf: false })
    expect([su.status, su.location]).toEqual([303, '/t/acme?ok=joined'])
    const minaId = env.cloud.db.query<{ id: number; verified_at: number | null; public_id: string }, []>("SELECT id, verified_at, public_id FROM users WHERE email = 'mina@acme.test'").get()!
    expect(minaId.verified_at).not.toBeNull() // the link proved the mailbox
    expect(env.cloud.members.role(t.id, minaId.id)).toBe('member')
    // used once
    expect((await new Browser(env).get(`/invite/${token}`)).status).toBe(404)
    // the drive gets the member, linked to the invited row (the first payload carries both ids)
    await runJobs(env)
    const last = drive.payloads.at(-1)!
    const entry = last.members.find((m) => m.email === 'mina@acme.test')!
    expect(entry).toMatchObject({ cloud_user: minaId.public_id, status: 'active', role: 'member', name: 'Mina Kim' })
    expect(entry.invite).toMatch(/^inv_/)
    expect(drive.member('mina@acme.test')).toMatchObject({ active: true, cloud_user: minaId.public_id, admin: false })
    await runJobs(env)
    expect(env.cloud.db.query('SELECT count(*) AS n FROM invites WHERE linked_at IS NOT NULL').get()).toEqual({ n: 1 })
    // the console audit
    const actions = env.cloud.db.query<{ action: string }, [number]>('SELECT action FROM audit WHERE team_id = ? ORDER BY id').all(t.id).map((x) => x.action)
    expect(actions).toEqual(expect.arrayContaining(['member.invited', 'member.joined']))
  })

  test('finding 7: an invite works only for its address (a forwarded admin invite is useless)', async () => {
    env = setupConsole()
    const o = await account(env, 'owner@acme.test', { totp: true })
    const t = await opsTeam(env, 'owner@acme.test', 'acme')
    await o.b.api('POST', `/api/teams/${t.public_id}/invites`, { emails: ['boss2@acme.test'], role: 'admin' })
    const token = inviteLink('boss2@acme.test')
    const eve = await account(env, 'eve@evil.test')
    const page = await eve.b.get(`/invite/${token}`)
    expect(page.status).toBe(403)
    expect(page.text).toContain('works only for boss2@acme.test')
    const r = await eve.b.api('POST', '/api/invites/accept', { token })
    expect([r.status, r.json.error]).toEqual([403, 'wrong_account'])
    const form = await eve.b.post(`/invite/${token}/accept`)
    expect(form.status).toBe(403)
    expect(env.cloud.members.role(t.id, eve.userId)).toBeNull()
    // the invite is still open for its owner; a signed-out visitor with an account is sent to sign in as that address
    const boss = await account(env, 'boss2@acme.test')
    expect((await new Browser(env).get(`/invite/${token}`)).text).toContain('Sign in to join')
    expect((await boss.b.api('POST', '/api/invites/accept', { token })).status).toBe(200)
    expect(env.cloud.members.role(t.id, boss.userId)).toBe('admin')
  })

  test('revoke, resend (the old link stops working), and an event for the drive', async () => {
    env = setupConsole()
    const o = await account(env, 'owner@acme.test', { totp: true })
    const t = await opsTeam(env, 'owner@acme.test', 'acme')
    const inv = (await o.b.api('POST', `/api/teams/${t.public_id}/invites`, { emails: ['x@acme.test'] })).json.invites[0].id
    const first = inviteLink('x@acme.test')
    expect((await o.b.api('POST', `/api/teams/${t.public_id}/invites/${inv}/resend`, {})).status).toBe(200)
    expect(inviteLink('x@acme.test')).not.toBe(first)
    expect((await new Browser(env).get(`/invite/${first}`)).status).toBe(404)
    await runJobs(env)
    expect((await o.b.api('DELETE', `/api/teams/${t.public_id}/invites/${inv}`, {})).status).toBe(200)
    await runJobs(env)
    const p = env.drive('acme').payloads.at(-1)!
    expect(p.members.some((m) => m.email === 'x@acme.test')).toBe(false)
    expect(p.events).toEqual([expect.objectContaining({ type: 'invite.revoked', invite: inv })])
    expect(env.drive('acme').member('x@acme.test')!.active).toBe(false)
  })
})

describe('S08: member → admin, then removal', () => {
  test('the drive gets the role, then the removal with every credential cut; the next SSO is refused', async () => {
    env = setupConsole()
    const o = await account(env, 'owner@acme.test', { totp: true })
    const t = await opsTeam(env, 'owner@acme.test', 'acme')
    await o.b.api('POST', `/api/teams/${t.public_id}/invites`, { emails: ['mina@acme.test'] })
    const mina = await account(env, 'mina@acme.test')
    await mina.b.api('POST', '/api/invites/accept', { token: inviteLink('mina@acme.test') })
    await runJobs(env)
    const drive = env.drive('acme')
    const sub = env.cloud.db.query<{ public_id: string }, []>("SELECT public_id FROM users WHERE email = 'mina@acme.test'").get()!.public_id
    drive.people.get(sub)!.tokens = 3 // she made tokens on the drive

    const up = await o.b.api('PATCH', `/api/teams/${t.public_id}/members/${sub}`, { role: 'admin' })
    expect(up.status).toBe(200)
    await runJobs(env)
    expect(drive.people.get(sub)).toMatchObject({ admin: true, active: true })
    expect(env.cloud.db.query("SELECT detail FROM audit WHERE action = 'member.role_changed'").get()).toEqual({ detail: JSON.stringify({ user: sub, from: 'member', to: 'admin' }) })

    // an admin (not the owner) may not remove another admin; nobody removes the owner
    const ownerSub = env.cloud.db.query<{ public_id: string }, []>("SELECT public_id FROM users WHERE email = 'owner@acme.test'").get()!.public_id
    await (await import('./console-helpers')).enrollTotp(mina.b)
    expect((await mina.b.api('DELETE', `/api/teams/${t.public_id}/members/${ownerSub}`, { totp: mina.code() })).json.error).toBe('owner_role')

    const before = drive.applied
    const rm = await o.b.api('DELETE', `/api/teams/${t.public_id}/members/${sub}`, {})
    expect(rm.status).toBe(200)
    await runJobs(env)
    const p = drive.payloads.at(-1)!
    expect(p.seq).toBeGreaterThan(before)
    expect(p.members.some((m) => m.cloud_user === sub)).toBe(false)
    expect(p.events).toEqual([expect.objectContaining({ type: 'member.removed', cloud_user: sub })])
    expect(drive.people.get(sub)).toMatchObject({ active: false, tokens: 0 })
    expect(env.mailer.sent.some((m) => m.to === 'mina@acme.test' && /removed from Acme/.test(m.subject))).toBe(true)
    // the console no longer lets her in
    expect((await mina.b.get('/t/acme')).status).toBe(404)
    const az = await mina.b.get(`/sso/authorize?team=${t.public_id}&state=${'s'.repeat(43)}`)
    expect(az.status).toBe(404)
    // the event is delivered once
    await runJobs(env)
    expect(env.cloud.db.query('SELECT count(*) AS n FROM sync_events WHERE delivered_seq IS NULL').get()).toEqual({ n: 0 })
  })

  test('transfer: to an admin, with the password and a code; the old owner becomes admin', async () => {
    env = setupConsole()
    const o = await account(env, 'owner@acme.test', { totp: true })
    const t = await opsTeam(env, 'owner@acme.test', 'acme')
    await o.b.api('POST', `/api/teams/${t.public_id}/invites`, { emails: ['a@acme.test'], role: 'admin' })
    const a = await account(env, 'a@acme.test')
    await a.b.api('POST', '/api/invites/accept', { token: inviteLink('a@acme.test') })
    const aSub = env.cloud.db.query<{ public_id: string }, []>("SELECT public_id FROM users WHERE email = 'a@acme.test'").get()!.public_id
    expect((await o.b.api('POST', `/api/teams/${t.public_id}/transfer`, { to: aSub, password: 'wrong wrong wrong' })).json.error).toBe('bad_password')
    expect((await o.b.api('POST', `/api/teams/${t.public_id}/transfer`, { to: aSub, password: PW })).status).toBe(200)
    expect(env.cloud.members.role(t.id, a.userId)).toBe('owner')
    expect(env.cloud.members.role(t.id, o.userId)).toBe('admin')
    expect(teamBySlug(env.cloud.db, 'acme')!.owner_user_id).toBe(a.userId)
    expect(env.mailer.sent.filter((m) => /Ownership of Acme/.test(m.subject)).map((m) => m.to).sort()).toEqual(['a@acme.test', 'owner@acme.test'])
  })
})

describe('limits and the drive callback', () => {
  test('Free: 3 people counting open invites', async () => {
    env = setupConsole()
    const o = await account(env, 'owner@free.test', { totp: true })
    const t = await opsTeam(env, 'owner@free.test', 'freeco', 'free')
    expect((await o.b.api('POST', `/api/teams/${t.public_id}/invites`, { emails: ['a@free.test', 'b@free.test'] })).status).toBe(201)
    const r = await o.b.api('POST', `/api/teams/${t.public_id}/invites`, { emails: ['c@free.test'] })
    expect([r.status, r.json.error]).toEqual([409, 'people_limit'])
    // re-sending to someone already invited does not take a seat
    expect((await o.b.api('POST', `/api/teams/${t.public_id}/invites`, { emails: ['a@free.test'] })).status).toBe(201)
  })

  test('the team callback: members only, on behalf of a console admin, with the team\'s token', async () => {
    env = setupConsole()
    const o = await account(env, 'owner@acme.test', { totp: true })
    const t = await opsTeam(env, 'owner@acme.test', 'acme')
    const tokenEnv = env.driver.instances.get('acme')!.spec.env.TDRIVE_CLOUD_CALLBACK_TOKEN!
    expect(tokenEnv).toMatch(/^tdcb_/)
    // the console keeps only its hash
    expect(JSON.stringify(env.cloud.db.query('SELECT * FROM teams').all())).not.toContain(tokenEnv)
    const ownerSub = env.cloud.db.query<{ public_id: string }, []>("SELECT public_id FROM users WHERE email = 'owner@acme.test'").get()!.public_id
    const cb = (body: unknown, token = tokenEnv) => env.call('POST', '/api/team-callback/invites', { body, headers: { authorization: `Bearer ${token}`, origin: 'https://acme.cloud.example.com' } })
    const ok = await cb({ email: 'jae@partner.test', role: 'member', by_cloud_user: ownerSub })
    expect(ok.status).toBe(201)
    expect(await ok.json()).toEqual({ status: 'invited', invite: expect.stringMatching(/^inv_\d{12}$/) })
    expect(env.cloud.db.query("SELECT via FROM invites WHERE email = 'jae@partner.test'").get()).toEqual({ via: 'drive' })
    expect((await cb({ email: 'x@partner.test', role: 'admin', by_cloud_user: ownerSub })).status).toBe(400)
    expect((await cb({ email: 'x@partner.test', role: 'member', by_cloud_user: 'usr_00000000000000000000' })).status).toBe(403)
    expect((await cb({ email: 'x@partner.test', role: 'member', by_cloud_user: ownerSub }, 'tdcb_wrongwrongwrongwrongwrong')).status).toBe(401)
    // a member (not admin) cannot invite through the drive
    await o.b.api('POST', `/api/teams/${t.public_id}/invites`, { emails: ['m@acme.test'] })
    const m = await account(env, 'm@acme.test')
    await m.b.api('POST', '/api/invites/accept', { token: inviteLink('m@acme.test') })
    const mSub = env.cloud.db.query<{ public_id: string }, []>("SELECT public_id FROM users WHERE email = 'm@acme.test'").get()!.public_id
    expect((await cb({ email: 'y@partner.test', role: 'member', by_cloud_user: mSub })).status).toBe(403)
    // after the env is written again (a recreate), the previous token still works once more, an older one not
    await env.cloud.upgrade(teamBySlug(env.cloud.db, 'acme')!, 'admin:test')
    await env.cloud.upgrade(teamBySlug(env.cloud.db, 'acme')!, 'admin:test')
    expect((await cb({ email: 'z@partner.test', role: 'member', by_cloud_user: ownerSub })).status).toBe(401)
  })
})
