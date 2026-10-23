// brand/ is the one source of the brand (tokens, mark, fonts); every app ships a byte-for-byte copy made by
// scripts/sync-brand.ts. A copy edited by hand, or a source edit without a sync, fails here.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, staleCopies, TARGETS } from '../scripts/sync-brand'

const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')
/** custom properties declared in the first block that starts with `selector {` */
function block(css: string, selector: string): Map<string, string> {
  const i = css.indexOf(selector + ' {')
  if (i < 0) return new Map()
  const body = css.slice(css.indexOf('{', i) + 1, css.indexOf('\n}', i))
  return new Map([...body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.replace(/\s+/g, ' ').trim()]))
}

describe('brand tokens', () => {
  test('every copy equals its source in brand/ (run: bun scripts/sync-brand.ts)', () => {
    expect(staleCopies()).toEqual([])
  })

  test('the website, the drive web app and the console each get tokens.css', () => {
    const copies = TARGETS.filter(([s]) => s === 'brand/tokens.css').map(([, d]) => d)
    expect(copies).toEqual(['website/src/styles/tokens.css', 'web/src/tokens.css', 'cloud/control/src/ui/tokens.css'])
  })

  test('Signal Orange values (plan 2.5)', () => {
    const css = read('brand/tokens.css')
    const light = block(css, ':root'), dark = block(css, ':root[data-theme="dark"]')
    expect(light.get('--signal')).toBe('#ff5b1f')
    expect(light.get('--signal-fg')).toBe('#14110f') // ink on orange, never white
    expect(light.get('--accent')).toBe('#c43d0a') // links and text on light
    expect(dark.get('--accent')).toBe('#ff6a33')
    expect(light.get('--font-sans')).toStartWith('"Geist"')
  })

  test('the light and dark blocks declare the same properties, and both dark blocks agree', () => {
    const css = read('brand/tokens.css')
    const light = block(css, ':root'), dark = block(css, ':root[data-theme="dark"]'), media = block(css, ':root:not([data-theme="light"])')
    expect([...media.entries()]).toEqual([...dark.entries()])
    for (const k of dark.keys()) expect(light.has(k)).toBe(true)
  })

  test('tokens the live landing still declares itself have the same values as brand/', () => {
    const brand = block(read('brand/tokens.css'), ':root'), site = block(read('website/src/styles/global.css'), ':root')
    for (const [k, v] of brand) if (site.has(k)) expect(`${k}: ${site.get(k)}`).toBe(`${k}: ${v}`)
  })
})
