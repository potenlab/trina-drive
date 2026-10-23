// A small Trina-Cloud-like team for the drive UI scripts (web/e2e/*.mjs): managed storage, team folders with rules,
// and people who sign in with a password. Serves the built app (web/dist) over plain HTTP on 127.0.0.1.
//   bun web/e2e/fixture.ts [--port 0]   → prints one JSON line {"base": "...", "dir": "...", "password": "..."}, keeps serving
// People: boss (admin), mina, sam (재무 group), kim (Editor of 프로젝트), lee (Manager of 프로젝트, not an admin).
// Skills: a skill library (team/proposal: approved, with a change waiting for lee's approval).
// Folders: 공용 (Anyone in the team · Editor), 재무 (restricted: nobody yet), 경영 (경영 group · Editor, No AI),
//          프로젝트 (Anyone · Viewer; kim Editor; lee Manager), 프로젝트/비밀 (restricted here: lee only).
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../../src/db'
import { createManagedFolder } from '../../src/managed/folders'
import { metaSet } from '../../src/managed/settings'
import { makeCtx } from '../../src/session'
import { addGroup, addMember, addPerson, grantManage, setFlag, setRule } from '../../src/store'
import { approveVersion, designate, folderRowAt, libraries, pendingOf, scan } from '../../src/skills/core'
import { createSession, hashPassword } from '../../src/web/auth'
import { OutboxMailer } from '../../src/web/mail'
import { makeWebCtx, serveWeb } from '../../src/web/server'
import { setInviteHandler } from '../../src/share/invite'
import { applyShareInvites } from '../../src/share/invites'
import { reconcileMyFiles } from '../../src/tdcloud/my-files'

const PASSWORD = 'correct horse battery'
// --cloud: Trina Cloud mode, SSO only (src/tdcloud): mina and sam come from the console and have My files; invitations
// by mail are recorded (GET <hooks>/invited) and POST <hooks>/join {email, name} lets an invited address join as a
// console member (pending shares applied, a session cookie answered). mina and sam: no password here; their
// sessions are made directly and printed; boss and the others keep a password. Console at http://console.test.
const CLOUD = process.argv.includes('--cloud')
if (CLOUD) {
  const { publicKey } = crypto.generateKeyPairSync('ed25519')
  const x = (publicKey.export({ format: 'jwk' }) as { x: string }).x
  Object.assign(process.env, { TDRIVE_CLOUD_ISSUER: 'http://console.test', TDRIVE_CLOUD_TEAM: 'team_0123456789abcdef0123', TDRIVE_CLOUD_SSO_KEYS: JSON.stringify([{ kid: 'k1', x }]),
    TDRIVE_CLOUD_CONSOLE_URL: 'http://console.test', TDRIVE_SSO_ONLY: '1' })
}
const port = process.argv.includes('--port') ? Number(process.argv[process.argv.indexOf('--port') + 1]) || 0 : 0
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tdrive-ui-')))
const db = openDb(dir)
const ctx = makeCtx(db, dir)
metaSet(db, 'storage_mode', 'managed')
makeWebCtx(ctx, {}) // web tables

const people: [string, boolean][] = [['boss', true], ['mina', false], ['sam', false], ['kim', false], ['lee', false]]
for (const [n, admin] of people) addPerson(db, n, admin)
for (const g of ['전체', '재무', '경영']) addGroup(db, g)
for (const [n] of people) addMember(db, '전체', n)
addMember(db, '재무', 'sam'); addMember(db, '경영', 'boss')
const hash = await hashPassword(PASSWORD)
const pid = (n: string) => db.query<{ id: number }, [string]>('SELECT id FROM people WHERE name = ?').get(n)!.id
for (const [n] of people) db.query('INSERT INTO accounts (person_id, email, password_hash, created_at, password_set_at) VALUES (?, ?, ?, ?, ?)').run(pid(n), `${n}@trina.test`, hash, Date.now(), Date.now())

const mk = (name: string) => createManagedFolder(db, dir, { name })
const common = mk('공용'), fin = mk('재무'), exec = mk('경영'), proj = mk('프로젝트'), skills = mk('Skills')
setRule(db, common.path, '@전체', 'write')
setRule(db, exec.path, '@경영', 'write'); setFlag(db, exec.path, 'no_ai', true)
setRule(db, proj.path, '@전체', 'read'); setRule(db, proj.path, 'kim', 'write'); setRule(db, proj.path, 'lee', 'write'); grantManage(db, proj.path, 'lee')
setRule(db, skills.path, '@전체', 'read'); setRule(db, skills.path, 'boss', 'write'); setRule(db, skills.path, 'lee', 'write'); grantManage(db, skills.path, 'lee')
// boss puts the files in (an admin does not read folders by default), then loses that access again
setRule(db, fin.path, 'boss', 'write'); setRule(db, proj.path, 'boss', 'write')

const { server } = serveWeb(ctx, port, '127.0.0.1', { mailer: new OutboxMailer(dir, true), webDir: path.join(import.meta.dir, '..', 'dist') })
const base = `http://127.0.0.1:${server.port}`

