// File-level sharing (workstream A2; memo a2-file-sharing-design.md §11.2): one test per invariant I1–I15 where a unit
// test can show it, the O1 table for files, General access, the 200-grant limit, R4 via-file drafts, S13 end to end.
import fs from 'node:fs'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { managedIdle, purgeExpired, rescan } from '../src/managed/ops'
import { Access } from '../src/policy'
import { addGroup, addMember, createToken, setRule } from '../src/store'
import { splitVirtual } from '../src/names'
import { setPromote } from '../src/promote'
import { fileShareSetup, Q3, SIB, type FileShareEnv } from './file-grants-helpers'

let e: FileShareEnv
beforeEach(async () => { e = await fileShareSetup() })
afterEach(() => e.cleanup())

const NOT_FOUND = async (b: FileShareEnv['boss'], p: string) => {
  const hid = await b.call('GET', '/api/files/download?path=' + encodeURIComponent(p))
  const none = await b.call('GET', '/api/files/download?path=' + encodeURIComponent('/재무팀/결산/없는파일.md'))
  expect(hid.status).toBe(404)
  expect(JSON.stringify(hid.data)).toBe(JSON.stringify(none.data))
}
const shareAudit = () => e.db.query<{ command: string }, []>("SELECT command FROM audit WHERE command LIKE 'share %(file)%' ORDER BY id").all().map((r) => r.command)

