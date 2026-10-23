// Sign-in with Trina Cloud (docs/SSO-CONTRACT.md "Sign-in flow"): GET /api/sso/start sends the browser to the console
// with a fresh state; the console form_posts a signed one-time assertion to POST /api/sso/callback, which checks it
// (assertion.ts), finds or makes the person (rules: member_sync.sso_rule), and starts a new session — or, for someone
// with a second factor on this drive, hands over to /#/sso-second/<ticket> first. `reauth=1` asks the console for the
// password again (max_age=0): the new session then counts as a fresh login (2FA changes, app passwords, provenance
// reset), which is how a person without a drive password re-authenticates (review finding 4).
import { applyShareInvites } from '../share/invites'
import { tellWidened, withRejudge, type Judgement } from '../share/rejudge'
import crypto from 'node:crypto'
import { appendAudit } from '../audit'
import type { DB } from '../db'
import { checkPeopleRoom, PeopleLimitError, sha256 } from '../store'
import { lookupSession, markReauth, SESSION_COOKIE } from '../web/auth'
import { isHttps, startSession } from '../web/auth-routes'
import { ApiError, notFound, rateLimited, type WebCtx } from '../web/http'
import { createTicket, has2FA, ticketPerson } from '../web/mfa'
import { notify } from '../web/notices'
import * as approve from '../web/approve'
import { ensureWebSchema, metaGet } from '../web/schema'
import { stateHash, verifyAssertion, type Claims } from './assertion'
import { cloudConfig, type CloudConfig } from './config'
import { afterReconcile, reconcileMyFiles } from './my-files'
import { announceNewAdmins, byCloudUser, closeSetupIfCloudAdmin, createCloudPerson, inviteOnly, syncEveryone, unboundByEmail } from './people'

export const STATE_TTL_MS = 10 * 60_000
export const REAUTH_WINDOW_S = 120
const CALLBACK_MAX_BYTES = 16 * 1024
export const DEFAULT_RETURN = '/#/files'

/** `__Host-tdrive_sso` on https (no other subdomain can set or overwrite it); `tdrive_sso` on plain-http development. */
export const stateCookieName = (req: Request) => isHttps(req) ? '__Host-tdrive_sso' : 'tdrive_sso'
const stateCookie = (req: Request, value: string, maxAgeS: number) =>
  `${stateCookieName(req)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${isHttps(req) ? '; Secure' : ''}`

/** Only a path on this server: "/…", not "//…", no backslash or control characters (no open redirect). */
export function safeReturn(v: unknown): string {
  if (typeof v !== 'string' || !v || v.length > 1024 || !v.startsWith('/') || v.startsWith('//') || /[\\\p{Cc}]/u.test(v)) return DEFAULT_RETURN
  return v
}

/** One cookie's value (api.ts has the same; not imported from there: api.ts imports this module's routes). */
export function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return undefined
}

const cloudOr404 = (w: WebCtx): CloudConfig => {
  const c = cloudConfig(w.db)
  if (!c) throw notFound()
  return c
}

/** Keep a new state (tests call this to stand in for GET /api/sso/start). */
export function rememberState(db: DB, state: string, returnTo: string, reauth: boolean, at = Date.now()) {
  ensureWebSchema(db)
  db.query('DELETE FROM sso_states WHERE created_at < ?').run(at - STATE_TTL_MS)
  db.query('INSERT OR REPLACE INTO sso_states (state_hash, return_to, reauth, created_at) VALUES (?, ?, ?, ?)').run(stateHash(state), returnTo, reauth ? 1 : 0, at)
}

// ---------- GET /api/sso/start ----------
export function start(w: WebCtx, req: Request, url: URL, addr: string): Response {
  const cfg = cloudOr404(w)
  if (!w.ssoByAddr.hit(addr)) throw rateLimited(w.ssoByAddr.retryAfter(addr))
  const reauth = url.searchParams.get('reauth') === '1'
  const state = crypto.randomBytes(32).toString('base64url')
  rememberState(w.db, state, safeReturn(url.searchParams.get('return')), reauth, cfg.now())
  const to = `${cfg.issuer}/sso/authorize?team=${encodeURIComponent(cfg.team)}&state=${state}${reauth ? '&max_age=0' : ''}`
  return new Response(null, { status: 303, headers: { location: to, 'set-cookie': stateCookie(req, state, STATE_TTL_MS / 1000), 'cache-control': 'no-store' } })
}

// ---------- POST /api/sso/callback ----------
export class SsoFail extends Error { constructor(readonly code: string) { super(code) } }

export interface SignedIn { personId: number; admin: boolean; created: boolean; reactivated: boolean; newAdmin: boolean }

/**
 * The person an accepted assertion is for (member_sync.sso_rule, in the caller's transaction). `applied` =
 * meta.cloud_sync_seq; an assertion is newer when its sync_seq is greater — only a newer one may reactivate someone or
 * change their admin flag, so a pass signed just before a removal cannot undo it.
 */
