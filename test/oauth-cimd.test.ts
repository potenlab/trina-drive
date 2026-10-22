// Client ID Metadata Documents: the server fetches a URL a stranger chose, so the fetch must never reach this machine,
// the LAN or a cloud metadata service (plan 7.1 "OAuth 공격", review-tech 4.1). Address rules, the guard with the
// default (real) policy for literal addresses, an injected resolver for host names (DNS answers that point inward,
// mixed answers, rebinding between check and connect), redirects, size, time, and document validation.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { DEFAULT_GUARD, FetchRefused, guardedGetJson, isPublicAddress, type FetchGuard } from '../src/oauth/ssrf'
import { isCimdUrl, redirectMatches, validateCimd } from '../src/oauth/clients'
import { metadataFixture, oauthSetup, pkce, testGuard, type Fixture, type OAuthEnv } from './oauth-helpers'

let fx: Fixture
beforeAll(() => { fx = metadataFixture() })
afterAll(() => fx.stop())

const refused = async (url: string, guard: Partial<FetchGuard> = {}) => {
  try { await guardedGetJson(url, { ...DEFAULT_GUARD, ...guard }); return null } catch (e) { if (e instanceof FetchRefused) return e.message; throw e }
}

describe('address rules', () => {
  test.each([
    '127.0.0.1', '127.255.0.1', '0.0.0.0', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.1', '192.168.1.10', '169.254.169.254', '169.254.0.1',
    '100.64.0.1', '100.127.0.1', '192.0.0.8', '192.0.2.1', '198.18.0.1', '198.51.100.7', '203.0.113.9', '224.0.0.1', '255.255.255.255', '240.0.0.1',
    '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%en0', 'fec0::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:169.254.169.254',
    '::127.0.0.1', '64:ff9b::a00:1', '2001:db8::1', '2002:7f00:1::1', '2001::1', '100::1', 'not-an-ip', '',
  ])('%s is not public', (ip) => { expect(isPublicAddress(ip)).toBe(false) })

  test.each(['8.8.8.8', '1.1.1.1', '160.79.104.10', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '2a00:1450:4001:80b::200e', '::ffff:8.8.8.8'])('%s is public', (ip) => {
    expect(isPublicAddress(ip)).toBe(true)
  })
})

describe('guarded fetch with the default policy', () => {
  test.each([
    ['https://127.0.0.1/client.json', 'not public'], ['https://10.1.2.3/c.json', 'not public'], ['https://169.254.169.254/latest/meta-data/iam', 'not public'],
    ['https://[::1]/c.json', 'not public'], ['https://[fc00::1]/c.json', 'not public'], ['https://[::ffff:127.0.0.1]/c.json', 'not public'],
    ['https://0x7f000001/c.json', 'not public'], ['https://2130706433/c.json', 'not public'], // the URL parser turns these into 127.0.0.1
    ['http://example.com/c.json', 'only https'], ['https://user:pw@example.com/c.json', 'user name'], ['ftp://example.com/c.json', 'only https'],
  ])('%s is refused (%s) before any connection', async (url, why) => {
    expect(await refused(url)).toContain(why)
  })

  test('a host name that resolves to a private address is refused (resolver answers 10.0.0.5 / fd00::1 / 169.254.169.254)', async () => {
    for (const a of [['10.0.0.5', 4], ['fd00::1', 6], ['169.254.169.254', 4], ['127.0.0.1', 4]] as const) {
      expect(await refused('https://cimd.example.com/c.json', { resolve: async () => [{ address: a[0], family: a[1] }] })).toContain('not public')
    }
  })

  test('one private answer among public ones refuses the lot', async () => {
    expect(await refused('https://cimd.example.com/c.json', { resolve: async () => [{ address: '93.184.216.34', family: 4 }, { address: '192.168.0.10', family: 4 }] })).toContain('not public')
  })

  test('a name that does not resolve is refused', async () => {
    expect(await refused('https://nowhere.example.com/c.json', { resolve: async () => [] })).toContain('does not resolve')
    expect(await refused('https://nowhere.example.com/c.json', { resolve: async () => { throw new Error('ENOTFOUND') } })).toContain('does not resolve')
  })
})

