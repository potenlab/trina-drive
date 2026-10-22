// MCP endpoint abuse (plan §7.1 "웹 공격", "공개 노출", "토큰 유출"): malformed JSON-RPC, batches, huge bodies,
// protocol versions, cookie/query-string tokens, Origin, token format.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { TOKEN_PREFIX } from '../../src/config'
import { handleRequest, RATE_LIMIT_CODE, serve } from '../../src/mcp'
import { McpLimiter } from '../../src/ratelimit'
import { verifyAudit } from '../../src/audit'
import { createToken, sha256, verifyToken } from '../../src/store'
import { securitySetup, type SecEnv } from './fixture'

let e: SecEnv
let server: ReturnType<typeof serve>
let url: string
beforeAll(() => {
  e = securitySetup()
  // generous limits here: this file sends many requests with one token; the limits themselves are tested at the end
  server = serve(e.ctx, 0, '127.0.0.1', { limiter: new McpLimiter({ tokenPerMin: 100_000, ipPerMin: 100_000, badAuthPerMin: 100_000 }) })
  url = `http://127.0.0.1:${server.port}/mcp`
})
afterAll(() => { server.stop(true); e.cleanup() })

const auth = () => ({ authorization: `Bearer ${e.secrets.kim}` })
const post = (body: string | Uint8Array, headers: Record<string, string> = {}, u = url) =>
  fetch(u, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body })
const call = (name: string, args: unknown, id: unknown = 1) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })

describe('malformed JSON-RPC never reaches a 500 or a stack trace', () => {
  const bodies: [string, string][] = [
    ['not json', '{"jsonrpc":'],
    ['empty', ''],
    ['null', 'null'],
    ['number', '5'],
    ['string', '"x"'],
    ['array of nothing', '[]'],
    ['params null (tools/call)', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: null })],
    ['params null (initialize)', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: null })],
    ['params string', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: 'bash' })],
    ['params array', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: ['bash', { command: 'ls' }] })],
    ['params number', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: 7 })],
    ['arguments null', call('bash', null)],
    ['arguments array', call('bash', ['ls /'])],
    ['arguments string', call('bash', 'ls /')],
    ['command not a string', call('bash', { command: ['ls'] })],
    ['name not a string', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: { toString: 1 }, arguments: {} } })],
    ['protocolVersion not a string', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: { toString: 1 } } })],
    ['__proto__ args', '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"bash","arguments":{"__proto__":{"command":"cat /경영/c.md"}}}}'],
    ['constructor method', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'constructor' })],
    ['__proto__ method', JSON.stringify({ jsonrpc: '2.0', id: 1, method: '__proto__' })],
    ['jsonrpc 1.0', JSON.stringify({ jsonrpc: '1.0', id: 1, method: 'ping' })],
    ['method missing', JSON.stringify({ jsonrpc: '2.0', id: 1 })],
    ['deeply nested array', '['.repeat(100_000) + ']'.repeat(100_000)],
    ['deeply nested object', '{"a":'.repeat(50_000) + '1' + '}'.repeat(50_000)],
    ['read offset garbage', call('read', { path: '/공용/c.md', offset: 'x', limit: -1 })],
    ['history version garbage', call('history', { path: '/drafts/x.md', action: 'restore', version: { a: 1 } })],
    ['invalid UTF-8', '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"bash","arguments":{"command":"echo \xff\xfe"}}}'],
  ]
  test.each(bodies)('%s', async (_label, body) => {
    const r = await post(body, auth())
    const text = await r.text()
    expect(r.status).toBeLessThan(500)
    expect(text).not.toMatch(/<html|at handleRequest|\.ts:\d+|TypeError|node_modules/i)
    if (text) expect(() => JSON.parse(text)).not.toThrow()
  })

  test('the server still answers after all of that', async () => {
    const r = await post(call('bash', { command: 'cat /공용/c.md' }), auth())
    expect(((await r.json()) as { result: { content: { text: string }[] } }).result.content[0]!.text).toContain(e.canary.get('pub')!)
  })
})

