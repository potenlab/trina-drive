// S25 — a token limited to /프로젝트 and read-only: its AI sees /프로젝트 only (nothing elsewhere the person can read,
// shared or not) and cannot even write drafts.
import { CANARY } from '../../seed-team'
import type { Scenario } from '../lib/ctx'
import { bash, tool } from '../lib/drive'

export default {
  id: 'S25', title: 'a read-only token scoped to /프로젝트: nothing outside it, no drafts', phase: 1, targets: ['local', 'aws'], uses: 'H1 MCP',
  async run(t) {
    const fx = t.fx, sd = fx.s.seeded!
    const sam = await fx.drive('sam')
    const tok = await sam.token(`e2e-s25-${Date.now().toString(36)}`, { scope: [sd.folders.프로젝트!], read_only: true, password: fx.creds('sam').password })
    const ls = await bash(t.http, fx.slug, tok, 'ls /; grep -rl CANARY / ; true')
    t.check('ls / shows /프로젝트 only (sam also reads 공용 and 재무)', /프로젝트/.test(ls.stdout) && !/공용|재무/.test(ls.stdout), ls.stdout)
    t.check('grep -r finds the /프로젝트 canaries only', ls.stdout.includes('plan.md') && !ls.stdout.includes('결산') && !ls.stdout.includes('notice'), ls.stdout)
    const sec = await bash(t.http, fx.slug, tok, "cat '/프로젝트/비밀/secret.md'")
    t.check('…including /프로젝트/비밀, which sam reads', sec.stdout.includes(CANARY.비밀), sec)
    const fin = await bash(t.http, fx.slug, tok, "cat '/재무/결산.md'")
    const nx = await bash(t.http, fx.slug, tok, "cat '/재무-nx41/결산.md'")
    t.check('/재무 (sam reads it, out of scope) answers like a missing path', fin.exit === nx.exit && fin.stderr.replace('재무/', '') === nx.stderr.replace('재무-nx41/', ''), { fin, nx })
    const w = await tool(t.http, fx.slug, tok, 'write', { path: '/drafts/s25.md', content: 'no' })
    t.check('writing a draft is refused (read-only token)', w.isError && /read-only|read only/i.test(w.text + w.raw), w.raw.slice(0, 300))
    const full = await fx.token('sam')
    const all = await bash(t.http, fx.slug, full, 'ls /')
    t.check('sam\'s full token still sees 공용 and 재무 (scope is per token)', /공용/.test(all.stdout) && /재무/.test(all.stdout), all.stdout)
  },
} satisfies Scenario
