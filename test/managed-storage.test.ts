// Managed storage, what it keeps (plan 2.2 "관리 모드"): atomic placement and content hashes, concurrent uploads of
// one name, resumable uploads (offsets, damaged chunks, resume, whole-file sha256), quota (trash and versions count),
// version retention, trash expiry, the text mirror after a replace (search and "view text"), an audit row for every
// change, promote into managed folders (new file, overwrite = new version, widening → approval), the reconciler
// leaving managed folders alone, and the admin's view and folder creation.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { verifyAudit } from '../src/audit'
import { reconcile } from '../src/inplace/reconcile'
import { managedIdle, purgeExpired, rescan, usage } from '../src/managed/ops'
import { MANAGED_LIMITS, metaSet, systemDirs } from '../src/managed/settings'
import { approvalById, setPromote } from '../src/promote'
import { sampleDocx } from '../src/samples'
import { grantManage } from '../src/store'
import { totpSecretOf } from '../src/web/mfa'
import { totpAt } from '../src/web/totp'
import { handleWeb } from '../src/web/server'
import { managedSetup, type ManagedEnv } from './managed-helpers'

let e: ManagedEnv
type B = InstanceType<ManagedEnv['Browser']>
let kim: B, boss: B, dion: B
const q = encodeURIComponent
const sha = (b: string | Uint8Array) => crypto.createHash('sha256').update(b).digest('hex')

beforeEach(async () => {
  e = await managedSetup()
  ;[kim, boss, dion] = await Promise.all([e.as('kim'), e.as('boss'), e.as('dion')])
})
afterEach(() => e.cleanup())

const versionsOf = async (b: B, p: string) => (await b.call('GET', '/api/files/versions?path=' + q(p))).data.versions as { version: number; size: number; sha256: string | null; current: boolean }[]
const download = async (b: B, p: string) => {
  const r = await handleWeb(e.w, new Request('http://drive.test/api/files/download?path=' + q(p), { headers: { cookie: `tdrive_session=${b.cookie}` } }), '10.0.0.1')
  return { status: r.status, bytes: new Uint8Array(await r.arrayBuffer()), headers: r.headers }
}

