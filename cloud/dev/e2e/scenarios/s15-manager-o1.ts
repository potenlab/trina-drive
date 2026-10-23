// S15 (O1) — kim manages /프로젝트 (not an admin): shares it (mina → Editor), may not grant Manager or turn No AI off.
// O1: an Editor shares by default (Viewer/Editor, General access) unless a Manager turns "Editors can change
// permissions and share" off; the details are S42.
import type { Scenario } from '../lib/ctx'
import { setRole, share } from '../lib/share'

export default {
  id: 'S15', title: 'Manager (not admin) shares; cannot grant Manager or turn No AI off; Editor shares (O1)', phase: 1, targets: ['local', 'aws'], uses: 'H1 H2',
  async run(t) {
    const fx = t.fx, sd = fx.s.seeded!
    const kim = await fx.drive('kim')
    const mina = { type: 'person' as const, id: sd.people.mina! }
    t.step('kim (Manager of /프로젝트) shares it')
    const g = await setRole(t, kim, '/프로젝트', sd.folders.프로젝트!, mina, 'editor')
    t.check(`kim gives mina Editor on /프로젝트 (${g.via})`, g.res.status === 200, g.res.text)
    const up = await (await fx.drive('mina')).upload('/프로젝트', `s15-${Date.now().toString(36)}.md`, 'mina writes here now\n')
    t.check('mina can now upload into /프로젝트', up.status === 200, up.text)
    t.step('what a Manager may not do')
    const mgr = g.via === 'share'
      ? await share(kim, { path: '/프로젝트', set: [{ subject: mina, role: 'manager' }] })
      : await kim.api('PUT', `/folders/${sd.folders.프로젝트}/managers/${sd.people.mina}`)
    t.check('kim cannot make mina a Manager: 403', mgr.status === 403, mgr.text)
    const noAi = await kim.api('PATCH', `/folders/${sd.folders.프로젝트}`, { no_ai: true })
    t.check('kim may turn No AI on', noAi.status === 200, noAi.text)
    const off = await kim.api('PATCH', `/folders/${sd.folders.프로젝트}`, { no_ai: false })
    t.check('…but not off again: 403 (only an admin)', off.status === 403, off.text)
    const adm = await (await fx.drive('admin')).api('PATCH', `/folders/${sd.folders.프로젝트}`, { no_ai: false })
    t.check('the admin turns it off', adm.status === 200, adm.text)
    t.step('O1: an Editor shares by default')
    if (await t.has('share', 'Editor (mina on /프로젝트) adds a Viewer through the share dialog')) {
      const r = await share(await fx.drive('mina'), { path: '/프로젝트', add: [{ subject: { type: 'group', id: sd.groups.재무 }, role: 'viewer' }] })
      t.check('mina (Editor) adds 재무 as Viewer: 200', r.status === 200, r.text)
      const m = await share(await fx.drive('mina'), { path: '/프로젝트', set: [{ subject: { type: 'person', id: sd.people.sam }, role: 'manager' }] })
      t.check('mina (Editor) cannot grant Manager: 403', m.status === 403, m.text)
      await share(kim, { path: '/프로젝트', set: [{ subject: { type: 'group', id: sd.groups.재무 }, role: 'remove' }] })
    }
    if (await t.has('browser', 'the share dialog as Manager and as Editor (UI)')) {
      const r = await (await (await import('../lib/ui')).ui()).managerDialog(t)
      if (r.pending) t.pending('the share dialog as Manager and as Editor (UI)', r.pending)
      else for (const [k, v] of Object.entries(r.checks as Record<string, boolean>)) t.check(`browser: ${k}`, v, r)
    }
    const back = await setRole(t, kim, '/프로젝트', sd.folders.프로젝트!, mina, 'remove')
    t.check('cleanup: mina back to what everyone has', back.res.status === 200, back.res.text)
  },
} satisfies Scenario
