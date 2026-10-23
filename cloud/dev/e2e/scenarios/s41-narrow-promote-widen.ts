// S41 (finding 1) — the A3 path in managed storage: an Editor narrows a folder, their AI promotes a /재무 draft into it
// (not widening while narrow), then they widen the folder → 409 widening; an Editor cannot confirm it (the source
// Manager/Admin approves); an Admin confirms with confirm_widening, the source side hears of it without names.
import type { Scenario } from '../lib/ctx'
import { bash, tool } from '../lib/drive'
import { share } from '../lib/share'

export default {
  id: 'S41', title: 'narrow → promote → widen: Editor gets 409 widening (cannot confirm), Admin confirms + notice', phase: 1, targets: ['local', 'aws'], needs: ['share'], uses: 'H1 MCP',
  async run(t) {
    const fx = t.fx, sd = fx.s.seeded!
    const run = Date.now().toString(36)
    const admin = await fx.drive('admin')
    const name = `S41-${run}`
    const mk = await admin.api('POST', '/folders', { name, managed: true, template: 'custom' })
    t.check(`admin makes a Restricted folder /${name}`, mk.status === 200, mk.text)
    const id = mk.json().id as number
    await admin.api('PUT', `/folders/${id}/promote`, { enabled: true })
    const add = await share(admin, { path: `/${name}`, add: [{ subject: { type: 'person', id: sd.people.sam }, role: 'editor' }, { subject: { type: 'group', id: sd.groups.재무 }, role: 'editor' }] })
    t.check('sam and the 재무 group are its Editors (readers ⊆ /재무 readers)', add.status === 200, add.text)
    const tok = await (await fx.drive('sam')).token(`e2e-s41-${run}`, { password: fx.creds('sam').password })
    await bash(t.http, fx.slug, tok, "cat '/재무/결산.md'")
    await tool(t.http, fx.slug, tok, 'write', { path: `/drafts/s41-${run}.md`, content: `from 재무 ${run}\n` })
    const pr = await tool(t.http, fx.slug, tok, 'promote', { draft: `/drafts/s41-${run}.md`, folder: `/${name}`, name: 'copy.md' })
    t.check('the promote lands (the folder is as narrow as /재무)', !pr.isError && (await (await fx.drive('sam')).stat(`/${name}/copy.md`)).status === 200, pr.text)
    t.step('sam (Editor) widens it to everyone')
    const sam = await fx.drive('sam')
    const w = await share(sam, { path: `/${name}`, general: { mode: 'team', role: 'viewer' } })
    t.check('409 widening, with how many sources the Editor cannot see', w.status === 409 && w.json().code === 'widening' || /widening/.test(w.text), w.text)
    const wc = await share(sam, { path: `/${name}`, general: { mode: 'team', role: 'viewer' }, confirm_widening: true })
    t.check('an Editor cannot confirm a widening (403, or an approval request instead)', wc.status === 403 || wc.status === 202 || /approval|pending/.test(wc.text), wc.text)
    t.check('mina still does not see the copy', (await (await fx.drive('mina')).stat(`/${name}/copy.md`)).status === 404)
    t.step('the admin confirms')
    const ac = await share(admin, { path: `/${name}`, general: { mode: 'team', role: 'viewer' }, confirm_widening: true })
    t.check('admin: confirm_widening → 200, widens: ≥ 1', ac.status === 200 && (ac.json().widens ?? 0) >= 1, ac.text)
    const audit = await admin.get('/audit?view=mine')
    t.check('audited as a share that widens', /widen/.test(audit.text), audit.text.slice(0, 300))
    const notices = await (await fx.drive('sam')).get('/notices')
    t.check('notices about it name no folder or file', !notices.text.includes('결산') && !notices.text.includes(name), notices.text.slice(0, 300))
  },
} satisfies Scenario