describe('placing files', () => {
  test('upload stores exactly the bytes (any size, streamed back), with sha256, mode 0600, and no staging left behind', async () => {
    const big = crypto.randomBytes(3 * 1024 * 1024 + 17)
    const r = await e.upload(kim, '/팀', 'big.bin', big)
    expect(r.status).toBe(200)
    const real = path.join(e.team.path, 'big.bin')
    expect(fs.statSync(real).mode & 0o777).toBe(0o600)
    const d = await download(kim, '/팀/big.bin')
    expect(d.status).toBe(200)
    expect(Buffer.from(d.bytes).equals(big)).toBe(true)
    expect(d.headers.get('content-disposition')).toStartWith('attachment')
    expect(d.headers.get('content-type')).toBe('application/octet-stream')
    expect(d.headers.get('content-length')).toBe(String(big.length))
    expect((await versionsOf(kim, '/팀/big.bin'))[0]!.sha256).toBe(sha(big))
    expect(fs.readdirSync(systemDirs(path.dirname(e.team.path)).uploads)).toEqual([])
    // several files in one request
    const m = await e.upload(kim, '/팀', [{ name: 'x.md', content: 'x' }, { name: 'big.bin', content: 'clash' }, { name: '.DS_Store', content: 'no' }])
    expect(m.data.results.map((x: { ok: boolean; error?: string }) => x.error ?? 'ok')).toEqual(['ok', 'exists', 'bad_name'])
  })

  test('the same name uploaded at once: fail → one wins; replace → two versions; rename → both kept', async () => {
    const both = (conflict: string, name: string) => Promise.all([e.upload(kim, '/팀', name, 'first', conflict), e.upload(boss, '/팀', name, 'second', conflict)])
    const f = await both('fail', 'f.txt')
    expect(f.map((r) => r.status).sort()).toEqual([200, 409])
    const r = await both('replace', 'r.txt')
    expect(r.map((x) => x.status)).toEqual([200, 200])
    expect((await versionsOf(kim, '/팀/r.txt')).map((v) => v.version)).toEqual([2, 1])
    const n = await both('rename', 'n.txt')
    expect(n.map((x) => x.data.path).sort()).toEqual(['/팀/n (1).txt', '/팀/n.txt'])
    expect(await e.names(kim, '/팀')).toEqual(['f.txt', 'n (1).txt', 'n.txt', 'r.txt'])
  })

  test('replace keeps the old bytes as an earlier version; restoring one makes a new version; retention drops the oldest', async () => {
    metaSet(e.db, 'versions_kept', '2')
    for (let i = 1; i <= 5; i++) expect((await e.upload(kim, '/팀', 'doc.md', `v${i}\n`, i === 1 ? undefined : 'replace')).status).toBe(200)
    const vs = await versionsOf(kim, '/팀/doc.md')
    expect(vs.map((v) => v.version)).toEqual([5, 4, 3])
    // dropped version bytes are gone from the store; kept ones are there
    const store = systemDirs(path.dirname(e.team.path)).versions
    const blobs = fs.readdirSync(store, { recursive: true }).map(String).filter((n) => /^[0-9a-f]{2}\/[0-9a-f]{64}$/.test(n)).map((n) => n.slice(3)).sort()
    expect(blobs).toEqual([sha('v3\n'), sha('v4\n')].sort())
    expect((await kim.call('POST', '/api/files/versions/restore', { path: '/팀/doc.md', version: 3 })).data.version).toBe(6)
    expect(Buffer.from((await download(kim, '/팀/doc.md')).bytes).toString()).toBe('v3\n')
    expect((await versionsOf(kim, '/팀/doc.md')).map((v) => v.version)).toEqual([6, 5, 4])
    expect((await kim.call('GET', `/api/files/versions/download?path=${q('/팀/doc.md')}&v=3`)).status).toBe(404)
    // a rename or a move keeps the history (same file)
    expect((await kim.call('POST', '/api/files/rename', { path: '/팀/doc.md', name: 'doc2.md' })).status).toBe(200)
    expect((await kim.call('POST', '/api/files/move', { paths: ['/팀/doc2.md'], to: '/내폴더' })).status).toBe(200)
    expect((await versionsOf(kim, '/내폴더/doc2.md')).map((v) => v.version)).toEqual([6, 5, 4])
  })
})

