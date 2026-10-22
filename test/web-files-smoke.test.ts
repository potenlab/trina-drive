// End to end over real HTTP: the built app carries the Files page, and a signed-in person browses, searches and
// downloads through it the way the page does (cookie only, plain GETs).
import { afterAll, beforeAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_WEB_DIR, serveWeb } from '../src/web/server'
import { OutboxMailer } from '../src/web/mail'
import { PASSWORD, webSetup, type WebEnv } from './web-helpers'

let e: WebEnv
let server: ReturnType<typeof serveWeb>['server']
let base: string

/** The built bundle, rebuilt if it predates the Files page. */
function bundle(): string {
  const read = () => {
    const html = fs.readFileSync(path.join(DEFAULT_WEB_DIR, 'index.html'), 'utf8')
    return fs.readFileSync(path.join(DEFAULT_WEB_DIR, /src="\/(assets\/[^"]+\.js)"/.exec(html)![1]!), 'utf8')
  }
  if (fs.existsSync(path.join(DEFAULT_WEB_DIR, 'index.html')) && read().includes('/files/download?path=')) return read()
  const r = Bun.spawnSync(['bun', 'run', 'build:web'], { cwd: path.join(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`build:web failed: ${r.stderr.toString()}`)
  return read()
}

let js = ''
beforeAll(async () => {
  js = bundle()
  e = await webSetup()
  server = serveWeb(e.ctx, 0, '127.0.0.1', { mailer: new OutboxMailer(e.dir, true) }).server
  base = `http://127.0.0.1:${server.port}`
}, 60_000)
afterAll(() => { server.stop(true); e.cleanup() })

test('the app served at / is the build that holds the Files page (en + ko)', async () => {
  const res = await fetch(base + '/')
  expect(res.status).toBe(200)
  const html = await res.text()
  expect(html).toContain('<div id="root">')
  const src = /src="(\/assets\/[^"]+\.js)"/.exec(html)![1]!
  const served = await (await fetch(base + src)).text()
  expect(served).toBe(js)
  for (const s of ['/files/download?path=', '/files/who?path=', '/files/text?path=', '/search?q=', 'Search names and text', '이름과 본문 검색', '내 초안']) expect(served).toContain(s)
  // the page never puts file content in as HTML
  expect(served).not.toContain('dangerouslySetInnerHTML:')
})

test('kim browses, searches and downloads over HTTP with the cookie only; 경영 is as missing as a typo', async () => {
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ login: 'kim', password: PASSWORD }) })
  const cookie = /shelf_session=[^;]+/.exec(login.headers.get('set-cookie')!)![0]
  const g = (p: string) => fetch(base + '/api' + p, { headers: { cookie } })
  const root = await (await g('/files')).json() as { entries: { name: string }[] }
  expect(root.entries.map((x) => x.name).sort()).toEqual(['개인_kim', '공용', '프로젝트'].sort())
  const s = await (await g('/search?q=' + encodeURIComponent('한빛물산'))).json() as { results: { path: string }[] }
  expect(s.results.length).toBeGreaterThan(0)
  const dl = await g('/files/download?path=' + encodeURIComponent('/프로젝트/견적_2026.md'))
  expect(dl.status).toBe(200)
  expect(dl.headers.get('content-disposition')).toStartWith('attachment;')
  expect(dl.headers.get('content-type')).toBe('application/octet-stream')
  expect(dl.headers.get('x-content-type-options')).toBe('nosniff')
  const hidden = await g('/files/download?path=' + encodeURIComponent('/경영/손익.csv'))
  const missing = await g('/files/download?path=' + encodeURIComponent('/겅영/손익.csv'))
  expect([hidden.status, await hidden.text()]).toEqual([missing.status, await missing.text()])
  expect((await fetch(base + '/api/files')).status).toBe(401)
})
