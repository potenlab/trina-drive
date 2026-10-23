// WebDAV, who may do what: the mount is one more door to the same rooms (Access.forPerson, R0/R1, principle 1 and 2).
// Every method against every kind of folder, per person: hidden == nonexistent (the same status and body), read-only
// folders refuse changes (403), in-place NAS folders are not on the mount at all, and nothing here is wider than the web.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import path from 'node:path'
import { setFlag, setRule } from '../src/store'
import { davSetup, type Dav, type DavEnv } from './dav-helpers'

let e: DavEnv
let kim: Dav, boss: Dav, lee: Dav, dion: Dav
const enc = (p: string) => '/dav' + p.split('/').map(encodeURIComponent).join('/')

beforeEach(async () => {
  e = await davSetup()
  ;[kim, boss, lee, dion] = await Promise.all([e.dav('kim'), e.dav('boss'), e.dav('lee'), e.dav('dion')])
  // 팀/비밀: a break inside 팀 that only boss reads and writes (as in managed-permissions.test.ts)
  expect((await boss('MKCOL', enc('/팀/비밀'))).status).toBe(201)
  setFlag(e.db, path.join(e.team.path, '비밀'), 'inherit_break', true)
  setRule(e.db, path.join(e.team.path, '비밀'), 'boss', 'write')
  for (const [c, f] of [[kim, '/팀'], [boss, '/임원'], [boss, '/공지'], [kim, '/내폴더'], [boss, '/팀/비밀']] as const)
    expect((await c('PUT', enc(`${f}/f.txt`), { body: `in ${f}` })).status).toBe(201)
})
afterEach(() => e.cleanup())

/** status + body: what a client can tell apart (headers carry nothing path-specific on these answers) */
const shape = (r: { status: number; text: string }) => `${r.status} ${r.text}`

describe('the root shows the managed team folders each person can see, nothing else', () => {
  test('per person', async () => {
    const tops = async (c: Dav) => e.hrefs((await c('PROPFIND', '/dav/', { headers: { depth: '1' } })).text).slice(1)
    expect(await tops(kim)).toEqual(['/dav/공지/', '/dav/내폴더/', '/dav/팀/'])
    expect(await tops(boss)).toEqual(['/dav/공지/', '/dav/임원/', '/dav/팀/'])
    expect(await tops(lee)).toEqual(['/dav/공지/', '/dav/팀/'])
    // the admin gets no extra reads (and no in-place folders: 공용, 프로젝트 are NAS folders)
    expect(await tops(dion)).toEqual(['/dav/공지/', '/dav/팀/'])
    expect(e.hrefs((await kim('PROPFIND', enc('/팀') + '/', { headers: { depth: '1' } })).text)).toEqual(['/dav/팀/', '/dav/팀/f.txt'])
    expect(e.hrefs((await boss('PROPFIND', enc('/팀') + '/', { headers: { depth: '1' } })).text)).toEqual(['/dav/팀/', '/dav/팀/f.txt', '/dav/팀/비밀/'])
  })
})

