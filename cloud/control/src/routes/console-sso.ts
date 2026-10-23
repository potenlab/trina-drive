// "Open drive" and the console side of the SSO contract (docs/SSO-CONTRACT.md "Sign-in flow"):
//   GET  /open/<slug>       a member → 303 to the drive's /api/sso/start (the drive makes the state, then comes back)
//   GET  /sso/authorize     ?team=<public_id>&state=<s>[&max_age=0]: no session → /login?next=…; not an active member
//                           (or no such team) → the same 404; an owner/admin without two-step verification → set it up
//                           first (finding 3); max_age=0 (the drive's reauth) or an older sign-in → the password (and
//                           code) again; then a page that auto-POSTs (form_post) the assertion and the state to
//                           https://<slug>.<domain>/api/sso/callback — the callback URL comes from the team record,
//                           never from the query. Its CSP allows form-action to the team hosts only (review #9).
//   POST /sso/authorize     the re-authentication form of the above
//   POST /api/team-callback/invites   the drive's share dialog invites a member (Bearer = the team's callback token)
import { audit } from '../audit'
import { CloudError, type ConsoleSession, type SessionAmr } from '../cloud'
import { teamByPublicId, teamBySlug, type TeamRow } from '../db'
import { verifyPassword } from '../keys'
import { atLeast, userPublicId } from '../team-members'
import type { Role } from '../sso'
import { csrfField } from '../ui/components'
import { esc, page } from '../ui/layout'
import { ssoPostCsp } from './console-http'
import type { ControlRoute, RouteCtx } from './types'

const STATE_RE = /^[A-Za-z0-9_-]{16,128}$/

const notFound = () => page('Not found', `<h1>Not found</h1><p>There is no team here, or you are not a member of it. Ask an admin of the team to invite you.</p><p class="alt"><a href="/">Your teams</a></p>`, { status: 404 })

const toLogin = (c: RouteCtx) => c.redirect(`/login?next=${encodeURIComponent(c.url.pathname + c.url.search)}`)

/** The member's role in a team that may be opened, or a response to show instead. */
function gate(c: RouteCtx, s: ConsoleSession, t: TeamRow | null): { role: Role } | Response {
  const role = t && t.status !== 'deleted' ? c.cloud.members.role(t.id, s.userId) : null
  if (!t || !role) return notFound()
  // finding 3: an owner or admin opens the drive (as its admin) only with two-step verification
  if (atLeast(role, 'admin') && !c.cloud.mfa.enabled(s.userId)) return c.redirect(`/account?required=1&next=${encodeURIComponent(c.url.pathname + c.url.search)}#two-step`)
  if (c.cloud.free.isPaused(t)) return c.redirect(`/wake/${t.slug}`)
  if (!['active', 'past_due'].includes(t.status)) {
    const why = t.status === 'provisioning' ? 'It is starting — usually a minute or two.' : t.status === 'pending_payment' ? 'It is waiting for payment.' : 'It is not running right now.'
    return page('Not running', `<h1>${esc(t.name)} is not running</h1><p>${esc(why)}</p><p class="alt"><a href="/t/${esc(t.slug)}">Back to the team</a></p>`, { status: 409 })
  }
  return { role }
}

function reauthPage(c: RouteCtx, s: ConsoleSession, t: TeamRow, q: { team: string; state: string; max_age: string }, err?: string, status?: number) {
  const totp = c.cloud.mfa.enabled(s.userId)
  return page('Confirm it is you', `<h1>Confirm it's you</h1><p>${esc(t.name)}'s drive asks you to sign in again before a sensitive change.</p>${err ? `<div class="flash flash-err" role="alert">${esc(err)}</div>` : ''}
<form method="post" action="/sso/authorize">${csrfField(s.csrf)}<input type="hidden" name="team" value="${esc(q.team)}"><input type="hidden" name="state" value="${esc(q.state)}"><input type="hidden" name="max_age" value="${esc(q.max_age)}">
<label>Email<input value="${esc(s.email)}" readonly></label><label>Password<input type="password" name="password" required autocomplete="current-password" autofocus></label>
${totp ? '<label>Authenticator code<input class="code" name="code" inputmode="numeric" autocomplete="one-time-code" required maxlength="12"></label>' : ''}<button class="btn-primary">Continue</button></form>
<form method="post" action="/login/link"><input type="hidden" name="email" value="${esc(s.email)}"><input type="hidden" name="next" value="${esc(`/sso/authorize?${new URLSearchParams(q)}`)}"><p class="alt">No password? <button class="link-btn">Email me a sign-in link</button></p></form>`, { status })
}

/** Sign and hand the assertion to the drive (form_post). */
async function handOff(c: RouteCtx, s: ConsoleSession, t: TeamRow, role: Role, state: string) {
  const db = c.cloud.db
  const user = db.query<{ email: string; name: string | null; verified_at: number | null }, [number]>('SELECT email, name, verified_at FROM users WHERE id = ?').get(s.userId)!
  if (!user.verified_at) throw new CloudError('unverified', 'confirm your email address first (check your inbox)', 403)
  const fresh = db.query<{ sync_seq: number }, [number]>('SELECT sync_seq FROM teams WHERE id = ?').get(t.id)!
  const assertion = await c.cloud.sso.issue({
    team: t, sub: s.publicId ?? userPublicId(c.cloud, s.userId), email: user.email, name: user.name ?? '', role, state,
    amr: s.amr as SessionAmr, authTime: s.authTime, syncSeq: fresh.sync_seq, actor: `user:${s.userId}`,
  })
  const url = c.cloud.url(t)
  return page('Opening your drive', `<h1>Opening ${esc(t.name)}…</h1><p>Signing you in to ${esc(url.replace(/^https:\/\//, ''))}.</p>
<form method="post" action="${esc(`${url}/api/sso/callback`)}" data-autosubmit><input type="hidden" name="assertion" value="${esc(assertion)}"><input type="hidden" name="state" value="${esc(state)}">
<noscript><p>JavaScript is off: press the button.</p></noscript><button class="btn-primary">Continue to the drive</button></form>`, { headers: { 'content-security-policy': ssoPostCsp(url), 'referrer-policy': 'no-referrer' } })
}