export function personFor(db: DB, c: Claims): SignedIn {
  const applied = Number(metaGet(db, 'cloud_sync_seq') ?? 0)
  const newer = c.sync_seq > applied
  const roleAdmin = c.role === 'owner' || c.role === 'admin'
  const found = byCloudUser(db, c.sub) ?? unboundByEmail(db, c.email)
  if (!found) {
    // JIT: the console vouches for membership now; the admin flag only from a pass newer than the last sync
    const id = createCloudPerson(db, { email: c.email, displayName: c.name, admin: newer && roleAdmin, cloudUser: c.sub, invite: null })
    return { personId: id, admin: newer && roleAdmin, created: true, reactivated: false, newAdmin: newer && roleAdmin }
  }
  let reactivated = false
  if (found.active && inviteOnly(found)) checkPeopleRoom(db) // an invite becomes a member: one more person on the plan
  if (!found.active) {
    if (!newer) throw new SsoFail('deactivated')
    checkPeopleRoom(db)
    db.query('UPDATE people SET active = 1 WHERE id = ?').run(found.id)
    reactivated = true
  }
  if (found.cloud_user == null) db.query('UPDATE accounts SET cloud_user = ?, cloud_invite = NULL WHERE person_id = ?').run(c.sub, found.id)
  db.query('UPDATE people SET display_name = ? WHERE id = ?').run(c.name || null, found.id)
  if (found.email && found.email.toLowerCase() !== c.email.toLowerCase() && !db.query('SELECT 1 FROM accounts WHERE email = ? COLLATE NOCASE').get(c.email))
    db.query('UPDATE accounts SET email = ? WHERE person_id = ?').run(c.email, found.id)
  let admin = !!found.admin, newAdmin = false
  if (newer && admin !== roleAdmin) {
    db.query('UPDATE people SET admin = ? WHERE id = ?').run(roleAdmin ? 1 : 0, found.id)
    newAdmin = roleAdmin
    admin = roleAdmin
  }
  return { personId: found.id, admin, created: false, reactivated, newAdmin }
}

const failTo = (req: Request, code: string, extra: Record<string, string> = {}) => {
  const h = new Headers({ location: `/#/sso-error/${encodeURIComponent(code)}`, 'cache-control': 'no-store', ...extra })
  h.append('set-cookie', stateCookie(req, '', 0))
  return new Response(null, { status: 303, headers: h })
}