describe('resumable uploads', () => {
  test('chunks at offsets, a damaged chunk and a wrong offset refused, resume after a drop, sha256 of the whole checked', async () => {
    const before = MANAGED_LIMITS.chunkBytes
    MANAGED_LIMITS.chunkBytes = 64 * 1024
    try {
      const data = crypto.randomBytes(300 * 1024 + 5)
      const s = await kim.call('POST', '/api/uploads', { path: '/팀', name: 'video.mp4', size: data.length, sha256: sha(data) })
      expect(s.status).toBe(200)
      const id = s.data.id as string
      expect(s.data.chunk_size).toBe(64 * 1024)
      const put = (off: number, bytes: Uint8Array, h: Record<string, string> = {}) =>
        e.send(kim, 'PUT', `/api/uploads/${id}?offset=${off}`, bytes, { 'content-length': String(bytes.length), 'content-type': 'application/octet-stream', ...h })
      const C = 64 * 1024
      expect((await put(0, data.subarray(0, C))).data.received).toBe(C)
      // resent chunk / wrong offset: 409 with where it stands
      const again = await put(0, data.subarray(0, C))
      expect(again.status).toBe(409)
      expect(again.headers.get('x-upload-received')).toBe(String(C))
      // a chunk damaged on the way (its sha256 does not match)
      const bad = await put(C, data.subarray(C, 2 * C), { 'x-chunk-sha256': sha('something else') })
      expect(bad.status).toBe(422)
      expect((await kim.call('GET', `/api/uploads/${id}`)).data.received).toBe(C)
      // too large a chunk
      expect((await put(C, data.subarray(C, C + C + 1))).status).toBe(413)
      // completing early is refused; then the rest, resuming from what the server says
      expect((await kim.call('POST', `/api/uploads/${id}/complete`)).data.error).toBe('incomplete')
      for (let off = (await kim.call('GET', `/api/uploads/${id}`)).data.received; off < data.length; off += C) {
        const part = data.subarray(off, off + C)
        expect((await put(off, part, { 'x-chunk-sha256': sha(part) })).status).toBe(200)
      }
      const done = await kim.call('POST', `/api/uploads/${id}/complete`)
      expect(done.status).toBe(200)
      expect(done.data.path).toBe('/팀/video.mp4')
      expect(Buffer.from((await download(kim, '/팀/video.mp4')).bytes).equals(data)).toBe(true)
      expect((await kim.call('POST', `/api/uploads/${id}/complete`)).data).toMatchObject({ path: '/팀/video.mp4', already: true })

      // the whole file differs from what the client said it sent: refused, nothing placed
      const s2 = await kim.call('POST', '/api/uploads', { path: '/팀', name: 'wrong.bin', size: 4, sha256: sha('abcd') })
      expect((await e.send(kim, 'PUT', `/api/uploads/${s2.data.id}?offset=0`, new TextEncoder().encode('abce'), { 'content-length': '4' })).status).toBe(200)
      const w = await kim.call('POST', `/api/uploads/${s2.data.id}/complete`)
      expect(w.status).toBe(422)
      expect(w.data.error).toBe('checksum_mismatch')
      expect(await e.names(kim, '/팀')).toEqual(['video.mp4'])

      // a name taken meanwhile: the upload stays open and can be completed as "replace"
      const s3 = await kim.call('POST', '/api/uploads', { path: '/팀', name: 'video.mp4', size: 2, conflict: 'fail' })
      expect((await e.send(kim, 'PUT', `/api/uploads/${s3.data.id}?offset=0`, new TextEncoder().encode('v2'), { 'content-length': '2' })).status).toBe(200)
      expect((await kim.call('POST', `/api/uploads/${s3.data.id}/complete`)).status).toBe(409)
      expect((await kim.call('POST', `/api/uploads/${s3.data.id}/complete`, { conflict: 'replace' })).data.version).toBe(2)
      // a cancelled upload leaves nothing
      const s4 = await kim.call('POST', '/api/uploads', { path: '/팀', name: 'gone.bin', size: 10 })
      expect((await kim.call('DELETE', `/api/uploads/${s4.data.id}`)).status).toBe(200)
      expect(fs.readdirSync(systemDirs(path.dirname(e.team.path)).uploads)).toEqual([])
    } finally { MANAGED_LIMITS.chunkBytes = before }
  })

  test('rules changed between start and complete: judged again at completion', async () => {
    const s = await kim.call('POST', '/api/uploads', { path: '/팀', name: 'late.txt', size: 2 })
    await e.send(kim, 'PUT', `/api/uploads/${s.data.id}?offset=0`, new TextEncoder().encode('hi'), { 'content-length': '2' })
    e.db.query("UPDATE rules SET level = 1 WHERE folder_id = ?").run(e.team.id)
    expect((await kim.call('POST', `/api/uploads/${s.data.id}/complete`)).status).toBe(403)
    expect(await e.names(kim, '/팀')).toEqual([])
  })
})

