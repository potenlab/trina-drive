// End-to-end sharing scenarios over the real handlers (plan §5 / §10.5): S12 a group's folder hidden from everyone else
// on every path, S14 restrict access here, S17 revoking a folder share takes effect on the next request everywhere,
// S18 "No AI" — and hidden == nonexistent in the web list, stat, download, search, Shared with me, the share dialog,
// WebDAV, the AI's bash (ls / cat / grep -r / find / du) and Google Drive import.
import { afterEach, describe, expect, test } from 'bun:test'
import { PASSWORD } from './web-helpers'
import { handleWeb } from '../src/web/server'
import { gdriveSetup } from './gdrive-helpers'
import { shareSetup, type ShareEnv } from './share-helpers'

let e: ShareEnv | null = null
afterEach(() => { e?.cleanup(); e = null })
const q = encodeURIComponent

/** A WebDAV client for a person (an app password made through the API). */
async function dav(x: ShareEnv, name: string) {
  const b = await x.as(name)
  const r = await b.call('POST', '/api/me/app-passwords', { name: 'Mac', password: PASSWORD })
  expect(r.status).toBe(200)
  const auth = 'Basic ' + Buffer.from(`${name}:${r.data.password}`).toString('base64')
  return async (method: string, p: string, headers: Record<string, string> = {}, body?: string) => {
    const res = await handleWeb(x.w, new Request('https://drive.test' + p, { method, headers: { authorization: auth, ...headers }, body }), '10.0.0.1')
    return { status: res.status, text: await res.text() }
  }
}
const davPath = (p: string) => '/dav' + p.split('/').map(encodeURIComponent).join('/')

/** Everything a person and their AI can reach about `folder` / `file` (true = present). */
async function reach(x: ShareEnv, who: string, folder: string, file: string, canary: string) {
  const b = await x.as(who)
  const d = await dav(x, who)
  const name = folder.slice(1)
  const tops = (await b.call('GET', '/api/files?path=/')).data.entries?.map((y: { name: string }) => y.name) ?? []
  // the AI's view in one bash call: ls, cat, grep -r, find, du (sections split by a marker)
  const ai = (await x.agent(who, `ls /; echo @@; cat ${file}; echo @@; grep -r ${canary} / ; echo @@; find / -name "*.md"; echo @@; du ${folder} 2>&1; echo @@`)).split('@@')
  return {
    list: (await b.call('GET', `/api/files?path=${q(folder)}`)).status,
    stat: (await b.call('GET', `/api/files/stat?path=${q(file)}`)).status,
    download: (await b.call('GET', `/api/files/download?path=${q(file)}`)).status,
    top: tops.includes(name),
    search: (await x.search(b, file.slice(file.lastIndexOf('/') + 1).replace(/\.md$/, ''))).includes(file),
    shared: (await x.sharedWithMe(b)).includes(folder),
    dialog: (await x.view(b, folder)).status,
    davList: (await d('PROPFIND', '/dav/', { depth: '1' })).text.includes(`/dav/${q(name)}/`),
    davGet: (await d('GET', davPath(file))).status,
    aiLs: ai[0]!.split(/\s+/).includes(name),
    aiCat: ai[1]!.includes(canary),
    aiGrep: ai[2]!.includes(canary),
    aiFind: ai[3]!.includes(file),
    aiDu: !/No such file|not found/i.test(ai[4]!) && ai[4]!.includes(folder),
  }
}
const NOTHING = { list: 404, stat: 404, download: 404, top: false, search: false, shared: false, dialog: 404, davList: false, davGet: 404, aiLs: false, aiCat: false, aiGrep: false, aiFind: false, aiDu: false }

