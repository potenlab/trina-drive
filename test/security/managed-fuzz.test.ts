// The managed-storage security fuzz (file-level sharing, A2) inside `bun test`: 300 runs in three parts (the gate is
// FUZZ_RUNS=10000 bun run test:managed-fuzz, 0 violations; see test/security/managed-fuzz.ts).
import { expect, test } from 'bun:test'
import { runManagedFuzz } from './managed-fuzz'

const seed = Number(process.env.FUZZ_SEED ?? 20261023)
const runs = Number(process.env.MANAGED_FUZZ_TEST_RUNS ?? 300)
const parts = 3
for (let k = 0; k < parts; k++) {
  test(`managed fuzz part ${k + 1}/${parts}: I1–I15 hold after every operation and on every surface`, async () => {
    const per = Math.ceil(runs / parts)
    const stats = await runManagedFuzz({ runs: per, seed, from: k * per, log: (s) => { if (s.startsWith('VIOLATION')) console.log(s) } })
    console.log(`[managed-fuzz] part ${k + 1}: ${stats.runs} runs, ${stats.ops} ops, ${stats.checks} checks, ${stats.violations.length} violations, ${Math.round(stats.ms / 1000)} s`)
    expect(stats.violations.map((v) => `seed ${v.seed} op ${v.op} ${v.kind}: ${v.detail}`)).toEqual([])
    expect(stats.runs).toBe(per)
  }, 600_000)
}
