// Shell resource attacks (plan §7.1 "셸 자원 고갈", §5.1 limits): every attack is bounded, and another token's `ls`
// keeps p99 < 200 ms while it runs. Attacks that do synchronous work in the server process cannot meet the second
// part in-process; they pass since commands run in the isolated executor (plan 5.1 "격리 실행기"). HEAVY lists why each
// one would block the server without it.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import { LIMITS } from '../../src/config'
import { closeDefaultExecutor, defaultExecutor } from '../../src/worker'
import { securitySetup, type SecEnv } from './fixture'

let e: SecEnv
beforeAll(async () => {
  e = securitySetup()
  e.addToken('attacker', 'kim', { name: 'kim-attacker' })
  e.addToken('victim', 'boss', { name: 'boss-victim' })
  await e.sh('attacker', 'cat /공용/c.md > /dev/null') // drafts get Src {공용}: kim's other tokens may read them (R4)
  const w = (p: string, content: string | Uint8Array) => e.ctx.blobs && e.tool('attacker', 'write', { path: p, content: typeof content === 'string' ? content : Buffer.from(content).toString('base64') })
  await w('/drafts/a30k.txt', 'a'.repeat(30_000) + '\n')
  // ~8 MB (the draft size limit): one million 7-digit lines
  await w('/drafts/big.txt', Array.from({ length: 1_000_000 }, (_, i) => String((i * 7919) % 1_000_003).padStart(7, '0')).join('\n') + '\n')
  // 512 MB of zeros, gzipped (~0.5 MB), stored base64
  await w('/drafts/bomb.b64', Bun.gzipSync(new Uint8Array(512 * 1024 * 1024)))
}, 60_000)
afterAll(() => e.cleanup())

const DEADLINE = LIMITS.commandMs + 3000

/**
 * Run `attack` as the attacker while the victim keeps running `ls /`. A request that arrives while the server's event
 * loop is blocked waits for it, so the latency a victim request arriving at time t sees is (first moment the loop runs
 * again after t) - t + the cost of an ls (measured before the attack). A 2 ms ticker gives those moments; requests are
 * virtual, every 10 ms of the attack. Real probes run too (and catch slowdowns that are not loop stalls).
 */
async function underAttack(attack: string, run: () => Promise<{ exitCode: number }> = () => e.sh('attacker', attack)) {
  const base: number[] = []
  for (let i = 0; i < 5; i++) { const s = performance.now(); await e.sh('victim', 'ls /'); base.push(performance.now() - s) }
  const lsCost = base.sort((a, b) => a - b)[2]!
  const ticks: number[] = []
  const ticker = setInterval(() => ticks.push(performance.now()), 2)
  const real: number[] = []
  let done = false
  const prober = (async () => { while (!done) { const s = performance.now(); await e.sh('victim', 'ls /'); real.push(performance.now() - s); await Bun.sleep(10) } })()
  const started = performance.now()
  const r = await run().finally(() => { done = true })
  const ended = performance.now()
  await prober
  clearInterval(ticks.push(performance.now()) && ticker)
  const lat: number[] = []
  let k = 0
  for (let t = started; t < ended; t += 10) {
    while (k < ticks.length && ticks[k]! < t) k++
    lat.push((ticks[k] ?? ended) - t + lsCost)
  }
  lat.push(...real)
  lat.sort((a, b) => a - b)
  const p99 = lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.99))]! : 0
  const ms = ended - started
  console.log(`[resource] ${JSON.stringify({ attack: attack.slice(0, 60), ms: Math.round(ms), exit: r.exitCode, probes: real.length, lsBaseline: +lsCost.toFixed(1), p99: Math.round(p99), max: Math.round(lat.at(-1) ?? 0) })}`)
  return { r, ms, p99 }
}