describe('the matrix', () => {
  // folder → expected [kim, boss] for reading (PROPFIND 0 on the folder, GET of f.txt) and writing (PUT, MKCOL, DELETE)
  type Row = [folder: string, read: [number, number], write: [number, number]]
  const ROWS: Row[] = [
    ['/팀', [207, 207], [201, 201]], ['/임원', [404, 207], [409, 201]], ['/공지', [207, 207], [403, 201]], ['/내폴더', [207, 404], [201, 409]],
    ['/팀/비밀', [404, 207], [409, 201]],
    // in-place NAS folders (registered, readable on the web) are not on the mount
    ['/프로젝트', [404, 404], [409, 409]], ['/공용', [404, 404], [409, 409]], ['/경영', [404, 404], [409, 409]], ['/없는곳', [404, 404], [409, 409]],
  ]
  test('read: PROPFIND and GET', async () => {
    for (const [f, [k, b]] of ROWS) {
      expect([f, (await kim('PROPFIND', enc(f) + '/', { headers: { depth: '0' } })).status]).toEqual([f, k])
      expect([f, (await boss('PROPFIND', enc(f) + '/', { headers: { depth: '0' } })).status]).toEqual([f, b])
      const gk = (await kim('GET', enc(`${f}/f.txt`))).status, gb = (await boss('GET', enc(`${f}/f.txt`))).status
      expect([f, gk, gb]).toEqual([f, k === 207 ? 200 : 404, b === 207 ? 200 : 404])
    }
  })
  test('write: PUT a new file, MKCOL, PUT over f.txt, DELETE f.txt, PROPPATCH, LOCK', async () => {
    for (const [f, , [k, b]] of ROWS) {
      for (const [who, c, want] of [['kim', kim, k], ['boss', boss, b]] as const) {
        expect([who, f, 'put', (await c('PUT', enc(`${f}/${who}.txt`), { body: 'x' })).status]).toEqual([who, f, 'put', want])
        expect([who, f, 'mkcol', (await c('MKCOL', enc(`${f}/${who}-dir`))).status]).toEqual([who, f, 'mkcol', want])
      }
    }
    // changing an existing file: where hidden, exactly as if nothing were there (its folder "does not exist": PUT and
    // LOCK 409, PROPPATCH and DELETE 404); where read-only, 403
    const exist: [string, number, number][] = [['/팀', 204, 204], ['/임원', 404, 204], ['/공지', 403, 204], ['/내폴더', 204, 404], ['/팀/비밀', 404, 204]]
    const asNew = (s: number) => s === 404 ? 409 : s
    for (const [f, k2, b2] of exist) {
      expect([f, (await kim('PUT', enc(`${f}/f.txt`), { body: 'k' })).status]).toEqual([f, asNew(k2)])
      expect([f, (await boss('PUT', enc(`${f}/f.txt`), { body: 'b' })).status]).toEqual([f, asNew(b2)])
      const pp = '<D:propertyupdate xmlns:D="DAV:" xmlns:Z="urn:z"><D:set><D:prop><Z:a>1</Z:a></D:prop></D:set></D:propertyupdate>'
      expect([f, (await kim('PROPPATCH', enc(`${f}/f.txt`), { body: pp })).status]).toEqual([f, k2 === 204 ? 207 : k2])
      const li = '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>'
      const lk = await kim('LOCK', enc(`${f}/f.txt`), { body: li })
      expect([f, lk.status]).toEqual([f, k2 === 204 ? 200 : asNew(k2)])
      if (lk.status === 200) await kim('UNLOCK', enc(`${f}/f.txt`), { headers: { 'lock-token': lk.headers.get('lock-token')! } })
    }
    for (const [f, k2, b2] of exist) {
      expect([f, (await kim('DELETE', enc(`${f}/f.txt`))).status]).toEqual([f, k2])
      if (k2 !== 204) expect([f, (await boss('DELETE', enc(`${f}/f.txt`))).status]).toEqual([f, b2])
    }
  })
  test('hidden == nonexistent: the same answer for every method', async () => {
    const probes: [string, Record<string, string>, string?][] = [
      ['PROPFIND', { depth: '0' }], ['PROPFIND', { depth: '1' }], ['GET', {}], ['HEAD', {}], ['DELETE', {}], ['MKCOL', {}],
      ['PUT', {}, 'x'], ['MOVE', { destination: 'https://drive.test' + enc('/팀/moved') }], ['COPY', { destination: 'https://drive.test' + enc('/팀/copied') }],
      ['PROPPATCH', {}, '<D:propertyupdate xmlns:D="DAV:"><D:set><D:prop><D:x/></D:prop></D:set></D:propertyupdate>'],
      ['LOCK', {}, '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>'],
      ['UNLOCK', { 'lock-token': '<opaquelocktoken:x>' }],
    ]
    // kim cannot see /임원 or /팀/비밀; /없는곳 and /팀/없음 do not exist. (Making something under a name taken by a
    // hidden item in a folder you can write says "exists": the documented hole, tested below, so those probes are
    // left out for /팀/비밀 itself.)
    const pairs: [string, string][] = [['/임원', '/없는곳'], ['/임원/f.txt', '/없는곳/f.txt'], ['/팀/비밀', '/팀/없음'], ['/팀/비밀/f.txt', '/팀/없음/f.txt'], ['/임원/sub/x', '/없는곳/sub/x']]
    for (const [hidden, missing] of pairs) for (const [m, headers, body] of probes) {
      if (hidden === '/팀/비밀' && ['MKCOL', 'PUT', 'LOCK'].includes(m)) continue
      const a = await kim(m, enc(hidden), { headers, body })
      const b = await kim(m, enc(missing), { headers, body })
      expect([hidden, m, shape(a)]).toEqual([hidden, m, shape(b)])
    }
    // as a destination too
    await kim('PUT', enc('/팀/mine.txt'), { body: 'm' })
    for (const m of ['MOVE', 'COPY']) {
      const a = await kim(m, enc('/팀/mine.txt'), { headers: { destination: 'https://drive.test' + enc('/임원/x.txt') } })
      const b = await kim(m, enc('/팀/mine.txt'), { headers: { destination: 'https://drive.test' + enc('/없는곳/x.txt') } })
      expect([m, shape(a)]).toEqual([m, shape(b)])
      expect(a.status).toBe(409)
    }
  })
  test('the documented hole: a name taken by a hidden folder in a folder you write answers "exists" (as on the web)', async () => {
    expect((await kim('MKCOL', enc('/팀/비밀'))).status).toBe(405)
    expect((await kim('PUT', enc('/팀/비밀'), { body: 'x' })).status).toBe(409)
    // and nothing about what is inside leaks
    expect((await kim('PROPFIND', enc('/팀/비밀') + '/', { headers: { depth: '0' } })).status).toBe(404)
  })
  test('moves and copies between folders follow write on both ends; a folder with hidden items does not move', async () => {
    await kim('PUT', enc('/팀/k.txt'), { body: 'k' })
    // into a read-only folder
    expect((await kim('MOVE', enc('/팀/k.txt'), { headers: { destination: 'https://drive.test' + enc('/공지/k.txt') } })).status).toBe(403)
    expect((await kim('COPY', enc('/팀/k.txt'), { headers: { destination: 'https://drive.test' + enc('/공지/k.txt') } })).status).toBe(403)
    // out of a read-only folder: copy yes, move no
    expect((await kim('COPY', enc('/공지/f.txt'), { headers: { destination: 'https://drive.test' + enc('/팀/notice-copy.txt') } })).status).toBe(201)
    expect((await kim('MOVE', enc('/공지/f.txt'), { headers: { destination: 'https://drive.test' + enc('/팀/stolen.txt') } })).status).toBe(403)
    // into an in-place folder kim writes on the NAS (프로젝트 has @전체 write): not on the mount
    expect((await kim('COPY', enc('/팀/k.txt'), { headers: { destination: 'https://drive.test' + enc('/프로젝트/k.txt') } })).status).toBe(409)
    // 팀 holds 비밀 (kim cannot see it): kim cannot delete or move 팀's subtree that contains it
    await boss('MKCOL', enc('/팀/outer'))
    await boss('MOVE', enc('/팀/비밀'), { headers: { destination: 'https://drive.test' + enc('/팀/outer/비밀') } })
    expect((await kim('DELETE', enc('/팀/outer'))).status).toBe(403)
    expect((await kim('MOVE', enc('/팀/outer'), { headers: { destination: 'https://drive.test' + enc('/내폴더/outer') } })).status).toBe(403)
    // copying it copies what kim sees (nothing of 비밀)
    expect((await kim('COPY', enc('/팀/outer'), { headers: { destination: 'https://drive.test' + enc('/내폴더/outer') } })).status).toBe(201)
    expect(e.hrefs((await kim('PROPFIND', enc('/내폴더/outer') + '/', { headers: { depth: '1' } })).text)).toEqual(['/dav/내폴더/outer/'])
  })
  test('“No AI” does not close folders to people (the mount is a person, not an agent); quarantine does', async () => {
    setFlag(e.db, e.team.path, 'no_ai', true)
    expect((await kim('GET', enc('/팀/f.txt'))).status).toBe(200)
    setFlag(e.db, e.team.path, 'quarantine', true)
    expect((await kim('GET', enc('/팀/f.txt'))).status).toBe(404)
    expect((await kim('PUT', enc('/팀/new.txt'), { body: 'x' })).status).toBe(409)
  })
})
