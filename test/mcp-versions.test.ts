// MCP protocol eras on one endpoint: 2025-11-25 (initialize handshake) and 2026-07-28 (stateless, server/discover,
// per-request _meta, Mcp-Method/Mcp-Name headers). Raw requests for each rule, then the official TypeScript SDK v2 client
// (@modelcontextprotocol/client) negotiating both ways.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Client, StreamableHTTPClientTransport, type ClientOptions } from '@modelcontextprotocol/client'
import { HEADER_MISMATCH, serve, UNSUPPORTED_PROTOCOL_VERSION } from '../src/mcp'
import { setup, type Env } from './helpers'

const MODERN = '2026-07-28', LEGACY = '2025-11-25'
let e: Env
let server: ReturnType<typeof serve>
let url: string
const seen: { method: string; clientName?: string; clientVersion?: string }[] = []
beforeAll(() => {
  e = setup()
  server = serve(e.ctx, 0, '127.0.0.1', { onRequest: (_t, i) => { seen.push(i) } })
  url = `http://127.0.0.1:${server.port}/mcp`
})
afterAll(() => { server.stop(true); e.cleanup() })

type Rpc = { result?: Record<string, any>; error?: { code: number; message: string; data?: any } }
const post = async (body: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(url, { method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${e.secrets.kim}`, ...headers } })
  const text = await r.text()
  return { status: r.status, body: (text ? JSON.parse(text) : undefined) as Rpc }
}
const meta = (v = MODERN, extra: Record<string, unknown> = {}) => ({
  'io.modelcontextprotocol/protocolVersion': v, 'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'modern-raw', version: '9.1' }, ...extra })
/** a 2026-07-28 request the way the spec writes it: _meta in params, version/method/name mirrored into headers */
const modern = (method: string, params: Record<string, unknown> = {}, o: { v?: string; headers?: Record<string, string>; meta?: Record<string, unknown> } = {}) => {
  const v = o.v ?? MODERN
  const h: Record<string, string> = { 'mcp-protocol-version': v, 'mcp-method': method }
  if (typeof params.name === 'string') h['mcp-name'] = params.name
  return post({ jsonrpc: '2.0', id: 7, method, params: { ...params, _meta: o.meta ?? meta(v) } }, { ...h, ...o.headers })
}
const legacyInit = (v: unknown = LEGACY) =>
  post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: v, capabilities: {}, clientInfo: { name: 'legacy-raw', version: '1.0' } } })

describe('a client that only speaks 2025-11-25', () => {
  test('initialize → 2025-11-25 with instructions; later requests carry the legacy header', async () => {
    const init = await legacyInit()
    expect(init.status).toBe(200)
    expect(init.body.result).toMatchObject({ protocolVersion: LEGACY, capabilities: { tools: {} }, serverInfo: { name: 'trina-drive' } })
    expect(init.body.result!.instructions).toContain('/drafts/')
    expect(init.body.result!.resultType).toBeUndefined() // 2025-11-25 results stay as they were
    const h = { 'mcp-protocol-version': LEGACY }
    expect((await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, h)).status).toBe(202)
    expect((await post({ jsonrpc: '2.0', id: 2, method: 'ping' }, h)).body.result).toEqual({})
    const list = await post({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, h)
    expect(list.body.result!.tools.map((t: { name: string }) => t.name)).toContain('bash')
    expect(list.body.result!.ttlMs).toBeUndefined()
    const call = await post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'bash', arguments: { command: 'ls /' } } }, h)
    expect(call.body.result!.content[0].text).toContain('프로젝트')
  })

  test('initialize never answers with a modern version: 2026-07-28, unknown or garbage get 2025-11-25', async () => {
    for (const v of [MODERN, '2024-11-05', '2099-01-01', { x: 1 }]) expect((await legacyInit(v)).body.result!.protocolVersion).toBe(LEGACY)
  })

  test('the legacy client is recorded from initialize clientInfo', async () => {
    seen.length = 0
    await legacyInit()
    expect(seen.at(-1)).toMatchObject({ method: 'initialize', clientName: 'legacy-raw', clientVersion: '1.0' })
  })
})

describe('a client that only speaks 2026-07-28', () => {
  test('server/discover: versions, capabilities, the same instructions as initialize, serverInfo, cache hints', async () => {
    const d = await modern('server/discover')
    expect(d.status).toBe(200)
    expect(d.body.result).toMatchObject({ resultType: 'complete', supportedVersions: [MODERN, LEGACY], capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'trina-drive' } }, cacheScope: 'private' })
    expect(d.body.result!.ttlMs).toBeGreaterThanOrEqual(0)
    expect(d.body.result!.instructions).toBe((await legacyInit()).body.result!.instructions)
  })

  test('tools/list and tools/call without any handshake', async () => {
    const list = await modern('tools/list')
    expect(list.body.result).toMatchObject({ resultType: 'complete', cacheScope: 'private', _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'trina-drive' } } })
    expect(Number.isInteger(list.body.result!.ttlMs)).toBe(true)
    expect(list.body.result!.tools.map((t: { name: string }) => t.name)).toContain('bash')
    const call = await modern('tools/call', { name: 'bash', arguments: { command: 'ls /' } })
    expect(call.status).toBe(200)
    expect(call.body.result).toMatchObject({ resultType: 'complete', structuredContent: { exitCode: 0 } })
    expect(call.body.result!.content[0].text).toContain('프로젝트')
    expect(call.body.result!.ttlMs).toBeUndefined() // tools/call results are not cacheable
    // Mcp-Name in the base64 sentinel form is decoded before the comparison
    const b64 = await modern('tools/call', { name: 'bash', arguments: { command: 'ls /' } }, { headers: { 'mcp-name': `=?base64?${btoa('bash')}?=` } })
    expect(b64.body.result!.resultType).toBe('complete')
  })

  test('each request names its client in _meta', async () => {
    seen.length = 0
    await modern('tools/list')
    expect(seen.at(-1)).toMatchObject({ method: 'tools/list', clientName: 'modern-raw', clientVersion: '9.1' })
  })

  test('methods 2026-07-28 removed or this server does not offer: 404 with -32601', async () => {
    for (const m of ['initialize', 'ping', 'subscriptions/listen', 'resources/list', 'logging/setLevel']) {
      const r = await modern(m)
      expect([m, r.status, r.body.error?.code]).toEqual([m, 404, -32601])
    }
  })

  test('header and _meta rules: 400 with HeaderMismatch or invalid params, and the call does not run', async () => {
    const write = { name: 'write', arguments: { path: '/drafts/versions-refused.md', content: 'x' } }
    const cases: [string, Promise<{ status: number; body: Rpc }>, number][] = [
      ['no MCP-Protocol-Version header', post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { ...write, _meta: meta() } }, { 'mcp-method': 'tools/call', 'mcp-name': 'write' }), HEADER_MISMATCH],
      ['header and _meta disagree', modern('tools/call', write, { meta: meta(LEGACY) }), HEADER_MISMATCH],
      ['no Mcp-Method', modern('tools/call', write, { headers: { 'mcp-method': '' } }), HEADER_MISMATCH],
      ['Mcp-Method differs', modern('tools/call', write, { headers: { 'mcp-method': 'tools/list' } }), HEADER_MISMATCH],
      ['Mcp-Name differs', modern('tools/call', write, { headers: { 'mcp-name': 'read' } }), HEADER_MISMATCH],
      ['Mcp-Name bad base64', modern('tools/call', write, { headers: { 'mcp-name': '=?base64?***?=' } }), HEADER_MISMATCH],
      ['no _meta at all', post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: write }, { 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/call', 'mcp-name': 'write' }), -32602],
      ['no clientCapabilities', modern('tools/call', write, { meta: { 'io.modelcontextprotocol/protocolVersion': MODERN } }), -32602],
    ]
    for (const [label, p, code] of cases) {
      const r = await p
      expect([label, r.status, r.body.error?.code]).toEqual([label, 400, code])
    }
    expect(e.db.query("SELECT count(*) AS n FROM drafts WHERE path LIKE '%versions-refused%'").get()).toEqual({ n: 0 })
    // the same call, well-formed, does run
    expect((await modern('tools/call', write)).body.result!.isError).toBeFalsy()
    expect(e.db.query("SELECT count(*) AS n FROM drafts WHERE path LIKE '%versions-refused%'").get()).toEqual({ n: 1 })
  })

  test('server/discover with no protocol version at all is a malformed modern request', async () => {
    const r = await post({ jsonrpc: '2.0', id: 1, method: 'server/discover' })
    expect([r.status, r.body.error?.code]).toEqual([400, -32602])
  })
})

describe('an unknown protocol version', () => {
  const expectUnsupported = (r: { status: number; body: Rpc }, requested: string) => {
    expect(r.status).toBe(400)
    expect(r.body.error).toMatchObject({ code: UNSUPPORTED_PROTOCOL_VERSION, data: { supported: [MODERN, LEGACY], requested } })
  }
  test('in _meta and the header: UnsupportedProtocolVersionError listing what the server speaks', async () => {
    expectUnsupported(await modern('server/discover', {}, { v: '2099-01-01' }), '2099-01-01')
    expectUnsupported(await modern('tools/list', {}, { v: '2099-01-01' }), '2099-01-01')
  })
  test('in the header only (a client from another era), on any method', async () => {
    for (const v of ['1999-01-01', '2025-06-18', '2026-07-28,2025-11-25']) {
      expectUnsupported(await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'mcp-protocol-version': v }), v)
    }
  })
  test('2025-11-25 in _meta is not a stateless version', async () => {
    expectUnsupported(await modern('tools/list', {}, { v: LEGACY }), LEGACY)
  })
})

describe('official TypeScript SDK v2 client', () => {
  const connect = async (versionNegotiation?: ClientOptions['versionNegotiation']) => {
    const client = new Client({ name: 'sdk-v2', version: '2.3.1' }, versionNegotiation ? { versionNegotiation } : undefined)
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${e.secrets.kim}` } } }))
    return client
  }
  const use = async (client: Client) => {
    expect(client.getServerVersion()?.name).toBe('trina-drive')
    expect(client.getInstructions()).toContain('/drafts/')
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('bash')
    const r = await client.callTool({ name: 'bash', arguments: { command: 'ls /' } })
    expect((r.content as { text: string }[])[0]!.text).toContain('프로젝트')
    await client.close()
  }

  test('auto negotiation probes server/discover and stays on 2026-07-28', async () => {
    const client = await connect({ mode: 'auto' })
    expect(client.getProtocolEra()).toBe('modern')
    expect(client.getNegotiatedProtocolVersion()).toBe(MODERN)
    expect(client.getDiscoverResult()?.supportedVersions).toEqual([MODERN, LEGACY])
    await use(client)
  })

  test('pinned to 2026-07-28 (no fallback)', async () => {
    const client = await connect({ mode: { pin: MODERN } })
    expect(client.getNegotiatedProtocolVersion()).toBe(MODERN)
    await use(client)
  })

  test('legacy mode (the SDK default) runs initialize and gets 2025-11-25', async () => {
    const client = await connect()
    expect(client.getProtocolEra()).toBe('legacy')
    expect(client.getNegotiatedProtocolVersion()).toBe(LEGACY)
    await use(client)
  })
})