describe('S12: /재무 shared with the 재무 group as Viewer', () => {
  test('kim (not in 재무) finds nothing on any path, exactly like a folder that does not exist; park (재무) finds it', async () => {
    e = await shareSetup()
    expect(await reach(e, 'kim', '/재무', '/재무/결산.md', 'CANARY-FIN-7731')).toEqual(NOTHING)
    const park = await reach(e, 'park', '/재무', '/재무/결산.md', 'CANARY-FIN-7731')
    expect(park).toMatchObject({ list: 200, stat: 200, download: 200, top: true, search: true, shared: true, dialog: 200, davList: true, davGet: 200, aiLs: true, aiCat: true, aiGrep: true, aiFind: true })
    // the 404 bodies of a hidden and a nonexistent folder are the same bytes, on the web and on WebDAV
    const kim = await e.as('kim')
    expect(await (await kim.raw('GET', `/api/files?path=${q('/재무')}`)).text()).toBe(await (await kim.raw('GET', `/api/files?path=${q('/없음')}`)).text())
    const d = await dav(e, 'kim')
    expect(await d('GET', davPath('/재무/결산.md'))).toEqual(await d('GET', davPath('/없음/결산.md')))
    // the AI's error for a hidden path is the one for a missing path (same text, same exit)
    expect((await e.agent('kim', 'cat /재무/결산.md; echo "exit $?"')).replace('재무', 'X')).toBe((await e.agent('kim', 'cat /없음/결산.md; echo "exit $?"')).replace('없음', 'X'))
  })

  test('given to kim through the share dialog: on every path at once; Google Drive import into it follows too', async () => {
    e = await shareSetup()
    const dion = await e.as('dion')
    expect((await e.share(dion, { path: '/재무', add: [{ subject: e.person('kim'), role: 'viewer' }] })).status).toBe(200)
    expect(await reach(e, 'kim', '/재무', '/재무/결산.md', 'CANARY-FIN-7731')).toMatchObject({ list: 200, download: 200, shared: true, davGet: 200, aiCat: true, aiGrep: true })
  })
})

describe('S17: revoking a folder share', () => {
  test('the next request on every path is "nothing", other access stays', async () => {
    e = await shareSetup()
    const dion = await e.as('dion')
    await e.share(dion, { path: '/재무', add: [{ subject: e.person('kim'), role: 'editor' }] })
    expect((await reach(e, 'kim', '/재무', '/재무/결산.md', 'CANARY-FIN-7731')).aiCat).toBe(true)
    // the same session, the same token, the same app password — no new sign-in
    const kim = await e.as('kim')
    const d = await dav(e, 'kim')
    expect((await e.share(dion, { path: '/재무', set: [{ subject: e.person('kim'), role: 'remove' }] })).status).toBe(200)
    expect((await kim.call('GET', `/api/files/download?path=${q('/재무/결산.md')}`)).status).toBe(404)
    expect((await d('GET', davPath('/재무/결산.md'))).status).toBe(404)
    expect(await e.agent('kim', 'cat /재무/결산.md')).not.toContain('CANARY')
    expect(await reach(e, 'kim', '/재무', '/재무/결산.md', 'CANARY-FIN-7731')).toEqual(NOTHING)
    // kim keeps everything else
    expect(await e.agent('kim', 'cat /Projects/readme.md')).toContain('CANARY-PRJ-1001')
    expect(await reach(e, 'park', '/재무', '/재무/결산.md', 'CANARY-FIN-7731')).toMatchObject({ aiCat: true, list: 200 })
  })

  test('Google Drive import: a folder no longer shared answers like one that does not exist (nothing fetched)', async () => {
    const g = await gdriveSetup()
    try {
      const kim = await g.as('kim')
      await g.connect(kim)
      const dion = await g.as('dion')
      const { createManagedFolder } = await import('../src/managed/folders')
      const f = createManagedFolder(g.db, g.dir, { name: '재무' })
      await dion.call('GET', `/api/share?path=${q('/재무')}`)
      expect((await dion.call('POST', '/api/share', { path: '/재무', add: [{ subject: { type: 'person', id: g.pid('kim') }, role: 'editor' }] })).status).toBe(200)
      expect((await kim.call('POST', '/api/gdrive/import', { path: '/재무', items: [{ id: 'doc-plan-0001' }] })).status).toBe(200)
      expect((await dion.call('POST', '/api/share', { path: '/재무', set: [{ subject: { type: 'person', id: g.pid('kim') }, role: 'remove' }] })).status).toBe(200)
      const calls = g.g.calls.length
      const hidden = await kim.call('POST', '/api/gdrive/import', { path: '/재무', items: [{ id: 'doc-plan-0001' }] })
      const none = await kim.call('POST', '/api/gdrive/import', { path: '/없음', items: [{ id: 'doc-plan-0001' }] })
      expect([hidden.status, hidden.data]).toEqual([none.status, none.data])
      expect(hidden.status).toBe(404)
      expect(g.g.calls.length).toBe(calls)
      expect(f.id).toBeGreaterThan(0)
    } finally { g.cleanup() }
  })
})

