// People on the web: passwords (argon2id), sessions (cookie value never stored, only its sha256), CSRF tokens bound to
// the session, one-time invite / reset links, the one-time setup token printed by `init`, and a login rate limit.
// Nothing here trusts loopback or "local" requests (plan 7.1).
import crypto from 'node:crypto'
import type { DB } from '../db'
import { NAME } from '../config'
import { sha256 } from '../store'
import { ensureWebSchema, metaGet, metaSet } from './schema'

export const SESSION_COOKIE = `${NAME}_session`
export const SESSION_IDLE_MS = 12 * 3600_000
export const SESSION_MAX_MS = 7 * 86400_000
export const INVITE_TTL_MS = 7 * 86400_000
export const RESET_TTL_MS = 3600_000
export const SETUP_TTL_MS = 7 * 86400_000
export const PASSWORD_MIN = 10

const random = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url')
const now = () => Date.now()

export class AuthError extends Error {
  constructor(readonly code: string, message = code, readonly status = 400) { super(message) }
}

// ---------- passwords ----------
export function checkPasswordRules(pw: unknown): string {
  if (typeof pw !== 'string') throw new AuthError('password_required', 'password required')
  if ([...pw].length < PASSWORD_MIN) throw new AuthError('password_too_short', `password must be at least ${PASSWORD_MIN} characters`)
  if (pw.length > 256) throw new AuthError('password_too_long', 'password is too long')
  return pw
}
export const hashPassword = (pw: string) => Bun.password.hash(pw, { algorithm: 'argon2id' })
/** Spent on unknown names too, so a wrong name and a wrong password take the same time. */
let dummyHash: Promise<string> | null = null
export async function verifyPassword(pw: string, hash: string | null | undefined): Promise<boolean> {
  if (!hash) { dummyHash ??= hashPassword(random()); await Bun.password.verify(pw, await dummyHash).catch(() => false); return false }
  return Bun.password.verify(pw, hash).catch(() => false)
}

export interface Account { person_id: number; name: string; admin: number; active: number; email: string; password_hash: string | null }

export function accountByLogin(db: DB, login: string): Account | null {
  ensureWebSchema(db)
  const l = login.trim().normalize('NFC')
  return db.query<Account, [string, string]>(
    `SELECT a.person_id, p.name, p.admin, p.active, a.email, a.password_hash FROM accounts a JOIN people p ON p.id = a.person_id
     WHERE a.email = ? COLLATE NOCASE OR p.name = ? LIMIT 1`).get(l, l)
}
export function accountOf(db: DB, personId: number) {
  ensureWebSchema(db)
  return db.query<{ email: string; password_hash: string | null; password_set_at: number | null }, [number]>(
    'SELECT email, password_hash, password_set_at FROM accounts WHERE person_id = ?').get(personId)
}

export async function setPassword(db: DB, personId: number, pw: string) {
  const hash = await hashPassword(checkPasswordRules(pw))
  db.query('UPDATE accounts SET password_hash = ?, password_set_at = ? WHERE person_id = ?').run(hash, now(), personId)
}

// ---------- sessions ----------
export interface WebSession { idHash: string; personId: number; csrf: string; name: string; admin: boolean }

/** A fresh session id every time (never reuses one the browser brought: no session fixation). */
export function createSession(db: DB, personId: number, userAgent?: string): { cookie: string; csrf: string } {
  ensureWebSchema(db)
  const cookie = random(32), csrf = random(24), t = now()
  db.query('INSERT INTO web_sessions (id_hash, person_id, csrf, created_at, last_seen_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(sha256(cookie), personId, csrf, t, t, t + SESSION_MAX_MS, userAgent?.slice(0, 200) ?? null)
  return { cookie, csrf }
}

export function lookupSession(db: DB, cookie: string | undefined): WebSession | null {
  if (!cookie || cookie.length > 100) return null
  ensureWebSchema(db)
  const s = db.query<{ id_hash: string; person_id: number; csrf: string; last_seen_at: number; expires_at: number; revoked_at: number | null; name: string; admin: number; active: number }, [string]>(
    `SELECT s.*, p.name, p.admin, p.active FROM web_sessions s JOIN people p ON p.id = s.person_id WHERE s.id_hash = ?`).get(sha256(cookie))
  const t = now()
  if (!s || s.revoked_at != null || !s.active || s.expires_at <= t || s.last_seen_at + SESSION_IDLE_MS <= t) return null
  if (t - s.last_seen_at > 60_000) db.query('UPDATE web_sessions SET last_seen_at = ? WHERE id_hash = ?').run(t, s.id_hash)
  return { idHash: s.id_hash, personId: s.person_id, csrf: s.csrf, name: s.name, admin: !!s.admin }
}

export function revokeSession(db: DB, idHash: string) {
  db.query('UPDATE web_sessions SET revoked_at = ? WHERE id_hash = ? AND revoked_at IS NULL').run(now(), idHash)
}
/** All of a person's sessions (but one, when given). */
export function revokeSessionsOf(db: DB, personId: number, exceptIdHash?: string) {
  ensureWebSchema(db)
  db.query('UPDATE web_sessions SET revoked_at = ? WHERE person_id = ? AND revoked_at IS NULL AND id_hash != ?').run(now(), personId, exceptIdHash ?? '')
}
export function revokeTokensOf(db: DB, personId: number): number {
  return db.query('UPDATE tokens SET revoked_at = ? WHERE person_id = ? AND revoked_at IS NULL').run(now(), personId).changes
}

export const csrfOk = (s: WebSession, presented: string | null) =>
  !!presented && presented.length === s.csrf.length && crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(s.csrf))

