// Renders terminal.html frame by frame (render(t) at FPS) into PNGs.  env: HTML, DATA, OUT, FPS
import { chromium } from 'playwright-core'
import fs from 'node:fs'
const { HTML, DATA, OUT } = process.env, FPS = Number(process.env.FPS ?? 12)
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true })
const exe = process.env.CHROME // a Chromium or Chrome binary
const b = await chromium.launch({ executablePath: exe, headless: true, args: ['--allow-file-access-from-files'] })
const p = await b.newPage({ viewport: { width: 1080, height: 640 }, deviceScaleFactor: 1 })
await p.goto(`file://${HTML}?capture&data=${encodeURIComponent('file://' + DATA)}`)
await p.evaluate(() => window.ready)
const dur = await p.evaluate(() => window.DURATION)
const n = Math.ceil(dur * FPS)
for (let i = 0; i < n; i++) {
  await p.evaluate((t) => window.render(t), i / FPS)
  await p.screenshot({ path: `${OUT}/f${String(i).padStart(4, '0')}.png` })
}
console.log(`${n} frames, ${dur.toFixed(1)} s`)
await b.close()
