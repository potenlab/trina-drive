// Shared rules of the console's routes:
//   teamFor()     "not yours = not found": a team the signed-in account is not an active member of (or a role below
//                 what the action needs) answers exactly like a team that does not exist (404)
//   needTotp()    finding 3: owners and admins must have two-step verification before changing members or settings
//                 ('enrolled'); inviting an admin, changing a role, removing, transferring and deleting need a code
//                 from the last 5 minutes ('fresh': the session's last code, or the `totp` field of this request)
//   safeNext()    a relative path only (no open redirect: not //host, not /\host, no scheme)
//   act()         a form post: on success 303 back with ?ok=<code>; on a CloudError the page is drawn again with the
//                 message (no text from the URL is ever shown)
import { CloudError, type ConsoleSession } from '../cloud'
import { teamByPublicId, teamBySlug, type TeamRow } from '../db'
import type { Role } from '../sso'
import { atLeast } from '../team-members'
import { STEP_UP_MS } from '../totp'
import { findRoute } from './index'
import type { RouteCtx } from './types'

export type Flash = { kind: 'ok' | 'err' | 'warn'; text: string }

/** success messages by code (?ok=…) */
export const OK: Record<string, string> = {
  invited: 'Invite sent.', resent: 'Invite sent again.', revoked: 'Invite revoked.', role: 'Role changed.', removed: 'Removed. Their access to the drive ends as soon as the drive applies it.',
  left: 'You left the team.', renamed: 'Team renamed.', transferred: 'Ownership transferred.', delete_requested: 'The team is paused and will be deleted after a final backup.',
  joined: 'Welcome! You joined the team.', woken: 'Waking up — usually a few seconds.', totp_on: 'Two-step verification is on.', totp_off: 'Two-step verification is off.',
  name: 'Name saved.', password: 'Password changed. Your other sessions were signed out.', sessions: 'Signed out of the other sessions.', session: 'Session signed out.',
  synced: 'Sync queued.', created: 'Your team is starting.', waitlisted: 'You are on the waitlist for Free.', verified: 'Email confirmed. Sign in to continue.',
}

const flashes = new WeakMap<Request, Flash>()
export function flashOf(c: RouteCtx): Flash | null {
  const f = flashes.get(c.req)
  if (f) return f
  const ok = c.url.searchParams.get('ok')
  return ok && OK[ok] ? { kind: 'ok', text: OK[ok]! } : null
}

export function safeNext(v: unknown, dflt = '/'): string {
  if (typeof v !== 'string' || !v.startsWith('/') || v.startsWith('//') || v.startsWith('/\\') || v.length > 2000 || /[\r\n\t]/.test(v)) return dflt
  try { const u = new URL(v, 'https://x.invalid'); return u.host === 'x.invalid' ? u.pathname + u.search : dflt } catch { return dflt }
}

/** The team in the path (slug) or in an API id (team_…), for an active member with at least `need`; else 404. */
export function teamFor(c: RouteCtx, ref: string, need: Role = 'member'): { t: TeamRow; role: Role; s: ConsoleSession } {
  const s = c.signedIn()
  const t = /^team_[0-9a-f]{20}$/.test(ref) ? teamByPublicId(c.cloud.db, ref) : /^[a-z0-9-]{1,40}$/.test(ref) ? teamBySlug(c.cloud.db, ref) : null
  const role = t && t.status !== 'deleted' ? c.cloud.members.role(t.id, s.userId) : null
  if (!t || !role || !atLeast(role, need)) throw new CloudError('not_found', 'not found', 404)
  return { t, role, s }
}

export const stepUpFresh = (s: ConsoleSession) => s.totpAt != null && Date.now() - s.totpAt < STEP_UP_MS

/** finding 3. 'enrolled': the account has an authenticator; 'fresh': and a code from the last 5 minutes (this request's
 * `totp` field counts, and is remembered in the session for the next 5 minutes). */
export async function needTotp(c: RouteCtx, s: ConsoleSession, body: Record<string, unknown>, mode: 'enrolled' | 'fresh') {
  if (!c.cloud.mfa.enabled(s.userId)) throw new CloudError('totp_setup_required', 'set up two-step verification first (Account & security): owners and admins need it to change members and settings', 403)
  if (mode === 'enrolled' || stepUpFresh(s)) return
  const code = typeof body.totp === 'string' ? body.totp.trim() : ''
  if (!code) throw new CloudError('step_up_required', 'enter a code from your authenticator app to confirm', 403)
  if (!(await c.cloud.mfa.verify(s.userId, code))) throw new CloudError('bad_code', 'that code is not right; try the next one', 403)
  const t = Date.now()
  c.cloud.db.query('UPDATE sessions SET totp_at = ? WHERE id_hash = ?').run(t, s.idHash)
  s.totpAt = t
}

/** A form post from a console page: CSRF, then `fn`; success → 303 `back?ok=code`, failure → `back` drawn again with
 * the error (status of the error). */
export async function act(c: RouteCtx, back: string, fn: (body: Record<string, string>, s: ConsoleSession) => Promise<string | void> | string | void): Promise<Response> {
  const s = c.signedIn()
  const body = await c.form()
  c.csrfOk(body)
  try {
    const ok = await fn(body, s)
    const to = typeof ok === 'string' && ok.startsWith('/') ? ok : `${back}${back.includes('?') ? '&' : '?'}ok=${ok ?? 'saved'}`
    return c.redirect(to)
  } catch (e) {
    return rerender(c, back, e)
  }
}

/** The page at `back` drawn again with this error (a CloudError that is not a 404; anything else is thrown on). */
export async function rerender(c: RouteCtx, back: string, e: unknown): Promise<Response> {
  if (!(e instanceof CloudError) || e.status === 404) throw e
  const path = back.split('?')[0]!
  const r = findRoute('GET', path)
  if (!r) throw e
  flashes.set(c.req, { kind: 'err', text: e.message })
  const res = await r.route.fn({ ...c, match: r.match })
  return new Response(res.body, { status: e.status, headers: res.headers })
}

/** JSON body for the API (CSRF checked). */
export async function apiBody(c: RouteCtx): Promise<{ s: ConsoleSession; body: Record<string, string> }> {
  const s = c.signedIn()
  const body = await c.form()
  c.csrfOk(body)
  return { s, body }
}
