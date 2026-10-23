// S28 — audit: the admin's summary with a verified hash chain; a Manager sees the rows of their own folders only
// (sharing changes and AI reads included, other folders' rows never); others see none; the product's and the
// console's chains verify from the command line.
import type { Scenario } from '../lib/ctx'
import { bash } from '../lib/drive'
import { setRole } from '../lib/share'

export default {
  id: 'S28', title: 'audit: admin summary + chain, Manager sees only their folders (shares, AI reads), CLI verify', phase: 1, targets: ['local', 'aws'], uses: 'H1 MCP OPS',
  async run(t) {
    const fx = t.fx, sd = fx.s.seeded!
    const run = Date.now().toString(36)
    t.step('things to find: kim\'s AI reads /프로젝트 and /재무; the admin changes sharing on /프로젝트')
    const tok = await fx.token('kim')
    await bash(t.http, fx.slug, tok, `cat '/프로젝트/plan.md' '/재무/결산.md' # ${run}`)
    const sam = { type: 'person' as const, id: sd.people.sam! }
    const g = await setRole(t, await fx.drive('admin'), '/프로젝트', sd.folders.프로젝트!, sam, 'editor')
    await setRole(t, await fx.drive('admin'), '/프로젝트', sd.folders.프로젝트!, sam, 'remove')
    t.check('sharing changed twice', g.res.status === 200, g.res.text)
    const sum = await (await fx.drive('admin')).get('/audit?view=summary')
    t.check('admin summary: rows per person and connection; the chain verifies', sum.status === 200 && sum.json().chain?.ok === true && sum.json().rows.length > 3, sum.text.slice(0, 300))
    const notAdmin = await (await fx.drive('kim')).get('/audit?view=summary')
    t.check('kim (not admin) gets no summary: 403', notAdmin.status === 403, notAdmin.status)
    const kf = await (await fx.drive('kim')).get('/audit?view=folders')
    const kj = kf.status === 200 ? kf.json() as { entries: { files: string[]; command: string | null; tool: string; connection: string }[]; folders: string[] } : { entries: [], folders: [] }
    const files = kj.entries.flatMap((e) => e.files)
    t.check('kim\'s folder audit covers /프로젝트 (the folder he manages)', kj.folders.includes('/프로젝트'), kj.folders)
    t.check('…with his AI\'s read of /프로젝트/plan.md', kj.entries.some((e) => e.files.includes('/프로젝트/plan.md') && e.connection !== 'web'), kj.entries.slice(0, 5))
    t.check('…and the sharing changes on /프로젝트', kj.entries.some((e) => /rule|share/.test(e.command ?? '') || (e.tool === 'web' && e.files.includes('/프로젝트'))), kj.entries.slice(0, 5))
    // the team is shared by every scenario and run: S42 makes kim the Manager of its own /S42-<run> folders, so those
    // are his too. What he only reads (/재무, which his AI just read) must never show.
    const under = (file: string, d: string) => { const f = file.startsWith('/.raw/') ? file.slice(5) : file; return f === d || f.startsWith(d + '/') }
    const others = kj.folders.filter((d) => d !== '/프로젝트' && !/^\/S42-[a-z0-9]+$/.test(d))
    t.check('kim manages /프로젝트 (and only S42\'s folders besides)', !others.length, kj.folders)
    t.check('…and nothing from folders he does not manage (/재무 he only reads)', !files.some((f) => !kj.folders.some((d) => under(f, d)) || under(f, '/재무')),
      files.filter((f) => !kj.folders.some((d) => under(f, d)) || under(f, '/재무')).slice(0, 5))
    const mf = await (await fx.drive('mina')).get('/audit?view=folders')
    t.check('mina (manages nothing) sees no folder rows', mf.status === 200 && mf.json().entries.length === 0, mf.text.slice(0, 200))
    if (t.target.tdrive) {
      const v = t.target.tdrive(fx.slug, 'audit', 'verify')
      t.check('tdrive audit verify (in the team) → ok', v.code === 0, v.out + v.err)
    } else t.pending('tdrive audit verify', 'no operator access on this target (E2E_OPS)')
    if (t.target.ops) {
      const c = t.target.ops('audit', 'verify')
      t.check('console audit verify → audit chain ok', c.code === 0 && /audit chain ok/.test(c.out), c.out + c.err)
    } else t.pending('console audit verify', 'no operator access on this target (E2E_OPS)')
    if (await t.has('console', 'console audit rows for SSO and member changes (sso.issued, member.*)') && t.target.ops) {
      const log = t.target.ops('audit', 'list', '--limit', '500').out
      t.check('console audit has sso.issued', /sso\.issued/.test(log), log.slice(-400))
    }
  },
} satisfies Scenario
