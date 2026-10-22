// A short fuzz run inside `bun test` (the full one: `bun run test:fuzz`, 60 s by default; FUZZ_SECONDS for long mode).
import { expect, test } from 'bun:test'
import { expandBraces, hiddenNames, rng, runFuzz } from './fuzz'

test('rng is deterministic per seed', () => {
  const a = rng(42), b = rng(42)
  expect(Array.from({ length: 5 }, () => a.int(1000))).toEqual(Array.from({ length: 5 }, () => b.int(1000)))
})

test('oracle helpers', () => {
  expect(expandBraces('/a/{b,c}/{d,e}')).toEqual(['/a/b/d', '/a/b/e', '/a/c/d', '/a/c/e'])
  expect(hiddenNames('kim')).toEqual(expect.arrayContaining(['인사', '외주', '잠금', '#recycle', '대외비']))
  expect(hiddenNames('kim')).not.toContain('경영') // shown to kim as a bare path
  expect(hiddenNames('lee')).not.toContain('인사')
})

test('fuzz: no canary, no hidden name, no write to originals, no crash, no timeout', async () => {
  const seconds = Number(process.env.FUZZ_TEST_SECONDS ?? 8)
  const seed = Number(process.env.FUZZ_SEED ?? 20261022)
  const stats = await runFuzz({ seconds, seed })
  console.log(`[fuzz] ${JSON.stringify({ ...stats, failures: stats.failures.length })}`)
  expect(stats.failures).toEqual([])
  expect(stats.iterations).toBeGreaterThan(100)
}, 120_000)
