// Critical 1 of the Trina Cloud v1 review: the R6 re-check of AI-draft copies in managed storage, in the same
// transaction as every sharing, rule and membership change (src/share/rejudge.ts). Scenarios S41 (narrow → promote →
// widen: an Editor gets 409 and an approval request; a manager confirms and the copies close until a source manager
// confirms; the source manager's approval applies it) and S19 for managed storage.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { createManagedFolder } from '../src/managed/folders'
import { managedIdle } from '../src/managed/ops'
import type { DriveEvent } from '../src/notify/events'
import { approvalById } from '../src/promote'
import { snapshotCopies } from '../src/share/rejudge'
import { addGroup, addMember, grantManage, setRule } from '../src/store'
import { shareSetup, type ShareEnv } from './share-helpers'

let e: ShareEnv
let events: DriveEvent[]
beforeEach(async () => {
  e = await shareSetup()
  events = []
  e.w.opts.emit = (ev) => { events.push(ev) }
  // Scratch: park is its Editor, Anyone in Trina reads it; lee manages it (not the sources); boss manages 재무 and reads it
  const scratch = createManagedFolder(e.db, e.dir, { name: 'Scratch' })
  setRule(e.db, scratch.path, 'park', 'write')
  setRule(e.db, scratch.path, '@전체', 'read')
  grantManage(e.db, scratch.path, 'lee')
  grantManage(e.db, e.fin.path, 'boss')
  setRule(e.db, e.fin.path, 'boss', 'read')
})
afterEach(() => e.cleanup())

const SECRET = '# summary\n\nCANARY-FIN-7731 numbers from the finance folder, long enough to count\n'
const scratchReal = () => e.db.query<{ path: string }, []>("SELECT path FROM folders WHERE mount_name = 'Scratch'").get()!.path

/** S41 steps 1–2: park (Editor) narrows Scratch, then park's AI promotes a draft made from /재무 into it: written at once. */
async function narrowAndPromote() {
  const park = await e.as('park')
  expect((await e.share(park, { path: '/Scratch', general: { mode: 'restricted' } })).status).toBe(200)
  const p = await e.promoteFrom('park', '/재무/결산.md', '/Scratch', 'summary.md', SECRET)
  expect(p).toMatchObject({ status: 'written', path: '/Scratch/summary.md' })
  expect(e.widened()).toEqual([expect.objectContaining({ status: 'tracked' })])
  return park
}