describe('batches and notifications', () => {
  test('a JSON-RPC batch is refused as a whole (no call inside it runs)', async () => {
    const batch = JSON.stringify([JSON.parse(call('write', { path: '/drafts/batch1.md', content: 'x' }, 1)), JSON.parse(call('write', { path: '/drafts/batch2.md', content: 'x' }, 2))])
    const r = await post(batch, auth())
    expect(r.status).toBe(400)
    const big = JSON.stringify(Array.from({ length: 10_000 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'ping' })))
    expect((await post(big, auth())).status).toBe(400)
    expect(e.db.query("SELECT count(*) AS n FROM drafts WHERE path LIKE 'batch%'").get()).toEqual({ n: 0 })
  })

  test('a tools/call sent as a notification (no id) does not run', async () => {
    const r = await post(JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'write', arguments: { path: '/drafts/notif.md', content: 'x' } } }), auth())
    expect(r.status).toBe(202)
    expect(e.db.query("SELECT count(*) AS n FROM drafts WHERE path = 'notif.md'").get()).toEqual({ n: 0 })
  })
})

describe('body size', () => {
  test('an unauthenticated huge body is refused without being read as JSON', async () => {
    const r = await post(new Uint8Array(30 * 1024 * 1024), {})
    expect([401, 413]).toContain(r.status)
  })
  test('an authenticated body larger than any tool needs is refused (413)', async () => {
    const r = await post(call('write', { path: '/drafts/huge.md', content: 'a'.repeat(40 * 1024 * 1024) }), auth())
    expect(r.status).toBe(413)
    expect(e.db.query("SELECT count(*) AS n FROM drafts WHERE path = 'huge.md'").get()).toEqual({ n: 0 })
  })
  test('a large command line is cut by the shell limit, not the process', async () => {
    const r = await post(call('bash', { command: 'echo ' + 'a'.repeat(9 * 1024 * 1024) + ' | wc -c' }), auth())
    expect(r.status).toBe(200)
  })
})


describe('protocol versions', () => {
  test.each([['1999-01-01'], ['2025-06-18'], ['2025-03-26'], [''], ['2026-07-28,2025-11-25']])('MCP-Protocol-Version %p is refused or ignored, never crashes', async (v) => {
    const r = await post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), { ...auth(), 'mcp-protocol-version': v })
    expect(v === '' ? 200 : 400).toBe(r.status)
  })
  test('initialize with an unknown version is answered with the latest supported one', async () => {
    const r = await post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: { x: 1 }, capabilities: {}, clientInfo: { name: 'x', version: '0' } } }), auth())
    expect(((await r.json()) as { result: { protocolVersion: string } }).result.protocolVersion).toBe('2026-07-28')
  })
})

