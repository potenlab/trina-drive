// S47 — No AI × WebDAV: a mounted drive is the person (their own access), so No AI folders are on the mount for the
// people who may open them — as docs/SECURITY-MODEL.md says (review finding 16). Agents' tokens never work on /dav,
// app passwords never on /mcp or /api.
import fs from 'node:fs'
import path from 'node:path'
import { CANARY } from '../../seed-team'
import type { Scenario } from '../lib/ctx'
import { dav, davAuth, mcpRaw, propfindBody } from '../lib/drive'
import { expectSight } from '../lib/see'

export default {
  id: 'S47', title: 'No AI × WebDAV: the mount shows /인사 and /경영 to boss (a person), the docs say so', phase: 1, targets: ['local', 'aws'], uses: 'DAV MCP',
  async run(t) {
    const fx = t.fx
    await expectSight(t, 'boss', '/인사/hr.md', CANARY.인사, { human: true, ai: false }, 'mounted', ['dav', 'mcp'])
    await expectSight(t, 'boss', '/경영/board.md', CANARY.경영, { human: true, ai: false }, 'mounted', ['dav', 'mcp'])
    const pat = await fx.token('boss'), ap = await fx.appPassword('boss')
    const withPat = await dav(t.http, fx.slug, davAuth(fx.login('boss'), pat), 'PROPFIND', '/', { body: propfindBody, headers: { depth: '1' } })
    t.check('an agent token (PAT) is refused on /dav (401)', withPat.status === 401, withPat.status)
    const bearer = await dav(t.http, fx.slug, `Bearer ${pat}`, 'PROPFIND', '/', { body: propfindBody, headers: { depth: '1' } })
    t.check('…also as a Bearer header (401)', bearer.status === 401, bearer.status)
    const apOnMcp = await mcpRaw(t.http, fx.slug, ap, 'tools/list')
    t.check('an app password is refused on /mcp (401)', apOnMcp.status === 401, apOnMcp.status)
    const apOnApi = await t.http.req('GET', `${fx.url}/api/session`, { headers: { authorization: davAuth(fx.login('boss'), ap) } })
    t.check('an app password is no session on /api (401)', apOnApi.status === 401, apOnApi.status)
    const doc = fs.readFileSync(path.resolve(import.meta.dir, '../../../../docs/SECURITY-MODEL.md'), 'utf8')
    const says = /mount[^.]*No AI|No AI[^.]*mount|No AI[^.]*WebDAV|WebDAV[^.]*No AI/is.test(doc)
    if (says) t.check('docs/SECURITY-MODEL.md says a mount shows No AI folders to the person', true)
    else t.pending('docs/SECURITY-MODEL.md names No AI on a mounted drive', 'needs A1 (feat/a1-share): finding 16 wording not in the docs yet')
  },
} satisfies Scenario
