// S43: agents never share, by any route (owner decision O1). /api reads only the session cookie, so a PAT or an OAuth
// Bearer token gets 401 on every sharing route; no MCP tool changes sharing; WebDAV has no ACL method and its
// protected properties cannot be set. Nothing changes in the rules whatever is tried.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { TOOL_DEFS } from '../src/tools'
import { handleWeb } from '../src/web/server'
import { ORIGIN, PASSWORD } from './web-helpers'
import { shareSetup, type ShareEnv } from './share-helpers'

let e: ShareEnv
beforeEach(async () => { e = await shareSetup() })
afterEach(() => e.cleanup())

const rules = () => JSON.stringify(e.db.query('SELECT * FROM rules ORDER BY folder_id, subject_type, subject_id').all()) + JSON.stringify(e.db.query('SELECT * FROM manage_grants ORDER BY folder_id, person_id').all()) + JSON.stringify(e.db.query('SELECT id, no_ai, inherit_break, editors_can_share FROM folders ORDER BY id').all())

describe('S43: agents cannot share', () => {
  test('Bearer tokens (a PAT, an OAuth-style token) on every sharing route: 401, nothing changed', async () => {
    const before = rules()
    const body = JSON.stringify({ path: '/Projects', general: { mode: 'team', role: 'editor' }, add: [{ subject: { type: 'person', id: e.pid('park') }, role: 'manager' }] })
    const routes: [string, string, string | undefined][] = [
      ['GET', '/api/share?path=%2FProjects', undefined], ['POST', '/api/share', body], ['POST', '/api/share/step-up/options', body], ['POST', '/api/share/step-up', body],
      ['GET', '/api/shared-with-me', undefined], ['GET', '/api/directory', undefined],
      ['PUT', `/api/folders/${e.proj.id}/rules`, JSON.stringify({ subject_type: 'person', subject_id: e.pid('park'), level: 'write' })],
      ['PATCH', `/api/folders/${e.proj.id}`, JSON.stringify({ no_ai: false })], ['PUT', `/api/folders/${e.proj.id}/managers/${e.pid('park')}`, undefined],
    ]
    for (const bearer of [e.secrets['kim-ai']!, e.secrets['dion-ai']!, 'tdo_' + 'x'.repeat(40)]) {
      for (const [method, path, b] of routes) {
        const res = await handleWeb(e.w, new Request(ORIGIN + path, { method, body: b, headers: { authorization: `Bearer ${bearer}`, origin: ORIGIN, 'content-type': 'application/json' } }), '10.0.0.1')
        expect([method, path, res.status]).toEqual([method, path, 401])
      }
    }
    expect(rules()).toBe(before)
  })

  test('no MCP tool shares or changes access; asking for one is an unknown tool', async () => {
    const before = rules()
    const names = TOOL_DEFS.map((t) => t.name)
    expect(names.filter((n) => /share|permission|rule|grant|manage|acl|access|member|invite/i.test(n))).toEqual([])
    const r = await e.tool('dion-ai', 'share', { path: '/Projects', general: { mode: 'team', role: 'editor' } })
    expect(r.isError).toBe(true)
    // the AI's shell cannot reach the sharing API or the rule store either: it only has the read-only virtual tree
    const out = (await e.tool('dion-ai', 'bash', { command: 'curl http://localhost/api/share 2>&1; ls /.rules 2>&1; echo end' })).content.map((c: { text: string }) => c.text).join('\n')
    expect(out).toContain('end')
    expect(rules()).toBe(before)
  })

  test('WebDAV: no ACL method, protected properties refused, nothing changes', async () => {
    const before = rules()
    const b = await e.as('dion')
    const pw = (await b.call('POST', '/api/me/app-passwords', { name: 'Mac', password: PASSWORD })).data.password as string
    const auth = 'Basic ' + Buffer.from(`dion:${pw}`).toString('base64')
    const dav = (method: string, body?: string) => handleWeb(e.w, new Request('https://drive.test/dav/Projects/', { method, body, headers: { authorization: auth, 'content-type': 'application/xml' } }), '10.0.0.1')
    const acl = await dav('ACL', '<?xml version="1.0"?><D:acl xmlns:D="DAV:"><D:ace><D:principal><D:all/></D:principal><D:grant><D:privilege><D:write/></D:privilege></D:grant></D:ace></D:acl>')
    expect(acl.status).toBe(405)
    const pp = await dav('PROPPATCH', '<?xml version="1.0"?><D:propertyupdate xmlns:D="DAV:"><D:set><D:prop><D:acl/></D:prop></D:set></D:propertyupdate>')
    const text = await pp.text()
    expect(pp.status === 207 ? text : String(pp.status)).toMatch(/403 Forbidden|^40\d$/)
    expect(rules()).toBe(before)
  })
})