describe('S13: a file shared as Viewer', () => {
  test('Shared with me, bare paths with names only, no siblings, download, AI cat with provenance, promote needs approval', async () => {
    expect((await e.give(e.boss, Q3, 'kim')).status).toBe(200)
    const kim = await e.as('kim')
    // Shared with me
    const sw = (await kim.call('GET', '/api/shared-with-me')).data.items
    expect(sw).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'file', path: Q3, role: 'viewer', shared_by: { id: e.pid('boss'), name: 'boss' } })]))
    // bare paths: the folder names only (I2)
    const root = await e.list(kim, '/재무팀')
    expect(root.data.entries.map((x: { name: string }) => x.name)).toEqual(['결산'])
    expect(root.data.entries[0]).toMatchObject({ kind: 'folder', readable: false, writable: false, size: null, mtime: null })
    expect(root.data).toMatchObject({ readable: false, writable: false })
    expect(await e.ls(kim, '/재무팀/결산')).toEqual(['2026-Q3.md'])
    // the file: download / text; siblings: 404 exactly like a path that does not exist (I3)
    const d = await e.dl(kim, Q3)
    expect(d.status).toBe(200)
    expect(d.body).toContain('CANARY-Q3-7781')
    expect((await e.text(kim, Q3)).data.text).toContain('CANARY-Q3-7781')
    await NOT_FOUND(kim, SIB)
    await NOT_FOUND(kim, '/재무팀/top.md')
    expect((await kim.call('GET', '/api/files/who?path=' + encodeURIComponent(Q3))).data).toMatchObject({ restricted: true })
    // search: the file and the bare folder names, never a sibling's canary (I13)
    const hits = await e.search(kim, 'CANARY')
    expect(hits).toContain(Q3)
    expect(hits.some((p: string) => p.includes('sibling') || p.includes('top.md'))).toBe(false)
    // versions: current only for a file-only Viewer (F7)
    const v = await kim.call('GET', '/api/files/versions?path=' + encodeURIComponent(Q3))
    expect(v.data).toMatchObject({ writable: false, history: 'editors_only' })
    // the AI: cat works, siblings stay hidden, ls shows names only
    const out = await e.agent('kim', `cat ${Q3}; ls -R /재무팀; find /재무팀; du -a /재무팀; grep -r CANARY /재무팀`)
    expect(out).toContain('CANARY-Q3-7781')
    expect(out).not.toContain('CANARY-SIB-1180')
    expect(out).not.toContain('sibling')
    expect(out).not.toContain('top.md')
    expect(out).not.toContain('CANARY-TOP')
    // a hidden sibling answers like a name that is not there
    expect((await e.agent('kim', `cat ${SIB}`)).replace('sibling.md', 'X')).toBe((await e.agent('kim', 'cat /재무팀/결산/nothere.md')).replace('nothere.md', 'X'))
    // R3 (the touchFile fix): the read records /재무팀/결산 as a strong source, via_file
    const t = e.db.query<{ folder_id: number; strong_at: number | null; via_file: number }, []>('SELECT folder_id, strong_at, via_file FROM touches WHERE token_id = (SELECT id FROM tokens WHERE name = \'kim-agent\')').all()
    const finFolder = e.db.query<{ id: number }, [string]>('SELECT id FROM folders WHERE path = ?').get(e.real('/재무팀/결산'))!.id
    expect(t.find((x) => x.folder_id === finFolder)).toMatchObject({ via_file: 1 })
    expect(t.find((x) => x.folder_id === finFolder)!.strong_at).not.toBeNull()
    // a draft from it: its source is the folder (via_file), the AI sees its own draft (R4 via-file rule)
    const r = await e.promoteFrom('kim', Q3, '/Projects', 'summary.md', '# summary\n')
    expect(r.status).toBe('input_required') // W3: widening — Projects' readers do not all read /재무팀/결산 (asks for a reason, then approval)
    const src = e.db.query<{ folder_id: number; via_file: number }, []>("SELECT s.folder_id, s.via_file FROM draft_src s JOIN drafts d ON d.id = s.draft_id WHERE d.path = 'summary.md'").all()
    expect(src).toEqual([{ folder_id: finFolder, via_file: 1 }])
    expect(await e.agent('kim', 'ls /drafts')).toContain('summary.md')
  })

  test('I5 revocation is immediate on every path; the via-file draft is sealed again (R4)', async () => {
    await e.give(e.boss, Q3, 'kim')
    const kim = await e.as('kim')
    expect((await e.tool('kim-ai', 'read', { path: Q3 })).isError).toBeFalsy()
    expect((await e.tool('kim-ai', 'write', { path: '/drafts/s.md', content: 'x' })).isError).toBeFalsy()
    expect(await e.agent('kim', 'ls /drafts')).toContain('s.md')
    expect((await e.shareFile(e.boss, Q3, { set: [{ subject: e.person('kim'), role: 'remove' }] })).status).toBe(200)
    expect((await kim.call('GET', '/api/files?path=' + encodeURIComponent('/재무팀'))).status).toBe(404)
    await NOT_FOUND(kim, Q3)
    expect(await e.search(kim, 'CANARY-Q3')).toEqual([])
    expect((await kim.call('GET', '/api/shared-with-me')).data.items.some((x: { path: string }) => x.path === Q3)).toBe(false)
    expect(await e.agent('kim', `cat ${Q3}`)).not.toContain('CANARY-Q3')
    const out = await e.agent('kim', 'ls /; ls /drafts')
    expect(out).not.toContain('재무팀')
    expect(out).not.toContain('s.md')
    expect((await kim.call('GET', '/api/recent')).data.items.some((x: { path: string }) => x.path === Q3)).toBe(false)
  })

  test('R4: a via-file draft stays visible while another share in the folder remains; a direct revoked source is not revived', async () => {
    await e.give(e.boss, Q3, 'kim')
    await e.give(e.boss, SIB, 'kim')
    await e.tool('kim-ai', 'read', { path: Q3 })
    await e.tool('kim-ai', 'write', { path: '/drafts/a.md', content: 'a' })
    await e.shareFile(e.boss, Q3, { set: [{ subject: e.person('kim'), role: 'remove' }] })
    expect(await e.agent('kim', 'ls /drafts')).toContain('a.md') // known over-retention: SIB is still shared in the folder
    await e.shareFile(e.boss, SIB, { set: [{ subject: e.person('kim'), role: 'remove' }] })
    expect(await e.agent('kim', 'ls /drafts')).not.toContain('a.md')
    // direct: lee reads /재무팀 by rule, drafts from it, loses the rule; a later file share in it does not reopen the draft
    setRule(e.db, e.team.path, 'lee', 'read')
    await e.tool('lee-ai', 'read', { path: '/재무팀/결산/sibling.md' })
    await e.tool('lee-ai', 'write', { path: '/drafts/b.md', content: 'b' })
    expect(await e.agent('lee', 'ls /drafts')).toContain('b.md')
    setRule(e.db, e.team.path, 'lee', 'none')
    expect(await e.agent('lee', 'ls /drafts')).not.toContain('b.md')
    await e.give(e.boss, Q3, 'lee')
    expect(await e.agent('lee', 'ls /drafts')).not.toContain('b.md')
  })
})

