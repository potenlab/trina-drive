// Shared bits of the drive UI scripts (node; headless Chromium / WebKit through playwright-core, not Playwright MCP).
//   PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs  when playwright-core is not installed in this repo
//   E2E_OUT=dir   where screenshots go (default web/e2e/.out)
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(here, '..', '..')
export const OUT = process.env.E2E_OUT || path.join(here, '.out')
fs.mkdirSync(OUT, { recursive: true })
export const pw = await import(process.env.PLAYWRIGHT_CORE || 'playwright-core')

/** Starts web/e2e/fixture.ts (bun) and resolves with its {base, password, stop}. */
export function startFixture() {
  return new Promise((resolve, reject) => {
    const p = spawn('bun', [path.join(here, 'fixture.ts')], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] })
    let buf = ''
    p.stdout.on('data', (d) => {
      buf += d
      const line = buf.split('\n').find((l) => l.startsWith('{'))
      if (line) { const j = JSON.parse(line); resolve({ ...j, stop: () => p.kill('SIGTERM') }) }
    })
    p.on('exit', (c) => reject(new Error(`fixture exited ${c}`)))
  })
}

/** A signed-in browser page for `name` (session cookie set through the API, like the sign-in form does). */
export async function signedIn(browser, fx, name, { width = 1440, height = 900, theme = 'light', locale = 'en', mobile = false } = {}) {
  const ctx = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile,
    colorScheme: theme, locale: locale === 'ko' ? 'ko-KR' : 'en-US', permissions: [],
  })
  await ctx.addInitScript(([l]) => { try { localStorage.setItem('trina-drive.locale', l) } catch {} }, [locale])
  if (name) {
    const r = await ctx.request.post(fx.base + '/api/login', { data: { login: name, password: fx.password }, headers: { origin: fx.base } })
    if (r.status() !== 200) throw new Error(`login ${name}: ${r.status()}`)
  }
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  // HTTP 4xx answers are expected (403, 404, 409); script errors are not. WebKit also reports one refused inline
  // stylesheet under the app's CSP (style-src 'self') on every load, main's build included: known, not this page's.
  const known = /Failed to load resource|^Refused to apply a stylesheet because its hash/
  page.on('console', (m) => { if (m.type() === 'error' && !known.test(m.text())) errors.push(m.text()) })
  page.errors = errors
  return page
}

export async function shot(page, name) {
  await page.waitForTimeout(250)
  const file = path.join(OUT, name + '.png')
  await page.screenshot({ path: file, fullPage: false })
  return file
}

let failures = 0
export function check(ok, what) {
  if (ok) console.log('  ok  ' + what)
  else { failures++; console.log('  FAIL ' + what) }
}
export const failed = () => failures
