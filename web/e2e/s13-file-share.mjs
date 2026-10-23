// S13 (plan 10, A2 file sharing in the drive UI): lee (Manager of /프로젝트) shares one file of /프로젝트/비밀 — a folder
// only lee reads — with mina as Viewer, from the row's menu; the dialog offers Viewer/Editor only, says which folder
// names mina will see, and has no folder settings. Share is also on the row (hover) and in the detail panel.
// mina: Shared with me lists the file; it opens picked in /프로젝트/비밀, which shows that file alone (a bare path);
// she downloads it, sees the current version only (a file-only Viewer), and cannot share it. Recent lists it.
// S49 (hidden == nonexistent, in the UI): once lee takes the share back, mina's dialog and folder read exactly like a
// path that does not exist, with no name from the request in the message; the API answers byte for byte the same.
// Approvals: a share request, an AI draft and a skill version are labelled apart (the inbox through a stand-in).
import { apiAs, check, shot, signedIn } from './lib.mjs'

const enc = encodeURIComponent
const DIR = '/프로젝트/비밀', FILE = DIR + '/계약.docx'

export async function s13(browser, fx) {
  console.log('S13 file share (lee → mina, Viewer), S49 hidden == missing, Recent, approval kinds')
  const lee = await signedIn(browser, fx, 'lee')
  await lee.goto(fx.base + '/#/files?p=' + enc(DIR))
  // a second version, so the history holds something a file-only Viewer must not see
  const csrf = (await (await lee.request.get(fx.base + '/api/session')).json()).csrf
  const up = await lee.request.post(`${fx.base}/api/files/upload?path=${enc(DIR)}&conflict=replace`, {
    headers: { origin: fx.base, 'x-csrf-token': csrf }, multipart: { file: { name: '계약.docx', mimeType: 'application/octet-stream', buffer: Buffer.from('docx v2') } } })
  check(up.status() < 300, 'lee uploaded a second version of 계약.docx')
  check(await lee.locator('.sb-nav', { hasText: 'My files' }).count() === 0, 'self-hosted: no My files in the sidebar')
  check(await lee.locator('.sb-item[href="#/recent"]').count() === 1, 'Recent is in the sidebar')

  const row = lee.locator('.fv-items > li', { hasText: '계약.docx' })
  await row.click({ button: 'right' })
  await lee.locator('.fv-menu button', { hasText: 'Share' }).click()
  await lee.waitForSelector('.sd-body')
  check((await lee.locator('.sd-head h2').textContent()).includes('계약.docx'), 'the file’s Share opens the dialog for that file')
  check((await lee.locator('.sd-warn', { hasText: 'folder names on the way' }).textContent()).includes(DIR), 'it says the people added will see the folder names /프로젝트/비밀')
  check(await lee.locator('.sd-settings').count() === 0, 'no folder settings (Editors can share, AI) for a file')
  check(await lee.locator('.sd-entry', { hasText: 'lee' }).locator('select').count() === 0, 'the folder’s Manager is listed as inherited, not editable')
  await lee.fill('.sd-combo input', 'mina')
  await lee.locator('.sd-options li', { hasText: 'mina' }).click()
  const roles = await lee.locator('.sd-add-row .sd-role option').allTextContents()
  check(JSON.stringify(roles) === JSON.stringify(['Viewer', 'Editor']), `a file has Viewer and Editor only (${roles.join(', ')})`)
  await lee.locator('.sd-add-foot button', { hasText: 'Share' }).click()
  await lee.locator('.sd-note', { hasText: 'Access updated.' }).waitFor()
  check(await lee.locator('.sd-entry', { hasText: 'mina' }).locator('.sd-role').inputValue() === 'viewer', 'mina is a Viewer of the file')
  await shot(lee, 's13-file-share-1440-light')
  await lee.keyboard.press('Escape')
  await lee.locator('.sd').waitFor({ state: 'detached' })
  // the same dialog from the detail panel and from the row's own Share icon
  await row.click()
  await lee.locator('.fv-detail .fv-detail-share').click()
  check(await lee.locator('.sd-head h2', { hasText: '계약.docx' }).waitFor().then(() => true, () => false), 'Share in the detail panel opens it')
  await lee.keyboard.press('Escape')
  await row.hover()
  await row.locator('.fv-row-share').click()
  check(await lee.locator('.sd-head h2', { hasText: '계약.docx' }).waitFor().then(() => true, () => false), 'the row’s Share icon opens it')
  await lee.keyboard.press('Escape')

  // ---- mina ----
  const mina = await signedIn(browser, fx, 'mina')
  await mina.goto(fx.base + '/#/shared')
  await mina.waitForSelector('table.swm')
  const sw = mina.locator('table.swm tr', { hasText: '계약.docx' })
  check(await sw.count() === 1 && (await sw.textContent()).includes('Viewer') && (await sw.textContent()).includes('lee'), 'Shared with me lists the file: Viewer, shared by lee')
  await sw.locator('a.swm-name').click()
  await mina.waitForSelector('.fv-detail')
  check(decodeURIComponent(mina.url()).includes('p=' + DIR), 'the file opens picked in its folder')
  check(await mina.locator('.fv-items > li').count() === 1, '/프로젝트/비밀 shows that one file, no siblings')
  check(await mina.locator('.fv-note', { hasText: 'only as the way' }).count() === 1, '…and says the folder itself is only a way through')
  const dl = await mina.request.get(fx.base + '/api/files/download?path=' + enc(FILE))
  check(dl.status() === 200, 'mina downloads it')
  await mina.locator('.fv-versions li').first().waitFor()
  check(await mina.locator('.fv-versions li').count() === 1 && await mina.locator('.fv-versions-only').count() === 1, 'versions: the current one only, with the reason (a file-only Viewer)')
  const old = await mina.request.get(`${fx.base}/api/files/versions/download?path=${enc(FILE)}&v=1`)
  check(old.status() === 404, 'an earlier version is not there for her (404)')
  await mina.locator('.fv-detail .fv-detail-share').click()
  await mina.locator('.sd-ro').waitFor()
  check((await mina.locator('.sd-ro').textContent()).includes('can open this file but not share it'), 'her dialog is read-only and says why')
  await shot(mina, 's13-mina-file-1440-light')
  await mina.keyboard.press('Escape')
  await mina.goto(fx.base + '/#/recent')
  await mina.waitForSelector('table.rc, .empty-state')
  const rc = mina.locator('table.rc tr', { hasText: '계약.docx' })
  check(await rc.count() === 1 && (await rc.textContent()).includes('You opened'), 'Recent lists the file she opened')
  check(await mina.locator('table.rc .rc-group', { hasText: 'Today' }).count() === 1, 'Recent groups by day (Today)')

  // ---- S49: lee takes it back; mina's views read like a path that does not exist ----
  await mina.goto(fx.base + '/#/files?p=' + enc(DIR) + '&s=' + enc(FILE))
  await mina.waitForSelector('.fv-detail')
  const minaId = (await apiAs(lee, fx, 'GET', '/directory')).body.people.find((p) => p.name === 'mina').id
  const back = await apiAs(lee, fx, 'POST', '/share', { path: FILE, set: [{ subject: { type: 'person', id: minaId }, role: 'remove' }] })
  check(back.status === 200, 'lee removed mina’s share')
  await mina.locator('.fv-detail .fv-detail-share').click()
  await mina.locator('.sd .error').waitFor()
  const said = await mina.locator('.sd .error').textContent()
  check(said === 'This isn’t there, or you can’t open it.' && !said.includes('계약') && !said.includes('비밀'), `S49: the dialog says only "${said}"`)
  await mina.keyboard.press('Escape')
  const hidden = await mina.request.get(fx.base + '/api/share?path=' + enc(FILE))
  const missing = await mina.request.get(fx.base + '/api/share?path=' + enc(DIR + '/없음.docx'))
  check(hidden.status() === 404 && (await hidden.text()) === (await missing.text()), 'S49: GET /api/share on the revoked file = on a missing one, byte for byte')
  await mina.goto(fx.base + '/#/files?p=' + enc(DIR))
  await mina.waitForSelector('.fv-state')
  const t1 = await mina.locator('.fv-state p').textContent()
  await mina.goto(fx.base + '/#/files?p=' + enc('/프로젝트/없음'))
  await mina.waitForSelector('.fv-state')
  check(t1 === await mina.locator('.fv-state p').textContent(), 'S49: the folder now reads like one that does not exist')
  await mina.goto(fx.base + '/#/shared')
  await mina.waitForSelector('table.swm, .empty-state')
  check(await mina.locator('table.swm tr', { hasText: '계약.docx' }).count() === 0, 'S49: gone from Shared with me at once')
  check(mina.errors.length === 0, 'mina: no page errors' + (mina.errors.length ? ': ' + mina.errors.join(' | ') : ''))
  await mina.context().close()

  // ---- Approvals: three kinds, labelled apart (the inbox answers through a stand-in) ----
  await approvalsStandIn(lee)
  await lee.goto(fx.base + '/#/approvals')
  await lee.locator('.ap-list li').first().waitFor()
  const share = lee.locator('.ap-list li.ap-share')
  check(await share.locator('.badge', { hasText: 'Share request' }).count() === 1 && (await share.locator('strong').textContent()) === '/프로젝트', 'Approvals: a share request is labelled and named by its folder (not /프로젝트/프로젝트)')
  check(await lee.locator('.ap-list li.ap-promote .badge', { hasText: 'AI draft into a folder' }).count() === 1, 'Approvals: an AI draft is labelled')
  await lee.locator('.ap-skills li').first().waitFor()
  check(await lee.locator('.ap-skills .badge', { hasText: 'Skill version' }).count() >= 1, 'Approvals: a skill change is labelled Skill version')
  await shot(lee, 's13-approvals-1440-light')
  await share.locator('a').click()
  await lee.locator('.ap-change li').first().waitFor()
  const lines = await lee.locator('.ap-change li').allTextContents()
  check(lines.includes('Give Editor access to 1 (people or groups)') && lines.includes('General access: anyone in the team as Viewer'), `the share request says what was asked (${lines.join('; ')})`)
  check((await lee.locator('h1').textContent()) === 'Sharing change on /프로젝트' && await lee.locator('.card p.mono', { hasText: '/drafts/' }).count() === 0, 'its page is a sharing change, not a draft')
  await shot(lee, 's13-approval-share-1440-light')
  check(lee.errors.length === 0, 'lee: no page errors' + (lee.errors.length ? ': ' + lee.errors.join(' | ') : ''))
  await lee.context().close()
}

