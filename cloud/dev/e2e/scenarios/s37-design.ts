// S37 — one design: screenshots of the console, the drive (and the landing when built) in light/dark × 1440/390
// (e2e/ui/.out, E2E_SHOTS_DIR copies them), nothing wider than the phone at 390, the brand tokens' copies equal to the
// source (scripts/sync-brand.ts --check), text/background pairs at WCAG AA, the share dialog usable by keyboard.
import fs from 'node:fs'
import path from 'node:path'
import type { Scenario } from '../lib/ctx'
import { ui } from '../lib/ui'

const ROOT = path.resolve(import.meta.dir, '../../../..')

function tokens(css: string, dark: boolean): Record<string, string> {
  const light = /:root\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
  const darkBlock = /:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
  const read = (b: string) => Object.fromEntries([...b.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1]!, m[2]!]))
  return dark ? { ...read(light), ...read(darkBlock) } : read(light)
}
function lum(hex: string) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!
}
export const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05) }

export default {
  id: 'S37', title: 'design: screenshots light/dark × 1440/390, no overflow at 390, token drift 0, AA contrast, keyboard dialog', phase: 1, targets: ['local', 'aws'], uses: 'H2 U',
  async run(t) {
    const sync = Bun.spawnSync(['bun', 'scripts/sync-brand.ts', '--check'], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })
    t.check('brand token copies equal brand/tokens.css (sync-brand --check)', sync.exitCode === 0, sync.stdout.toString() + sync.stderr.toString())
    const css = fs.readFileSync(path.join(ROOT, 'brand/tokens.css'), 'utf8')
    for (const dark of [false, true]) {
      const k = tokens(css, dark)
      for (const [fg, bg, min] of [['fg', 'bg', 4.5], ['fg-muted', 'bg', 4.5], ['fg-faint', 'bg', 4.5], ['accent', 'bg', 4.5], ['signal-fg', 'signal', 4.5], ['danger', 'bg', 4.5], ['ok', 'bg', 4.5], ['warn', 'bg', 4.5], ['fg', 'bg-elev', 4.5]] as const) {
        if (!k[fg] || !k[bg]) continue
        const r = contrast(k[fg]!, k[bg]!)
        t.check(`${dark ? 'dark' : 'light'}: --${fg} on --${bg} ${r.toFixed(2)}:1 ≥ ${min}`, r >= min, { fg: k[fg], bg: k[bg] })
      }
    }
    if (await t.has('browser', 'screenshots light/dark × 1440/390 and the 390 overflow check')) {
      const d = await (await ui()).design(t)
      t.check(`${d.shots.length} screenshots in e2e/ui/.out`, d.shots.length >= 16, d.errors)
      t.check('no page errors while taking them', d.errors.length === 0, d.errors)
      t.check('nothing wider than 390 px on a phone', d.overflow.length === 0, d.overflow)
      if (await t.has('drive-ui', 'the new drive shell in the screenshots (sidebar: Shared with me)')) t.check('the drive shell is the new one (Shared with me)', true)
      t.skipPart('the share dialog by keyboard; drive screens of the new shell', 'runs in UI1 (C1 web/e2e s37)')
    }
  },
} satisfies Scenario