describe('S14: /Projects Anyone in Trina, /Projects/비밀 restricted here keeping two', () => {
  test('the loss is shown before, the dropped lose access at once, the kept and the managers above stay', async () => {
    e = await shareSetup()
    const boss = await e.as('boss')
    // the dialog shows what comes from above: these are the ones restrict-here would drop unless kept
    const before = (await e.view(boss, '/Projects/비밀')).data
    expect(before.general.effective).toMatchObject({ role: 'viewer', from_path: '/Projects' })
    expect(before.entries.filter((x: { source: string; role: string }) => x.source === 'inherited' && x.role !== 'manager').map((x: { subject: { name: string } }) => x.subject.name)).toEqual(['kim'])
    // keep kim (inherited editor) and add lee first (direct): Anyone in Trina is dropped
    await e.share(boss, { path: '/Projects/비밀', add: [{ subject: e.person('lee'), role: 'viewer' }] })
    const r = await e.share(boss, { path: '/Projects/비밀', restrict_here: { on: true, keep: [e.person('kim')] } })
    expect(r.status).toBe(200)
    expect(r.data.entries.map((x: { subject: { name: string }; role: string }) => `${x.subject.name}:${x.role}`).sort()).toEqual(['boss:manager', 'kim:editor', 'lee:viewer'])
    for (const who of ['park', 'dion']) {
      const s = await reach(e, who, '/Projects', '/Projects/비밀/plan.md', 'CANARY-SEC-4242')
      expect([who, s.stat, s.download, s.davGet, s.aiCat, s.aiGrep]).toEqual([who, 404, 404, 404, false, false])
    }
    for (const who of ['kim', 'lee', 'boss']) expect([who, (await reach(e, who, '/Projects', '/Projects/비밀/plan.md', 'CANARY-SEC-4242')).aiCat]).toEqual([who, true])
    // the admin still manages sharing there (never reads it by that alone)
    expect((await e.view(await e.as('dion'), '/Projects/비밀')).data).toMatchObject({ can_manage: true, my_role: 'admin' })
    // turning it off again brings Anyone in Trina back (a manager's widening; no AI-draft copies here)
    expect((await e.share(boss, { path: '/Projects/비밀', restrict_here: { on: false } })).data.general.effective).toMatchObject({ role: 'viewer' })
  })
})

describe('S18: "No AI" on /인사관리', () => {
  test('people with access open it on the web and WebDAV; no token sees it; a manager can only turn it on', async () => {
    e = await shareSetup()
    const lee = await e.as('lee')
    expect((await lee.call('GET', `/api/files/download?path=${q('/인사관리/급여.md')}`)).status).toBe(200)
    const d = await dav(e, 'lee')
    expect((await d('GET', davPath('/인사관리/급여.md'))).text).toContain('CANARY-HR-5150') // a mount is the person (finding 16)
    expect(await e.agent('lee', 'ls /; cat /인사관리/급여.md; grep -r CANARY-HR / ; echo end')).not.toContain('CANARY-HR')
    expect(await e.agent('lee', 'ls /')).not.toContain('인사관리')
    expect((await e.view(lee, '/인사관리')).data.ai).toEqual({ no_ai: true })
    // a manager (not admin): can turn it on elsewhere, never off
    const dion = await e.as('dion')
    await dion.call('PUT', `/api/folders/${e.hr.id}/managers/${e.pid('lee')}`)
    expect((await e.share(lee, { path: '/인사관리', ai_access: true })).data.error).toBe('admin_only')
    const off = await e.share(dion, { path: '/인사관리', ai_access: true })
    expect(off.status).toBe(200)
    expect(await e.agent('lee', 'cat /인사관리/급여.md')).toContain('CANARY-HR-5150')
    // turning it off is told to the managers and the admin (R9)
    expect(e.db.query<{ kind: string }, [number]>("SELECT kind FROM notices WHERE person_id = ? AND kind = 'no_ai_off'").all(e.pid('lee'))).toEqual([{ kind: 'no_ai_off' }])
    expect((await e.share(lee, { path: '/인사관리', ai_access: false })).status).toBe(200)
    expect(await e.agent('lee', 'cat /인사관리/급여.md')).not.toContain('CANARY-HR-5150')
  })
})