describe('I6 lifecycle', () => {
  test('rename, move within team folders, new version, restore version and trash→restore keep the share; copy has none', async () => {
    await e.give(e.boss, Q3, 'kim')
    const kim = await e.as('kim')
    const uid = e.uidOf(e.real(Q3))
    const can = async (p: string) => (await e.dl(kim, p)).status
    expect((await e.boss.call('POST', '/api/files/rename', { path: Q3, name: 'Q3-final.md' })).status).toBe(200)
    expect(await can('/재무팀/결산/Q3-final.md')).toBe(200)
    expect((await e.boss.call('POST', '/api/files/folder', { path: '/재무팀', name: '보관' })).status).toBe(200)
    const mv = await e.boss.call('POST', '/api/files/move', { paths: ['/재무팀/결산/Q3-final.md'], to: '/재무팀/보관' })
    expect(mv.data.results[0]).toMatchObject({ to: '/재무팀/보관/Q3-final.md', shared_with: 1 })
    expect(await can('/재무팀/보관/Q3-final.md')).toBe(200)
    expect(await e.ls(kim, '/재무팀')).toEqual(['보관']) // the old folder is no longer a path to anything
    // a folder rename / move: rows follow, the share with them
    expect((await e.boss.call('POST', '/api/files/rename', { path: '/재무팀/보관', name: '아카이브' })).status).toBe(200)
    expect(await can('/재무팀/아카이브/Q3-final.md')).toBe(200)
    // new version by the folder's editor: same uid, still shared
    expect((await e.upload(e.boss, '/재무팀/아카이브', 'Q3-final.md', 'v2 CANARY-Q3-V2', 'replace')).status).toBe(200)
    expect((await e.dl(kim, '/재무팀/아카이브/Q3-final.md')).body).toContain('CANARY-Q3-V2')
    expect((await e.boss.call('POST', '/api/files/versions/restore', { path: '/재무팀/아카이브/Q3-final.md', version: 1 })).status).toBe(200)
    expect((await e.dl(kim, '/재무팀/아카이브/Q3-final.md')).body).toContain('CANARY-Q3-7781')
    expect(e.uidOf(e.real('/재무팀/아카이브/Q3-final.md'))).toBe(uid)
    // trash: gone for the grantee (inert location), restore brings it back
    const del = await e.boss.call('POST', '/api/files/delete', { paths: ['/재무팀/아카이브/Q3-final.md'] })
    expect(await can('/재무팀/아카이브/Q3-final.md')).toBe(404)
    expect(await e.ls(kim, '/')).not.toContain('재무팀')
    expect((await kim.call('GET', '/api/trash')).data.items).toEqual([])
    expect((await e.boss.call('POST', `/api/trash/${del.data.results[0].trash_id}/restore`)).status).toBe(200)
    expect(await can('/재무팀/아카이브/Q3-final.md')).toBe(200)
    // copy: a new file, not shared
    expect((await e.boss.call('POST', '/api/files/copy', { paths: ['/재무팀/아카이브/Q3-final.md'], to: '/재무팀' })).status).toBe(200)
    expect(await can('/재무팀/Q3-final.md')).toBe(404)
    expect(e.grantRows().length).toBe(1)
    // purge: 0 grant rows for that uid (I6, I12)
    const del2 = await e.boss.call('POST', '/api/files/delete', { paths: ['/재무팀/아카이브/Q3-final.md'] })
    expect((await e.boss.call('DELETE', `/api/trash/${del2.data.results[0].trash_id}`)).status).toBe(200)
    expect(e.grantRows().filter((g) => g.file_uid === uid)).toEqual([])
  })

  test('moving a shared file or folder into a personal folder removes its shares (and moving back does not reshare)', async () => {
    // kim: Editor on Projects, owner of 내폴더; shares Projects/readme.md with lee; then moves it into 내폴더
    const kim = await e.as('kim')
    setRule(e.db, e.proj.path, '@전체', 'none')
    expect((await e.give(kim, '/Projects/readme.md', 'lee')).status).toBe(200)
    const lee = await e.as('lee')
    expect((await e.dl(lee, '/Projects/readme.md')).status).toBe(200)
    const mv = await kim.call('POST', '/api/files/move', { paths: ['/Projects/readme.md'], to: '/내폴더' })
    expect(mv.data.results[0]).toMatchObject({ unshared: 1 })
    expect(e.grantRows()).toEqual([])
    expect((await kim.call('POST', '/api/files/move', { paths: ['/내폴더/readme.md'], to: '/Projects' })).status).toBe(200)
    expect((await e.dl(lee, '/Projects/readme.md')).status).toBe(404)
    expect(e.db.query("SELECT command FROM audit WHERE command LIKE 'files move%unshared: 1%'").get()).toBeTruthy()
  })
})