describe('guarded fetch against a local fixture (test guard: client.test → 127.0.0.1 only)', () => {
  test('DNS rebinding: the name is resolved once and the socket goes to exactly the checked address', async () => {
    fx.routes.set('/rebind.json', fx.json({ ok: 1 }))
    let calls = 0
    // first answer: the allowed fixture address; every later answer: a LAN address
    const resolve = async () => (calls++ === 0 ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '10.0.0.7', family: 4 }])
    const r = await guardedGetJson(`${fx.base()}/rebind.json`, { ...DEFAULT_GUARD, ...testGuard({ resolve }) })
    expect(r.body).toEqual({ ok: 1 })
    expect(calls).toBe(1)
    // and the other order: the check sees the LAN address and nothing is fetched
    let calls2 = 0
    const before = fx.hits.get('/rebind.json')
    const resolve2 = async () => (calls2++ === 0 ? [{ address: '10.0.0.7', family: 4 }] : [{ address: '127.0.0.1', family: 4 }])
    expect(await refused(`${fx.base()}/rebind.json`, testGuard({ resolve: resolve2 }))).toContain('not public')
    expect(fx.hits.get('/rebind.json')).toBe(before)
  })

  test('redirects are not followed (a redirect to a private address never reaches it)', async () => {
    fx.routes.set('/internal', () => new Response('secret'))
    fx.routes.set('/redirect.json', () => new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${fx.server.port}/internal` } }))
    fx.routes.set('/redirect-same.json', () => new Response(null, { status: 301, headers: { location: '/client.json' } }))
    expect(await refused(`${fx.base()}/redirect.json`, testGuard())).toContain('redirects are not followed')
    expect(await refused(`${fx.base()}/redirect-same.json`, testGuard())).toContain('redirects are not followed')
    expect(fx.hits.get('/internal')).toBeUndefined()
  })

  test('size, time, status and content type limits', async () => {
    fx.routes.set('/big.json', () => new Response(JSON.stringify({ pad: 'x'.repeat(9000) }), { headers: { 'content-type': 'application/json' } }))
    fx.routes.set('/big-chunked.json', () => new Response(new ReadableStream({ start(c) { for (let i = 0; i < 20; i++) c.enqueue(new TextEncoder().encode('x'.repeat(1000))); c.close() } }), { headers: { 'content-type': 'application/json' } }))
    fx.routes.set('/slow.json', async () => { await Bun.sleep(1500); return new Response('{}', { headers: { 'content-type': 'application/json' } }) })
    fx.routes.set('/html', () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }))
    fx.routes.set('/bad.json', () => new Response('{nope', { headers: { 'content-type': 'application/json' } }))
    expect(await refused(`${fx.base()}/big.json`, testGuard())).toContain('larger than')
    expect(await refused(`${fx.base()}/big-chunked.json`, testGuard())).toContain('larger than')
    expect(await refused(`${fx.base()}/slow.json`, testGuard({ timeoutMs: 200 }))).toContain('too long')
    expect(await refused(`${fx.base()}/html`, testGuard())).toContain('not application/json')
    expect(await refused(`${fx.base()}/bad.json`, testGuard())).toContain('not valid JSON')
    expect(await refused(`${fx.base()}/missing.json`, testGuard())).toContain('HTTP 404')
  })
})

describe('client metadata documents', () => {
  test('client_id URL shape', () => {
    expect(isCimdUrl('https://claude.ai/oauth/claude-code-client-metadata')).toBe(true)
    expect(isCimdUrl('https://chatgpt.com/oauth/client.json')).toBe(true)
    for (const bad of ['https://claude.ai', 'https://claude.ai/', 'http://claude.ai/x.json', 'https://claude.ai/x.json#f', 'https://u@claude.ai/x.json', 'https://claude.ai/a/../x.json', 'https://CLAUDE.ai/x.json', 'dcr_abc']) {
      expect(isCimdUrl(bad)).toBe(false)
    }
  })

  test('validation: client_id must equal the URL, name and redirect URIs required, no secrets', () => {
    const url = 'https://app.example.com/client.json'
    const ok = { client_id: url, client_name: 'App', redirect_uris: ['https://app.example.com/cb', 'http://localhost/cb'] }
    expect(validateCimd(url, ok).domain).toBe('app.example.com')
    for (const bad of [
      { ...ok, client_id: 'https://other.example.com/client.json' }, { ...ok, client_name: '' }, { ...ok, redirect_uris: [] },
      { ...ok, redirect_uris: ['http://app.example.com/cb'] }, { ...ok, redirect_uris: ['https://app.example.com/cb#x'] }, { ...ok, client_secret: 's' },
      [ok], 'text', null,
    ]) expect(() => validateCimd(url, bad)).toThrow()
  })

  test('redirect matching: exact, and loopback with any port only', () => {
    const reg = ['https://claude.ai/api/mcp/auth_callback', 'http://localhost/callback', 'http://127.0.0.1/callback']
    expect(redirectMatches(reg, 'https://claude.ai/api/mcp/auth_callback')).toBe(true)
    expect(redirectMatches(reg, 'http://localhost:3118/callback')).toBe(true)
    expect(redirectMatches(reg, 'http://127.0.0.1:50000/callback')).toBe(true)
    for (const bad of ['https://claude.ai/api/mcp/auth_callback/', 'https://claude.ai:8443/api/mcp/auth_callback', 'http://localhost:3118/other', 'http://127.0.0.2:1/callback', 'https://localhost/callback', 'http://[::1]:5/callback']) {
      expect(redirectMatches(reg, bad)).toBe(false)
    }
  })
})

describe('through /oauth/authorize', () => {
  let o: OAuthEnv
  beforeAll(async () => { o = await oauthSetup() })
  afterAll(() => o.cleanup())

  test('metadata-service and LAN client_ids get an error page, never a fetch or a redirect (any-client policy, real address rules)', async () => {
    const before = o.env.w.oauth
    o.env.w.oauth = o.runtime({ clientHosts: 'any', guard: {} })
    try {
      for (const id of ['https://169.254.169.254/latest/meta-data/x', 'https://10.0.0.1/c.json', 'https://[::1]/c.json', 'https://127.0.0.1/c.json']) {
        const a = await o.startAuth(pkce().challenge, { client_id: id })
        expect(a.res.status).toBe(400)
        expect(a.res.headers.get('location')).toBeNull()
        expect(await a.res.text()).toContain('not public')
      }
    } finally { o.env.w.oauth = before }
  })

  test('hosts outside the trust list are refused before fetching', async () => {
    const hits = fx.hits.get('/client.json') ?? 0
    const a = await o.startAuth(pkce().challenge, { client_id: `${fx.base('other.client.test')}/client.json` })
    expect(a.res.status).toBe(400)
    expect(await a.res.text()).toContain('not allowed on this server')
    expect(fx.hits.get('/client.json') ?? 0).toBe(hits)
  })

  test('the document is cached (one fetch for several authorizations)', async () => {
    const n0 = o.fx.hits.get('/client.json') ?? 0
    for (let i = 0; i < 3; i++) expect((await o.startAuth(pkce().challenge)).rid).not.toBeNull()
    expect((o.fx.hits.get('/client.json') ?? 0) - n0).toBeLessThanOrEqual(1)
  })

  test('a document whose client_id differs from its URL, or a redirect URI the document does not list, is refused', async () => {
    o.fx.routes.set('/liar.json', o.fx.json({ client_id: 'https://claude.ai/oauth/claude-code-client-metadata', client_name: 'Claude', redirect_uris: ['https://app.client.test/callback'] }))
    const a = await o.startAuth(pkce().challenge, { client_id: `${o.fx.base()}/liar.json` })
    expect(a.res.status).toBe(400)
    expect(await a.res.text()).toContain('does not equal its URL')
  })

  test('localhost-only clients are flagged for the consent page', async () => {
    const id = `${o.fx.base()}/local.json`
    o.fx.routes.set('/local.json', o.fx.json({ client_id: id, client_name: 'Local tool', redirect_uris: ['http://127.0.0.1/cb'] }))
    const a = await o.startAuth(pkce().challenge, { client_id: id, redirect_uri: 'http://127.0.0.1:4444/cb' })
    const b = await o.env.as('kim')
    const d = await b.call('GET', `/api/oauth/requests/${a.rid}`)
    expect(d.data.client).toMatchObject({ loopback_only: true, loopback: true, redirect_host: '127.0.0.1:4444', domain: 'client.test' })
  })
})