describe('quota', () => {
  test('the team total counts files, trash, earlier versions and unfinished uploads; full = 507 until room is made', async () => {
    metaSet(e.db, 'storage_quota', '1000')
    expect((await e.upload(kim, '/팀', 'a.bin', 'x'.repeat(400))).status).toBe(200)
    expect((await e.upload(kim, '/팀', 'a.bin', 'y'.repeat(400), 'replace')).status).toBe(200) // 400 now + 400 earlier version
    const full = await e.upload(kim, '/팀', 'b.bin', 'z'.repeat(300))
    expect(full.status).toBe(507)
    expect(full.data.error).toBe('quota_exceeded')
    expect((await kim.call('POST', '/api/uploads', { path: '/팀', name: 'c.bin', size: 300 })).status).toBe(507)
    expect(usage(e.db)).toMatchObject({ files: 400, versions: 400, trash: 0, total: 800 })
    // deleting moves to the trash: still counted
    expect((await kim.call('POST', '/api/files/delete', { paths: ['/팀/a.bin'] })).status).toBe(200)
    expect(usage(e.db)).toMatchObject({ files: 0, trash: 400, total: 800 })
    expect((await e.upload(kim, '/팀', 'b.bin', 'z'.repeat(300))).status).toBe(507)
    // delete forever frees the file and its versions
    expect((await kim.call('POST', '/api/trash/empty')).data.deleted).toBe(1)
    expect(usage(e.db).total).toBe(0)
    expect((await e.upload(kim, '/팀', 'b.bin', 'z'.repeat(300))).status).toBe(200)
    // an open upload reserves its size
    expect((await kim.call('POST', '/api/uploads', { path: '/팀', name: 'c.bin', size: 600 })).status).toBe(200)
    expect((await e.upload(kim, '/팀', 'd.bin', 'q'.repeat(200))).status).toBe(507)
    // the largest file
    metaSet(e.db, 'storage_quota', null)
    metaSet(e.db, 'max_file_bytes', '100')
    expect((await kim.call('POST', '/api/uploads', { path: '/팀', name: 'huge.bin', size: 101 })).status).toBe(413)
  })

  test('the trash empties itself after its days; usage, file rows and folder rows follow', async () => {
    expect((await kim.call('POST', '/api/files/folder', { path: '/팀', name: 'old' })).status).toBe(200)
    expect((await e.upload(kim, '/팀/old', 'x.txt', 'xxxx')).status).toBe(200)
    expect((await e.upload(kim, '/팀/old', 'x.txt', 'yyyy', 'replace')).status).toBe(200)
    expect((await dion.call('POST', '/api/files/share', { path: '/팀/old' })).status).toBe(200) // gives it a folder row
    expect((await kim.call('POST', '/api/files/delete', { paths: ['/팀/old'] })).status).toBe(200)
    expect(usage(e.db).total).toBe(8)
    expect(purgeExpired(e.ctx, Date.now() + 29 * 86400_000)).toBe(0)
    expect(purgeExpired(e.ctx, Date.now() + 31 * 86400_000)).toBe(1)
    expect(usage(e.db).total).toBe(0)
    expect((await kim.call('GET', '/api/trash')).data.items).toEqual([])
    expect(e.db.query("SELECT 1 FROM folders WHERE path LIKE '%/old' AND ino NOT LIKE '%@gone%'").get()).toBeNull()
    expect(fs.readdirSync(systemDirs(path.dirname(e.team.path)).trash)).toEqual([])
  })
})

describe('the text mirror follows changes', () => {
  test('after a replace, search and "view text" show the new content only (plain text and an office document)', async () => {
    const search = async (s: string) => (await kim.call('GET', `/api/search?q=${q(s)}&path=${q('/팀')}`)).data.results.map((r: { path: string }) => r.path)
    expect((await e.upload(kim, '/팀', 'notes.md', '# alpha plan\n')).status).toBe(200)
    expect((await e.upload(kim, '/팀', '사양.docx', sampleDocx(['첫 번째 사양 ALPHADOC']))).status).toBe(200)
    await managedIdle(e.db)
    expect(await search('alpha')).toEqual(['/팀/notes.md', '/팀/사양.docx'])
    expect((await e.upload(kim, '/팀', 'notes.md', '# beta plan\n', 'replace')).status).toBe(200)
    expect((await e.upload(kim, '/팀', '사양.docx', sampleDocx(['두 번째 사양 BETADOC']), 'replace')).status).toBe(200)
    await managedIdle(e.db)
    expect(await search('alpha')).toEqual([])
    expect(await search('beta')).toEqual(['/팀/notes.md', '/팀/사양.docx'])
    expect((await e.text(kim, '/팀/notes.md')).data.text).toBe('# beta plan\n')
    expect((await e.text(kim, '/팀/사양.docx')).data.text).toContain('BETADOC')
    // agents read the new text too (the same mirror, by identity)
    expect((await e.sh('kim', 'cat /팀/사양.docx')).stdout).toContain('BETADOC')
  })
})

