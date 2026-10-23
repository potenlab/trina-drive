// Managed storage, who may do what (plan 2.2 "관리 모드", 4.1 R0/R1/R5, principle 1 and 2): every new operation over
// the real /api handler, per person. Hidden == missing on every endpoint (status, body and headers), no change without
// `write`, folders you cannot fully see cannot be moved or deleted, trash and versions follow R1, names are checked
// (path parts, NFC, case, system names), and nothing here opens a door for agents (they still only read, R2).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { setFlag, setRule } from '../src/store'
import { managedSetup, type ManagedEnv } from './managed-helpers'

let e: ManagedEnv
type B = InstanceType<ManagedEnv['Browser']>
let kim: B, boss: B, lee: B, dion: B

beforeEach(async () => {
  e = await managedSetup()
  ;[kim, boss, lee, dion] = await Promise.all([e.as('kim'), e.as('boss'), e.as('lee'), e.as('dion')])
  // 팀/비밀: a break inside 팀 that only boss reads and writes
  expect((await boss.call('POST', '/api/files/folder', { path: '/팀', name: '비밀' })).status).toBe(200)
  setFlag(e.db, path.join(e.team.path, '비밀'), 'inherit_break', true)
  setRule(e.db, path.join(e.team.path, '비밀'), 'boss', 'write')
  for (const [b, folder, name] of [[kim, '/팀', 'a.txt'], [boss, '/임원', 'plan.md'], [boss, '/공지', 'notice.md'], [kim, '/내폴더', 'memo.md'], [boss, '/팀/비밀', 'secret.md']] as const)
    expect((await e.upload(b, folder, name, `${name} in ${folder}\n`)).status).toBe(200)
})
afterEach(() => e.cleanup())

const q = encodeURIComponent
/** status, body and the headers a client could tell apart */
const shape = (r: { status: number; data: unknown; headers: Headers }) =>
  JSON.stringify({ status: r.status, body: r.data, h: [...r.headers].filter(([k]) => k !== 'date').sort() })

describe('listing says where you may write', () => {
  test('writable flags per person; in-place folders are never writable from the web', async () => {
    const flags = async (b: B) => Object.fromEntries((await e.list(b, '/')).data.entries.map((x: { name: string; writable: boolean }) => [x.name, x.writable]))
    expect(await flags(kim)).toEqual({ 개인_kim: false, 공용: false, 공지: false, 내폴더: true, 팀: true, 프로젝트: false })
    expect(await flags(boss)).toEqual({ 경영: false, 공용: false, 공지: true, 임원: true, 팀: true, 프로젝트: false })
    // the admin gets no extra reads or writes
    expect(await flags(dion)).toEqual({ 공용: false, 공지: false, 팀: true, 프로젝트: false })
    expect(await e.names(kim, '/팀')).toEqual(['a.txt'])
    expect(await e.names(boss, '/팀')).toEqual(['a.txt', '비밀'])
    expect((await e.list(kim, '/공지')).data.writable).toBe(false)
  })
})

