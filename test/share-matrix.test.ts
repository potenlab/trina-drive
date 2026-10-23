// Who may change what in the share dialog (O1 + R7 + R9; scenarios S15 "O1 version" and S42): the permission matrix
// over every operation and role, the per-folder "Editors can change permissions and share" toggle (inherited, off below
// when off above), and the passkey / authenticator step-up an Editor needs to open a folder to the whole team.
import { afterEach, describe, expect, test } from 'bun:test'
import { shareSetup, type ShareEnv } from './share-helpers'
import { SoftAuthenticator } from './soft-authenticator'

let e: ShareEnv | null = null
afterEach(() => { e?.cleanup(); e = null })

type Actor = 'admin' | 'manager' | 'editor' | 'viewer' | 'hidden'
const WHO: Record<Actor, string> = { admin: 'dion', manager: 'boss', editor: 'kim', viewer: 'lee', hidden: 'kim' }

interface Case { name: string; path: string; body: (x: ShareEnv) => Record<string, unknown>; prep?: (x: ShareEnv) => void; expect: Record<Actor, number | [number, string]> }
const SUB = '/Projects/비밀'
const CASES: Case[] = [
  { name: 'add a viewer', path: SUB, body: (x) => ({ add: [{ subject: x.person('park'), role: 'viewer' }] }),
    expect: { admin: 200, manager: 200, editor: 200, viewer: [403, 'not_manager'], hidden: 404 } },
  { name: 'add an editor', path: SUB, body: (x) => ({ add: [{ subject: x.person('lee'), role: 'editor' }] }),
    expect: { admin: 200, manager: 200, editor: 200, viewer: [403, 'not_manager'], hidden: 404 } },
  { name: 'make someone a manager', path: SUB, body: (x) => ({ add: [{ subject: x.person('lee'), role: 'manager' }] }),
    expect: { admin: 200, manager: [403, 'admin_only'], editor: [403, 'admin_only'], viewer: [403, 'not_manager'], hidden: 404 } },
  { name: 'remove a direct entry', path: SUB, prep: (x) => { x.db.query("INSERT INTO rules (folder_id, subject_type, subject_id, level) VALUES (?, 'person', ?, 2)").run(subId(x), x.pid('park')) },
    body: (x) => ({ set: [{ subject: x.person('park'), role: 'remove' }] }),
    expect: { admin: 200, manager: 200, editor: 200, viewer: [403, 'not_manager'], hidden: 404 } },
  { name: 'remove a manager', path: '/Projects', body: (x) => ({ set: [{ subject: x.person('boss'), role: 'editor' }] }),
    expect: { admin: 200, manager: [403, 'admin_only'], editor: [403, 'admin_only'], viewer: [403, 'not_manager'], hidden: 404 } },
  { name: 'open to Anyone in Trina as editor', path: SUB, body: () => ({ general: { mode: 'team', role: 'editor' } }),
    expect: { admin: 200, manager: 200, editor: [403, 'step_up_required'], viewer: [403, 'not_manager'], hidden: 404 } },
  { name: 'General access: restricted', path: '/Projects', body: () => ({ general: { mode: 'restricted' } }),
    expect: { admin: 200, manager: 200, editor: 200, viewer: [403, 'not_manager'], hidden: 404 } },
  { name: 'restrict access here', path: SUB, body: () => ({ restrict_here: { on: true, keep: [] } }),
    expect: { admin: 200, manager: 200, editor: [403, 'manager_only'], viewer: [403, 'not_manager'], hidden: 404 } },
  { name: '"No AI" on', path: SUB, body: () => ({ ai_access: false }),
    expect: { admin: 200, manager: 200, editor: 200, viewer: [403, 'not_manager'], hidden: 404 } },
  { name: '"No AI" off', path: SUB, prep: (x) => { x.db.query('UPDATE folders SET no_ai = 1 WHERE id = ?').run(subId(x)) }, body: () => ({ ai_access: true }),
    expect: { admin: 200, manager: [403, 'admin_only'], editor: [403, 'admin_only'], viewer: [403, 'not_manager'], hidden: 404 } },
  { name: 'turn "Editors can share" off', path: SUB, body: () => ({ editors_can_share: false }),
    expect: { admin: 200, manager: 200, editor: [403, 'manager_only'], viewer: [403, 'not_manager'], hidden: 404 } },
  { name: 'share with a non-member (invite)', path: SUB, body: () => ({ add: [{ subject: { email: 'new@example.org' }, role: 'viewer' }] }),
    expect: { admin: [409, 'invites_unavailable'], manager: [403, 'invite_admin_only'], editor: [403, 'invite_admin_only'], viewer: [403, 'not_manager'], hidden: 404 } },
]
/** the subfolder's row (made by a GET of the dialog, as the web does) */
function subId(x: ShareEnv): number {
  const r = x.db.query<{ id: number }, [string]>('SELECT id FROM folders WHERE path = ?').get(x.proj.path + '/비밀')
  if (r) return r.id
  throw new Error('open the dialog first')
}

