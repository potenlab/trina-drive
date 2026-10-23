// Member sync v2 on the drive (src/tdcloud/sync.ts), scenarios S08 (promote, remove) and S44 (order, removal vs. a
// pass signed just before it, re-invite without old credentials, people APIs closed, shadow accounts reported).
import crypto from 'node:crypto'
import { afterEach, describe, expect, test } from 'bun:test'
import { checkAppPassword } from '../src/dav/apppw'
import { makeOAuthRuntime } from '../src/oauth'
import { refreshTokens, verifyAccessToken } from '../src/oauth/tokens'
import { createToken, sha256, verifyToken } from '../src/store'
import { applySync } from '../src/tdcloud/sync'
import { OutboxMailer } from '../src/web/mail'
import { handleWeb } from '../src/web/server'
import { ORIGIN } from './web-helpers'
import { cloudSetup, payload, USERS, type CloudEnv } from './sso-helpers'

const MINA = { sub: USERS.mina, email: 'mina@trina.app', name: 'Mina Kim' }
const OWNER = { cloud_user: USERS.dion, email: 'dion@trina.app', name: 'Dion Nam', role: 'owner' as const }
const minaRow = { cloud_user: USERS.mina, email: 'mina@trina.app', name: 'Mina Kim' }

const sync = (e: CloudEnv, p: unknown) => applySync({ db: e.db, cfg: e.cfg, mailer: new OutboxMailer(e.dir, true), baseUrl: 'https://trina.cloud.trina.app' }, p)
const personId = (e: CloudEnv, email: string) => e.db.query<{ person_id: number }, [string]>('SELECT person_id FROM accounts WHERE email = ?').get(email)!.person_id
const noticesOf = (e: CloudEnv, id: number, kind: string) => e.db.query<{ n: number }, [number, string]>('SELECT count(*) AS n FROM notices WHERE person_id = ? AND kind = ?').get(id, kind)!.n

