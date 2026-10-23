// H4 — G1's smoke check (cloud/scripts/aws-smoke.ts: the 13 plan §6.3 checks + extras) as one gate item: on AWS with
// the deploy's own options (E2E_SMOKE_ARGS, e.g. "--team trina --profile tdcloud"), locally with --local when
// E2E_SMOKE_LOCAL=1 (it needs the smoke account and canary folder of cloud/README.md "Smoke check").
import path from 'node:path'
import type { Scenario } from '../lib/ctx'

const ROOT = path.resolve(import.meta.dir, '../../../..')

export default {
  id: 'H4', title: 'smoke check (G1 cloud/scripts/aws-smoke.ts) as one gate item', phase: 1, targets: ['local', 'aws'], uses: 'H4 OPS',
  async run(t) {
    if (t.target.kind === 'local' && process.env.E2E_SMOKE_LOCAL !== '1') t.skip('local: set E2E_SMOKE_LOCAL=1 (needs the smoke account; G1 runs it on the local stack)')
    const args = t.target.kind === 'local' ? ['--local', ...(process.env.E2E_SMOKE_ARGS ?? '').split(/\s+/).filter(Boolean)]
      : ['--base', t.target.control, ...(process.env.E2E_SMOKE_ARGS ?? `--team ${t.fx.slug}`).split(/\s+/).filter(Boolean)]
    const p = Bun.spawn(['bun', 'cloud/scripts/aws-smoke.ts', ...args], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
    const code = await p.exited
    for (const line of out.split('\n')) {
      const m = /^(ok|FAIL|skip)\s+(\S+)\s+(.*)$/.exec(line.trim())
      if (!m) continue
      if (m[1] === 'skip') t.skipPart(`smoke ${m[2]}`, m[3]!)
      else t.check(`smoke ${m[2]} ${m[3]}`, m[1] === 'ok')
    }
    t.check(`aws-smoke.ts exit ${code}`, code === 0, (err || out).slice(-400))
  },
} satisfies Scenario