/** Bounded and does not stall other tokens (no synchronous whole-input work in the server process). */
const CHEAP: string[] = [
  "grep -E '(a|aa)*b' /drafts/a30k.txt | wc -c",
  "rg '(a*)*b' /drafts/a30k.txt",
  "rg 'a{1000}{1000}' /drafts/a30k.txt",
  "grep -E '(x+x+)+y' /drafts/big.txt",
  "awk '/(a+)+b/' /drafts/a30k.txt | wc -c",
  "sed -E 's/(a|aa)*b/x/' /drafts/a30k.txt | wc -c",
  'echo {1..10000000} | wc -c',
  'printf "%s" {1..100000000}',
  'yes | head -c 1000000000 | wc -c',
  'cat /dev/zero | head -c 100000000 | wc -c',
  'seq 1 100000000 | sort -r | head -1',
  'f(){ f; }; f',
  'f(){ f | f & }; f',
  ':(){ :|:& };:',
  'while true; do :; done',
  'x=a; while true; do x=$x$x; done',
  'printf "%0100000000d" 0 | wc -c',
  "awk 'BEGIN{while(1){}}'",
  "sed ':a;ba' /drafts/a30k.txt",
  'jq -n "def f: f; f"',
  'jq -n "[range(100000000)] | length"',
  'base64 -d /drafts/bomb.b64 | gunzip | wc -c',
  'cat /drafts/big.txt /drafts/big.txt /drafts/big.txt /drafts/big.txt | wc -l',
  'for i in 1 2 3 4 5 6 7 8 9 10; do find / > /dev/null; grep -r CANARY / > /dev/null; done',
  'eval "$(printf \'echo x;%.0s\' {1..50000})"',
  'sleep 1000',
  'timeout 1000 sleep 1000',
  'split -b 1 /drafts/a30k.txt /drafts/piece',
]

/** Synchronous whole-input work inside the server process (just-bash builtins on an 8 MB input). */
const HEAVY: [string, string][] = [
  ['for ((i=0;;i++)); do echo $i; done | tail -1', 'the just-bash interpreter runs a loop on microtasks without yielding to the event loop (~0.5 s up to the 10 000-command cap)'],
  ['sort /drafts/big.txt | head -1', 'just-bash sort is synchronous in-process'],
  ['sort -u /drafts/big.txt | wc -l', 'just-bash sort is synchronous in-process'],
  ["sed 's/0/x/g' /drafts/big.txt | tail -1", 'just-bash sed runs synchronously over the whole input'],
  ['md5sum /drafts/big.txt /drafts/big.txt /drafts/big.txt /drafts/big.txt', 'hashing 32 MB in JS blocks the event loop'],
]

describe('every attack is bounded (time, output, exit code)', () => {
  test.each([...CHEAP, ...HEAVY.map(([c]) => c)].map((c) => [c]))('%s', async (c) => {
    const t0 = performance.now()
    const r = await e.sh('attacker', c)
    const ms = performance.now() - t0
    expect(ms).toBeLessThan(DEADLINE)
    expect(Buffer.byteLength(r.stdout)).toBeLessThanOrEqual(LIMITS.stdoutBytes + 200)
    expect(Buffer.byteLength(r.stderr)).toBeLessThanOrEqual(LIMITS.stderrBytes + 200)
    expect(typeof r.exitCode).toBe('number')
  }, DEADLINE + 5000)
})

describe('another token\'s ls keeps p99 < 200 ms during the attack', () => {
  test.each(CHEAP.filter((c) => !c.startsWith('sleep') && !c.startsWith('timeout')).map((c) => [c]))('%s', async (c) => {
    const { p99 } = await underAttack(c)
    expect(p99).toBeLessThan(200)
  }, DEADLINE + 10_000)

  test('sleep holds only its own call (other tokens are unaffected)', async () => {
    const { p99 } = await underAttack('sleep 2')
    expect(p99).toBeLessThan(200)
  }, 30_000)

  // These block the server when commands run in-process (TDRIVE_SHELL=inprocess); the isolated executor keeps them off it.
  for (const [c, why] of HEAVY) {
    test.skipIf(process.env.TDRIVE_SHELL === 'inprocess')(`${c}  [isolated executor: in-process ${why}]`, async () => {
      const { p99 } = await underAttack(c)
      expect(p99).toBeLessThan(200)
    }, DEADLINE + 10_000)
  }

  test.skipIf(process.env.TDRIVE_SHELL === 'inprocess')('five tokens of one person running heavy commands at once  [isolated executor: per-token/person limits]', async () => {
    const extra = ['a1', 'a2', 'a3', 'a4', 'a5']
    for (const n of extra) e.addToken(n, 'kim', { name: `kim-${n}` })
    const { r } = await underAttack('5 x sort of an 8 MB draft', async () => {
      const rs = await Promise.all(extra.map((n) => e.sh(n, 'sort /drafts/@kim-attacker/big.txt | head -1')))
      expect(rs.every((x) => !x.stderr.includes('No such file'))).toBe(true)
      return rs[0]!
    })
    expect(r.exitCode).not.toBe(0) // the output cap stops each sort
    expect((await underAttack('noop', async () => ({ exitCode: 0 }))).p99).toBeLessThan(200)
    expect((await underAttack('5 x sort again', () => Promise.all(extra.map((n) => e.sh(n, 'sort /drafts/@kim-attacker/big.txt | head -1'))).then((x) => x[0]!))).p99).toBeLessThan(200)
  }, 60_000)
})

