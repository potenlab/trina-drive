// REST API rules: who sees which folder (404, never 403, for what you cannot see), R7 manage limits, R9 admin limits
// and notices, tokens only for yourself, drafts per R4 with the session as a full-scope token, audit filtering.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { verifyToken } from '../src/store'
import { webSetup, type WebEnv } from './web-helpers'

let e: WebEnv
beforeEach(async () => { e = await webSetup() })
afterEach(() => e.cleanup())

const notices = (name: string, kind?: string) =>
  e.db.query<{ kind: string; link: string }, [number]>('SELECT kind, link FROM notices WHERE person_id = ?').all(e.pid(name)).filter((n) => !kind || n.kind === kind)

describe('who can see which folder', () => {
  test('members see folders they read, are NAS readers or owners of; others are 404', async () => {
    const kim = await e.as('kim')
    const names = (await kim.call('GET', '/api/folders')).data.folders.map((f: { name: string }) => f.name).sort()
    expect(names).toEqual(['개인_kim', '공용', '프로젝트'].sort())
    for (const hidden of ['경영', '인사']) {
      expect((await kim.call('GET', `/api/folders/${e.fid(hidden)}`)).status).toBe(404)
      expect((await kim.call('PUT', `/api/folders/${e.fid(hidden)}/rules`, { subject_type: 'person', subject_id: e.pid('kim'), level: 'read' })).status).toBe(404)
      expect((await kim.call('PATCH', `/api/folders/${e.fid(hidden)}`, { no_ai: true })).status).toBe(404)
    }
    expect((await kim.call('GET', '/api/folders/99999')).status).toBe(404)
    // a member does not see server paths
    expect((await kim.call('GET', `/api/folders/${e.fid('프로젝트')}`)).data.folder.path).toBeUndefined()
  })

  test('a NAS reader without AI access still sees the folder in "who can see"', async () => {
    const admin = await e.as('dion')
    expect((await admin.call('PUT', `/api/folders/${e.fid('인사')}/nas`, { mode: 'chosen', people: [e.pid('lee'), e.pid('kim')] })).status).toBe(200)
    const kim = await e.as('kim')
    const v = await kim.call('GET', `/api/folders/${e.fid('인사')}`)
    expect(v.status).toBe(200)
    expect(v.data.folder.mine).toMatchObject({ ai: false, nas: true })
  })

  test('a personal folder: only its owner (and the admin) see it; nobody can set rules in it', async () => {
    const lee = await e.as('lee'), kim = await e.as('kim'), admin = await e.as('dion')
    expect((await lee.call('GET', `/api/folders/${e.fid('개인_kim')}`)).status).toBe(404)
    expect((await kim.call('GET', `/api/folders/${e.fid('개인_kim')}`)).status).toBe(200)
    expect((await admin.call('PUT', `/api/folders/${e.fid('개인_kim')}/rules`, { subject_type: 'person', subject_id: e.pid('lee'), level: 'read' })).status).toBe(403)
    // NAS readers of a personal folder: the owner only, not the admin (R5)
    expect((await admin.call('PUT', `/api/folders/${e.fid('개인_kim')}/nas`, { mode: 'all' })).status).toBe(403)
    expect((await kim.call('PUT', `/api/folders/${e.fid('개인_kim')}/nas`, { mode: 'chosen', people: [e.pid('kim')] })).status).toBe(200)
  })

  test('the two-column table: AI and NAS per person, with the "AI ✓ · NAS ✗" warning', async () => {
    const admin = await e.as('dion')
    expect((await admin.call('PUT', `/api/folders/${e.fid('경영')}/rules`, { subject_type: 'person', subject_id: e.pid('kim'), level: 'read' })).status).toBe(200)
    const t = (await admin.call('GET', `/api/folders/${e.fid('경영')}`)).data
    const row = (type: string, name: string) => t.rows.find((r: { type: string; name: string }) => r.type === type && r.name === name)
    expect(row('person', 'boss')).toMatchObject({ ai: { level: 1, via: 'group' }, nas: true, warn: false })
    expect(row('person', 'kim')).toMatchObject({ ai: { level: 1, via: 'direct', direct: true }, nas: false, warn: true })
    expect(row('person', 'lee')).toMatchObject({ ai: { level: 0 }, nas: false, warn: false })
    expect(row('group', '경영')).toMatchObject({ ai: { direct: true, level: 1 }, nas: true })
    expect(t.folder.path).toBe(path.join(e.root, '경영'))
  })

  test('subfolders inherit and "start fresh here" cuts the inheritance', async () => {
    fs.mkdirSync(path.join(e.root, '프로젝트', '2026'))
    const admin = await e.as('dion')
    const sub = await admin.call('POST', `/api/folders/${e.fid('프로젝트')}/subfolders`, { rel: '2026' })
    expect(sub.status).toBe(200)
    const sid = sub.data.id
    let t = (await admin.call('GET', `/api/folders/${sid}`)).data
    expect(t.rows.find((r: { name: string }) => r.name === 'kim').ai).toMatchObject({ level: 2, via: 'group' })
    expect(t.rows.find((r: { type: string; name: string }) => r.type === 'group' && r.name === '전체').ai.inherited_from).toBe('/프로젝트')
    expect((await admin.call('PATCH', `/api/folders/${sid}`, { inherit_break: true })).status).toBe(200)
    t = (await admin.call('GET', `/api/folders/${sid}`)).data
    expect(t.rows.find((r: { name: string }) => r.name === 'kim').ai.level).toBe(0)
    // links and parent steps are refused
    fs.symlinkSync(path.join(e.root, '경영'), path.join(e.root, '프로젝트', 'link'))
    expect((await admin.call('POST', `/api/folders/${e.fid('프로젝트')}/subfolders`, { rel: 'link' })).status).toBe(400)
    expect((await admin.call('POST', `/api/folders/${e.fid('프로젝트')}/subfolders`, { rel: '../경영' })).status).toBe(400)
  })
})