describe('the permission matrix (S15 O1 version, S42)', () => {
  for (const c of CASES) {
    test(c.name, async () => {
      for (const actor of Object.keys(c.expect) as Actor[]) {
        e = await shareSetup()
        const b = await e.as(WHO[actor])
        await e.view(await e.as('dion'), SUB) // the subfolder gets its row, as when someone opens its dialog
        c.prep?.(e)
        const before = e.db.query<{ n: number }, []>('SELECT count(*) AS n FROM audit').get()!.n
        const path = actor === 'hidden' ? '/재무' : c.path
        const r = await e.share(b, { path, ...c.body(e) })
        const want = c.expect[actor]
        const [status, code] = Array.isArray(want) ? want : [want, undefined]
        expect({ actor, status: r.status, code: r.status === 200 ? undefined : r.data.error }).toEqual({ actor, status, code: status === 200 ? undefined : code ?? 'not_found' })
        const rows = e.db.query<{ command: string }, [number]>("SELECT command FROM audit WHERE id > ? AND command LIKE 'share %'").all(before)
        expect(rows.length).toBe(status === 200 ? 1 : 0) // every change audited; refusals change nothing
        e.cleanup(); e = null
      }
    })
  }
})

describe('O1: "Editors can change permissions and share"', () => {
  test('on by default; off on a folder turns it off there and below, and cannot be turned back on below', async () => {
    e = await shareSetup()
    const kim = await e.as('kim'), boss = await e.as('boss')
    expect((await e.view(kim, SUB)).data).toMatchObject({ my_role: 'editor', can_share: true, can_manage: false, editors_can_share: { effective: true }, general: { editor_step_up: true } })
    expect((await e.share(boss, { path: '/Projects', editors_can_share: false })).status).toBe(200)
    for (const p of ['/Projects', SUB]) {
      expect((await e.view(kim, p)).data).toMatchObject({ my_role: 'editor', can_share: false })
      const r = await e.share(kim, { path: p, add: [{ subject: e.person('park'), role: 'viewer' }] })
      expect([r.status, r.data.error]).toEqual([403, 'editors_cannot_share'])
    }
    const below = await e.share(boss, { path: SUB, editors_can_share: true })
    expect(below.data.editors_can_share).toEqual({ effective: false, own: true, off_above: true })
    expect(below.data.warnings).toContainEqual({ code: 'editors_off_above' })
    expect((await e.share(kim, { path: SUB, add: [{ subject: e.person('park'), role: 'viewer' }] })).status).toBe(403)
    expect(e.db.query<{ new_value: string }, [number]>("SELECT new_value FROM folder_history WHERE folder_id = ? AND field = 'editors_can_share'").all(e.proj.id)).toEqual([{ new_value: '0' }])
  })

  test('an Editor\'s change is audited "by editor" and the folder\'s managers are told (kind + count + link)', async () => {
    e = await shareSetup()
    const kim = await e.as('kim')
    expect((await e.share(kim, { path: '/Projects', add: [{ subject: e.person('park'), role: 'editor' }] })).status).toBe(200)
    expect(e.db.query<{ command: string }, []>("SELECT command FROM audit WHERE command LIKE 'share %'").all().at(-1)!.command)
      .toBe(`share /Projects: person:${e.pid('park')} none→editor by editor`)
    expect(e.db.query<{ kind: string; link: string }, [number]>('SELECT kind, link FROM notices WHERE person_id = ?').all(e.pid('boss'))).toContainEqual({ kind: 'rules_changed', link: `/#/folders/${e.proj.id}` })
    // the Editor removes what they (or anyone) gave here directly, but not a manager or something from above
    expect((await e.share(kim, { path: '/Projects', set: [{ subject: e.person('park'), role: 'remove' }] })).status).toBe(200)
    expect((await e.share(kim, { path: SUB, set: [{ subject: e.person('boss'), role: 'remove' }] })).data.error).toBe('inherited')
  })

  test('an Editor opening a folder to the whole team proves it with an authenticator code (no public address)', async () => {
    e = await shareSetup()
    const kim = await e.as('kim')
    const general = { mode: 'team', role: 'editor' }
    const opt0 = await kim.call('POST', '/api/share/step-up/options', { path: SUB, general })
    expect([opt0.status, opt0.data.error]).toEqual([409, 'totp_required'])
    const code = await e.addTotp(kim, 'kim')
    expect((await kim.call('POST', '/api/share/step-up/options', { path: SUB, general })).data).toEqual({ method: 'totp' })
    expect((await kim.call('POST', '/api/share/step-up', { path: SUB, general, code: '000000' })).status).toBe(401)
    const s = await kim.call('POST', '/api/share/step-up', { path: SUB, general, code: code() })
    expect(s.status).toBe(200)
    // bound to that folder and that change: another change or folder does not take it
    expect((await e.share(kim, { path: '/Projects', general, step_up: s.data.assertion })).data.error).toBe('step_up_required')
    const ok = await e.share(kim, { path: SUB, general, step_up: s.data.assertion })
    expect(ok.status).toBe(200)
    expect(ok.data.general.own).toBe('editor')
    // single use
    expect((await e.share(await e.as('boss'), { path: SUB, general: { mode: 'team', role: 'viewer' } })).status).toBe(200)
    expect((await e.share(kim, { path: SUB, general, step_up: s.data.assertion })).data.error).toBe('step_up_required')
    // narrowing needs no step-up; nor does a manager
    expect((await e.share(kim, { path: '/Projects', general: { mode: 'restricted' } })).status).toBe(200)
    expect((await e.share(await e.as('boss'), { path: '/Projects', general: { mode: 'team', role: 'viewer' } })).status).toBe(200)
  })

  test('…and with a passkey where the server has its public https address (hosted)', async () => {
    e = await shareSetup()
    e.w.opts.publicUrl = 'https://drive.test'
    const kim = await e.as('kim')
    const a = new SoftAuthenticator('https://drive.test')
    const reg = await kim.call('POST', '/api/me/passkeys/options')
    expect((await kim.call('POST', '/api/me/passkeys', { response: a.register(reg.data), name: 'Laptop' })).status).toBe(200)
    const general = { mode: 'team', role: 'viewer' }
    await e.share(await e.as('boss'), { path: '/Projects', general: { mode: 'restricted' } })
    const o = await kim.call('POST', '/api/share/step-up/options', { path: '/Projects', general })
    expect(o.data.method).toBe('passkey')
    const s = await kim.call('POST', '/api/share/step-up', { path: '/Projects', general, response: a.assert(o.data.options) })
    expect(s.status).toBe(200)
    expect((await e.share(kim, { path: '/Projects', general, step_up: s.data.assertion })).status).toBe(200)
  })

  test('S15: a manager (not an admin) shares in their folder; Manager grants and "No AI" off are refused; viewers read only', async () => {
    e = await shareSetup()
    const boss = await e.as('boss')
    expect((await e.share(boss, { path: '/Projects', add: [{ subject: e.group('재무'), role: 'editor' }] })).status).toBe(200)
    expect((await e.share(boss, { path: '/Projects', add: [{ subject: e.person('lee'), role: 'manager' }] })).data.error).toBe('admin_only')
    expect((await e.share(boss, { path: '/Projects', ai_access: false })).status).toBe(200)
    expect((await e.share(boss, { path: '/Projects', ai_access: true })).data.error).toBe('admin_only')
    const lee = await e.as('lee')
    expect((await e.view(lee, '/Projects')).data).toMatchObject({ can_share: false, my_role: 'viewer' })
    // the folder page routes keep their R7 rules: an Editor is not a manager there
    expect((await (await e.as('kim')).call('PUT', `/api/folders/${e.proj.id}/rules`, { subject_type: 'person', subject_id: e.pid('park'), level: 'read' })).status).toBe(403)
  })
})