describe('the matrix: every operation, every kind of folder', () => {
  // folder → [kim, boss] expected status for a write into it
  const WRITE_INTO: [string, number, number][] = [
    ['/팀', 200, 200], ['/임원', 404, 200], ['/공지', 403, 200], ['/내폴더', 200, 404], ['/팀/비밀', 404, 200],
    ['/프로젝트', 403, 403], ['/경영', 404, 403], ['/없는곳', 404, 404], ['/', 404, 404],
  ]
  test('upload (multipart) and mkdir', async () => {
    for (const [folder, k, b] of WRITE_INTO) {
      expect([folder, (await e.upload(kim, folder, 'k.txt', 'kim')).status]).toEqual([folder, k])
      expect([folder, (await e.upload(boss, folder, 'b.txt', 'boss')).status]).toEqual([folder, b])
      expect([folder, (await kim.call('POST', '/api/files/folder', { path: folder, name: 'kdir' })).status]).toEqual([folder, k])
      expect([folder, (await boss.call('POST', '/api/files/folder', { path: folder, name: 'bdir' })).status]).toEqual([folder, b])
    }
    // in-place folders say why
    expect((await e.upload(kim, '/프로젝트', 'x.txt', 'x')).data.error).toBe('not_managed')
    expect((await e.upload(kim, '/공지', 'x.txt', 'x')).data.error).toBe('no_write')
  })

  test('resumable upload start follows the same matrix; another person cannot touch my upload', async () => {
    for (const [folder, k, b] of WRITE_INTO) {
      expect([folder, (await kim.call('POST', '/api/uploads', { path: folder, name: 'big.bin', size: 10 })).status]).toEqual([folder, k])
      expect([folder, (await boss.call('POST', '/api/uploads', { path: folder, name: 'big.bin', size: 10 })).status]).toEqual([folder, b])
    }
    const u = (await kim.call('POST', '/api/uploads', { path: '/팀', name: 'mine.bin', size: 3 })).data
    expect((await boss.call('GET', `/api/uploads/${u.id}`)).status).toBe(404)
    expect((await e.send(boss, 'PUT', `/api/uploads/${u.id}?offset=0`, new Uint8Array([1, 2, 3]), { 'content-length': '3' })).status).toBe(404)
    expect((await boss.call('POST', `/api/uploads/${u.id}/complete`)).status).toBe(404)
    expect((await boss.call('DELETE', `/api/uploads/${u.id}`)).status).toBe(404)
    expect((await kim.call('GET', `/api/uploads/${u.id}`)).data.received).toBe(0)
  })

  test('rename: write on the folder it is in; top folders are the admin\'s', async () => {
    expect((await kim.call('POST', '/api/files/rename', { path: '/팀/a.txt', name: 'b.txt' })).status).toBe(200)
    expect(await e.names(kim, '/팀')).toEqual(['b.txt'])
    expect((await kim.call('POST', '/api/files/rename', { path: '/공지/notice.md', name: 'x.md' })).status).toBe(403)
    expect((await kim.call('POST', '/api/files/rename', { path: '/임원/plan.md', name: 'x.md' })).status).toBe(404)
    expect((await kim.call('POST', '/api/files/rename', { path: '/팀/비밀', name: 'open' })).status).toBe(404)
    expect((await kim.call('POST', '/api/files/rename', { path: '/팀', name: 'x' })).data.error).toBe('top_folder')
    expect((await boss.call('POST', '/api/files/rename', { path: '/팀/비밀', name: '비밀2' })).status).toBe(200)
    // the rules followed the folder (identity): kim still sees nothing, boss sees it under the new name
    expect(await e.names(kim, '/팀')).toEqual(['b.txt'])
    expect(await e.names(boss, '/팀/비밀2')).toEqual(['secret.md'])
  })

  test('move: write where it leaves and where it lands; targets you cannot see are missing', async () => {
    const mv = (b: B, paths: string[], to: string) => b.call('POST', '/api/files/move', { paths, to })
    expect((await mv(kim, ['/팀/a.txt'], '/임원')).status).toBe(404)
    expect((await mv(kim, ['/팀/a.txt'], '/공지')).status).toBe(403)
    expect((await mv(kim, ['/팀/a.txt'], '/프로젝트')).status).toBe(403)
    const r = await mv(kim, ['/팀/a.txt', '/공지/notice.md', '/임원/plan.md', '/없음.txt'], '/내폴더')
    expect(r.status).toBe(200)
    expect(r.data.results.map((x: { error?: string }) => x.error ?? 'ok')).toEqual(['ok', 'no_write', 'not_found', 'not_found'])
    expect(await e.names(kim, '/내폴더')).toEqual(['a.txt', 'memo.md'])
    // a folder into itself
    expect((await kim.call('POST', '/api/files/folder', { path: '/팀', name: 'd' })).status).toBe(200)
    expect((await kim.call('POST', '/api/files/folder', { path: '/팀/d', name: 'e' })).status).toBe(200)
    expect((await mv(kim, ['/팀/d'], '/팀/d/e')).data.results[0].error).toBe('into_itself')
    // boss moves his secret folder, rules and all, into 임원
    expect((await mv(boss, ['/팀/비밀'], '/임원')).data.results[0]).toMatchObject({ to: '/임원/비밀' })
    expect(await e.names(boss, '/임원/비밀')).toEqual(['secret.md'])
    expect((await e.list(kim, '/임원/비밀')).status).toBe(404)
    expect(e.db.query<{ path: string }, [string]>('SELECT path FROM folders WHERE path LIKE ?').get('%/비밀')!.path).toBe(path.join(e.exec.path, '비밀'))
  })

  test('a folder holding something you cannot see (or change) cannot be moved or deleted by you', async () => {
    // 팀/공용폴더 holds boss's break 숨김 that kim cannot see
    expect((await kim.call('POST', '/api/files/folder', { path: '/팀', name: '공용폴더' })).status).toBe(200)
    expect((await e.upload(kim, '/팀/공용폴더', 'x.txt', 'x')).status).toBe(200)
    expect((await boss.call('POST', '/api/files/folder', { path: '/팀/공용폴더', name: '숨김' })).status).toBe(200)
    setFlag(e.db, path.join(e.team.path, '공용폴더', '숨김'), 'inherit_break', true)
    setRule(e.db, path.join(e.team.path, '공용폴더', '숨김'), 'boss', 'write')
    expect(await e.names(kim, '/팀/공용폴더')).toEqual(['x.txt'])
    expect((await kim.call('POST', '/api/files/delete', { paths: ['/팀/공용폴더'] })).data.results[0].error).toBe('has_hidden')
    expect((await kim.call('POST', '/api/files/move', { paths: ['/팀/공용폴더'], to: '/내폴더' })).data.results[0].error).toBe('has_hidden')
    // a subfolder you can read but not write counts too
    setRule(e.db, path.join(e.team.path, '공용폴더', '숨김'), 'kim', 'read')
    expect((await kim.call('POST', '/api/files/delete', { paths: ['/팀/공용폴더'] })).data.results[0].error).toBe('has_hidden')
    // boss sees and writes all of it
    expect((await boss.call('POST', '/api/files/delete', { paths: ['/팀/공용폴더'] })).data.results[0].trash_id).toBeGreaterThan(0)
  })

  test('copy: read where it is, write where it goes', async () => {
    const cp = (b: B, paths: string[], to: string) => b.call('POST', '/api/files/copy', { paths, to })
    const r = await cp(kim, ['/공지/notice.md', '/임원/plan.md', '/팀/a.txt'], '/팀')
    expect(r.data.results.map((x: { error?: string; to?: string }) => x.error ?? x.to)).toEqual(['/팀/notice.md', 'not_found', '/팀/a (1).txt'])
    expect((await cp(kim, ['/팀/a.txt'], '/공지')).status).toBe(403)
    expect((await cp(kim, ['/팀/a.txt'], '/임원')).status).toBe(404)
    expect((await cp(boss, ['/팀/비밀'], '/임원')).data.results[0].error).toBe('is_folder')
  })

  test('versions: list and download need read (R1); restore needs write', async () => {
    expect((await e.upload(boss, '/공지', 'notice.md', 'v2\n', 'replace')).status).toBe(200)
    const v = await kim.call('GET', '/api/files/versions?path=' + q('/공지/notice.md'))
    expect(v.status).toBe(200)
    expect(v.data.versions.map((x: { version: number }) => x.version)).toEqual([2, 1])
    expect(v.data.writable).toBe(false)
    const old = await kim.call('GET', `/api/files/versions/download?path=${q('/공지/notice.md')}&v=1`)
    expect(old.status).toBe(200)
    expect(old.data).toBe('notice.md in /공지\n')
    expect(old.headers.get('content-disposition')).toStartWith('attachment')
    expect((await kim.call('POST', '/api/files/versions/restore', { path: '/공지/notice.md', version: 1 })).status).toBe(403)
    expect((await boss.call('POST', '/api/files/versions/restore', { path: '/공지/notice.md', version: 1 })).data.version).toBe(3)
    for (const u of [`/api/files/versions?path=${q('/임원/plan.md')}`, `/api/files/versions/download?path=${q('/임원/plan.md')}&v=1`])
      expect((await kim.call('GET', u)).status).toBe(404)
    expect((await kim.call('POST', '/api/files/versions/restore', { path: '/임원/plan.md', version: 1 })).status).toBe(404)
  })

  test('trash follows R1: you see what you could read where it was; restore and delete forever need write there', async () => {
    const del = (b: B, p: string) => b.call('POST', '/api/files/delete', { paths: [p] })
    expect((await del(kim, '/팀/a.txt')).status).toBe(200)
    expect((await del(boss, '/임원/plan.md')).status).toBe(200)
    expect((await del(boss, '/공지/notice.md')).status).toBe(200)
    expect((await del(kim, '/공지/notice.md')).data.results[0].error).toBe('not_found') // gone already
    const items = async (b: B) => (await b.call('GET', '/api/trash')).data.items.map((x: { name: string; from: string; can_restore: boolean }) => `${x.from}/${x.name}:${x.can_restore}`).sort()
    expect(await items(kim)).toEqual(['/공지/notice.md:false', '/팀/a.txt:true'])
    expect(await items(lee)).toEqual(['/공지/notice.md:false', '/팀/a.txt:true'])
    expect(await items(boss)).toEqual(['/공지/notice.md:true', '/임원/plan.md:true', '/팀/a.txt:true'])
    expect(await items(dion)).toEqual(['/공지/notice.md:false', '/팀/a.txt:true'])
    const id = (name: string) => e.db.query<{ id: number }, [string]>('SELECT id FROM mtrash WHERE name = ?').get(name)!.id
    // someone else's hidden trash item answers like one that does not exist
    const hidden = await kim.call('POST', `/api/trash/${id('plan.md')}/restore`)
    const missing = await kim.call('POST', '/api/trash/99999/restore')
    expect(shape(hidden)).toBe(shape(missing))
    expect(hidden.status).toBe(404)
    expect(shape(await kim.call('DELETE', `/api/trash/${id('plan.md')}`))).toBe(shape(await kim.call('DELETE', '/api/trash/99999')))
    expect((await kim.call('POST', `/api/trash/${id('notice.md')}/restore`)).status).toBe(403)
    expect((await kim.call('POST', `/api/trash/${id('a.txt')}/restore`)).data.path).toBe('/팀/a.txt')
    // empty trash: only what you may restore
    expect((await kim.call('POST', '/api/trash/empty')).data.deleted).toBe(0)
    expect((await boss.call('POST', '/api/trash/empty')).data.deleted).toBe(2)
    expect(await items(boss)).toEqual([])
  })

  test('a deleted folder holding a break stays hidden in the trash from those who could not read the break', async () => {
    expect((await boss.call('POST', '/api/files/folder', { path: '/팀', name: '프로젝트A' })).status).toBe(200)
    expect((await boss.call('POST', '/api/files/folder', { path: '/팀/프로젝트A', name: '숨김' })).status).toBe(200)
    setFlag(e.db, path.join(e.team.path, '프로젝트A', '숨김'), 'inherit_break', true)
    setRule(e.db, path.join(e.team.path, '프로젝트A', '숨김'), 'boss', 'write')
    expect((await e.upload(boss, '/팀/프로젝트A/숨김', 's.txt', 'secret')).status).toBe(200)
    expect((await boss.call('POST', '/api/files/delete', { paths: ['/팀/프로젝트A'] })).status).toBe(200)
    const names = async (b: B) => (await b.call('GET', '/api/trash')).data.items.map((x: { name: string }) => x.name)
    expect(await names(boss)).toEqual(['프로젝트A'])
    expect(await names(kim)).toEqual([])
    // restored, its rules came back with it (identity)
    const t = (await boss.call('GET', '/api/trash')).data.items[0]
    expect((await boss.call('POST', `/api/trash/${t.id}/restore`)).status).toBe(200)
    expect(await e.names(boss, '/팀/프로젝트A/숨김')).toEqual(['s.txt'])
    expect(await e.names(kim, '/팀/프로젝트A')).toEqual([])
  })

  test('share settings: managers and admins get the folder page; others do not', async () => {
    expect((await kim.call('POST', '/api/files/share', { path: '/팀' })).status).toBe(403)
    expect((await kim.call('POST', '/api/files/share', { path: '/임원' })).status).toBe(404)
    const a = await dion.call('POST', '/api/files/share', { path: '/팀/a.txt' })
    expect(a.data.folder_id).toBe(e.team.id)
    const who = await kim.call('GET', '/api/files/who?path=' + q('/팀/a.txt'))
    expect(who.data).toMatchObject({ managed: true, nas: null, can_share: false })
    expect(who.data.web.sort()).toEqual(['boss', 'dion', 'kim', 'lee', 'park'])
    expect((await dion.call('GET', '/api/files/who?path=' + q('/팀'))).data.can_share).toBe(true)
  })
})

