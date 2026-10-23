// My files in Trina Cloud mode (src/tdcloud/my-files.ts, workstream B2, scenario S50 drive side): one managed personal
// folder per active member — made on the first SSO sign-in, by the member sync, or by `cloud my-files` — owner only,
// not shareable, on the team quota, readable by the person's own AI (token scope and No AI apply). A person who leaves
// has theirs moved to "Former members/<handle>" (admins are Editors there, No AI on); coming back brings it back.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'bun:test'
import { createManagedFolder } from '../src/managed/folders'
import { metaSet as storageMetaSet } from '../src/managed/settings'
import { Access, entryName } from '../src/policy'
import { createToken, verifyToken } from '../src/store'
import { cloudCommands } from '../src/tdcloud/cli'
import { setCloudConfig } from '../src/tdcloud/config'
import { FORMER_META, formerMembersFolder, myFilesOf, myFilesPath, reconcileMyFiles } from '../src/tdcloud/my-files'
import { applySync } from '../src/tdcloud/sync'
import { OutboxMailer } from '../src/web/mail'
import { handleWeb } from '../src/web/server'
import { ORIGIN } from './web-helpers'
import { cloudSetup, payload, USERS, type CloudEnv, type Person } from './sso-helpers'

const MINA = { sub: USERS.mina, email: 'mina@trina.app', name: 'Mina Kim' }
const KIM = { sub: USERS.kim, email: 'kim@trina.app', name: 'Kim' }
const OWNER = { sub: USERS.dion, email: 'dion@trina.app', name: 'Dion Nam', role: 'owner' as const }
const ownerRow = { cloud_user: USERS.dion, email: 'dion@trina.app', name: 'Dion Nam', role: 'owner' as const }
const minaRow = { cloud_user: USERS.mina, email: 'mina@trina.app', name: 'Mina Kim' }
const kimRow = { cloud_user: USERS.kim, email: 'kim@trina.app', name: 'Kim' }

const sync = (e: CloudEnv, p: unknown) => applySync({ db: e.db, cfg: e.cfg, mailer: new OutboxMailer(e.dir, true), baseUrl: 'https://trina.cloud.trina.app', dataDir: e.dir }, p)
const idOf = (e: CloudEnv, email: string) => e.db.query<{ person_id: number }, [string]>('SELECT person_id FROM accounts WHERE email = ?').get(email)!.person_id
const personalMounts = (e: CloudEnv, pid: number) => e.db.query<{ id: number }, [number]>('SELECT f.id FROM folders f JOIN managed_mounts m ON m.folder_id = f.id WHERE f.registered = 1 AND f.personal_owner = ?').all(pid).length
type B = InstanceType<CloudEnv['SsoBrowser']>

async function upload(e: CloudEnv, b: B, folder: string, name: string, content: string) {
  const form = new FormData()
  form.append('file', new File([content], name))
  const r = new Response(form)
  const type = r.headers.get('content-type')!
  const buf = new Uint8Array(await r.arrayBuffer())
  const res = await handleWeb(e.w, new Request(`${ORIGIN}/api/files/upload?path=${encodeURIComponent(folder)}`, {
    method: 'POST', body: buf, headers: { origin: ORIGIN, cookie: `tdrive_session=${b.cookie}`, 'x-csrf-token': b.csrf!, 'content-type': type, 'content-length': String(buf.length) },
  }), '10.0.0.1')
  return { status: res.status, data: (await res.json().catch(() => null)) as any }
}
const names = async (b: B, p: string) => {
  const r = await b.call('GET', '/api/files?path=' + encodeURIComponent(p))
  return r.status === 200 ? (r.data.entries as { name: string }[]).map((x) => x.name).sort() : r.status
}
const textOf = async (b: B, p: string) => { const r = await b.call('GET', '/api/files/text?path=' + encodeURIComponent(p)); return r.status === 200 ? r.data.text : r.status }
const agentRoot = (e: CloudEnv, secret: string) => Access.forToken(e.db, verifyToken(e.db, secret)!).rootEntries().map(entryName)