// ---------- one-time links ----------
export type LinkKind = 'invite' | 'reset'

/** A new link; earlier unused links of the same kind for that person stop working. */
export function createLink(db: DB, kind: LinkKind, personId: number, by: number | null): string {
  ensureWebSchema(db)
  const secret = random(32), t = now()
  db.query('UPDATE web_links SET used_at = ? WHERE kind = ? AND person_id = ? AND used_at IS NULL').run(t, kind, personId)
  db.query('INSERT INTO web_links (kind, secret_hash, person_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(kind, sha256(secret), personId, by, t, t + (kind === 'invite' ? INVITE_TTL_MS : RESET_TTL_MS))
  return secret
}

/** The person a live link is for, without using it up. */
export function peekLink(db: DB, kind: LinkKind, secret: unknown): number | null {
  if (typeof secret !== 'string' || secret.length > 100) return null
  ensureWebSchema(db)
  const l = db.query<{ person_id: number }, [string, string, number]>(
    'SELECT person_id FROM web_links WHERE kind = ? AND secret_hash = ? AND used_at IS NULL AND expires_at > ?').get(kind, sha256(secret), now())
  return l?.person_id ?? null
}

/** Use a link up (exactly once, even with two requests at the same moment). */
export function consumeLink(db: DB, kind: LinkKind, secret: unknown): number | null {
  const personId = peekLink(db, kind, secret)
  if (personId == null) return null
  const r = db.query('UPDATE web_links SET used_at = ? WHERE kind = ? AND secret_hash = ? AND used_at IS NULL').run(now(), kind, sha256(secret as string))
  return r.changes === 1 ? personId : null
}

// ---------- the one-time setup token (printed by `init`) ----------
export const SETUP_PREFIX = `${NAME}_setup_`

/** Issue (or replace) the setup token. Only possible while no admin can sign in on the web. */
export function issueSetupToken(db: DB): string | null {
  ensureWebSchema(db)
  if (setupDone(db)) return null
  const secret = SETUP_PREFIX + random(24)
  metaSet(db, 'web_setup_token', JSON.stringify({ hash: sha256(secret), expires: now() + SETUP_TTL_MS }))
  return secret
}
export function setupDone(db: DB): boolean {
  ensureWebSchema(db)
  return !!db.query('SELECT 1 FROM accounts a JOIN people p ON p.id = a.person_id WHERE p.admin = 1 AND p.active = 1 AND a.password_hash IS NOT NULL LIMIT 1').get()
}
export function setupPending(db: DB): boolean {
  if (setupDone(db)) return false
  const v = metaGet(db, 'web_setup_token')
  return !!v && (JSON.parse(v) as { expires: number }).expires > now()
}
/** Checks and uses up the setup token. */
export function consumeSetupToken(db: DB, presented: unknown): boolean {
  const v = metaGet(db, 'web_setup_token')
  if (!v || typeof presented !== 'string' || setupDone(db)) return false
  const { hash, expires } = JSON.parse(v) as { hash: string; expires: number }
  const h = sha256(presented)
  if (expires <= now() || !crypto.timingSafeEqual(Buffer.from(h), Buffer.from(hash))) return false
  metaSet(db, 'web_setup_token', null)
  return true
}

// ---------- rate limit ----------
/** Fixed windows per key; used for sign-in (per name and per address) and for link use. */
export class RateLimiter {
  private readonly hits = new Map<string, { n: number; until: number }>()
  constructor(readonly max: number, readonly windowMs: number) {}
  /** false when the key is over its limit (the attempt is counted either way). */
  hit(key: string): boolean {
    const t = now()
    const h = this.hits.get(key)
    if (!h || h.until <= t) { this.hits.set(key, { n: 1, until: t + this.windowMs }); this.gc(t); return true }
    h.n++
    return h.n <= this.max
  }
  blocked(key: string) { const h = this.hits.get(key); return !!h && h.until > now() && h.n >= this.max }
  reset(key: string) { this.hits.delete(key) }
  private gc(t: number) { if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.until <= t) this.hits.delete(k) }
}