describe('hidden == missing, byte for byte', () => {
  test('every endpoint answers a hidden path exactly like one that is not there', async () => {
    const pairs: [string, string][] = [['/임원', '/없음'], ['/임원/plan.md', '/팀/없음.md'], ['/팀/비밀', '/팀/없음'], ['/팀/비밀/secret.md', '/팀/없음/secret.md'], ['/내폴더/memo.md', '/없음/memo.md']]
    for (const [hidden, missing] of pairs) {
      const asBoth = async (f: (p: string) => Promise<{ status: number; data: unknown; headers: Headers }>) => {
        const h = await f(hidden), m = await f(missing)
        // batch answers echo the path that was asked about: compare with it blanked out
        expect([hidden, shape(h).split(hidden).join('P')]).toEqual([hidden, shape(m).split(missing).join('P')])
        expect(h.status === 404 || (h.status === 200 && JSON.stringify(h.data).includes('not_found'))).toBe(true)
      }
      const who = hidden.startsWith('/내폴더') ? boss : kim
      await asBoth((p) => e.upload(who, p, 'x.txt', 'x'))
      await asBoth((p) => who.call('POST', '/api/files/folder', { path: p, name: 'x' }))
      await asBoth((p) => who.call('POST', '/api/uploads', { path: p, name: 'x', size: 1 }))
      await asBoth((p) => who.call('POST', '/api/files/rename', { path: p, name: 'x' }))
      await asBoth((p) => who.call('POST', '/api/files/move', { paths: [p], to: '/팀' }))
      await asBoth((p) => who.call('POST', '/api/files/move', { paths: ['/팀/a.txt'], to: p }))
      await asBoth((p) => who.call('POST', '/api/files/copy', { paths: [p], to: '/팀' }))
      await asBoth((p) => who.call('POST', '/api/files/copy', { paths: ['/팀/a.txt'], to: p }))
      await asBoth((p) => who.call('POST', '/api/files/delete', { paths: [p] }))
      await asBoth((p) => who.call('GET', '/api/files/versions?path=' + q(p)))
      await asBoth((p) => who.call('GET', `/api/files/versions/download?path=${q(p)}&v=1`))
      await asBoth((p) => who.call('POST', '/api/files/versions/restore', { path: p, version: 1 }))
      await asBoth((p) => who.call('POST', '/api/files/share', { path: p }))
      await asBoth((p) => who.call('GET', '/api/files/download?path=' + q(p)))
    }
    // nothing was created anywhere by those attempts
    expect(await e.names(boss, '/임원')).toEqual(['plan.md'])
    expect(await e.names(boss, '/팀')).toEqual(['a.txt', '비밀'])
  })
})

