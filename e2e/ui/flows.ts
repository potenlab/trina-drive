// Browser flows the scenarios call (cloud/dev/e2e/scenarios/*): each takes the scenario's context `t` (t.fx = the
// fixture team, t.features, t.target) and returns plain results the scenario checks — or { pending } when the screen
// it needs is not built yet (C1's new drive shell and share dialog, B1/D1's SSO).
//
// ADAPTER for C1 (feat/c1-drive-ui): the share dialog selectors below follow plan §2.4 ("Share" in the row menu,
// "Add people and groups", role select, "Share", "People with access", "General access", "Done"); adjust them here
// when C1 merges, the scenarios stay as they are.
import path from 'node:path'
import fs from 'node:fs'
import { open, shot, OUT } from './browser.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** a browser signed in to the drive as `who` (the fixture's session cookie: no extra sign-ins against the rate limit) */
async function asPerson(t: Any, who: string, o: Parameters<typeof open>[0] = {}) {
  const b = await open(o)
  const d = await t.fx.drive(who)
  const host = new URL(t.fx.url).host
  const cookies = ['tdrive_session', '__Host-tdrive_session'].map((name) => ({ name, value: d.jar.get(host, name) })).filter((c) => c.value)
  await b.context.addCookies(cookies.map((c) => ({ ...c, url: t.fx.url, secure: true, httpOnly: true, sameSite: 'Lax' })))
  const page = await b.context.newPage()
  return { ...b, page }
}

async function settle(page: Any) {
  try { await page.waitForLoadState('networkidle', { timeout: 15_000 }) } catch { /* long-polling pages */ }
  await wait(300)
}
// today's drive reads ?p= (web/src/pages/Files.tsx filesRoute); ?path= too, for the plan's #/files?path= (C1)
const filesUrl = (t: Any, p: string) => `${t.fx.url}/#/files?p=${encodeURIComponent(p)}&path=${encodeURIComponent(p)}`

export async function financeHidden(t: Any) {
  const out = { minaNotFound: false, samSees: false, shots: [] as string[] }
  const m = await asPerson(t, 'mina')
  try {
    await m.page.goto(filesUrl(t, '/재무')); await settle(m.page)
    const text = await m.page.locator('body').innerText()
    out.minaNotFound = !text.includes('결산.md') && /not there|cannot open|없거나|not found/i.test(text)
    out.shots.push(await shot(m.page, 's12-mina-finance'))
  } finally { await m.close() }
  const s = await asPerson(t, 'sam')
  try {
    await s.page.goto(filesUrl(t, '/재무')); await settle(s.page)
    out.samSees = (await s.page.locator('body').innerText()).includes('결산.md')
    out.shots.push(await shot(s.page, 's12-sam-finance'))
  } finally { await s.close() }
  return out
}

export async function uploadInBrowser(t: Any, dir: string) {
  const name = `ui-${Date.now().toString(36)}.txt`
  const file = path.join(OUT, name)
  fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(file, 'uploaded through the page\n')
  const m = await asPerson(t, 'mina')
  try {
    await m.page.goto(filesUrl(t, dir)); await settle(m.page)
    const input = m.page.locator('input[type=file]:not([webkitdirectory])').first()
    if (!(await input.count())) return { pending: 'no file input on the files page' }
    await input.setInputFiles(file)
    // the name shows in the upload panel at once; wait until the server has the file, then for the listing row
    const api = await t.fx.drive('mina')
    let stored = false
    for (let i = 0; i < 40 && !stored; i++) { stored = (await api.stat(`${dir}/${name}`)).status === 200; if (!stored) await wait(500) }
    await m.page.getByText(name).nth(1).waitFor({ timeout: 20_000 }).catch(() => {})
    const ok = stored && (await m.page.getByText(name).count()) >= 1
    return { ok, shot: await shot(m.page, 's10-upload') }
  } catch (e) { return { ok: false, error: (e as Error).message, shot: await shot(m.page, 's10-upload-failed') } } finally { await m.close() }
}

async function needDialog(t: Any): Promise<string | null> {
  for (const f of ['drive-ui', 'share']) { const r = await t.features.get(f); if (!r.ok) return r.reason }
  return null
}

/** open the share dialog of a folder from its row menu (plan §2.4) */
async function openShare(page: Any, folderName: string) {
  const row = page.getByRole('row', { name: new RegExp(folderName) }).first()
  if (await row.count()) { await row.click({ button: 'right' }).catch(() => {}); }
  const item = page.getByRole('menuitem', { name: /share/i }).first()
  if (await item.count()) await item.click()
  else await page.getByRole('button', { name: /share/i }).first().click()
  await page.getByRole('dialog').first().waitFor({ timeout: 10_000 })
  return page.getByRole('dialog').first()
}

