// Renders public/og.png and public/og-ko.png (1200×630) and the PNG favicons from SVG with rsvg-convert
// (brew install librsvg). Run: bun run og. The PNGs are committed, so the site build does not need this.
import { $ } from 'bun'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const here = import.meta.dir
const pub = join(here, '..', 'public')
const tpl = readFileSync(join(here, 'og-template.svg'), 'utf8')
const tmp = mkdtempSync(join(tmpdir(), 'og-'))
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')

const variants = [
  { out: 'og.png', SIZE: '64', L1: 'Give your team’s AI agents', L2: 'your company files.', SUB: 'Only what each person may see · originals read-only · everything logged' },
  { out: 'og-ko.png', SIZE: '62', L1: '팀 AI에게 회사 파일을,', L2: '볼 수 있는 만큼만', SUB: '사람마다 볼 수 있는 파일만 · 원본은 읽기 전용 · 전부 기록' },
]
for (const v of variants) {
  const y2 = 252 + Math.round(Number(v.SIZE) * 1.15)
  const svg = tpl
    .replace('{{SIZE}}', v.SIZE).replace('{{L1}}', esc(v.L1)).replace('{{L2}}', esc(v.L2))
    .replace('{{Y2}}', String(y2)).replace('{{YS}}', String(y2 + 66)).replace('{{SUB}}', esc(v.SUB))
  const f = join(tmp, v.out.replace('.png', '.svg'))
  writeFileSync(f, svg)
  await $`rsvg-convert -w 1200 -h 630 ${f} -o ${join(pub, v.out)}`
}
const fav = join(pub, 'favicon.svg')
await $`rsvg-convert -w 32 -h 32 ${fav} -o ${join(pub, 'favicon-32.png')}`
await $`rsvg-convert -w 180 -h 180 ${fav} -o ${join(pub, 'apple-touch-icon.png')}`
console.log('wrote og.png, og-ko.png, favicon-32.png, apple-touch-icon.png')