describe('names and paths', () => {
  test('path parts, dot names, system names and control characters are refused; paths are normalized', async () => {
    for (const bad of ['../x.txt', 'a/b.txt', 'a\\b.txt', '..', '.', '', ' lead.txt', 'trail.txt ', '.DS_Store', '._x', '~$lock.docx', 'Thumbs\u0000.db', 'a\nb.txt', 'x'.repeat(256)]) {
      const r = await kim.call('POST', '/api/files/folder', { path: '/팀', name: bad })
      expect([bad, r.status, r.data.error]).toEqual([bad, 400, 'bad_name'])
      const u = await e.upload(kim, '/팀', bad || 'x', 'x')
      if (bad && !bad.includes('/') && !bad.includes('\\')) expect([bad, u.status]).toEqual([bad, 400])
    }
    // the browser sends only the last part of a file name; a path in the target parameter is normalized first
    expect((await e.upload(kim, '/팀/../임원', 'x.txt', 'x')).status).toBe(404)
    expect((await e.upload(kim, '/팀/./', 'dot.txt', 'x')).data.path).toBe('/팀/dot.txt')
    expect((await e.upload(kim, '/팀\u0000', 'x.txt', 'x')).status).toBe(404)
    expect((await kim.call('POST', '/api/files/rename', { path: '/팀/a.txt', name: '../../escape.txt' })).status).toBe(400)
    expect(fs.readdirSync(path.dirname(e.team.path)).filter((n) => n.endsWith('.txt'))).toEqual([])
  })

  test('NFC: a decomposed name is stored composed; equal names (after NFC, case-folded) are one name', async () => {
    const nfd = '한글 문서.txt'.normalize('NFD')
    expect(nfd).not.toBe(nfd.normalize('NFC'))
    const r = await e.upload(kim, '/팀', nfd, 'one')
    expect(r.status).toBe(200)
    expect(r.data.path).toBe('/팀/한글 문서.txt')
    expect(fs.readdirSync(e.team.path)).toContain('한글 문서.txt')
    expect((await e.upload(kim, '/팀', '한글 문서.txt', 'two')).status).toBe(409)
    expect((await e.upload(kim, '/팀', 'A.TXT', 'upper')).status).toBe(409)
    expect((await kim.call('POST', '/api/files/folder', { path: '/팀', name: '한글 문서.TXT'.normalize('NFD') })).status).toBe(409)
    // a decomposed path in a query finds the composed name
    const dl = await kim.call('GET', '/api/files/download?path=' + q('/팀/' + nfd))
    expect(dl.status).toBe(200)
    expect(dl.data).toBe('one')
    // a case-only rename is allowed (it is the same item)
    expect((await kim.call('POST', '/api/files/rename', { path: '/팀/a.txt', name: 'A.txt' })).data.path).toBe('/팀/A.txt')
  })

  test('content that would be taken for a link (XSym) is refused; nothing is left behind', async () => {
    const xsym = Buffer.alloc(1067, 0x20)
    xsym.write('XSym\n0012\n0123456789abcdef0123456789abcdef\n/etc/passwd\n', 'latin1')
    const r = await e.upload(kim, '/팀', 'link.txt', xsym)
    expect(r.status).toBe(422)
    expect(r.data.error).toBe('bad_content')
    expect(await e.names(kim, '/팀')).toEqual(['a.txt'])
  })
})

