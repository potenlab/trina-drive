// Renders the PNG favicons from public/favicon.svg with rsvg-convert (brew install librsvg). Run: bun run og.
// public/og.png (1200×630) is rendered from scripts/og.html with headless Chromium — see the comment in that file.
// The PNGs are committed, so the site build does not need this.
import { $ } from 'bun'
import { join } from 'node:path'

const pub = join(import.meta.dir, '..', 'public')
const fav = join(pub, 'favicon.svg')
await $`rsvg-convert -w 32 -h 32 ${fav} -o ${join(pub, 'favicon-32.png')}`
await $`rsvg-convert -w 180 -h 180 ${fav} -o ${join(pub, 'apple-touch-icon.png')}`
console.log('wrote favicon-32.png, apple-touch-icon.png (og.png comes from scripts/og.html)')