async function signIn(e: CloudEnv, who: Person) {
  const b = new e.SsoBrowser()
  const r = await b.sso(who, { authTime: e.nowS() })
  expect(r.status).toBe(303)
  return b
}

async function cli(e: CloudEnv, args: string[] = []) {
  const out: string[] = [], err: string[] = []
  const code = await cloudCommands.find((c) => c.name === 'cloud my-files')!.run({ db: e.db, dataDir: e.dir, args, out: (s) => out.push(s), err: (s) => err.push(s) })
  return { code: code ?? 0, json: JSON.parse(out.join('\n') || 'null'), err: err.join('\n') }
}

describe('S50: My files on the first sign-in', () => {
  test('exactly one folder, shown as me.myFilesPath; a second sign-in makes none', async () => {
    const e = await cloudSetup()
    const b = await signIn(e, MINA)
    const mina = idOf(e, 'mina@trina.app')
    expect(personalMounts(e, mina)).toBe(1)
    const me = (await b.call('GET', '/api/session')).data.me
    expect(me.myFilesPath).toBe('/mina (personal)')
    expect(myFilesPath(e.db, mina)).toBe('/mina (personal)')
    // the folder is the person's own: owner only, managed, the person's name never in someone else's list
    const f = myFilesOf(e.db, mina)!
    expect(f.personal_owner).toBe(mina)
    expect(e.db.query('SELECT 1 FROM rules WHERE folder_id = ?').get(f.id)).toBeNull()
    await signIn(e, MINA)
    expect(personalMounts(e, mina)).toBe(1)
    expect(e.db.query<{ n: number }, []>("SELECT count(*) AS n FROM audit WHERE command LIKE 'my files of mina: folder create%'").get()!.n).toBe(1)
  })

  test('upload works; others (members and the admin) never see it; the owner reads it back', async () => {
    const e = await cloudSetup()
    const mina = await signIn(e, MINA)
    const kim = await signIn(e, KIM)
    const owner = await signIn(e, OWNER)
    expect((await upload(e, mina, '/mina (personal)', 'note.txt', 'only mine')).status).toBe(200)
    expect(await names(mina, '/mina (personal)')).toEqual(['note.txt'])
    expect(await textOf(mina, '/mina (personal)/note.txt')).toBe('only mine')
    for (const other of [kim, owner]) {
      const root = await names(other, '/')
      expect(root).not.toContain('mina (personal)')
      expect(await names(other, '/mina (personal)')).toBe(404)
      expect(await textOf(other, '/mina (personal)/note.txt')).toBe(404)
    }
    // each has their own
    expect((await kim.call('GET', '/api/session')).data.me.myFilesPath).toBe('/kim-2 (personal)') // the demo has a kim already
  })

  test('sharing is closed: no share, no rules, no manager (R0; "Move it to a team folder to share")', async () => {
    const e = await cloudSetup()
    const b = await signIn(e, MINA)
    const kim = e.pid('kim') // the demo kim (unmanaged) is someone to share with
    const f = myFilesOf(e.db, idOf(e, 'mina@trina.app'))!
    const share = await b.call('POST', '/api/share', { path: '/mina (personal)', add: [{ type: 'person', id: kim, role: 'viewer' }] })
    // A1's folder share API: 403 (its code today is editors_cannot_share: the owner has level write, editors may not share in a personal folder)
    expect(share.status).toBe(403)
    const who = await b.call('GET', '/api/files/who?path=' + encodeURIComponent('/mina (personal)'))
    expect(who.data).toMatchObject({ can_share: false, personal_owner: 'mina' })
    const rule = await b.call('PUT', `/api/folders/${f.id}/rules`, { subject_type: 'person', subject_id: kim, level: 'read' })
    expect(rule.status).toBeGreaterThanOrEqual(400)
    expect(e.db.query('SELECT 1 FROM rules WHERE folder_id = ?').get(f.id)).toBeNull()
    expect(e.db.query('SELECT 1 FROM manage_grants WHERE folder_id = ?').get(f.id)).toBeNull()
  })

  test('the team quota counts it: a full team refuses the upload into My files too', async () => {
    const e = await cloudSetup()
    const b = await signIn(e, MINA)
    storageMetaSet(e.db, 'storage_quota', '1KB')
    expect((await upload(e, b, '/mina (personal)', 'small.txt', 'x'.repeat(500))).status).toBe(200)
    const full = await upload(e, b, '/mina (personal)', 'big.txt', 'y'.repeat(900))
    expect(full.status).toBe(507)
    expect(full.data.error).toBe('quota_exceeded')
  })
})

