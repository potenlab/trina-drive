// Document extraction runs only in isolated workers (plan 6 "추출·셸 작업자는 모두 격리한다", 7.1): on demand (cat/read/
// grep of an office file through the mirror) and in the reconciler's queue. Malicious documents are killed in their
// worker while another token's `ls` keeps p99 < 200 ms; without isolation, extraction is refused, not run in-process.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { LIMITS } from '../src/config'
import { ExtractError, TOOLS } from '../src/extract'
import { extractDocument, ExtractUnavailable, extractMode, INDEX_WHO } from '../src/extract/run'
import { extractForIndex } from '../src/inplace/extractq'
import { Mirror } from '../src/mirror'
import { sampleDocx, sampleHwp, samplePdf } from '../src/samples'
import { Executor } from '../src/worker'
import { setup, textOf, type Env } from './helpers'
import { difatLoopHwp, docxBomb, regexLoopDocx, xlsxBomb } from './hostile-docs'

let e: Env
const saved = { ms: LIMITS.extractMs, rss: LIMITS.extractRssBytes }
beforeAll(() => {
  e = setup()
  e.addToken('attacker', 'kim', { name: 'kim-attacker' })
  e.addToken('victim', 'boss', { name: 'boss-victim' })
  const put = (rel: string, b: Uint8Array) => fs.writeFileSync(path.join(e.root, '공용', rel), b)
  put('bomb.docx', docxBomb())
  put('bomb.xlsx', xlsxBomb())
  put('loop.docx', regexLoopDocx())
  put('alloc.hwp', difatLoopHwp())
  put('ok.docx', sampleDocx(['평범한 문서', 'ordinary text']))
  // keep the suite short: the loop is cut at 4 s, memory at 256 MB
  LIMITS.extractMs = 4000
  LIMITS.extractRssBytes = 256 << 20
})
afterAll(() => { LIMITS.extractMs = saved.ms; LIMITS.extractRssBytes = saved.rss; e.cleanup() })

/**
 * Runs `attack` while the victim keeps running `ls /`; returns the victim's latency p99. As in resource.test.ts, a
 * 2 ms ticker catches event-loop stalls (a victim request arriving during a stall waits for it) and real probes run too.
 */
async function victimP99(attack: () => Promise<unknown>) {
  const base: number[] = []
  for (let i = 0; i < 5; i++) { const s = performance.now(); await e.sh('victim', 'ls /'); base.push(performance.now() - s) }
  const lsCost = base.sort((a, b) => a - b)[2]!
  const ticks: number[] = []
  const ticker = setInterval(() => ticks.push(performance.now()), 2)
  const real: number[] = []
  let done = false
  const prober = (async () => { while (!done) { const s = performance.now(); await e.sh('victim', 'ls /'); real.push(performance.now() - s); await Bun.sleep(10) } })()
  const started = performance.now()
  await attack().finally(() => { done = true })
  const ended = performance.now()
  await prober
  clearInterval(ticker)
  ticks.push(performance.now())
  const lat: number[] = [...real]
  let k = 0
  for (let t = started; t < ended; t += 10) {
    while (k < ticks.length && ticks[k]! < t) k++
    lat.push((ticks[k] ?? ended) - t + lsCost)
  }
  lat.sort((a, b) => a - b)
  return { p99: lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.99))]!, ms: ended - started, probes: real.length }
}

test('extraction is isolated by default', () => {
  expect(process.env.SHELF_EXTRACT === 'inprocess' ? 'inprocess' : 'isolated').toBe(extractMode())
})

