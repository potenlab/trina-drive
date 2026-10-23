// `serve --trusted-proxy` (src/web/proxy.ts): behind a reverse proxy (Caddy in Trina Cloud) the main listener takes
// the client address from X-Forwarded-For only when the TCP peer is a trusted proxy; per-address limits, audit and
// connection records then tell clients apart. Spoofed headers from any other peer are ignored, and without the flag
// nothing changes.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { McpLimiter } from '../src/ratelimit'
import { forwardedClient, normalizeIp, parseTrustedProxies, trustedProxiesFrom, type TrustedProxies } from '../src/web/proxy'
import { serveWeb } from '../src/web/server'
import { setup } from './helpers'

const req = (h: Record<string, string> = {}) => new Request('http://drive.test/api/state', { headers: h })

describe('parsing', () => {
  test('addresses and CIDR ranges, v4 and v6', () => {
    const t = parseTrustedProxies(' 127.0.0.1, 172.18.0.0/16 ,fd00::/8, ::1')
    expect(t.spec).toBe('127.0.0.1,172.18.0.0/16,fd00::/8,::1')
    expect(t.header).toBe('x-forwarded-for')
    for (const ok of ['127.0.0.1', '172.18.5.9', 'fd12::3', '::1', '::ffff:172.18.0.2']) expect(forwardedClient(req({ 'x-forwarded-for': '203.0.113.7' }), ok, t)).toBe('203.0.113.7')
    for (const no of ['127.0.0.2', '172.19.0.1', 'fe80::1']) expect(forwardedClient(req({ 'x-forwarded-for': '203.0.113.7' }), no, t)).toBe(no)
  })
  test.each(['', ' , ', 'caddy', '10.0.0.0/33', '10.0.0.1/8/1', 'fd00::/129', '10.0.0.0/x', '1.2.3'])('refuses %p', (spec) => {
    expect(() => parseTrustedProxies(spec)).toThrow()
  })
  test('header choice', () => {
    expect(parseTrustedProxies('10.0.0.1', 'CF-Connecting-IP').header).toBe('cf-connecting-ip')
    expect(() => parseTrustedProxies('10.0.0.1', 'x-real-ip')).toThrow()
  })
  test('flag, then environment; none = off', () => {
    expect(trustedProxiesFrom(undefined, undefined, {}, 'TDRIVE')).toBeNull()
    expect(trustedProxiesFrom('none', undefined, { TDRIVE_TRUSTED_PROXY: '10.0.0.1' }, 'TDRIVE')).toBeNull()
    expect(trustedProxiesFrom(undefined, undefined, { TDRIVE_TRUSTED_PROXY: '10.0.0.0/8', TDRIVE_CLIENT_IP_HEADER: 'cf-connecting-ip' }, 'TDRIVE')).toMatchObject({ spec: '10.0.0.0/8', header: 'cf-connecting-ip' })
    expect(trustedProxiesFrom('192.0.2.1', undefined, { TDRIVE_TRUSTED_PROXY: '10.0.0.0/8' }, 'TDRIVE')?.spec).toBe('192.0.2.1')
  })
  test('normalizeIp', () => {
    expect(normalizeIp('::ffff:10.1.2.3')).toBe('10.1.2.3')
    expect(normalizeIp('[::1]')).toBe('::1')
    expect(normalizeIp('nope')).toBeNull()
  })
})

