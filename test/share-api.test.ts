// The share dialog API (plan 3.7 as changed by §10; docs/SHARING-API.md): the view each role gets, adding and removing
// people and groups, General access, restrict-here keeping current levels (finding 12), what is shown to whom
// (finding 11), the Everyone group as "Anyone in Trina" (finding 13), Shared with me, the directory, audit and notices.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { shareSetup, type ShareEnv } from './share-helpers'

let e: ShareEnv
beforeEach(async () => { e = await shareSetup() })
afterEach(() => e.cleanup())

const audit = () => e.db.query<{ person_id: number; command: string }, []>("SELECT person_id, command FROM audit WHERE command LIKE 'share %' ORDER BY id").all()

describe('GET /api/share', () => {
  test('a manager sees the whole list: roles, direct / inherited, General access, toggles', async () => {
    const boss = await e.as('boss')
    const v = await e.view(boss, '/Projects')
    expect(v.status).toBe(200)
    expect(v.data).toMatchObject({ mode: 'managed', item: { path: '/Projects', kind: 'folder', name: 'Projects' }, my_role: 'manager',
      can_share: true, can_manage: true, can_grant_manager: false, can_ai_off: false, can_restrict_here: false, can_toggle_editors: true, full_list: true,
      general: { effective: { role: 'viewer', from_path: '/Projects' }, own: 'viewer', restricted_here: false, editor_step_up: false },
      editors_can_share: { effective: true, own: null, off_above: false }, ai: { no_ai: false }, path_names_visible: true })
    const roles = Object.fromEntries(v.data.entries.map((x: { subject: { name: string }; role: string }) => [x.subject.name, x.role]))
    expect(roles).toEqual({ boss: 'manager', kim: 'editor' })
    // the Everyone group is General access, never an entry; addresses are for the admin only (finding 11)
    expect(v.data.entries.some((x: { subject: { email?: string } }) => 'email' in x.subject)).toBe(false)
    const sub = await e.view(boss, '/Projects/비밀')
    expect(sub.data.entries.every((x: { source: string; from_path: string }) => x.source === 'inherited' && x.from_path === '/Projects')).toBe(true)
    expect(sub.data.can_restrict_here).toBe(true)
    const admin = await e.view(await e.as('dion'), '/Projects')
    expect(admin.data).toMatchObject({ my_role: 'viewer', can_grant_manager: true, can_ai_off: true, can_manage: true }) // dion reads it as everyone does
    expect(admin.data.entries.find((x: { subject: { name: string } }) => x.subject.name === 'kim').subject.email).toBe('kim@example.com')
  })

  test('hidden == nonexistent: a folder you cannot see answers byte for byte like one that does not exist', async () => {
    const kim = await e.as('kim')
    const hidden = await kim.raw('GET', '/api/share?path=' + encodeURIComponent('/재무'))
    const none = await kim.raw('GET', '/api/share?path=' + encodeURIComponent('/없는폴더'))
    const deep = await kim.raw('GET', '/api/share?path=' + encodeURIComponent('/재무/결산.md'))
    expect(hidden.status).toBe(404)
    const body = await none.text()
    expect(await hidden.text()).toBe(body)
    expect(await deep.text()).toBe(body)
    expect([...hidden.headers.entries()].filter(([k]) => k !== 'date')).toEqual([...none.headers.entries()].filter(([k]) => k !== 'date'))
    // POST too
    const p1 = await e.share(kim, { path: '/재무', add: [{ subject: e.person('lee'), role: 'viewer' }] })
    const p2 = await e.share(kim, { path: '/없는폴더', add: [{ subject: e.person('lee'), role: 'viewer' }] })
    expect([p1.status, p1.data]).toEqual([p2.status, p2.data])
    // a visible file: folders only in this version
    expect((await e.view(kim, '/Projects/readme.md')).data.error).toBe('folders_only')
  })

  test('a viewer sees the list of a folder they open; a bare-path visitor only their own entry (finding 11)', async () => {
    const lee = await e.as('lee')
    const v = await e.view(lee, '/Projects')
    expect(v.data).toMatchObject({ my_role: 'viewer', can_share: false, full_list: true })
    // lee gets /Projects/비밀/x only: /Projects/비밀 restricted, lee kept there as a person
    const boss = await e.as('boss')
    expect((await e.share(boss, { path: '/Projects/비밀', restrict_here: { on: true, keep: [] } })).status).toBe(200)
    expect((await e.share(boss, { path: '/Projects', general: { mode: 'restricted' } })).status).toBe(200)
    expect((await e.share(boss, { path: '/Projects/비밀', add: [{ subject: e.person('lee'), role: 'viewer' }] })).status).toBe(200)
    const bare = await e.view(lee, '/Projects')
    expect(bare.status).toBe(200)
    expect(bare.data).toMatchObject({ my_role: null, can_share: false, full_list: false, entries: [] })
    expect((await e.view(lee, '/Projects/비밀')).data.entries.map((x: { subject: { name: string } }) => x.subject.name)).toContain('lee')
  })
})