describe.skipIf(extractMode() === 'inprocess')('malicious documents are killed in the worker, other tokens unaffected', () => {
  const cases: [string, string, RegExp][] = [
    ['docx zip bomb (60 MB of paragraphs)', 'bomb.docx', /too much memory|too long/],
    ['xlsx zip bomb (16 sheets x 60 MB)', 'bomb.xlsx', /too much memory|too long/],
    ['parser that never returns (quadratic regex)', 'loop.docx', /too long/],
    ['huge allocation (self-referencing hwp DIFAT)', 'alloc.hwp', /too much memory|too long/],
  ]
  for (const [what, file, why] of cases) {
    test(`${what}: cat is refused, victim ls p99 < 200 ms`, async () => {
      let r!: { stdout: string; stderr: string; exitCode: number }
      const { p99, ms, probes } = await victimP99(async () => { r = await e.sh('attacker', `cat /공용/${file}`) })
      console.log(`[extract] ${JSON.stringify({ file, ms: Math.round(ms), p99: Math.round(p99), probes, stderr: r.stderr.trim().slice(0, 120) })}`)
      expect(r.exitCode).not.toBe(0)
      expect(r.stderr).toMatch(why)
      expect(r.stdout).toBe('')
      expect(ms).toBeLessThan(LIMITS.extractMs + 3000)
      expect(p99).toBeLessThan(200)
      // remembered: the next read answers at once, without another worker
      const t0 = performance.now()
      const again = await e.sh('attacker', `cat /공용/${file}`)
      expect(again.stderr).toMatch(why)
      expect(performance.now() - t0).toBeLessThan(1000)
    }, 30_000)
  }

  test('grep -r over the folder skips the unreadable documents and still finds the rest', async () => {
    const r = await e.sh('attacker', 'grep -r ordinary /공용')
    expect(r.stdout).toContain('/공용/ok.docx')
    expect(r.stderr).toMatch(/could not be read as text/)
  })

  test('the reconciler path (extractForIndex) is isolated too: a bomb fails without stalling the server', async () => {
    let err: unknown
    const { p99 } = await victimP99(async () => { await extractForIndex('x.hwp', difatLoopHwp()).catch((x) => { err = x }) })
    expect(err).toBeInstanceOf(ExtractError)
    expect(String((err as Error).message)).toMatch(/too much memory|too long/)
    expect(p99).toBeLessThan(200)
    expect(await extractForIndex('x.docx', sampleDocx(['index me']))).toContain('index me')
  }, 30_000)
})

describe('isolation is required', () => {
  const none = new Executor({ isolation: 'none', requireIsolation: true, warm: 0 })
  afterAll(() => none.close())

  test('without isolation extraction is refused with a clear error (not run in the server)', async () => {
    const err = await extractDocument('a.docx', sampleDocx(['x']), INDEX_WHO, { executor: none }).catch((x) => x)
    expect(err).toBeInstanceOf(ExtractUnavailable)
    expect(err.message).toMatch(/no isolated executor/)
  })

  test('through the shell: cat says why, and the refusal is not remembered', async () => {
    const real = e.ctx.mirror
    fs.writeFileSync(path.join(e.root, '공용', 'later.docx'), sampleDocx(['readable later']))
    e.ctx.mirror = new Mirror(e.db, real.dir, (n, b, w) => extractDocument(n, b, w, { executor: none }))
    try {
      const r = await e.sh('kim', 'cat /공용/later.docx')
      expect(r.exitCode).not.toBe(0)
      expect(r.stderr).toMatch(/no isolated executor/)
      const t = textOf(await e.tool('kim', 'read', { path: '/공용/later.docx' }))
      expect(t).toMatch(/no isolated executor/)
    } finally { e.ctx.mirror = real }
    expect((await e.sh('kim', 'cat /공용/later.docx')).stdout).toContain('readable later')
  })
})

describe.skipIf(extractMode() === 'inprocess')('ordinary documents', () => {
  test('docx, hwp and pdf extract in the worker (pdf: a worker allowed to run pdftotext)', async () => {
    expect(await extractDocument('a.docx', sampleDocx(['워드 본문']), INDEX_WHO)).toContain('워드 본문')
    expect(await extractDocument('a.hwp', sampleHwp(['한글 본문']), INDEX_WHO)).toContain('한글 본문')
    if (TOOLS.pdftotext) expect(await extractDocument('a.pdf', samplePdf(['PDF body text']), INDEX_WHO)).toContain('PDF body text')
  })

  test('a damaged document gives the parser\'s message, remembered like before', async () => {
    const err = await extractDocument('a.docx', new TextEncoder().encode('not a zip'), INDEX_WHO).catch((x) => x)
    expect(err).toBeInstanceOf(ExtractError)
    expect(err).not.toBeInstanceOf(ExtractUnavailable)
    expect(err.message).toMatch(/cannot extract text: not a zip file/)
  })
})
