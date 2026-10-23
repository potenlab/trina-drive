// S43 — agents never share: a token (PAT, or an OAuth bearer) gets 401 on the sharing and rules APIs; no MCP tool can
// share; WebDAV (a person's mount) has no ACL method and agent tokens do not open it.
import type { Scenario } from '../lib/ctx'
import { dav, davAuth, mcpRaw } from '../lib/drive'

export default {
  id: 'S43', title: 'agents cannot share: Bearer tokens 401 on /api/share and rules, no share tool, no WebDAV ACL', phase: 1, targets: ['local', 'aws'], uses: 'H1 MCP DAV',
  async run(t) {
    const fx = t.fx, sd = fx.s.seeded!
    const pat = await fx.token('kim') // kim manages /프로젝트: the person could share; their AI must not
    const asBearer = (method: string, p: string, body?: unknown) => t.http.req(method, `${fx.url}/api${p}`, { body, headers: { authorization: `Bearer ${pat}` } })
    const calls: [string, string, unknown?][] = [
      ['PUT', `/folders/${sd.folders.프로젝트}/rules`, { subject_type: 'person', subject_id: sd.people.mina, level: 'write' }],
      ['PATCH', `/folders/${sd.folders.프로젝트}`, { no_ai: false }],
      ['PUT', `/folders/${sd.folders.프로젝트}/managers/${sd.people.mina}`],
      ['POST', '/files/share', { path: '/프로젝트' }],
      ['POST', '/share', { path: '/프로젝트', add: [{ subject: { type: 'person', id: sd.people.mina }, role: 'editor' }] }],
      ['GET', `/share?path=${encodeURIComponent('/프로젝트')}`],
      ['POST', '/tokens', { name: 'agent-made', ttl: '1d' }],
    ]
    const shareApi = (await t.features.get('share')).ok
    for (const [m, p, b] of calls) {
      if (p.startsWith('/share') && !shareApi) { t.pending(`kim's PAT on ${m} /api/share → 401`, 'needs A1 (feat/a1-share): /api/share not served yet'); continue }
      const r = await asBearer(m, p, b)
      t.check(`kim's PAT on ${m} /api${p.split('?')[0]} → 401`, r.status === 401, `${r.status} ${r.text.slice(0, 120)}`)
    }
    const list = await mcpRaw(t.http, fx.slug, pat, 'tools/list')
    const names = (list.json().result?.tools ?? []).map((x: { name: string }) => x.name) as string[]
    t.check(`tools/list has no sharing tool (${names.join(', ')})`, names.length > 0 && !names.some((n) => /share|grant|rule|permission|acl|manage/i.test(n)), names)
    const call = await mcpRaw(t.http, fx.slug, pat, 'tools/call', { name: 'share', arguments: { path: '/프로젝트', person: 'mina' } })
    t.check('tools/call share → unknown tool', /unknown|not found|-32602|-32601/i.test(call.text), call.text.slice(0, 200))
    const ap = await fx.appPassword('kim')
    const acl = await dav(t.http, fx.slug, davAuth(fx.login('kim'), ap), 'ACL', '/프로젝트/', { body: '<?xml version="1.0"?><D:acl xmlns:D="DAV:"/>' })
    t.check('WebDAV ACL → 405 (no such method)', acl.status === 405, acl.status)
    const pp = await dav(t.http, fx.slug, davAuth(fx.login('kim'), pat), 'PROPPATCH', '/프로젝트/', { body: '<?xml version="1.0"?><D:propertyupdate xmlns:D="DAV:"><D:set><D:prop><x:share xmlns:x="urn:x">mina</x:share></D:prop></D:set></D:propertyupdate>' })
    t.check('WebDAV PROPPATCH with an agent token → 401', pp.status === 401, pp.status)
    const up = await (await fx.drive('mina')).upload('/프로젝트', 's43.md', 'should not land')
    t.check('nothing changed: mina is still a Viewer of /프로젝트 (upload refused)', up.status === 403 || up.status === 404, `${up.status} ${up.text}`)
  },
} satisfies Scenario
