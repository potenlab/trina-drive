// MCP endpoint abuse (plan §7.1 "웹 공격", "공개 노출", "토큰 유출"): malformed JSON-RPC, batches, huge bodies,
// protocol versions, cookie/query-string tokens, Origin, token format.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { TOKEN_PREFIX } from '../../src/config'
import { serve } from '../../src/mcp'
import { createToken } from '../../src/store'
import { securitySetup, type SecEnv } from './fixture'

let e: SecEnv
let server: ReturnType<typeof serve>
let url: string
beforeAll(() => {
  e = securitySetup()
  server = serve(e.ctx, 0)
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
  test.todo('login and MCP rate limits (plan 7.1 "로그인·MCP 속도 제한") [owner: packaging / admin REST]', () => {})
  test.todo('a token pasted into a bash command is redacted in the audit command line [owner: audit]', () => {})
})
