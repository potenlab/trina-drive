// File shares and My files (A2 × B2): a file an admin shared from "Former members/<handle>" loses its shares when the
// folder comes back as the person's My files (moving into a personal folder unshares), and they do not come back when
// the person leaves again. Sharing a personal folder answers the plain code `personal`.
import { expect, test } from 'bun:test'
import { myFilesOf } from '../src/tdcloud/my-files'
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
type B = InstanceType<CloudEnv['SsoBrowser']>
async function signIn(e: CloudEnv, who: Person) { const b = new e.SsoBrowser(); expect((await b.sso(who, { authTime: e.nowS() })).status).toBe(303); return b }
async function upload(e: CloudEnv, b: B, folder: string, name: string, content: string) {
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
const dl = async (b: B, p: string) => (await b.call('GET', '/api/files/download?path=' + encodeURIComponent(p))).status

test('My files back from Former members: file shares inside are removed and stay removed after the next handover', async () => {
  const e = await cloudSetup()
  expect((await sync(e, payload(1, [ownerRow, minaRow, kimRow]))).ok).toBe(true)
  const mina = await signIn(e, MINA)
  expect(await upload(e, mina, '/mina (personal)', 'handover.txt', 'CANARY-HANDOVER')).toBe(200)
  const kimB = await signIn(e, KIM)
  const kim = idOf(e, 'kim@trina.app'), minaId = idOf(e, 'mina@trina.app')
  // sharing her personal folder (or a file in it) answers `personal`
  const pf = await mina.call('POST', '/api/share', { path: '/mina (personal)', add: [{ subject: { type: 'person', id: kim }, role: 'viewer' }] })
  expect(pf.status).toBe(403)
  expect(pf.data.error).toBe('personal')
  const ff = await mina.call('POST', '/api/share', { path: '/mina (personal)/handover.txt', add: [{ subject: { type: 'person', id: kim }, role: 'viewer' }] })
  expect(ff.status).toBe(409)
  expect(ff.data.error).toBe('personal')
  // mina leaves: an admin (Editor of Former members) shares the handed-over file with kim
  expect((await sync(e, payload(2, [ownerRow, kimRow]))).ok).toBe(true)
  const owner = await signIn(e, OWNER)
  const s = await owner.call('POST', '/api/share', { path: '/Former members/mina/handover.txt', add: [{ subject: { type: 'person', id: kim }, role: 'viewer' }] })
  expect(s.status).toBe(200)
  expect(await dl(kimB, '/Former members/mina/handover.txt')).toBe(200)
  // mina comes back: the folder is her My files again, the share is gone (audited), kim reads nothing
  expect((await sync(e, payload(3, [ownerRow, minaRow, kimRow]))).ok).toBe(true)
  expect(myFilesOf(e.db, minaId)).not.toBeNull()
  expect(e.db.query('SELECT count(*) AS n FROM file_grants').get()).toEqual({ n: 0 })
  expect(await dl(kimB, '/mina (personal)/handover.txt')).toBe(404)
  expect(e.db.query("SELECT 1 FROM audit WHERE command LIKE 'my files of mina: back from%file shares there cleared%'").get()).not.toBeNull()
  // she leaves again: nothing is shared again by the move out
  expect((await sync(e, payload(4, [ownerRow, kimRow]))).ok).toBe(true)
  expect(await dl(kimB, '/Former members/mina/handover.txt')).toBe(404)
  expect(await dl(owner, '/Former members/mina/handover.txt')).toBe(200)
})
