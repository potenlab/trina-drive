#!/usr/bin/env bun
// Trina Cloud v1 end-to-end scenarios (plan §10.5), one file each under scenarios/, against the local stack or AWS.
//
//   bun cloud/dev/e2e/run.ts --phase 1                 every Phase 1 gate scenario, then a table
//   bun cloud/dev/e2e/run.ts --only S12,S17            just these (each runs alone: the fixture team is made/reused)
//   bun cloud/dev/e2e/run.ts --list                    the scenarios and what each needs
//   bun cloud/dev/e2e/run.ts --target aws --phase 1    the same against https://<E2E_TEAM>.cloud.trina.app (lib/target.ts)
//   options: --quiet (table only), --json FILE (results), --seed (make/seed the fixture team and stop),
//            --strict (exit 1 on PENDING/PARTIAL too: the release gate), --skip S05,S32
//
// Local: cloud/dev/up.sh --no-teams (fast) or cloud/dev/up.sh (also the legacy checks of cloud/dev/e2e.ts), then this.
// The browser flows use playwright-core (root devDependency) and its Chromium/WebKit (`bunx playwright@1.64.1 install
// chromium webkit` if they are not on this machine). UI1 runs C1's drive UI suite (web/e2e/run.mjs, its own fixture
// servers); H4 runs G1's smoke check (cloud/scripts/aws-smoke.ts).
//
// Verdicts: PASS (all checks ok) · PARTIAL (ran what exists; some parts wait for another workstream's merge) ·
// PENDING (nothing could run yet) · SKIP (not on this target) · FAIL · ERROR (the scenario threw).
// Exit code: 1 when anything FAILs or ERRORs (with --strict also when anything is PENDING/PARTIAL).
import fs from 'node:fs'
import { Features } from './lib/features'
import { Fixture } from './lib/fixture'
import { Http } from './lib/http'
import { SkipScenario, T, type Result, type Scenario } from './lib/ctx'
import { makeTarget, sh, type TargetKind } from './lib/target'
import { SCENARIOS } from './scenarios'

export interface Ctx { target: ReturnType<typeof makeTarget>; http: Http; features: Features; fx: Fixture }

export async function setup(o: { target: TargetKind; verbose: boolean }): Promise<Ctx> {
  const target = makeTarget(o.target)
  const http = new Http(target)
  const features = new Features(target, http)
  const fx = new Fixture(target, http, features, (s) => { if (o.verbose) console.log(s) })
  await fx.ready()
  features.reset()
  return { target, http, features, fx }
}


/**
 * Local only: every scenario comes from this one address, and the console counts sign-ups (10 an hour) and sign-ins
 * (30 per 15 minutes) per address, the drive its sign-ins (50 per 15 minutes). Their counters are cleared between
 * scenarios so the gate measures the flows, not the order they ran in; the limits themselves are tested in
 * cloud/control/test and test/ (and by the legacy suite's rate-limit checks).
 */
function resetLocalLimits(c: Ctx) {
  if (c.target.kind !== 'local') return
  const sql = (db: string, q: string) => `const { Database } = require('bun:sqlite'); const d = new Database(${JSON.stringify(db)}); d.exec('PRAGMA busy_timeout = 5000'); d.run(${JSON.stringify(q)})`
  sh(['docker', 'exec', 'tdc-control', 'bun', '-e', sql(`${c.target.devEnv.TDCLOUD_STATE_DIR}/control.db`, "DELETE FROM rate WHERE key LIKE 'signup:%' OR key LIKE 'login%' OR key LIKE 'verify:%'")])
  c.target.inTeam?.(c.target.team, ['/usr/local/bin/bun', '-e', sql('/data/db/store.db', "DELETE FROM rate_limits WHERE scope IN ('login_addr', 'login_name')")])
}

async function runOne(s: Scenario, c: Ctx, verbose: boolean): Promise<Result> {
  const t = new T(s.id, c.target, c.http, c.features, c.fx, verbose)
  const t0 = Date.now()
  const res = (verdict: Result['verdict'], skipped?: string): Result => ({ id: s.id, title: s.title, verdict, passed: t.passed, failed: t.failed, pending: t.pendings, failures: t.failures, warnings: t.warnings, optional: t.optional, skipped, ms: Date.now() - t0, uses: s.uses })
  if (verbose) console.log(`\n== ${s.id} ${s.title}`)
  if (!s.targets.includes(c.target.kind)) return res('SKIP', `local only (${s.targets.join(', ')})`)
  for (const f of s.needs ?? []) {
    const r = await c.features.get(f)
    if (!r.ok) t.pending('all of it', r.reason)
  }
  if (t.pendings.length) return res('PENDING')
  resetLocalLimits(c)
  try { await s.run(t) } catch (e) {
    if (e instanceof SkipScenario) return res('SKIP', e.message)
    t.failures.push(`threw: ${(e as Error).stack?.split('\n').slice(0, 4).join(' | ') ?? e}`)
    if (verbose) console.log(`    ERROR ${(e as Error).stack ?? e}`)
    return res('ERROR')
  }
  return res(t.verdict())
}

