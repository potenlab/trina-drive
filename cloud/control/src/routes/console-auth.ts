// Trina Cloud accounts (plan 2.3, review finding 3): sign-up with a confirmed email; sign-in with a password or an
// email link; a second step with the authenticator code when the account has one (always for owners and admins once
// enrolled; they are sent to set it up before they can change anything or open a drive). Account & security: name,
// password, two-step verification with recovery codes, sessions.
// These take over web.ts's /login, /api/login, /login/link…, /signup, /verify, /logout (registered routes are asked
// first) with the same JSON answers where they existed.
import { audit } from '../audit'
import { checkPassword, CloudError, type ConsoleSession, type SessionAmr } from '../cloud'
import { hashPassword, verifyPassword } from '../keys'
import { FRESH_AUTH_MS } from '../totp'
import { userPublicId } from '../team-members'
import { csrfField, dateTime, when } from '../ui/components'
import { esc, page, shell } from '../ui/layout'
import { random, sha256 } from '../util'
import { sessionCookie } from './console-http'
import { act, flashOf, OK, rerender, safeNext } from './console-guard'
import type { ControlRoute, RouteCtx } from './types'

const TICKET_TTL = 5 * 60_000
const SESSION_MAX_AGE = 7 * 86400

const setCookie = (c: RouteCtx, v: string, maxAge = SESSION_MAX_AGE) => sessionCookie(v, maxAge, c.cfg.controlUrl.startsWith('https://'))

/** Session + cookie for this account, then the destination. */
function signIn(c: RouteCtx, userId: number, amr: SessionAmr, next: string, asJson: boolean) {
  const l = c.cloud.startSession(userId, amr, c.ip)
  c.cloud.wakeOwned(userId)
  audit(c.cloud.db, { actor: `user:${userId}`, action: 'user.login', detail: { amr } })
  if (asJson) return c.json({ ok: true, csrf: l.csrf, next }, 200, { 'set-cookie': setCookie(c, l.cookie) })
  return c.redirect(next, { 'set-cookie': setCookie(c, l.cookie) })
}