describe('POST /api/share', () => {
  test('a manager adds a person and a group, changes and removes them; audited, the new reader is told without names (O7)', async () => {
    const boss = await e.as('boss')
    const before = e.mailer.read().length
    const r = await e.share(boss, { path: '/Projects/비밀', add: [{ subject: e.group('재무'), role: 'editor' }] })
    expect(r.status).toBe(200)
    expect(r.data.entries.find((x: { subject: { name: string } }) => x.subject.name === '재무')).toMatchObject({ role: 'editor', source: 'direct', editable: true })
    expect(r.data.widens).toBe(0)
    expect(audit().at(-1)).toEqual({ person_id: e.pid('boss'), command: `share /Projects/비밀: @group:${e.gid('재무')} none→editor` })
    // park (재무) was already a viewer of /Projects (everyone) → not "newly shared"; nobody new: no shared notice
    expect(e.mailer.read().slice(before).filter((m) => /shared with you/.test(m.subject))).toEqual([])
    // restrict 비밀 to nobody but 재무 (kept) → then lee is added and is told
    expect((await e.share(boss, { path: '/Projects/비밀', restrict_here: { on: true, keep: [] } })).status).toBe(200)
    const n0 = e.mailer.read().length
    expect((await e.share(boss, { path: '/Projects/비밀', add: [{ subject: e.person('lee'), role: 'viewer' }] })).status).toBe(200)
    const mails = e.mailer.read().slice(n0).filter((m) => /shared with you/.test(m.subject))
    expect(mails.map((m) => m.to)).toEqual(['lee@example.com'])
    for (const m of mails) { expect(m.text).not.toContain('비밀'); expect(m.text).not.toContain('Projects'); expect(m.text).toContain('/#/shared') }
    expect(e.db.query<{ kind: string; link: string }, [number]>("SELECT kind, link FROM notices WHERE person_id = ? AND kind = 'shared'").all(e.pid('lee'))).toEqual([{ kind: 'shared', link: '/#/shared' }])
    // change, then remove
    expect((await e.share(boss, { path: '/Projects/비밀', set: [{ subject: e.person('lee'), role: 'editor' }] })).data.entries
      .find((x: { subject: { name: string } }) => x.subject.name === 'lee').role).toBe('editor')
    const rm = await e.share(boss, { path: '/Projects/비밀', set: [{ subject: e.person('lee'), role: 'remove' }] })
    expect(rm.data.entries.some((x: { subject: { name: string } }) => x.subject.name === 'lee')).toBe(false)
    expect(audit().at(-1)!.command).toBe(`share /Projects/비밀: person:${e.pid('lee')} editor→none`)
    // the notify switch
    const n1 = e.mailer.read().length
    await e.share(boss, { path: '/Projects/비밀', add: [{ subject: e.person('lee'), role: 'viewer' }], notify: false })
    expect(e.mailer.read().slice(n1).filter((m) => /shared with you/.test(m.subject))).toEqual([])
  })

  test('inherited entries cannot be lowered or removed here; General access from above needs restrict-here', async () => {
    const boss = await e.as('boss')
    const lower = await e.share(boss, { path: '/Projects/비밀', set: [{ subject: e.person('kim'), role: 'viewer' }] })
    expect([lower.status, lower.data.error]).toEqual([400, 'inherited'])
    const rm = await e.share(boss, { path: '/Projects/비밀', set: [{ subject: e.person('kim'), role: 'remove' }] })
    expect([rm.status, rm.data.error]).toEqual([400, 'inherited'])
    const g = await e.share(boss, { path: '/Projects/비밀', general: { mode: 'restricted' } })
    expect([g.status, g.data.error]).toEqual([400, 'inherited_general'])
    expect((await e.share(boss, { path: '/Projects/비밀', add: [{ subject: e.group('재무'), role: 'manager' }] })).data.error).toBe('group_manager')
  })

  test('General access: Anyone in Trina ↔ Restricted is the Everyone group\'s rule', async () => {
    const boss = await e.as('boss')
    const r = await e.share(boss, { path: '/Projects', general: { mode: 'team', role: 'editor' } })
    expect(r.data.general).toMatchObject({ own: 'editor', effective: { role: 'editor' } })
    expect(audit().at(-1)!.command).toBe('share /Projects: general team:editor')
    const lee = await e.as('lee')
    expect((await e.upload(lee, '/Projects', 'lee.txt', 'hi')).status).toBe(200)
    const res = await e.share(boss, { path: '/Projects', general: { mode: 'restricted' } })
    expect(res.data.general).toMatchObject({ own: null, effective: null })
    expect((await lee.call('GET', '/api/files?path=' + encodeURIComponent('/Projects'))).status).toBe(404)
  })

  test('restrict access here keeps current levels: kept entries and upper managers, never raised (finding 12)', async () => {
    const boss = await e.as('boss')
    const dion = await e.as('dion')
    // lee manages Projects without any rule of their own: today a viewer through Anyone in Trina
    expect((await dion.call('PUT', `/api/folders/${e.proj.id}/managers/${e.pid('lee')}`)).status).toBe(200)
    const r = await e.share(boss, { path: '/Projects/비밀', restrict_here: { on: true, keep: [e.person('kim')] } })
    expect(r.status).toBe(200)
    expect(r.data.general).toMatchObject({ restricted_here: true, effective: null })
    const roles = Object.fromEntries(r.data.entries.map((x: { subject: { name: string }; role: string; note?: string; source: string }) => [x.subject.name, [x.role, x.note ?? null, x.source]]))
    // kim kept as editor (their level), boss and lee keep managing: boss at write, lee at read (copied, not raised)
    expect(roles).toEqual({ kim: ['editor', null, 'direct'], boss: ['manager', null, 'inherited'], lee: ['manager', 'viewer', 'inherited'] })
    const rule = (name: string) => e.db.query<{ level: number }, [number, number]>("SELECT level FROM rules WHERE folder_id = ? AND subject_type = 'person' AND subject_id = ?").get(r.data.item.id, e.pid(name))?.level
    expect([rule('kim'), rule('boss'), rule('lee')]).toEqual([2, 2, 1])
    expect(audit().at(-1)!.command).toBe('share /Projects/비밀: restrict-here keep=1 drop=1')
    // park (only through Anyone in Trina) is out at once: web, search, agent
    const park = await e.as('park')
    expect((await park.call('GET', '/api/files?path=' + encodeURIComponent('/Projects/비밀'))).status).toBe(404)
    expect(await e.agent('park', 'cat /Projects/비밀/plan.md; ls /Projects')).not.toContain('CANARY-SEC')
    expect(await e.agent('park', 'ls /Projects')).not.toContain('비밀')
    expect(e.db.query<{ field: string; new_value: string }, [number]>("SELECT field, new_value FROM folder_history WHERE folder_id = ? AND field = 'inherit_break'").all(r.data.item.id)).toEqual([{ field: 'inherit_break', new_value: '1' }])
  })
})

