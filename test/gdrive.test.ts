// Google Drive import into managed team folders, against a fake Google (test/gdrive-helpers.ts, no network):
// hidden unless configured; the OAuth round trip (state once, the same browser, PKCE); tokens sealed per person and
// revocable; picked files imported through the same write path as an upload (rules, quota, audit, versions, text
// mirror, conflict = rename); Google Docs/Sheets/Slides exported; re-import = a new version; folders only in
// drive.readonly mode; Google's "slow down", expired tokens and the 10 MB export limit handled.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { dataKey, open, seal, SecretBoxError } from '../src/secretbox'
import { googleConfigFromEnv, SCOPE_READONLY } from '../src/gdrive/config'
import { safeName } from '../src/gdrive/importer'
import { metaSet } from '../src/managed/settings'
import { sampleDocx, samplePdf, sampleXlsx } from '../src/samples'
import { gdriveSetup, type GEnv } from './gdrive-helpers'
import { managedSetup } from './managed-helpers'

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

let e: GEnv
type B = InstanceType<GEnv['Browser']>
let kim: B
beforeEach(async () => {
  e = await gdriveSetup()
  kim = await e.as('kim')
  e.g.add({ id: 'doc-plan-0001', name: '분기 계획', mimeType: 'application/vnd.google-apps.document', exports: { [DOCX]: sampleDocx(['분기 계획 초안', 'Q4 매출 목표']) } })
  e.g.add({ id: 'sheet-budget-01', name: 'Budget 2026', mimeType: 'application/vnd.google-apps.spreadsheet', exports: { [XLSX]: sampleXlsx('Sheet1', [['item', 'krw'], ['server', 120000]]) } })
  e.g.add({ id: 'slides-deck-001', name: 'Pitch', mimeType: 'application/vnd.google-apps.presentation', exports: { [PPTX]: new Uint8Array([80, 75, 3, 4, 1, 2, 3]) } })
  e.g.add({ id: 'pdf-contract-01', name: 'contract.pdf', mimeType: 'application/pdf', bytes: samplePdf(['계약서 본문']) })
  e.g.add({ id: 'form-survey-001', name: 'Survey', mimeType: 'application/vnd.google-apps.form' })
  e.g.add({ id: 'folder-team-001', name: 'Team docs', mimeType: 'application/vnd.google-apps.folder' })
})
afterEach(() => e.cleanup())

const names = async (b: B, p: string) => e.names(b, p)

