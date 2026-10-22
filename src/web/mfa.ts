// Second factors for people on the web (plan 5.2 "관리자 2단계 인증", 7.1 "승인 시 패스키 단계 인증, 매직 링크 금지"):
//   - passkeys (WebAuthn, @simplewebauthn/server). The RP ID is the host of the configured public HTTPS address
//     (`serve --public-url https://files.example.com`); without one (LAN-only install) passkeys are unavailable and
//     approvals fall back to TOTP step-up.
//   - TOTP (RFC 6238, totp.ts) with replay protection (each 30-second step is accepted once per person).
//   - recovery codes (10, single use, sign-in only — never an approval step-up).
//   - sign-in tickets: a correct password of someone with a second factor gives a 5-minute ticket, not a session.
//   - step-up assertions: a short-lived (2 min), single-use secret bound to one session, person, approval id and
//     draft version hash; minted only after a fresh passkey (or, LAN-only, TOTP) check. Approving consumes it.
//
// "Admin 2FA" = a passkey or a confirmed TOTP. adminHas2FA / allAdminsHave2FA / requireAdmin2FA are the hook the public
// listener (OAuth, tunnel) calls: an install that opens a public address must have every admin on a second factor.
import crypto from 'node:crypto'
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type AuthenticatorTransportFuture, type RegistrationResponseJSON,
} from '@simplewebauthn/server'
import type { DB } from '../db'
import { NAME, PRODUCT } from '../config'
import { sha256 } from '../store'
import { matchTotp, newTotpSecret, otpauthUri } from './totp'

export const CHALLENGE_TTL_MS = 5 * 60_000
export const TICKET_TTL_MS = 5 * 60_000
export const TICKET_MAX_FAILURES = 5
export const STEPUP_TTL_MS = 2 * 60_000
export const RECOVERY_CODES = 10

const MFA_SCHEMA = `
CREATE TABLE IF NOT EXISTS mfa_passkeys (
  id INTEGER PRIMARY KEY, person_id INTEGER NOT NULL REFERENCES people(id), credential_id TEXT NOT NULL UNIQUE,
  public_key BLOB NOT NULL, counter INTEGER NOT NULL DEFAULT 0, transports TEXT, rp_id TEXT NOT NULL, name TEXT NOT NULL,
  created_at INTEGER NOT NULL, last_used_at INTEGER);
-- confirmed_at NULL = being set up (not a second factor yet); last_step = the last 30-second step accepted (replay)
CREATE TABLE IF NOT EXISTS mfa_totp (
  person_id INTEGER PRIMARY KEY REFERENCES people(id), secret TEXT NOT NULL, created_at INTEGER NOT NULL,
  confirmed_at INTEGER, last_step INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS mfa_recovery (
  id INTEGER PRIMARY KEY, person_id INTEGER NOT NULL REFERENCES people(id), code_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL, used_at INTEGER);
-- WebAuthn challenges: used once, short-lived, bound to what they are for (a session, a sign-in ticket, an approval)
CREATE TABLE IF NOT EXISTS mfa_challenges (
  challenge TEXT PRIMARY KEY, purpose TEXT NOT NULL CHECK (purpose IN ('register','login','stepup')),
  person_id INTEGER NOT NULL, bound TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
-- a sign-in waiting for its second factor (only the sha256 of the ticket is kept)
CREATE TABLE IF NOT EXISTS mfa_tickets (
  ticket_hash TEXT PRIMARY KEY, person_id INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0, used_at INTEGER);
-- approval step-ups (sha256 of the assertion), bound to session, person, approval and draft version hash
CREATE TABLE IF NOT EXISTS mfa_stepups (
  assertion_hash TEXT PRIMARY KEY, session_hash TEXT NOT NULL, person_id INTEGER NOT NULL, approval_id INTEGER NOT NULL,
  sha256 TEXT NOT NULL, method TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
`
const done = new WeakSet<DB>()
export function ensureMfaSchema(db: DB) {
  if (done.has(db)) return
  db.exec(MFA_SCHEMA)
  done.add(db)
}

const random = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url')

export class MfaError extends Error {
  constructor(readonly code: string, message = code, readonly status = 400) { super(message) }
}

// ---------- the relying party (passkeys) ----------
export interface PasskeyConfig { rpId: string; origin: string; rpName: string }

/**
 * Passkeys need a secure origin whose host is the RP ID: the configured public address over https (or http on
 * localhost, which browsers treat as secure — development only). Anything else (no public address, a LAN http
 * address): null, passkeys are unavailable and approvals use TOTP.
 */