describe('I7 / I4 / I12: identity, never the location or the row id', () => {
  test('a file replaced by hand, or a stale location, opens nothing; rescan drops the row and its grants', async () => {
    await e.give(e.boss, Q3, 'kim')
    const kim = await e.as('kim')
    // the location points at sibling.md: it still opens only Q3's identity (I7)
    e.db.run("UPDATE mfiles SET name = 'sibling.md' WHERE folder_id IS NOT NULL")
    await NOT_FOUND(kim, SIB)
    // a stale location is closed, not wrong: no bare path leads to the file until the location is put right
    await NOT_FOUND(kim, Q3)
    expect(await e.ls(kim, '/')).not.toContain('재무팀')
    // relocate puts it right
    expect(rescan(e.ctx)).toMatchObject({ relocated: 1 })
    expect(await e.ls(kim, '/재무팀/결산')).toEqual(['2026-Q3.md'])
    // the bytes changed by hand: size/mtime differ from the row → closed; rescan drops the row and the grant (fail closed)
    fs.writeFileSync(e.real(Q3), 'changed by hand CANARY-HAND')
    await NOT_FOUND(kim, Q3)
    const before = e.grantRows().length
    expect(before).toBe(1)
    rescan(e.ctx)
    expect(e.grantRows()).toEqual([])
  })

  test('group id reuse: a group deleted and another made with the same id gets nothing (groups.uid)', async () => {
    addGroup(e.db, '감사'); addMember(e.db, '감사', 'lee')
    const g = e.gid('감사')
    expect((await e.shareFile(e.boss, Q3, { add: [{ subject: { type: 'group', id: g }, role: 'viewer' }] })).status).toBe(200)
    const lee = await e.as('lee')
    expect((await e.dl(lee, Q3)).status).toBe(200)
    // an older image deletes the group (it knows nothing of file grants), another group takes the same id
    e.db.query('DELETE FROM memberships WHERE group_id = ?').run(g)
    e.db.query('DELETE FROM groups WHERE id = ?').run(g)
    e.db.query('INSERT INTO groups (id, name) VALUES (?, ?)').run(g, '새그룹')
    addMember(e.db, '새그룹', 'lee'); addMember(e.db, '새그룹', 'park')
    expect((await e.dl(lee, Q3)).status).toBe(404)
    expect((await e.dl(await e.as('park'), Q3)).status).toBe(404)
  })

  test('rowid and inode reuse: an orphan grant row never attaches to another file; deletes never fail with grants (no FK)', async () => {
    await e.give(e.boss, Q3, 'kim')
    const uid = e.uidOf(e.real(Q3))!
    // an older image's dropRow: the row goes, the grant stays (orphan)
    e.db.query('DELETE FROM mfiles WHERE uid = ?').run(uid)
    // a new file takes the freed rowid, and even the old file's dev/ino (simulated inode reuse) — it gets a new uid
    expect((await e.upload(e.boss, '/재무팀/결산', 'new.md', 'NEW CANARY-NEW')).status).toBe(200)
    const kim = await e.as('kim')
    expect((await e.dl(kim, '/재무팀/결산/new.md')).status).toBe(404)
    expect((await e.dl(kim, Q3)).status).toBe(404)
    // deleting, purging, emptying the trash, expiry and rescan all succeed with grants present
    await e.give(e.boss, SIB, 'kim')
    const del = await e.boss.call('POST', '/api/files/delete', { paths: [SIB] })
    expect(del.status).toBe(200)
    expect(purgeExpired(e.ctx, Date.now() + 365 * 86400_000)).toBe(1)
    expect(rescan(e.ctx).dropped).toBeGreaterThanOrEqual(0)
    expect(e.grantRows().filter((g) => g.file_uid !== uid)).toEqual([])
  })
})