describe('the person\'s AI and My files (token scope and No AI apply)', () => {
  test('an unscoped token reads it; a token scoped elsewhere does not; No AI closes it; nobody else\'s token sees it', async () => {
    const e = await cloudSetup()
    const b = await signIn(e, MINA)
    expect((await upload(e, b, '/mina (personal)', 'plan.md', '# plan')).status).toBe(200)
    const team = createManagedFolder(e.db, e.dir, { name: 'Team' })
    const all = createToken(e.db, 'mina', { name: 'all' }).token
    const scoped = createToken(e.db, 'mina', { name: 'team', scope: [team.path] }).token
    const mine = createToken(e.db, 'mina', { name: 'mine', scope: [myFilesOf(e.db, idOf(e, 'mina@trina.app'))!.path] }).token
    expect(agentRoot(e, all)).toContain('mina (personal)')
    expect(agentRoot(e, mine)).toEqual(['mina (personal)'])
    expect(agentRoot(e, scoped)).not.toContain('mina (personal)')
    const kim = await signIn(e, KIM)
    void kim
    expect(agentRoot(e, createToken(e.db, 'kim').token)).not.toContain('mina (personal)')
    const owner = await signIn(e, OWNER)
    void owner
    expect(agentRoot(e, createToken(e.db, 'dion-2').token)).not.toContain('mina (personal)')
    // the owner turns No AI on: their own agent no longer reads it, they still do
    const f = myFilesOf(e.db, idOf(e, 'mina@trina.app'))!
    expect((await b.call('PATCH', `/api/folders/${f.id}`, { no_ai: true })).status).toBe(200)
    expect(agentRoot(e, all)).not.toContain('mina (personal)')
    expect(await names(b, '/mina (personal)')).toEqual(['plan.md'])
  })
})