export function passkeyConfig(publicUrl: string | undefined | null): PasskeyConfig | null {
  if (!publicUrl) return null
  let u: URL
  try { u = new URL(publicUrl) } catch { return null }
  const local = u.hostname === 'localhost' || u.hostname.endsWith('.localhost')
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null
  if (/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname) || u.hostname.startsWith('[')) return null // RP IDs are domains
  return { rpId: u.hostname, origin: u.origin, rpName: PRODUCT }
}

// ---------- who has what ----------
export function passkeysOf(db: DB, personId: number) {
  ensureMfaSchema(db)
  return db.query<{ id: number; name: string; rp_id: string; created_at: number; last_used_at: number | null; credential_id: string; transports: string | null }, [number]>(
    'SELECT id, name, rp_id, created_at, last_used_at, credential_id, transports FROM mfa_passkeys WHERE person_id = ? ORDER BY id').all(personId)
}
export function totpEnabled(db: DB, personId: number): boolean {
  ensureMfaSchema(db)
  return !!db.query('SELECT 1 FROM mfa_totp WHERE person_id = ? AND confirmed_at IS NOT NULL').get(personId)
}
export function recoveryRemaining(db: DB, personId: number): number {
  ensureMfaSchema(db)
  return db.query<{ n: number }, [number]>('SELECT count(*) AS n FROM mfa_recovery WHERE person_id = ? AND used_at IS NULL').get(personId)!.n
}
/** A second factor: at least one passkey, or a confirmed TOTP. Recovery codes alone are not one. */
export function has2FA(db: DB, personId: number): boolean {
  ensureMfaSchema(db)
  return totpEnabled(db, personId) || !!db.query('SELECT 1 FROM mfa_passkeys WHERE person_id = ? LIMIT 1').get(personId)
}

/** True when this person has a second factor (passkey or confirmed TOTP). For the public-listener gate. */
export function adminHas2FA(db: DB, personId: number): boolean { return has2FA(db, personId) }

/** Every active admin has a second factor (and there is at least one active admin). */
export function allAdminsHave2FA(db: DB): boolean { return adminsWithout2FA(db).length === 0 && activeAdmins(db).length > 0 }

const activeAdmins = (db: DB) => db.query<{ id: number }, []>('SELECT id FROM people WHERE admin = 1 AND active = 1').all().map((p) => p.id)
export const adminsWithout2FA = (db: DB) => activeAdmins(db).filter((id) => !has2FA(db, id))

/**
 * The gate for anything that opens this server to the internet (plan 5.2: "공개 주소를 여는 설치는 관리자 2단계 인증 필수").
 * Throws MfaError('admin_2fa_required', 403) naming how many admins lack one (no names).
 */
export function requireAdmin2FA(db: DB): void {
  const missing = adminsWithout2FA(db).length
  if (!activeAdmins(db).length) throw new MfaError('admin_2fa_required', 'there is no active admin', 403)
  if (missing) throw new MfaError('admin_2fa_required', `${missing} admin${missing === 1 ? '' : 's'} without a second factor (passkey or authenticator app); every admin must set one up before the public address opens`, 403)
}

// ---------- TOTP ----------
/** Start (or restart) setting up TOTP; the factor counts only after totpConfirm. Refused while one is confirmed. */
export function totpBegin(db: DB, personId: number, account: string): { secret: string; uri: string } {
  ensureMfaSchema(db)
  if (totpEnabled(db, personId)) throw new MfaError('totp_exists', 'an authenticator app is already set up; remove it first', 409)
  const secret = newTotpSecret()
  db.query('INSERT INTO mfa_totp (person_id, secret, created_at) VALUES (?, ?, ?) ON CONFLICT (person_id) DO UPDATE SET secret = excluded.secret, created_at = excluded.created_at, confirmed_at = NULL, last_step = 0')
    .run(personId, secret, Date.now())
  return { secret, uri: otpauthUri(PRODUCT, account, secret) }
}

/** Check a code against a secret and use its step up (atomically: the same step never passes twice). */
function useStep(db: DB, personId: number, secret: string, code: unknown, now: number): boolean {
  const step = matchTotp(secret, code, now)
  if (step === null) return false
  return db.query('UPDATE mfa_totp SET last_step = ? WHERE person_id = ? AND last_step < ?').run(step, personId, step).changes === 1
}