describe('audit', () => {
  test('every change (and every refused attempt) is an audit row of the person, in an intact chain', async () => {
    const pid = e.pid('kim')
    const start = e.auditRows().length
    await e.upload(kim, '/팀', 'a.txt', 'a')
    await e.upload(kim, '/팀', 'a.txt', 'b', 'replace')
    await kim.call('POST', '/api/files/folder', { path: '/팀', name: 'd' })
    await kim.call('POST', '/api/files/rename', { path: '/팀/a.txt', name: 'b.txt' })
    await kim.call('POST', '/api/files/move', { paths: ['/팀/b.txt'], to: '/팀/d' })
    await kim.call('POST', '/api/files/copy', { paths: ['/팀/d/b.txt'], to: '/내폴더' })
    await kim.call('POST', '/api/files/versions/restore', { path: '/팀/d/b.txt', version: 1 })
    await kim.call('POST', '/api/files/delete', { paths: ['/팀/d'] })
    const t = (await kim.call('GET', '/api/trash')).data.items[0]
    await kim.call('POST', `/api/trash/${t.id}/restore`)
    await e.upload(kim, '/임원', 'x.txt', 'x')
    const rows = e.auditRows().slice(start).filter((r) => r.person_id === pid && /^(files|trash) (?!list|trash)/.test(r.command))
    expect(rows.map((r) => r.command.replace(/sha256 [0-9a-f]+/, 'sha256 …').replace(/#\d+/, '#n'))).toEqual([
      'files upload /팀/a.txt (1 bytes, sha256 …)',
      'files upload /팀/a.txt (new version, 1 bytes, sha256 …)',
      'files mkdir /팀/d',
      'files rename /팀/a.txt -> /팀/b.txt',
      'files move /팀/b.txt -> /팀/d/b.txt',
      'files copy /팀/d/b.txt -> /내폴더/b.txt',
      'files restore-version /팀/d/b.txt v1 (as a new version)',
      'files delete /팀/d (to the trash, 1 files)',
      'trash restore #n -> /팀/d',
      'files upload /임원',
    ])
    expect(rows.at(-1)!.outcome).toBe('not_found')
    expect(JSON.parse(rows[4]!.files)).toEqual(['/팀/b.txt', '/팀/d/b.txt'])
    expect(verifyAudit(e.db).ok).toBe(true)
  })

  test('a move into a folder more people read is allowed for a person, and the audit row says it widens', async () => {
    await e.upload(boss, '/임원', 'plan.md', 'plan')
    const r = await boss.call('POST', '/api/files/move', { paths: ['/임원/plan.md'], to: '/팀' })
    expect(r.data.results[0]).toMatchObject({ to: '/팀/plan.md', widens: 4 })
    expect(e.auditRows().at(-1)!.command).toBe('files move /임원/plan.md -> /팀/plan.md (widens: 4 more people read it)')
    expect((await e.text(kim, '/팀/plan.md')).data.text).toBe('plan')
  })

  test('if the audit row cannot be written, nothing changes on disk', async () => {
    await e.upload(kim, '/팀', 'keep.txt', 'v1')
    e.db.exec("CREATE TRIGGER no_audit BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT, 'audit down'); END")
    const tries = [
      () => e.upload(kim, '/팀', 'new.txt', 'x'),
      () => e.upload(kim, '/팀', 'keep.txt', 'v2', 'replace'),
      () => kim.call('POST', '/api/files/folder', { path: '/팀', name: 'd' }),
      () => kim.call('POST', '/api/files/rename', { path: '/팀/keep.txt', name: 'k.txt' }),
      () => kim.call('POST', '/api/files/move', { paths: ['/팀/keep.txt'], to: '/내폴더' }),
      () => kim.call('POST', '/api/files/delete', { paths: ['/팀/keep.txt'] }),
    ]
    for (const t of tries) expect((await t()).status).toBe(500)
    e.db.exec('DROP TRIGGER no_audit')
    expect(await e.names(kim, '/팀')).toEqual(['keep.txt'])
    expect(await e.names(kim, '/내폴더')).toEqual([])
    expect(Buffer.from((await download(kim, '/팀/keep.txt')).bytes).toString()).toBe('v1')
    expect((await versionsOf(kim, '/팀/keep.txt')).map((v) => v.version)).toEqual([1])
    expect(fs.readdirSync(systemDirs(path.dirname(e.team.path)).trash)).toEqual([])
  })
})

describe('agents: drafts and promote into managed folders', () => {
  test('promote writes a new file; again with overwrite makes a new version (never without asking)', async () => {
    setPromote(e.db, e.team.id, true, null)
    await e.tool('kim', 'write', { path: '/drafts/report.md', content: '# report v1\n' })
    const p1 = await e.tool('kim', 'promote', { draft: '/drafts/report.md', folder: '/팀', name: 'report.md' })
    expect(p1.structuredContent).toMatchObject({ status: 'written', path: '/팀/report.md' })
    await e.tool('kim', 'write', { path: '/drafts/report.md', content: '# report v2\n' })
    const p2 = await e.tool('kim', 'promote', { draft: '/drafts/report.md', folder: '/팀', name: 'report.md' })
    expect(p2.isError).toBe(true)
    expect(p2.content[0]!.text).toContain('overwrite: true')
    const p3 = await e.tool('kim', 'promote', { draft: '/drafts/report.md', folder: '/팀', name: 'report.md', overwrite: true })
    expect(p3.structuredContent).toMatchObject({ status: 'written', replaced: true })
    expect((await versionsOf(kim, '/팀/report.md')).map((v) => v.version)).toEqual([2, 1])
    await managedIdle(e.db)
    expect((await e.text(kim, '/팀/report.md')).data.text).toBe('# report v2\n')
    expect(fs.statSync(path.join(e.team.path, 'report.md')).mode & 0o777).toBe(0o600)
    // overwrite does nothing for in-place folders (no earlier versions there)
    setPromote(e.db, e.fid('프로젝트'), true, null)
    expect((await e.tool('kim', 'promote', { draft: '/drafts/report.md', folder: '/프로젝트', name: 'README.md', overwrite: true })).isError).toBe(true)
  })

  test('a widening overwrite waits for an approval, which replaces the file as a new version', async () => {
    setPromote(e.db, e.team.id, true, null)
    grantManage(e.db, e.exec.path, 'boss')
    await e.upload(kim, '/팀', 'plan.md', 'team plan\n')
    await e.upload(boss, '/임원', 'numbers.md', '매출 1,240,000,000\n')
    await e.tool('boss', 'read', { path: '/임원/numbers.md' })
    await e.tool('boss', 'write', { path: '/drafts/plan.md', content: 'plan with numbers\n' })
    const r = await e.tool('boss', 'promote', { draft: '/drafts/plan.md', folder: '/팀', name: 'plan.md', overwrite: true })
    const s = r.structuredContent as { status: string; approval_id: number }
    expect(s.status).toBe('input_required')
    const ap = approvalById(e.db, s.approval_id)!
    expect(ap.overwrite).toBe(1)
    expect((await kim.call('GET', '/api/files/download?path=' + q('/팀/plan.md'))).data).toBe('team plan\n')
    // boss approves his own (he manages every source) with an authenticator code (no public https address here)
    const setup = await boss.call('POST', '/api/me/totp/setup')
    expect((await boss.call('POST', '/api/me/totp/confirm', { code: totpAt(setup.data.secret, Date.now() - 30_000) })).status).toBe(200)
    const secret = totpSecretOf(e.db, e.pid('boss'))!
    expect((await boss.call('POST', `/api/approvals/${ap.id}/step-up/options`, { sha256: ap.sha256 })).data.method).toBe('totp')
    const st = await boss.call('POST', `/api/approvals/${ap.id}/step-up`, { sha256: ap.sha256, code: totpAt(secret, Date.now() + 30_000) })
    expect(st.status).toBe(200)
    const ok = await boss.call('POST', `/api/approvals/${ap.id}/approve`, { sha256: ap.sha256, assertion: st.data.assertion })
    expect(ok.status).toBe(200)
    expect((await kim.call('GET', '/api/files/download?path=' + q('/팀/plan.md'))).data).toBe('plan with numbers\n')
    expect((await versionsOf(kim, '/팀/plan.md')).map((v) => v.version)).toEqual([2, 1])
    expect(e.auditRows().some((x) => /approve promote #\d+: .* -> \/팀\/plan\.md \(new version, widening\)/.test(x.command))).toBe(true)
  })

  test('a person uploading a copy of a draft: allowed, logged, and readers inherit the draft\'s sources', async () => {
    await e.tool('boss', 'read', { path: '/경영/손익.csv' })
    await e.tool('boss', 'write', { path: '/drafts/copy.md', content: 'numbers from 경영\n' })
    const r = await e.upload(boss, '/팀', 'copy.md', 'numbers from 경영\n')
    expect(r.status).toBe(200)
    expect(e.auditRows().at(-1)!.command).toMatch(/files upload \/팀\/copy\.md .*\(a copy of 1 draft, wider than its sources\)$/)
    // kim's agent reads it: the draft's source (경영) comes into its window, so its own drafts carry it (R3/R4)
    await e.tool('kim', 'read', { path: '/팀/copy.md' })
    await e.tool('kim', 'write', { path: '/drafts/derived.md', content: 'derived\n' })
    expect([...e.draftSrc('kim', 'derived.md').keys()]).toContain(e.fid('경영'))
  })
})

describe('the reconciler and the admin', () => {
  test('the reconciler never walks managed folders: a person\'s moves there are not quarantined or indexed', async () => {
    await e.upload(boss, '/임원', 'plan.md', 'plan')
    await reconcile(e.db, { dataDir: e.dir })
    expect((await boss.call('POST', '/api/files/move', { paths: ['/임원/plan.md'], to: '/팀' })).status).toBe(200)
    const rep = await reconcile(e.db, { dataDir: e.dir })
    expect(rep.quarantined).toBe(0)
    const root = path.dirname(e.team.path)
    expect(e.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM fs_index WHERE path LIKE ? || '%'").get(root)!.n).toBe(0)
    expect((await e.text(kim, '/팀/plan.md')).data.text).toBe('plan')
  })

  test('admin creates a managed team folder (no path, no NAS), sees usage; unregister only when empty', async () => {
    const gid = e.db.query<{ id: number }, []>("SELECT id FROM groups WHERE name = '영업'").get()!.id
    const c = await dion.call('POST', '/api/folders', { name: '디자인', template: 'team', group: gid })
    expect(c.status).toBe(200)
    const f = await dion.call('GET', `/api/folders/${c.data.id}`)
    expect(f.data.folder).toMatchObject({ managed: true, nas_mode: null, can: { edit_nas: false } })
    expect(f.data.rows.every((r: { nas: unknown; warn: boolean }) => r.nas === null && !r.warn)).toBe(true)
    expect(f.data.folder.path.startsWith(path.dirname(e.team.path) + '/')).toBe(true)
    expect((await dion.call('PUT', `/api/folders/${c.data.id}/nas`, { mode: 'all' })).status).toBe(400)
    const park = await e.as('park')
    expect((await e.upload(park, '/디자인', 'logo.svg', '<svg/>')).status).toBe(200)
    expect((await e.upload(kim, '/디자인', 'x.txt', 'x')).status).toBe(404)
    expect((await dion.call('DELETE', `/api/folders/${c.data.id}`)).status).toBe(409)
    expect((await park.call('POST', '/api/files/delete', { paths: ['/디자인/logo.svg'] })).status).toBe(200)
    expect((await park.call('POST', '/api/trash/empty')).data.deleted).toBe(1)
    expect((await dion.call('DELETE', `/api/folders/${c.data.id}`)).status).toBe(200)
    expect(fs.existsSync(f.data.folder.path)).toBe(false)
    // storage: admin only
    await e.upload(kim, '/팀', 'a.bin', 'x'.repeat(1000))
    const s = await dion.call('GET', '/api/storage')
    expect(s.data).toMatchObject({ mode: 'managed', quota: null, usage: { files: 1000, count: 1 } })
    expect(s.data.folders.find((x: { name: string }) => x.name === '팀')).toMatchObject({ bytes: 1000, files: 1 })
    expect((await kim.call('GET', '/api/storage')).status).toBe(403)
    expect((await kim.call('GET', '/api/session')).data.me.storage).toBe('managed')
  })

  test('rescan brings rows in line with files put in by hand and drops rows of files that are gone', async () => {
    fs.writeFileSync(path.join(e.team.path, 'by-hand.txt'), 'hand')
    await e.upload(kim, '/팀', 'gone.txt', 'gone')
    fs.unlinkSync(path.join(e.team.path, 'gone.txt'))
    expect(rescan(e.ctx)).toEqual({ added: 1, dropped: 1 })
    expect(usage(e.db)).toMatchObject({ files: 4, count: 1 })
    expect(rescan(e.ctx)).toEqual({ added: 0, dropped: 0 })
  })
})
