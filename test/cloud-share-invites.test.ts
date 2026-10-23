// Trina Cloud membership × sharing (workstream B2 follow-up): a share given by mail to a non-member (S16) arrives when
// the member sync or an SSO sign-in makes that address an active member — in the same transaction and R6 re-check —
// with one "Items were shared with you" notice (kind, count, link; O7: no file names). Admins hear when a My files
// folder lands in Former members (count and a link, no names). Deleting a group removes its file shares too.
import { describe, expect, test } from 'bun:test'
import { createManagedFolder } from '../src/managed/folders'
import { managedIdle } from '../src/managed/ops'
import { setCloudConfig } from '../src/tdcloud/config'
import { setConsoleFetch } from '../src/tdcloud/invite'
import { FORMER_META } from '../src/tdcloud/my-files'
import { applySync } from '../src/tdcloud/sync'
import { metaGet } from '../src/web/schema'
import { OutboxMailer } from '../src/web/mail'
import { handleWeb } from '../src/web/server'
import { ORIGIN } from './web-helpers'
import { fileShareSetup, Q3 } from './file-grants-helpers'
import { cloudSetup, fixtureConfig, payload, USERS, type CloudEnv, type Person } from './sso-helpers'

const OWNER = { sub: USERS.dion, email: 'dion@trina.app', name: 'Dion Nam', role: 'owner' as const }
const ownerRow = { cloud_user: USERS.dion, email: 'dion@trina.app', name: 'Dion Nam', role: 'owner' as const }
const minaRow = { cloud_user: USERS.mina, email: 'mina@trina.app', name: 'Mina Kim' }
const kimRow = { cloud_user: USERS.kim, email: 'kim@trina.app', name: 'Kim' }
const JAE = { sub: USERS.jae, email: 'jae@partner.example', name: 'Jae' }
const FILE = 'Q4-board-CANARY.md'

const sync = (e: CloudEnv, p: unknown) => applySync({ db: e.db, cfg: e.cfg, mailer: new OutboxMailer(e.dir, true), baseUrl: 'https://trina.cloud.trina.app', dataDir: e.dir }, p)
const idOf = (e: CloudEnv, email: string) => e.db.query<{ person_id: number }, [string]>('SELECT person_id FROM accounts WHERE email = ?').get(email)?.person_id
const noticesOf = (e: CloudEnv, pid: number | undefined, kind: string) =>
  e.db.query<{ count: number; link: string }, [number, string]>('SELECT count, link FROM notices WHERE person_id = ? AND kind = ? ORDER BY id').all(pid ?? -1, kind)
const mails = (e: CloudEnv) => new OutboxMailer(e.dir, true).read()
async function upload(e: CloudEnv, b: InstanceType<CloudEnv['SsoBrowser']>, folder: string, name: string, content: string) {
  const form = new FormData()
  form.append('file', new File([content], name))
  const r = new Response(form)
  const type = r.headers.get('content-type')!
  const buf = new Uint8Array(await r.arrayBuffer())
  const res = await handleWeb(e.w, new Request(`${ORIGIN}/api/files/upload?path=${encodeURIComponent(folder)}`, {
    method: 'POST', body: buf, headers: { origin: ORIGIN, cookie: `tdrive_session=${b.cookie}`, 'x-csrf-token': b.csrf!, 'content-type': type, 'content-length': String(buf.length) },
  }), '10.0.0.1')
  return res.status
}
async function signIn(e: CloudEnv, who: Person) { const b = new e.SsoBrowser(); expect((await b.sso(who, { authTime: e.nowS() })).status).toBe(303); return b }

/** The owner (console admin) shares a file in a managed team folder with an address that is not a member yet. */
async function shareByMail(e: CloudEnv, email: string) {
  const seen: unknown[] = []
  setConsoleFetch(async (_url, init) => { seen.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ status: 'invited', invite: 'inv_000000000042' }), { status: 201 }) })
  try {
    const proj = createManagedFolder(e.db, e.dir, { name: 'Board' })
    const owner = await signIn(e, OWNER)
    e.db.query("INSERT INTO rules (folder_id, subject_type, subject_id, level, granted_by, granted_at) VALUES (?, 'person', ?, 2, NULL, ?)").run(proj.id, idOf(e, 'dion@trina.app')!, Date.now())
    expect(await upload(e, owner, '/Board', FILE, '# Q4\nCANARY-Q4-9911\n')).toBe(200)
    expect(await upload(e, owner, '/Board', 'sibling.md', 'CANARY-SIB')).toBe(200)
    await managedIdle(e.db)
    const r = await owner.call('POST', '/api/share', { path: `/Board/${FILE}`, add: [{ subject: { email }, role: 'viewer' }] })
    expect(r.status).toBe(200)
    expect(r.data.invited).toEqual([{ email, status: 'invited', granted: false }])
    expect(seen).toEqual([{ email, role: 'member', by_cloud_user: USERS.dion }]) // the console's invite flow was asked
    expect(e.db.query('SELECT count(*) AS n FROM share_invites WHERE applied_at IS NULL').get()).toEqual({ n: 1 })
    return owner
  } finally { setConsoleFetch(null) }
}