export function totpConfirm(db: DB, personId: number, code: unknown, now = Date.now()): boolean {
  ensureMfaSchema(db)
  const t = db.query<{ secret: string; confirmed_at: number | null }, [number]>('SELECT secret, confirmed_at FROM mfa_totp WHERE person_id = ?').get(personId)
  if (!t || t.confirmed_at != null) return false
  if (!useStep(db, personId, t.secret, code, now)) return false
  db.query('UPDATE mfa_totp SET confirmed_at = ? WHERE person_id = ?').run(now, personId)
  return true
}

/** A confirmed TOTP code, each 30-second step accepted once (a code seen by someone else cannot be replayed). */
export function totpVerify(db: DB, personId: number, code: unknown, now = Date.now()): boolean {
  ensureMfaSchema(db)
  const t = db.query<{ secret: string }, [number]>('SELECT secret FROM mfa_totp WHERE person_id = ? AND confirmed_at IS NOT NULL').get(personId)
  return !!t && useStep(db, personId, t.secret, code, now)
}

export function totpRemove(db: DB, personId: number): boolean {
  ensureMfaSchema(db)
  return db.query('DELETE FROM mfa_totp WHERE person_id = ?').run(personId).changes > 0
}

/** For tests and the CLI: the current code of a person's secret. */
export const totpSecretOf = (db: DB, personId: number) => { ensureMfaSchema(db); return db.query<{ secret: string }, [number]>('SELECT secret FROM mfa_totp WHERE person_id = ?').get(personId)?.secret ?? null }
export const lastTotpStep = (db: DB, personId: number) => db.query<{ last_step: number }, [number]>('SELECT last_step FROM mfa_totp WHERE person_id = ?').get(personId)?.last_step ?? 0

// ---------- recovery codes ----------
const normCode = (c: string) => c.toLowerCase().replace(/[^a-z0-9]/g, '')

/** New codes (the old ones stop working). Shown once; only their sha256 is kept. */
export function makeRecoveryCodes(db: DB, personId: number): string[] {
  ensureMfaSchema(db)
  const codes = Array.from({ length: RECOVERY_CODES }, () => {
    const s = crypto.randomBytes(8).toString('hex').slice(0, 10)
    return `${s.slice(0, 5)}-${s.slice(5)}`
  })
  const t = Date.now()
  db.transaction(() => {
    db.query('DELETE FROM mfa_recovery WHERE person_id = ?').run(personId)
    for (const c of codes) db.query('INSERT INTO mfa_recovery (person_id, code_hash, created_at) VALUES (?, ?, ?)').run(personId, sha256(normCode(c)), t)
  })()
  return codes
}

/** Use one recovery code up (sign-in only). */
export function useRecoveryCode(db: DB, personId: number, code: unknown): boolean {
  ensureMfaSchema(db)
  if (typeof code !== 'string' || code.length > 40) return false
  const h = sha256(normCode(code))
  return db.query('UPDATE mfa_recovery SET used_at = ? WHERE person_id = ? AND code_hash = ? AND used_at IS NULL').run(Date.now(), personId, h).changes === 1
}

