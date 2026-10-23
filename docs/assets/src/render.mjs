import { chromium } from 'playwright-core'
const { R, S } = process.env, HTML = `${R}/docs/assets/src/banner.html`
const exe = process.env.CHROME // a Chromium or Chrome binary
const b = await chromium.launch({ executablePath: exe, headless: true, args: ['--allow-file-access-from-files'] })
const shots = [['banner', 400, 2, `${S}/out-banner.png`], ['social', 640, 1, `${S}/out-social.png`], ['chat', 860, 2, `${S}/out-chat.png`]]
for (const [v, h, dsf, out] of shots) {
  const p = await b.newPage({ viewport: { width: 1280, height: h }, deviceScaleFactor: dsf })
  await p.goto(`file://${HTML}?v=${v}&img=${encodeURIComponent('file://' + S + '/raw/chat-b-15000.png')}`)
  await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(500)
  await p.screenshot({ path: out })
}
await b.close()