describe('I10 file Editors', () => {
  test('new version and restore-version of that file only; everything else in the folder is 403 and changes nothing', async () => {
    expect((await e.give(e.boss, Q3, 'kim', 'editor')).status).toBe(200)
    const kim = await e.as('kim')
    expect((await e.upload(kim, '/재무팀/결산', '2026-Q3.md', 'kim v2 CANARY-KIM-V2', 'replace')).status).toBe(200)
    expect((await e.dl(kim, Q3)).body).toContain('CANARY-KIM-V2')
    const v = await kim.call('GET', '/api/files/versions?path=' + encodeURIComponent(Q3))
    expect(v.data).toMatchObject({ writable: true, history: 'all' })
    expect(v.data.versions.length).toBe(2)
    expect((await kim.call('POST', '/api/files/versions/restore', { path: Q3, version: 1 })).status).toBe(200)
    // chunked upload start for a replace is accepted, a new name is not
    expect((await kim.call('POST', '/api/uploads', { path: '/재무팀/결산', name: '2026-Q3.md', size: 3, conflict: 'replace' })).status).toBe(200)
    const listing = () => fs.readdirSync(e.real('/재무팀/결산')).sort()
    const before = listing()
    const refused = [
      await kim.call('POST', '/api/uploads', { path: '/재무팀/결산', name: 'new.md', size: 3 }),
      await e.upload(kim, '/재무팀/결산', 'new.md', 'x'),
      await e.upload(kim, '/재무팀/결산', 'sibling-hidden-name.md', 'x', 'replace'),
      await kim.call('POST', '/api/files/rename', { path: Q3, name: 'x.md' }),
      await kim.call('POST', '/api/files/delete', { paths: [Q3] }),
      await kim.call('POST', '/api/files/folder', { path: '/재무팀/결산', name: 'sub' }),
      await kim.call('POST', '/api/files/move', { paths: [Q3], to: '/Projects' }),
    ]
    for (const r of refused) expect(JSON.stringify(r.data)).toMatch(/no_write|403/)
    expect(listing()).toEqual(before)
    // a file-only Viewer cannot restore or upload a version
    await e.give(e.boss, SIB, 'lee')
    const lee = await e.as('lee')
    expect((await lee.call('POST', '/api/files/versions/restore', { path: SIB, version: 1 })).status).toBe(403)
    expect((await e.upload(lee, '/재무팀/결산', 'sibling.md', 'x', 'replace')).status).toBe(403)
  })
})

