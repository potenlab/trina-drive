// S37 (plan 5): every main screen of the drive at 1440 and 390, light and dark (and Korean at 1440), saved as
// screenshots; text contrast (WCAG AA) measured on the key elements in both themes; the manual theme switch and the
// Korean text checked on screen. Screenshots: $E2E_OUT/s37-<screen>-<width>-<theme>.png
import { check, shot, signedIn } from './lib.mjs'

const enc = encodeURIComponent
const SCREENS = [
  // [name, who, route, wait-for, before-shot]
  ['files', 'boss', '/files?p=' + enc('/공용'), '.fv-items'],
  ['files-grid', 'boss', '/files?p=' + enc('/공용'), '.fv-items', async (p) => { await p.click('.seg-btns button:nth-child(2)'); await p.waitForSelector('.fv-items.grid') }],
  ['detail', 'boss', '/files?p=' + enc('/공용') + '&s=' + enc('/공용/안내.md'), '.fv-detail .fv-who-body'],
  ['search', 'boss', '/files?q=' + enc('CANARY'), '.fv-hits, .fv-state'],
  ['share', 'lee', '/files?p=' + enc('/프로젝트'), '.fv-share', async (p) => { await p.click('.fv-share'); await p.waitForSelector('.sd-body'); await p.waitForTimeout(200) }],
  ['context-menu', 'boss', '/files?p=' + enc('/공용'), '.fv-items', async (p) => { const r = p.locator('.fv-items > li').nth(1); await r.click({ button: 'right' }); await p.waitForSelector('.fv-menu') }],
  ['shared', 'lee', '/shared', 'table.swm, .empty-state'],
  ['connect', 'boss', '/connect', '.cai-panel'],
  ['mount', 'boss', '/mount', '.mount-facts'],
  ['trash', 'boss', '/trash', '.fv-trash p'],
  ['skills', 'lee', '/skills', '.card'],
  ['skill-review', 'lee', '/approvals', '.ap-skills', async (p) => { await p.click('.ap-skills a.btn'); await p.waitForSelector('.card.highlight') }],
  ['drafts', 'boss', '/drafts', '.page'],
  ['approvals', 'boss', '/approvals', '.page'],
  ['people', 'boss', '/people', '.page'],
  ['folders', 'boss', '/folders', 'table.list'],
  ['folder-access', 'boss', '/folders', 'table.list', async (p) => { await p.locator('table.list a.strong', { hasText: /^\/프로젝트$/ }).click(); await p.waitForSelector('.matrix, table') }],
  ['audit', 'boss', '/audit', '.page'],
  ['settings', 'boss', '/settings', '.page'],
  ['account-menu', 'boss', '/files', '.fv-items', async (p) => { await p.click('.acct-btn'); await p.waitForSelector('.acct-menu') }],
  ['drawer', 'boss', '/files', '.fv-items', async (p) => { await p.click('.tb-menu'); await p.waitForTimeout(300) }, 390],
  ['signin', null, '/', 'input[autocomplete=username]'],
]

/** WCAG contrast of an element's text against what is painted behind it (alpha backgrounds composited). */
const contrastOf = (sel) => {
  const el = document.querySelector(sel)
  if (!el) return null
  const parse = (c) => { const m = c.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 0]; return { r: m[0], g: m[1], b: m[2], a: m[3] ?? 1 } }
  const layers = []
  for (let e = el; e; e = e.parentElement) { const bg = parse(getComputedStyle(e).backgroundColor); if (bg.a > 0) { layers.push(bg); if (bg.a >= 1) break } }
  let base = { r: 255, g: 255, b: 255 }
  for (const l of layers.reverse()) base = { r: l.r * l.a + base.r * (1 - l.a), g: l.g * l.a + base.g * (1 - l.a), b: l.b * l.a + base.b * (1 - l.a) }
  const fg = parse(getComputedStyle(el).color)
  const f = { r: fg.r * fg.a + base.r * (1 - fg.a), g: fg.g * fg.a + base.g * (1 - fg.a), b: fg.b * fg.a + base.b * (1 - fg.a) }
  const lum = (c) => { const ch = [c.r, c.g, c.b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }); return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2] }
  const [a, b] = [lum(f), lum(base)].sort((x, y) => y - x)
  return Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100
}
const CONTRAST = [
  ['.fv-items .fv-name', 'file names'], ['.fv-items .fv-date', 'dates (muted)'], ['.tr-row.here > a', 'selected folder in the tree'], ['.sb-item:not(.on) .sb-label', 'sidebar items'],
  ['.sb-new', 'Signal Orange “New” (ink on orange)'], ['.fv-crumbs .here', 'breadcrumb'], ['.tb-search input', 'search text'], ['.fv-share', 'Share button'],
]

