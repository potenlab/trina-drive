// Two-step verification for Trina Cloud accounts (review finding 3): owners and admins of a team must have an
// authenticator app (TOTP); member, role, ownership and deletion changes need a code from the last 5 minutes (step-up).
// The RFC 6238 functions are copied from the product (src/web/totp.ts) — the control plane has no dependencies.
// The secret is kept wrapped by the KeyWrapper (KMS in production, context {purpose: 'totp', user}); each 30-second
// step is accepted once per account (replay). Ten one-time recovery codes (sha256 only) for a lost phone.
import crypto from 'node:crypto'
import { audit } from './audit'
import { CloudError, type Cloud } from './cloud'
import { sha256 } from './util'

export const TOTP_STEP_S = 30
export const TOTP_DIGITS = 6
/** Steps accepted on either side of now (clock drift): ±1 step = a 90-second window. */
export const TOTP_WINDOW = 1
/** how long a code counts for the sensitive actions after it was typed */
export const STEP_UP_MS = 5 * 60_000
/** how fresh the password (or email link) must be to turn two-step verification on or off */
export const FRESH_AUTH_MS = 15 * 60_000
export const RECOVERY_CODES = 10

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(b: Uint8Array): string {
  let bits = 0, value = 0, out = ''
  for (const byte of b) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5 }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(s: string): Uint8Array {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '')
  let bits = 0, value = 0
  const out: number[] = []
  for (const c of clean) {
    const i = B32.indexOf(c)
    if (i < 0) throw new Error('bad base32')
    value = (value << 5) | i
    bits += 5
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8 }
  }
  return Uint8Array.from(out)
}

export const newTotpSecret = () => base32Encode(crypto.randomBytes(20))

export function hotp(secret: Uint8Array, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter))
  const h = crypto.createHmac('sha1', secret).update(msg).digest()
  const off = h[h.length - 1]! & 0x0f
  const bin = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!
  return String(bin % 10 ** digits).padStart(digits, '0')
}

export const stepAt = (ms: number) => Math.floor(ms / 1000 / TOTP_STEP_S)
export const totpAt = (secretB32: string, ms: number) => hotp(base32Decode(secretB32), stepAt(ms))

/** The step a presented code belongs to (within ±TOTP_WINDOW), or null; constant time per step. */
export function matchTotp(secretB32: string, code: unknown, ms: number): number | null {
  if (typeof code !== 'string') return null
  const c = code.replace(/\s/g, '')
  if (!/^\d{6}$/.test(c)) return null
  const key = base32Decode(secretB32)
  const now = stepAt(ms)
  let found: number | null = null
  for (let s = now - TOTP_WINDOW; s <= now + TOTP_WINDOW; s++) {
    if (crypto.timingSafeEqual(Buffer.from(hotp(key, s)), Buffer.from(c)) && found === null) found = s
  }
  return found
}

export function otpauthUri(issuer: string, account: string, secretB32: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`)
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_S}`
}

const recoveryCode = () => {
  const s = base32Encode(crypto.randomBytes(8)).slice(0, 10).toLowerCase()
  return `${s.slice(0, 5)}-${s.slice(5)}`
}
const normRecovery = (c: string) => c.trim().toLowerCase().replace(/[\s-]/g, '')

interface TotpRow { id: number; public_id: string | null; email: string; totp_secret_enc: string | null; totp_pending_enc: string | null; totp_last_step: number | null; recovery_hashes: string | null }

/** The console's TOTP operations on one control database. */
export class ConsoleMfa {
  constructor(private readonly c: Cloud) {}
  private row(userId: number) {
    const r = this.c.db.query<TotpRow, [number]>('SELECT id, public_id, email, totp_secret_enc, totp_pending_enc, totp_last_step, recovery_hashes FROM users WHERE id = ?').get(userId)
    if (!r) throw new CloudError('no_user', 'sign in first', 401)
    return r
  }
  private ctx(userId: number) { return { purpose: 'totp', user: String(userId) } }

  enabled(userId: number): boolean {
    return !!this.c.db.query<{ e: string | null }, [number]>('SELECT totp_secret_enc AS e FROM users WHERE id = ?').get(userId)?.e
  }

  /** Step 1 of enrolling: a new secret (kept pending until a code from it is confirmed). */
  async begin(userId: number): Promise<{ secret: string; uri: string }> {
    const r = this.row(userId)
    const secret = newTotpSecret()
    const enc = await this.c.keys.wrap(new TextEncoder().encode(secret), this.ctx(userId))
    this.c.db.query('UPDATE users SET totp_pending_enc = ? WHERE id = ?').run(enc, userId)
    return { secret, uri: otpauthUri('Trina Cloud', r.email, secret) }
  }