describe('Shared with me and the directory', () => {
  test('folders given to me or my groups (not Everyone), that I can open now, newest first; revoked → gone at once', async () => {
    const boss = await e.as('boss')
    const lee = await e.as('lee')
    const base = await e.sharedWithMe(lee)
    expect(base).toEqual(['/인사', '/인사관리']) // lee's group 인사; Projects reaches lee only through Anyone in Trina
    await e.share(boss, { path: '/Projects/비밀', restrict_here: { on: true, keep: [] } })
    await e.share(boss, { path: '/Projects/비밀', add: [{ subject: e.person('lee'), role: 'viewer' }] })
    const items = (await lee.call('GET', '/api/shared-with-me')).data.items
    expect(items.slice(0, 1)).toEqual([{ path: '/Projects/비밀', kind: 'folder', name: '비밀', role: 'viewer', shared_by: { id: e.pid('boss'), name: 'boss' }, shared_at: expect.any(Number) }])
    // the 재무 group's folder for park (seeded by the CLI: no "shared by")
    expect((await (await e.as('park')).call('GET', '/api/shared-with-me')).data.items).toContainEqual(
      { path: '/재무', kind: 'folder', name: '재무', role: 'viewer', shared_by: null, shared_at: null })
    await e.share(boss, { path: '/Projects/비밀', set: [{ subject: e.person('lee'), role: 'remove' }] })
    expect(await e.sharedWithMe(lee)).toEqual(base)
    // a folder closed to people (quarantine) is not listed either
    e.db.query('UPDATE folders SET quarantine = 1 WHERE id = ?').run(e.fin.id)
    expect(await e.sharedWithMe(await e.as('park'))).toEqual(['/영업'])
  })

  test('the directory: names for everyone, addresses for the admin only; Everyone is "Anyone in Trina"', async () => {
    const kim = await e.as('kim')
    const d = (await kim.call('GET', '/api/directory')).data
    expect(d.people.map((p: { name: string }) => p.name)).toEqual(['boss', 'dion', 'kim', 'lee', 'park'])
    expect(d.people.some((p: object) => 'email' in p)).toBe(false)
    expect(d.groups.find((g: { everyone?: boolean }) => g.everyone)).toEqual({ id: e.gid('전체'), name: 'Anyone in Trina', size: 5, everyone: true })
    const admin = (await (await e.as('dion')).call('GET', '/api/directory')).data
    expect(admin.people.find((p: { name: string }) => p.name === 'kim').email).toBe('kim@example.com')
  })

  test('me carries the share field; the folder page\'s rule route records who gave the rule', async () => {
    const boss = await e.as('boss')
    expect((await boss.call('GET', '/api/session')).data.me.share).toEqual({ api: 1, can_invite: false })
    expect((await boss.call('PUT', `/api/folders/${e.proj.id}/rules`, { subject_type: 'person', subject_id: e.pid('park'), level: 'write' })).status).toBe(200)
    expect(e.db.query<{ granted_by: number }, [number, number]>("SELECT granted_by FROM rules WHERE folder_id = ? AND subject_type = 'person' AND subject_id = ?").get(e.proj.id, e.pid('park'))!.granted_by).toBe(e.pid('boss'))
  })
})
