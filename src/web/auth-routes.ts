// /api routes before sign-in, and signing in and out: server state, first setup, password sign-in, the second factor
// after it, sign-out, invite and reset links. Moved here unchanged from api.ts (W0 seams) so the Trina Cloud SSO work
// (workstream B1) changes one module; api.ts puts these first in the route table.
import { appendAudit } from '../audit'
import { CLI, NAME, PRODUCT, VERSION } from '../config'
import { addPerson } from '../store'
import {
  accountByLogin, checkPasswordRules, consumeLink, consumeSetupToken, createSession, hashPassword,
  peekLink, revokeSession, SESSION_COOKIE, SESSION_MAX_MS, setPassword, setupDone, setupPending, verifyPassword, type WebSession,
} from './auth'
import * as approve from './approve'
import { consumeTicket, createTicket, has2FA, ticketFailed, ticketPerson } from './mfa'
import { ApiError, bad, json, rateLimited, type WebCtx } from './http'
import { everyoneGroup } from '../share/rules'
import { R, type Route } from './route'
import * as views from './views'

const isHttps = (req: Request) => new URL(req.url).protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https'
export function sessionCookie(req: Request, value: string, maxAgeS: number) {
  return `${SESSION_COOKIE}=${value}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}${isHttps(req) ? '; Secure' : ''}`
}

/** A new session for this person (and its cookie); the one the request came with, if any, is revoked (no fixation). */
export function startSession(w: WebCtx, req: Request, personId: number, previous?: WebSession | null) {
  if (previous) revokeSession(w.db, previous.idHash) // a new id on every sign-in (no fixation)
  const s = createSession(w.db, personId, req.headers.get('user-agent') ?? undefined)
  return { csrf: s.csrf, cookie: sessionCookie(req, s.cookie, SESSION_MAX_MS / 1000) }
}

