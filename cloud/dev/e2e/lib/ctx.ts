// One scenario run: its checks, the parts that cannot run yet (pending: a feature another workstream has not merged)
// and the scenario's verdict. A scenario never stops at the first failed check: it reports every check, like
// cloud/dev/e2e.ts.
import type { Features, Feature } from './features'
import type { Fixture } from './fixture'
import type { Http } from './http'
import type { Target } from './target'

export type Verdict = 'PASS' | 'PARTIAL' | 'PENDING' | 'FAIL' | 'SKIP' | 'ERROR'

export interface Scenario {
  id: string
  title: string
  phase: 1 | 2
  /** where it can run; others report SKIP */
  targets: ('local' | 'aws')[]
  /** features without which nothing of it can run: the whole scenario is PENDING */
  needs?: Feature[]
  /** the harness pieces it uses, for the table: H1 (HTTP), H2 (browser), MCP, DAV, OPS */
  uses: string
  run(t: T): Promise<void>
}

export class SkipScenario extends Error {}

export interface Result {
  id: string; title: string; verdict: Verdict; passed: number; failed: number
  pending: string[]; failures: string[]; skipped?: string; ms: number; uses: string
}

export class T {
  passed = 0
  failed = 0
  pendings: string[] = []
  failures: string[] = []
  private started = Date.now()

  constructor(public id: string, public target: Target, public http: Http, public features: Features, public fx: Fixture, private verbose: boolean) {}

  log(s: string) { if (this.verbose) console.log(s) }
  step(s: string) { this.log(`  -- ${s} (${Math.round((Date.now() - this.started) / 1000)}s)`) }

  check(what: string, ok: boolean, detail?: unknown): boolean {
    if (ok) { this.passed++; this.log(`    ok   ${what}`) } else {
      this.failed++
      const d = detail === undefined ? '' : typeof detail === 'string' ? detail : safeJson(detail)
      this.failures.push(`${what}${d ? ` — ${d.slice(0, 400)}` : ''}`)
      this.log(`    FAIL ${what}${d ? `\n         ${d.slice(0, 600)}` : ''}`)
    }
    return ok
  }

  /** a part that cannot run yet; the scenario is PARTIAL (or PENDING when nothing ran) */
  pending(what: string, reason: string) {
    const line = `${what}: ${reason}`
    if (!this.pendings.includes(line)) this.pendings.push(line)
    this.log(`    PEND ${line}`)
  }

  /**
   * true when the feature is there; otherwise records `what` as pending with the feature's reason. Use as
   *   if (await t.has('share', 'Editor shares by default')) { … }
   */
  async has(f: Feature, what: string): Promise<boolean> {
    const r = await this.features.get(f)
    if (!r.ok) this.pending(what, r.reason)
    return r.ok
  }

  skip(reason: string): never { throw new SkipScenario(reason) }

  verdict(): Verdict {
    if (this.failed) return 'FAIL'
    if (this.pendings.length) return this.passed ? 'PARTIAL' : 'PENDING'
    return this.passed ? 'PASS' : 'PENDING'
  }
}

export function safeJson(x: unknown): string {
  try { return JSON.stringify(x) } catch { return String(x) }
}

/** check helpers shared by scenarios */
export const has = (s: string | undefined | null, ...needles: string[]) => !!s && needles.every((n) => s.includes(n))
export const lacks = (s: string | undefined | null, ...needles: string[]) => !needles.some((n) => (s ?? '').includes(n))