describe('member sync and My files', () => {
  test('active members get one; an invite gets none until it is accepted', async () => {
    const e = await cloudSetup()
    expect((await sync(e, payload(1, [ownerRow, minaRow, { invite: 'inv_lee', email: 'lee@trina.app', name: 'Lee' }]))).ok).toBe(true)
    expect(personalMounts(e, idOf(e, 'dion@trina.app'))).toBe(1)
    expect(personalMounts(e, idOf(e, 'mina@trina.app'))).toBe(1)
    const lee = idOf(e, 'lee@trina.app')
    expect(personalMounts(e, lee)).toBe(0)
    expect((await sync(e, payload(2, [ownerRow, minaRow, { cloud_user: USERS.lee, email: 'lee@trina.app', name: 'Lee' }]))).ok).toBe(true)
    expect(personalMounts(e, lee)).toBe(1)
    // a stale (retried) job changes nothing and makes nothing twice
    expect((await sync(e, payload(2, [ownerRow, minaRow]))).ok).toBe(true)
    for (const m of ['dion@trina.app', 'mina@trina.app', 'lee@trina.app']) expect(personalMounts(e, idOf(e, m))).toBe(1)
  })

  test('removal: My files moves to Former members/<handle>, files intact; admins are Editors there, members and agents see nothing', async () => {
    const e = await cloudSetup()
    expect((await sync(e, payload(1, [ownerRow, minaRow, kimRow]))).ok).toBe(true)
    const mina = await signIn(e, MINA)
    expect((await upload(e, mina, '/mina (personal)', 'handover.txt', 'the keys are in the drawer')).status).toBe(200)
    const minaId = idOf(e, 'mina@trina.app')
    const folderId = myFilesOf(e.db, minaId)!.id
    expect((await sync(e, payload(2, [ownerRow, kimRow]))).ok).toBe(true)
    expect(myFilesOf(e.db, minaId)).toBeNull()
    expect(personalMounts(e, minaId)).toBe(0)
    // the same folder row (identity kept), now an ordinary folder inside Former members
    const fm = formerMembersFolder(e.db, e.dir, false)!
    expect(fm.mount_name).toBe('Former members')
    expect(fm.no_ai).toBe(1)
    const moved = e.db.query<{ path: string; registered: number; personal_owner: number | null }, [number]>('SELECT path, registered, personal_owner FROM folders WHERE id = ?').get(folderId)!
    expect(moved).toEqual({ path: path.join(fm.path, 'mina'), registered: 0, personal_owner: null })
    const owner = await signIn(e, OWNER)
    expect(await names(owner, '/Former members')).toEqual(['mina'])
    expect(await textOf(owner, '/Former members/mina/handover.txt')).toBe('the keys are in the drawer')
    // an admin may move it on (Editor)
    expect((await upload(e, owner, '/Former members/mina', 'from-admin.txt', 'ok')).status).toBe(200)
    // a member does not see it; nor does the admin's agent (No AI on Former members)
    const kim = await signIn(e, KIM)
    expect(await names(kim, '/')).not.toContain('Former members')
    expect(await names(kim, '/Former members')).toBe(404)
    expect(agentRoot(e, createToken(e.db, 'dion-2').token)).not.toContain('Former members')
    expect(e.db.query("SELECT 1 FROM audit WHERE command LIKE 'my files of mina (left the team): /mina (personal) moved to /Former members/mina%'").get()).not.toBeNull()
  })

  test('an AI-draft copy moved into My files does not open to the admins on the handover: it closes (R6)', async () => {
    const e = await cloudSetup()
    // kim left first: Former members exists and the admins are already its Editors (the move itself must re-check)
    expect((await sync(e, payload(1, [ownerRow, minaRow, kimRow]))).ok).toBe(true)
    expect((await sync(e, payload(2, [ownerRow, minaRow]))).ok).toBe(true)
    const mina = await signIn(e, MINA)
    const minaId = idOf(e, 'mina@trina.app')
    // a draft of mina's AI made from /Finance (mina reads it, the owner does not); its bytes now sit in her My files
    const fin = createManagedFolder(e.db, e.dir, { name: 'Finance' })
    e.db.query("INSERT INTO rules (folder_id, subject_type, subject_id, level) VALUES (?, 'person', ?, 1)").run(fin.id, minaId)
    expect((await upload(e, mina, '/mina (personal)', 'summary.md', 'CANARY numbers')).status).toBe(200)
    const tok = createToken(e.db, 'mina', { name: 'ai' })
    const draft = Number(e.db.query("INSERT INTO drafts (token_id, person_id, path, created_at) VALUES (?, ?, '/drafts/summary.md', 0)").run(tok.id, minaId).lastInsertRowid)
    e.db.query('INSERT INTO draft_src (draft_id, folder_id, strong) VALUES (?, ?, 1)').run(draft, fin.id)
    const my = myFilesOf(e.db, minaId)!
    const real = path.join(my.path, 'summary.md')
    const st = fs.statSync(real, { bigint: true })
    e.db.query(`INSERT INTO widened (at, dev, ino, path, sha256, draft_id, draft_version, writer_person_id, writer_token_id, target_folder_id, match, overlap, widening, ever_widening, status, judged_at)
      VALUES (0, ?, ?, ?, 'x', ?, 1, ?, ?, ?, 'exact', 1, 0, 0, 'tracked', 0)`).run(String(st.dev), String(st.ino), real, draft, minaId, tok.id, my.id)
    expect((await sync(e, payload(3, [ownerRow]))).ok).toBe(true)
    const w = e.db.query<{ status: string; path: string }, []>('SELECT status, path FROM widened').get()!
    expect(w.status).toBe('pending')
    expect(w.path).toBe(path.join(formerMembersFolder(e.db, e.dir, false)!.path, 'mina', 'summary.md'))
    const owner = await signIn(e, OWNER)
    expect(await textOf(owner, '/Former members/mina/summary.md')).not.toBe('CANARY numbers')
  })

  test('re-invite: the same folder comes back as My files (with what the admins left in it); the person is told', async () => {
    const e = await cloudSetup()
    expect((await sync(e, payload(1, [ownerRow, minaRow]))).ok).toBe(true)
    const mina = await signIn(e, MINA)
    expect((await upload(e, mina, '/mina (personal)', 'a.txt', 'A')).status).toBe(200)
    const minaId = idOf(e, 'mina@trina.app')
    const folderId = myFilesOf(e.db, minaId)!.id
    expect((await sync(e, payload(2, [ownerRow]))).ok).toBe(true)
    expect((await sync(e, payload(3, [ownerRow, minaRow]))).ok).toBe(true)
    const back = myFilesOf(e.db, minaId)!
    expect(back.id).toBe(folderId)
    expect(back.mount_name).toBe('mina (personal)')
    const again = await signIn(e, MINA)
    expect(await names(again, '/mina (personal)')).toEqual(['a.txt'])
    expect((await again.call('GET', '/api/session')).data.me.myFilesPath).toBe('/mina (personal)')
    expect(personalMounts(e, minaId)).toBe(1)
    expect(e.db.query("SELECT 1 FROM notices WHERE person_id = ? AND kind = 'personal_folder_changed' AND link = '/#/my'").get(minaId)).not.toBeNull()
    const owner = await signIn(e, OWNER)
    expect(await names(owner, '/Former members')).toEqual([])
  })

  test('re-invite after the admins moved the folder out of Former members: a new, empty My files', async () => {
    const e = await cloudSetup()
    expect((await sync(e, payload(1, [ownerRow, minaRow]))).ok).toBe(true)
    const mina = await signIn(e, MINA)
    expect((await upload(e, mina, '/mina (personal)', 'a.txt', 'A')).status).toBe(200)
    expect((await sync(e, payload(2, [ownerRow]))).ok).toBe(true)
    const owner = await signIn(e, OWNER)
    createManagedFolder(e.db, e.dir, { name: 'Archive' })
    e.db.query("INSERT INTO rules (folder_id, subject_type, subject_id, level) VALUES ((SELECT id FROM folders WHERE mount_name = 'Archive'), 'person', ?, 2)").run(idOf(e, 'dion@trina.app'))
    const mv = await owner.call('POST', '/api/files/move', { paths: ['/Former members/mina'], to: '/Archive' })
    expect(mv.status).toBe(200)
    expect((await sync(e, payload(3, [ownerRow, minaRow]))).ok).toBe(true)
    const again = await signIn(e, MINA)
    expect(await names(again, '/mina (personal)')).toEqual([])
    expect(await names(owner, '/Archive/mina')).toEqual(['a.txt'])
  })

  test('admins follow the console: a new admin becomes an Editor of Former members, a demoted one stops being one', async () => {
    const e = await cloudSetup()
    expect((await sync(e, payload(1, [ownerRow, minaRow, kimRow]))).ok).toBe(true)
    expect((await sync(e, payload(2, [ownerRow, kimRow]))).ok).toBe(true) // mina leaves: Former members exists
    const fm = Number(e.db.query<{ value: string }, []>(`SELECT value FROM meta WHERE key = '${FORMER_META}'`).get()!.value)
    const level = (email: string) => e.db.query<{ level: number }, [number, number]>("SELECT level FROM rules WHERE folder_id = ? AND subject_type = 'person' AND subject_id = ?").get(fm, idOf(e, email))?.level ?? 0
    expect(level('dion@trina.app')).toBe(2)
    expect(level('kim@trina.app')).toBe(0)
    expect((await sync(e, payload(3, [ownerRow, { ...kimRow, role: 'admin' }]))).ok).toBe(true)
    expect(level('kim@trina.app')).toBe(2)
    expect((await sync(e, payload(4, [ownerRow, kimRow]))).ok).toBe(true)
    expect(level('kim@trina.app')).toBe(0)
    // a rule an admin set by hand for someone else is left alone
    const lee = e.pid('lee')
    e.db.query("INSERT INTO rules (folder_id, subject_type, subject_id, level) VALUES (?, 'person', ?, 1)").run(fm, lee)
    expect((await sync(e, payload(5, [ownerRow, kimRow]))).ok).toBe(true)
    expect(e.db.query("SELECT level FROM rules WHERE folder_id = ? AND subject_type = 'person' AND subject_id = ?").get(fm, lee)).toEqual({ level: 1 })
  })
})