function newTicket(c: RouteCtx, userId: number, amr: SessionAmr, next: string): string {
  const t = random(32), now = Date.now()
  c.cloud.db.query('INSERT INTO login_tickets (id_hash, user_id, amr, next, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run(sha256(t), userId, JSON.stringify(amr), next, now, now + TICKET_TTL)
  return t
}

/** The second step: the ticket of the first, and a code. 5 tries per ticket. */
async function useTicket(c: RouteCtx, ticket: unknown, code: unknown): Promise<{ userId: number; amr: SessionAmr; next: string }> {
  if (typeof ticket !== 'string' || ticket.length > 100) throw new CloudError('bad_ticket', 'sign in again', 401)
  const db = c.cloud.db
  const r = db.query<{ id_hash: string; user_id: number; amr: string; next: string | null; attempts: number }, [string, number]>('SELECT id_hash, user_id, amr, next, attempts FROM login_tickets WHERE id_hash = ? AND used_at IS NULL AND expires_at > ?').get(sha256(ticket), Date.now())
  if (!r || r.attempts >= 5) throw new CloudError('bad_ticket', 'that took too long or too many tries: sign in again', 401)
  db.query('UPDATE login_tickets SET attempts = attempts + 1 WHERE id_hash = ?').run(r.id_hash)
  if (!(await c.cloud.mfa.verify(r.user_id, code))) throw new CloudError('bad_code', 'that code is not right; check the time on your phone and try the next one', 401)
  if (db.query('UPDATE login_tickets SET used_at = ? WHERE id_hash = ? AND used_at IS NULL').run(Date.now(), r.id_hash).changes !== 1) throw new CloudError('bad_ticket', 'sign in again', 401)
  return { userId: r.user_id, amr: [...(JSON.parse(r.amr) as SessionAmr), 'totp'], next: safeNext(r.next) }
}

// ---------------------------------------------------------------- pages
const loginPage = (c: RouteCtx, o: { error?: string; email?: string; status?: number } = {}) => {
  const next = safeNext(c.url.searchParams.get('next'), '')
  const nextField = next ? `<input type="hidden" name="next" value="${esc(next)}">` : ''
  const verified = c.url.searchParams.get('verified')
  return page('Sign in', `<h1>Sign in to Trina Cloud</h1><p>Your team drives, members and plan.</p>
${verified ? `<div class="flash flash-ok">${esc(OK.verified)}</div>` : ''}${o.error ? `<div class="flash flash-err" role="alert">${esc(o.error)}</div>` : ''}
<form method="post" action="/login">${nextField}
<label>Email<input type="email" name="email" required autocomplete="email" value="${esc(o.email ?? c.url.searchParams.get('email') ?? '')}"></label>
<label>Password<input type="password" name="password" required autocomplete="current-password"></label>
<button class="btn-primary">Sign in</button></form>
<div class="divider">or</div>
<form method="post" action="/login/link">${nextField}<label>Email me a sign-in link<input type="email" name="email" required autocomplete="email" placeholder="you@company.com"></label>
<button class="btn-secondary">Send link</button></form>
<p class="alt">New here? <a href="/signup">Create an account</a></p>`, { status: o.status })
}

const totpPage = (ticket: string, error?: string, status?: number) => page('Two-step verification', `<h1>Two-step verification</h1>
<p>Enter the 6-digit code from your authenticator app.</p>${error ? `<div class="flash flash-err" role="alert">${esc(error)}</div>` : ''}
<form method="post" action="/login/totp"><input type="hidden" name="ticket" value="${esc(ticket)}">
<label>Code<input class="code" name="code" inputmode="numeric" autocomplete="one-time-code" required autofocus maxlength="12"></label>
<button class="btn-primary">Continue</button></form>
<p class="alt">Lost your phone? Type one of your recovery codes instead.</p>`, { status })

const signupPage = (c: RouteCtx, error?: string, status?: number) => page('Create an account', `<h1>Create your account</h1>
<p>One account for the console and every team drive you belong to.</p>${error ? `<div class="flash flash-err" role="alert">${esc(error)}</div>` : ''}
<form method="post" action="/signup"><label>Work email<input type="email" name="email" required autocomplete="email"></label>
<label>Password<input type="password" name="password" required minlength="10" autocomplete="new-password"><span class="hint">At least 10 characters.</span></label>
<button class="btn-primary">Create account</button></form>
${c.url.searchParams.get('plan') === 'free' && c.cloud.free.full() ? '<p class="alt">Free teams are by invitation right now: create your account and join the waitlist from the console.</p>' : ''}
<p class="alt">Already have one? <a href="/login">Sign in</a></p>`, { status })

const checkMail = (email: string, what: string) => page('Check your email', `<h1>Check your email</h1><p>${what.replace('{email}', `<b>${esc(email)}</b>`)}</p><p class="alt"><a href="/login">Back to sign in</a></p>`)

// ---------------------------------------------------------------- account & security
function accountPage(c: RouteCtx, s: ConsoleSession, extra: { totpSetup?: { secret: string; uri: string }; codes?: string[] } = {}) {
  const db = c.cloud.db
  const u = db.query<{ name: string | null; email: string; password_set: number | null; totp_enabled_at: number | null; created_at: number }, [number]>('SELECT name, email, password_set, totp_enabled_at, created_at FROM users WHERE id = ?').get(s.userId)!
  const mustHave = c.cloud.mfa.mustHave(s.userId)
  const on = !!u.totp_enabled_at
  const fresh = Date.now() - s.authTime < FRESH_AUTH_MS
  const sessions = db.query<{ id_hash: string; created_at: number; last_seen_at: number | null; amr: string | null; ip: string | null }, [number, number]>('SELECT id_hash, created_at, last_seen_at, amr, ip FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 20').all(s.userId, Date.now())
  const required = c.url.searchParams.get('required')
  const next = safeNext(c.url.searchParams.get('next'), '')
  const nextField = next ? `<input type="hidden" name="next" value="${esc(next)}">` : ''
  const reauth = fresh ? '' : `<label class="field">Your password<input type="password" name="password" autocomplete="current-password" required><span class="hint">No password? <a href="/login?next=${encodeURIComponent('/account')}">Sign in again with an email link</a>, then set it up within 15 minutes.</span></label>`
  const totpBody = extra.codes
    ? `<div class="sec-body"><p style="margin-bottom:10px"><b>Save your recovery codes.</b> Each works once if you lose your phone. They are not shown again.</p><div class="codes">${extra.codes.map((x) => `<span>${esc(x)}</span>`).join('')}</div>
<p class="hint" style="margin-top:12px">Store them in your password manager.</p></div>${next ? `<div class="sec-foot"><a class="btn btn-dark" href="${esc(next)}">Continue</a></div>` : ''}`
    : extra.totpSetup
      ? `<div class="sec-body"><ol class="muted" style="margin:0 0 14px;padding-left:18px;font-size:14px"><li>Open your authenticator app (1Password, Google Authenticator, Authy…) and add an account.</li><li>Paste this key (or the setup link), then type the 6-digit code it shows.</li></ol>
<p class="secret">${esc(extra.totpSetup.secret.replace(/(.{4})/g, '$1 ').trim())}</p>
<p class="hint" style="margin:8px 0 16px">Setup link: <button type="button" class="link-btn" data-copy="${esc(extra.totpSetup.uri)}">copy otpauth:// link</button></p>
<form method="post" action="/account/totp/confirm" class="inline">${csrfField(s.csrf)}${nextField}<label class="field" style="flex:1;min-width:180px">Code from the app<input class="code" name="code" inputmode="numeric" autocomplete="one-time-code" required maxlength="6" autofocus></label><button class="btn btn-primary">Turn on</button></form></div>`
      : on
        ? `<div class="sec-body"><p>On since ${esc(dateTime(u.totp_enabled_at))}. ${c.cloud.mfa.recoveryLeft(s.userId)} recovery codes left.</p></div>
<div class="sec-foot"><span class="muted">${mustHave ? 'Required: you own or run a team.' : 'Recommended for everyone.'}</span>${mustHave ? '' : `<form method="post" action="/account/totp/disable" data-confirm="Turn off two-step verification?">${csrfField(s.csrf)}<button class="btn btn-sm">Turn off</button></form>`}</div>`
        : `<div class="sec-body"><p class="muted" style="margin-bottom:14px">A code from an authenticator app at sign-in, and before member and team changes.${mustHave ? ' <b>Required for owners and admins.</b>' : ''}</p>
<form method="post" action="/account/totp/begin">${csrfField(s.csrf)}${nextField}${reauth}<button class="btn btn-primary">Set up two-step verification</button></form></div>`
  const body = `<section class="section"><div class="card"><div class="sec-head"><div><h2>Profile</h2><p>Shown to your teammates and in the drives.</p></div></div>
<form method="post" action="/account/name">${csrfField(s.csrf)}<div class="sec-body"><dl class="kv" style="margin-bottom:14px"><dt>Email</dt><dd>${esc(u.email)}</dd><dt>Account since</dt><dd>${esc(dateTime(u.created_at))}</dd></dl>
<label class="field">Name<input name="name" maxlength="80" value="${esc(u.name ?? '')}" autocomplete="name"></label></div><div class="sec-foot"><button class="btn btn-dark btn-sm">Save</button></div></form></div></section>
<section class="section" id="two-step"><div class="card"><div class="sec-head"><div><h2>Two-step verification</h2><p>${on ? 'On' : 'Off'}</p></div><span class="grow"></span>${on ? '<span class="badge b-ok">On</span>' : mustHave ? '<span class="badge b-warn">Required</span>' : ''}</div>${totpBody}</div></section>
<section class="section"><div class="card"><div class="sec-head"><div><h2>Password</h2><p>${u.password_set === 0 ? 'Not set — you sign in with email links.' : 'Changing it signs out your other sessions and drives.'}</p></div></div>
<form method="post" action="/account/password">${csrfField(s.csrf)}<div class="sec-body"><div class="grid-2">${fresh ? '<div></div>' : '<label class="field">Current password<input type="password" name="current" autocomplete="current-password"></label>'}
<label class="field">New password<input type="password" name="password" minlength="10" required autocomplete="new-password"><span class="hint">At least 10 characters.</span></label></div></div><div class="sec-foot"><button class="btn btn-dark btn-sm">Change password</button></div></form></div></section>
<section class="section"><div class="card"><div class="sec-head"><div><h2>Sessions</h2><p>Where you are signed in to the console.</p></div><span class="grow"></span>
<form method="post" action="/account/sessions/others">${csrfField(s.csrf)}<button class="btn btn-sm">Sign out the others</button></form></div>
<table class="table stack"><thead><tr><th>Signed in</th><th>How</th><th>Last seen</th><th></th></tr></thead><tbody>${sessions.map((x) => `<tr><td>${esc(dateTime(x.created_at))}${x.id_hash === s.idHash ? ' <span class="badge b-accent nodot">This browser</span>' : ''}</td>
<td class="faint">${esc((x.amr ? JSON.parse(x.amr) as string[] : ['pwd']).map((a) => (a === 'pwd' ? 'password' : a === 'link' ? 'email link' : 'authenticator')).join(' + '))}</td><td class="faint">${esc(when(x.last_seen_at ?? x.created_at))}</td>
<td class="actions">${x.id_hash === s.idHash ? '' : `<form method="post" action="/account/sessions/revoke">${csrfField(s.csrf)}<input type="hidden" name="id" value="${esc(x.id_hash.slice(0, 16))}"><button class="btn btn-sm btn-ghost">Sign out</button></form>`}</td></tr>`).join('')}</tbody></table></div></section>`
  const banner = required && !on ? `<div class="banner" role="alert"><p><b>Set up two-step verification to continue.</b> Owners and admins of a team need an authenticator app before they open a drive or change members (it protects everyone in the team if your password leaks).</p></div>` : ''
  return shell({
    title: 'Account & security', user: s, csrf: s.csrf, teams: c.cloud.members.teamsOf(s.userId).map((t) => ({ slug: t.slug, name: t.name, role: t.role })), section: 'account',
    heading: 'Account & security', sub: esc(u.email), body, banner, flash: flashOf(c),
  })
}

async function confirmPassword(c: RouteCtx, s: ConsoleSession, pw: unknown) {
  if (Date.now() - s.authTime < FRESH_AUTH_MS) return
  const h = c.cloud.db.query<{ password_hash: string }, [number]>('SELECT password_hash FROM users WHERE id = ?').get(s.userId)
  if (!(await verifyPassword(typeof pw === 'string' ? pw : '', h?.password_hash))) throw new CloudError('bad_password', 'that password is not right (or sign in again with an email link)', 401)
  const t = Date.now()
  c.cloud.db.query('UPDATE sessions SET auth_time = ? WHERE id_hash = ?').run(t, s.idHash)
  s.authTime = t
}

// ---------------------------------------------------------------- routes
const limitLogin = (c: RouteCtx, email: unknown) => {
  c.limited('login', 30, 900_000)
  if (!c.rateLimit.hit(`login-email:${String(email ?? '').toLowerCase()}`, 10, 900_000)) throw new CloudError('rate_limited', 'too many attempts; try again later', 429)
}

async function passwordStep(c: RouteCtx, b: Record<string, string>, asJson: boolean): Promise<Response> {
  limitLogin(c, b.email)
  const userId = await c.cloud.checkPassword(b.email, b.password)
  const next = safeNext(b.next)
  if (c.cloud.mfa.enabled(userId)) {
    const ticket = newTicket(c, userId, ['pwd'], next)
    return asJson ? c.json({ ok: true, totp_required: true, ticket }) : totpPage(ticket)
  }
  return signIn(c, userId, ['pwd'], next, asJson)
}

async function linkStep(c: RouteCtx, b: Record<string, string>, asJson: boolean): Promise<Response> {
  c.limited('login', 30, 900_000)
  const userId = c.cloud.useLoginLink(b.token)
  const next = safeNext(b.next)
  if (c.cloud.mfa.enabled(userId)) {
    const ticket = newTicket(c, userId, ['link'], next)
    return asJson ? c.json({ ok: true, totp_required: true, ticket }) : totpPage(ticket)
  }
  return signIn(c, userId, ['link'], next, asJson)
}

export const authRoutes: ControlRoute[] = [
  { method: 'GET', path: '/login', fn: (c) => c.session ? c.redirect(safeNext(c.url.searchParams.get('next'))) : loginPage(c) },
  { method: 'POST', path: '/login', async fn(c) {
    const b = await c.form()
    try { return await passwordStep(c, b, false) } catch (e) {
      if (e instanceof CloudError) { c.url.searchParams.set('next', safeNext(b.next, '')); return loginPage(c, { error: e.message, email: b.email, status: e.status }) }
      throw e
    }
  } },
  { method: 'POST', path: '/api/login', async fn(c) { return passwordStep(c, await c.form(), true) } },
  { method: 'POST', path: '/login/totp', async fn(c) {
    const b = await c.form()
    try { const r = await useTicket(c, b.ticket, b.code); return signIn(c, r.userId, r.amr, r.next, false) } catch (e) {
      if (e instanceof CloudError && e.code === 'bad_code') return totpPage(String(b.ticket), e.message, 401)
      if (e instanceof CloudError) return loginPage(c, { error: e.message, status: e.status })
      throw e
    }
  } },
  { method: 'POST', path: '/api/login/totp', async fn(c) { const b = await c.form(); const r = await useTicket(c, b.ticket, b.code); return signIn(c, r.userId, r.amr, r.next, true) } },
  // email sign-in links (members use these instead of a password)
  { method: 'POST', path: '/login/link', async fn(c) {
    c.limited('login-link', 10, 3600_000)
    const b = await c.form()
    try { await c.cloud.requestLoginLink(b.email, safeNext(b.next, '')) } catch (e) { if (e instanceof CloudError) return loginPage(c, { error: e.message, status: e.status }); throw e }
    return checkMail(String(b.email ?? ''), 'If {email} has an account, a sign-in link is on its way. It works once, for 15 minutes.')
  } },
  { method: 'POST', path: '/api/login/link', async fn(c) { c.limited('login-link', 10, 3600_000); const b = await c.form(); await c.cloud.requestLoginLink(b.email, safeNext(b.next, '')); return c.json({ ok: true, next: 'check your email' }) } },
  // the link only shows a button: mail scanners that fetch links must not use it up
  { method: 'GET', path: '/login/link', fn: (c) => page('Sign in', `<h1>Sign in to Trina Cloud</h1><p>Continue with the link from your email.</p>
<form method="post" action="/login/link/confirm"><input type="hidden" name="token" value="${esc(c.url.searchParams.get('token') ?? '')}"><input type="hidden" name="next" value="${esc(safeNext(c.url.searchParams.get('next')))}"><button class="btn-primary">Sign in</button></form>`) },
  { method: 'POST', path: '/login/link/confirm', async fn(c) {
    const b = await c.form()
    try { return await linkStep(c, b, false) } catch (e) {
      if (e instanceof CloudError) return page('Sign in', `<h1>That link did not work</h1><p class="err">${esc(e.message)}</p><p class="alt"><a href="/login">Sign in</a></p>`, { status: e.status })
      throw e
    }
  } },
  { method: 'POST', path: '/api/login/link/confirm', async fn(c) { return linkStep(c, await c.form(), true) } },
  { method: 'POST', path: '/logout', async fn(c) {
    if (c.session) { const b = await c.form(); c.csrfOk(b); c.cloud.logout(c.session.idHash) }
    return c.redirect('/login', { 'set-cookie': setCookie(c, '', 0) })
  } },
  // sign-up (an account; teams are made in the console)
  { method: 'GET', path: '/signup', fn: (c) => c.session ? c.redirect('/') : signupPage(c) },
  { method: 'POST', path: '/signup', async fn(c) {
    c.limited('signup', 10, 3600_000)
    const b = await c.form()
    try { await c.cloud.signup(b.email, b.password) } catch (e) { if (e instanceof CloudError) return signupPage(c, e.message, e.status); throw e }
    return checkMail(String(b.email ?? ''), 'We sent a confirmation link to {email}. It works once, for 48 hours.')
  } },
  { method: 'GET', path: '/verify', fn: (c) => page('Confirm your email', `<h1>Confirm your email</h1><p>One click and your account is ready.</p>
<form method="post" action="/verify"><input type="hidden" name="token" value="${esc(c.url.searchParams.get('token') ?? '')}"><button class="btn-primary">Confirm</button></form>`) },
  { method: 'POST', path: '/verify', async fn(c) {
    c.limited('verify', 30, 3600_000)
    const b = await c.form()
    try { c.cloud.verifyEmail(b.token) } catch (e) { if (e instanceof CloudError) return page('Confirm your email', `<h1>That link did not work</h1><p class="err">${esc(e.message)}</p><p class="alt"><a href="/login">Sign in</a></p>`, { status: e.status }); throw e }
    return c.redirect('/login?verified=1')
  } },

  // ---- account & security
  { method: 'GET', path: '/account', fn: (c) => { const s = c.session; return s ? accountPage(c, s) : c.redirect('/login?next=/account') } },
  { method: 'GET', path: '/account/security', fn: (c) => c.redirect(`/account${c.url.search}#two-step`) },
  { method: 'POST', path: '/account/name', fn: (c) => act(c, '/account', (b, s) => {
    const name = String(b.name ?? '').trim().replace(/\s+/g, ' ')
    if (name.length > 80 || /[\p{Cc}]/u.test(name)) throw new CloudError('bad_name', 'a name of at most 80 characters')
    c.cloud.db.query('UPDATE users SET name = ? WHERE id = ?').run(name || null, s.userId)
    // the drives show the new name after the next sync
    for (const t of c.cloud.members.teamsOf(s.userId)) c.cloud.sync.changed(t.id)
    return 'name'
  }) },
  { method: 'POST', path: '/account/password', fn: (c) => act(c, '/account', async (b, s) => {
    await confirmPassword(c, s, b.current)
    const pw = checkPassword(b.password)
    c.cloud.db.query('UPDATE users SET password_hash = ?, password_set = 1 WHERE id = ?').run(await hashPassword(pw), s.userId)
    c.cloud.db.query('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id_hash != ? AND revoked_at IS NULL').run(Date.now(), s.userId, s.idHash)
    audit(c.cloud.db, { actor: `user:${s.userId}`, action: 'user.password_changed' })
    // the drives drop this person's web sessions too (contract event member.sessions_revoked)
    const sub = userPublicId(c.cloud, s.userId)
    for (const t of c.cloud.members.teamsOf(s.userId)) c.cloud.sync.changed(t.id, [{ type: 'member.sessions_revoked', cloud_user: sub, reason: 'console_password_changed' }])
    return 'password'
  }) },
  { method: 'POST', path: '/account/totp/begin', async fn(c) {
    const s = c.signedIn(); const b = await c.form(); c.csrfOk(b)
    try {
      await confirmPassword(c, s, b.password)
      const setup = await c.cloud.mfa.begin(s.userId)
      if (b.next) c.url.searchParams.set('next', safeNext(b.next, ''))
      return accountPage(c, s, { totpSetup: setup })
    } catch (e) { return rerender(c, '/account', e) }
  } },
  { method: 'POST', path: '/account/totp/confirm', async fn(c) {
    const s = c.signedIn(); const b = await c.form(); c.csrfOk(b)
    if (b.next) c.url.searchParams.set('next', safeNext(b.next, ''))
    let codes: string[]
    try { codes = await c.cloud.mfa.confirm(s.userId, b.code, `user:${s.userId}`) } catch (e) {
      if (e instanceof CloudError && e.code === 'bad_code') {
        // the same secret, again (the pending one is kept)
        const setup = await c.cloud.mfa.begin(s.userId)
        const res = accountPage(c, s, { totpSetup: setup })
        return new Response(res.body, { status: 401, headers: res.headers })
      }
      throw e
    }
    const t = Date.now()
    c.cloud.db.query("UPDATE sessions SET totp_at = ?, amr = ? WHERE id_hash = ?").run(t, JSON.stringify([...new Set([...s.amr, 'totp'])]), s.idHash)
    s.totpAt = t
    return accountPage(c, s, { codes })
  } },
  { method: 'POST', path: '/account/totp/disable', fn: (c) => act(c, '/account', (_b, s) => { c.cloud.mfa.disable(s.userId, `user:${s.userId}`); return 'totp_off' }) },
  { method: 'POST', path: '/account/sessions/others', fn: (c) => act(c, '/account', (_b, s) => {
    c.cloud.db.query('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id_hash != ? AND revoked_at IS NULL').run(Date.now(), s.userId, s.idHash)
    audit(c.cloud.db, { actor: `user:${s.userId}`, action: 'user.sessions_revoked' })
    return 'sessions'
  }) },
  { method: 'POST', path: '/account/sessions/revoke', fn: (c) => act(c, '/account', (b, s) => {
    const prefix = String(b.id ?? '')
    if (!/^[0-9a-f]{16}$/.test(prefix)) throw new CloudError('not_found', 'not found', 404)
    c.cloud.db.query("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND substr(id_hash, 1, 16) = ? AND id_hash != ? AND revoked_at IS NULL").run(Date.now(), s.userId, prefix, s.idHash)
    return 'session'
  }) },

  // ---- JSON
  { method: 'GET', path: '/api/me', fn: (c) => {
    const s = c.signedIn()
    return c.json({ user: { id: s.publicId ?? userPublicId(c.cloud, s.userId), email: s.email, name: s.name, verified: s.verified, totp: c.cloud.mfa.enabled(s.userId), totp_required: c.cloud.mfa.mustHave(s.userId) },
      teams: c.cloud.members.teamsOf(s.userId).map((t) => ({ id: t.public_id, slug: t.slug, name: t.name, role: t.role, url: c.cloud.url(t) })) })
  } },
  { method: 'POST', path: '/api/me/totp/setup', async fn(c) {
    const s = c.signedIn(); const b = await c.form(); c.csrfOk(b)
    await confirmPassword(c, s, b.password)
    return c.json(await c.cloud.mfa.begin(s.userId))
  } },
  { method: 'POST', path: '/api/me/totp/enable', async fn(c) {
    const s = c.signedIn(); const b = await c.form(); c.csrfOk(b)
    const codes = await c.cloud.mfa.confirm(s.userId, b.code, `user:${s.userId}`)
    c.cloud.db.query('UPDATE sessions SET totp_at = ? WHERE id_hash = ?').run(Date.now(), s.idHash)
    return c.json({ ok: true, recovery_codes: codes })
  } },
  { method: 'POST', path: '/api/stepup', async fn(c) {
    const s = c.signedIn(); const b = await c.form(); c.csrfOk(b)
    if (!(await c.cloud.mfa.verify(s.userId, b.code))) throw new CloudError('bad_code', 'that code is not right', 401)
    c.cloud.db.query('UPDATE sessions SET totp_at = ? WHERE id_hash = ?').run(Date.now(), s.idHash)
    return c.json({ ok: true })
  } },
]