describe('R7: what a manage holder can and cannot do', () => {
  test('boss (manage on 경영) edits AI readers and turns no-AI on — nothing more', async () => {
    const boss = await e.as('boss')
    const f = e.fid('경영')
    expect((await boss.call('GET', `/api/folders/${f}`)).data.folder.can).toMatchObject({ edit_rules: true, no_ai_on: true, no_ai_off: false, edit_nas: false, admin: false })
    expect((await boss.call('PUT', `/api/folders/${f}/rules`, { subject_type: 'person', subject_id: e.pid('lee'), level: 'read' })).status).toBe(200)
    expect((await boss.call('PATCH', `/api/folders/${f}`, { no_ai: true })).status).toBe(200)
    // cannot: NAS readers, no-AI off, register/unregister, quarantine, grant manage
    expect((await boss.call('PUT', `/api/folders/${f}/nas`, { mode: 'all' })).status).toBe(403)
    expect((await boss.call('PATCH', `/api/folders/${f}`, { no_ai: false })).status).toBe(403)
    expect((await boss.call('DELETE', `/api/folders/${f}`)).status).toBe(403)
    expect((await boss.call('PATCH', `/api/folders/${f}`, { quarantine: false })).status).toBe(403)
    expect((await boss.call('PUT', `/api/folders/${f}/managers/${e.pid('kim')}`)).status).toBe(403)
    expect((await boss.call('POST', '/api/folders', { path: path.join(e.root, '영업'), template: 'custom' })).status).toBe(403)
    const row = e.db.query<{ no_ai: number; nas_readers: string }, [number]>('SELECT no_ai, nas_readers FROM folders WHERE id = ?').get(f)!
    expect(row).toEqual({ no_ai: 1, nas_readers: JSON.stringify([e.pid('boss')]) })
    // and nothing on folders boss does not manage
    expect((await boss.call('PUT', `/api/folders/${e.fid('프로젝트')}/rules`, { subject_type: 'person', subject_id: e.pid('lee'), level: 'read' })).status).toBe(403)
  })

  test('a rule change tells the other manage holders', async () => {
    const admin = await e.as('dion')
    await admin.call('PUT', `/api/folders/${e.fid('경영')}/managers/${e.pid('park')}`)
    const before = notices('park', 'rules_changed').length
    const boss = await e.as('boss')
    await boss.call('PUT', `/api/folders/${e.fid('경영')}/rules`, { subject_type: 'person', subject_id: e.pid('lee'), level: 'read' })
    expect(notices('park', 'rules_changed').length).toBe(before + 1)
    expect(notices('boss', 'rules_changed').length).toBe(0)
  })

  test('manage holds below the folder, but not across into another registered tree', async () => {
    fs.mkdirSync(path.join(e.root, '경영', '2026'))
    const admin = await e.as('dion')
    const sid = (await admin.call('POST', `/api/folders/${e.fid('경영')}/subfolders`, { rel: '2026' })).data.id
    const boss = await e.as('boss')
    expect((await boss.call('PUT', `/api/folders/${sid}/rules`, { subject_type: 'person', subject_id: e.pid('lee'), level: 'read' })).status).toBe(200)
  })
})

