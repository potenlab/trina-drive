// Rate limits (plan 7.1 "로그인·MCP 속도 제한").
//   RateLimiter: fixed windows per key. With a database it lives in SQLite (table rate_limits), so a restart does not
//   hand an attacker a fresh set of sign-in attempts; keys are stored as sha256 (a password typed into the name field
//   is never kept). Used for sign-in per name and per address, one-time links and the setup token.
//   McpLimiter: /mcp requests per token and per address per minute, concurrent requests per token and per address
//   (in memory: a restart ends every request anyway), and failed bearer tokens per address.
import type { DB } from './db'
import { sha256 } from './store'

const RATE_SCHEMA = `CREATE TABLE IF NOT EXISTS rate_limits (
  scope TEXT NOT NULL, key_hash TEXT NOT NULL, n INTEGER NOT NULL, until INTEGER NOT NULL, PRIMARY KEY (scope, key_hash))`
const ready = new WeakSet<DB>()

export interface RateOptions { db?: DB; scope?: string; now?: () => number }

export class RateLimiter {
  private readonly hits = new Map<string, { n: number; until: number }>()
  private readonly now: () => number
  private lastGc = 0
  constructor(readonly max: number, readonly windowMs: number, private readonly o: RateOptions = {}) {
    this.now = o.now ?? Date.now
    if (o.db && !ready.has(o.db)) { o.db.exec(RATE_SCHEMA); ready.add(o.db) }
  }
  private get scope() { return this.o.scope ?? 'default' }

  /** false when the key is over its limit (the attempt is counted either way). */
  hit(key: string): boolean {
    const t = this.now()
    let h: { n: number; until: number }
    if (this.o.db) {
      h = this.o.db.query<{ n: number; until: number }, [string, string, number, number, number]>(
        `INSERT INTO rate_limits (scope, key_hash, n, until) VALUES (?, ?, 1, ?)
         ON CONFLICT (scope, key_hash) DO UPDATE SET n = CASE WHEN until <= ? THEN 1 ELSE n + 1 END,
           until = CASE WHEN until <= ? THEN excluded.until ELSE until END
         RETURNING n, until`).get(this.scope, sha256(key), t + this.windowMs, t, t)!
      this.gc(t)
    } else {
      const cur = this.hits.get(key)
      if (!cur || cur.until <= t) { h = { n: 1, until: t + this.windowMs }; this.hits.set(key, h); this.gc(t) } else { cur.n++; h = cur }
    }
    return h.n <= this.max
  }
  private entry(key: string): { n: number; until: number } | null {
    const h = this.o.db
      ? this.o.db.query<{ n: number; until: number }, [string, string]>('SELECT n, until FROM rate_limits WHERE scope = ? AND key_hash = ?').get(this.scope, sha256(key))
      : this.hits.get(key)
    return h && h.until > this.now() ? h : null
  }
  /** At the limit: the next attempt would be refused. */
  blocked(key: string) { const h = this.entry(key); return !!h && h.n >= this.max }
  /** Seconds until the key's window ends (at least 1). */
  retryAfter(key: string): number { const h = this.entry(key); return Math.max(1, Math.ceil(((h?.until ?? this.now()) - this.now()) / 1000)) }
  reset(key: string) {
    if (this.o.db) this.o.db.query('DELETE FROM rate_limits WHERE scope = ? AND key_hash = ?').run(this.scope, sha256(key))
    else this.hits.delete(key)
  }
  private gc(t: number) {
    if (this.o.db) {
      if (t - this.lastGc < 60_000) return
      this.lastGc = t
      this.o.db.query('DELETE FROM rate_limits WHERE until <= ?').run(t)
    } else if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.until <= t) this.hits.delete(k)
  }
}

export interface McpLimits {
  /** requests per minute for one token */
  tokenPerMin: number
  /** requests per minute from one address (all tokens, and requests without a valid token) */
  ipPerMin: number
  /** requests being handled at once for one token / from one address */
  tokenConcurrent: number
  ipConcurrent: number
  /** requests with a missing or wrong bearer token per minute from one address */
  badAuthPerMin: number
}
export const MCP_LIMITS: McpLimits = { tokenPerMin: 120, ipPerMin: 600, tokenConcurrent: 4, ipConcurrent: 16, badAuthPerMin: 30 }

export type Refusal = { reason: string; retryAfter: number }

export class McpLimiter {
  readonly limits: McpLimits
  private readonly byToken: RateLimiter
  private readonly byIp: RateLimiter
  private readonly badAuth: RateLimiter
  private readonly running = new Map<string, number>()
  constructor(limits: Partial<McpLimits> = {}, now?: () => number) {
    this.limits = { ...MCP_LIMITS, ...limits }
    this.byToken = new RateLimiter(this.limits.tokenPerMin, 60_000, { now })
    this.byIp = new RateLimiter(this.limits.ipPerMin, 60_000, { now })
    this.badAuth = new RateLimiter(this.limits.badAuthPerMin, 60_000, { now })
  }
  /** Before the token is checked: the address's request rate and its failed-token count. */
  checkAddress(ip: string): Refusal | null {
    if (this.badAuth.blocked(ip)) return { reason: 'too many requests with an invalid token from this address', retryAfter: this.badAuth.retryAfter(ip) }
    if (!this.byIp.hit(ip)) return { reason: 'too many requests from this address', retryAfter: this.byIp.retryAfter(ip) }
    return null
  }
  failedAuth(ip: string) { this.badAuth.hit(ip) }
  /** The token's request rate. */
  checkToken(tokenId: number): Refusal | null {
    const k = String(tokenId)
    return this.byToken.hit(k) ? null : { reason: 'too many requests for this token', retryAfter: this.byToken.retryAfter(k) }
  }
  /** Take a slot for one request (token and address); returns the release function, or a refusal. */
  acquire(tokenId: number, ip: string): (() => void) | Refusal {
    const kt = `t:${tokenId}`, ki = `a:${ip}`
    if ((this.running.get(kt) ?? 0) >= this.limits.tokenConcurrent) return { reason: 'too many requests at once for this token', retryAfter: 1 }
    if ((this.running.get(ki) ?? 0) >= this.limits.ipConcurrent) return { reason: 'too many requests at once from this address', retryAfter: 1 }
    for (const k of [kt, ki]) this.running.set(k, (this.running.get(k) ?? 0) + 1)
    let done = false
    return () => {
      if (done) return
      done = true
      for (const k of [kt, ki]) { const n = (this.running.get(k) ?? 1) - 1; if (n > 0) this.running.set(k, n); else this.running.delete(k) }
    }
  }
}