export const authRoutes: Route[] = [
  // ---------- before sign-in ----------
  R('GET', '/state', false, ({ w }) => ({ name: NAME, product: PRODUCT, cli: CLI, version: VERSION, setup_pending: setupPending(w.db), setup_done: setupDone(w.db) })),
  R('POST', '/setup', false, async ({ w, req, body: b, s, addr }) => {
    if (!w.linkByAddr.hit(`setup:${addr}`)) throw rateLimited(w.linkByAddr.retryAfter(`setup:${addr}`))
    const pw = checkPasswordRules(b.password)
    const hash = await hashPassword(pw)
    const name = typeof b.name === 'string' ? b.name.trim().normalize('NFC') : ''
    const email = typeof b.email === 'string' ? b.email.trim() : ''
    if (!/^[^\s/\\@#][^/\\\p{Cc}]{0,63}$/u.test(name) || !/^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw bad('bad_input', 'a name and a valid mail address are required')
    if (!consumeSetupToken(w.db, b.setup_token)) throw new ApiError(403, 'bad_setup_token', 'that setup token is not valid (it is used once and printed by init)')
    let personId = 0
    w.db.transaction(() => {
      const p = w.db.query<{ id: number; admin: number }, [string]>('SELECT id, admin FROM people WHERE name = ?').get(name)
      if (p && !p.admin) throw new ApiError(409, 'not_admin', 'a person with that name exists and is not an admin')
      personId = p?.id ?? addPerson(w.db, name, true).id
      w.db.query('INSERT INTO accounts (person_id, email, password_hash, created_at, password_set_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (person_id) DO UPDATE SET email = excluded.email, password_hash = excluded.password_hash, password_set_at = excluded.password_set_at')
        .run(personId, email, hash, Date.now(), Date.now())
      appendAudit(w.db, { personId, tokenId: null, tool: 'web', command: `setup: first admin ${name}`, files: [], outcome: 'ok' })
    })()
    const everyone = everyoneGroup(w)
    w.db.query('INSERT OR IGNORE INTO memberships (group_id, person_id) VALUES (?, ?)').run(everyone, personId)
    const ss = startSession(w, req, personId, s)
    return json({ me: views.me(w, { personId, admin: true }), csrf: ss.csrf }, 200, { 'set-cookie': ss.cookie })
  }),
  R('POST', '/login', false, async ({ w, req, body: b, s, addr }) => {
    const login = typeof b.login === 'string' ? b.login.trim().toLowerCase().slice(0, 254) : ''
    const pw = typeof b.password === 'string' ? b.password : ''
    if (!login || !pw) throw bad('bad_input', 'name or mail address, and password')
    if (w.loginByName.blocked(login)) throw rateLimited(w.loginByName.retryAfter(login))
    if (!w.loginByAddr.hit(addr)) throw rateLimited(w.loginByAddr.retryAfter(addr))
    const acc = accountByLogin(w.db, login)
    const ok = await verifyPassword(pw, acc?.password_hash)
    if (!ok || !acc || !acc.active) {
      w.loginByName.hit(login)
      throw new ApiError(401, 'bad_login', 'wrong name or password')
    }
    w.loginByName.reset(login)
    // a second factor when the person has one: a 5-minute ticket now, the session after the factor (POST /login/second)
    if (has2FA(w.db, acc.person_id)) return { second_factor: await approve.secondFactorChallenge(w, createTicket(w.db, acc.person_id), acc.person_id) }
    const ss = startSession(w, req, acc.person_id, s)
    return json({ me: views.me(w, { personId: acc.person_id, admin: !!acc.admin }), csrf: ss.csrf }, 200, { 'set-cookie': ss.cookie })
  }),
  R('POST', '/login/second', false, async ({ w, req, body: b, s, addr }) => {
    if (!w.loginByAddr.hit(addr)) throw rateLimited(w.loginByAddr.retryAfter(addr))
    const ticket = typeof b.ticket === 'string' ? b.ticket : ''
    const pid = ticketPerson(w.db, ticket)
    if (pid == null) throw new ApiError(401, 'bad_ticket', 'sign in again')
    const key = `mfa:${pid}`
    if (w.loginByName.blocked(key)) throw rateLimited(w.loginByName.retryAfter(key))
    let method: string
    try { method = await approve.checkSecondFactor(w, ticket, pid, b) } catch (e) {
      ticketFailed(w.db, ticket)
      w.loginByName.hit(key)
      throw e
    }
    const p = w.db.query<{ admin: number; active: number }, [number]>('SELECT admin, active FROM people WHERE id = ?').get(pid)
    if (!p?.active || !consumeTicket(w.db, ticket)) throw new ApiError(401, 'bad_ticket', 'sign in again')
    w.loginByName.reset(key)
    if (method === 'recovery') appendAudit(w.db, { personId: pid, tokenId: null, tool: 'web', command: 'signed in with a recovery code', files: [], outcome: 'ok' })
    const ss = startSession(w, req, pid, s)
    return json({ me: views.me(w, { personId: pid, admin: !!p.admin }), csrf: ss.csrf }, 200, { 'set-cookie': ss.cookie })
  }),
  R('POST', '/logout', true, ({ w, req, s }) => {
    revokeSession(w.db, s!.idHash)
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie(req, '', 0) })
  }),
  R('POST', '/links/check', false, ({ w, body: b, addr }) => {
    if (!w.linkByAddr.hit(`link:${addr}`)) throw rateLimited(w.linkByAddr.retryAfter(`link:${addr}`))
    const kind = b.kind === 'reset' ? 'reset' : 'invite'
    const pid = peekLink(w.db, kind, b.token)
    if (pid == null) throw new ApiError(404, 'bad_link', 'this link is used, expired or wrong')
    return { name: w.db.query<{ name: string }, [number]>('SELECT name FROM people WHERE id = ?').get(pid)?.name }
  }),
  R('POST', '/links/accept', false, async ({ w, req, body: b, s, addr }) => {
    if (!w.linkByAddr.hit(`link:${addr}`)) throw rateLimited(w.linkByAddr.retryAfter(`link:${addr}`))
    const kind = b.kind === 'reset' ? 'reset' : 'invite'
    const pw = checkPasswordRules(b.password)
    const pid = consumeLink(w.db, kind, b.token)
    if (pid == null) throw new ApiError(404, 'bad_link', 'this link is used, expired or wrong')
    await setPassword(w.db, pid, pw)
    appendAudit(w.db, { personId: pid, tokenId: null, tool: 'web', command: kind === 'invite' ? 'invite accepted' : 'password reset completed', files: [], outcome: 'ok' })
    const p = w.db.query<{ admin: number; active: number }, [number]>('SELECT admin, active FROM people WHERE id = ?').get(pid)!
    if (!p.active) return { ok: true }
    // a reset link does not skip the second factor (R9: a reset mail must not be a way around it)
    if (has2FA(w.db, pid)) return { second_factor: await approve.secondFactorChallenge(w, createTicket(w.db, pid), pid) }
    const ss = startSession(w, req, pid, s)
    return json({ me: views.me(w, { personId: pid, admin: !!p.admin }), csrf: ss.csrf }, 200, { 'set-cookie': ss.cookie })
  }),
]