describe('session, CSRF and agents', () => {
  test('changes need the session and its CSRF token; agents still cannot write here', async () => {
    const anon = new e.Browser()
    expect((await anon.call('POST', '/api/files/folder', { path: '/팀', name: 'x' })).status).toBe(401)
    expect((await e.upload(anon, '/팀', 'x.txt', 'x')).status).toBe(401)
    const noCsrf = await e.send({ ...kim, csrf: undefined } as B, 'POST', '/api/files/delete', JSON.stringify({ paths: ['/팀/a.txt'] }), { 'content-type': 'application/json' })
    expect(noCsrf.status).toBe(403)
    const foreign = await e.send(kim, 'POST', '/api/files/delete', JSON.stringify({ paths: ['/팀/a.txt'] }), { 'content-type': 'application/json', origin: 'https://evil.example' })
    expect(foreign.status).toBe(403)
    expect(await e.names(kim, '/팀')).toEqual(['a.txt'])
    // an agent reads managed files by the same rules, and writes only drafts
    expect((await e.sh('kim', 'cat /팀/a.txt')).stdout).toBe('a.txt in /팀\n')
    expect((await e.sh('kim', 'ls /')).stdout.split('\n')).not.toContain('임원')
    const w = await e.sh('kim', 'echo hi > /팀/new.md; rm /팀/a.txt; mv /팀/a.txt /팀/b.txt')
    expect(w.exitCode).not.toBe(0)
    expect(await e.names(kim, '/팀')).toEqual(['a.txt'])
  })
})