export async function shareAndRevoke(t: Any) {
  const why = await needDialog(t)
  if (why) return { pending: why }
  const checks: Record<string, boolean> = {}
  const a = await asPerson(t, 'admin'), m = await asPerson(t, 'mina')
  try {
    await a.page.goto(filesUrl(t, '/')); await settle(a.page)
    let dlg = await openShare(a.page, '재무')
    await dlg.getByPlaceholder(/add people|people and groups/i).fill('mina')
    await a.page.getByRole('option', { name: /mina/i }).first().click()
    await dlg.getByRole('button', { name: /^share$/i }).click()
    await settle(a.page)
    checks['admin shares /재무 with mina in the dialog'] = (await dlg.innerText()).includes('mina')
    await shot(a.page, 's17-share-dialog')
    await m.page.goto(filesUrl(t, '/재무')); await settle(m.page)
    checks['mina sees 결산.md after the share'] = (await m.page.locator('body').innerText()).includes('결산.md')
    dlg = a.page.getByRole('dialog').first()
    const mrow = dlg.getByText(/mina/).first()
    await mrow.locator('xpath=ancestor::*[self::li or self::tr or self::div][1]').getByRole('combobox').first().selectOption({ label: /remove/i }).catch(async () => {
      await mrow.click(); await a.page.getByRole('option', { name: /remove/i }).first().click()
    })
    await settle(a.page)
    await m.page.reload(); await settle(m.page)
    checks['mina no longer sees 결산.md after Remove'] = !(await m.page.locator('body').innerText()).includes('결산.md')
    await shot(m.page, 's17-mina-after-revoke')
  } catch (e) { checks[`dialog flow ran (${(e as Error).message.slice(0, 80)})`] = false } finally { await a.close(); await m.close() }
  return { checks }
}

export async function managerDialog(t: Any) {
  const why = await needDialog(t)
  if (why) return { pending: why }
  const checks: Record<string, boolean> = {}
  const k = await asPerson(t, 'kim')
  try {
    await k.page.goto(filesUrl(t, '/')); await settle(k.page)
    const dlg = await openShare(k.page, '프로젝트')
    const roles = (await dlg.locator('select, [role=listbox], [role=combobox]').allInnerTexts()).join(' ')
    checks['kim (Manager, not admin) gets no "Manager" role to give'] = !/manager/i.test(roles)
    await shot(k.page, 's15-manager-dialog')
    for (const dark of [false, true]) {
      const b = await asPerson(t, 'kim', { width: 390, dark })
      await b.page.goto(filesUrl(t, '/')); await settle(b.page)
      await openShare(b.page, '프로젝트').catch(() => {})
      await shot(b.page, `s15-dialog-390-${dark ? 'dark' : 'light'}`)
      await b.close()
    }
  } catch (e) { checks[`dialog flow ran (${(e as Error).message.slice(0, 80)})`] = false } finally { await k.close() }
  return { checks }
}

export async function consoleSignupPage(t: Any) {
  const b = await open()
  try {
    const p = await b.context.newPage()
    await p.goto(`${t.target.control}/signup`); await settle(p)
    const ok = (await p.locator('input[type=email]').count()) > 0 && (await p.locator('input[type=password]').count()) > 0
    return { ok, shot: await shot(p, 's01-console-signup') }
  } finally { await b.close() }
}