// files, uploaded the way the page does (as boss)
async function session(name: string) {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ login: name, password: PASSWORD }) })
  const cookie = /tdrive_session=[^;]+/.exec(r.headers.get('set-cookie') ?? '')![0]
  const csrf = ((await r.json()) as { csrf: string }).csrf
  return { cookie, csrf }
}
const s = await session('boss')
const h = { cookie: s.cookie, 'x-csrf-token': s.csrf, origin: base }
async function upload(folder: string, name: string, text: string) {
  const form = new FormData(); form.append('file', new File([text], name))
  const r = await fetch(`${base}/api/files/upload?path=${encodeURIComponent(folder)}`, { method: 'POST', headers: h, body: form })
  if (!r.ok) throw new Error(`upload ${folder}/${name}: ${r.status} ${await r.text()}`)
}
async function folder(at: string, name: string) {
  const r = await fetch(`${base}/api/files/folder`, { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: JSON.stringify({ path: at, name }) })
  if (!r.ok) throw new Error(`mkdir ${at}/${name}: ${r.status} ${await r.text()}`)
}
await upload('/공용', '안내.md', '# 팀 안내\n공용 폴더 CANARY-PUB-1042\n')
await upload('/공용', '2026 로드맵.pptx', 'slides')
await upload('/공용', 'brand-guide.pdf', '%PDF-1.4 fake')
await folder('/공용', '디자인')
await upload('/공용/디자인', 'logo.png', 'png')
await upload('/재무', '결산 2026 Q3.md', '# Q3 결산\n매출 CANARY-FIN-7731\n')
await upload('/재무', '예산.xlsx', 'xlsx')
await upload('/경영', '이사회.md', 'CANARY-EXEC-5520')
await upload('/프로젝트', '계획.md', '# 계획\nCANARY-PROJ-3301')
await folder('/프로젝트', '비밀')
await upload('/프로젝트/비밀', '계약.docx', 'docx')
setRule(db, path.join(proj.path, '비밀'), 'lee', 'write', { breakInherit: true })
db.query("DELETE FROM rules WHERE subject_type = 'person' AND subject_id = ? AND folder_id IN (?, ?)").run(pid('boss'), fin.id, proj.id)

// team skills (workstream I1): /Skills is a library; team/proposal approved by lee, then changed by boss (pending)
const md = (d: string) => `---\nname: proposal\ndescription: ${d}\n---\n# Proposal\n\n1. Read the brief.\n2. Draft in /drafts.\n`
await folder('/Skills', 'proposal')
await upload('/Skills/proposal', 'SKILL.md', md('Write a client proposal the Trina way'))
designate(db, folderRowAt(db, skills.path), 'team', pid('boss'))
scan(db, dir)
const lib = libraries(db).find((l) => l.slug === 'team')!
const v1 = pendingOf(db, lib.folder_id, 'proposal')!
approveVersion(db, dir, v1.id, pid('lee'), v1.digest)
await fetch(`${base}/api/files/upload?path=${encodeURIComponent('/Skills/proposal')}&conflict=replace`, { method: 'POST', headers: h, body: (() => { const f = new FormData(); f.append('file', new File([md('Write a client proposal the Trina way, with pricing')], 'SKILL.md')); return f })() })
scan(db, dir)

const sessions: Record<string, string> = {}
let hooks: string | null = null
if (CLOUD) {
  for (const n of ['mina', 'sam']) {
    db.query('UPDATE accounts SET cloud_user = ?, password_hash = NULL WHERE person_id = ?').run(`usr_${n}`, pid(n))
    sessions[n] = createSession(db, pid(n)).cookie
  }
  // My files (workstream B2): the member sync makes one per console member; here once, at the start
  reconcileMyFiles(db, dir)
  // S16: the console's invite flow, stood in for (no console here): the address is "invited", the person arrives later
  const invited: string[] = []
  setInviteHandler(async (_w, req) => { invited.push(req.email); return { status: 'invited' } })
  // …and arrives through this hook, as the member sync would: an active console member, pending shares applied, My files made
  const hook = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    async fetch(req) {
      const u = new URL(req.url)
      if (u.pathname === '/invited') return Response.json({ invited })
      if (u.pathname === '/join' && req.method === 'POST') {
        const { email, name } = (await req.json()) as { email: string; name: string }
        const p = addPerson(db, name, false)
        addMember(db, '전체', name)
        db.query('INSERT INTO accounts (person_id, email, password_hash, created_at, cloud_user) VALUES (?, ?, NULL, ?, ?)').run(p.id, email, Date.now(), `usr_${name}`)
        const applied = applyShareInvites(db, p.id, email)
        reconcileMyFiles(db, dir, { only: p.id })
        return Response.json({ applied, cookie: createSession(db, p.id).cookie })
      }
      return new Response('not found', { status: 404 })
    },
  })
  hooks = `http://127.0.0.1:${hook.port}`
}
console.log(JSON.stringify({ base, dir, password: PASSWORD, sessions, hooks }))
process.on('SIGTERM', () => { server.stop(true); fs.rmSync(dir, { recursive: true, force: true }); process.exit(0) })
process.on('SIGINT', () => { server.stop(true); fs.rmSync(dir, { recursive: true, force: true }); process.exit(0) })
