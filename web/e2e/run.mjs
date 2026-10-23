// Runs the drive UI scenarios (plan 5 / 10.5): node web/e2e/run.mjs [s10 s12 s15 s37 s48]  (default: all)
// Needs a built app (bun run build:web), bun on PATH (the fixture server) and playwright-core with Chromium and WebKit
// (PLAYWRIGHT_CORE=… when it is not installed here). Each scenario gets a fresh team (web/e2e/fixture.ts).
import { failed, pw, startFixture } from './lib.mjs'
import { cloudUi } from './cloud-ui.mjs'
import { s10 } from './s10-files.mjs'
import { s12 } from './s12-share-group.mjs'
import { s15 } from './s15-share-roles.mjs'
import { s37 } from './s37-screens.mjs'
import { s48 } from './s48-mobile.mjs'

const ALL = { s10: [s10, 'chromium'], s12: [s12, 'chromium'], s15: [s15, 'chromium'], s37: [s37, 'chromium'], s48: [s48, 'webkit'], cloud: [cloudUi, 'chromium', ['--cloud']] }
const want = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(ALL)
for (const id of want) {
  const [fn, engine, args] = ALL[id] ?? []
  if (!fn) { console.error('unknown scenario ' + id); process.exit(2) }
  const fx = await startFixture(args)
  const browser = await pw[engine].launch()
  try { await fn(browser, fx) } catch (e) { console.log('  FAIL ' + id + ' threw: ' + (e?.stack ?? e)); process.exitCode = 1 } finally { await browser.close(); fx.stop() }
}
if (failed()) { console.log(`\n${failed()} check(s) failed`); process.exitCode = 1 } else if (!process.exitCode) console.log('\nall checks passed')
