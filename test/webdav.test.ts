// WebDAV mount, litmus-style (the suites of the `litmus` WebDAV test tool, as bun tests over the real handler):
// basic, copymove, props, locks, http — plus what a mounted drive must keep from the rest of the product: HTTPS only,
// app passwords (never agent tokens), the sign-in rate limit, versions, the trash, the quota and the audit trail.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { metaSet } from '../src/managed/settings'
import { parseTrustedProxies } from '../src/web/proxy'
import { serveWeb } from '../src/web/server'
import { davSetup, type Dav, type DavEnv } from './dav-helpers'
import { PASSWORD } from './web-helpers'

let e: DavEnv
let kim: Dav
beforeEach(async () => { e = await davSetup(); kim = await e.dav('kim') })
afterEach(() => e.cleanup())

const T = '/dav/' + encodeURIComponent('팀')
const dest = (p: string) => ({ destination: 'https://drive.test' + p })
const LOCKINFO = (scope = 'exclusive', owner = 'kim') =>
  `<?xml version="1.0" encoding="utf-8"?><D:lockinfo xmlns:D="DAV:"><D:lockscope><D:${scope}/></D:lockscope><D:locktype><D:write/></D:locktype><D:owner><D:href>${owner}</D:href></D:owner></D:lockinfo>`
const token = (r: { headers: Headers }) => /<([^>]+)>/.exec(r.headers.get('lock-token') ?? '')?.[1] ?? ''

describe('basic', () => {
  test('OPTIONS says class 1 and 2, also at the server root (Windows asks there first)', async () => {
    const r = await kim('OPTIONS', '/dav/')
    expect(r.status).toBe(200)
    expect(r.headers.get('dav')).toBe('1, 2')
    expect(r.headers.get('allow')).toContain('PROPFIND')
    expect((await kim('OPTIONS', '/')).headers.get('dav')).toBe('1, 2')
  })
  test('put, get, put again (a new version), delete (to the trash)', async () => {
    expect((await kim('PUT', `${T}/res.txt`, { body: 'one' })).status).toBe(201)
    const g = await kim('GET', `${T}/res.txt`)
    expect([g.status, g.text]).toEqual([200, 'one'])
    expect(g.headers.get('etag')).toMatch(/^"[0-9a-f]{24}"$/)
    expect((await kim('PUT', `${T}/res.txt`, { body: 'two!' })).status).toBe(204)
    expect((await kim('GET', `${T}/res.txt`)).text).toBe('two!')
    const b = await e.as('kim')
    const v = await b.call('GET', '/api/files/versions?path=' + encodeURIComponent('/팀/res.txt'))
    expect(v.data.versions.map((x: { version: number }) => x.version)).toEqual([2, 1])
    expect((await kim('DELETE', `${T}/res.txt`)).status).toBe(204)
    expect((await kim('GET', `${T}/res.txt`)).status).toBe(404)
    expect((await b.call('GET', '/api/trash')).data.items.map((x: { name: string }) => x.name)).toEqual(['res.txt'])
    expect((await kim('DELETE', `${T}/res.txt`)).status).toBe(404)
  })
  test('names: UTF-8 path segments, NFD from a Mac arrives as NFC; a bad name is refused', async () => {
    const nfd = '한글 파일.txt'.normalize('NFD')
    expect((await kim('PUT', `${T}/${encodeURIComponent(nfd)}`, { body: 'x' })).status).toBe(201)
    expect((await kim('GET', `${T}/${encodeURIComponent('한글 파일.txt')}`)).text).toBe('x')
    expect(e.hrefs((await kim('PROPFIND', `${T}/`, { headers: { depth: '1' } })).text)).toContain('/dav/팀/한글 파일.txt')
    expect((await kim('PUT', `${T}/${encodeURIComponent(' lead')}`, { body: 'x' })).status).toBe(400)
    expect((await kim('PUT', `${T}/a%2Fb`, { body: 'x' })).status).toBe(400)
    expect((await kim('GET', '/dav/%E0%A4%A')).status).toBe(400)
  })
  test('PUT and MKCOL need the folder they go into (409), MKCOL over something is 405, with a body 415', async () => {
    expect((await kim('PUT', `${T}/nope/x.txt`, { body: 'x' })).status).toBe(409)
    expect((await kim('MKCOL', `${T}/nope/sub`)).status).toBe(409)
    expect((await kim('MKCOL', `${T}/coll`)).status).toBe(201)
    expect((await kim('MKCOL', `${T}/coll`)).status).toBe(405)
    expect((await kim('PUT', `${T}/plain`, { body: 'x' })).status).toBe(201)
    expect((await kim('MKCOL', `${T}/plain`)).status).toBe(405)
    expect((await kim('PUT', `${T}/coll`, { body: 'x' })).status).toBe(405)
    expect((await kim('MKCOL', `${T}/withbody`, { body: '<x/>' })).status).toBe(415)
    expect((await kim('PUT', `${T}/coll/in.txt`, { body: 'x' })).status).toBe(201)
    expect((await kim('DELETE', `${T}/coll`, { headers: { depth: '0' } })).status).toBe(400)
    expect((await kim('DELETE', `${T}/coll`)).status).toBe(204)
    expect((await kim('PROPFIND', `${T}/coll/`, { headers: { depth: '0' } })).status).toBe(404)
  })
  test('team folders are the admin’s: no PUT, MKCOL or DELETE at the root', async () => {
    expect((await kim('PUT', '/dav/x.txt', { body: 'x' })).status).toBe(403)
    expect((await kim('MKCOL', '/dav/new')).status).toBe(403)
    expect((await kim('DELETE', T)).status).toBe(403)
    expect((await kim('MOVE', T, { headers: dest('/dav/x') })).status).toBe(403)
  })
  test('chunked PUT (no Content-Length), a large file streamed, 0-byte files', async () => {
    const big = new Uint8Array(3 * 1024 * 1024 + 17).map((_, i) => i % 251)
    const stream = new ReadableStream<Uint8Array>({ start(c) { for (let i = 0; i < big.length; i += 65536) c.enqueue(big.subarray(i, i + 65536)); c.close() } })
    expect((await kim('PUT', `${T}/big.bin`, { body: stream })).status).toBe(201)
    const g = await kim('GET', `${T}/big.bin`)
    expect(g.bytes.length).toBe(big.length)
    expect(Buffer.compare(Buffer.from(g.bytes), Buffer.from(big))).toBe(0)
    expect((await kim('PUT', `${T}/empty.txt`, { body: '' })).status).toBe(201)
    const z = await kim('GET', `${T}/empty.txt`)
    expect([z.status, z.bytes.length]).toEqual([200, 0])
    expect((await kim('PUT', `${T}/part.txt`, { body: 'x', headers: { 'content-range': 'bytes 0-0/10' } })).status).toBe(400)
  })
})