function table(rs: Result[]): string {
  const w = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n))
  const lines = [`${w('ID', 5)} ${w('VERDICT', 8)} ${w('OK', 4)} ${w('FAIL', 4)} ${w('TIME', 6)} ${w('USES', 14)} SCENARIO`]
  for (const r of rs) {
    lines.push(`${w(r.id, 5)} ${w(r.verdict, 8)} ${w(String(r.passed), 4)} ${w(String(r.failed), 4)} ${w(`${Math.round(r.ms / 1000)}s`, 6)} ${w(r.uses, 14)} ${r.title}`)
    for (const f of r.failures) lines.push(`        ✗ ${f}`)
    for (const p of r.pending) lines.push(`        … ${p}`)
    for (const x of r.warnings) lines.push(`        ! ${x}`)
    for (const x of r.optional) lines.push(`        - optional, not run: ${x}`)
    if (r.skipped) lines.push(`        - ${r.skipped}`)
  }
  const n = (v: string) => rs.filter((r) => r.verdict === v).length
  lines.push('', `${rs.length} scenarios: ${n('PASS')} pass, ${n('PARTIAL')} partial, ${n('PENDING')} pending, ${n('SKIP')} skip, ${n('FAIL')} fail, ${n('ERROR')} error · ${rs.reduce((a, r) => a + r.passed, 0)} checks ok, ${rs.reduce((a, r) => a + r.failed, 0)} failed`)
  return lines.join('\n')
}

async function main(argv: string[]) {
  const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
  const bool = (n: string) => argv.includes(n)
  const phase = Number(flag('--phase') ?? 1)
  const only = flag('--only')?.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean)
  const skip = new Set(flag('--skip')?.split(',').map((x) => x.trim().toUpperCase()) ?? [])
  const kind = (flag('--target') ?? process.env.E2E_TARGET ?? 'local') as TargetKind
  const verbose = !bool('--quiet')
  if (bool('--list')) {
    for (const s of SCENARIOS) console.log(`${s.id.padEnd(5)} P${s.phase} ${s.targets.join('+').padEnd(10)} ${s.uses.padEnd(14)} ${s.title}${s.needs?.length ? `   [needs ${s.needs.join(', ')}]` : ''}`)
    return 0
  }
  const unknown = only?.filter((id) => !SCENARIOS.some((s) => s.id === id))
  if (unknown?.length) { console.error(`unknown scenario ${unknown.join(', ')} (--list)`); return 2 }
  const list = SCENARIOS.filter((s) => (only ? only.includes(s.id) : s.phase === phase) && !skip.has(s.id))

  console.log(`Trina Cloud E2E · ${kind} · ${list.length} scenario(s)${only ? '' : ` of phase ${phase}`}`)
  const t0 = Date.now()
  let c: Ctx
  try { c = await setup({ target: kind, verbose }) } catch (e) {
    console.error(`\nfixture: ${(e as Error).message}`)
    return 1
  }
  console.log(`team ${c.fx.url} (${c.fx.s.mode} sign-in)`)
  if (bool('--seed')) { console.log(JSON.stringify(c.fx.s.seeded)); return 0 }
  const results: Result[] = []
  for (const s of list) results.push(await runOne(s, c, verbose))
  console.log(`\n${table(results)}\n(${Math.round((Date.now() - t0) / 1000)}s)`)
  const out = flag('--json')
  if (out) fs.writeFileSync(out, JSON.stringify({ target: kind, team: c.fx.slug, at: new Date().toISOString(), results }, null, 2))
  const bad = results.some((r) => r.verdict === 'FAIL' || r.verdict === 'ERROR')
  const open = results.some((r) => r.verdict === 'PENDING' || r.verdict === 'PARTIAL')
  return bad || (bool('--strict') && open) ? 1 : 0
}

if (import.meta.main) main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(e); process.exit(1) })
