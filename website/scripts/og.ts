// Renders the PNG favicons and app icons from public/favicon.svg with rsvg-convert (brew install librsvg). The
// apple-touch-icon is drawn full-bleed (iOS rounds the corners itself), so it comes from a square copy of the SVG.
// Run: bun run og.
// public/og.png (1200×630) is rendered from scripts/og.html with headless Chromium — see the comment in that file.
// The PNGs are committed, so the site build does not need this.
import { $ } from 'bun'
import { join } from 'node:path'

const pub = join(import.meta.dir, '..', 'public')
const fav = join(pub, 'favicon.svg')
for (const s of [16, 32]) await $`rsvg-convert -w ${s} -h ${s} ${fav} -o ${join(pub, `favicon-${s}.png`)}`
for (const s of [192, 512]) await $`rsvg-convert -w ${s} -h ${s} ${fav} -o ${join(pub, `icon-${s}.png`)}`
const square = (await Bun.file(fav).text()).replace(' rx="7.2"', '').replace('scale(.78)', 'scale(.66)')
const tmp = join(import.meta.dir, '.touch.svg')
await Bun.write(tmp, square)
await $`rsvg-convert -w 180 -h 180 ${tmp} -o ${join(pub, 'apple-touch-icon.png')}`
await $`rm ${tmp}`
console.log('wrote favicon-16/32.png, icon-192/512.png, apple-touch-icon.png (og.png comes from scripts/og.html)')
