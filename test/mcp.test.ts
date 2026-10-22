// MCP end to end over real HTTP: the official SDK client against our endpoint, plus raw requests for the edges.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { serve } from '../src/mcp'
import { createToken, person, revokeToken } from '../src/store'
import { setup, type Env } from './helpers'

let e: Env
let server: ReturnType<typeof serve>
let url: string
beforeAll(() => {
  e = setup()
  server = serve(e.ctx, 0)
  url = `http://127.0.0.1:${server.port}/mcp`
})
afterAll(() => { server.stop(true); e.cleanup() })

const rpc = (body: unknown, headers: Record<string, string> = {}, method = 'POST') =>
  fetch(url, { method, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: method === 'POST' ? JSON.stringify(body) : undefined })
const init = (id = 1, v = '2025-11-25') => ({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: v, capabilities: {}, clientInfo: { name: 't', version: '0' } } })

describe('MCP over HTTP', () => {
  test('SDK client: initialize, tools/list, tools/call bash with a PAT', async () => {
    const client = new Client({ name: 'test-client', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${e.secrets.kim}` } } })
    await client.connect(transport)
    expect(client.getServerVersion()?.name).toBe('shelf')
    const tools = await client.listTools()
    expect(tools.tools.map((t) => t.name).sort()).toEqual(['bash', 'edit', 'history', 'read', 'write'])
    const r = await client.callTool({ name: 'bash', arguments: { command: 'ls /' } })
    const text = (r.content as { text: string }[])[0]!.text
    expect(text).toContain('프로젝트')
    expect(text).not.toContain('경영')
    expect(r.structuredContent).toMatchObject({ exitCode: 0 })
    const g = await client.callTool({ name: 'bash', arguments: { command: 'grep -r 매출 /' } })
    expect((g.content as { text: string }[])[0]!.text).toBe('[exit code 1]')
    await client.close()
  })

  test('protocol versions 2025-11-25 and 2026-07-28 are both accepted; others get the latest', async () => {
    const auth = { authorization: `Bearer ${e.secrets.kim}` }
    for (const v of ['2025-11-25', '2026-07-28']) {
      const r = await (await rpc(init(1, v), auth)).json() as { result: { protocolVersion: string } }
      expect(r.result.protocolVersion).toBe(v)
    }
    expect(((await (await rpc(init(1, '2024-01-01'), auth)).json()) as { result: { protocolVersion: string } }).result.protocolVersion).toBe('2026-07-28')
    expect((await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { ...auth, 'mcp-protocol-version': '1999-01-01' })).status).toBe(400)
    expect((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, auth)).status).toBe(202)
  })

  test('missing, malformed, expired and revoked tokens are rejected; cookies are ignored', async () => {
    const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' }
    const expired = createToken(e.db, 'kim', { ttlMs: 1 })
    await Bun.sleep(5)
    const revoked = createToken(e.db, 'kim')
    revokeToken(e.db, revoked.id)
    for (const h of <Record<string, string>[]>[{}, { authorization: 'Bearer nope' }, { authorization: `Basic ${e.secrets.kim}` }, { authorization: `Bearer ${expired.token}` },
      { authorization: `Bearer ${revoked.token}` }, { cookie: `token=${e.secrets.kim}` }]) {
      const r = await rpc(list, h)
      expect(r.status).toBe(401)
      expect(r.headers.get('www-authenticate')).toContain('Bearer')
    }
    // a deactivated person's token stops working too
    const t = createToken(e.db, 'park')
    e.db.query('UPDATE people SET active = 0 WHERE id = ?').run(person(e.db, 'park').id)
    expect((await rpc(list, { authorization: `Bearer ${t.token}` })).status).toBe(401)
  })

  test('foreign Origin is refused, GET has no stream, unknown tool is an error', async () => {
    const auth = { authorization: `Bearer ${e.secrets.kim}` }
    expect((await rpc(init(), { ...auth, origin: 'https://evil.example' })).status).toBe(403)
    expect((await rpc(init(), { ...auth, origin: 'http://localhost:3000' })).status).toBe(200)
    expect((await rpc(null, auth, 'GET')).status).toBe(405)
    const r = await (await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'rm', arguments: {} } }, auth)).json() as { error: { code: number } }
    expect(r.error.code).toBe(-32602)
  })

  test('tool calls are audited with the token', async () => {
    const n = e.db.query<{ n: number }, [number]>('SELECT count(*) AS n FROM audit WHERE token_id = ?').get(e.tok('kim').id)!.n
    expect(n).toBeGreaterThanOrEqual(2)
  })
})
