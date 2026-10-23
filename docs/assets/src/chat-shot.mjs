import { chromium } from 'playwright-core'
const S = process.env.S
const exe = process.env.CHROME // a Chromium or Chrome binary
const b = await chromium.launch({ executablePath: exe, headless: true })
const p = await b.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2, colorScheme: 'light', locale: 'en-US' })
await p.goto('https://drive.trina.app/b', { waitUntil: 'networkidle' })
await p.waitForTimeout(1500)
const el = p.locator('.cd').first()
await el.scrollIntoViewIfNeeded()
for (const t of [3000, 9000, 15000, 21000]) {
  await p.waitForTimeout(t === 3000 ? 3000 : 6000)
  await el.screenshot({ path: `${S}/raw/chat-b-${t}.png` })
}
console.log(await p.evaluate(() => document.querySelector('.cd')?.getBoundingClientRect().toJSON()))
await b.close()