describe('S16: a share by mail arrives when the address becomes a member', () => {
  test('member sync: invited (nothing yet) → accepted (grant applied, one notice, no file name) → the file opens', async () => {
    const e = await cloudSetup()
    expect((await sync(e, payload(1, [ownerRow, kimRow]))).ok).toBe(true)
    await shareByMail(e, JAE.email)
    // the console's next sync lists the invite: a row, but not a member — nothing is given yet
    expect((await sync(e, payload(2, [ownerRow, kimRow, { invite: 'inv_000000000042', email: JAE.email }]))).ok).toBe(true)
    const jae = idOf(e, JAE.email)!
    expect(e.db.query("SELECT count(*) AS n FROM file_grants WHERE subject_type = 'person' AND subject_id = ?").get(jae)).toEqual({ n: 0 })
    expect(noticesOf(e, jae, 'shared')).toEqual([])
    // accepted in the console: the sync makes them a member and gives the share (with its original giver)
    expect((await sync(e, payload(3, [ownerRow, kimRow, { cloud_user: USERS.jae, email: JAE.email, name: 'Jae' }]))).ok).toBe(true)
    expect(e.db.query("SELECT level, granted_by FROM file_grants WHERE subject_type = 'person' AND subject_id = ?").all(jae)).toEqual([{ level: 1, granted_by: idOf(e, 'dion@trina.app')! }])
    expect(e.db.query('SELECT count(*) AS n FROM share_invites WHERE applied_at IS NOT NULL').get()).toEqual({ n: 1 })
    expect(noticesOf(e, jae, 'shared')).toEqual([{ count: 1, link: '/#/shared' }])
    const mail = mails(e).filter((m) => m.to === JAE.email)
    expect(mail).toHaveLength(1)
    expect(JSON.stringify(mail)).not.toContain('Q4') // O7: no file names in the mail
    expect(JSON.stringify(mail)).not.toContain('Board')
    // a later sync gives nothing twice and tells nobody again
    expect((await sync(e, payload(4, [ownerRow, kimRow, { cloud_user: USERS.jae, email: JAE.email, name: 'Jae' }]))).ok).toBe(true)
    expect(noticesOf(e, jae, 'shared')).toHaveLength(1)
    // they sign in: the file is in Shared with me and opens; the file next to it does not
    const b = await signIn(e, JAE)
    const swm = await b.call('GET', '/api/shared-with-me')
    expect(swm.data.items).toEqual([expect.objectContaining({ kind: 'file', path: `/Board/${FILE}`, role: 'viewer' })])
    expect((await b.call('GET', '/api/files/download?path=' + encodeURIComponent(`/Board/${FILE}`))).status).toBe(200)
    expect((await b.call('GET', '/api/files/download?path=' + encodeURIComponent('/Board/sibling.md'))).status).toBe(404) // only the file
  })

  test('SSO sign-in that makes the person (before any sync lists them): the share arrives with the sign-in', async () => {
    const e = await cloudSetup()
    expect((await sync(e, payload(1, [ownerRow]))).ok).toBe(true)
    await shareByMail(e, JAE.email)
    const b = await signIn(e, JAE)
    const jae = idOf(e, JAE.email)!
    expect(noticesOf(e, jae, 'shared')).toEqual([{ count: 1, link: '/#/shared' }])
    expect((await b.call('GET', '/api/files/download?path=' + encodeURIComponent(`/Board/${FILE}`))).status).toBe(200)
    // signing in again gives nothing twice
    await signIn(e, JAE)
    expect(noticesOf(e, jae, 'shared')).toHaveLength(1)
  })

  test('a person who left gets nothing from a pending share until they are a member again', async () => {
    const e = await cloudSetup()
    expect((await sync(e, payload(1, [ownerRow, minaRow]))).ok).toBe(true)
    expect((await sync(e, payload(2, [ownerRow]))).ok).toBe(true) // mina leaves
    await shareByMail(e, 'mina@trina.app')
    const mina = idOf(e, 'mina@trina.app')!
    expect(e.db.query("SELECT count(*) AS n FROM file_grants WHERE subject_id = ?").get(mina)).toEqual({ n: 0 })
    expect((await sync(e, payload(3, [ownerRow, minaRow]))).ok).toBe(true) // back
    expect(e.db.query("SELECT count(*) AS n FROM file_grants WHERE subject_type = 'person' AND subject_id = ?").get(mina)).toEqual({ n: 1 })
    expect(noticesOf(e, mina, 'shared')).toEqual([{ count: 1, link: '/#/shared' }])
  })
})