describe('hidden unless configured', () => {
  test('no Google client, or not managed storage: GET says off, every other route 404', async () => {
    const x = await managedSetup()
    try {
      Object.assign(x.w.opts, { google: null })
      const b = await x.as('kim')
      expect((await b.call('GET', '/api/gdrive')).data).toEqual({ enabled: false })
      for (const [m, p] of [['POST', '/api/gdrive/connect'], ['GET', '/api/gdrive/picker'], ['POST', '/api/gdrive/import'], ['DELETE', '/api/gdrive'], ['GET', '/api/gdrive/callback?state=x&code=y'], ['GET', '/api/gdrive/jobs']] as const)
        expect([p, (await b.call(m, p, m === 'GET' || m === 'DELETE' ? undefined : {})).status]).toEqual([p, 404])
    } finally { x.cleanup() }
    metaSet(e.db, 'storage_mode', 'inplace')
    expect((await kim.call('GET', '/api/gdrive')).data).toEqual({ enabled: false })
  })
  test('configuration from the environment (all three needed; the app id from the client id; readonly off by default)', () => {
    expect(googleConfigFromEnv({ GOOGLE_CLIENT_ID: 'x' })).toBeNull()
    const c = googleConfigFromEnv({ GOOGLE_CLIENT_ID: '987-abc.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 's', GOOGLE_API_KEY: 'k' })!
    expect([c.appId, c.readonly]).toEqual(['987', false])
    expect(googleConfigFromEnv({ GOOGLE_CLIENT_ID: '987-a', GOOGLE_CLIENT_SECRET: 's', GOOGLE_API_KEY: 'k', TDRIVE_GDRIVE_READONLY: '1' })!.readonly).toBe(true)
  })
  test('the app page may load Google’s Picker only when the feature is on', async () => {
    const dir = fs.mkdtempSync(path.join(e.dir, 'web-'))
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html>')
    e.w.opts.webDir = dir
    const csp = async () => (await kim.raw('GET', '/')).headers.get('content-security-policy')!
    expect(await csp()).toContain('https://apis.google.com')
    expect((await kim.raw('GET', '/api/gdrive')).headers.get('content-security-policy')).not.toContain('google')
    e.w.opts.google = null
    expect(await csp()).not.toContain('google')
  })
})

describe('connecting', () => {
  test('the round trip: Google’s consent URL (drive.file, offline, PKCE), back with the code, tokens sealed, audited', async () => {
    const r = await e.connect(kim)
    expect(r.url.origin + r.url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(r.url.searchParams.get('scope')).toBe('openid email https://www.googleapis.com/auth/drive.file')
    expect(r.url.searchParams.get('redirect_uri')).toBe('http://drive.test/api/gdrive/callback')
    expect([r.url.searchParams.get('access_type'), r.url.searchParams.get('code_challenge_method')]).toEqual(['offline', 'S256'])
    expect(r.back.status).toBe(303)
    expect(r.back.location).toBe('/#/files?path=%2F%ED%8C%80&gdrive=connected')
    expect(r.back.setCookie).toContain('Max-Age=0')
    const s = (await kim.call('GET', '/api/gdrive')).data
    expect(s).toMatchObject({ enabled: true, connected: true, email: 'kim@gmail.example', readonly: false, folders: false })
    // nothing Google handed out is stored in the clear
    const row = e.db.query<{ refresh_sealed: string; access_sealed: string }, []>('SELECT refresh_sealed, access_sealed FROM gdrive_connections').get()!
    expect(row.refresh_sealed).toStartWith('sb1.')
    for (const t of [...e.g.refresh, ...e.g.access]) expect(fs.readFileSync(path.join(e.dir, 'store.db')).includes(Buffer.from(t))).toBe(false)
    expect(fs.statSync(path.join(e.dir, 'keys', 'data.key')).mode & 0o777).toBe(0o600)
    expect(e.auditRows().map((x) => x.command).filter((c) => c.startsWith('gdrive'))).toEqual(['gdrive connect started', 'gdrive connected (kim@gmail.example; scope drive.file)'])
  })
  test('the callback needs the state once and the browser that started it; a refusal at Google; an unticked Drive box', async () => {
    const noCookie = await e.connect(kim, { cookie: null })
    expect(noCookie.back.location).toEndWith('gdrive=expired')
    const other = await e.connect(kim, { cookie: 'someone-elses-browser' })
    expect(other.back.location).toEndWith('gdrive=expired')
    const ok = await e.connect(kim)
    expect(ok.back.location).toEndWith('gdrive=connected')
    // replayed: used once
    expect((await e.callback(ok.state, e.g.code('x'), ok.cookie)).location).toEndWith('gdrive=expired')
    const lee = await e.as('lee')
    const r = await lee.call('POST', '/api/gdrive/connect', {})
    const st = new URL(r.data.url).searchParams.get('state')!
    const ck = /tdrive_gdrive=([^;]+)/.exec(r.headers.get('set-cookie')!)![1]!
    expect((await e.callback(st, null, ck, '&error=access_denied')).location).toEndWith('gdrive=denied')
    e.g.scope = 'openid email'
    const r2 = await lee.call('POST', '/api/gdrive/connect', {})
    const u2 = new URL(r2.data.url)
    expect((await e.callback(u2.searchParams.get('state')!, e.g.code(u2.searchParams.get('code_challenge')!), /tdrive_gdrive=([^;]+)/.exec(r2.headers.get('set-cookie')!)![1])).location)
      .toBe('/#/settings?gdrive=no_scope')
    expect((await lee.call('GET', '/api/gdrive')).data.connected).toBe(false)
  })
  test('a code stolen from someone else’s round trip does not connect (PKCE)', async () => {
    const r = await kim.call('POST', '/api/gdrive/connect', {})
    const u = new URL(r.data.url)
    const ck = /tdrive_gdrive=([^;]+)/.exec(r.headers.get('set-cookie')!)![1]
    const wrong = e.g.code('a-different-challenge')
    expect((await e.callback(u.searchParams.get('state')!, wrong, ck)).location).toEndWith('gdrive=failed')
  })
  test('picker: the person’s own short-lived token, the browser key, the app id; not connected → 409', async () => {
    expect((await kim.call('GET', '/api/gdrive/picker')).status).toBe(409)
    await e.connect(kim)
    const p = (await kim.call('GET', '/api/gdrive/picker')).data
    expect(e.g.access.has(p.access_token)).toBe(true)
    expect([p.api_key, p.app_id, p.folders]).toEqual(['AIza-test-key', '123456789012', false])
  })
  test('an expired access token is refreshed; a revoked grant marks the connection broken', async () => {
    await e.connect(kim)
    e.db.query('UPDATE gdrive_connections SET access_expires = 0').run()
    const before = e.g.calls.filter((c) => c.startsWith('POST /token')).length
    const p = (await kim.call('GET', '/api/gdrive/picker')).data
    expect(e.g.calls.filter((c) => c.startsWith('POST /token')).length).toBe(before + 1)
    expect(e.g.access.has(p.access_token)).toBe(true)
    e.g.refreshFails = true
    e.db.query('UPDATE gdrive_connections SET access_expires = 0').run()
    expect((await kim.call('GET', '/api/gdrive/picker')).status).toBe(409)
    expect((await kim.call('GET', '/api/gdrive')).data).toMatchObject({ connected: false, broken: true })
  })
  test('disconnect: the grant is revoked at Google, the tokens are gone, the next import needs a new connection', async () => {
    await e.connect(kim)
    const refresh = [...e.g.refresh][0]!
    expect((await kim.call('DELETE', '/api/gdrive')).data).toEqual({ ok: true, disconnected: true })
    expect(e.g.revoked).toEqual([refresh])
    expect(e.db.query('SELECT count(*) AS n FROM gdrive_connections').get()).toEqual({ n: 0 })
    expect((await kim.call('POST', '/api/gdrive/import', { path: '/팀', items: [{ id: 'doc-plan-0001' }] })).data.error).toBe('not_connected')
    expect(e.auditRows().map((x) => x.command)).toContain('gdrive disconnected (grant revoked at Google)')
  })
  test('sealed values open only with this server’s key, for this purpose (one person’s token is useless in another’s row)', () => {
    const k = dataKey(e.dir)
    const s = seal(k, 'gdrive:refresh:2', 'secret')
    expect(open(k, 'gdrive:refresh:2', s)).toBe('secret')
    expect(() => open(k, 'gdrive:refresh:3', s)).toThrow(SecretBoxError)
    expect(() => open(Buffer.alloc(32, 1), 'gdrive:refresh:2', s)).toThrow(SecretBoxError)
    expect(() => open(k, 'gdrive:refresh:2', s.slice(0, -2) + (s.at(-2) === 'A' ? 'B' : 'A') + s.slice(-1))).toThrow(SecretBoxError)
    process.env.TDRIVE_SECRET_KEY = Buffer.alloc(32, 7).toString('hex')
    try { expect(dataKey('/nonexistent')).toEqual(Buffer.alloc(32, 7)) } finally { delete process.env.TDRIVE_SECRET_KEY }
  })
})

describe('importing', () => {
  beforeEach(async () => { await e.connect(kim) })
  test('Docs/Sheets/Slides exported as docx/xlsx/pptx, other files as they are; text extraction like any upload; audited', async () => {
    const j = (await e.importAndWait(kim, '/팀', ['doc-plan-0001', 'sheet-budget-01', 'slides-deck-001', 'pdf-contract-01'])).data
    expect([j.state, j.total, j.imported, j.failed]).toEqual(['done', 4, 4, 0])
    expect(await names(kim, '/팀')).toEqual(['Budget 2026.xlsx', 'Pitch.pptx', 'contract.pdf', '분기 계획.docx'])
    expect((await e.text(kim, '/팀/분기 계획.docx')).data.text).toContain('Q4 매출 목표')
    expect((await e.text(kim, '/팀/Budget 2026.xlsx')).data.text).toContain('server')
    const pdf = await kim.raw('GET', '/api/files/download?path=' + encodeURIComponent('/팀/contract.pdf'))
    expect(Buffer.from(await pdf.arrayBuffer()).equals(Buffer.from(e.g.files.get('pdf-contract-01')!.bytes!))).toBe(true)
    const rows = e.auditRows().map((x) => x.command)
    expect(rows).toContain('gdrive import into /팀: 4 picked (drive doc-plan-0001,sheet-budget-01,slides-deck-001,pdf-contract-01)')
    expect(rows.some((c) => /^files gdrive-import \/팀\/분기 계획\.docx \(\d+ bytes, sha256 [0-9a-f]{64}\)$/.test(c))).toBe(true)
    expect(rows).toContain('gdrive import into /팀 finished: 4 new, 0 updated, 0 unchanged, 0 failed')
    // who wrote it: kim, like an upload
    const v = await kim.call('GET', '/api/files/versions?path=' + encodeURIComponent('/팀/contract.pdf'))
    expect(v.data.versions[0].by).toBe('kim')
  })
  test('importing the same Google file again: unchanged → nothing; changed → a new version of the same file, even renamed', async () => {
    await e.importAndWait(kim, '/팀', ['doc-plan-0001'])
    let j = (await e.importAndWait(kim, '/팀', ['doc-plan-0001'])).data
    expect([j.unchanged, j.imported, j.items[0].path]).toEqual([1, 0, '/팀/분기 계획.docx'])
    expect((await kim.call('POST', '/api/files/rename', { path: '/팀/분기 계획.docx', name: 'plan.docx' })).status).toBe(200)
    const f = e.g.files.get('doc-plan-0001')!
    Object.assign(f, { modifiedTime: '2026-10-20T00:00:00.000Z', version: '7', exports: { [DOCX]: sampleDocx(['개정판']) } })
    j = (await e.importAndWait(kim, '/팀', ['doc-plan-0001'])).data
    expect([j.updated, j.items[0].path, j.items[0].version]).toEqual([1, '/팀/plan.docx', 2])
    expect(await names(kim, '/팀')).toEqual(['plan.docx'])
    expect((await e.text(kim, '/팀/plan.docx')).data.text).toContain('개정판')
    const v = await kim.call('GET', '/api/files/versions?path=' + encodeURIComponent('/팀/plan.docx'))
    expect(v.data.versions.map((x: { version: number }) => x.version)).toEqual([2, 1])
    // into another folder it is another file; deleted in Trina → imported fresh
    await e.importAndWait(kim, '/내폴더', ['doc-plan-0001'])
    expect(await names(kim, '/내폴더')).toEqual(['분기 계획.docx'])
    await kim.call('POST', '/api/files/delete', { paths: ['/팀/plan.docx'] })
    j = (await e.importAndWait(kim, '/팀', ['doc-plan-0001'])).data
    expect([j.imported, j.items[0].path]).toEqual([1, '/팀/분기 계획.docx'])
  })
  test('a name that is taken by another file: " (1)"', async () => {
    expect((await e.upload(kim, '/팀', 'contract.pdf', 'mine')).status).toBe(200)
    const j = (await e.importAndWait(kim, '/팀', ['pdf-contract-01'])).data
    expect(j.items[0].path).toBe('/팀/contract (1).pdf')
  })
  test('the person’s rules decide: read-only folder 403, hidden 404, in-place 403, nonexistent 404 (before anything is fetched)', async () => {
    const calls = e.g.calls.length
    for (const [f, s] of [['/공지', 403], ['/임원', 404], ['/프로젝트', 403], ['/없는곳', 404]] as const)
      expect([f, (await kim.call('POST', '/api/gdrive/import', { path: f, items: [{ id: 'doc-plan-0001' }] })).status]).toEqual([f, s])
    expect(e.g.calls.length).toBe(calls)
    expect((await kim.call('POST', '/api/gdrive/import', { path: '/팀', items: [] })).status).toBe(400)
    expect((await kim.call('POST', '/api/gdrive/import', { path: '/팀', items: [{ id: '../etc' }] })).status).toBe(400)
    // a job is the person's own
    const j = (await e.importAndWait(kim, '/팀', ['pdf-contract-01'])).data
    expect((await (await e.as('lee')).call('GET', `/api/gdrive/jobs/${j.id}`)).status).toBe(404)
  })
  test('rules changed while importing: each file is judged again', async () => {
    const { setRule } = await import('../src/store')
    setRule(e.db, e.team.path, '@전체', 'read')
    const j = (await e.importAndWait(kim, '/내폴더', ['pdf-contract-01'])).data
    expect(j.imported).toBe(1)
    const r = await kim.call('POST', '/api/gdrive/import', { path: '/팀', items: [{ id: 'pdf-contract-01' }] })
    expect(r.status).toBe(403)
  })
  test('per-item failures: forms and folders (drive.file), the quota, a file gone at Google; the others still come in', async () => {
    metaSet(e.db, 'storage_quota', String(e.g.files.get('pdf-contract-01')!.bytes!.length + 50))
    e.g.add({ id: 'pdf-big-000001', name: 'big.pdf', mimeType: 'application/pdf', bytes: new Uint8Array(10_000) })
    const j = (await e.importAndWait(kim, '/팀', ['form-survey-001', 'folder-team-001', 'pdf-contract-01', 'pdf-big-000001', 'missing-file-01'])).data
    const by = Object.fromEntries(j.items.map((i: { drive_id: string; status: string; error?: string }) => [i.drive_id, i.error ?? i.status]))
    expect(by).toEqual({ 'form-survey-001': 'not_exportable', 'folder-team-001': 'folder_needs_readonly', 'pdf-contract-01': 'imported', 'pdf-big-000001': 'quota_exceeded', 'missing-file-01': 'notFound' })
    expect(e.auditRows().map((x) => x.command)).toContain('gdrive import into /팀 finished: 1 new, 0 updated, 0 unchanged, 4 failed')
    // nothing half-written stays in staging
    expect(fs.readdirSync(path.join(e.dir, 'files', '.trina-drive', 'uploads'))).toEqual([])
  })
  test('Google says slow down (429): retried; an export over 10 MB: the file’s own export link', async () => {
    e.g.failNext = { match: /pdf-contract-01/, status: 429, reason: 'rateLimitExceeded', times: 2 }
    e.g.bigExports.add('doc-plan-0001')
    const j = (await e.importAndWait(kim, '/팀', ['pdf-contract-01', 'doc-plan-0001'])).data
    expect([j.imported, j.failed]).toEqual([2, 0])
    expect(e.g.calls.some((c) => c.startsWith('GET /export/doc-plan-0001'))).toBe(true)
  })
  test('an access token that expires in the middle: refreshed once, the import goes on', async () => {
    e.g.access.clear()
    const j = (await e.importAndWait(kim, '/팀', ['pdf-contract-01'])).data
    expect(j.imported).toBe(1)
  })
  test('names Google allows and Trina does not are made safe', () => {
    expect(safeName('a/b\\c')).toBe('a_b_c')
    expect(safeName('.DS_Store')).toBe('_.DS_Store')
    expect(safeName('~$lock')).toBe('_~$lock')
    expect(safeName('  ')).toBe('Untitled')
    expect(safeName('Report', 'docx')).toBe('Report.docx')
    expect(safeName('Report.DOCX', 'docx')).toBe('Report.DOCX')
    expect(Buffer.byteLength(safeName('가'.repeat(200), 'docx'))).toBeLessThanOrEqual(255)
    expect(safeName('가'.repeat(200), 'docx')).toEndWith('.docx')
  })
})

describe('drive.readonly mode (design partners): whole folders, recursively', () => {
  test('a picked folder comes in with its subfolders; off by default', async () => {
    e.w.opts.google = { ...e.w.opts.google!, readonly: true }
    e.g.scope += ' ' + SCOPE_READONLY
    const c = await e.connect(kim)
    expect(c.url.searchParams.get('scope')).toContain(SCOPE_READONLY)
    expect((await kim.call('GET', '/api/gdrive')).data.folders).toBe(true)
    e.g.add({ id: 'kid-doc-000001', name: 'Notes', mimeType: 'application/vnd.google-apps.document', parents: ['folder-team-001'], exports: { [DOCX]: sampleDocx(['notes']) } })
    e.g.add({ id: 'kid-folder-0001', name: 'Sub', mimeType: 'application/vnd.google-apps.folder', parents: ['folder-team-001'] })
    e.g.add({ id: 'grandkid-pdf-01', name: 'deep.pdf', mimeType: 'application/pdf', parents: ['kid-folder-0001'], bytes: samplePdf(['deep']) })
    const j = (await e.importAndWait(kim, '/팀', ['folder-team-001'])).data
    expect([j.total, j.imported, j.failed]).toEqual([2, 2, 0])
    expect(await names(kim, '/팀/Team docs')).toEqual(['Notes.docx', 'Sub'])
    expect(await names(kim, '/팀/Team docs/Sub')).toEqual(['deep.pdf'])
    // again: the folders are reused, the files unchanged
    const again = (await e.importAndWait(kim, '/팀', ['folder-team-001'])).data
    expect([again.unchanged, again.imported]).toEqual([2, 0])
  })
})