describe('limits that are not built yet', () => {
})

describe('memory cap per command: what one call may read into the server (scaled down: 9 MB per file, 20 MB per call)', () => {
  const saved = { file: LIMITS.fileBytes, call: LIMITS.callReadBytes }
  const big = [1, 2, 3, 4, 5].map((i) => `/공용/big${i}.txt`)
  const SIZE = 6 << 20
  beforeAll(() => {
    LIMITS.fileBytes = 9 << 20
    LIMITS.callReadBytes = 20 << 20
    for (const p of big) fs.writeFileSync(e.R(p.slice(1)), 'x\n'.repeat(SIZE / 2))
    fs.writeFileSync(e.R('공용/huge.txt'), 'y\n'.repeat(5 << 20))
  })
  afterAll(() => { LIMITS.fileBytes = saved.file; LIMITS.callReadBytes = saved.call })

  test('a command over many large originals stops at the per-call cap with a clear reason', async () => {
    const r = await e.sh('attacker', `wc -l ${big.join(' ')}`)
    // three files fit in 20 MB; the 4th and 5th are refused before anything is read
    for (const p of big.slice(0, 3)) expect(r.stdout).toContain(`${SIZE / 2} ${p}`)
    for (const p of big.slice(3)) expect(r.stdout).not.toContain(p)
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr).toContain(`${big[3]}: not read: one command may read at most 20 MB of files (this one had read 18 MB)`)
    // the next call starts from zero
    expect((await e.sh('attacker', `wc -l < ${big[4]}`)).stdout.trim()).toBe(String(SIZE / 2))
  })

  test('a file above the per-file cap is refused, not read', async () => {
    const r = await e.sh('attacker', 'wc -l /공용/huge.txt; sha256sum /.raw/공용/huge.txt')
    expect(r.stdout).not.toMatch(/[0-9a-f]{64}|^\d+ /m) // neither a count nor a hash: nothing was read
    expect(r.stderr).toContain('/공용/huge.txt: file too large to read (one file may be at most 9 MB)')
    expect(r.stderr).toContain('/.raw/공용/huge.txt: file too large to read')
    const t = await e.tool('attacker', 'read', { path: '/공용/huge.txt' })
    expect(t.isError).toBe(true)
    expect(t.content[0]!.text).toMatch(/^EFBIG: file too large to read/)
  })

  test('drafts count too', async () => {
    const r = await e.sh('attacker', 'wc -l /drafts/big.txt /drafts/big.txt /drafts/big.txt')
    expect(r.stdout).toContain('1000000 /drafts/big.txt')
    expect(r.stderr).toContain('/drafts/big.txt: not read: one command may read at most 20 MB of files (this one had read 15 MB)')
  })

  test('with the budget spent, a hidden path and a missing one still answer the same', async () => {
    const spend = `wc -l ${big.slice(0, 3).join(' ')} > /dev/null; `
    const norm = (x: { stdout: string; stderr: string; exitCode: number }, p: string) => JSON.stringify(x).replaceAll(p, 'P')
    for (const [hidden, missing] of [['/경영/c.md', '/경영/nope.md'], ['/인사/c.csv', '/인사/nope.csv'], ['/경영/c.md', '/nowhere/c.md']] as const) {
      for (const probe of ['cat P', 'head -1 P', 'wc -c P', 'sha256sum P', 'cp P /drafts/x.md', 'grep x P', 'cat /.rawP']) {
        const a = await e.sh('attacker', spend + probe.replaceAll('P', hidden))
        const b = await e.sh('attacker', spend + probe.replaceAll('P', missing))
        expect(norm(a, hidden)).toBe(norm(b, missing))
      }
    }
  })
})