describe('I11: no file sharing in-place or in personal folders', () => {
  test('the API refuses; forged rows have no effect', async () => {
    const kim = await e.as('kim')
    expect((await e.upload(kim, '/내폴더', 'mine.md', 'MINE CANARY-MINE')).status).toBe(200)
    expect((await e.view(kim, '/내폴더/mine.md')).data).toMatchObject({ mode: 'personal' })
    const r = await e.give(kim, '/내폴더/mine.md', 'lee')
    expect(r.status).toBe(409)
    expect(r.data.error).toBe('personal')
    // a row forged into the database for a personal file gives nothing
    const uid = e.uidOf(e.real('/재무팀/결산/2026-Q3.md'))
    const st = fs.lstatSync(fs.readdirSync(e.mine.path).map((n) => `${e.mine.path}/${n}`).find((p) => p.endsWith('mine.md'))!, { bigint: true })
    const mu = e.db.query<{ uid: string }, [string, string]>('SELECT uid FROM mfiles WHERE dev = ? AND ino = ?').get(String(st.dev), String(st.ino))!.uid
    e.db.query("INSERT INTO file_grants (file_uid, subject_type, subject_id, level, granted_at) VALUES (?, 'person', ?, 2, 0)").run(mu, e.pid('lee'))
    expect(uid).not.toBe(mu)
    const lee = await e.as('lee')
    expect((await e.dl(lee, '/내폴더/mine.md')).status).toBe(404)
    expect(await e.ls(lee, '/')).not.toContain('내폴더')
  })
})