describe('which address is believed', () => {
  const t = parseTrustedProxies('10.0.0.2, 10.0.1.0/24')
  test('no trusted proxy: the peer as given, headers ignored', () => {
    expect(forwardedClient(req({ 'x-forwarded-for': '198.51.100.1', 'cf-connecting-ip': '198.51.100.2' }), '10.0.0.2', null)).toBe('10.0.0.2')
    expect(forwardedClient(req(), undefined, null)).toBeUndefined()
  })
  test('spoofed headers from an untrusted peer are ignored', () => {
    expect(forwardedClient(req({ 'x-forwarded-for': '198.51.100.1' }), '203.0.113.9', t)).toBe('203.0.113.9')
    expect(forwardedClient(req({ 'cf-connecting-ip': '198.51.100.1' }), '203.0.113.9', t)).toBe('203.0.113.9')
  })
  test('X-Forwarded-For from the right: the first hop that is not a trusted proxy', () => {
    // a client-written entry at the far left never wins over what the proxy appended
    expect(forwardedClient(req({ 'x-forwarded-for': '1.1.1.1, 198.51.100.4' }), '10.0.0.2', t)).toBe('198.51.100.4')
    expect(forwardedClient(req({ 'x-forwarded-for': '198.51.100.4, 10.0.1.7' }), '10.0.0.2', t)).toBe('198.51.100.4')
    expect(forwardedClient(req({ 'x-forwarded-for': '10.0.1.7' }), '10.0.0.2', t)).toBe('10.0.0.2')
    expect(forwardedClient(req({ 'x-forwarded-for': '1.1.1.1, garbage' }), '10.0.0.2', t)).toBe('10.0.0.2')
    expect(forwardedClient(req(), '10.0.0.2', t)).toBe('10.0.0.2')
  })
  test('CF-Connecting-IP only when chosen (a proxy like Caddy passes a client\'s own header through)', () => {
    expect(forwardedClient(req({ 'cf-connecting-ip': '198.51.100.1' }), '10.0.0.2', t)).toBe('10.0.0.2')
    const cf: TrustedProxies = parseTrustedProxies('10.0.0.2', 'cf-connecting-ip')
    expect(forwardedClient(req({ 'cf-connecting-ip': '198.51.100.1', 'x-forwarded-for': '198.51.100.9' }), '10.0.0.2', cf)).toBe('198.51.100.1')
    expect(forwardedClient(req({ 'cf-connecting-ip': 'nope' }), '10.0.0.2', cf)).toBe('10.0.0.2')
  })
})

describe('the main listener (a real socket, peer 127.0.0.1)', () => {
  const e = setup()
  const servers: ReturnType<typeof serveWeb>[] = []
  const start = (trusted: string | null) => {
    const s = serveWeb(e.ctx, 0, '127.0.0.1', { webDir: '/nonexistent', trustedProxy: trusted ? parseTrustedProxies(trusted) : null, mcpLimiter: new McpLimiter() })
    servers.push(s)
    return `http://127.0.0.1:${s.server.port}`
  }
  let behindProxy: string, spoofed: string, plain: string
  beforeAll(() => { behindProxy = start('127.0.0.1'); spoofed = start('10.9.9.9'); plain = start(null) })
  afterAll(() => { for (const s of servers) s.server.stop(true); e.cleanup() })

  const badMcp = (base: string, xff: string) => fetch(`${base}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer tdrive_pat_nope', 'x-forwarded-for': xff },
    body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
  })
  const linkCheck = (base: string, xff: string) => fetch(`${base}/api/links/check`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': xff }, body: JSON.stringify({ kind: 'invite', token: 'nope' }),
  })
  const exhaust = async (f: () => Promise<Response>) => { for (let i = 0; i < 60; i++) if ((await f()).status === 429) return i; return -1 }

  test('behind a trusted proxy: one client\'s bad tokens lock that client out of /mcp, not the whole team', async () => {
    expect(await exhaust(() => badMcp(behindProxy, '198.51.100.10'))).toBeGreaterThan(0)
    expect((await badMcp(behindProxy, '198.51.100.10')).status).toBe(429)
    expect((await badMcp(behindProxy, '198.51.100.11')).status).toBe(401)
  })
  test('behind a trusted proxy: per-address link and setup-token limits per client', async () => {
    expect(await exhaust(() => linkCheck(behindProxy, '198.51.100.20'))).toBe(30)
    expect((await linkCheck(behindProxy, '198.51.100.21')).status).toBe(404)
  })
  test('from an untrusted peer, X-Forwarded-For is ignored: a spoofed address does not get a fresh allowance', async () => {
    expect(await exhaust(() => badMcp(spoofed, '198.51.100.30'))).toBeGreaterThan(0)
    expect((await badMcp(spoofed, '198.51.100.31')).status).toBe(429)
  })
  test('without --trusted-proxy nothing changes: every request is the peer\'s', async () => {
    expect(await exhaust(() => linkCheck(plain, '198.51.100.40'))).toBe(30)
    expect((await linkCheck(plain, '198.51.100.41')).status).toBe(429)
  })
})
