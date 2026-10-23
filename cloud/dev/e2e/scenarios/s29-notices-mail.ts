// S29 — R11: notices and mails about sharing, widening and approvals carry the kind, a count and a link — never a
// file or folder name (invites may name the inviter). Checks every notice of the team's people and every mail the
// team (and, with D1, the console) sent to them.
import { FILES } from '../../seed-team'
import type { Scenario } from '../lib/ctx'
import { PEOPLE, type Who } from '../lib/fixture'
import { setRole, share } from '../lib/share'

const NAMES = ['공용', '경영', '재무', '프로젝트', '비밀', '인사', ...Object.keys(FILES).map((f) => f.slice(f.lastIndexOf('/') + 1)), 'CANARY', 's24w-', 's19-']

export default {
  id: 'S29', title: 'notices and mails (sharing, widening, approvals, invites) name no file or folder (R11)', phase: 1, targets: ['local', 'aws'], uses: 'H1',
  async run(t) {
    const fx = t.fx, sd = fx.s.seeded!
    t.step('make some: a sharing change kim (Manager) hears of')
    const admin = await fx.drive('admin')
    await setRole(t, admin, '/프로젝트', sd.folders.프로젝트!, { type: 'person', id: sd.people.mina! }, 'editor')
    await setRole(t, admin, '/프로젝트', sd.folders.프로젝트!, { type: 'person', id: sd.people.mina! }, 'remove')
    let total = 0
    for (const who of ['admin', ...PEOPLE] as Who[]) {
      const n = await (await fx.drive(who)).get('/notices')
      const list = n.status === 200 ? n.json().notices as unknown[] : []
      total += list.length
      const leak = NAMES.filter((x) => JSON.stringify(list).includes(x))
      t.check(`${who}: ${list.length} notices, no file/folder names`, n.status === 200 && !leak.length, { leak, sample: list.slice(0, 3) })
    }
    t.check('kim was told about the sharing change on his folder', total > 0)
    if (await t.has('share', 'the share notification mail ("Notify people"): kind, count, link only')) {
      const r = await share(admin, { path: '/재무', add: [{ subject: { type: 'person', id: sd.people.mina }, role: 'viewer' }], notify: true, confirm_widening: true })
      t.check('share with Notify', r.status === 200, r.text)
      // "shared with you" is an in-app notice: kind, count and a link to Shared with me (no mail, docs/SHARING-API.md)
      const n = (await (await fx.drive('mina')).get('/notices')).json().notices as { kind?: string; link?: string }[]
      const sharedN = n.find((x) => /shared/.test(x.kind ?? '') || /shared/.test(x.link ?? ''))
      t.check('mina has a "shared with you" notice with a #/shared link and no names', !!sharedN && !NAMES.some((x) => JSON.stringify(sharedN).includes(x)), n.slice(0, 3))
      await share(admin, { path: '/재무', set: [{ subject: { type: 'person', id: sd.people.mina }, role: 'remove' }], confirm_widening: true })
    }
    if (await t.has('mail', 'the mails the team sent')) {
      const mine = new Set([fx.creds('admin').email, ...PEOPLE.map((p) => fx.creds(p).email)])
      const mails = [...(t.target.teamMail?.() ?? []), ...(t.target.outbox?.() ?? [])].filter((m) => mine.has(m.to))
      for (const m of mails) {
        const leak = NAMES.filter((x) => (m.subject + m.text).includes(x))
        t.check(`mail "${m.subject}" to ${m.to}: no file/folder names`, !leak.length, { leak, text: m.text.slice(0, 300) })
      }
      t.check(`there were mails to check (${mails.length})`, mails.length > 0)
    }
  },
} satisfies Scenario
