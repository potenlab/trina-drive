// S14 — /프로젝트 is "Anyone in the team · Viewer"; /프로젝트/비밀 is "Restrict access here" keeping boss and sam (and
// kim, who manages /프로젝트 above and keeps access by rule). Everyone not kept — mina, the admin — loses it at once
// on every route; the dialog names how many lose access; the Manager from above stays.
import { CANARY } from '../../seed-team'
import type { Scenario } from '../lib/ctx'
import { expectSight } from '../lib/see'
import { share, shareView } from '../lib/share'

export default {
  id: 'S14', title: '/프로젝트/비밀 Restrict here (keep 2): the rest lose it everywhere, the Manager above stays', phase: 1, targets: ['local', 'aws'], uses: 'H1 MCP DAV',
  async run(t) {
    const fx = t.fx, sd = fx.s.seeded!
    const f = '/프로젝트/비밀/secret.md'
    t.step('kept: boss, sam (Viewer) and kim (Editor; Manager of /프로젝트)')
    for (const who of ['boss', 'sam', 'kim'] as const) await expectSight(t, who, f, CANARY.비밀, { human: true, ai: true }, 'kept')
    t.step('not kept: mina and the admin, although /프로젝트 above is open to everyone')
    await expectSight(t, 'mina', '/프로젝트/plan.md', CANARY.프로젝트, { human: true, ai: true }, 'above', ['web', 'mcp'])
    for (const who of ['mina', 'admin'] as const) await expectSight(t, who, f, CANARY.비밀, { human: false, ai: false }, 'restricted')
    const sub = await (await fx.drive('admin')).get(`/folders/${sd.folders['프로젝트/비밀']}`)
    t.check('the folder row says inheritance is broken here', sub.status === 200 && JSON.stringify(sub.json()).includes('"inherit_break":true'), sub.text.slice(0, 300))

    if (await t.has('share', 'the dialog\'s Restrict here: lost count, Keep, the Manager from above kept')) {
      const kim = await fx.drive('kim')
      const v = await shareView(kim, '/프로젝트/비밀')
      const j = v.status === 200 ? v.json() : {}
      t.check('GET /api/share: restricted_here', j.general?.restricted_here === true, v.text)
      const mgr = (j.entries ?? []).find((e: { subject: { type: string; id: number } }) => e.subject?.type === 'person' && e.subject.id === sd.people.kim)
      t.check('kim (Manager of /프로젝트) is listed and stays', !!mgr, j.entries)
      // turn it off and on again through the dialog: the answer names how many lose access when it is on
      const off = await share(kim, { path: '/프로젝트/비밀', restrict_here: { on: false, keep: [] } })
      t.check('Restrict here off (kim, Manager)', off.status === 200, off.text)
      await expectSight(t, 'mina', f, CANARY.비밀, { human: true, ai: true }, 'inherited again', ['web', 'mcp'])
      const pre = (await shareView(kim, '/프로젝트/비밀')).json()
      const losing = (pre.entries ?? []).filter((e: { source: string; role: string }) => e.source === 'inherited' && e.role !== 'manager')
      t.check(`the dialog can show who would lose access (${losing.length} inherited entries + Anyone in the team)`, !!pre.general?.effective || losing.length > 0, pre)
      const on = await share(kim, { path: '/프로젝트/비밀', restrict_here: { on: true, keep: [{ type: 'person', id: sd.people.boss }, { type: 'person', id: sd.people.sam }] } })
      t.check('Restrict here on, keeping boss and sam', on.status === 200 && on.json().general?.restricted_here === true, on.text)
      await expectSight(t, 'mina', f, CANARY.비밀, { human: false, ai: false }, 'restricted again')
      await expectSight(t, 'kim', f, CANARY.비밀, { human: true, ai: true }, 'Manager from above, restricted again', ['web', 'mcp'])
    }
  },
} satisfies Scenario
