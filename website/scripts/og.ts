// Renders the social cards and the PNG icons. Run: bun run og. The PNGs are committed, so the site build does not need
// this script or its tools.
//
// 1. Social cards (1200×630): one per main page, from the template scripts/og.html with the text in the query string,
//    screenshotted by headless Chrome (CHROME_PATH, or Google Chrome / Chromium in the usual places).
//    Pages point at them with <Base ogImage=…> (home: t.meta.ogImage). Then palette-compressed with Pillow (via uvx).
// 2. PNG favicons and app icons from public/favicon.svg with rsvg-convert (brew install librsvg). The apple-touch-icon
//    is drawn full-bleed (iOS rounds the corners itself), so it comes from a square copy of the SVG.
import { $ } from 'bun'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const pub = join(root, 'public')

const CARDS: { out: string; t1: string; t2: string; sub: string; chips: string[] }[] = [
  {
    out: 'og.png',
    t1: 'The team drive',
    t2: 'your AI can read.',
    sub: 'AI knowledge base for teams. Each person’s AI sees only what they may.',
    chips: ['Claude', 'ChatGPT', 'Codex', 'Cursor', 'MCP', 'Open source'],
  },
  {
    out: 'og/security.png',
    t1: 'What we promise,',
    t2: 'and where it stops.',
    sub: 'Five guarantees, the known limits, and how to report a vulnerability.',
    chips: ['Per-person AI access', 'Drafts, not edits', 'Audit log', 'Apache-2.0'],
  },
  {
    out: 'og/compare-google-drive.png',
    t1: 'Trina Drive vs Google Drive',
    t2: 'for AI teams.',
    sub: 'A team drive every person’s AI can read, with their permissions.',
    chips: ['Claude', 'ChatGPT', 'Cursor', 'MCP', 'Open source'],
  },
]

function chrome(): string {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ]
  const found = candidates.find((c) => c && existsSync(c))
  if (!found) throw new Error('No Chrome found: set CHROME_PATH')
  return found
}

const bin = chrome()
const profile = join(import.meta.dir, '.og-profile')
for (const c of CARDS) {
  const out = join(pub, c.out)
  mkdirSync(join(out, '..'), { recursive: true })
  const q = new URLSearchParams({ t1: c.t1, t2: c.t2, sub: c.sub, chips: c.chips.join('|') })
  const url = `file://${join(import.meta.dir, 'og.html')}?${q}`
  await $`${bin} --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --user-data-dir=${profile} --window-size=1200,630 --virtual-time-budget=3000 --screenshot=${out} ${url}`.quiet()
  console.log('wrote', c.out)
}
rmSync(profile, { recursive: true, force: true })
// 256-colour palette with dithering: ~210 KB instead of ~430 KB, no visible banding. Needs uv (Pillow is fetched).
const quantize = `import sys
from PIL import Image
for p in sys.argv[1:]:
    Image.open(p).convert('RGB').quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.FLOYDSTEINBERG).save(p, optimize=True)`
if (Bun.which('uvx')) await $`uvx --with pillow python -c ${quantize} ${CARDS.map((c) => join(pub, c.out))}`.quiet()
else console.log('uvx not found: social cards left uncompressed')

const fav = join(pub, 'favicon.svg')
for (const s of [16, 32]) await $`rsvg-convert -w ${s} -h ${s} ${fav} -o ${join(pub, `favicon-${s}.png`)}`
for (const s of [192, 512]) await $`rsvg-convert -w ${s} -h ${s} ${fav} -o ${join(pub, `icon-${s}.png`)}`
const square = (await Bun.file(fav).text()).replace(' rx="7.2"', '').replace('scale(.78)', 'scale(.66)')
const tmp = join(import.meta.dir, '.touch.svg')
await Bun.write(tmp, square)
await $`rsvg-convert -w 180 -h 180 ${tmp} -o ${join(pub, 'apple-touch-icon.png')}`
await $`rm ${tmp}`
console.log('wrote favicon-16/32.png, icon-192/512.png, apple-touch-icon.png')