async function approvalsStandIn(page) {
  const now = Date.now()
  const stepUp = { method: 'totp', missing: null, lan_only: true, public_url: null }
  const base = { status: 'pending', created_at: now - 3_600_000, expires_at: now + 6 * 86_400_000, decided_at: null, can_decide: true, mine: false, via: 'web', overwrite: false }
  const share = { ...base, id: 7, kind: 'share', target: '/프로젝트', name: '프로젝트', size: 0, gain: 2, requester: 'kim' }
  const draft = { ...base, id: 8, kind: 'promote', target: '/공용', name: '회의 요약.md', size: 812, gain: 3, requester: 'mina', via: 'agent' }
  await page.route('**/api/approvals', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [share, draft], others_pending: 0, step_up: stepUp }) }))
  await page.route('**/api/approvals/7', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    ...share, sha256: 'share-0f3a', decided_by: null, decision_reason: null, approvers_exist: true, via_eligibility: 'sources',
    change: { path: '/프로젝트', add: [{ subject: { type: 'person', id: 2 }, role: 'editor' }], general: { mode: 'team', role: 'viewer' }, notify: true, confirm_widening: true },
    sources: ['/경영'], hidden_sources: 1, gainers: { count: 2 }, preview: null, diff: null, step_up: stepUp,
  }) }))
}