describe('Former members: the admins hear of a handover', () => {
  test('every active admin gets one former_member_files notice (count + link to Former members, no names); members get none', async () => {
    const e = await cloudSetup()
    const kimAdmin = { ...kimRow, role: 'admin' as const }
    expect((await sync(e, payload(1, [ownerRow, kimAdmin, minaRow, { cloud_user: USERS.lee, email: 'lee@trina.app', name: 'Lee' }]))).ok).toBe(true)
    const owner = idOf(e, 'dion@trina.app'), kim = idOf(e, 'kim@trina.app'), lee = idOf(e, 'lee@trina.app')
    expect(noticesOf(e, owner, 'former_member_files')).toEqual([])
    expect((await sync(e, payload(2, [ownerRow, kimAdmin, { cloud_user: USERS.lee, email: 'lee@trina.app', name: 'Lee' }]))).ok).toBe(true) // mina leaves
    const fm = Number(metaGet(e.db, FORMER_META))
    expect(fm).toBeGreaterThan(0)
    for (const a of [owner, kim]) expect(noticesOf(e, a, 'former_member_files')).toEqual([{ count: 1, link: `/#/folders/${fm}` }])
    expect(noticesOf(e, lee, 'former_member_files')).toEqual([])
    const adminMail = mails(e).filter((m) => m.subject.includes('Former members'))
    expect(adminMail.map((m) => m.to)).toEqual(expect.arrayContaining(['dion@trina.app', 'kim@trina.app']))
    expect(adminMail.map((m) => m.to)).not.toContain('lee@trina.app')
    expect(JSON.stringify(adminMail)).not.toMatch(/mina/i)
    // nothing moved: nobody is told again
    expect((await sync(e, payload(3, [ownerRow, kimAdmin, { cloud_user: USERS.lee, email: 'lee@trina.app', name: 'Lee' }]))).ok).toBe(true)
    expect(noticesOf(e, owner, 'former_member_files')).toHaveLength(1)
    // two leave at once: one notice, count 2
    expect((await sync(e, payload(4, [ownerRow]))).ok).toBe(true)
    expect(noticesOf(e, owner, 'former_member_files').at(-1)).toEqual({ count: 2, link: `/#/folders/${fm}` })
  })
})

describe('deleting a group deletes its file shares', () => {
  test('in cloud mode (and self-hosted): DELETE /api/groups/:id leaves no file_grants row for the group', async () => {
    for (const cloud of [true, false]) {
      const e = await fileShareSetup()
      e.db.query("INSERT INTO groups (name) VALUES ('Board')").run()
      const g = e.db.query<{ id: number }, []>("SELECT id FROM groups WHERE name = 'Board'").get()!.id
      e.db.query('INSERT INTO memberships (group_id, person_id) VALUES (?, ?)').run(g, e.pid('kim'))
      expect((await e.shareFile(e.boss, Q3, { add: [{ subject: { type: 'group', id: g }, role: 'viewer' }] })).status).toBe(200)
      const kim = await e.as('kim')
      expect((await e.dl(kim, Q3)).status).toBe(200)
      expect(e.grantRows().filter((r) => r.subject_type === 'group')).toHaveLength(1)
      const dion = await e.as('dion')
      if (cloud) setCloudConfig(e.db, fixtureConfig({ t: Date.now() }, { ssoOnly: false }))
      expect((await dion.call('DELETE', `/api/groups/${g}`)).status).toBe(200)
      expect(e.grantRows().filter((r) => r.subject_type === 'group' && r.subject_id === g)).toEqual([])
      expect((await e.dl(kim, Q3)).status).not.toBe(200)
    }
  })
})