describe('O1 for files (memo §5)', () => {
  test('Viewers cannot share; Editors can (Viewer/Editor), not invite, not confirm; the toggle off stops them', async () => {
    // lee: file Viewer → 403 not_manager; kim: file Editor → may add Viewer, remove it
    await e.give(e.boss, Q3, 'lee')
    await e.give(e.boss, Q3, 'kim', 'editor')
    const lee = await e.as('lee'), kim = await e.as('kim')
    expect((await e.give(lee, Q3, 'park')).data.error).toBe('not_manager')
    expect((await e.view(lee, Q3)).data).toMatchObject({ my_role: 'viewer', can_manage: false, entries: [], general: null })
    const kv = await e.view(kim, Q3)
    expect(kv.data).toMatchObject({ my_role: 'editor', can_manage: true, manage_as: 'editor', inherited: 'hidden', can_confirm_widening: false, path_names_visible: '/재무팀/결산' })
    expect(kv.data.entries.every((x: { source: string }) => x.source === 'direct')).toBe(true)
    expect((await e.give(kim, Q3, 'park', 'editor')).status).toBe(200)
    expect((await e.shareFile(kim, Q3, { set: [{ subject: e.person('park'), role: 'remove' }] })).status).toBe(200)
    expect((await e.shareFile(kim, Q3, { add: [{ subject: { email: 'new@x.com' }, role: 'viewer' }] })).data.error).toBe('invite_admin_only')
    expect((await e.shareFile(kim, Q3, { add: [{ subject: e.person('park'), role: 'manager' }] })).data.error).toBe('not_for_files')
    expect((await e.shareFile(e.boss, Q3, { restrict_here: { on: true } })).data.error).toBe('not_for_files')
    // General access: an Editor needs a step-up to open the file to the team
    expect((await e.shareFile(kim, Q3, { general: { mode: 'team', role: 'viewer' } })).data.error).toBe('step_up_required')
    // the manager turns "Editors can share" off on the folder: kim's file Editor role no longer shares
    e.db.query('UPDATE folders SET editors_can_share = 0 WHERE id = ?').run(e.team.id)
    expect((await e.give(kim, Q3, 'park')).data.error).toBe('editors_cannot_share')
    // anyone may leave
    expect((await e.shareFile(lee, Q3, { leave: true })).status).toBe(200)
    expect((await e.dl(lee, Q3)).status).toBe(404)
    expect(shareAudit()).toEqual(expect.arrayContaining([expect.stringContaining('(file) leave')]))
  })

  test('manager view: direct and inherited entries, General access inherited vs own, the 200-grant limit, audit per change', async () => {
    await e.give(e.boss, Q3, 'kim')
    const v = await e.view(e.boss, Q3)
    expect(v.data).toMatchObject({ mode: 'managed', item: { path: Q3, kind: 'file', name: '2026-Q3.md' }, my_role: 'manager', can_manage: true, manage_as: 'manager',
      can_confirm_widening: true, inherited: 'shown', general: { effective: null, own: null, can_restrict: true } })
    const byName = Object.fromEntries(v.data.entries.map((x: { subject: { name: string }; source: string; role: string }) => [x.subject.name, `${x.role}/${x.source}`]))
    expect(byName).toEqual({ kim: 'viewer/direct', boss: 'manager/inherited' })
    // General access on the file: own grant to Everyone
    expect((await e.shareFile(e.boss, Q3, { general: { mode: 'team', role: 'viewer' } })).status).toBe(200)
    expect((await e.dl(await e.as('park'), Q3)).status).toBe(200)
    expect((await e.view(e.boss, Q3)).data.general).toMatchObject({ effective: { role: 'viewer', from_path: Q3 }, own: 'viewer', can_restrict: true })
    // Everyone is not "shared with me"
    expect((await (await e.as('park')).call('GET', '/api/shared-with-me')).data.items.some((x: { path: string }) => x.path === Q3)).toBe(false)
    // inherited General access: a file cannot be narrower than its folder
    setRule(e.db, e.team.path, '@전체', 'read')
    const r = await e.shareFile(e.boss, Q3, { general: { mode: 'restricted' } })
    expect(r.status).toBe(400)
    expect(r.data.error).toBe('inherited_general')
    expect((await e.view(e.boss, Q3)).data.general.can_restrict).toBe(false)
    setRule(e.db, e.team.path, '@전체', 'none')
    // 200 grants at most
    for (let i = 0; i < 200; i++) addGroup(e.db, `g${i}`)
    const many = Array.from({ length: 200 }, (_, i) => ({ subject: { type: 'group', id: e.gid(`g${i}`) }, role: 'viewer' }))
    const t = await e.shareFile(e.boss, Q3, { add: many.slice(0, 100) })
    expect(t.status).toBe(200)
    expect((await e.shareFile(e.boss, Q3, { add: many.slice(100) })).data.error).toBe('too_many')
    expect(shareAudit().filter((c) => c.includes('group:')).length).toBe(100) // one audit row per change
  })

  test('hidden == nonexistent on /api/share; agents get 401 (I3, I14)', async () => {
    const kim = await e.as('kim')
    const hid = await e.view(kim, SIB), none = await e.view(kim, '/재무팀/결산/nope.md')
    expect(hid.status).toBe(404)
    expect(JSON.stringify(hid.data)).toBe(JSON.stringify(none.data))
    const post = await e.give(kim, SIB, 'lee')
    expect(post.status).toBe(404)
    // an admin who cannot read the file does not see it either
    expect((await e.view(await e.as('dion'), Q3)).status).toBe(404)
    const tok = createToken(e.db, 'boss', { name: 'x' }).token
    const res = await new e.Browser().call('GET', '/api/share?path=' + encodeURIComponent(Q3), undefined, { authorization: `Bearer ${tok}` })
    expect(res.status).toBe(401)
    const post2 = await new e.Browser().call('POST', '/api/share', { path: Q3, add: [{ subject: e.person('kim'), role: 'viewer' }] }, { authorization: `Bearer ${tok}` })
    expect([401, 403]).toContain(post2.status)
    expect(e.grantRows()).toEqual([])
  })
})

