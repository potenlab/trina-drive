// S42 (O1) — Editors share by default: add Viewers/Editors and change General access; a Manager turns "Editors can
// change permissions and share" off for a folder and everything below (off above wins); Editors never grant Manager,
// Restrict here, turn No AI off, confirm a widening or invite non-members; opening to "Anyone in the team" takes a
// passkey step-up.
// ADAPTER (A1): the toggle is sent as POST /api/share { path, editors_can_share } — plan §10.2 #8 names the column
// (folders.editors_can_share), not the field; fix here when A1 merges.
import type { Scenario } from '../lib/ctx'
import { share, shareView } from '../lib/share'

export default {
  id: 'S42', title: 'O1 matrix: Editor shares; toggle off (inherited) → 403; 5 Editor-forbidden actions; Anyone needs a passkey', phase: 1, targets: ['local', 'aws'], needs: ['share'], uses: 'H1',
  async run(t) {
    const fx = t.fx, sd = fx.s.seeded!
    const run = Date.now().toString(36)
    const admin = await fx.drive('admin')
    const name = `S42-${run}`
    const mk = await admin.api('POST', '/folders', { name, managed: true, template: 'custom' })
    const id = mk.json().id as number
    await share(admin, { path: `/${name}`, add: [{ subject: { type: 'person', id: sd.people.mina }, role: 'editor' }, { subject: { type: 'person', id: sd.people.kim }, role: 'manager' }] })
    const mina = await fx.drive('mina'), kim = await fx.drive('kim')
    await mina.mkdir(`/${name}`, 'sub')
    const v = await shareView(mina, `/${name}`)
    t.check('the Editor\'s dialog says she can share (can_manage or an editor flag)', v.status === 200 && (v.json().can_manage === true || v.json().can_share === true), v.text)
    const e1 = await share(mina, { path: `/${name}`, add: [{ subject: { type: 'person', id: sd.people.sam }, role: 'viewer' }] })
    t.check('Editor adds a Viewer → 200', e1.status === 200, e1.text)
    const e2 = await share(mina, { path: `/${name}`, set: [{ subject: { type: 'person', id: sd.people.sam }, role: 'editor' }] })
    t.check('Editor raises a Viewer to Editor → 200', e2.status === 200, e2.text)
    t.step('Editor-forbidden')
    const forbidden: [string, Record<string, unknown>][] = [
      ['grant Manager', { set: [{ subject: { type: 'person', id: sd.people.sam }, role: 'manager' }] }],
      ['Restrict here (on the subfolder)', { path: `/${name}/sub`, restrict_here: { on: true, keep: [] } }],
      ['turn AI access back on (No AI off)', { ai_access: true }],
      ['confirm a widening', { general: { mode: 'team', role: 'viewer' }, confirm_widening: true }],
      ['invite a non-member by email', { add: [{ subject: { email: `s42-${run}@outside.test` }, role: 'viewer' }] }],
      ['change the Editors-can-share toggle', { editors_can_share: false }],
    ]
    if (forbidden[2]) await share(kim, { path: `/${name}`, ai_access: false })
    for (const [what, body] of forbidden) {
      const r = await share(mina, { path: `/${name}`, ...body })
      t.check(`Editor cannot ${what} → 403`, r.status === 403, `${r.status} ${r.text.slice(0, 160)}`)
    }
    t.step('"Anyone in the team" by an Editor needs a passkey step-up')
    const any = await share(mina, { path: `/${name}`, general: { mode: 'team', role: 'viewer' } })
    t.check('without a step-up: refused with step_up / passkey required', [401, 403, 409].includes(any.status) && /step_up|passkey|reauth/.test(any.text), any.text)
    t.step('the Manager turns Editor sharing off: inherited below')
    const off = await share(kim, { path: `/${name}`, editors_can_share: false })
    t.check('kim (Manager) turns "Editors can change permissions and share" off', off.status === 200, off.text)
    const e3 = await share(mina, { path: `/${name}`, add: [{ subject: { type: 'person', id: sd.people.boss }, role: 'viewer' }] })
    t.check('now the Editor\'s share → 403', e3.status === 403, e3.text)
    const e4 = await share(mina, { path: `/${name}/sub`, add: [{ subject: { type: 'person', id: sd.people.boss }, role: 'viewer' }] })
    t.check('…also on the subfolder (inherited)', e4.status === 403, e4.text)
    const e5 = await share(kim, { path: `/${name}/sub`, editors_can_share: true })
    const e6 = await share(mina, { path: `/${name}/sub`, add: [{ subject: { type: 'person', id: sd.people.boss }, role: 'viewer' }] })
    t.check('turning it on below while off above changes nothing (off above wins)', e6.status === 403, `${e5.status} ${e6.status}`)
    void id
  },
} satisfies Scenario