/** console sign-in through the console's own pages (password, then the authenticator code if asked) */
async function consoleLogin(t: Any, page: Any, who: string) {
  const c = t.fx.creds(who)
  await page.goto(`${t.target.control}/login`); await settle(page)
  await page.locator('input[type=email]').first().fill(c.email)
  await page.locator('input[type=password]').first().fill(c.password)
  await page.locator('button[type=submit], form button').first().click()
  await settle(page)
  const code = page.locator('input[autocomplete=one-time-code], input[name=code], input[inputmode=numeric]').first()
  if (await code.count()) {
    if (!c.consoleTotp) throw new Error(`${who}: the console asks for a code and the fixture has no console TOTP`)
    const { freshTotp } = await import(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../cloud/dev/e2e/lib/totp.ts'))
    await code.fill(await freshTotp(c.consoleTotp))
    await page.locator('button[type=submit], form button').first().click()
    await settle(page)
  }
}

export async function ownerOpensDrive(t: Any) {
  for (const f of ['sso', 'sso-console']) { const r = await t.features.get(f); if (!r.ok) return { pending: r.reason } }
  const b = await open()
  try {
    const p = await b.context.newPage()
    await consoleLogin(t, p, 'admin')
    await shot(p, 's02-console-teams')
    await p.goto(`${t.target.control}/open/${t.fx.slug}`)
    await p.waitForURL((u: URL) => u.origin === new URL(t.fx.url).origin, { timeout: 30_000 })
    await settle(p)
    const ok = new URL(p.url()).origin === new URL(t.fx.url).origin
    return { ok, url: p.url(), shot: await shot(p, 's02-drive-after-sso') }
  } catch (e) { return { ok: false, error: (e as Error).message } } finally { await b.close() }
}

export async function deepLinkSignIn(t: Any) {
  for (const f of ['sso', 'sso-console']) { const r = await t.features.get(f); if (!r.ok) return { pending: r.reason } }
  const b = await open()
  try {
    const p = await b.context.newPage()
    await consoleLogin(t, p, 'mina')
    await p.goto(filesUrl(t, '/공용')); await settle(p)
    const btn = p.getByRole('button', { name: /sign in with trina cloud/i }).or(p.getByRole('link', { name: /sign in with trina cloud/i })).first()
    if (await btn.count()) { await btn.click(); await p.waitForURL((u: URL) => u.origin === new URL(t.fx.url).origin && u.hash.includes('files'), { timeout: 30_000 }); await settle(p) }
    const ok = p.url().includes(encodeURIComponent('/공용')) || p.url().includes('/공용') || (await p.locator('body').innerText()).includes('notice.md')
    return { ok, url: p.url(), shot: await shot(p, 's04-deep-link') }
  } catch (e) { return { ok: false, error: (e as Error).message } } finally { await b.close() }
}

/** S37: screenshots of the console, the drive and (if built) the landing, light/dark × 1440/390; horizontal overflow */
export async function design(t: Any) {
  const out: { shots: string[]; overflow: string[]; errors: string[] } = { shots: [], overflow: [], errors: [] }
  const landing = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../website/dist/index.html')
  for (const dark of [false, true]) for (const width of [1440, 390]) {
    const tag = `${width}-${dark ? 'dark' : 'light'}`
    const pages: [string, string, string | null][] = [
      ['console-login', `${t.target.control}/login`, null], ['console-signup', `${t.target.control}/signup`, null],
      ['drive-files', filesUrl(t, '/'), 'mina'], ['drive-folder', filesUrl(t, '/공용'), 'mina'], ['drive-admin', `${t.fx.url}/#/folders`, 'admin'],
      ...(fs.existsSync(landing) ? [['landing', `file://${landing}`, null] as [string, string, null]] : []),
    ]
    for (const [name, url, who] of pages) {
      const b = who ? await asPerson(t, who, { width, dark }) : { ...(await open({ width, dark })), page: null as Any }
      try {
        const page = b.page ?? await b.context.newPage()
        await page.goto(url); await settle(page)
        out.shots.push(await shot(page, `s37-${name}-${tag}`))
        if (width === 390) {
          const sw = await page.evaluate(() => document.documentElement.scrollWidth)
          if (sw > 392) out.overflow.push(`${name} ${tag}: page is ${sw}px wide at 390`)
        }
      } catch (e) { out.errors.push(`${name} ${tag}: ${(e as Error).message.slice(0, 120)}`) } finally { await b.close() }
    }
  }
  return out
}

/** S37: the share dialog by keyboard only (Tab to it, Enter opens, Escape closes and focus returns) */
export async function keyboardDialog(t: Any) {
  const why = await needDialog(t)
  if (why) return { pending: why }
  const k = await asPerson(t, 'kim')
  try {
    await k.page.goto(filesUrl(t, '/프로젝트')); await settle(k.page)
    let opened = false
    for (let i = 0; i < 60 && !opened; i++) {
      await k.page.keyboard.press('Tab')
      const label = await k.page.evaluate(() => (document.activeElement?.textContent ?? '') + ' ' + (document.activeElement?.getAttribute('aria-label') ?? ''))
      if (/share/i.test(label)) { await k.page.keyboard.press('Enter'); opened = await k.page.getByRole('dialog').count() > 0 }
    }
    await k.page.keyboard.press('Escape'); await wait(300)
    const closed = await k.page.getByRole('dialog').count() === 0
    return { ok: opened && closed, opened, closed }
  } finally { await k.close() }
}

/** S48: WebKit at 390 (iPhone): console sign-in page, the drive's files, the share sheet */
export async function mobileWebkit(t: Any) {
  const out: { ok: boolean; shots: string[]; overflow: string[]; sheet: string } = { ok: true, shots: [], overflow: [], sheet: '' }
  for (const [name, url, who] of [['console-login', `${t.target.control}/login`, null], ['drive-files', filesUrl(t, '/공용'), 'mina']] as const) {
    const b = who ? await asPerson(t, who, { width: 390, engine: 'webkit', mobile: true }) : { ...(await open({ width: 390, engine: 'webkit', mobile: true })), page: null as Any }
    try {
      const page = b.page ?? await b.context.newPage()
      await page.goto(url); await settle(page)
      out.shots.push(await shot(page, `s48-webkit-${name}`))
      const sw = await page.evaluate(() => document.documentElement.scrollWidth)
      if (sw > 392) { out.overflow.push(`${name}: ${sw}px`); out.ok = false }
      if (name === 'drive-files' && !(await page.locator('body').innerText()).includes('notice.md')) out.ok = false
    } finally { await b.close() }
  }
  const why = await needDialog(t)
  if (why) out.sheet = why
  else {
    const b = await asPerson(t, 'kim', { width: 390, engine: 'webkit', mobile: true })
    try {
      await b.page.goto(filesUrl(t, '/')); await settle(b.page)
      const dlg = await openShare(b.page, '프로젝트')
      const box = await dlg.boundingBox()
      out.shots.push(await shot(b.page, 's48-webkit-share-sheet'))
      if (!box || box.y + box.height < 800 || box.width < 380) { out.ok = false; out.sheet = `not a bottom sheet: ${JSON.stringify(box)}` }
    } catch (e) { out.ok = false; out.sheet = (e as Error).message } finally { await b.close() }
  }
  return out
}