  /** Step 2: a code from the pending secret turns it on. Returns the recovery codes (shown once). */
  async confirm(userId: number, code: unknown, actor: string): Promise<string[]> {
    const r = this.row(userId)
    if (!r.totp_pending_enc) throw new CloudError('no_enrolment', 'start again: the setup expired', 409)
    const secret = new TextDecoder().decode(await this.c.keys.unwrap(r.totp_pending_enc, this.ctx(userId)))
    const step = matchTotp(secret, code, this.c.clock())
    if (step == null) throw new CloudError('bad_code', 'that code is not right; check the time on your phone and try the next one', 401)
    const codes = Array.from({ length: RECOVERY_CODES }, recoveryCode)
    this.c.db.query('UPDATE users SET totp_secret_enc = totp_pending_enc, totp_pending_enc = NULL, totp_enabled_at = ?, totp_last_step = ?, recovery_hashes = ? WHERE id = ?')
      .run(this.c.clock(), step, JSON.stringify(codes.map((x) => sha256(normRecovery(x)))), userId)
    audit(this.c.db, { actor, action: 'user.totp_enabled', detail: { user: userId } })
    await this.c.mailer.send({ to: r.email, subject: 'Two-step verification is on for your Trina Cloud account', text: `Two-step verification was turned on for ${r.email}. Signing in and changing members now need a code from your authenticator app.\n\nIf this wasn't you, write to ${this.c.cfg.opsEmail} right away.` }).catch(() => {})
    return codes
  }

  /** A code (or a recovery code) for this account; each TOTP step once. true = right. */
  async verify(userId: number, code: unknown): Promise<boolean> {
    const r = this.row(userId)
    if (!r.totp_secret_enc) return false
    if (typeof code !== 'string') return false
    if (/[a-z]/i.test(code)) return this.useRecovery(r, code)
    const secret = new TextDecoder().decode(await this.c.keys.unwrap(r.totp_secret_enc, this.ctx(userId)))
    const step = matchTotp(secret, code, this.c.clock())
    if (step == null || (r.totp_last_step != null && step <= r.totp_last_step)) return false
    // the update only wins when no other request used this step meanwhile
    return this.c.db.query('UPDATE users SET totp_last_step = ? WHERE id = ? AND coalesce(totp_last_step, -1) < ?').run(step, userId, step).changes === 1
  }

  private useRecovery(r: TotpRow, code: string): boolean {
    const hashes: string[] = r.recovery_hashes ? JSON.parse(r.recovery_hashes) : []
    const h = sha256(normRecovery(code))
    const i = hashes.indexOf(h)
    if (i < 0) return false
    hashes.splice(i, 1)
    this.c.db.query('UPDATE users SET recovery_hashes = ? WHERE id = ?').run(JSON.stringify(hashes), r.id)
    audit(this.c.db, { actor: `user:${r.id}`, action: 'user.recovery_code_used', detail: { left: hashes.length } })
    return true
  }

  recoveryLeft(userId: number): number {
    const r = this.c.db.query<{ h: string | null }, [number]>('SELECT recovery_hashes AS h FROM users WHERE id = ?').get(userId)
    return r?.h ? (JSON.parse(r.h) as string[]).length : 0
  }

  /** Off (members only: owners and admins must keep it). */
  disable(userId: number, actor: string) {
    if (this.mustHave(userId)) throw new CloudError('totp_required', 'owners and admins of a team must keep two-step verification on', 409)
    this.c.db.query('UPDATE users SET totp_secret_enc = NULL, totp_pending_enc = NULL, totp_enabled_at = NULL, recovery_hashes = NULL WHERE id = ?').run(userId)
    audit(this.c.db, { actor, action: 'user.totp_disabled', detail: { user: userId } })
  }

  /** Operator reset after a lost phone and lost recovery codes (CLI `users reset-totp`). */
  reset(userId: number, actor: string) {
    this.c.db.query('UPDATE users SET totp_secret_enc = NULL, totp_pending_enc = NULL, totp_enabled_at = NULL, recovery_hashes = NULL, totp_last_step = NULL WHERE id = ?').run(userId)
    this.c.db.query('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(this.c.clock(), userId)
    audit(this.c.db, { actor, action: 'user.totp_reset', detail: { user: userId } })
  }

  /** An owner or admin of any team (finding 3: they must have two-step verification). */
  mustHave(userId: number): boolean {
    return !!this.c.db.query("SELECT 1 FROM team_members m JOIN teams t ON t.id = m.team_id WHERE m.user_id = ? AND m.status = 'active' AND m.role IN ('owner','admin') AND t.status != 'deleted' LIMIT 1").get(userId)
  }
}