function query(c: RouteCtx) {
  return { team: c.url.searchParams.get('team') ?? '', state: c.url.searchParams.get('state') ?? '', max_age: c.url.searchParams.get('max_age') ?? '' }
}

const needsReauth = (s: ConsoleSession, maxAge: string) => {
  if (maxAge === '') return false
  const n = Number(maxAge)
  if (!Number.isInteger(n) || n < 0) return true
  return Date.now() - s.authTime > n * 1000
}

export const ssoRoutes: ControlRoute[] = [
  { method: 'GET', path: /^\/open\/([a-z0-9-]{1,40})$/, fn(c) {
    const s = c.session
    if (!s) return toLogin(c)
    const t = teamBySlug(c.cloud.db, c.match[1]!)
    const g = gate(c, s, t)
    if (g instanceof Response) return g
    // without SSO (TDCLOUD_SSO=0: an older product image) the drive has its own sign-in
    if (!c.cfg.sso) return c.redirect(`${c.cloud.url(t!)}/`)
    return c.redirect(`${c.cloud.url(t!)}/api/sso/start?return=${encodeURIComponent('/')}`)
  } },
  { method: 'GET', path: '/sso/authorize', async fn(c) {
    const s = c.session
    if (!s) return toLogin(c)
    const q = query(c)
    const t = /^team_[0-9a-f]{20}$/.test(q.team) ? teamByPublicId(c.cloud.db, q.team) : null
    const g = gate(c, s, t)
    if (g instanceof Response) return g
    if (!STATE_RE.test(q.state)) throw new CloudError('bad_state', 'this sign-in link is broken: open the drive again', 400)
    if (needsReauth(s, q.max_age)) return reauthPage(c, s, t!, q)
    return handOff(c, s, t!, g.role, q.state)
  } },
  { method: 'POST', path: '/sso/authorize', async fn(c) {
    const s = c.signedIn()
    const b = await c.form()
    c.csrfOk(b)
    const q = { team: String(b.team ?? ''), state: String(b.state ?? ''), max_age: String(b.max_age ?? '') }
    const t = /^team_[0-9a-f]{20}$/.test(q.team) ? teamByPublicId(c.cloud.db, q.team) : null
    const g = gate(c, s, t)
    if (g instanceof Response) return g
    if (!STATE_RE.test(q.state)) throw new CloudError('bad_state', 'this sign-in link is broken: open the drive again', 400)
    c.limited('reauth', 20, 900_000)
    const h = c.cloud.db.query<{ password_hash: string }, [number]>('SELECT password_hash FROM users WHERE id = ?').get(s.userId)
    if (!(await verifyPassword(typeof b.password === 'string' ? b.password : '', h?.password_hash))) return reauthPage(c, s, t!, q, 'that password is not right', 401)
    const amr: SessionAmr = ['pwd']
    if (c.cloud.mfa.enabled(s.userId)) {
      if (!(await c.cloud.mfa.verify(s.userId, b.code))) return reauthPage(c, s, t!, q, 'that code is not right', 401)
      amr.push('totp')
    }
    const now = Date.now()
    c.cloud.db.query('UPDATE sessions SET auth_time = ?, amr = ?, totp_at = coalesce(?, totp_at) WHERE id_hash = ?').run(now, JSON.stringify(amr), amr.includes('totp') ? now : null, s.idHash)
    audit(c.cloud.db, { actor: `user:${s.userId}`, action: 'user.reauth', teamId: t!.id, detail: { amr } })
    return handOff(c, { ...s, authTime: now, amr, totpAt: amr.includes('totp') ? now : s.totpAt }, t!, g.role, q.state)
  } },
  // the drive → the console (contract "Invite from the drive"): no session, no Origin; the Bearer token proves the team
  { method: 'POST', path: '/api/team-callback/invites', crossOrigin: true, async fn(c) {
    const auth = c.req.headers.get('authorization') ?? ''
    const token = /^Bearer\s+(\S+)$/i.exec(auth)?.[1] ?? ''
    const t = token ? c.cloud.teamByCallbackToken(token) : null
    if (!t) { c.limited('team-callback-bad', 30, 3600_000); return c.json({ error: 'bad_token' }, 401) }
    const body: Record<string, unknown> = await c.form()
    try {
      const r = await c.cloud.invites.fromDrive(t, body)
      return c.json(r, r.status === 'invited' ? 201 : 200)
    } catch (e) {
      if (e instanceof CloudError) return c.json({ error: e.code, message: e.message }, e.code === 'rate_limited' ? 429 : e.code === 'people_limit' ? 409 : e.status)
      throw e
    }
  } },
]
