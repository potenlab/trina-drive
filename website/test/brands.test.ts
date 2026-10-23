import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LOGOS, markFor } from '../src/content/brands'
import en from '../src/content/en'

const root = join(import.meta.dir, '..')
const sources = readFileSync(join(root, 'LOGO-SOURCES.md'), 'utf8')

describe('client marks', () => {
  test('every logo file is self-hosted, unmodified and recorded in LOGO-SOURCES.md with its SHA-256', () => {
    const files = new Set(Object.values(LOGOS).flatMap((l) => [l.light, l.dark]))
    for (const url of files) {
      const path = join(root, 'public', url)
      expect(existsSync(path)).toBe(true)
      const sha = createHash('sha256').update(readFileSync(path)).digest('hex')
      const file = url.split('/').pop()!
      const row = sources.split('\n').find((l) => l.includes(`\`${file}\``) && l.includes(sha))
      expect(row, `${file} with sha ${sha} in LOGO-SOURCES.md`).toBeDefined()
    }
  })

  test('Claude products never get a logo (Anthropic requires approval): neutral icon only', () => {
    for (const name of ['Claude', 'Claude Code', 'claude.ai', 'Claude app & claude.ai']) {
      expect(markFor(name).kind).toBe('icon')
    }
  })

  test('marquee: brands without logo permission are plain text', () => {
    for (const name of ['Grok', 'Gemini CLI', 'Devin Desktop (Windsurf)', 'VS Code + Copilot', 'goose']) {
      expect(markFor(name)).toEqual({ kind: 'none' })
    }
  })

  test('marquee list has no duplicates and every name maps to a mark kind', () => {
    const any = en.clients.any
    expect(new Set(any).size).toBe(any.length)
    expect(any.map((n) => markFor(n).kind).filter((k) => k === 'logo').length).toBeGreaterThan(0)
  })

  test('existing names keep their marks (Flow, variant B)', () => {
    expect(markFor('Codex app')).toEqual({ kind: 'logo', brand: 'openai' })
    expect(markFor('Codex CLI')).toEqual({ kind: 'logo', brand: 'openai' })
    expect(markFor('ChatGPT')).toEqual({ kind: 'logo', brand: 'openai' })
    expect(markFor('Cursor')).toEqual({ kind: 'logo', brand: 'cursor' })
  })
})