/** An OAuth grant with live access and refresh tokens for this person (as a finished consent would leave). */
function oauthGrant(e: CloudEnv, pid: number) {
  const rt = makeOAuthRuntime({ issuer: 'https://trina.cloud.trina.app' })
  e.db.query("INSERT INTO oauth_clients (client_id, kind, name, domain, redirect_uris, created_at) VALUES ('https://claude.ai/oauth/client.json', 'cimd', 'Claude', 'claude.ai', '[]', 0) ON CONFLICT DO NOTHING").run()
  const g = Number(e.db.query(`INSERT INTO tokens (person_id, name, hash, hint, scope, read_only, created_at, expires_at, kind, client_id) VALUES (?, ?, ?, 'oauth:claude.ai', NULL, 0, ?, ?, 'oauth', 'https://claude.ai/oauth/client.json')`)
    .run(pid, `Claude ${pid}`, sha256(crypto.randomBytes(8)), Date.now(), Date.now() + 86400_000).lastInsertRowid)
  const access = `tdrive_oat_${crypto.randomBytes(16).toString('base64url')}`, refresh = `tdrive_ort_${crypto.randomBytes(16).toString('base64url')}`
  const ins = e.db.query('INSERT INTO oauth_tokens (hash, grant_id, kind, resource, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
  ins.run(sha256(access), g, 'access', rt.resource, Date.now(), Date.now() + 3600_000)
  ins.run(sha256(refresh), g, 'refresh', rt.resource, Date.now(), Date.now() + 86400_000)
  return { rt, access, refresh }
}

/** Mina signed in (fresh) with a PAT, an OAuth connection and an app password. */
async function minaWithEverything(e: CloudEnv) {
  const b = new e.SsoBrowser()
  await b.sso(MINA, { authTime: e.nowS() })
  const pid = personId(e, 'mina@trina.app')
  const name = e.db.query<{ name: string }, [number]>('SELECT name FROM people WHERE id = ?').get(pid)!.name
  const pat = createToken(e.db, name).token
  const oauth = oauthGrant(e, pid)
  const app = await b.call('POST', '/api/me/app-passwords', { name: 'Mac' })
  expect(app.status).toBe(200)
  return { b, pid, name, pat, oauth, app: app.data.password as string }
}

const mcpStatus = async (e: CloudEnv, bearer: string) => (await handleWeb(e.w, new Request(`${ORIGIN}/mcp`, {
  method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }), '10.0.0.1')).status

async function allCut(e: CloudEnv, m: Awaited<ReturnType<typeof minaWithEverything>>) {
  expect((await m.b.call('GET', '/api/session')).status).toBe(401)
  expect(verifyToken(e.db, m.pat)).toBeNull()
  expect(await mcpStatus(e, m.pat)).toBe(401)
  expect(verifyAccessToken(m.oauth.rt, e.db, m.oauth.access)).toEqual({ ok: false, reason: 'invalid' })
  expect(() => refreshTokens(m.oauth.rt, e.db, { refreshToken: m.oauth.refresh, clientId: 'https://claude.ai/oauth/client.json', resource: undefined, scope: undefined })).toThrow()
  expect(checkAppPassword(e.db, 'mina@trina.app', m.app, '10.0.0.1')).toBeNull()
}

describe('S08: promote and remove', () => {
  test('member → admin: on the next request, and every admin plus the person is told', async () => {
    const e = await cloudSetup()
    expect((await sync(e, payload(1, [OWNER, minaRow]))).ok).toBe(true)
    const owner = personId(e, 'dion@trina.app'), mina = personId(e, 'mina@trina.app')
    // the owner became admin through the sync: told (the only admin before was the demo's unmanaged dion)
    expect(noticesOf(e, owner, 'admin_added')).toBe(1)
    const b = new e.SsoBrowser()
    await b.sso(MINA)
    expect((await b.call('GET', '/api/people')).data.people.find((p: { id: number }) => p.id === mina).admin).toBe(false)
    expect((await b.call('POST', '/api/groups', { name: 'x' })).status).toBe(403)
    expect((await sync(e, payload(2, [OWNER, { ...minaRow, role: 'admin' }]))).ok).toBe(true)
    // the same session: admin now (people.admin is read on every request)
    expect((await b.call('POST', '/api/groups', { name: 'x' })).status).toBe(200)
    expect(noticesOf(e, mina, 'admin_added')).toBe(1)
    expect(noticesOf(e, owner, 'admin_added')).toBe(2)
    expect(noticesOf(e, e.pid('dion'), 'admin_added')).toBe(2) // the demo admin (unmanaged) hears it too
    expect(e.db.query("SELECT 1 FROM audit WHERE command LIKE 'admin added: mina%'").get()).not.toBeNull()
  })

  test('removal: session, PAT, OAuth, app password all refused on the next request; the next SSO with an older pass is refused', async () => {
    const e = await cloudSetup()
    await sync(e, payload(1, [OWNER, minaRow]))
    const m = await minaWithEverything(e)
    expect(verifyToken(e.db, m.pat)).not.toBeNull()
    expect(verifyAccessToken(m.oauth.rt, e.db, m.oauth.access).ok).toBe(true)
    expect(checkAppPassword(e.db, 'mina@trina.app', m.app, '10.0.0.1')).toBe(m.pid)
    const r = await sync(e, payload(2, [OWNER]))
    expect(r).toMatchObject({ ok: true, applied: true, deactivated: 1 })
    await allCut(e, m)
    // a pass the console signed before it removed her (sync_seq 1) cannot bring her back
    const again = new e.SsoBrowser()
    expect((await again.sso(MINA, { syncSeq: 1 })).location).toBe('/#/sso-error/deactivated')
    expect(e.db.query("SELECT 1 FROM audit WHERE command LIKE 'member mina deactivated%' AND command LIKE '%1 tokens, 1 OAuth grants, 1 app passwords'").get()).not.toBeNull()
  })
})

describe('S44: order, passes, re-invite, people APIs, shadow accounts', () => {
  test('a retried old job after a newer one is stale and changes nothing', async () => {
    const e = await cloudSetup()
    await sync(e, payload(8, [OWNER]))
    expect(await sync(e, payload(7, [OWNER, minaRow]))).toEqual({ ok: true, applied: false, seq: 7, current_seq: 8, reason: 'stale' })
    expect(e.db.query("SELECT 1 FROM accounts WHERE email = 'mina@trina.app'").get()).toBeNull()
    expect(e.syncSeq()).toBe(8)
  })

  test('removed while asleep, applied on wake before anyone signs in: the pass from before the removal is refused', async () => {
    const e = await cloudSetup()
    await sync(e, payload(3, [OWNER, minaRow]))
    // the console removed Mina (seq 4) while the drive was paused; a pass signed earlier carries sync_seq 3
    await sync(e, payload(4, [OWNER]))
    expect((await new e.SsoBrowser().sso(MINA, { syncSeq: 3 })).location).toBe('/#/sso-error/deactivated')
    expect((await new e.SsoBrowser().sso(MINA, { syncSeq: 4 })).location).toBe('/#/sso-error/deactivated')
  })

  test('re-invited weeks later: back in, but the lost laptop\'s PAT, OAuth connection and app password stay dead', async () => {
    const e = await cloudSetup()
    await sync(e, payload(1, [OWNER, minaRow]))
    const m = await minaWithEverything(e)
    await sync(e, payload(2, [OWNER]))
    const r = await sync(e, payload(3, [OWNER, minaRow]))
    expect(r).toMatchObject({ ok: true, applied: true, reactivated: 1 })
    await allCut(e, m)
    const b = new e.SsoBrowser()
    expect((await b.sso(MINA)).location).toBe('/#/files')
    expect((await b.call('GET', '/api/session')).data.me.id).toBe(m.pid)
    // reactivation by a newer pass (the sync has not arrived yet) revives nothing either
    await sync(e, payload(4, [OWNER]))
    expect((await new e.SsoBrowser().sso(MINA, { syncSeq: 5 })).location).toBe('/#/files')
    expect(verifyToken(e.db, m.pat)).toBeNull()
  })

  test('the drive cannot change people under SSO-only (409 managed_by_console); Everyone is a system group', async () => {
    const e = await cloudSetup()
    await sync(e, payload(1, [OWNER, minaRow]))
    const owner = new e.SsoBrowser()
    await owner.sso({ sub: USERS.dion, email: 'dion@trina.app', role: 'owner' })
    const mina = personId(e, 'mina@trina.app')
    const code = async (method: string, path: string, body?: unknown) => { const r = await owner.call(method, path, body); return r.status === 409 ? r.data.error : r.status }
    expect(await code('POST', '/api/people', { name: 'x', email: 'x@example.com' })).toBe('managed_by_console')
    expect(await code('PATCH', `/api/people/${mina}`, { admin: true })).toBe('managed_by_console')
    expect(await code('PATCH', `/api/people/${mina}`, { active: false })).toBe('managed_by_console')
    expect(await code('PATCH', `/api/people/${mina}`, { email: 'm2@trina.app' })).toBe('managed_by_console')
    expect(await code('POST', `/api/people/${mina}/reset`)).toBe('managed_by_console')
    expect(await code('POST', `/api/people/${mina}/invite`, {})).toBe('managed_by_console')
    // someone the console does not know (CLI, break-glass) can only be switched off here
    expect(await code('PATCH', `/api/people/${e.pid('kim')}`, { admin: true })).toBe('managed_by_console')
    expect(await code('PATCH', `/api/people/${e.pid('kim')}`, { active: false })).toBe(200)
    const everyone = Number(e.db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'everyone_group'").get()!.value)
    expect(await code('DELETE', `/api/groups/${everyone}/members/${mina}`)).toBe('managed_by_console')
    expect(await code('PUT', `/api/groups/${everyone}/members/${e.pid('lee')}`)).toBe('managed_by_console')
    expect(await code('DELETE', `/api/groups/${everyone}`)).toBe('managed_by_console')
    // other groups are the drive's own
    const g = await owner.call('POST', '/api/groups', { name: 'design' })
    expect(await code('PUT', `/api/groups/${g.data.id}/members/${mina}`)).toBe(200)
    // Everyone = exactly the active console members (not invites, not the unmanaged demo people)
    await sync(e, payload(2, [OWNER, minaRow, { invite: 'inv_000000000001', email: 'jae@partner.example' }]))
    const members = e.db.query<{ email: string }, [number]>('SELECT a.email FROM memberships m JOIN accounts a ON a.person_id = m.person_id WHERE m.group_id = ? ORDER BY a.email').all(everyone).map((x) => x.email)
    expect(members).toEqual(['dion@trina.app', 'mina@trina.app'])
  })

  test('shadow accounts are reported, never changed; events apply once; sessions_revoked keeps tokens', async () => {
    const e = await cloudSetup()
    const r = await sync(e, payload(1, [OWNER, minaRow]))
    expect(r.ok && r.applied && r.unmanaged).toEqual([
      { name: 'boss', admin: false, active: true }, { name: 'dion', admin: true, active: true }, { name: 'kim', admin: false, active: true },
      { name: 'lee', admin: false, active: true }, { name: 'park', admin: false, active: true }])
    expect(e.db.query<{ active: number }, []>("SELECT active FROM people WHERE name = 'kim'").get()!.active).toBe(1)
    const m = await minaWithEverything(e)
    const ev = { id: 'evt_00000000000000000042', type: 'member.sessions_revoked', cloud_user: USERS.mina, at: Date.now(), reason: 'console_password_changed' }
    await sync(e, payload(2, [OWNER, minaRow], [ev]))
    expect((await m.b.call('GET', '/api/session')).status).toBe(401)
    expect(verifyToken(e.db, m.pat)).not.toBeNull()
    // the same event id again (a later payload repeats it): not applied twice
    const b2 = new e.SsoBrowser()
    await b2.sso(MINA)
    await sync(e, payload(3, [OWNER, minaRow], [ev]))
    expect((await b2.call('GET', '/api/session')).status).toBe(200)
    // member.removed: explicit, even though the list still had her in an older payload
    await sync(e, payload(4, [OWNER], [{ id: 'evt_00000000000000000050', type: 'member.removed', cloud_user: USERS.mina, at: Date.now() }]))
    expect(e.db.query("SELECT 1 FROM audit WHERE command LIKE 'member.removed mina%'").get()).not.toBeNull()
    expect(verifyToken(e.db, m.pat)).toBeNull()
  })

  test('invites: a row now (shareable, not counted, not in Everyone); acceptance links it; withdrawal deactivates it', async () => {
    const e = await cloudSetup()
    const jae = { invite: 'inv_000000000017', email: 'jae@partner.example' }
    await sync(e, payload(1, [OWNER, jae]))
    const pid = personId(e, 'jae@partner.example')
    const row = () => e.db.query<{ active: number; cloud_user: string | null; cloud_invite: string | null }, [number]>('SELECT p.active, a.cloud_user, a.cloud_invite FROM people p JOIN accounts a ON a.person_id = p.id WHERE p.id = ?').get(pid)!
    expect(row()).toEqual({ active: 1, cloud_user: null, cloud_invite: 'inv_000000000017' })
    // accepted: the first payload after acceptance carries both
    await sync(e, payload(2, [OWNER, { ...jae, cloud_user: USERS.jae, status: 'active' }]))
    expect(row()).toEqual({ active: 1, cloud_user: USERS.jae, cloud_invite: null })
    // a second invite withdrawn by event
    await sync(e, payload(3, [OWNER, { cloud_user: USERS.jae, email: 'jae@partner.example' }, { invite: 'inv_000000000018', email: 'kai@partner.example' }]))
    const kai = personId(e, 'kai@partner.example')
    await sync(e, payload(4, [OWNER, { cloud_user: USERS.jae, email: 'jae@partner.example' }], [{ id: 'evt_00000000000000000060', type: 'invite.revoked', invite: 'inv_000000000018', at: Date.now() }]))
    expect(e.db.query<{ active: number }, [number]>('SELECT active FROM people WHERE id = ?').get(kai)!.active).toBe(0)
  })
})

describe('people limit', () => {
  const before = process.env.TDRIVE_MAX_PEOPLE
  afterEach(() => { if (before === undefined) delete process.env.TDRIVE_MAX_PEOPLE; else process.env.TDRIVE_MAX_PEOPLE = before })
  test('a sync that would go past TDRIVE_MAX_PEOPLE applies nothing and says people_limit; invites do not count', async () => {
    const e = await cloudSetup()
    // the demo already has 5 active (unmanaged) people
    process.env.TDRIVE_MAX_PEOPLE = '6'
    expect(await sync(e, payload(1, [OWNER, { invite: 'inv_000000000001', email: 'a@x.io' }, { invite: 'inv_000000000002', email: 'b@x.io' }]))).toMatchObject({ ok: true, applied: true, created: 3 })
    const r = await sync(e, payload(2, [OWNER, minaRow]))
    expect(r).toMatchObject({ ok: false, error: 'people_limit' })
    expect(e.syncSeq()).toBe(1)
    expect(e.db.query("SELECT 1 FROM accounts WHERE email = 'mina@trina.app'").get()).toBeNull()
  })
})
