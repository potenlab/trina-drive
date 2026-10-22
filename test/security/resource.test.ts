// Shell resource attacks (plan §7.1 "셸 자원 고갈", §5.1 limits): every attack is bounded, and another token's `ls`
// keeps p99 < 200 ms while it runs. Attacks that do synchronous work in the server process cannot meet the second
// part in-process; they pass since commands run in the isolated executor (plan 5.1 "격리 실행기"). HEAVY lists why each
// one would block the server without it.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { LIMITS } from '../../src/config'
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

  // These block the server when commands run in-process (SHELF_SHELL=inprocess); the isolated executor keeps them off it.
  for (const [c, why] of HEAVY) {
    test.skipIf(process.env.SHELF_SHELL === 'inprocess')(`${c}  [isolated executor: in-process ${why}]`, async () => {
      const { p99 } = await underAttack(c)
      expect(p99).toBeLessThan(200)
    }, DEADLINE + 10_000)
  }

  test.skipIf(process.env.SHELF_SHELL === 'inprocess')('five tokens of one person running heavy commands at once  [isolated executor: per-token/person limits]', async () => {
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
  test.todo('per-token draft quota (count and bytes): today a token can store unlimited 8 MB drafts [owner: drafts]', () => {})
  test.todo('per-token / per-person / global concurrent command limits (plan 5.1) [owner: worker sandbox]', () => {})
  test.todo('memory cap per command: `cat` of many 64 MB originals is read whole into the server process [owner: worker sandbox]', () => {})
})
