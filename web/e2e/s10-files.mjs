// S10 (plan 5): a team folder's whole file life in the browser, as mina in /공용 (Anyone in the team · Editor):
// new folder → upload (multipart, and a 50 MB file that goes up in resumable chunks) → rename → move → copy →
// new version and restore → delete, trash, restore, empty the trash. Each step is checked on screen and through the API.
import fs from 'node:fs'
import path from 'node:path'
import { check, OUT, shot, signedIn } from './lib.mjs'

export async function s10(browser, fx) {
  console.log('S10 files: folder, upload (50 MB resumable), rename, move, copy, versions, trash')
  const page = await signedIn(browser, fx, 'mina')
  const api = async (p) => (await page.request.get(fx.base + '/api' + p)).json()
  const names = async (p) => ((await api('/files?path=' + encodeURIComponent(p))).entries ?? []).map((x) => x.name).sort()
  const row = (name) => page.locator('.fv-items > li', { has: page.locator('.fv-name', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) })
  const menuOn = async (name, item) => { await row(name).click({ button: 'right' }); await page.locator('.fv-menu button', { hasText: item }).click() }
  const newMenu = async (item) => { await page.click('.sb-new'); await page.locator('.fv-menu button', { hasText: item }).click() }

  await page.goto(fx.base + '/#/files?p=' + encodeURIComponent('/공용'))
  await page.waitForSelector('.fv-items')
  check(await page.locator('.sb-new').isEnabled(), '+ New is on in a folder mina may edit')

  // new folder
  await newMenu('New folder')
  await page.fill('.fv-dialog input', 'S10')
  await page.click('.fv-dialog button[type=submit]')
  await row('S10').waitFor()
  check((await names('/공용')).includes('S10'), 'new folder S10 exists on the server')
  await row('S10').dblclick()
  await page.waitForURL(/p=%2F%EA%B3%B5%EC%9A%A9%2FS10/)

  // upload: two small files and one of 50 MB (resumable chunks)
  const big = path.join(OUT, 's10-big.bin')
  fs.writeFileSync(big, Buffer.alloc(50 * 1024 * 1024, 7))
  const small = [path.join(OUT, 'a.txt'), path.join(OUT, 'b.md')]
  fs.writeFileSync(small[0], 'first version\n'); fs.writeFileSync(small[1], '# b\n')
  const chooser = page.waitForEvent('filechooser')
  await newMenu('Upload files')
  await (await chooser).setFiles([...small, big])
  await page.locator('.fv-uploads header strong', { hasText: 'Uploads done' }).waitFor({ timeout: 120_000 })
  await row('s10-big.bin').waitFor()
  const stat = await api('/files/stat?path=' + encodeURIComponent('/공용/S10/s10-big.bin'))
  check(stat.size === 50 * 1024 * 1024 || stat.item?.size === 50 * 1024 * 1024, 'the 50 MB file arrived whole')
  check(JSON.stringify(await names('/공용/S10')) === JSON.stringify(['a.txt', 'b.md', 's10-big.bin'].sort()), 'three files uploaded')
  await page.locator('.fv-uploads button[aria-label="Clear"]').click().catch(() => {})

  // rename
  await menuOn('a.txt', 'Rename')
  await page.fill('.fv-dialog input', 'a-renamed.txt')
  await page.click('.fv-dialog button[type=submit]')
  await row('a-renamed.txt').waitFor()
  check((await names('/공용/S10')).includes('a-renamed.txt'), 'renamed on the server')

  // move b.md into a new subfolder
  await newMenu('New folder')
  await page.fill('.fv-dialog input', 'sub')
  await page.click('.fv-dialog button[type=submit]')
  await row('sub').waitFor()
  await menuOn('b.md', 'Move to')
  await page.locator('.fv-pick button', { hasText: 'sub' }).click()
  await page.locator('.fv-dialog-actions button', { hasText: 'Move here' }).click()
  await row('b.md').waitFor({ state: 'detached' })
  check((await names('/공용/S10/sub')).includes('b.md'), 'moved into sub')

  // copy to /공용
  await menuOn('a-renamed.txt', 'Copy to')
  await page.locator('.fv-dialog .fv-crumbs button', { hasText: '공용' }).click()
  await page.locator('.fv-dialog-actions button', { hasText: 'Copy here' }).click()
  await page.locator('.fv-toast', { hasText: 'Copied 1' }).waitFor()
  check((await names('/공용')).includes('a-renamed.txt'), 'copied to /공용')

  // a new version (upload the same name, Replace), then restore version 1
  fs.writeFileSync(path.join(OUT, 'a-renamed.txt'), 'second version\n')
  const chooser2 = page.waitForEvent('filechooser')
  await newMenu('Upload files')
  await (await chooser2).setFiles(path.join(OUT, 'a-renamed.txt'))
  await page.locator('.fv-uploads .linkish', { hasText: 'Replace' }).first().click()
  await page.locator('.fv-uploads header strong', { hasText: 'Uploads done' }).waitFor()
  await row('a-renamed.txt').click()
  await page.locator('.fv-versions li', { hasText: 'Version 2' }).waitFor()
  await shot(page, 's10-versions')
  await page.locator('.fv-versions li', { hasText: 'Version 1' }).locator('button', { hasText: 'Restore' }).click()
  await page.locator('.fv-toast', { hasText: 'Restored as version 3' }).waitFor()
  const v = await api('/files/versions?path=' + encodeURIComponent('/공용/S10/a-renamed.txt'))
  check(v.versions?.length === 3 && v.versions.find((x) => x.current)?.version === 3, 'version 1 restored as version 3')

  // delete → trash → restore → delete → empty
  await page.locator('.fv-detail button[aria-label="Close"]').click()
  await row('a-renamed.txt').click()
  await page.keyboard.press('Delete')
  await page.locator('.fv-toast', { hasText: 'Moved 1 to the trash' }).waitFor()
  check(!(await names('/공용/S10')).includes('a-renamed.txt'), 'deleted')
  await page.click('a.sb-item[href="#/trash"]')
  await page.locator('.fv-trash-list li', { hasText: 'a-renamed.txt' }).locator('button', { hasText: 'Restore' }).click()
  await page.locator('.fv-trash', { hasText: 'Restored to' }).waitFor()
  check((await names('/공용/S10')).includes('a-renamed.txt'), 'restored from the trash')
  await page.goto(fx.base + '/#/files?p=' + encodeURIComponent('/공용/S10'))
  await row('a-renamed.txt').click()
  await page.keyboard.press('Delete')
  await page.locator('.fv-toast', { hasText: 'Moved 1 to the trash' }).waitFor()
  await page.click('a.sb-item[href="#/trash"]')
  await page.locator('.fv-trash-head button', { hasText: 'Empty trash' }).click()
  await page.locator('.fv-dialog-actions button', { hasText: 'Delete forever' }).click()
  await page.locator('.fv-state', { hasText: 'The trash is empty.' }).waitFor()
  check((await api('/trash')).items.length === 0, 'trash emptied')
  const audit = await api('/audit?view=mine')
  check(JSON.stringify(audit).includes('S10'), 'the changes are in mina’s audit log')
  check(page.errors.length === 0, 'no page errors' + (page.errors.length ? ': ' + page.errors.join(' | ') : ''))
  fs.rmSync(big, { force: true })
  await page.context().close()
}