describe('copymove', () => {
  beforeEach(async () => {
    await kim('PUT', `${T}/src.txt`, { body: 'source' })
    await kim('MKCOL', `${T}/dir`)
    await kim('PUT', `${T}/dir/inner.txt`, { body: 'inner' })
  })
  test('copy a file; overwrite F → 412, T → a new version of the destination', async () => {
    expect((await kim('COPY', `${T}/src.txt`, { headers: dest(`${T}/copy.txt`) })).status).toBe(201)
    expect((await kim('GET', `${T}/copy.txt`)).text).toBe('source')
    await kim('PUT', `${T}/src.txt`, { body: 'changed' })
    expect((await kim('COPY', `${T}/src.txt`, { headers: { ...dest(`${T}/copy.txt`), overwrite: 'F' } })).status).toBe(412)
    expect((await kim('COPY', `${T}/src.txt`, { headers: dest(`${T}/copy.txt`) })).status).toBe(204)
    expect((await kim('GET', `${T}/copy.txt`)).text).toBe('changed')
    const b = await e.as('kim')
    expect((await b.call('GET', '/api/files/versions?path=' + encodeURIComponent('/팀/copy.txt'))).data.versions.length).toBe(2)
  })
  test('copy into a folder that is not there → 409; a folder, depth infinity and 0', async () => {
    expect((await kim('COPY', `${T}/src.txt`, { headers: dest(`${T}/none/x.txt`) })).status).toBe(409)
    expect((await kim('COPY', `${T}/dir`, { headers: dest(`${T}/dir2`) })).status).toBe(201)
    expect((await kim('GET', `${T}/dir2/inner.txt`)).text).toBe('inner')
    expect((await kim('COPY', `${T}/dir`, { headers: { ...dest(`${T}/dir3`), depth: '0' } })).status).toBe(201)
    expect(e.hrefs((await kim('PROPFIND', `${T}/dir3/`, { headers: { depth: '1' } })).text)).toEqual(['/dav/팀/dir3/'])
  })
  test('move: rename in place, into a folder, over a file (versions kept, the source in the trash), over a folder', async () => {
    expect((await kim('MOVE', `${T}/src.txt`, { headers: dest(`${T}/renamed.txt`) })).status).toBe(201)
    expect((await kim('GET', `${T}/src.txt`)).status).toBe(404)
    expect((await kim('MOVE', `${T}/renamed.txt`, { headers: dest(`${T}/dir/moved.txt`) })).status).toBe(201)
    expect((await kim('GET', `${T}/dir/moved.txt`)).text).toBe('source')
    await kim('PUT', `${T}/tmp.txt`, { body: 'saved by an editor' })
    expect((await kim('MOVE', `${T}/tmp.txt`, { headers: { ...dest(`${T}/dir/moved.txt`), overwrite: 'F' } })).status).toBe(412)
    expect((await kim('MOVE', `${T}/tmp.txt`, { headers: dest(`${T}/dir/moved.txt`) })).status).toBe(204)
    expect((await kim('GET', `${T}/dir/moved.txt`)).text).toBe('saved by an editor')
    expect((await kim('GET', `${T}/tmp.txt`)).status).toBe(404)
    const b = await e.as('kim')
    expect((await b.call('GET', '/api/files/versions?path=' + encodeURIComponent('/팀/dir/moved.txt'))).data.versions.length).toBe(2)
    await kim('MKCOL', `${T}/other`)
    expect((await kim('MOVE', `${T}/other`, { headers: dest(`${T}/dir`) })).status).toBe(204)
    expect(e.hrefs((await kim('PROPFIND', `${T}/dir/`, { headers: { depth: '1' } })).text)).toEqual(['/dav/팀/dir/'])
  })
  test('a case-only rename works; a folder into itself, the same path, another server are refused', async () => {
    expect((await kim('MOVE', `${T}/src.txt`, { headers: dest(`${T}/SRC.txt`) })).status).toBe(201)
    expect((await kim('GET', `${T}/SRC.txt`)).text).toBe('source')
    expect((await kim('MOVE', `${T}/dir`, { headers: dest(`${T}/dir/sub`) })).status).toBe(403)
    expect((await kim('MOVE', `${T}/dir`, { headers: dest(`${T}/dir`) })).status).toBe(403)
    expect((await kim('MOVE', `${T}/dir`, { headers: { destination: 'https://elsewhere.test/dav/x' } })).status).toBe(502)
    expect((await kim('MOVE', `${T}/dir`)).status).toBe(400)
  })
})

