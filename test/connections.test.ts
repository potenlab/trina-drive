// Connections, new-client alerts, revocation on the next MCP call, bulk-read alarm, original-write attempts.
import { afterEach, describe, expect, test } from 'bun:test'
import { serve } from '../src/mcp'
import { verifyToken } from '../src/store'
import { setup, type Env } from './helpers'
import { withNotify } from './notify-helpers'

const cleanups: (() => void)[] = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })
const env = () => { const e = setup(); cleanups.push(e.cleanup); return e }
const events = (e: Env, kind: string) => e.db.query<{ token_id: number; subject_person_id: number; detail: string }, [string]>('SELECT * FROM notify_events WHERE kind = ?').all(kind)

function mcp(e: Env, n: ReturnType<typeof withNotify>) {
  const server = serve(e.ctx, 0, '127.0.0.1', { onRequest: n.rt.onMcpRequest })
  cleanups.push(() => server.stop(true))
  const url = `http://127.0.0.1:${server.port}/mcp`
  let id = 0
  return async (secret: string | undefined, method: string, params: Record<string, unknown> = {}, ua = 'claude-code/2.0.1 (darwin)') => {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}`, 'user-agent': ua }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) })
    return { status: r.status, body: await r.json() as { result?: { content?: { text: string }[] }; error?: unknown } }
  }
}
const init = (name: string, version = '1.0') => ({ protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name, version } })

describe('connections', () => {
  test('a new client fires new_client once; version updates do not; another client or IP-less UA does', async () => {
    const e = env()
    const n = withNotify(e)
    const call = mcp(e, n)
    expect((await call(e.secrets.kim, 'initialize', init('claude-code', '2.0.1'))).status).toBe(200)
    await call(e.secrets.kim, 'tools/list')
    await call(e.secrets.kim, 'tools/call', { name: 'bash', arguments: { command: 'ls /' } })
    await call(e.secrets.kim, 'initialize', init('claude-code', '2.0.2'), 'claude-code/2.0.2 (darwin)')
    expect(events(e, 'new_client').length).toBe(1)
    await call(e.secrets.kim, 'initialize', init('cursor', '1.7'), 'cursor/1.7')
    expect(events(e, 'new_client').length).toBe(2)
    // another token is its own story
    await call(e.secrets.boss, 'initialize', init('claude-code'))
    expect(events(e, 'new_client').length).toBe(3)
    const rows = n.rt.connections.list()
    const kim = rows.filter((r) => r.person === 'kim')
    expect(kim.map((r) => [r.token_name, r.client_name, r.client_version, r.ua_product, r.ip]).sort()).toEqual([
      ['kim-laptop', 'claude-code', '2.0.2', 'claude-code', '127.0.0.1'],
      ['kim-laptop', 'cursor', '1.7', 'cursor', '127.0.0.1'],
    ])
    expect(kim.find((r) => r.client_name === 'claude-code')!.requests).toBe(4)
    expect(n.rt.notifier.inbox(n.pid('kim')).map((r) => [r.kind, r.count])).toEqual([['new_client', 2]])
  })

  test('revoke takes effect on the very next MCP call and tells the owner', async () => {
    const e = env()
    const n = withNotify(e)
    const call = mcp(e, n)
    await call(e.secrets.kim, 'initialize', init('claude-code'))
    const ok = await call(e.secrets.kim, 'tools/call', { name: 'bash', arguments: { command: 'ls /' } })
    expect(ok.status).toBe(200)
    expect(ok.body.result!.content![0]!.text).toContain('프로젝트')
    const tokenId = e.tok('kim').id
    expect(n.rt.connections.revoke(tokenId)).toBe(true)
    const next = await call(e.secrets.kim, 'tools/call', { name: 'bash', arguments: { command: 'ls /' } })
    expect(next.status).toBe(401)
    expect((await call(e.secrets.kim, 'tools/list')).status).toBe(401)
    expect(n.rt.connections.revoke(tokenId)).toBe(false)
    expect(n.rt.connections.list().some((r) => r.token_id === tokenId)).toBe(false)
    expect(n.rt.connections.list({ includeRevoked: true }).find((r) => r.token_id === tokenId)!.revoked_at).not.toBeNull()
    expect(events(e, 'token_revoked').map((r) => r.subject_person_id)).toEqual([n.pid('kim')])
    // other tokens are untouched
    expect((await call(e.secrets.boss, 'tools/list')).status).toBe(200)
  })

  test('a write to an original (bash redirect or edit tool) fires original_write_attempt', async () => {
    const e = env()
    const n = withNotify(e)
    await e.tool('kim', 'bash', { command: 'echo x > /프로젝트/new.md' })
    await e.tool('kim', 'edit', { path: '/프로젝트/README.md', old_string: 'Projects', new_string: 'X' })
    await e.tool('kim', 'write', { path: '/drafts/ok.md', content: 'fine' })
    expect(events(e, 'original_write_attempt').length).toBe(2)
    expect(n.rt.notifier.inbox(n.pid('kim')).map((r) => [r.kind, r.level, r.count])).toEqual([['original_write_attempt', 'detail', 2]])
    expect(n.rt.notifier.inbox(n.pid('dion')).map((r) => [r.kind, r.level, r.count])).toEqual([['original_write_attempt', 'count', 2]])
  })
})

describe('bulk-read alarm', () => {
  test('files threshold in a sliding window fires once per window', async () => {
    const e = env()
    const n = withNotify(e, { bulkRead: { windowMs: 600_000, files: 4, bytes: 0, folders: 0, autoSuspend: false } })
    await e.sh('kim', 'cat /프로젝트/README.md /프로젝트/견적_2026.md')
    await e.sh('kim', 'ls -R / ; grep -c 없는말 -r /') // looking without content out does not count
    expect(n.rt.bulk.totals(e.tok('kim').id).files).toBe(2)
    expect(events(e, 'bulk_read').length).toBe(0)
    await e.sh('kim', 'cat /공용/공지.md /프로젝트/사양서.docx')
    expect(events(e, 'bulk_read').length).toBe(1)
    await e.sh('kim', 'cat /프로젝트/일정.hwpx')
    expect(events(e, 'bulk_read').length).toBe(1)
    n.clock.t += 11 * 60_000 // the window slid past everything
    await e.sh('kim', 'cat /프로젝트/README.md')
    expect(events(e, 'bulk_read').length).toBe(1)
    await e.sh('kim', 'cat /프로젝트/README.md /프로젝트/견적_2026.md /공용/공지.md')
    expect(events(e, 'bulk_read').length).toBe(2)
    expect(JSON.parse(events(e, 'bulk_read')[0]!.detail)).toMatchObject({ files: 4, folders: 2 })
    // the token still works (auto-suspend is off by default)
    expect(verifyToken(e.db, e.secrets.kim!)).not.toBeNull()
  })

  test('bytes and distinct-folder thresholds; grep output counts as content', async () => {
    const e = env()
    const n = withNotify(e, { bulkRead: { windowMs: 600_000, files: 0, bytes: 0, folders: 3, autoSuspend: false } })
    await e.sh('boss', 'grep -r 매출 /')
    expect(n.rt.bulk.totals(e.tok('boss').id).folders).toBe(1)
    await e.sh('boss', 'cat /프로젝트/README.md /공용/공지.md')
    expect(events(e, 'bulk_read').length).toBe(1)
    const e2 = env()
    const n2 = withNotify(e2, { bulkRead: { windowMs: 600_000, files: 0, bytes: 150, folders: 0, autoSuspend: false } })
    await e2.sh('kim', 'cat /프로젝트/README.md')
    expect(events(e2, 'bulk_read').length).toBe(0)
    await e2.sh('kim', 'cat /프로젝트/견적_2026.md')
    expect(n2.rt.bulk.totals(e2.tok('kim').id).bytes).toBeGreaterThanOrEqual(150)
    expect(events(e2, 'bulk_read').length).toBe(1)
  })

  test('auto-suspend (opt-in) revokes the token: the next call fails', async () => {
    const e = env()
    const n = withNotify(e, { bulkRead: { windowMs: 600_000, files: 2, bytes: 0, folders: 0, autoSuspend: true } })
    const call = mcp(e, n)
    const r = await call(e.secrets.kim, 'tools/call', { name: 'bash', arguments: { command: 'cat /프로젝트/README.md /공용/공지.md' } })
    expect(r.status).toBe(200)
    expect(events(e, 'bulk_read').length).toBe(1)
    expect(events(e, 'token_revoked').length).toBe(1)
    expect((await call(e.secrets.kim, 'tools/list')).status).toBe(401)
  })
})