// ---------- WebAuthn challenges ----------
function saveChallenge(db: DB, challenge: string, purpose: 'register' | 'login' | 'stepup', personId: number, bound: string) {
  const t = Date.now()
  db.query('DELETE FROM mfa_challenges WHERE expires_at < ?').run(t - CHALLENGE_TTL_MS)
  db.query('INSERT INTO mfa_challenges (challenge, purpose, person_id, bound, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run(challenge, purpose, personId, bound, t, t + CHALLENGE_TTL_MS)
}

/** The challenge the authenticator signed, if it is ours, live, unused and for exactly this purpose / person / binding; used up here. */
function takeChallenge(db: DB, clientDataJSON: unknown, purpose: string, personId: number, bound: string): string {
  let challenge: string
  try { challenge = JSON.parse(Buffer.from(String(clientDataJSON), 'base64url').toString('utf8')).challenge } catch { throw new MfaError('bad_passkey', 'the passkey response cannot be read') }
  if (typeof challenge !== 'string' || challenge.length > 200) throw new MfaError('bad_passkey', 'the passkey response cannot be read')
  const r = db.query('UPDATE mfa_challenges SET used_at = ? WHERE challenge = ? AND purpose = ? AND person_id = ? AND bound = ? AND used_at IS NULL AND expires_at > ?')
    .run(Date.now(), challenge, purpose, personId, bound, Date.now())
  if (r.changes !== 1) throw new MfaError('bad_challenge', 'this passkey request expired or was already used; try again', 400)
  return challenge
}

// ---------- passkeys: registration ----------
export async function passkeyRegistrationOptions(db: DB, cfg: PasskeyConfig, person: { id: number; name: string }, sessionHash: string) {
  ensureMfaSchema(db)
  const options = await generateRegistrationOptions({
    rpName: cfg.rpName, rpID: cfg.rpId, userName: person.name, userDisplayName: person.name,
    userID: new TextEncoder().encode(`${NAME}:${person.id}`),
    attestationType: 'none',
    excludeCredentials: passkeysOf(db, person.id).map((p) => ({ id: p.credential_id, transports: p.transports ? JSON.parse(p.transports) as AuthenticatorTransportFuture[] : undefined })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    supportedAlgorithmIDs: [-7, -8, -257],
    timeout: CHALLENGE_TTL_MS,
  })
  saveChallenge(db, options.challenge, 'register', person.id, `session:${sessionHash}`)
  return options
}

export async function passkeyRegister(db: DB, cfg: PasskeyConfig, personId: number, sessionHash: string, response: unknown, name: unknown) {
  ensureMfaSchema(db)
  const resp = response as RegistrationResponseJSON
  if (!resp || typeof resp !== 'object' || !resp.response) throw new MfaError('bad_passkey', 'the passkey response cannot be read')
  const challenge = takeChallenge(db, resp.response.clientDataJSON, 'register', personId, `session:${sessionHash}`)
  let v: Awaited<ReturnType<typeof verifyRegistrationResponse>>
  try {
    v = await verifyRegistrationResponse({ response: resp, expectedChallenge: challenge, expectedOrigin: cfg.origin, expectedRPID: cfg.rpId, requireUserVerification: true })
  } catch (e) { throw new MfaError('bad_passkey', `the passkey was not accepted (${(e as Error).message})`) }
  if (!v.verified || !v.registrationInfo) throw new MfaError('bad_passkey', 'the passkey was not accepted')
  const c = v.registrationInfo.credential
  const label = typeof name === 'string' && name.trim() ? name.trim().slice(0, 64) : 'Passkey'
  try {
    db.query('INSERT INTO mfa_passkeys (person_id, credential_id, public_key, counter, transports, rp_id, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(personId, c.id, Buffer.from(c.publicKey), c.counter, c.transports ? JSON.stringify(c.transports) : null, cfg.rpId, label, Date.now())
  } catch (e) {
    if (/UNIQUE/.test(String((e as Error).message))) throw new MfaError('passkey_exists', 'this passkey is already registered', 409)
    throw e
  }
  return { id: c.id, name: label }
}

export function passkeyRemove(db: DB, personId: number, id: number): boolean {
  ensureMfaSchema(db)
  return db.query('DELETE FROM mfa_passkeys WHERE id = ? AND person_id = ?').run(id, personId).changes === 1
}

// ---------- passkeys: assertion (sign-in second factor, approval step-up) ----------
/** Options for proving a passkey of this person, for `purpose`, bound to `bound` (a ticket or an approval). */
export async function passkeyAssertionOptions(db: DB, cfg: PasskeyConfig, personId: number, purpose: 'login' | 'stepup', bound: string) {
  ensureMfaSchema(db)
  const mine = passkeysOf(db, personId).filter((p) => p.rp_id === cfg.rpId)
  if (!mine.length) return null
  const options = await generateAuthenticationOptions({
    rpID: cfg.rpId, userVerification: 'required', timeout: CHALLENGE_TTL_MS,
    allowCredentials: mine.map((p) => ({ id: p.credential_id, transports: p.transports ? JSON.parse(p.transports) as AuthenticatorTransportFuture[] : undefined })),
  })
  saveChallenge(db, options.challenge, purpose, personId, bound)
  return options
}

/** Verify a passkey assertion of this person for `purpose` / `bound` (user verification required). Returns the passkey row id. */
export async function passkeyVerify(db: DB, cfg: PasskeyConfig, personId: number, purpose: 'login' | 'stepup', bound: string, response: unknown): Promise<number> {
  ensureMfaSchema(db)
  const resp = response as AuthenticationResponseJSON
  if (!resp || typeof resp !== 'object' || !resp.response || typeof resp.id !== 'string') throw new MfaError('bad_passkey', 'the passkey response cannot be read')
  const row = db.query<{ id: number; credential_id: string; public_key: Uint8Array; counter: number; transports: string | null; rp_id: string }, [string, number]>(
    'SELECT id, credential_id, public_key, counter, transports, rp_id FROM mfa_passkeys WHERE credential_id = ? AND person_id = ?').get(resp.id, personId)
  // the challenge is spent even when the credential is not this person's (one try per challenge)
  const challenge = takeChallenge(db, resp.response.clientDataJSON, purpose, personId, bound)
  if (!row || row.rp_id !== cfg.rpId) throw new MfaError('bad_passkey', 'that passkey is not registered for you here')
  let v: Awaited<ReturnType<typeof verifyAuthenticationResponse>>
  try {
    v = await verifyAuthenticationResponse({
      response: resp, expectedChallenge: challenge, expectedOrigin: cfg.origin, expectedRPID: cfg.rpId, requireUserVerification: true,
      credential: { id: row.credential_id, publicKey: new Uint8Array(row.public_key), counter: row.counter, transports: row.transports ? JSON.parse(row.transports) : undefined },
    })
  } catch (e) { throw new MfaError('bad_passkey', `the passkey was not accepted (${(e as Error).message})`) }
  if (!v.verified) throw new MfaError('bad_passkey', 'the passkey was not accepted')
  db.query('UPDATE mfa_passkeys SET counter = ?, last_used_at = ? WHERE id = ?').run(v.authenticationInfo.newCounter, Date.now(), row.id)
  return row.id
}

// ---------- sign-in tickets ----------
export function createTicket(db: DB, personId: number): string {
  ensureMfaSchema(db)
  const ticket = random(32), t = Date.now()
  db.query('DELETE FROM mfa_tickets WHERE expires_at < ?').run(t - TICKET_TTL_MS)
  db.query('INSERT INTO mfa_tickets (ticket_hash, person_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(ticket), personId, t, t + TICKET_TTL_MS)
  return ticket
}
/** The person a live ticket is for (not used up). */
export function ticketPerson(db: DB, ticket: unknown): number | null {
  if (typeof ticket !== 'string' || ticket.length > 100) return null
  ensureMfaSchema(db)
  return db.query<{ person_id: number }, [string, number, number]>(
    'SELECT person_id FROM mfa_tickets WHERE ticket_hash = ? AND used_at IS NULL AND expires_at > ? AND failures < ?').get(sha256(ticket), Date.now(), TICKET_MAX_FAILURES)?.person_id ?? null
}
export const ticketBinding = (ticket: string) => `ticket:${sha256(ticket)}`
export function ticketFailed(db: DB, ticket: string) { db.query('UPDATE mfa_tickets SET failures = failures + 1 WHERE ticket_hash = ?').run(sha256(ticket)) }
/** Use the ticket up (exactly once). */
export function consumeTicket(db: DB, ticket: string): boolean {
  return db.query('UPDATE mfa_tickets SET used_at = ? WHERE ticket_hash = ? AND used_at IS NULL AND expires_at > ?').run(Date.now(), sha256(ticket), Date.now()).changes === 1
}

// ---------- approval step-ups ----------
export interface StepUpBinding { sessionHash: string; personId: number; approvalId: number; sha256: string }
export const stepUpChallengeBinding = (b: StepUpBinding) => `approval:${b.approvalId}:${b.sha256}:${b.sessionHash}`

export function issueStepUp(db: DB, b: StepUpBinding, method: 'passkey' | 'totp'): { assertion: string; expires_at: number } {
  ensureMfaSchema(db)
  const assertion = random(32), t = Date.now()
  db.query('DELETE FROM mfa_stepups WHERE expires_at < ?').run(t - 86400_000)
  db.query('INSERT INTO mfa_stepups (assertion_hash, session_hash, person_id, approval_id, sha256, method, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(sha256(assertion), b.sessionHash, b.personId, b.approvalId, b.sha256, method, t, t + STEPUP_TTL_MS)
  return { assertion, expires_at: t + STEPUP_TTL_MS }
}

/** Use a step-up assertion up: it must be live, unused, and minted for exactly this session, person, approval and hash. */
export function consumeStepUp(db: DB, assertion: unknown, b: StepUpBinding): boolean {
  if (typeof assertion !== 'string' || assertion.length > 100) return false
  ensureMfaSchema(db)
  return db.query('UPDATE mfa_stepups SET used_at = ? WHERE assertion_hash = ? AND session_hash = ? AND person_id = ? AND approval_id = ? AND sha256 = ? AND used_at IS NULL AND expires_at > ?')
    .run(Date.now(), sha256(assertion), b.sessionHash, b.personId, b.approvalId, b.sha256, Date.now()).changes === 1
}