describe('props', () => {
  beforeEach(async () => { await kim('PUT', `${T}/p.txt`, { body: 'props' }) })
  test('depth 0 and 1; infinity is refused (propfind-finite-depth), also when Depth is missing', async () => {
    expect(e.hrefs((await kim('PROPFIND', `${T}/p.txt`, { headers: { depth: '0' } })).text)).toEqual(['/dav/팀/p.txt'])
    expect(e.hrefs((await kim('PROPFIND', `${T}/`, { headers: { depth: '1' } })).text)).toEqual(['/dav/팀/', '/dav/팀/p.txt'])
    for (const h of [{ depth: 'infinity' }, {}] as Record<string, string>[]) {
      const r = await kim('PROPFIND', `${T}/`, { headers: h })
      expect(r.status).toBe(403)
      expect(r.text).toContain('propfind-finite-depth')
    }
  })
  test('named props: known ones 200, unknown ones 404 in their own propstat; propname; allprop', async () => {
    const body = `<?xml version="1.0"?><D:propfind xmlns:D="DAV:" xmlns:Z="urn:x"><D:prop><D:getcontentlength/><D:getetag/><Z:nope/><D:quota-used-bytes/></D:prop></D:propfind>`
    const r = await kim('PROPFIND', `${T}/p.txt`, { headers: { depth: '0' }, body })
    expect(r.status).toBe(207)
    expect(r.text).toContain('<d:getcontentlength>5</d:getcontentlength>')
    expect(r.text).toMatch(/<x:nope xmlns:x="urn:x"\/><d:quota-used-bytes\/><\/d:prop><d:status>HTTP\/1.1 404 Not Found/)
    const names = await kim('PROPFIND', `${T}/`, { headers: { depth: '0' }, body: '<D:propfind xmlns:D="DAV:"><D:propname/></D:propfind>' })
    expect(names.text).toContain('<d:quota-used-bytes/>')
    const all = await kim('PROPFIND', `${T}/p.txt`, { headers: { depth: '0' }, body: '<propfind xmlns="DAV:"><allprop/></propfind>' })
    expect(all.text).toContain('<d:resourcetype/>')
    expect(all.text).toContain('<d:supportedlock>')
  })
  test('quota properties when a quota is set', async () => {
    metaSet(e.db, 'storage_quota', '1MB')
    const r = await kim('PROPFIND', `${T}/`, { headers: { depth: '0' }, body: e.propfind(['quota-available-bytes', 'quota-used-bytes']) })
    const avail = Number(/<d:quota-available-bytes>(\d+)</.exec(r.text)![1]), used = Number(/<d:quota-used-bytes>(\d+)</.exec(r.text)![1])
    expect(avail + used).toBe(1024 * 1024)
  })
  test('bad XML 400; DTDs refused; PROPPATCH answers per property (DAV: ones are protected)', async () => {
    expect((await kim('PROPFIND', `${T}/`, { headers: { depth: '0' }, body: '<D:propfind xmlns:D="DAV:"><D:prop>' })).status).toBe(400)
    expect((await kim('PROPFIND', `${T}/`, { headers: { depth: '0' }, body: '<!DOCTYPE x [<!ENTITY a "b">]><D:propfind xmlns:D="DAV:"/>' })).status).toBe(400)
    const set = `<?xml version="1.0"?><D:propertyupdate xmlns:D="DAV:" xmlns:Z="urn:schemas-microsoft-com:"><D:set><D:prop><Z:Win32LastModifiedTime>Thu, 01 Jan 2026 00:00:00 GMT</Z:Win32LastModifiedTime></D:prop></D:set></D:propertyupdate>`
    const r = await kim('PROPPATCH', `${T}/p.txt`, { body: set })
    expect(r.status).toBe(207)
    expect(r.text).toContain('HTTP/1.1 200 OK')
    const prot = await kim('PROPPATCH', `${T}/p.txt`, { body: set.replace('<D:prop>', '<D:prop><D:getetag>x</D:getetag>') })
    expect(prot.text).toContain('HTTP/1.1 403 Forbidden')
    expect(prot.text).toContain('HTTP/1.1 424 Failed Dependency')
    expect((await kim('PROPPATCH', `${T}/none.txt`, { body: set })).status).toBe(404)
  })
})

