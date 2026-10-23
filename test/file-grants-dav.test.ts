// File shares on the mounted drive (A2): a file-only Editor saves a new version with PUT, everything else in the folder
// is refused; bare-path folders show no time of their own (memo §3.3 "synthetic dates"); hidden == missing on WebDAV.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { handleWeb } from '../src/web/server'
import { PASSWORD } from './web-helpers'
import { fileShareSetup, Q3, SIB, type FileShareEnv } from './file-grants-helpers'

let e: FileShareEnv
beforeEach(async () => { e = await fileShareSetup() })
afterEach(() => e.cleanup())

async function dav(name: string) {
  const b = await e.as(name)
  const pw = (await b.call('POST', '/api/me/app-passwords', { name: 'Mac', password: PASSWORD })).data.password as string
  const auth = 'Basic ' + Buffer.from(`${name}:${pw}`).toString('base64')
  return async (method: string, p: string, o: { body?: string; headers?: Record<string, string> } = {}) => {
    const url = 'https://drive.test/dav' + p.split('/').map(encodeURIComponent).join('/')
    const res = await handleWeb(e.w, new Request(url, { method, headers: { authorization: auth, ...(o.headers ?? {}) }, body: o.body }), '10.0.0.1')
    return { status: res.status, text: await res.text() }
  }
}

test('a file-only Editor PUTs a new version; MOVE, DELETE, MKCOL and new files in the folder are 403', async () => {
  await e.give(e.boss, Q3, 'kim', 'editor')
  const d = await dav('kim')
  expect((await d('PUT', Q3, { body: 'via webdav CANARY-DAV-V2' })).status).toBe(204)
  expect((await d('GET', Q3)).text).toContain('CANARY-DAV-V2')
  expect((await d('PUT', '/재무팀/결산/new.md', { body: 'x' })).status).toBe(403)
  expect((await d('DELETE', Q3)).status).toBe(403)
  expect((await d('MKCOL', '/재무팀/결산/sub')).status).toBe(403)
  expect((await d('MOVE', Q3, { headers: { destination: 'https://drive.test/dav/' + encodeURIComponent('재무팀') + '/' + encodeURIComponent('결산') + '/x.md' } })).status).toBe(403)
  // a Viewer's PUT is refused too
  await e.give(e.boss, SIB, 'lee')
  expect((await (await dav('lee'))('PUT', SIB, { body: 'no' })).status).toBe(403)
})

test('bare-path folders: one synthetic date (never their own birth time); siblings 404 like missing', async () => {
  await e.give(e.boss, Q3, 'kim')
  const d = await dav('kim')
  const pf = await d('PROPFIND', '/재무팀', { headers: { depth: '1' } })
  expect(pf.status).toBe(207)
  const hrefs = [...pf.text.matchAll(/<d:href>([^<]*)<\/d:href>/g)].map((m) => decodeURIComponent(m[1]!))
  expect(hrefs).toEqual(['/dav/재무팀/', '/dav/재무팀/결산/'])
  const dates = [...pf.text.matchAll(/<d:getlastmodified>([^<]*)</g)].map((m) => m[1])
  const created = [...pf.text.matchAll(/<d:creationdate>([^<]*)</g)].map((m) => m[1])
  expect(new Set(dates).size).toBe(1)
  expect(new Set(created).size).toBe(1)
  // boss reads the folders: their own birth times
  const bp = await (await dav('boss'))('PROPFIND', '/재무팀', { headers: { depth: '0' } })
  expect(/<d:getlastmodified>([^<]*)</.exec(bp.text)?.[1]).not.toBe(dates[0])
  const hidden = await d('GET', SIB), none = await d('GET', '/재무팀/결산/nope.md')
  expect(hidden.status).toBe(404)
  expect(hidden.text).toBe(none.text)
  expect((await d('GET', Q3)).text).toContain('CANARY-Q3-7781')
})