export async function s37(browser, fx) {
  console.log('S37 screens at 1440/390 × light/dark (+ ko), contrast AA, theme switch, Korean text')
  for (const width of [1440, 390]) {
    for (const theme of ['light', 'dark']) {
      const pages = {}
      for (const [name, who, route, wait, before, only] of SCREENS) {
        if (only && only !== width) continue
        const key = who ?? 'anon'
        pages[key] ??= await signedIn(browser, fx, who, { width, height: width > 500 ? 900 : 844, theme, mobile: width < 500 })
        const p = pages[key]
        await p.goto(fx.base + '/#' + route)
        await p.waitForSelector(wait, { timeout: 10_000 })
        if (before) await before(p)
        await shot(p, `s37-${name}-${width}-${theme}`)
        await p.keyboard.press('Escape').catch(() => {})
      }
      // contrast on the files screen
      const p = pages.boss
      await p.goto(fx.base + '/#/files?p=' + enc('/공용'))
      await p.waitForSelector('.fv-items')
      for (const [sel, what] of CONTRAST) {
        if (width < 500 && (sel.startsWith('.sb') || sel.startsWith('.tr'))) continue // the drawer is closed
        const c = await p.evaluate(contrastOf, sel)
        check(c !== null && c >= 4.5, `contrast ${width} ${theme}: ${what} ${c}:1 ≥ 4.5`)
      }
      check(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${width} ${theme}: no sideways scroll`)
      for (const x of Object.values(pages)) { check(x.errors.length === 0, `${width} ${theme}: no page errors` + (x.errors.length ? ': ' + x.errors.join(' | ') : '')); await x.context().close() }
    }
  }

  // the manual switch beats the system: system light, choice dark
  const p = await signedIn(browser, fx, 'boss', { theme: 'light' })
  await p.goto(fx.base + '/#/files')
  await p.click('.acct-btn')
  await p.locator('.seg-mini button', { hasText: 'Dark' }).click()
  const bg = await p.evaluate(() => [document.documentElement.dataset.theme, getComputedStyle(document.body).backgroundColor])
  check(bg[0] === 'dark' && bg[1] === 'rgb(21, 18, 16)', `the theme switch turns the page dark on a light system (${bg.join(', ')})`)
  await p.reload(); await p.waitForSelector('.fv-items')
  check(await p.evaluate(() => document.documentElement.dataset.theme) === 'dark', 'the choice is kept after a reload')
  await p.context().close()

  // Korean
  for (const theme of ['light', 'dark']) {
    const k = await signedIn(browser, fx, 'lee', { theme, locale: 'ko' })
    await k.goto(fx.base + '/#/files?p=' + enc('/프로젝트'))
    await k.waitForSelector('.fv-items')
    await shot(k, `s37-files-1440-${theme}-ko`)
    const nav = await k.locator('.sb-nav').innerText()
    check(['팀 폴더', '공유 문서함', '휴지통', '내 AI 연결'].every((x) => nav.includes(x)) && !/Shared with me|Trash|Connect your AI|Team folders/.test(nav), `ko ${theme}: the sidebar is all Korean`)
    await k.click('.fv-share'); await k.waitForSelector('.sd-body'); await k.waitForTimeout(200)
    const sd = await k.locator('.sd').innerText()
    check(/액세스 권한이 있는 사용자/.test(sd) && /일반 액세스/.test(sd) && !/People with access|General access|Copy link/.test(sd), `ko ${theme}: the share dialog is all Korean`)
    await shot(k, `s37-share-1440-${theme}-ko`)
    await k.goto(fx.base + '/#/connect'); await k.waitForSelector('.cai-panel')
    await shot(k, `s37-connect-1440-${theme}-ko`)
    check(k.errors.length === 0, `ko ${theme}: no page errors`)
    await k.context().close()
  }
}
