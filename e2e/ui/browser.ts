// Headless browsers for the end-to-end flows (H2): playwright-core 1.64.1 from this folder's own package (bun install
// --cwd e2e/ui) and the Chromium / WebKit builds it expects (bunx playwright@1.64.1 install chromium webkit). Never the
// Playwright MCP. Runs under bun (cloud/dev/e2e/run.ts imports it) and under node ≥ 23 (type stripping).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const OUT = path.join(here, '.out')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PW = any
let pw: PW | null = null
async function load(): Promise<PW> {
  if (!pw) pw = await import(path.join(here, 'node_modules/playwright-core/index.mjs'))
  return pw
}

export async function chromiumPath(): Promise<string | null> {
  const p = (await load()).chromium.executablePath() as string
  return p && fs.existsSync(p) ? p : null
}
export async function webkitAvailable(): Promise<boolean> {
  const p = (await load()).webkit.executablePath() as string
  return !!p && fs.existsSync(p)
}

export interface Opts { width?: number; height?: number; dark?: boolean; engine?: 'chromium' | 'webkit'; mobile?: boolean }

/** a browser context the way a person has it: own cookies, the local CA's certificate accepted (self-signed dev CA) */
export async function open(o: Opts = {}) {
  const lib = await load()
  const engine = o.engine === 'webkit' ? lib.webkit : lib.chromium
  const browser = await engine.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: o.width ?? 1440, height: o.height ?? (o.width && o.width < 600 ? 844 : 900) },
    colorScheme: o.dark ? 'dark' : 'light', ignoreHTTPSErrors: true, locale: 'en-US',
    ...(o.mobile ? { isMobile: o.engine !== 'webkit' ? true : undefined, hasTouch: true, deviceScaleFactor: 2,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' } : {}),
  })
  return { browser, context, close: () => browser.close() }
}

/** a Chromium virtual authenticator (WebAuthn) for passkey prompts, user-verifying */
export async function virtualAuthenticator(page: PW) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  return cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })
}

export async function shot(page: PW, name: string): Promise<string> {
  fs.mkdirSync(OUT, { recursive: true })
  const file = path.join(OUT, `${name}.png`)
  await page.screenshot({ path: file, fullPage: false })
  const extra = process.env.E2E_SHOTS_DIR
  if (extra) { fs.mkdirSync(extra, { recursive: true }); fs.copyFileSync(file, path.join(extra, `${name}.png`)) }
  return file
}
