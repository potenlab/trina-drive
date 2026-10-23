// S17 — revoking mina's access to a folder: from the very next request she (web, search, WebDAV) and her AI (the same
// token, MCP) find nothing there, and every other access she has is untouched.
import { CANARY } from '../../seed-team'
import type { Scenario } from '../lib/ctx'
import { expectSight } from '../lib/see'
import { setRole } from '../lib/share'

export default {
  id: 'S17', title: 'revoke mina\'s folder access: gone on every route from the next request, the rest intact', phase: 1, targets: ['local', 'aws'], uses: 'H1 MCP DAV H2',
  async run(t) {
    const fx = t.fx, sd = fx.s.seeded!
    const admin = await fx.drive('admin')
    const mina = { type: 'person' as const, id: sd.people.mina! }
    t.step('admin gives mina Viewer on /재무')
    const g = await setRole(t, admin, '/재무', sd.folders.재무!, mina, 'viewer')
    t.check(`mina Viewer on /재무 (${g.via})`, g.res.status === 200, g.res.text)
    await expectSight(t, 'mina', '/재무/결산.md', CANARY.재무, { human: true, ai: true }, 'shared')
    t.step('revoke')
    const r = await setRole(t, admin, '/재무', sd.folders.재무!, mina, 'remove')
    t.check(`mina removed from /재무 (${r.via})`, r.res.status === 200, r.res.text)
    await expectSight(t, 'mina', '/재무/결산.md', CANARY.재무, { human: false, ai: false }, 'revoked')
    t.step('the rest of mina\'s access is as before')
    await expectSight(t, 'mina', '/공용/notice.md', CANARY.공용, { human: true, ai: true }, 'untouched')
    await expectSight(t, 'mina', '/프로젝트/plan.md', CANARY.프로젝트, { human: true, ai: true }, 'untouched')
    await expectSight(t, 'sam', '/재무/결산.md', CANARY.재무, { human: true, ai: true }, 'others untouched', ['web', 'mcp'])
    if (r.via === 'rules') t.pending('the same through the share dialog (Remove in "People with access")', 'needs A1 (feat/a1-share): POST /api/share not served yet')
    if (await t.has('browser', 'the UI flow (share dialog → second user sees it → revoke)')) {
      const r2 = await (await (await import('../lib/ui')).ui()).shareAndRevoke(t)
      if (r2.pending) t.pending('the UI flow (share dialog → second user sees it → revoke)', r2.pending)
      else for (const [k, v] of Object.entries(r2.checks as Record<string, boolean>)) t.check(`browser: ${k}`, v, r2)
    }
  },
} satisfies Scenario