describe('S41: narrow → promote → widen', () => {
  test('an Editor cannot widen: 409 with the sources hidden from them counted, then an approval request', async () => {
    const park = await narrowAndPromote()
    const code = await e.addTotp(park, 'park')
    const general = { mode: 'team', role: 'viewer' }
    const st = await park.call('POST', '/api/share/step-up', { path: '/Scratch', general, code: code() })
    const r = await e.share(park, { path: '/Scratch', general, step_up: st.data.assertion })
    expect(r.status).toBe(409)
    // park reads 재무, so the source is named for them
    expect(r.data).toMatchObject({ error: 'widening', count: 1, people: 3, sources: ['/재무'], sources_hidden: 0, can_confirm: false, needs_approval: true })
    // nothing changed: still restricted, the copy still tracked, nobody else sees it
    expect((await e.view(park, '/Scratch')).data.general.own).toBeNull()
    expect(e.widened()[0]!.status).toBe('tracked')
    expect(await e.agent('kim', 'cat /Scratch/summary.md')).not.toContain('CANARY')
    // the step-up was not used up by the refused change: asking for approval with it works
    const ask = await e.share(park, { path: '/Scratch', general, step_up: st.data.assertion, confirm_widening: true })
    expect(ask.status).toBe(202)
    expect(ask.data).toMatchObject({ status: 'approval_pending', widens: 3 })
    const ap = approvalById(e.db, ask.data.approval_id)!
    expect(ap).toMatchObject({ kind: 'share', status: 'pending', requester_person_id: e.pid('park'), target_vpath: '/Scratch' })
    expect(events.filter((x) => x.kind === 'approval_pending')).toEqual([{ kind: 'approval_pending', approvalId: ap.id, targetFolderId: ap.target_folder_id, sourceFolderIds: [e.fin.id] }])
    expect(e.db.query<{ command: string }, []>("SELECT command FROM audit WHERE command LIKE 'share /Scratch by editor%'").get()!.command).toBe(`share /Scratch by editor: approval #${ap.id} pending widens: 3`)
    // the same request again is the same approval; the requester cannot approve; lee (manages Scratch only) cannot either
    expect((await e.share(park, { path: '/Scratch', general, confirm_widening: true, step_up: (await park.call('POST', '/api/share/step-up', { path: '/Scratch', general, code: code() })).data.assertion })).data.approval_id).toBe(ap.id)
    expect((await park.call('GET', '/api/approvals')).data.items[0]).toMatchObject({ id: ap.id, kind: 'share', can_decide: false, mine: true })
    expect((await (await e.as('lee')).call('POST', `/api/approvals/${ap.id}/step-up/options`, { sha256: ap.sha256 })).status).toBe(404)

    // boss manages the source (재무) and reads it: he decides, with his own step-up for this request
    const boss = await e.as('boss')
    const inbox = (await boss.call('GET', '/api/approvals')).data.items
    expect(inbox[0]).toMatchObject({ id: ap.id, kind: 'share', can_decide: true, target: '/Scratch' })
    const detail = (await boss.call('GET', `/api/approvals/${ap.id}`)).data
    expect(detail).toMatchObject({ kind: 'share', sources: ['/재무'], hidden_sources: 0, gainers: { count: 3 }, change: { path: '/Scratch', general } })
    const bossCode = await e.addTotp(boss, 'boss')
    const bs = await boss.call('POST', `/api/approvals/${ap.id}/step-up`, { sha256: ap.sha256, code: bossCode() })
    expect(bs.status).toBe(200)
    const ok = await boss.call('POST', `/api/approvals/${ap.id}/approve`, { sha256: ap.sha256, assertion: bs.data.assertion })
    expect(ok.status).toBe(200)
    expect(approvalById(e.db, ap.id)!.status).toBe('approved')
    // applied as park's change, the copy confirmed by boss: everyone and their AI read it now
    expect((await e.view(park, '/Scratch')).data.general.own).toBe('viewer')
    expect(e.widened()[0]!.status).toBe('confirmed')
    expect(await e.agent('kim', 'cat /Scratch/summary.md')).toContain('CANARY-FIN-7731')
    expect(e.db.query<{ person_id: number; command: string }, []>("SELECT person_id, command FROM audit WHERE command LIKE 'approve share%'").get())
      .toEqual({ person_id: e.pid('boss'), command: `approve share #${ap.id}: share /Scratch: general team:viewer by editor widens: 3` })
  })

  test('a manager of the folder (not of the sources) confirms: the change applies, the copy closes until a source manager confirms', async () => {
    await narrowAndPromote()
    const lee = await e.as('lee')
    const r = await e.share(lee, { path: '/Scratch', general: { mode: 'team', role: 'viewer' } })
    expect(r.status).toBe(409)
    // lee cannot read 재무: the source is only counted (finding 11)
    expect(r.data).toMatchObject({ sources: [], sources_hidden: 1, can_confirm: true, needs_approval: false })
    const ok = await e.share(lee, { path: '/Scratch', general: { mode: 'team', role: 'viewer' }, confirm_widening: true })
    expect(ok.status).toBe(200)
    expect(ok.data.widens).toBe(3) // kim, lee, dion: boss and park read 재무
    expect(e.widened()[0]!.status).toBe('pending')
    // closed to every agent and every person until confirmed; the rest of the folder is open
    expect(await e.agent('kim', 'ls /Scratch; cat /Scratch/summary.md')).not.toContain('CANARY')
    expect(await e.agent('park', 'cat /Scratch/summary.md')).not.toContain('CANARY')
    expect((await (await e.as('kim')).call('GET', '/api/files?path=' + encodeURIComponent('/Scratch'))).status).toBe(200)
    // the source managers hear of it: kind + count + ids only (R11)
    expect(events.filter((x) => x.kind === 'widened_draft')).toEqual([{ kind: 'widened_draft', count: 1, sourceFolderIds: [e.fin.id], targetFolderId: expect.any(Number) }])
    expect(e.db.query<{ command: string }, []>("SELECT command FROM audit WHERE command LIKE 'share /Scratch:%'").all().at(-1)!.command).toBe('share /Scratch: general team:viewer widens: 3')
    expect(e.db.query<{ n: number }, []>("SELECT count(*) AS n FROM quarantine WHERE kind = 'widened' AND released_at IS NULL").get()!.n).toBe(1)
  })

  test('a manager of every source confirms at once; the folder-page rule route has the same 409', async () => {
    await narrowAndPromote()
    grantManage(e.db, scratchReal(), 'boss')
    const boss = await e.as('boss')
    const sid = e.db.query<{ id: number }, []>("SELECT id FROM folders WHERE mount_name = 'Scratch'").get()!.id
    const legacy = await boss.call('PUT', `/api/folders/${sid}/rules`, { subject_type: 'person', subject_id: e.pid('kim'), level: 'read' })
    expect([legacy.status, legacy.data.error]).toEqual([409, 'widening'])
    expect((await boss.call('PUT', `/api/folders/${sid}/rules`, { subject_type: 'person', subject_id: e.pid('kim'), level: 'read', confirm_widening: true })).status).toBe(200)
    expect(e.widened()[0]!.status).toBe('confirmed')
    expect(await e.agent('kim', 'cat /Scratch/summary.md')).toContain('CANARY-FIN-7731')
    expect(e.db.query<{ command: string }, []>("SELECT command FROM audit WHERE command LIKE 'rule kim%'").get()!.command).toBe('rule kim read widens: 1')
    // a further widening of a confirmed copy is judged again (the confirmation was for kim, not for everyone)
    const r = await e.share(await e.as('lee'), { path: '/Scratch', general: { mode: 'team', role: 'viewer' } })
    expect([r.status, r.data.people]).toEqual([409, 2])
  })

  test('the copy is found where it is now: moved inside managed storage; in the trash it is not judged', async () => {
    const park = await narrowAndPromote()
    expect((await park.call('POST', '/api/files/folder', { path: '/Scratch', name: 'sub' })).status).toBe(200)
    expect((await park.call('POST', '/api/files/move', { paths: ['/Scratch/summary.md'], to: '/Scratch/sub' })).data.results[0].to).toBe('/Scratch/sub/summary.md')
    expect(e.widened()[0]!.path).toBe(path.join(scratchReal(), 'sub', 'summary.md'))
    // even a path the database did not follow (moved by hand) is found by identity
    fs.renameSync(path.join(scratchReal(), 'sub', 'summary.md'), path.join(scratchReal(), 'sub', 'moved.md'))
    expect([...snapshotCopies(e.db).values()].map((x) => x.real)).toEqual([path.join(scratchReal(), 'sub', 'moved.md')])
    expect((await e.share(await e.as('lee'), { path: '/Scratch', general: { mode: 'team', role: 'viewer' } })).status).toBe(409)
    fs.renameSync(path.join(scratchReal(), 'sub', 'moved.md'), path.join(scratchReal(), 'sub', 'summary.md'))
    expect((await park.call('POST', '/api/files/delete', { paths: ['/Scratch/sub/summary.md'] })).status).toBe(200)
    expect(snapshotCopies(e.db).size).toBe(0)
    expect((await e.share(await e.as('lee'), { path: '/Scratch', general: { mode: 'team', role: 'viewer' } })).status).toBe(200)
  })

  test('taking access away never widens: a reader of the copy loses a source (S17)', async () => {
    await narrowAndPromote()
    const boss = await e.as('boss'), lee = await e.as('lee')
    // kim reads 재무 (boss gives it), then Scratch (lee manages it): no excess reader, nothing to judge
    const kim = e.person('kim')
    expect((await e.share(boss, { path: '/재무', add: [{ subject: kim, role: 'viewer' }] })).status).toBe(200)
    expect((await e.share(lee, { path: '/Scratch', add: [{ subject: kim, role: 'viewer' }] })).status).toBe(200)
    expect(await e.agent('kim', 'cat /Scratch/summary.md')).toContain('CANARY-FIN-7731')
    // boss takes 재무 away from kim: kim reads nothing new (she already read the copy), so no 409 widening
    const r = await e.share(boss, { path: '/재무', set: [{ subject: kim, role: 'remove' }] })
    expect([r.status, r.data.error]).toEqual([200, undefined])
    expect(e.widened()[0]!.status).toBe('tracked')
    // the same through the folder-page rule route, and a membership change (park leaves 재무 but keeps Scratch)
    expect((await e.share(boss, { path: '/재무', add: [{ subject: kim, role: 'viewer' }] })).status).toBe(200)
    expect((await boss.call('PUT', `/api/folders/${e.fin.id}/rules`, { subject_type: 'person', subject_id: e.pid('kim'), level: 'none' })).status).toBe(200)
    expect((await (await e.as('dion')).call('DELETE', `/api/groups/${e.gid('재무')}/members/${e.pid('park')}`)).status).toBe(200)
    expect(e.widened()[0]!.status).toBe('tracked')
    // someone new reading the copy is still judged: Scratch opened to the team
    const again = await e.share(lee, { path: '/Scratch', general: { mode: 'team', role: 'viewer' } })
    expect([again.status, again.data.error]).toEqual([409, 'widening'])
  })

  test('membership changes re-check in their own transaction: someone joining the copy\'s audience but not the sources', async () => {
    addGroup(e.db, 'scratchers'); addMember(e.db, 'scratchers', 'park')
    const park = await e.as('park')
    expect((await e.share(park, { path: '/Scratch', general: { mode: 'restricted' }, add: [{ subject: e.group('scratchers'), role: 'editor' }] })).status).toBe(200)
    await e.promoteFrom('park', '/재무/결산.md', '/Scratch', 'summary.md', SECRET)
    expect(e.widened()[0]!.status).toBe('tracked')
    const dion = await e.as('dion')
    expect((await dion.call('PUT', `/api/groups/${e.gid('scratchers')}/members/${e.pid('kim')}`)).status).toBe(200)
    expect(e.widened()[0]!.status).toBe('pending')
    expect(await e.agent('kim', 'cat /Scratch/summary.md')).not.toContain('CANARY')
  })
})

