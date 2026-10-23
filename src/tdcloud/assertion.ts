// The console's one-time sign-in assertion (docs/SSO-CONTRACT.md, test/fixtures/sso-v1.json): checked in the
// contract's order, the first failing check names the error. Pure: the caller supplies the clock, the cookie state and
// whether the jti was seen; recording the jti happens in the sign-in transaction (sso.ts).
import crypto from 'node:crypto'
import type { CloudConfig } from './config'

export const ASSERTION_MAX = 4096
export const SKEW_S = 60
export const MAX_LIFETIME_S = 120
const SHAPE = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/
const SIGNING_PREFIX = 'tdcloud-sso-v1.'
const REQUIRED = ['iss', 'aud', 'kid', 'sub', 'email', 'name', 'role', 'iat', 'nbf', 'exp', 'auth_time', 'jti', 'state_hash', 'amr', 'sync_seq'] as const

export type SsoError =
  | 'bad_state' | 'malformed' | 'unknown_kid' | 'bad_signature' | 'bad_issuer' | 'bad_audience'
  | 'not_yet_valid' | 'expired' | 'bad_lifetime' | 'replayed'
export const SSO_ERRORS: SsoError[] = ['bad_state', 'malformed', 'unknown_kid', 'bad_signature', 'bad_issuer', 'bad_audience', 'not_yet_valid', 'expired', 'bad_lifetime', 'replayed']

export type Role = 'owner' | 'admin' | 'member'
export interface Claims {
  iss: string; aud: string; kid: string; sub: string; email: string; name: string; role: Role
  iat: number; nbf: number; exp: number; auth_time: number; jti: string; state_hash: string
  amr: ('pwd' | 'link' | 'totp')[]; sync_seq: number
}
export type Verified = { ok: true; claims: Claims } | { ok: false; error: SsoError }

export const stateHash = (state: string) => crypto.createHash('sha256').update(state, 'utf8').digest('base64url')
const int = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x)
const same = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

export interface VerifyInput {
  assertion: unknown
  /** the posted state */
  state: unknown
  /** the state cookie this browser brought (null: none) */
  cookieState: string | null | undefined
  /** seconds */
  now: number
  seen: (jti: string) => boolean
}

export function verifyAssertion(cfg: Pick<CloudConfig, 'issuer' | 'team' | 'keys'>, v: VerifyInput): Verified {
  const fail = (error: SsoError): Verified => ({ ok: false, error })
  // 1. the browser that posts is the one that started (login CSRF)
  if (typeof v.state !== 'string' || !v.state || v.state.length > 200 || typeof v.cookieState !== 'string' || !same(v.cookieState, v.state)) return fail('bad_state')
  // 2. shape
  if (typeof v.assertion !== 'string' || v.assertion.length > ASSERTION_MAX) return fail('malformed')
  const m = SHAPE.exec(v.assertion)
  if (!m) return fail('malformed')
  let c: Record<string, unknown>
  try { c = JSON.parse(Buffer.from(m[1]!, 'base64url').toString('utf8')) } catch { return fail('malformed') }
  if (!c || typeof c !== 'object' || Array.isArray(c)) return fail('malformed')
  if (REQUIRED.some((k) => !(k in c))) return fail('malformed')
  if (!['iss', 'aud', 'kid', 'email', 'name', 'state_hash'].every((k) => typeof c[k] === 'string')) return fail('malformed')
  if (!/^usr_[0-9a-f]{20}$/.test(String(c.sub)) || !['owner', 'admin', 'member'].includes(String(c.role)) || !/^[A-Za-z0-9_-]{22}$/.test(String(c.jti))) return fail('malformed')
  if (!['iat', 'nbf', 'exp', 'auth_time', 'sync_seq'].every((k) => int(c[k])) || (c.sync_seq as number) < 0) return fail('malformed')
  if (!Array.isArray(c.amr) || !c.amr.every((a) => a === 'pwd' || a === 'link' || a === 'totp')) return fail('malformed')
  // 3–4. the key and the signature over the payload segment exactly as sent
  const key = cfg.keys.find((k) => k.kid === c.kid)
  if (!key) return fail('unknown_kid')
  let sigOk = false
  try { sigOk = crypto.verify(null, Buffer.from(SIGNING_PREFIX + m[1], 'ascii'), key.key, Buffer.from(m[2]!, 'base64url')) } catch { sigOk = false }
  if (!sigOk) return fail('bad_signature')
  // 5–6. for this console and this team
  if (c.iss !== cfg.issuer) return fail('bad_issuer')
  if (c.aud !== cfg.team) return fail('bad_audience')
  // 7. the clock (±60 s skew, at most 120 s of life)
  const { iat, nbf, exp } = c as unknown as Claims
  if (iat > v.now + SKEW_S || nbf > v.now + SKEW_S) return fail('not_yet_valid')
  if (v.now > exp + SKEW_S) return fail('expired')
  if (exp <= iat || exp - iat > MAX_LIFETIME_S) return fail('bad_lifetime')
  // 8. made for this state
  if (!same(String(c.state_hash), stateHash(v.state))) return fail('bad_state')
  // 9. once
  if (v.seen(String(c.jti))) return fail('replayed')
  return { ok: true, claims: c as unknown as Claims }
}
