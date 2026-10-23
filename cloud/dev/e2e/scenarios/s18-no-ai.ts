// S18 — /인사 is No AI: people with access open it on the web (and on a mounted drive, S47); no token of anyone's
// sees it; its Manager (boss, not an admin) may turn No AI on but never off; only an admin turns it off.
import { CANARY } from '../../seed-team'
import type { Scenario } from '../lib/ctx'
import { bash } from '../lib/drive'
import { expectSight } from '../lib/see'

export default {
  id: 'S18', title: '/인사 No AI: open on the web for its people, closed to every token; Manager can only turn it on', phase: 1, targets: ['local', 'aws'], uses: 'H1 MCP',
  async run(t) {
    const fx = t.fx, sd = fx.s.seeded!
    await expectSight(t, 'boss', '/인사/hr.md', CANARY.인사, { human: true, ai: false }, 'No AI', ['web', 'search', 'mcp'])
    const tok = await fx.token('boss')
    const ls = await bash(t.http, fx.slug, tok, 'ls /; find / -name "*.md" 2>/dev/null; du -a / 2>/dev/null | tail -50')
    t.check('boss\'s AI: no 인사 or 경영 in ls /, find, du', !/인사|경영|hr\.md|board\.md/.test(ls.stdout), ls.stdout)
    const scoped = await (await fx.drive('boss')).token(`e2e-s18-${Date.now().toString(36)}`, { scope: [sd.folders.인사!], read_only: true, password: fx.creds('boss').password }).catch((e) => String(e))
    if (scoped.startsWith('tdrive_pat_')) {
      const c = await bash(t.http, fx.slug, scoped, "cat '/인사/hr.md'; ls /")
      t.check('a token scoped to /인사 itself still reads nothing there', !c.stdout.includes(CANARY.인사) && !/인사/.test(c.stdout), c)
    } else t.check('a token scoped to /인사 can be made (or is refused outright)', /bad_scope|no_ai|403|400/.test(scoped), scoped)
    t.step('Manager (boss) and No AI')
    const boss = await fx.drive('boss')
    const off = await boss.api('PATCH', `/folders/${sd.folders.인사}`, { no_ai: false })
    t.check('boss (Manager, not admin) cannot turn No AI off: 403', off.status === 403, off.text)
    const on = await boss.api('PATCH', `/folders/${sd.folders.인사}`, { no_ai: true })
    t.check('boss may turn it on (already on: ok)', on.status === 200, on.text)
    const f = await boss.get(`/folders/${sd.folders.인사}`)
    t.check('the folder says No AI', f.status === 200 && JSON.stringify(f.json()).includes('"no_ai":true'), f.text.slice(0, 300))
    if (await t.has('share', 'the share dialog shows AI access off and Manager cannot switch it back')) {
      const v = await boss.get(`/share?path=${encodeURIComponent('/인사')}`)
      t.check('GET /api/share: ai.no_ai = true, can_ai_off = false for the Manager', v.status === 200 && v.json().ai?.no_ai === true && v.json().can_ai_off === false, v.text)
    }
  },
} satisfies Scenario