describe('I8 agents ≤ person; I9 provenance; I15 widening', () => {
  test('a file shared under No AI opens on the web, never to tokens; a scoped token outside does not see it', async () => {
    await e.give(e.boss, Q3, 'kim')
    e.db.query('UPDATE folders SET no_ai = 1 WHERE id = ?').run(e.team.id)
    const kim = await e.as('kim')
    expect((await e.dl(kim, Q3)).status).toBe(200)
    expect(await e.agent('kim', `cat ${Q3}; ls /`)).not.toContain('CANARY-Q3')
    e.db.query('UPDATE folders SET no_ai = 0 WHERE id = ?').run(e.team.id)
    const scoped = createToken(e.db, 'kim', { name: 'scoped', scope: [e.proj.path] })
    const t = e.db.query<{ id: number }, [string]>('SELECT id FROM tokens WHERE name = ?').get('scoped')!
    const acc = Access.forToken(e.db, e.db.query<any, [number]>('SELECT * FROM tokens WHERE id = ?').get(t.id))
    expect(acc.lookup(splitVirtual(Q3))).toBeNull()
    expect(acc.rootEntries().map((x) => x.kind === 'dir' && x.node.vpath)).not.toContain('/재무팀')
    expect(scoped.token).toBeTruthy()
  })

  test('sharing an AI-draft copy with people who cannot read its sources is a widening (409; Editors cannot confirm; managers can)', async () => {
    // boss's AI drafts from /재무팀/결산 and promotes into /재무팀 (no widening: boss alone reads both)
    const r = await e.promoteFrom('boss', Q3, '/재무팀', 'digest.md', '# digest CANARY-DIGEST\n')
    expect(r.status).toBe('written')
    // /재무팀/결산 is restricted below: kim (Editor on /재무팀/digest.md is fine) — make the source narrower than the target
    setRule(e.db, e.team.path, 'kim', 'write')
    e.db.query('UPDATE folders SET inherit_break = 1 WHERE path = ?').run(e.real('/재무팀/결산'))
    setRule(e.db, e.real('/재무팀/결산'), 'boss', 'write')
    const kim = await e.as('kim')
    const w1 = await e.give(kim, '/재무팀/digest.md', 'park')
    expect(w1.status).toBe(409)
    expect(w1.data).toMatchObject({ code: 'widening', can_confirm: false })
    expect((await e.shareFile(kim, '/재무팀/digest.md', { add: [{ subject: e.person('park'), role: 'viewer' }], confirm_widening: true })).data.error).toBe('editors_cannot_confirm')
    expect((await e.dl(await e.as('park'), '/재무팀/digest.md')).status).toBe(404)
    const w2 = await e.shareFile(e.boss, '/재무팀/digest.md', { add: [{ subject: e.person('park'), role: 'viewer' }], confirm_widening: true })
    expect(w2.status).toBe(200)
    expect(w2.data.widens).toBe(1)
    expect(shareAudit().some((c) => c.includes('widens:1'))).toBe(true)
  })

  test('promote overwrite of a shared file counts its grantees as readers (I1 one-liner)', async () => {
    // kim may write Projects; readme.md there is shared with lee (who cannot read Projects any more)
    setRule(e.db, e.proj.path, '@전체', 'none')
    const kim = await e.as('kim')
    expect((await e.upload(kim, '/Projects', 'shared.md', 'v1')).status).toBe(200)
    await e.give(kim, '/Projects/shared.md', 'lee')
    setPromote(e.db, e.proj.id, true, null)
    // kim's AI writes a draft from Projects and promotes it over the shared file: lee does not read Projects → widening
    await e.tool('kim-ai', 'read', { path: '/Projects/readme.md' })
    await e.tool('kim-ai', 'write', { path: '/drafts/over.md', content: 'over' })
    const r = await e.tool('kim-ai', 'promote', { draft: '/drafts/over.md', folder: '/Projects', name: 'shared.md', overwrite: true })
    await managedIdle(e.db)
    expect((r.structuredContent as { status: string }).status).toBe('input_required') // widening: lee gains it
  })
})

describe('Recent and the WebDAV face', () => {
  test('Recent lists the person\'s own opens and edits, as visible now', async () => {
    await e.give(e.boss, Q3, 'kim')
    const kim = await e.as('kim')
    await e.dl(kim, Q3)
    await e.upload(kim, '/팀', 'mine.txt', 'hi')
    const r = (await kim.call('GET', '/api/recent')).data
    expect(r.items.map((x: { path: string; action: string }) => `${x.action} ${x.path}`)).toEqual(['edited /팀/mine.txt', `opened ${Q3}`])
    await e.shareFile(e.boss, Q3, { set: [{ subject: e.person('kim'), role: 'remove' }] })
    expect((await kim.call('GET', '/api/recent')).data.items.map((x: { path: string }) => x.path)).toEqual(['/팀/mine.txt'])
  })
})