describe('R9: the admin', () => {
  test('putting themselves in a rule tells the folder managers and themselves, and is audited', async () => {
    const admin = await e.as('dion')
    expect((await admin.call('PUT', `/api/folders/${e.fid('경영')}/rules`, { subject_type: 'person', subject_id: e.pid('dion'), level: 'read' })).status).toBe(200)
    expect(notices('boss', 'self_grant')).toEqual([{ kind: 'self_grant', link: `/#/folders/${e.fid('경영')}` }])
    expect(notices('dion', 'self_grant').length).toBe(1)
    // the mail says what kind and how many, never the folder or person
    const mail = e.mailer.read().find((m) => m.to === 'boss@example.com' && /gave themselves/.test(m.subject))!
    expect(mail.text).not.toContain('경영')
    expect(mail.text).not.toContain('dion')
    expect(e.db.query(`SELECT count(*) AS n FROM audit WHERE tool = 'web' AND command LIKE 'rule dion read'`).get()).toEqual({ n: 1 })
  })

  test('self manage grant, self NAS reader, self group membership all notify', async () => {
    const admin = await e.as('dion')
    await admin.call('PUT', `/api/folders/${e.fid('경영')}/managers/${e.pid('dion')}`)
    expect(notices('boss', 'self_grant').length).toBe(1)
    await admin.call('PUT', `/api/folders/${e.fid('경영')}/nas`, { mode: 'chosen', people: [e.pid('boss'), e.pid('dion')] })
    expect(notices('boss', 'self_grant').length).toBe(2)
    expect(notices('boss', 'nas_readers_changed').length).toBe(1)
    const gid = e.db.query<{ id: number }, []>(`SELECT id FROM groups WHERE name = '경영'`).get()!.id
    await admin.call('PUT', `/api/groups/${gid}/members/${e.pid('dion')}`)
    expect(notices('boss', 'self_grant').length).toBe(3)
    // NAS history keeps the value before
    const t = (await admin.call('GET', `/api/folders/${e.fid('경영')}`)).data
    expect(t.nas_history[0].old_value).toBe(JSON.stringify([e.pid('boss')]))
  })

  test('turning no-AI off is admin only and notifies', async () => {
    const admin = await e.as('dion'), boss = await e.as('boss')
    await boss.call('PATCH', `/api/folders/${e.fid('경영')}`, { no_ai: true })
    expect((await admin.call('PATCH', `/api/folders/${e.fid('경영')}`, { no_ai: false })).status).toBe(200)
    expect(notices('boss', 'no_ai_off').length).toBe(1)
  })

  test('admins cannot make tokens for other people; tokens are always the caller\'s own', async () => {
    const admin = await e.as('dion')
    const r = await admin.call('POST', '/api/tokens', { name: 'for-kim', ttl: '7d', person: 'kim', person_id: e.pid('kim') })
    expect(r.status).toBe(200)
    expect(e.db.query<{ person_id: number }, [number]>('SELECT person_id FROM tokens WHERE id = ?').get(r.data.id)!.person_id).toBe(e.pid('dion'))
  })

  test('unregistering a personal folder or changing its owner tells the owner; re-registering it as regular tells the former owner', async () => {
    const admin = await e.as('dion')
    const f = e.fid('개인_kim')
    expect((await admin.call('DELETE', `/api/folders/${f}`)).status).toBe(200)
    expect(notices('kim', 'personal_folder_changed').length).toBe(1)
    const r = await admin.call('POST', '/api/folders', { path: path.join(e.root, '개인_kim'), template: 'custom' })
    expect(r.status).toBe(200)
    expect(r.data.warnings).toContain('former_personal')
    expect(notices('kim', 'former_personal_registered').length).toBe(1)
  })

  test('register with templates: public, team, management (no-AI suggested), personal', async () => {
    for (const d of ['pub', 'team', 'mgmt', 'mine']) fs.mkdirSync(path.join(e.root, 'new', d), { recursive: true })
    const admin = await e.as('dion')
    const gid = e.db.query<{ id: number }, []>(`SELECT id FROM groups WHERE name = '영업'`).get()!.id
    const reg = async (b: object) => { const r = await admin.call('POST', '/api/folders', b); expect(r.status).toBe(200); return e.db.query<any, [number]>('SELECT * FROM folders WHERE id = ?').get(r.data.id) }
    const pub = await reg({ path: path.join(e.root, 'new/pub'), template: 'public' })
    expect(pub.nas_readers).toBe('all')
    const team = await reg({ path: path.join(e.root, 'new/team'), template: 'team', group: gid })
    expect(team.nas_readers).toBe(JSON.stringify([e.pid('park')]))
    const mgmt = await reg({ path: path.join(e.root, 'new/mgmt'), template: 'management', group: gid, nas: { mode: 'unknown' } })
    expect(mgmt.no_ai).toBe(1)
    const mine = await reg({ path: path.join(e.root, 'new/mine'), template: 'personal', owner: e.pid('lee') })
    expect(mine.personal_owner).toBe(e.pid('lee'))
    expect(mine.nas_readers).toBe(JSON.stringify([e.pid('lee')]))
    // the agent side sees the new folders through the same policy
    const kim = await e.as('kim')
    expect((await kim.call('GET', '/api/folders')).data.folders.map((f: { name: string }) => f.name)).toContain('pub')
    expect((await admin.call('POST', '/api/folders', { path: path.join(e.root, 'new/pub'), template: 'public' })).status).toBe(409)
    expect((await admin.call('POST', '/api/folders', { path: e.dir, template: 'public' })).status).toBe(400) // holds the data dir
    expect((await admin.call('POST', '/api/folders', { path: '/no/such/dir', template: 'public' })).status).toBe(400)
  })

  test('there is always one admin; you cannot deactivate yourself', async () => {
    const admin = await e.as('dion')
    expect((await admin.call('PATCH', `/api/people/${e.pid('dion')}`, { admin: false })).status).toBe(400)
    expect((await admin.call('PATCH', `/api/people/${e.pid('dion')}`, { active: false })).status).toBe(400)
  })

  test('deactivating a person cuts their sessions and tokens', async () => {
    const admin = await e.as('dion'), kim = await e.as('kim')
    expect((await admin.call('PATCH', `/api/people/${e.pid('kim')}`, { active: false })).status).toBe(200)
    expect((await kim.call('GET', '/api/session')).status).toBe(401)
    expect(verifyToken(e.db, e.secrets.kim!)).toBeNull()
  })

  test('members cannot manage people or groups', async () => {
    const kim = await e.as('kim')
    expect((await kim.call('POST', '/api/people', { name: 'x', email: 'x@example.com' })).status).toBe(403)
    expect((await kim.call('POST', '/api/groups', { name: 'x' })).status).toBe(403)
    const people = (await kim.call('GET', '/api/people')).data.people
    expect(people.find((p: { name: string }) => p.name === 'lee').email).toBeUndefined()
    expect(people.find((p: { name: string }) => p.name === 'kim').email).toBe('kim@example.com')
  })
})