describe('locks', () => {
  beforeEach(async () => { await kim('PUT', `${T}/l.txt`, { body: 'locked' }) })
  test('lock, discover, refresh, write with and without the token, unlock', async () => {
    const r = await kim('LOCK', `${T}/l.txt`, { body: LOCKINFO(), headers: { timeout: 'Second-600' } })
    expect(r.status).toBe(200)
    const t = token(r)
    expect(t).toMatch(/^opaquelocktoken:/)
    const disc = await kim('PROPFIND', `${T}/l.txt`, { headers: { depth: '0' }, body: e.propfind(['lockdiscovery']) })
    expect(disc.text).toContain(t)
    expect(disc.text).toContain('<d:owner><d:href>kim</d:href></d:owner>')
    const ref = await kim('LOCK', `${T}/l.txt`, { headers: { if: `(<${t}>)`, timeout: 'Infinite' } })
    expect(ref.status).toBe(200)
    expect(ref.text).toContain('Second-3600')
    expect((await kim('PUT', `${T}/l.txt`, { body: 'no token' })).status).toBe(423)
    expect((await kim('DELETE', `${T}/l.txt`)).status).toBe(423)
    expect((await kim('MOVE', `${T}/l.txt`, { headers: dest(`${T}/m.txt`) })).status).toBe(423)
    expect((await kim('PUT', `${T}/l.txt`, { body: 'with token', headers: { if: `(<${t}>)` } })).status).toBe(204)
    expect((await kim('PUT', `${T}/l.txt`, { body: 'tagged', headers: { if: `<https://drive.test${T}/l.txt> (<${t}>)` } })).status).toBe(204)
    expect((await kim('UNLOCK', `${T}/l.txt`, { headers: { 'lock-token': '<opaquelocktoken:nope>' } })).status).toBe(409)
    expect((await kim('UNLOCK', `${T}/l.txt`, { headers: { 'lock-token': `<${t}>` } })).status).toBe(204)
    expect((await kim('PUT', `${T}/l.txt`, { body: 'free' })).status).toBe(204)
  })
  test('another person cannot use or remove the lock, nor take a conflicting one; shared locks share', async () => {
    const lee = await e.dav('lee')
    const t = token(await kim('LOCK', `${T}/l.txt`, { body: LOCKINFO() }))
    expect((await lee('PUT', `${T}/l.txt`, { body: 'x', headers: { if: `(<${t}>)` } })).status).toBe(423)
    expect((await lee('UNLOCK', `${T}/l.txt`, { headers: { 'lock-token': `<${t}>` } })).status).toBe(403)
    expect((await lee('LOCK', `${T}/l.txt`, { body: LOCKINFO('shared', 'lee') })).status).toBe(423)
    await kim('UNLOCK', `${T}/l.txt`, { headers: { 'lock-token': `<${t}>` } })
    const s1 = await kim('LOCK', `${T}/l.txt`, { body: LOCKINFO('shared') })
    const s2 = await lee('LOCK', `${T}/l.txt`, { body: LOCKINFO('shared', 'lee') })
    expect([s1.status, s2.status]).toEqual([200, 200])
    expect((await lee('LOCK', `${T}/l.txt`, { body: LOCKINFO('exclusive', 'lee') })).status).toBe(423)
    expect((await lee('PUT', `${T}/l.txt`, { body: 'lee', headers: { if: `(<${token(s2)}>)` } })).status).toBe(204)
  })
  test('lock an unmapped name: an empty file (201); a deep lock on a folder guards what is inside', async () => {
    const r = await kim('LOCK', `${T}/new.docx`, { body: LOCKINFO() })
    expect(r.status).toBe(201)
    expect((await kim('GET', `${T}/new.docx`)).bytes.length).toBe(0)
    expect((await kim('PUT', `${T}/new.docx`, { body: 'doc', headers: { if: `(<${token(r)}>)` } })).status).toBe(204)
    await kim('MKCOL', `${T}/guarded`)
    const d = await kim('LOCK', `${T}/guarded`, { body: LOCKINFO() })
    expect(d.text).toContain('<d:depth>infinity</d:depth>')
    expect((await kim('PUT', `${T}/guarded/a.txt`, { body: 'x' })).status).toBe(423)
    expect((await kim('PUT', `${T}/guarded/a.txt`, { body: 'x', headers: { if: `<https://drive.test${T}/guarded> (<${token(d)}>)` } })).status).toBe(201)
    expect((await kim('LOCK', `${T}/guarded/a.txt`, { body: LOCKINFO() })).status).toBe(423)
    expect((await kim('LOCK', `${T}/nope/x.txt`, { body: LOCKINFO() })).status).toBe(409)
  })
  test('If conditions: a wrong token or ETag fails (412), Not <DAV:no-lock> passes', async () => {
    const etag = (await kim('GET', `${T}/l.txt`)).headers.get('etag')!
    expect((await kim('PUT', `${T}/l.txt`, { body: 'x', headers: { if: '(<opaquelocktoken:bogus>)' } })).status).toBe(412)
    expect((await kim('PUT', `${T}/l.txt`, { body: 'x', headers: { if: '(["nope"])' } })).status).toBe(412)
    expect((await kim('PUT', `${T}/l.txt`, { body: 'y', headers: { if: `([${etag}])` } })).status).toBe(204)
    expect((await kim('PUT', `${T}/l.txt`, { body: 'z', headers: { if: '(Not <DAV:no-lock>)' } })).status).toBe(204)
    expect((await kim('PUT', `${T}/l.txt`, { body: 'z', headers: { if: '(garbage' } })).status).toBe(400)
  })
})