describe('edge cases', () => {
  test('rename: a new display name or handle keeps the same folder and path (no second folder)', async () => {
    const e = await cloudSetup()
    expect((await sync(e, payload(1, [ownerRow, minaRow]))).ok).toBe(true)
    const minaId = idOf(e, 'mina@trina.app')
    const before = myFilesOf(e.db, minaId)!
    expect((await sync(e, payload(2, [ownerRow, { ...minaRow, name: 'Mina Park', email: 'mina.park@trina.app' }]))).ok).toBe(true)
    e.db.query("UPDATE people SET name = 'minap' WHERE id = ?").run(minaId)
    const b = await signIn(e, { ...MINA, name: 'Mina Park', email: 'mina.park@trina.app' })
    expect(myFilesOf(e.db, minaId)!.id).toBe(before.id)
    expect(personalMounts(e, minaId)).toBe(1)
    expect((await b.call('GET', '/api/session')).data.me.myFilesPath).toBe('/mina (personal)')
    // leaving under the new handle: Former members/<new handle>
    expect((await sync(e, payload(3, [ownerRow]))).ok).toBe(true)
    expect(fs.existsSync(path.join(formerMembersFolder(e.db, e.dir, false)!.path, 'minap'))).toBe(true)
  })

  test('names that are taken: "<handle> (personal) 2", "Former members 2"', async () => {
    const e = await cloudSetup()
    createManagedFolder(e.db, e.dir, { name: 'mina (personal)' })
    createManagedFolder(e.db, e.dir, { name: 'Former members' })
    expect((await sync(e, payload(1, [ownerRow, minaRow]))).ok).toBe(true)
    expect(myFilesPath(e.db, idOf(e, 'mina@trina.app'))).toBe('/mina (personal) 2')
    expect((await sync(e, payload(2, [ownerRow]))).ok).toBe(true)
    expect(formerMembersFolder(e.db, e.dir, false)!.mount_name).toBe('Former members 2')
  })

  test('two leavers with the same handle over time: Former members/mina, Former members/mina 2', async () => {
    const e = await cloudSetup()
    expect((await sync(e, payload(1, [ownerRow, minaRow]))).ok).toBe(true)
    expect((await sync(e, payload(2, [ownerRow]))).ok).toBe(true)
    // she comes back while the old folder is elsewhere, gets a new one, then leaves again
    const fm = formerMembersFolder(e.db, e.dir, false)!
    fs.renameSync(path.join(fm.path, 'mina'), path.join(fm.path, 'kept'))
    fs.mkdirSync(path.join(fm.path, 'mina'))
    e.db.query("UPDATE cloud_my_files SET state = 'gone'").run()
    expect((await sync(e, payload(3, [ownerRow, minaRow]))).ok).toBe(true)
    expect((await sync(e, payload(4, [ownerRow]))).ok).toBe(true)
    expect(fs.readdirSync(fm.path).sort()).toEqual(['kept', 'mina', 'mina 2'])
  })

  test('an admin-made personal folder is adopted, not doubled; an admin releasing My files gives a new one', async () => {
    const e = await cloudSetup()
    expect((await sync(e, payload(1, [ownerRow]))).ok).toBe(true)
    // before My files existed, the admin made one by hand for mina (a person tied to the console)
    e.db.query("INSERT INTO people (name, admin, created_at) VALUES ('mina', 0, 0)").run()
    const minaId = e.pid('mina')
    e.db.query('INSERT INTO accounts (person_id, email, created_at, cloud_user) VALUES (?, ?, 0, ?)').run(minaId, 'mina@trina.app', USERS.mina)
    const hand = createManagedFolder(e.db, e.dir, { name: 'Mina private', personalOwner: 'mina' })
    expect((await sync(e, payload(2, [ownerRow, minaRow]))).ok).toBe(true)
    expect(myFilesOf(e.db, minaId)!.id).toBe(hand.id)
    expect(personalMounts(e, minaId)).toBe(1)
    // the admin gives it to someone else (R9 change owner): mina gets a fresh My files next time
    e.db.query('UPDATE folders SET personal_owner = ? WHERE id = ?').run(idOf(e, 'dion@trina.app'), hand.id)
    expect(myFilesOf(e.db, minaId)).toBeNull()
    const r = reconcileMyFiles(e.db, e.dir)
    expect(r.created).toBe(1)
    expect(myFilesPath(e.db, minaId)).toBe('/mina (personal)')
  })

  test('at most one My files per person, even when two processes race (unique index)', async () => {
    const e = await cloudSetup()
    await signIn(e, MINA)
    const minaId = idOf(e, 'mina@trina.app')
    expect(() => e.db.query("INSERT INTO cloud_my_files (folder_id, person_id, mount_name, state, created_at) VALUES (99999, ?, 'x', 'mine', 0)").run(minaId)).toThrow()
  })
})

