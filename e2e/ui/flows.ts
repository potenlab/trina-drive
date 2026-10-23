// Browser flows the scenarios call (cloud/dev/e2e/scenarios/*): each takes the scenario's context `t` (t.fx = the
// fixture team, t.features, t.target) and returns plain results the scenario checks — or { pending } when the screen
// it needs is not built yet (C1's new drive shell and share dialog, B1/D1's SSO).
// These run against the local stack (real SSO, the seeded team). The share dialog itself is exercised by C1's own
// suite (web/e2e/run.mjs), which the runner calls as UI1.
import path from 'node:path'
import fs from 'node:fs'
import { open, shot, OUT } from './browser.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** a browser step that must not hang the run */
function withTimeout<T>(ms: number, what: string, f: () => Promise<T>): Promise<T> {
  return Promise.race([f(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${what}: no answer in ${ms / 1000} s`)), ms))])
}

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
  const pw = page.locator('input[type=password]').first()
  await pw.fill(c.password)
  await pw.press('Enter') // the page has other forms (email me a link): submit the one with the password
  await settle(page)
  if (/cross-site request refused/.test(await page.locator('body').innerText())) throw new Error('the console refused its own sign-in form (the browser sent Origin: null: Referrer-Policy no-referrer)')
  const code = page.locator('input[autocomplete=one-time-code], input[name=code]').first()
  if (await code.count()) {
    if (!c.consoleTotp) throw new Error(`${who}: the console asks for a code and the fixture has no console TOTP`)
    const { freshTotp } = await import(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../cloud/dev/e2e/lib/totp.ts'))
    await code.fill(await freshTotp(c.consoleTotp))
    await code.press('Enter')
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
  } catch (e) { return { ok: false, error: (e as Error).message.slice(0, 200), shot: await shot((b.context.pages())[0], 's02-failed').catch(() => '') } } finally { await b.close() }
}

export async function deepLinkSignIn(t: Any) {
  for (const f of ['sso', 'sso-console']) { const r = await t.features.get(f); if (!r.ok) return { pending: r.reason } }
  const b = await open()
  try {
    const p = await b.context.newPage()
    await consoleLogin(t, p, 'mina')
    await p.goto(filesUrl(t, '/공용')); await settle(p)
    const btn = p.getByRole('button', { name: /sign in with trina cloud/i }).or(p.getByRole('link', { name: /sign in with trina cloud/i })).first()
    const had = await btn.count()
    if (had) { await btn.click(); await p.waitForURL((u: URL) => u.origin === new URL(t.fx.url).origin && !u.pathname.startsWith('/api/'), { timeout: 30_000 }); await settle(p) }
    const text = await p.locator('body').innerText()
    const ok = !!had && (text.includes('notice.md') || /공용/.test(text)) && !/sign in with trina cloud/i.test(text)
    return { ok, url: p.url(), shot: await shot(p, 's04-deep-link') }
  } catch (e) { return { ok: false, error: (e as Error).message.slice(0, 200), shot: await shot((b.context.pages())[0], 's04-failed').catch(() => '') } } finally { await b.close() }
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
        await withTimeout(60_000, `${name} ${tag}`, async () => {
          const page = b.page ?? await b.context.newPage()
          await page.goto(url, { timeout: 30_000 }); await settle(page)
          out.shots.push(await shot(page, `s37-${name}-${tag}`))
          if (width === 390) {
            const sw = await page.evaluate(() => document.documentElement.scrollWidth)
            if (sw > 392) out.overflow.push(`${name} ${tag}: page is ${sw}px wide at 390`)
          }
        })
      } catch (e) { out.errors.push(`${name} ${tag}: ${(e as Error).message.slice(0, 120)}`) } finally { await withTimeout(15_000, 'close', () => b.close()).catch(() => {}) }
    }
  }
  return out
}

/** S48: WebKit at 390 (iPhone): the console sign-in page and the drive's files (the share sheet: C1's web/e2e s48) */
export async function mobileWebkit(t: Any) {
  const out: { pagesOk: boolean; shots: string[]; overflow: string[] } = { pagesOk: true, shots: [], overflow: [] }
  for (const [name, url, who] of [['console-login', `${t.target.control}/login`, null], ['drive-files', filesUrl(t, '/공용'), 'mina']] as const) {
    const b = who ? await asPerson(t, who, { width: 390, engine: 'webkit', mobile: true }) : { ...(await open({ width: 390, engine: 'webkit', mobile: true })), page: null as Any }
    try {
      const page = b.page ?? await b.context.newPage()
      await page.goto(url); await settle(page)
      out.shots.push(await shot(page, `s48-webkit-${name}`))
      const sw = await page.evaluate(() => document.documentElement.scrollWidth)
      if (sw > 392) out.overflow.push(`${name}: ${sw}px`)
      if (name === 'drive-files' && !(await page.locator('body').innerText()).includes('notice.md')) out.pagesOk = false
    } catch (e) { out.pagesOk = false; out.overflow.push(`${name}: ${(e as Error).message.slice(0, 100)}`) } finally { await b.close() }
  }
  return out
}