describe('http', () => {
  beforeEach(async () => { await kim('PUT', `${T}/r.txt`, { body: '0123456789' }) })
  test('HEAD, ranges (first, open, suffix, unsatisfiable, several = the whole file), If-None-Match, If-Range', async () => {
    const h = await kim('HEAD', `${T}/r.txt`)
    expect([h.status, h.headers.get('content-length'), h.bytes.length]).toEqual([200, '10', 0])
    const r = async (range: string, extra: Record<string, string> = {}) => { const x = await kim('GET', `${T}/r.txt`, { headers: { range, ...extra } }); return [x.status, x.text, x.headers.get('content-range')] }
    expect(await r('bytes=2-4')).toEqual([206, '234', 'bytes 2-4/10'])
    expect(await r('bytes=7-')).toEqual([206, '789', 'bytes 7-9/10'])
    expect(await r('bytes=-3')).toEqual([206, '789', 'bytes 7-9/10'])
    expect(await r('bytes=5-100')).toEqual([206, '56789', 'bytes 5-9/10'])
    expect((await r('bytes=20-'))[0]).toBe(416)
    expect(await r('bytes=0-1,4-5')).toEqual([200, '0123456789', null])
    expect(await r('bytes=0-1', { 'if-range': '"other"' })).toEqual([200, '0123456789', null])
    const etag = h.headers.get('etag')!
    expect((await kim('GET', `${T}/r.txt`, { headers: { 'if-none-match': etag } })).status).toBe(304)
  })
  test('file bytes are never rendered on this origin (the app’s session lives here)', async () => {
    await kim('PUT', `${T}/x.html`, { body: '<script>alert(1)</script>' })
    const g = await kim('GET', `${T}/x.html`)
    expect(g.headers.get('content-type')).toBe('application/octet-stream')
    expect(g.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
    expect(g.headers.get('x-content-type-options')).toBe('nosniff')
    expect(g.headers.get('content-disposition')).toStartWith('attachment')
  })
})

describe('what a mounted drive keeps from the product', () => {
  test('HTTPS only: plain http is refused before any password is checked, except on this machine', async () => {
    const pw = await e.appPassword(await e.as('lee'))
    const lee = e.client('lee', pw)
    const r = await lee('PROPFIND', '/dav/', { origin: 'http://drive.test', headers: { depth: '0' } })
    expect(r.status).toBe(403)
    expect(r.text).toContain('HTTPS')
    expect((await lee('PROPFIND', '/dav/', { origin: 'http://drive.test', headers: { depth: '0', 'x-forwarded-proto': 'https' } })).status).toBe(207)
    expect((await lee('PROPFIND', '/dav/', { origin: 'http://127.0.0.1:8787', addr: '127.0.0.1', headers: { depth: '0' } })).status).toBe(207)
    expect((await lee('PROPFIND', '/dav/', { origin: 'http://localhost:8787', addr: '::1', headers: { depth: '0' } })).status).toBe(207)
    // loopback address but a public Host (a proxy on this machine forwarding plain http): refused
    expect((await lee('PROPFIND', '/dav/', { origin: 'http://drive.test', addr: '127.0.0.1', headers: { depth: '0' } })).status).toBe(403)
  })
  test('only app passwords sign in: no header, a wrong one, an agent token, a bearer token, the account password, someone else’s name', async () => {
    const pw = await e.appPassword(await e.as('lee'))
    const pat = e.secrets.kim!
    const cases: [string, string | null][] = [
      ['none', null], ['wrong', e.basic('lee', pw + 'x')], ['pat', e.basic('kim', pat)], ['bearer', `Bearer ${pat}`],
      ['account password', e.basic('lee', PASSWORD)], ['other name', e.basic('kim', pw)],
    ]
    for (const [what, auth] of cases) {
      const r = await kim('PROPFIND', '/dav/', { auth, headers: { depth: '0' } })
      expect([what, r.status]).toEqual([what, 401])
      expect(r.headers.get('www-authenticate')).toContain('Basic realm=')
    }
    expect((await kim('PROPFIND', '/dav/', { auth: e.basic('lee@example.com', pw), headers: { depth: '0' } })).status).toBe(207)
    expect((await kim('PROPFIND', '/dav/', { auth: e.basic('LEE@example.com', pw), headers: { depth: '0' } })).status).toBe(207)
  })
  test('failed sign-ins are rate limited per name (10 / 15 min) and per address', async () => {
    const pw = await e.appPassword(await e.as('lee'))
    const lee = e.client('lee', pw)
    for (let i = 0; i < 10; i++) expect((await lee('PROPFIND', '/dav/', { auth: e.basic('lee', 'tdrive_app_wrong'), headers: { depth: '0' } })).status).toBe(401)
    const r = await lee('PROPFIND', '/dav/', { headers: { depth: '0' } })
    expect(r.status).toBe(429)
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0)
    // another name from another address is not affected
    expect((await kim('PROPFIND', '/dav/', { addr: '10.0.0.2', headers: { depth: '0' } })).status).toBe(207)
    for (let i = 0; i < 50; i++) await kim('PROPFIND', '/dav/', { addr: '10.0.0.9', auth: e.basic(`n${i}`, 'x'), headers: { depth: '0' } })
    expect((await kim('PROPFIND', '/dav/', { addr: '10.0.0.9', headers: { depth: '0' } })).status).toBe(429)
  })
  test('behind a trusted proxy (the real listener): failed sign-ins count per forwarded client, not per proxy', async () => {
    const pw = await e.appPassword(await e.as('lee'))
    const s = serveWeb(e.ctx, 0, '127.0.0.1', { webDir: '/nonexistent', trustedProxy: parseTrustedProxies('127.0.0.1'), mailer: e.w.mailer })
    try {
      const url = `http://127.0.0.1:${s.server.port}/dav/`
      const go = (client: string, user: string, secret: string) => fetch(url, { method: 'PROPFIND', headers: {
        depth: '0', 'x-forwarded-for': client, 'x-forwarded-proto': 'https', authorization: e.basic(user, secret) } }).then((r) => r.status)
      // fifty failures from one client behind the proxy (different names, so the per-name limit stays out of it)
      for (let i = 0; i < 50; i++) expect(await go('203.0.113.7', `nobody${i}`, 'tdrive_app_wrong')).toBe(401)
      expect(await go('203.0.113.7', 'lee', pw)).toBe(429)
      // another client behind the same proxy is not affected
      expect(await go('198.51.100.9', 'lee', pw)).toBe(207)
      // a remote client behind the proxy over plain http (no X-Forwarded-Proto: https) is refused, though the Host is loopback
      expect(await fetch(url, { method: 'PROPFIND', headers: { depth: '0', 'x-forwarded-for': '198.51.100.9', authorization: e.basic('lee', pw) } }).then((r) => r.status)).toBe(403)
    } finally { s.server.stop(true) }
  })
  test('revoked, deactivated, reset: the next request is refused', async () => {
    const b = await e.as('lee')
    const pw = await e.appPassword(b, 'Laptop')
    const lee = e.client('lee', pw)
    expect((await lee('PROPFIND', '/dav/', { headers: { depth: '0' } })).status).toBe(207)
    const list = await b.call('GET', '/api/me/app-passwords')
    expect(list.data.passwords.map((x: { name: string; hint: string }) => [x.name, x.hint])).toEqual([['Laptop', pw.slice(-4)]])
    expect(JSON.stringify(list.data)).not.toContain(pw)
    expect(list.data.url).toBe('http://drive.test/dav/')
    expect((await b.call('DELETE', `/api/me/app-passwords/${list.data.passwords[0].id}`)).status).toBe(200)
    expect((await lee('PROPFIND', '/dav/', { headers: { depth: '0' } })).status).toBe(401)
    const pw2 = await e.appPassword(b)
    const admin = await e.as('dion')
    expect((await admin.call('POST', `/api/people/${e.pid('lee')}/reset`)).status).toBe(200)
    expect((await e.client('lee', pw2)('PROPFIND', '/dav/', { headers: { depth: '0' } })).status).toBe(401)
    const kpw = await e.appPassword(await e.as('kim'))
    expect((await admin.call('PATCH', `/api/people/${e.pid('kim')}`, { active: false })).status).toBe(200)
    expect((await e.client('kim', kpw)('PROPFIND', '/dav/', { headers: { depth: '0' } })).status).toBe(401)
  })
  test('making an app password needs the password typed again; someone else’s cannot be revoked', async () => {
    const b = await e.as('lee')
    // a session older than 5 minutes is not a fresh login
    e.db.query('UPDATE web_sessions SET created_at = created_at - 600000').run()
    const r = await b.call('POST', '/api/me/app-passwords', { name: 'Mac' })
    expect([r.status, r.data.error]).toEqual([403, 'reauth_required'])
    expect((await b.call('POST', '/api/me/app-passwords', { name: 'Mac', password: 'wrong password!' })).status).toBe(400)
    const ok = await b.call('POST', '/api/me/app-passwords', { name: 'Mac', password: PASSWORD })
    expect(ok.data.password).toMatch(/^tdrive_app_([a-z2-9]{4}-){7}[a-z2-9]{4}$/)
    expect((await (await e.as('kim')).call('DELETE', `/api/me/app-passwords/${ok.data.id}`)).status).toBe(404)
    const row = e.db.query<{ secret_hash: string }, []>('SELECT secret_hash FROM app_passwords').get()!
    expect(row.secret_hash).not.toContain(ok.data.password)
  })
  test('the audit trail: changes and reads by person with tool webdav; listings once per 10 minutes', async () => {
    await kim('PUT', `${T}/a.txt`, { body: 'a' })
    await kim('GET', `${T}/a.txt`)
    await kim('PROPFIND', `${T}/`, { headers: { depth: '1' } })
    await kim('PROPFIND', `${T}/`, { headers: { depth: '1' } })
    await kim('GET', `${T}/a.txt`, { headers: { range: 'bytes=0-0' } })
    await kim('GET', `${T}/a.txt`, { headers: { range: 'bytes=0-0' } })
    await kim('DELETE', `${T}/a.txt`)
    const rows = e.db.query<{ tool: string; command: string }, []>("SELECT tool, command FROM audit WHERE tool = 'webdav' ORDER BY id").all().map((r) => r.command)
    expect(rows).toEqual([
      expect.stringMatching(/^files webdav-put \/팀\/a.txt \(1 bytes/), 'files download /팀/a.txt', 'files list /팀', 'files download /팀/a.txt (bytes 0-0)', 'files delete /팀/a.txt (to the trash)',
    ])
  })
  test('the quota answers 507; the largest file 413', async () => {
    metaSet(e.db, 'storage_quota', '10')
    expect((await kim('PUT', `${T}/q.txt`, { body: 'more than ten bytes' })).status).toBe(507)
    metaSet(e.db, 'storage_quota', 'none')
    metaSet(e.db, 'max_file_bytes', '5')
    expect((await kim('PUT', `${T}/q.txt`, { body: 'too big' })).status).toBe(413)
    expect((await kim('PUT', `${T}/q.txt`, { body: 'too big', headers: { 'content-length': '7' } })).status).toBe(413)
    expect(fs.readdirSync(path.join(e.root, '..', 'files', '.trina-drive', 'uploads'))).toEqual([])
  })
  test('what Macs and Office write for themselves stays in memory: answered, never stored, never seen by others', async () => {
    expect((await kim('PUT', `${T}/._a.txt`, { body: 'apple double' })).status).toBe(201)
    expect((await kim('PUT', `${T}/.DS_Store`, { body: 'finder' })).status).toBe(201)
    expect((await kim('GET', `${T}/._a.txt`)).text).toBe('apple double')
    expect((await kim('PROPFIND', `${T}/.DS_Store`, { headers: { depth: '0' } })).status).toBe(207)
    expect(e.hrefs((await kim('PROPFIND', `${T}/`, { headers: { depth: '1' } })).text)).toEqual(['/dav/팀/'])
    expect(fs.readdirSync(e.team.path)).toEqual([])
    const lee = await e.dav('lee')
    expect((await lee('GET', `${T}/._a.txt`)).status).toBe(404)
    const lk = await kim('LOCK', `${T}/~$doc.docx`, { body: LOCKINFO() })
    expect(lk.status).toBe(201)
    expect((await kim('UNLOCK', `${T}/~$doc.docx`, { headers: { 'lock-token': `<${token(lk)}>` } })).status).toBe(204)
    expect((await kim('DELETE', `${T}/._a.txt`)).status).toBe(204)
    expect((await kim('PUT', '/dav/' + encodeURIComponent('임원') + '/._x', { body: 'x' })).status).toBe(409)
  })
  test('off outside managed storage, and when the operator turns it off', async () => {
    metaSet(e.db, 'storage_mode', 'inplace')
    expect((await kim('PROPFIND', '/dav/', { headers: { depth: '0' } })).status).toBe(404)
    expect((await kim('OPTIONS', '/')).headers.get('dav')).toBeNull()
    metaSet(e.db, 'storage_mode', 'managed')
    process.env.TDRIVE_WEBDAV = 'off'
    try { expect((await kim('PROPFIND', '/dav/', { headers: { depth: '0' } })).status).toBe(404) } finally { delete process.env.TDRIVE_WEBDAV }
  })
})