// Plan 5.1: per-token / per-person / global limits on commands running at once, through the MCP tool path (callTool ->
// runShell -> the process-wide executor). The executor is restarted with small limits from the environment
// (TDRIVE_WORKERS_*). The in-process shell (development only) has no executor and no such limits.
describe.skipIf(process.env.TDRIVE_SHELL === 'inprocess')('concurrent command limits (plan 5.1) through the bash tool', () => {
  const LIM = { TDRIVE_WORKERS_GLOBAL: '4', TDRIVE_WORKERS_PER_TOKEN: '2', TDRIVE_WORKERS_PER_PERSON: '3', TDRIVE_WORKERS_QUEUE: '4' }
  const saved: Record<string, string | undefined> = {}
  beforeAll(async () => {
    for (const [k, v] of Object.entries(LIM)) { saved[k] = process.env[k]; process.env[k] = v }
    await closeDefaultExecutor()
    for (const n of ['c1', 'c2', 'c3']) e.addToken(n, 'kim', { name: `kim-${n}` })
  })
  afterAll(async () => {
    for (const k of Object.keys(LIM)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
    await closeDefaultExecutor()
  })

  /** Runs the calls at once while sampling the executor; returns the most seen running per token, per person, overall. */
  async function flood(calls: [string, string][]) {
    const ex = defaultExecutor()
    expect(ex.info().limits).toMatchObject({ global: 4, perToken: 2, perPerson: 3, maxQueuedPerToken: 4 })
    const peak = { token: new Map<string, number>(), person: new Map<string, number>(), global: 0 }
    const sample = () => {
      const i = ex.info()
      peak.global = Math.max(peak.global, i.running)
      for (const [k, v] of Object.entries(i.runningBy.token)) peak.token.set(k, Math.max(peak.token.get(k) ?? 0, v))
      for (const [k, v] of Object.entries(i.runningBy.person)) peak.person.set(k, Math.max(peak.person.get(k) ?? 0, v))
    }
    const timer = setInterval(sample, 2)
    const t0 = performance.now()
    const results = await Promise.all(calls.map(([who, cmd]) => e.tool(who, 'bash', { command: cmd })))
    const ms = performance.now() - t0
    clearInterval(timer)
    const texts = results.map((r) => r.content.map((c) => c.text).join('\n'))
    const tokenPeak = (who: string) => peak.token.get(String(e.tok(who).id)) ?? 0
    const personPeak = (who: string) => peak.person.get(String(e.tok(who).person_id)) ?? 0
    console.log(`[limits] ${calls.length} calls in ${Math.round(ms)} ms; peak running ${peak.global}`)
    return { texts, ms, global: peak.global, tokenPeak, personPeak }
  }

  test('per token: one token\'s 4 commands run 2 at a time', async () => {
    const r = await flood(Array.from({ length: 4 }, () => ['c1', 'sleep 0.5; echo done'] as [string, string]))
    expect(r.texts.every((t) => t.includes('done') && t.includes('[exit code 0]'))).toBe(true)
    expect(r.tokenPeak('c1')).toBe(2)
    expect(r.ms).toBeGreaterThanOrEqual(1000) // two waves
  })

  test('per person: three tokens of one person run at most 3 commands together', async () => {
    const r = await flood((['c1', 'c2', 'c3'] as const).flatMap((w) => [[w, 'sleep 0.5; echo done'], [w, 'sleep 0.5; echo done']] as [string, string][]))
    expect(r.texts.every((t) => t.includes('done'))).toBe(true)
    expect(r.personPeak('c1')).toBe(3)
    for (const w of ['c1', 'c2', 'c3']) expect(r.tokenPeak(w)).toBeLessThanOrEqual(2)
    expect(r.ms).toBeGreaterThanOrEqual(1000)
  })

  test('global: five people at once run at most 4 commands overall', async () => {
    const people = ['dion', 'kim', 'boss', 'lee', 'park']
    const r = await flood(people.flatMap((w) => [[w, 'sleep 0.5; echo done'], [w, 'sleep 0.5; echo done']] as [string, string][]))
    expect(r.texts.every((t) => t.includes('done'))).toBe(true)
    expect(r.global).toBe(4)
    for (const w of people) expect(r.personPeak(w)).toBeLessThanOrEqual(2)
    expect(r.ms).toBeGreaterThanOrEqual(1500) // 10 jobs, 4 at a time: three waves
  })

  test('a token past its queue is told to retry, others are not affected', async () => {
    const r = await flood([...Array.from({ length: 9 }, () => ['c2', 'sleep 0.3; echo done'] as [string, string]), ['boss', 'echo boss-ok']])
    const busy = r.texts.filter((t) => t.includes('too many commands are running for this token'))
    expect(busy.length).toBe(3) // 2 running + 4 waiting
    expect(r.texts.filter((t) => t.includes('done')).length).toBe(6)
    expect(r.texts.at(-1)).toContain('boss-ok')
  })
})

describe('draft quota (count and bytes per token, bytes per person; scaled down: 5 drafts / 1 MB per token, 1.5 MB per person)', () => {
  const saved = { files: LIMITS.draftFilesPerToken, bytes: LIMITS.draftBytesPerToken, person: LIMITS.draftBytesPerPerson }
  beforeAll(() => {
    LIMITS.draftFilesPerToken = 5
    LIMITS.draftBytesPerToken = 1 << 20
    LIMITS.draftBytesPerPerson = 1.5 * (1 << 20)
    for (const n of ['q1', 'q2', 'q3']) e.addToken(n, 'park', { name: `park-${n}` })
    e.addToken('q4', 'lee', { name: 'lee-q4' })
  })
  afterAll(() => { LIMITS.draftFilesPerToken = saved.files; LIMITS.draftBytesPerToken = saved.bytes; LIMITS.draftBytesPerPerson = saved.person })
  const write = (who: string, path: string, content: string) => e.tool(who, 'write', { path, content })
  const live = (who: string) => e.db.query<{ n: number }, [number]>('SELECT count(*) AS n FROM drafts WHERE token_id = ? AND deleted_at IS NULL').get(e.tok(who).id)!.n

  test('count: the 6th draft of a token is refused; overwriting and replacing a deleted one are not', async () => {
    for (let i = 1; i <= 5; i++) expect((await write('q4', `/drafts/n${i}.md`, `note ${i}`)).isError).toBeFalsy()
    const r = await write('q4', '/drafts/n6.md', 'one too many')
    expect(r.isError).toBe(true)
    expect(r.content[0]!.text).toMatch(/^EDQUOT: draft quota exceeded: a token may keep at most 5 drafts \(this one has 5\)\. Delete drafts/)
    expect((await write('q4', '/drafts/n1.md', 'rewritten')).isError).toBeFalsy()
    const sh = await e.sh('q4', 'rm /drafts/n2.md && echo new > /drafts/n6.md && cat /drafts/n6.md')
    expect(sh.stdout).toBe('new\n')
    expect(live('q4')).toBe(5)
  })

  test('count through the shell: a loop creating drafts stops at the quota, with the reason on stderr', async () => {
    const r = await e.sh('q3', 'for i in 1 2 3 4 5 6 7 8; do echo $i > /drafts/s$i.md; done; ls /drafts | wc -l')
    expect(r.stdout.trim()).toBe('5')
    expect(r.stderr).toContain('draft quota exceeded: a token may keep at most 5 drafts')
    expect(live('q3')).toBe(5)
  })

  test('bytes per token: a write that takes the token over 1 MB is refused; shrinking is allowed', async () => {
    const kb = (n: number) => 'x'.repeat(n * 1024)
    expect((await write('q1', '/drafts/a.md', kb(600))).isError).toBeFalsy()
    const r = await write('q1', '/drafts/b.md', kb(600))
    expect(r.isError).toBe(true)
    expect(r.content[0]!.text).toContain("draft quota exceeded: a token's drafts may hold at most 1 MB")
    expect((await write('q1', '/drafts/a.md', kb(100))).isError).toBeFalsy()
    expect((await write('q1', '/drafts/b.md', kb(600))).isError).toBeFalsy()
    // appending through the shell is checked on the grown size
    const sh = await e.sh('q1', 'head -c 400000 /drafts/b.md >> /drafts/a.md')
    expect(sh.exitCode).not.toBe(0)
    expect(sh.stderr).toContain('draft quota exceeded')
    expect((await e.sh('q1', 'wc -c < /drafts/a.md')).stdout.trim()).toBe(String(100 * 1024))
  })

  test('bytes per person: two tokens of one person together stay under 1.5 MB', async () => {
    // q1 holds 700 KB now; q2 may add 700 KB (1.4 MB in all) but not another 200 KB
    expect((await write('q2', '/drafts/c.md', 'y'.repeat(700 * 1024))).isError).toBeFalsy()
    const r = await write('q2', '/drafts/d.md', 'y'.repeat(200 * 1024))
    expect(r.isError).toBe(true)
    expect(r.content[0]!.text).toContain("draft quota exceeded: one person's drafts (all tokens) may hold at most 1.5 MB")
    // another person is not affected
    expect((await write('q4', '/drafts/n1.md', 'y'.repeat(200 * 1024))).isError).toBeFalsy()
  })
})
