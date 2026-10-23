#!/usr/bin/env bun
// Copies the brand source (brand/**) into each app that ships it, byte for byte:
//   bun scripts/sync-brand.ts          write the copies
//   bun scripts/sync-brand.ts --check  only compare (exit 1 and list the stale copies)
// brand/tokens.css is the one place a colour, radius, shadow or font stack is decided; the apps import their copy
// (website/src/styles/tokens.css, web/src/tokens.css, cloud/control/src/ui/tokens.css). test/brand-tokens.test.ts runs
// the --check comparison, so a copy edited by hand (or a source edit without a sync) fails CI.
import fs from 'node:fs'
import path from 'node:path'

export const ROOT = path.resolve(import.meta.dir, '..')

const BRAND_FILES = ['mark.svg', 'mark-dark.svg', 'fonts/Geist-Variable.woff2', 'fonts/GeistMono-Variable.woff2', 'fonts/OFL-Geist.txt']

/** [source under brand/, copy] — paths relative to the repository root. */
export const TARGETS: [source: string, copy: string][] = [
  ['brand/tokens.css', 'website/src/styles/tokens.css'],
  ['brand/tokens.css', 'web/src/tokens.css'],
  ['brand/tokens.css', 'cloud/control/src/ui/tokens.css'],
  // the website keeps its fonts and favicon where Astro/Vite expect them (same bytes as brand/)
  ['brand/fonts/Geist-Variable.woff2', 'website/src/assets/fonts/Geist-Variable.woff2'],
  ['brand/fonts/GeistMono-Variable.woff2', 'website/src/assets/fonts/GeistMono-Variable.woff2'],
  ['brand/favicon.svg', 'website/public/favicon.svg'],
  ['brand/favicon.svg', 'web/public/favicon.svg'],
  // the drive web app (served from web/dist/brand/…) and the console (cloud/control/src/ui/brand/…)
  ...BRAND_FILES.map((f) => [`brand/${f}`, `web/public/brand/${f}`] as [string, string]),
  ...BRAND_FILES.map((f) => [`brand/${f}`, `cloud/control/src/ui/brand/${f}`] as [string, string]),
]

/** Copies that differ from their source (missing counts as different). */
export function staleCopies(root = ROOT): string[] {
  return TARGETS.filter(([src, dst]) => {
    const d = path.join(root, dst)
    return !fs.existsSync(d) || !fs.readFileSync(path.join(root, src)).equals(fs.readFileSync(d))
  }).map(([, dst]) => dst)
}

export function syncBrand(root = ROOT): string[] {
  const changed = staleCopies(root)
  for (const [src, dst] of TARGETS) {
    if (!changed.includes(dst)) continue
    fs.mkdirSync(path.dirname(path.join(root, dst)), { recursive: true })
    fs.copyFileSync(path.join(root, src), path.join(root, dst))
  }
  return changed
}

if (import.meta.main) {
  if (process.argv.includes('--check')) {
    const stale = staleCopies()
    if (stale.length) { console.error(`brand copies out of date (run: bun scripts/sync-brand.ts):\n${stale.map((s) => `  ${s}`).join('\n')}`); process.exit(1) }
    console.log(`brand copies match brand/ (${TARGETS.length} files)`)
  } else {
    const changed = syncBrand()
    console.log(changed.length ? `updated:\n${changed.map((s) => `  ${s}`).join('\n')}` : `brand copies already match (${TARGETS.length} files)`)
  }
}
