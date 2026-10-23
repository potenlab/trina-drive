// S50 (Trina Cloud, fixture --cloud): My files and Recent.
//   My files: first in mina's sidebar (me.myFilesPath), left out of Team folders and the tree; #/my opens it as
//   "My files" (breadcrumb, note, empty state); she uploads into it; Share there is shown but disabled with the reason
//   (top bar, menu), absent on rows and in the detail panel; the server refuses it too. boss (an admin who is not a
//   console member) has no My files.
//   Recent: what she opened and changed, newest first, grouped by day ("You opened" / "You edited").
//   Connect your AI: the "Team skills" section links to Skills.
// Screenshots at 1440 and 390, light and dark.
import { apiAs, check, shot, signedIn } from './lib.mjs'

const enc = encodeURIComponent

export async function s50(browser, fx) {
  console.log('S50 My files (cloud) and Recent')
  const mina = await signedIn(browser, fx, 'mina')
  const me = (await (await mina.request.get(fx.base + '/api/session')).json()).me
  check(typeof me.myFilesPath === 'string' && me.myFilesPath.endsWith('(personal)'), `me.myFilesPath = ${me.myFilesPath}`)
  const MY = me.myFilesPath
  await mina.goto(fx.base + '/#/files')
  await mina.waitForSelector('.fv-items')
  const first = mina.locator('.sb-nav .sb-group').first().locator('.sb-item').first()
  check((await first.textContent()).trim() === 'My files', 'My files is first in the sidebar')
  check(await mina.locator('.tr', { hasText: '(personal)' }).count() === 0, 'the tree under Team folders leaves it out')
  check(await mina.locator('.fv-items > li', { hasText: '(personal)' }).count() === 0, 'so does the Team folders list')
  await first.click()
  await mina.waitForURL(/#\/my$/)
  check(await mina.locator('.fv-crumbs .here', { hasText: /^My files$/ }).waitFor().then(() => true, () => false), 'the breadcrumb says My files, not the folder name')
  await mina.waitForSelector('.fv-state')
  check(await mina.locator('.fv-my-note', { hasText: 'Only you can open these' }).count() === 1, 'it says only she opens these')
  check((await mina.locator('.fv-state p').textContent()).includes('Your private space'), 'its empty state')
  await mina.locator('.fv-bar input[type=file]').first().setInputFiles({ name: '메모.md', mimeType: 'text/markdown', buffer: Buffer.from('# 메모\n나만 보는 메모\n') })
  const row = mina.locator('.fv-items > li', { hasText: '메모.md' })
  await row.waitFor()
  check(true, 'she uploaded 메모.md into My files')
  const top = mina.locator('.fv-share')
  check(await top.getAttribute('aria-disabled') === 'true' && (await top.getAttribute('title')).includes('Move it to a team folder'), 'Share (top) is disabled and says why')
  await row.click({ button: 'right' })
  const item = mina.locator('.fv-menu button', { hasText: 'Share' })
  check(await item.getAttribute('aria-disabled') === 'true', 'Share in the menu is disabled')
  await item.click({ force: true })
  check(await mina.locator('.sd').count() === 0, '…and opens nothing')
  await mina.keyboard.press('Escape')
  check(await row.locator('.fv-row-share').count() === 0, 'no Share icon on its rows')
  await row.click()
  await mina.waitForSelector('.fv-detail')
  check(await mina.locator('.fv-detail .fv-detail-share').count() === 0 && await mina.locator('.fv-detail .fv-my-note').count() === 1, 'the detail panel has no Share, only the reason')
  const f = await apiAs(mina, fx, 'POST', '/share', { path: MY + '/메모.md', general: { mode: 'team', role: 'viewer' } })
  const d = await apiAs(mina, fx, 'POST', '/share', { path: MY, general: { mode: 'team', role: 'viewer' } })
  check(f.status === 409 && f.body.error === 'personal' && d.status === 403 && d.body.error === 'personal', `the server refuses both (file ${f.status} ${f.body?.error}, folder ${d.status} ${d.body?.error})`)

  // Recent: she opens a team file, then puts another file in My files
  const txt = await mina.request.get(fx.base + '/api/files/text?path=' + enc('/공용/안내.md'))
  check(txt.status() === 200, 'she opened /공용/안내.md')
  const csrf = (await (await mina.request.get(fx.base + '/api/session')).json()).csrf
  const up = await mina.request.post(`${fx.base}/api/files/upload?path=${enc(MY)}`, { headers: { origin: fx.base, 'x-csrf-token': csrf }, multipart: { file: { name: '할일.md', mimeType: 'text/markdown', buffer: Buffer.from('- 정리') } } })
  check(up.status() < 300, 'she added 할일.md')
  await mina.goto(fx.base + '/#/recent')
  await mina.waitForSelector('table.rc')
  const names = await mina.locator('table.rc .swm-name').allTextContents()
  check(names[0] === '할일.md' && names[1] === '안내.md' && names.includes('메모.md'), `Recent, newest first: ${names.join(', ')}`)
  check((await mina.locator('table.rc tr', { hasText: '할일.md' }).textContent()).includes('You edited') && (await mina.locator('table.rc tr', { hasText: '안내.md' }).textContent()).includes('You opened'), 'opened vs edited')
  await mina.locator('table.rc a.swm-name', { hasText: '메모.md' }).click()
  await mina.waitForSelector('.fv-detail')
  check((await mina.locator('.fv-crumbs .here').textContent()) === 'My files' && await mina.locator('.sb-item.on', { hasText: 'My files' }).count() === 1, 'a Recent file in My files opens there, My files lit')
  await mina.goto(fx.base + '/#/connect')
  await mina.waitForSelector('.cai-skills')
  check(await mina.locator('.cai-skills a[href="#/skills"]').count() === 1, 'Connect your AI: Team skills links to Skills')
  check(mina.errors.length === 0, 'mina: no page errors' + (mina.errors.length ? ': ' + mina.errors.join(' | ') : ''))
  await mina.context().close()

  const boss = await signedIn(browser, fx, 'boss')
  await boss.goto(fx.base + '/#/files')
  await boss.waitForSelector('.fv-items')
  const bm = (await (await boss.request.get(fx.base + '/api/session')).json()).me
  check(bm.myFilesPath === null && await boss.locator('.sb-item[href="#/my"]').count() === 0, 'boss (not a console member): no My files')
  await boss.goto(fx.base + '/#/my')
  check(await boss.locator('.fv-crumbs .here', { hasText: /^Team folders$/ }).waitFor().then(() => true, () => false), '#/my without My files is the drive itself')
  await boss.context().close()

  // screenshots: My files, Recent, Connect at 1440 / 390 × light / dark (+ Korean sidebar)
  for (const width of [1440, 390]) {
    for (const theme of ['light', 'dark']) {
      const p = await signedIn(browser, fx, 'mina', { width, height: width > 500 ? 900 : 844, theme, mobile: width < 500 })
      await p.goto(fx.base + '/#/my'); await p.waitForSelector('.fv-items')
      await shot(p, `s50-my-files-${width}-${theme}`)
      await p.goto(fx.base + '/#/recent'); await p.waitForSelector('table.rc')
      await shot(p, `s50-recent-${width}-${theme}`)
      await p.goto(fx.base + '/#/shared'); await p.waitForSelector('table.swm, .empty-state')
      await shot(p, `s50-shared-${width}-${theme}`)
      await p.goto(fx.base + '/#/connect'); await p.waitForSelector('.cai-skills')
      await p.locator('.cai-skills').scrollIntoViewIfNeeded()
      await shot(p, `s50-connect-skills-${width}-${theme}`)
      if (width < 500) { await p.goto(fx.base + '/#/my'); await p.waitForSelector('.fv-items'); await p.click('.tb-menu'); await p.waitForTimeout(300); await shot(p, `s50-drawer-${width}-${theme}`) }
      check(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${width} ${theme}: no sideways scroll`)
      check(p.errors.length === 0, `${width} ${theme}: no page errors` + (p.errors.length ? ': ' + p.errors.join(' | ') : ''))
      await p.context().close()
    }
  }
  const k = await signedIn(browser, fx, 'mina', { locale: 'ko' })
  await k.goto(fx.base + '/#/recent'); await k.waitForSelector('table.rc')
  const nav = await k.locator('.sb-nav').innerText()
  check(['내 파일', '최근 문서함', '공유 문서함'].every((x) => nav.includes(x)) && !/My files|Recent/.test(nav), 'ko: My files and Recent are Korean in the sidebar')
  await shot(k, 's50-recent-1440-light-ko')
  await k.context().close()
}
