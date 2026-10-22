// End to end over real HTTP, no browser: the built web app is served at / with security headers, and a session made by
// signing in drives the API — including making a token that then works on /mcp (where the cookie does not).
import { afterAll, beforeAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_WEB_DIR, serveWeb } from '../src/web/server'
import { OutboxMailer } from '../src/web/mail'
import { PASSWORD, webSetup, type WebEnv } from './web-helpers'

let e: WebEnv
let server: ReturnType<typeof serveWeb>['server']
let base: string
beforeAll(async () => {
  if (!fs.existsSync(path.join(DEFAULT_WEB_DIR, 'index.html'))) {
    const r = Bun.spawnSync(['bun', 'run', 'build:web'], { cwd: path.join(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe' })
    if (r.exitCode !== 0) throw new Error(`build:web failed: ${r.stderr.toString()}`)
  }
  e = await webSetup()
  server = serveWeb(e.ctx, 0, '127.0.0.1', { mailer: new OutboxMailer(e.dir, true) }).server
  base = `http://127.0.0.1:${server.port}`
}, 60_000)
afterAll(() => { server.stop(true); e.cleanup() })

test('serves the built app with security headers; unknown paths fall back to the app; assets are served', async () => {
  const res = await fetch(base + '/')
  expect(res.status).toBe(200)
  const html = await res.text()
  expect(html).toContain('<div id="root">')
  expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
  expect(res.headers.get('content-security-policy')).toContain("script-src 'self'")
  expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  expect(res.headers.get('referrer-policy')).toBe('no-referrer')
  expect(res.headers.get('x-frame-options')).toBe('DENY')
  const js = /src="(\/assets\/[^"]+\.js)"/.exec(html)![1]!
  const asset = await fetch(base + js)
  expect(asset.status).toBe(200)
  expect(asset.headers.get('content-type')).toContain('javascript')
  expect(asset.headers.get('cache-control')).toContain('immutable')
  expect(await (await fetch(base + '/folders/3')).text()).toContain('<div id="root">')
  // no way out of the web directory
  const escape = await fetch(base + '/assets/..%2f..%2f..%2fpackage.json')
  expect(await escape.text()).not.toContain('"devDependencies"')
  expect((await fetch(base + '/api/nope')).status).toBe(404)
  expect((await fetch(base + '/api/folders')).status).toBe(401)
})

test('sign in, use the API with the session, make a token, use it on /mcp; the cookie alone gets nothing there', async () => {
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ login: 'kim', password: PASSWORD }) })
  expect(login.status).toBe(200)
  const { csrf } = await login.json() as { csrf: string }
  const cookie = /tdrive_session=[^;]+/.exec(login.headers.get('set-cookie')!)![0]
  const h = { cookie, origin: base, 'content-type': 'application/json', 'x-csrf-token': csrf }

  const folders = await (await fetch(base + '/api/folders', { headers: { cookie } })).json() as { folders: { name: string }[] }
  expect(folders.folders.map((f) => f.name)).toContain('프로젝트')
  expect(folders.folders.map((f) => f.name)).not.toContain('경영')

  const tok = await fetch(base + '/api/tokens', { method: 'POST', headers: h, body: JSON.stringify({ name: 'smoke', ttl: '8h', read_only: true }) })
  expect(tok.status).toBe(200)
  const { token } = await tok.json() as { token: string }

  const call = (headers: Record<string, string>) => fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bash', arguments: { command: 'ls /' } } }) })
  const viaCookie = await call({ cookie })
  expect(viaCookie.status).toBe(401)
  const viaToken = await call({ authorization: `Bearer ${token}` })
  expect(viaToken.status).toBe(200)
  const out = await viaToken.json() as { result: { content: { text: string }[] } }
  expect(out.result.content[0]!.text).toContain('프로젝트')
  expect(out.result.content[0]!.text).not.toContain('경영')

  const list = await (await fetch(base + '/api/tokens', { headers: { cookie } })).json() as { tokens: { name: string; last_used_at: number | null }[] }
  expect(list.tokens.find((x) => x.name === 'smoke')!.last_used_at).not.toBeNull()
  const audit = await (await fetch(base + '/api/audit?view=mine', { headers: { cookie } })).json() as { entries: { tool: string; command: string }[] }
  expect(audit.entries.some((x) => x.tool === 'bash' && x.command === 'ls /')).toBe(true)
})

test('the built My tokens page offers `mcp add` (recommended / --token-stdin), not a `--header "Authorization: Bearer …"` command line', async () => {
  const html = await (await fetch(base + '/')).text()
  const js = await (await fetch(base + /src="(\/assets\/[^"]+\.js)"/.exec(html)![1]!)).text()
  expect(js).toContain('--token-stdin')
  expect(js).toContain('Manual config (stores the token in plain text)')
  expect(js).not.toContain('--header "Authorization')
  expect(js).not.toContain('--transport http')
})