describe('authentication: only the Authorization header carries a token', () => {
  const ping = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
  test.each([
    ['cookie only', {}, (s: string) => ({ cookie: `token=${s}; shelf_token=${s}; session=${s}` })],
    ['query ?access_token=', { q: 'access_token' }, () => ({})],
    ['query ?token=', { q: 'token' }, () => ({})],
    ['query ?authorization=Bearer', { q: 'authorization' }, () => ({})],
    ['X-Api-Key header', {}, (s: string) => ({ 'x-api-key': s })],
    ['Basic scheme', {}, (s: string) => ({ authorization: `Basic ${Buffer.from('kim:' + s).toString('base64')}` })],
    ['token without scheme', {}, (s: string) => ({ authorization: s })],
    ['Bearer + extra word', {}, (s: string) => ({ authorization: `Bearer ${s} extra` })],
    ['Bearer with prefix only', {}, () => ({ authorization: `Bearer ${TOKEN_PREFIX}` })],
    ['Bearer with the token hash', {}, () => ({ authorization: `Bearer ${TOKEN_PREFIX}${e.db.query<{ hash: string }, []>('SELECT hash FROM tokens LIMIT 1').get()!.hash}` })],
    ['expired token', {}, () => ({ authorization: `Bearer ${e.expiredSecret}` })],
    ['revoked token', {}, () => ({ authorization: `Bearer ${e.revokedSecret}` })],
  ] as [string, { q?: string }, (s: string) => Record<string, string>][])('%s → 401', async (_l, o, h) => {
    const secret = e.secrets.kim!
    const u = o.q ? `${url}?${o.q}=${encodeURIComponent(o.q === 'authorization' ? 'Bearer ' + secret : secret)}` : url
    const r = await post(ping, h(secret), u)
    expect(r.status).toBe(401)
    expect(r.headers.get('www-authenticate')).toMatch(/^Bearer /)
  })
  test('a valid cookie does not upgrade an invalid bearer', async () => {
    expect((await post(ping, { authorization: 'Bearer shelf_pat_wrong', cookie: `token=${e.secrets.kim}` })).status).toBe(401)
  })
  test('the auth scheme is case-insensitive (RFC 7235) and a valid token works', async () => {
    expect((await post(ping, { authorization: `bearer ${e.secrets.kim}` })).status).toBe(200)
  })
})

