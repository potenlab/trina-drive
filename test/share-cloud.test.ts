// Sharing in Trina Cloud mode: console-side membership changes (the member sync, an SSO sign-in that creates or
// reactivates someone) run the R6 re-check of AI-draft copies in their own transaction — a copy never silently reaches
// people who cannot read its sources; Everyone is a system group (finding 13); sharing with a non-member asks the
// console for an invite.
import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { createManagedFolder } from '../src/managed/folders'
import { managedIdle } from '../src/managed/ops'
import { setPromote } from '../src/promote'
import { everyoneId } from '../src/share/service'
import { createToken, setRule } from '../src/store'
import { setConsoleFetch } from '../src/tdcloud/invite'
import { applySync } from '../src/tdcloud/sync'
import { callTool } from '../src/tools'
import { verifyToken } from '../src/store'
import { OutboxMailer } from '../src/web/mail'
import { cloudSetup, payload, USERS, type CloudEnv } from './sso-helpers'

const OWNER_ROW = { cloud_user: USERS.dion, email: 'dion@trina.app', name: 'Dion Nam', role: 'owner' as const }
const MINA_ROW = { cloud_user: USERS.mina, email: 'mina@trina.app', name: 'Mina Kim' }
const JAE_ROW = { cloud_user: USERS.jae, email: 'jae@trina.app', name: 'Jae' }
const OWNER = { sub: USERS.dion, email: 'dion@trina.app', name: 'Dion Nam', role: 'owner' as const }

let e: CloudEnv | null = null
afterEach(() => { setConsoleFetch(null); e?.cleanup(); e = null })

const sync = (x: CloudEnv, p: unknown) => applySync({ db: x.db, cfg: x.cfg, mailer: new OutboxMailer(x.dir, true), baseUrl: 'https://trina.cloud.trina.app' }, p)
const pidOf = (x: CloudEnv, email: string) => x.db.query<{ person_id: number }, [string]>('SELECT person_id FROM accounts WHERE email = ?').get(email)!.person_id
const nameOf = (x: CloudEnv, id: number) => x.db.query<{ name: string }, [number]>('SELECT name FROM people WHERE id = ?').get(id)!.name
const status = (x: CloudEnv) => x.db.query<{ status: string }, []>('SELECT status FROM widened ORDER BY id').all().map((r) => r.status)

/**
 * The console's members are the owner and mina. /Team: Anyone in Trina (= the console members) writes. /Fin: the owner
 * and mina read it. mina's AI turns a /Fin file into a draft and promotes it into /Team: nobody in Everyone lacks /Fin,
 * so it is written at once (a tracked copy, no excess readers).
 */
async function world() {
  const x = await cloudSetup()
  expect((await sync(x, payload(1, [OWNER_ROW, MINA_ROW]))).ok).toBe(true)
  const owner = pidOf(x, 'dion@trina.app'), mina = pidOf(x, 'mina@trina.app')
  const team = createManagedFolder(x.db, x.dir, { name: 'Team' }), fin = createManagedFolder(x.db, x.dir, { name: 'Fin' })
  setRule(x.db, team.path, '@' + x.db.query<{ name: string }, [number]>('SELECT name FROM groups WHERE id = ?').get(everyoneId(x.db)!)!.name, 'write')
  setRule(x.db, fin.path, nameOf(x, owner), 'read')
  setRule(x.db, fin.path, nameOf(x, mina), 'read')
  fs.writeFileSync(path.join(fin.path, 'q3.md'), '# Q3\n\nCANARY-FIN-7731 revenue numbers that must stay in Fin\n')
  setPromote(x.db, team.id, true, null)
  const tok = verifyToken(x.db, createToken(x.db, nameOf(x, mina), { name: 'mina-agent' }).token)!
  expect((await callTool(x.ctx, tok, 'read', { path: '/Fin/q3.md' })).isError).toBeFalsy()
  expect((await callTool(x.ctx, tok, 'write', { path: '/drafts/q3.md', content: '# summary\n\nCANARY-FIN-7731 revenue numbers that must stay in Fin\n' })).isError).toBeFalsy()
  const p = await callTool(x.ctx, tok, 'promote', { draft: '/drafts/q3.md', folder: '/Team', name: 'q3-summary.md' })
  expect(p.structuredContent).toMatchObject({ status: 'written' })
  await managedIdle(x.db)
  expect(status(x)).toEqual(['tracked'])
  return { x, owner, mina, team, fin }
}