describe('backfill CLI `cloud my-files`', () => {
  test('existing members get theirs; --dry-run only counts; a second run does nothing', async () => {
    const e = await cloudSetup()
    // members from before My files: the sync ran without a data directory (an older CLI)
    expect((await applySync({ db: e.db, cfg: e.cfg, mailer: new OutboxMailer(e.dir, true), baseUrl: 'https://x' }, payload(1, [ownerRow, minaRow, kimRow]))).ok).toBe(true)
    expect(personalMounts(e, idOf(e, 'mina@trina.app'))).toBe(0)
    const dry = await cli(e, ['--dry-run'])
    expect(dry.json).toEqual({ ok: true, dry_run: true, without_my_files: ['dion-2', 'kim-2', 'mina'], to_former_members: [] })
    expect(personalMounts(e, idOf(e, 'mina@trina.app'))).toBe(0)
    const run = await cli(e)
    expect(run.code).toBe(0)
    expect(run.json).toEqual({ ok: true, created: 3, adopted: 0, restored: 0, transferred: 0, failed: [] })
    for (const m of ['dion@trina.app', 'mina@trina.app', 'kim@trina.app']) expect(personalMounts(e, idOf(e, m))).toBe(1)
    expect((await cli(e)).json).toEqual({ ok: true, created: 0, adopted: 0, restored: 0, transferred: 0, failed: [] })
    expect(e.db.query("SELECT 1 FROM audit WHERE tool = 'cli' AND command LIKE 'cloud my-files: 3 created%'").get()).not.toBeNull()
  })

  test('a removal the sync could not finish (no data directory) is finished by the CLI', async () => {
    const e = await cloudSetup()
    expect((await sync(e, payload(1, [ownerRow, minaRow]))).ok).toBe(true)
    expect((await applySync({ db: e.db, cfg: e.cfg, mailer: new OutboxMailer(e.dir, true), baseUrl: 'https://x' }, payload(2, [ownerRow]))).ok).toBe(true)
    expect((await cli(e, ['--dry-run'])).json.to_former_members).toEqual(['mina'])
    expect((await cli(e)).json.transferred).toBe(1)
    expect(fs.existsSync(path.join(formerMembersFolder(e.db, e.dir, false)!.path, 'mina'))).toBe(true)
  })
})

describe('self-hosted (no TDRIVE_CLOUD_*): unchanged', () => {
  test('no folder is made, me has no myFilesPath, the CLI says not_cloud', async () => {
    const e = await cloudSetup()
    setCloudConfig(e.db, null)
    const b = await new e.Browser().login('kim')
    const me = (await b.call('GET', '/api/session')).data.me
    expect('myFilesPath' in me).toBe(false)
    expect(reconcileMyFiles(e.db, e.dir)).toEqual({ created: 0, adopted: 0, restored: 0, transferred: 0, restoredPeople: [], failed: [], judgements: [] })
    expect(e.db.query('SELECT count(*) AS n FROM managed_mounts').get()).toEqual({ n: 0 })
    const r = await cli(e)
    expect(r.code).toBe(1)
    expect(r.json.error).toBe('not_cloud')
  })
})