describe('Origin (DNS-rebinding guard)', () => {
  const ping = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
  test.each([['https://evil.example'], ['null'], ['http://localhost.evil.com'], ['http://127.0.0.1.nip.io'], ['file://'], ['http://127.0.0.1@evil.com'], ['http://evil.com#@localhost'], ['chrome-extension://abc'], ['http://0.0.0.0'], ['http://[::ffff:127.0.0.1]']])('%s → 403 even with a valid token', async (origin) => {
    const r = await post(ping, { ...auth(), origin })
    expect(r.status).toBe(403)
  })
  test.each([['http://localhost:3000'], ['http://127.0.0.1:8787'], ['http://[::1]:3000']])('%s (loopback) is allowed', async (origin) => {
    expect((await post(ping, { ...auth(), origin })).status).toBe(200)
  })
  test('an Origin refused before authentication does not reveal whether the token is valid', async () => {
    const a = await post(ping, { ...auth(), origin: 'https://evil.example' })
    const b = await post(ping, { authorization: 'Bearer shelf_pat_nope', origin: 'https://evil.example' })
    expect([a.status, await a.text()]).toEqual([b.status, await b.text()])
  })
  test('preflight (OPTIONS) from a foreign origin gets no CORS grant', async () => {
    const r = await fetch(url, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization' } })
    expect(r.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('content type', () => {
  const ping = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
  test.each([['text/plain'], ['application/x-www-form-urlencoded'], ['multipart/form-data; boundary=x'], ['text/plain; x=application/json'], ['application/jsonp'], ['']])('%p → 415', async (ct) => {
    expect((await post(ping, { ...auth(), 'content-type': ct })).status).toBe(415)
  })
  test.each([['application/json'], ['application/json; charset=utf-8'], ['Application/JSON']])('%p is accepted', async (ct) => {
    expect((await post(ping, { ...auth(), 'content-type': ct })).status).toBe(200)
  })
})


describe('token format (secret scanners) and storage', () => {
  test('tokens are <prefix>_pat_ + 32 base64url chars; only a hash and a short hint are stored', () => {
    const t = createToken(e.db, 'kim', { name: 'fmt' })
    expect(t.token).toMatch(new RegExp(`^${TOKEN_PREFIX}[A-Za-z0-9_-]{32}$`))
    expect(TOKEN_PREFIX).toMatch(/^[a-z][a-z0-9]*_pat_$/)
    const row = e.db.query<Record<string, unknown>, [number]>('SELECT * FROM tokens WHERE id = ?').get(t.id)!
    expect(JSON.stringify(row)).not.toContain(t.token.slice(TOKEN_PREFIX.length))
    expect(String(row.hint)).toBe(t.token.slice(0, TOKEN_PREFIX.length + 4))
    // the hint (4 chars) is not enough to find the token among others
    expect(String(row.hint).length - TOKEN_PREFIX.length).toBeLessThanOrEqual(4)
  })
  test('the secret never lands in the audit log, even when the agent prints it into a command', async () => {
    await post(call('bash', { command: 'echo hello' }), auth())
    const dump = JSON.stringify(e.db.query('SELECT * FROM audit').all())
    expect(dump).not.toContain(e.secrets.kim!)
  })
  test('a token pasted into a bash command or a tool argument is redacted in the audit command line (hash of the whole kept)', async () => {
    const other = createToken(e.db, 'boss', { name: 'leaked' }).token
    const gh = ['ghp_', 'Z9y8'.repeat(9)].join('')
    const cmd = `echo ${other} ${gh} | wc -c; curl -H "Authorization: Bearer ${e.secrets.kim}" x`
    expect((await post(call('bash', { command: cmd }), auth())).status).toBe(200)
    await post(call('read', { path: `/drafts/${other}.md` }), auth())
    await post(call('history', { path: `/drafts/${gh}.md`, action: 'list' }), auth())
    const rows = e.db.query<{ command: string; command_sha256: string; files: string }, []>('SELECT command, command_sha256, files FROM audit ORDER BY id DESC LIMIT 3').all()
    const dump = JSON.stringify(rows)
    for (const secret of [other, gh, e.secrets.kim!]) expect(dump).not.toContain(secret.slice(-20))
    expect(dump).toContain('[REDACTED')
    expect(rows.at(-1)!.command_sha256).toBe(sha256(cmd))
    expect(verifyAudit(e.db).ok).toBe(true)
  })
})

// plan 7.1 "로그인·MCP 속도 제한" (sign-in limits: test/web-auth.test.ts "rate limits survive a restart")
describe('MCP rate limits: per token and per address, requests per minute and at once; 429 + Retry-After + JSON-RPC error', () => {
  const ping = (id: number) => JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' })
  const req = (body: string, secret?: string) => new Request('http://127.0.0.1/mcp', { method: 'POST',
    headers: { 'content-type': 'application/json', ...(secret ? { authorization: `Bearer ${secret}` } : {}) }, body })
  async function expect429(r: Response, id: unknown) {
    expect(r.status).toBe(429)
    const after = Number(r.headers.get('retry-after'))
    expect(after).toBeGreaterThanOrEqual(1)
    expect(after).toBeLessThanOrEqual(60)
    const b = await r.json() as { jsonrpc: string; id: unknown; error: { code: number; message: string; data: { retry_after: number } } }
    expect(b.jsonrpc).toBe('2.0')
    expect(b.id).toEqual(id)
    expect(b.error.code).toBe(RATE_LIMIT_CODE)
    expect(b.error.data.retry_after).toBe(after)
  }

  test('requests per minute per token; another token is not affected; the window ends', async () => {
    let now = 1_000_000
    const limiter = new McpLimiter({ tokenPerMin: 3 }, () => now)
    for (let i = 1; i <= 3; i++) expect((await handleRequest(e.ctx, req(ping(i), e.secrets.kim), { limiter }, '10.0.0.5')).status).toBe(200)
    await expect429(await handleRequest(e.ctx, req(ping(4), e.secrets.kim), { limiter }, '10.0.0.5'), 4)
    expect((await handleRequest(e.ctx, req(ping(5), e.secrets.boss), { limiter }, '10.0.0.5')).status).toBe(200)
    now += 60_001
    expect((await handleRequest(e.ctx, req(ping(6), e.secrets.kim), { limiter }, '10.0.0.5')).status).toBe(200)
  })

  test('requests per minute per address, whatever the token (and without one)', async () => {
    const limiter = new McpLimiter({ ipPerMin: 2 })
    expect((await handleRequest(e.ctx, req(ping(1), e.secrets.kim), { limiter }, '10.0.0.6')).status).toBe(200)
    expect((await handleRequest(e.ctx, req(ping(2), e.secrets.boss), { limiter }, '10.0.0.6')).status).toBe(200)
    await expect429(await handleRequest(e.ctx, req(ping(3), e.secrets.lee), { limiter }, '10.0.0.6'), null)
    await expect429(await handleRequest(e.ctx, req(ping(4)), { limiter }, '10.0.0.6'), null)
    expect((await handleRequest(e.ctx, req(ping(5), e.secrets.kim), { limiter }, '10.0.0.7')).status).toBe(200)
  })

  test('wrong bearer tokens from one address: after the limit even a valid token is refused from there', async () => {
    const limiter = new McpLimiter({ badAuthPerMin: 3 })
    for (let i = 0; i < 3; i++) expect((await handleRequest(e.ctx, req(ping(i), `${TOKEN_PREFIX}${'x'.repeat(32)}`), { limiter }, '10.0.0.8')).status).toBe(401)
    await expect429(await handleRequest(e.ctx, req(ping(9), e.secrets.kim), { limiter }, '10.0.0.8'), null)
    expect((await handleRequest(e.ctx, req(ping(10), e.secrets.kim), { limiter }, '10.0.0.9')).status).toBe(200)
  })

  test('concurrent requests per token and per address', async () => {
    const limiter = new McpLimiter({ tokenConcurrent: 1, ipConcurrent: 2 })
    const kim = verifyToken(e.db, e.secrets.kim!)!.id
    const busy = limiter.acquire(kim, '10.0.1.1')
    expect(typeof busy).toBe('function')
    // kim's one slot is taken (a long command still running): the next request is refused, from any address
    await expect429(await handleRequest(e.ctx, req(ping(1), e.secrets.kim), { limiter }, '10.0.1.2'), 1)
    // the address has one slot left: boss gets it while kim's command runs
    expect((await handleRequest(e.ctx, req(ping(2), e.secrets.boss), { limiter }, '10.0.1.1')).status).toBe(200)
    const other = limiter.acquire(-1, '10.0.1.1') // fill the address
    await expect429(await handleRequest(e.ctx, req(ping(3), e.secrets.boss), { limiter }, '10.0.1.1'), 3)
    ;(busy as () => void)(); (other as () => void)()
    expect((await handleRequest(e.ctx, req(ping(4), e.secrets.kim), { limiter }, '10.0.1.1')).status).toBe(200)
  })

  test('a slot is given back when the tool call fails, and real parallel calls over HTTP beyond the limit get 429', async () => {
    const limiter = new McpLimiter({ tokenConcurrent: 2 })
    const srv = serve(e.ctx, 0, '127.0.0.1', { limiter })
    try {
      const u = `http://127.0.0.1:${srv.port}/mcp`
      const calls = Array.from({ length: 8 }, (_, i) => post(call('bash', { command: 'grep -r CANARY / | wc -l' }, i), auth(), u))
      const statuses = (await Promise.all(calls)).map((r) => r.status)
      expect(statuses.filter((s) => s === 200).length).toBeGreaterThanOrEqual(2)
      expect(statuses.every((s) => s === 200 || s === 429)).toBe(true)
      // every slot was released
      for (let i = 0; i < 3; i++) expect((await post(ping(100 + i), auth(), u)).status).toBe(200)
    } finally { srv.stop(true) }
  })

  test('the production entry points always limit: serve() and the web server set a limiter by default', async () => {
    const srv = serve(e.ctx, 0)
    try {
      const u = `http://127.0.0.1:${srv.port}/mcp`
      let last = 0
      for (let i = 0; i < 40 && last !== 429; i++) last = (await post(ping(i), { authorization: `Bearer ${TOKEN_PREFIX}${'y'.repeat(32)}` }, u)).status
      expect(last).toBe(429)
    } finally { srv.stop(true) }
  })
})