export async function callback(w: WebCtx, req: Request, addr: string, base: string): Promise<Response> {
  const cfg = cloudOr404(w)
  const db = w.db
  ensureWebSchema(db)
  // refusals count against the address (bad, replayed or expired assertions); a good sign-in does not: an office of
  // 20 behind one address opens the drive all morning, and an assertion is signed by the console, not guessed
  if (w.loginByAddr.blocked(addr)) return failTo(req, 'rate_limited')
  const refuse = (code: string) => { w.loginByAddr.hit(addr); return failTo(req, code) }
  if (!(req.headers.get('content-type') ?? '').includes('application/x-www-form-urlencoded') || Number(req.headers.get('content-length') ?? 0) > CALLBACK_MAX_BYTES) return refuse('malformed')
  const text = await req.text()
  if (text.length > CALLBACK_MAX_BYTES) return refuse('malformed')
  const form = new URLSearchParams(text)
  const state = form.get('state'), cookieState = readCookie(req, stateCookieName(req)) ?? null
  const nowMs = cfg.now(), nowS = Math.floor(nowMs / 1000)
  db.query('DELETE FROM sso_used WHERE expires_at < ?').run(nowS)
  const v = verifyAssertion(cfg, { assertion: form.get('assertion'), state, cookieState, now: nowS, seen: (jti) => !!db.query('SELECT 1 FROM sso_used WHERE jti = ?').get(jti) })
  if (!v.ok) {
    appendAudit(db, { personId: null, tokenId: null, tool: 'cloud', command: `sso sign-in refused: ${v.error}`, files: [], outcome: 'denied' })
    return refuse(v.error)
  }
  const c = v.claims
  let who!: SignedIn, stored!: { return_to: string; reauth: number }
  let widened: Judgement | null = null
  let shared = 0
  try {
    // a new or reactivated person joins Everyone here: the R6 re-check runs in the same transaction (src/share/rejudge.ts)
    widened = withRejudge(db, () => {
      // single use, even with two posts at the same moment
      if (db.query('INSERT OR IGNORE INTO sso_used (jti, expires_at) VALUES (?, ?)').run(c.jti, c.exp + 60).changes !== 1) throw new SsoFail('replayed')
      const s = db.query<{ return_to: string; reauth: number }, [string, number]>('DELETE FROM sso_states WHERE state_hash = ? AND created_at >= ? RETURNING return_to, reauth').get(stateHash(state!), nowMs - STATE_TTL_MS)
      if (!s) throw new SsoFail('bad_state')
      stored = s
      who = personFor(db, c)
      // S16: shares given by mail before this address was a member arrive with it (same transaction and re-check)
      shared = applyShareInvites(db, who.personId, c.email, nowMs)
      syncEveryone(db)
      closeSetupIfCloudAdmin(db)
      const name = db.query<{ name: string }, [number]>('SELECT name FROM people WHERE id = ?').get(who.personId)!.name
      appendAudit(db, { personId: who.personId, tokenId: null, tool: 'web', command: `signed in with Trina Cloud (${c.amr.join('+')}${who.created ? ', new person' : ''}${who.reactivated ? ', reactivated' : ''}${stored.reauth ? ', re-authentication' : ''})`, files: [], outcome: 'ok' })
      // review finding 3: an owner/admin whose console sign-in had no TOTP is worth a look
      if ((c.role === 'owner' || c.role === 'admin') && !c.amr.includes('totp'))
        appendAudit(db, { personId: who.personId, tokenId: null, tool: 'cloud', command: `warning: ${c.role} ${name} signed in without a console TOTP (amr ${c.amr.join('+')})`, files: [], outcome: 'warning' })
    }, { mode: 'membership' }).judgement
  } catch (e) {
    const code = e instanceof SsoFail ? e.code : e instanceof PeopleLimitError ? 'people_limit' : null
    if (!code) throw e
    appendAudit(db, { personId: null, tokenId: null, tool: 'cloud', command: `sso sign-in refused: ${code}`, files: [], outcome: 'denied' })
    return refuse(code)
  }
  if (who.newAdmin) await announceNewAdmins({ db, mailer: w.mailer, baseUrl: base }, [who.personId], 'Trina Cloud sign-in')
  if (widened) await tellWidened({ db, mailer: w.mailer, baseUrl: base }, widened)
  if (shared) await notify({ db, mailer: w.mailer, baseUrl: base }, [who.personId], 'shared', '/#/shared', { count: shared })
  // My files (B2): made on the first sign-in, back from Former members on a return; never blocks signing in
  try { await afterReconcile({ db, mailer: w.mailer, baseUrl: base }, reconcileMyFiles(db, w.dataDir, { only: who.personId })) }
  catch (e) { console.error(`[tdcloud] my files at sign-in: ${(e as Error).message}`) }
  const returnTo = safeReturn(stored.return_to)
  const authAt = c.auth_time * 1000
  const fresh = !!stored.reauth && nowS - c.auth_time <= REAUTH_WINDOW_S
  // the session the browser came with ends here (session fixation), whoever it was
  const previous = lookupSession(db, readCookie(req, SESSION_COOKIE))
  const h = new Headers({ 'cache-control': 'no-store' })
  h.append('set-cookie', stateCookie(req, '', 0))
  if (has2FA(db, who.personId)) {
    // the drive's own second factor still applies: a ticket, then POST /api/login/second (auth-routes.ts) finishes
    const ticket = createTicket(db, who.personId)
    db.query('DELETE FROM sso_tickets WHERE created_at < ?').run(nowMs - STATE_TTL_MS)
    db.query('INSERT INTO sso_tickets (ticket_hash, return_to, fresh_at, auth_at, created_at) VALUES (?, ?, ?, ?, ?)').run(sha256(ticket), returnTo, fresh ? nowMs : null, authAt, nowMs)
    h.set('location', `/#/sso-second/${ticket}`)
    return new Response(null, { status: 303, headers: h })
  }
  const ss = startSession(w, req, who.personId, previous, authAt)
  if (fresh) markReauth(db, ss.idHash)
  h.append('set-cookie', ss.cookie)
  h.set('location', returnTo)
  return new Response(null, { status: 303, headers: h })
}

// ---------- the drive's second factor after an SSO pass ----------
/** POST /api/sso/second {ticket}: what the person proves next (passkey options, TOTP, recovery code). */
export async function secondChallenge(w: WebCtx, body: { ticket?: unknown }, addr: string) {
  // like the callback: only a wrong ticket counts against the address
  if (w.loginByAddr.blocked(addr)) throw rateLimited(w.loginByAddr.retryAfter(addr))
  const ticket = typeof body.ticket === 'string' ? body.ticket : ''
  const pid = ticketPerson(w.db, ticket)
  ensureWebSchema(w.db)
  if (pid == null || !w.db.query('SELECT 1 FROM sso_tickets WHERE ticket_hash = ?').get(sha256(ticket))) { w.loginByAddr.hit(addr); throw new ApiError(401, 'bad_ticket', 'sign in again') }
  return { second_factor: await approve.secondFactorChallenge(w, ticket, pid) }
}

/** After POST /api/login/second used an SSO ticket: where to go, and how fresh the session is (null: not an SSO ticket). */
export function takeSsoTicket(db: DB, ticket: string): { returnTo: string; freshAt: number | null; authAt: number | null } | null {
  ensureWebSchema(db)
  const r = db.query<{ return_to: string; fresh_at: number | null; auth_at: number | null }, [string]>('DELETE FROM sso_tickets WHERE ticket_hash = ? RETURNING return_to, fresh_at, auth_at').get(sha256(ticket))
  return r ? { returnTo: safeReturn(r.return_to), freshAt: r.fresh_at, authAt: r.auth_at } : null
}