describe('console membership changes re-check AI-draft copies', () => {
  test('the member sync adds someone to Everyone who cannot read the sources: the copy closes in the same transaction', async () => {
    const w = await world(); e = w.x
    const r = await sync(e, payload(2, [OWNER_ROW, MINA_ROW, JAE_ROW]))
    expect(r).toMatchObject({ ok: true, applied: true, created: 1 })
    expect(status(e)).toEqual(['pending'])
    expect(e.db.query<{ command: string }, []>("SELECT command FROM audit WHERE command LIKE 'member sync 2:%'").get()!.command).toBe('member sync 2: 1 created, 0 updated, 0 deactivated, 0 reactivated, 1 AI-draft copy closed (widening)')
    // Fin has no manager: the admins hear "AI-draft copies need your review" — no names
    const n = e.db.query<{ kind: string; count: number; link: string }, [number]>("SELECT kind, count, link FROM notices WHERE person_id = ? AND kind = 'widened'").all(w.owner)
    expect(n).toEqual([{ kind: 'widened', count: 1, link: '/#/folders' }])
    for (const m of new OutboxMailer(e.dir, true).read()) expect(`${m.subject} ${m.text}`).not.toMatch(/Fin|Team|q3/)
    // jae's AI (and mina's) do not get the copy; the folder stays open
    const jae = verifyToken(e.db, createToken(e.db, nameOf(e, pidOf(e, 'jae@trina.app')), { name: 'jae-agent' }).token)!
    const out = await callTool(e.ctx, jae, 'bash', { command: 'ls /Team; cat /Team/q3-summary.md; echo end' })
    expect(out.content.map((c: { text: string }) => c.text).join('\n')).not.toContain('CANARY')
  })

  test('a stale sync (older seq) changes nothing and closes nothing', async () => {
    const w = await world(); e = w.x
    expect(await sync(e, payload(1, [OWNER_ROW, MINA_ROW, JAE_ROW]))).toMatchObject({ ok: true, applied: false, reason: 'stale' })
    expect(status(e)).toEqual(['tracked'])
  })

  test('an SSO sign-in that creates someone (JIT) and adds them to Everyone re-checks too', async () => {
    const w = await world(); e = w.x
    const b = new e.SsoBrowser()
    const r = await b.sso({ sub: USERS.lee, email: 'lee@trina.app', name: 'Lee' }, { syncSeq: 2 })
    expect(r.location).not.toMatch(/sso-error/)
    expect(status(e)).toEqual(['pending'])
    expect(e.db.query<{ n: number }, [number]>("SELECT count(*) AS n FROM notices WHERE person_id = ? AND kind = 'widened'").get(w.owner)!.n).toBe(1)
  })
})

describe('Everyone is a system group in cloud mode (finding 13)', () => {
  test('the People page cannot delete it or edit its members, even when it was adopted by name', async () => {
    e = await cloudSetup({ ssoOnly: false })
    await sync(e, payload(1, [OWNER_ROW, MINA_ROW]))
    const admin = await e.as('dion') // the demo's unmanaged admin
    const E = everyoneId(e.db)!
    const kim = e.pid('kim')
    expect((await admin.call('DELETE', `/api/groups/${E}`)).data.error).toBe('managed_by_console')
    expect((await admin.call('PUT', `/api/groups/${E}/members/${kim}`)).data.error).toBe('managed_by_console')
    expect((await admin.call('DELETE', `/api/groups/${E}/members/${pidOf(e, 'mina@trina.app')}`)).data.error).toBe('managed_by_console')
    e.db.query("DELETE FROM meta WHERE key = 'everyone_group'").run()
    expect((await admin.call('DELETE', `/api/groups/${E}`)).data.error).toBe('managed_by_console')
    expect(e.db.query('SELECT 1 FROM groups WHERE id = ?').get(E)).not.toBeNull()
    // other groups are still the admin's to change
    expect((await admin.call('PUT', `/api/groups/${e.db.query<{ id: number }, []>("SELECT id FROM groups WHERE name = '경영'").get()!.id}/members/${kim}`)).status).toBe(200)
    // the directory shows it as "Anyone in Trina"
    expect((await admin.call('GET', '/api/directory')).data.groups.find((g: { id: number }) => g.id === E)).toMatchObject({ name: 'Anyone in Trina', everyone: true })
  })
})

describe('sharing with a non-member in cloud mode', () => {
  test('an admin\'s share by mail asks the console to invite (member role); the share waits for them to join', async () => {
    e = await cloudSetup()
    await sync(e, payload(1, [OWNER_ROW, MINA_ROW]))
    createManagedFolder(e.db, e.dir, { name: 'Team' })
    const seen: unknown[] = []
    setConsoleFetch(async (_url, init) => { seen.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ status: 'invited', invite: 'inv_000000000042' }), { status: 201 }) })
    const owner = new e.SsoBrowser()
    await owner.sso(OWNER)
    expect((await owner.call('GET', '/api/session')).data.me.share).toEqual({ api: 1, can_invite: true })
    const r = await owner.call('POST', '/api/share', { path: '/Team', add: [{ subject: { email: 'new@partner.example' }, role: 'editor' }] })
    expect(r.status).toBe(200)
    expect(r.data.invited).toEqual([{ email: 'new@partner.example', status: 'invited', granted: false }])
    expect(seen).toEqual([{ email: 'new@partner.example', role: 'member', by_cloud_user: USERS.dion }])
    // a member who is not an admin cannot
    const mina = new e.SsoBrowser()
    await mina.sso({ sub: USERS.mina, email: 'mina@trina.app', name: 'Mina Kim' })
    expect((await mina.call('POST', '/api/share', { path: '/Team', add: [{ subject: { email: 'x@y.io' }, role: 'viewer' }] })).status).toBe(404) // mina cannot see /Team at all
  })
})
