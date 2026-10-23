// S12 — /재무 shared with the 재무 group as Viewer: sam (재무) sees it everywhere, mina (not 재무) sees it nowhere —
// web list, search, direct link, WebDAV and MCP all answer exactly as for a path that does not exist.
import { CANARY } from '../../seed-team'
import type { Scenario } from '../lib/ctx'
import { expectSight } from '../lib/see'
import { setRole } from '../lib/share'
import { ui } from '../lib/ui'

export default {
  id: 'S12', title: '/재무 to the 재무 group as Viewer: sam sees it, mina sees nothing anywhere', phase: 1, targets: ['local', 'aws'], uses: 'H1 MCP DAV H2',
  async run(t) {
    const fx = t.fx, sd = fx.s.seeded!
    t.step('admin shares /재무 with 재무 as Viewer')
    const { res, via } = await setRole(t, await fx.drive('admin'), '/재무', sd.folders.재무!, { type: 'group', id: sd.groups.재무! }, 'viewer')
    t.check(`share /재무 → 재무 Viewer (${via} API)`, res.status === 200, res.text)
    if (via === 'rules') t.pending('the share dialog API for this share', 'needs A1 (feat/a1-share): POST /api/share not served yet — the rules API did it')
    t.step('sam (재무): everywhere')
    await expectSight(t, 'sam', '/재무/결산.md', CANARY.재무, { human: true, ai: true })
    t.step('mina (not 재무): nowhere, like a path that does not exist')
    await expectSight(t, 'mina', '/재무/결산.md', CANARY.재무, { human: false, ai: false })
    const top = await (await fx.drive('mina')).list('/')
    t.check('mina: the drive root lists no 재무', top.status === 200 && !(top.json().entries as { name: string }[]).some((e) => e.name === '재무'), top.text)
    if (await t.has('browser', 'the same in a browser (mina opens /재무 by link)')) {
      const { financeHidden } = await ui()
      const r = await financeHidden(t)
      t.check('browser: mina\'s link to /재무 shows "not found", sam\'s shows 결산.md', r.minaNotFound && r.samSees, r)
    }
  },
} satisfies Scenario