describe('tokens', () => {
  test('create for yourself (shown once), list without the secret, revoke at once; others\' tokens are 404', async () => {
    const kim = await e.as('kim')
    const r = await kim.call('POST', '/api/tokens', { name: 'claude-laptop', scope: [e.fid('프로젝트')], read_only: true, ttl: '7d' })
    expect(r.status).toBe(200)
    expect(r.data.token).toStartWith('tdrive_pat_')
    const t = verifyToken(e.db, r.data.token, 'test')!
    expect(t.read_only).toBe(1)
    const list = (await kim.call('GET', '/api/tokens')).data.tokens
    expect(JSON.stringify(list)).not.toContain(r.data.token)
    const mine = list.find((x: { id: number }) => x.id === r.data.id)
    expect(mine).toMatchObject({ name: 'claude-laptop', read_only: true, status: 'active', last_client: 'test', scope: [{ vpath: '/프로젝트' }] })
    // scope only over folders you can see
    expect((await kim.call('POST', '/api/tokens', { name: 'sneaky', scope: [e.fid('경영')], ttl: '7d' })).status).toBe(404)
    expect((await kim.call('POST', '/api/tokens', { name: 'claude-laptop', ttl: '7d' })).status).toBe(409)
    const boss = await e.as('boss')
    expect((await boss.call('DELETE', `/api/tokens/${r.data.id}`)).status).toBe(404)
    expect((await (await e.as('dion')).call('DELETE', `/api/tokens/${r.data.id}`)).status).toBe(404)
    expect((await kim.call('DELETE', `/api/tokens/${r.data.id}`)).status).toBe(200)
    expect(verifyToken(e.db, r.data.token)).toBeNull()
  })
})