describe('S19 in managed storage', () => {
  test('an agent promote from /재무 into a wider folder waits for approval; a person\'s upload is recorded; the dialog warns', async () => {
    e.db.query("INSERT INTO rules (folder_id, subject_type, subject_id, level) VALUES (?, 'person', ?, 2)").run(e.proj.id, e.pid('park'))
    const p = await e.promoteFrom('park', '/재무/결산.md', '/Projects', 'leak.md', SECRET)
    expect(p.status).toBe('input_required')
    expect(fs.existsSync(path.join(e.proj.path, 'leak.md'))).toBe(false)
    // park (a person) uploads the same text into Projects: allowed, logged as wider than its sources (a person decides)
    const park = await e.as('park')
    expect((await e.upload(park, '/Projects', 'copy.md', SECRET)).status).toBe(200)
    await managedIdle(e.db)
    expect(e.db.query<{ command: string }, []>("SELECT command FROM audit WHERE command LIKE 'files upload /Projects/copy.md%'").get()!.command).toMatch(/wider than its sources\)$/)
    expect(e.widened()).toEqual([expect.objectContaining({ status: 'tracked' })])
    // the dialog of the folder warns about AI-draft copies (count only)
    const boss = await e.as('boss')
    expect((await e.view(boss, '/Projects')).data.warnings).toContainEqual({ code: 'draft_copies', count: 1 })
    // already wide on purpose: someone joining Anyone in Trina does not reopen it; giving lee write is no widening either
    expect((await e.share(boss, { path: '/Projects', add: [{ subject: e.person('lee'), role: 'editor' }] })).status).toBe(200)
    // making it narrower and wider again is judged: dion would read it again (kim, lee, park, boss still read it directly)
    expect((await e.share(boss, { path: '/Projects', general: { mode: 'restricted' } })).status).toBe(200)
    const again = await e.share(boss, { path: '/Projects', general: { mode: 'team', role: 'viewer' } })
    expect(again.status).toBe(409)
    expect(again.data).toMatchObject({ people: 1, sources: ['/재무'], sources_hidden: 0 }) // boss reads 재무 here
    // no mail or notice carries a folder or file name
    for (const m of e.mailer.read()) for (const n of ['재무', '결산', 'leak', 'copy.md', 'Projects']) expect(`${m.subject} ${m.text}`).not.toContain(n)
  })
})