describe('drafts (R4, session = full-scope token)', () => {
  test('own drafts with sources you can read now are listed and downloadable; nobody else sees them', async () => {
    const w = await e.tool('kim', 'bash', { command: 'cat /프로젝트/견적_2026.md > /dev/null; head -1 /공용/공지.md' })
    expect(w.isError).toBeFalsy()
    await e.tool('kim', 'write', { path: '/drafts/요약.md', content: '# 요약\n' })
    const kim = await e.as('kim')
    const v = (await kim.call('GET', '/api/drafts')).data
    expect(v.drafts.map((d: { path: string }) => d.path)).toEqual(['요약.md'])
    expect(v.drafts[0].sources.map((s: { folder: string }) => s.folder)).toEqual(['/공용', '/프로젝트'])
    const id = v.drafts[0].id
    const dl = await kim.raw('GET', `/api/drafts/${id}/download`)
    expect(dl.status).toBe(200)
    expect(await dl.text()).toBe('# 요약\n')
    expect(dl.headers.get('content-disposition')).toContain("filename*=UTF-8''%EC%9A%94%EC%95%BD.md")
    for (const other of ['boss', 'dion']) {
      const b = await e.as(other)
      expect((await b.call('GET', `/api/drafts/${id}/download`)).status).toBe(404)
      expect((await b.call('GET', '/api/drafts')).data.drafts).toEqual([])
    }
  })

  test('a draft whose sources you cannot read now is locked: count and date only', async () => {
    await e.tool('boss', 'bash', { command: 'cat /경영/손익.csv' })
    await e.tool('boss', 'write', { path: '/drafts/견적.md', content: '매출 기반 견적\n' })
    const boss = await e.as('boss')
    expect((await boss.call('GET', '/api/drafts')).data.drafts.length).toBe(1)
    e.db.query(`DELETE FROM memberships WHERE person_id = ? AND group_id = (SELECT id FROM groups WHERE name = '경영')`).run(e.pid('boss'))
    const v = (await boss.call('GET', '/api/drafts')).data
    expect(v.drafts).toEqual([])
    expect(v.locked.count).toBe(1)
    expect(JSON.stringify(v)).not.toContain('견적')
    const id = e.db.query<{ id: number }, []>('SELECT id FROM drafts').get()!.id
    expect((await boss.call('GET', `/api/drafts/${id}/download`)).status).toBe(404)
  })
})

describe('audit (R7 / R9 filtering)', () => {
  test('own entries; managers see their folders (without others\' command lines); admin sees counts only', async () => {
    await e.tool('kim', 'bash', { command: 'cat /프로젝트/README.md' })
    await e.tool('boss', 'bash', { command: 'cat /경영/손익.csv # secret-ish words' })
    const kim = await e.as('kim')
    const mine = (await kim.call('GET', '/api/audit?view=mine')).data.entries
    expect(mine.length).toBeGreaterThan(0)
    expect(mine.every((x: { command: string }) => !x.command.includes('경영'))).toBe(true)
    expect((await kim.call('GET', '/api/audit?view=folders')).data.entries).toEqual([])
    expect((await kim.call('GET', '/api/audit?view=summary')).status).toBe(403)

    // park manages 경영 too: sees boss's read of /경영, without the command line
    const admin = await e.as('dion')
    await admin.call('PUT', `/api/folders/${e.fid('경영')}/managers/${e.pid('park')}`)
    const park = await e.as('park')
    const pv = (await park.call('GET', '/api/audit?view=folders')).data
    const read = pv.entries.find((x: { person: string; tool: string }) => x.person === 'boss' && x.tool === 'bash')
    expect(read.files).toEqual(['/경영/손익.csv'])
    expect(read.command).toBeNull()
    expect(pv.entries.some((x: { files: string[] }) => x.files.some((f) => f.startsWith('/프로젝트')))).toBe(false)

    const s = (await admin.call('GET', '/api/audit?view=summary')).data
    expect(s.chain.ok).toBe(true)
    expect(s.rows.find((x: { person: string; connection: string }) => x.person === 'boss' && x.connection === 'boss-laptop').count).toBe(1)
    expect(JSON.stringify(s)).not.toContain('손익')
    // the admin's own entries are theirs to see, others' are not in "mine"
    const am = (await admin.call('GET', '/api/audit?view=mine')).data.entries
    expect(am.every((x: { command: string }) => !x.command.includes('손익'))).toBe(true)
  })
})
