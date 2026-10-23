// HTTP for the control plane (Bun.serve, behind Caddy): server-rendered pages for people (sign up, confirm email,
// sign in — with a password or an email link —, dashboard with Paddle checkout and upgrades, the Free sign-up at /free,
// the wake page a paused free team links to at /wake/<slug>), a JSON API with the same operations (/api/*, used by the landing page and
// the end-to-end test), the Paddle webhook, and two internal endpoints for Caddy and Prometheus.
// Seams (W0): feature modules register routes in routes/index.ts (asked before the pages here), the session cookie,
// headers and Origin rule are in routes/console-http.ts, the page frame and stylesheet in ui/layout.ts.
import { CloudError, type Cloud } from './cloud'
import { teamByPublicId, teamBySlug, type TeamRow } from './db'
import { PADDLE_IPS, summarize, verifyPaddle, type PaddleEvent } from './paddle'
import { suggestSlug } from './slug'
import { iso, now, timingSafeEqualStr } from './util'
import { findRoute } from './routes'
import { HEADERS, originRefused, readSessionCookie, sameOrigin, sessionCookie } from './routes/console-http'
import type { RouteCtx } from './routes/types'
import { CSS, esc, page } from './ui/layout'

const MAX_BODY = 64 * 1024

export class RateLimit {
  constructor(private readonly cloud: Cloud) {}
  /** true = allowed (and counted) */
  hit(key: string, limit: number, windowMs: number): boolean {
    const db = this.cloud.db, t = now()
    const r = db.query<{ count: number; reset_at: number }, [string]>('SELECT count, reset_at FROM rate WHERE key = ?').get(key)
    if (!r || r.reset_at <= t) { db.query('INSERT INTO rate (key, count, reset_at) VALUES (?, 1, ?) ON CONFLICT (key) DO UPDATE SET count = 1, reset_at = excluded.reset_at').run(key, t + windowMs); return true }
    if (r.count >= limit) return false
    db.query('UPDATE rate SET count = count + 1 WHERE key = ?').run(key)
    return true
  }
}

const CHECKOUT_JS = `(() => {
  const cfg = document.getElementById('paddle-config'); if (!cfg || !window.Paddle) return
  const d = cfg.dataset
  if (d.env === 'sandbox') Paddle.Environment.set('sandbox')
  Paddle.Initialize({ token: d.token })
  for (const b of document.querySelectorAll('[data-price]')) b.addEventListener('click', () => Paddle.Checkout.open({
    items: [{ priceId: b.dataset.price, quantity: 1 }], customer: { email: d.email },
    customData: { tdcloud_team: b.dataset.team }, settings: { successUrl: d.success },
  }))
})()`

// the wake page: polls until the team runs, then opens it
const WAKE_JS = `(() => {
  const el = document.getElementById('wake'); if (!el) return
  const slug = el.dataset.slug, started = Date.now()
  const tick = async () => {
    try {
      const r = await fetch('/api/wake/' + encodeURIComponent(slug), { cache: 'no-store' }).then((x) => x.json())
      if (r.state === 'running') { el.textContent = 'Ready. Opening…'; location.href = r.url + '/'; return }
      if (r.state === 'paused' || r.state === 'unavailable') { el.textContent = 'It did not start. Reload this page to try again.'; return }
      el.textContent = 'Starting… ' + Math.round((Date.now() - started) / 1000) + ' s'
    } catch { /* try again */ }
    setTimeout(tick, 1500)
  }
  tick()
})()`

interface Req { req: Request; url: URL; ip: string; cookie?: string }

export function makeHandler(cloud: Cloud) {
  const rl = new RateLimit(cloud)
  const cfg = cloud.cfg
  const controlOrigin = new URL(cfg.controlUrl).origin

  const clientIp = (req: Request, peer: string | undefined) => {
    const p = peer ?? 'unknown'
    if (!cfg.trustedProxies.includes(p) && !cfg.trustedProxies.includes('*')) return p
    // the entry the trusted proxy appended (Caddy sends exactly one); never a value further left that a client wrote
    return req.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim() || p
  }
  async function form(req: Request): Promise<Record<string, string>> {
    const len = Number(req.headers.get('content-length') ?? 0)
    if (len > MAX_BODY) throw new CloudError('too_large', 'request too large', 413)
    const text = await req.text()
    if (text.length > MAX_BODY) throw new CloudError('too_large', 'request too large', 413)
    const ct = req.headers.get('content-type') ?? ''
    if (ct.includes('application/json')) { try { const v = JSON.parse(text || '{}'); return v && typeof v === 'object' ? v : {} } catch { throw new CloudError('bad_json', 'bad JSON') } }
    return Object.fromEntries(new URLSearchParams(text))
  }
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } })
  const redirect = (to: string, headers: Record<string, string> = {}) => new Response(null, { status: 303, headers: { location: to, ...headers } })
  const setCookie = (v: string, maxAge: number) => sessionCookie(v, maxAge, cfg.controlUrl.startsWith('https://'))
  const limited = (r: Req, key: string, limit: number, windowMs: number) => {
    if (!rl.hit(`${key}:${r.ip}`, limit, windowMs)) throw new CloudError('rate_limited', 'too many attempts; try again later', 429)
  }
  /** free sign-ups per client address (Caddy's X-Forwarded-For: the real client) */
  const freeLimits = (r: Req) => {
    limited(r, 'free-signup', cfg.free.signupsPerIpHour, 3600_000)
    limited(r, 'free-signup-day', cfg.free.signupsPerIpDay, 86400_000)
  }
  const internalOk = (r: Req) => {
    const key = r.url.searchParams.get('key') ?? ''
    if (cfg.caddyAskKey) return timingSafeEqualStr(key, cfg.caddyAskKey)
    return r.ip === '127.0.0.1' || r.ip === '::1' || cfg.trustedProxies.includes(r.ip)
  }

  function teamCard(t: TeamRow, csrf: string) {
    const url = cloud.url(t)
    const free = t.plan === 'free'
    const status: Record<string, string> = {
      pending_payment: 'waiting for payment',
      provisioning: t.waiting_since ? 'starting — a server is being prepared for it (a few minutes; the setup link comes by email)' : 'starting (a minute or two; the setup link comes by email)',
      active: 'running',
      past_due: `running — payment failed, paused on ${iso(t.grace_until)} unless paid`,
      suspended: cloud.free.isPaused(t) ? `paused after ${Math.round(cfg.free.idlePauseMs / 86400_000)} days without activity — nothing deleted; deleted on ${iso((t.paused_at ?? t.suspended_at ?? 0) + cfg.free.deleteAfterMs).slice(0, 10)} unless woken and used` : `paused (${t.suspend_reason ?? ''})`,
      deleting: 'being deleted', failed: 'could not start — we have been alerted', deleted: 'deleted',
    }
    const buy = t.status === 'pending_payment' || (t.status === 'suspended' && t.sub_status === 'canceled')
    // a free team upgrades in place: the checkout carries this team's id, the webhook changes its plan (cloud.ts)
    const upgrade = free && ['provisioning', 'active', 'suspended'].includes(t.status)
    const plans: ('team' | 'business')[] = upgrade ? ['team', 'business'] : [t.plan as 'team' | 'business']
    const prices = plans.flatMap((pl) => (['monthly', 'yearly'] as const).map((c) => [pl, c, cfg.paddle.checkout[`${pl}_${c}`]] as const)).filter(([, , p]) => p)
    const label = (pl: string, c: string) => upgrade ? `Upgrade to ${pl === 'team' ? 'Team' : 'Business'} (${c})` : `Subscribe ${c}`
    return `<div class="card"><h2>${esc(t.name)}</h2><p><code>${esc(url)}</code></p><p class="muted">${esc(free ? 'Free' : t.plan)} plan · ${esc(status[t.status] ?? t.status)}</p>
${free ? `<p class="muted small">Free: 1 GB, up to 3 people; pauses after ${Math.round(cfg.free.idlePauseMs / 86400_000)} days without activity. Upgrading keeps this team, its files and its address.</p>` : ''}
${cloud.free.isPaused(t) ? `<form method="post" action="/teams/${esc(t.public_id)}/wake"><input type="hidden" name="csrf" value="${esc(csrf)}"><button>Wake up</button></form>` : ''}
${buy || upgrade ? (prices.length && cfg.paddle.clientToken ? `<div class="row">${prices.map(([pl, c, p]) => `<button type="button"${upgrade ? ' class="plain"' : ''} data-price="${esc(p)}" data-team="${esc(t.public_id)}">${esc(label(pl, c))}</button>`).join('')}</div>` : `<p class="muted">Checkout is not configured here; write to ${esc(cfg.opsEmail)}.</p>`) : ''}
${['active', 'past_due'].includes(t.status) ? `<div class="row"><a class="btn" href="${esc(url)}/">Open</a><form method="post" action="/teams/${esc(t.public_id)}/resend-setup"><input type="hidden" name="csrf" value="${esc(csrf)}"><button class="plain">Mail the setup link again</button></form></div>` : ''}</div>`
  }

  async function route(r: Req): Promise<Response> {
    const { req, url } = r
    const p = url.pathname, m = req.method
    const s = cloud.session(r.cookie)
    const signedIn = () => { if (!s) throw new CloudError('signed_out', 'sign in first', 401); return s }
    const csrfOk = (b: Record<string, string>) => { if (!s || !b.csrf && !req.headers.get('x-csrf-token') || !timingSafeEqualStr(b.csrf ?? req.headers.get('x-csrf-token') ?? '', s.csrf)) throw new CloudError('bad_csrf', 'reload the page and try again', 403) }
    // a route a module registered (routes/index.ts) may opt out of the Origin rule (a Bearer callback from a team)
    const reg = findRoute(m, p)
    if (originRefused(req, p, controlOrigin) && !reg?.route.crossOrigin) throw new CloudError('bad_origin', 'cross-site request refused', 403)

    // ---- static, health, internal
    if (p === '/static/app.css') return new Response(CSS, { headers: { 'content-type': 'text/css', 'cache-control': 'public, max-age=3600' } })
    if (p === '/static/checkout.js') return new Response(CHECKOUT_JS, { headers: { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=3600' } })
    if (p === '/static/wake.js') return new Response(WAKE_JS, { headers: { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=3600' } })
    if (p === '/healthz') return json({ ok: true })
    if (p === '/internal/caddy/ask') {
      if (!internalOk(r)) return new Response('forbidden', { status: 403 })
      return new Response(null, { status: cloud.hostAllowed(url.searchParams.get('domain') ?? '') ? 200 : 404 })
    }
    if (p === '/internal/metrics') {
      if (!internalOk(r)) return new Response('forbidden', { status: 403 })
      return new Response(metrics(cloud), { headers: { 'content-type': 'text/plain; version=0.0.4' } })
    }

    // ---- Paddle
    if (p === '/paddle/webhook' && m === 'POST') return paddleWebhook(r)

    // ---- routes the feature modules register (routes/index.ts: the console, …): asked before the pages below, so a
    // module may take one over; a changing request must come from the console's own pages unless the route says not
    if (reg) {
      if (m !== 'GET' && m !== 'HEAD' && !reg.route.crossOrigin && !sameOrigin(req, controlOrigin)) throw new CloudError('bad_origin', 'cross-site request refused', 403)
      const ctx: RouteCtx = {
        cloud, cfg, req, url, ip: r.ip, match: reg.match, session: s, signedIn, csrfOk, form: () => form(req),
        limited: (key, limit, windowMs) => limited(r, key, limit, windowMs), rateLimit: rl, json, redirect,
      }
      return reg.route.fn(ctx)
    }

    // ---- JSON API
    if (p === '/api/signup' && m === 'POST') { limited(r, 'signup', 10, 3600_000); const b = await form(req); await cloud.signup(b.email, b.password); return json({ ok: true, next: 'check your email' }) }
    if (p === '/api/verify' && m === 'POST') { limited(r, 'verify', 30, 3600_000); const b = await form(req); cloud.verifyEmail(b.token); return json({ ok: true }) }
    if (p === '/api/login' && m === 'POST') {
      limited(r, 'login', 30, 900_000)
      const b = await form(req)
      if (!rl.hit(`login-email:${String(b.email ?? '').toLowerCase()}`, 10, 900_000)) throw new CloudError('rate_limited', 'too many attempts; try again later', 429)
      const l = await cloud.login(b.email, b.password)
      cloud.wakeOwned(l.userId)
      return json({ ok: true, csrf: l.csrf }, 200, { 'set-cookie': setCookie(l.cookie, 7 * 86400) })
    }
    if (p === '/api/login/link' && m === 'POST') { limited(r, 'login-link', 10, 3600_000); const b = await form(req); await cloud.requestLoginLink(b.email); return json({ ok: true, next: 'check your email' }) }
    if (p === '/api/login/link/confirm' && m === 'POST') {
      limited(r, 'login', 30, 900_000)
      const b = await form(req)
      const l = await cloud.loginWithLink(b.token)
      cloud.wakeOwned(l.userId)
      return json({ ok: true, csrf: l.csrf }, 200, { 'set-cookie': setCookie(l.cookie, 7 * 86400) })
    }
    // ---- Free plan (free.ts)
    if (p === '/api/free/signup' && m === 'POST') { const b = await form(req); freeLimits(r); await cloud.free.requestSignup({ email: b.email, name: b.name, slug: b.slug, ip: r.ip, turnstile: b['cf-turnstile-response'] }); return json({ ok: true, next: 'check your email' }) }
    if (p === '/api/free/verify' && m === 'POST') {
      limited(r, 'verify', 30, 3600_000)
      const b = await form(req)
      const v = await cloud.free.verify(b.token)
      return json({ status: v.status, team: v.team && v.status === 'provisioning' ? publicTeam(cloud, v.team) : undefined, url: v.url })
    }
    const wakeApi = /^\/api\/wake\/([a-z0-9-]{1,40})$/.exec(p)
    if (wakeApi && m === 'GET') {
      limited(r, 'wake-poll', 600, 3600_000)
      const t = teamBySlug(cloud.db, wakeApi[1]!)
      const state = cloud.free.wakeState(t)
      return json({ state, url: t && state !== 'unavailable' ? cloud.url(t) : undefined })
    }
    if (p === '/api/teams' && m === 'GET') { const u = signedIn(); return json({ teams: cloud.teamsOf(u.userId).map((t) => publicTeam(cloud, t)) }) }
    if (p === '/api/teams' && m === 'POST') {
      const u = signedIn(); const b = await form(req); csrfOk(b)
      return json({ team: publicTeam(cloud, await cloud.createTeam(u.userId, b.name, b.slug, b.plan)) }, 201)
    }

    // ---- pages
    if (p === '/' && m === 'GET') return s ? redirect('/dashboard') : page('Your team\'s Trina Drive, hosted', `<h1>Your team's Trina Drive, hosted.</h1>
<p>Your own isolated Trina Drive at <code>your-team.${esc(cfg.domain)}</code>, with HTTPS, so Claude and ChatGPT connectors work right away.</p>
<p class="row"><a class="btn" href="/free">Start free</a> <a class="btn" href="/signup">Create an account</a> <a href="/login">Sign in</a></p>
<p class="muted">Free: 1 GB, up to 3 people, pauses after 7 days without activity. Team and Business: more people and storage, never paused.</p>`)
    if (p === '/signup' && m === 'GET') return page('Create an account', `<h1>Create an account</h1><form method="post" action="/signup">
<label>Work email<input type="email" name="email" required autocomplete="email"></label>
<label>Password (10+ characters)<input type="password" name="password" required minlength="10" autocomplete="new-password"></label><button>Create account</button></form>
<p class="muted">Already have one? <a href="/login">Sign in</a></p>`)
    if (p === '/signup' && m === 'POST') {
      limited(r, 'signup', 10, 3600_000)
      const b = await form(req)
      try { await cloud.signup(b.email, b.password) } catch (e) { if (e instanceof CloudError) return page('Create an account', `<h1>Create an account</h1><p class="err">${esc(e.message)}</p><p><a href="/signup">Back</a></p>`); throw e }
      return page('Check your email', `<h1>Check your email</h1><p>We sent a confirmation link to <b>${esc(b.email)}</b>.</p>`)
    }
    if (p === '/verify' && m === 'GET') {
      // the link only shows a button: mail scanners that fetch links must not use it up
      return page('Confirm your email', `<h1>Confirm your email</h1><form method="post" action="/verify"><input type="hidden" name="token" value="${esc(url.searchParams.get('token') ?? '')}"><button>Confirm</button></form>`)
    }
    if (p === '/verify' && m === 'POST') {
      limited(r, 'verify', 30, 3600_000)
      const b = await form(req)
      try { cloud.verifyEmail(b.token) } catch (e) { if (e instanceof CloudError) return page('Confirm your email', `<h1>That link did not work</h1><p class="err">${esc(e.message)}</p>`); throw e }
      return redirect('/login?verified=1')
    }
    if (p === '/login' && m === 'GET') return page('Sign in', `<h1>Sign in</h1>${url.searchParams.get('verified') ? '<p>Email confirmed. Sign in to create your team.</p>' : ''}<form method="post" action="/login">
<label>Email<input type="email" name="email" required autocomplete="email"></label><label>Password<input type="password" name="password" required autocomplete="current-password"></label><button>Sign in</button></form>
<div class="card"><h2>No password?</h2><p class="muted">Started with Free, or forgot it: we mail you a sign-in link.</p><form method="post" action="/login/link">
<label>Email<input type="email" name="email" required autocomplete="email"></label><button class="plain">Email me a sign-in link</button></form></div>`)
    if (p === '/login' && m === 'POST') {
      limited(r, 'login', 30, 900_000)
      const b = await form(req)
      try {
        if (!rl.hit(`login-email:${String(b.email ?? '').toLowerCase()}`, 10, 900_000)) throw new CloudError('rate_limited', 'too many attempts; try again later', 429)
        const l = await cloud.login(b.email, b.password)
        cloud.wakeOwned(l.userId)
        return redirect('/dashboard', { 'set-cookie': setCookie(l.cookie, 7 * 86400) })
      } catch (e) { if (e instanceof CloudError) return page('Sign in', `<h1>Sign in</h1><p class="err">${esc(e.message)}</p><p><a href="/login">Try again</a></p>`); throw e }
    }
    if (p === '/logout' && m === 'POST') { if (s) { const b = await form(req); csrfOk(b); cloud.logout(s.idHash) } return redirect('/', { 'set-cookie': setCookie('', 0) }) }
    if (p === '/login/link' && m === 'POST') {
      limited(r, 'login-link', 10, 3600_000)
      const b = await form(req)
      try { await cloud.requestLoginLink(b.email) } catch (e) { if (e instanceof CloudError) return page('Sign in', `<h1>Sign in</h1><p class="err">${esc(e.message)}</p><p><a href="/login">Back</a></p>`); throw e }
      return page('Check your email', `<h1>Check your email</h1><p>If <b>${esc(b.email)}</b> has an account, a sign-in link is on its way (it works once, for 15 minutes).</p>`)
    }
    if (p === '/login/link' && m === 'GET') {
      // a button, not a GET that signs in: mail scanners must not use the link up
      return page('Sign in', `<h1>Sign in to Trina Cloud</h1><form method="post" action="/login/link/confirm"><input type="hidden" name="token" value="${esc(url.searchParams.get('token') ?? '')}"><button>Sign in</button></form>`)
    }
    if (p === '/login/link/confirm' && m === 'POST') {
      limited(r, 'login', 30, 900_000)
      const b = await form(req)
      try {
        const l = await cloud.loginWithLink(b.token)
        cloud.wakeOwned(l.userId)
        return redirect('/dashboard', { 'set-cookie': setCookie(l.cookie, 7 * 86400) })
      } catch (e) { if (e instanceof CloudError) return page('Sign in', `<h1>That link did not work</h1><p class="err">${esc(e.message)}</p><p><a href="/login">Sign in</a></p>`); throw e }
    }
    if (p === '/free' && m === 'GET') {
      const ts = cfg.free.turnstileSiteKey
      return page('Start free', `<h1>Start your team's Trina Drive, free</h1>
<p class="muted">1 GB, up to 3 people, the same isolated instance as paid teams. It pauses after ${Math.round(cfg.free.idlePauseMs / 86400_000)} days without activity (nothing is deleted; one click wakes it) and is deleted after ${Math.round(cfg.free.deleteAfterMs / 86400_000)} days paused. One free team per person.</p>
${cloud.free.full() ? '<p class="err">Free is full right now: confirm your email and you are on the waitlist.</p>' : ''}
<form method="post" action="/free"><label>Work email<input type="email" name="email" required autocomplete="email"></label>
<label>Team name<input name="name" required maxlength="80"></label>
<label>Address (optional)<input name="slug" pattern="[a-z0-9](?:[a-z0-9-]{1,30})[a-z0-9]" placeholder="acme"><span class="muted">https://<i>address</i>.${esc(cfg.domain)} — made from the name if empty</span></label>
${ts ? `<div class="cf-turnstile" data-sitekey="${esc(ts)}"></div>` : ''}<button>Start free</button></form>
<p class="muted">Need more people or storage? <a href="/signup">Team and Business</a>. Already have a team? <a href="/login">Sign in</a></p>`, { turnstile: !!ts })
    }
    if (p === '/free' && m === 'POST') {
      const b = await form(req)
      try {
        freeLimits(r)
        await cloud.free.requestSignup({ email: b.email, name: b.name, slug: b.slug, ip: r.ip, turnstile: b['cf-turnstile-response'] })
      } catch (e) { if (e instanceof CloudError) return new Response(page('Start free', `<h1>Start free</h1><p class="err">${esc(e.message)}</p><p><a href="/free">Back</a></p>`).body, { status: e.status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }); throw e }
      return page('Check your email', `<h1>Check your email</h1><p>We sent a confirmation link to <b>${esc(b.email)}</b>. It works once, for ${Math.round(cfg.free.verifyTtlMs / 3600_000)} hours.</p>`)
    }
    if (p === '/free/verify' && m === 'GET') {
      return page('Confirm your email', `<h1>Confirm your email</h1><p>Your free Trina Drive starts when you confirm.</p><form method="post" action="/free/verify"><input type="hidden" name="token" value="${esc(url.searchParams.get('token') ?? '')}"><button>Confirm and start</button></form>`)
    }
    if (p === '/free/verify' && m === 'POST') {
      limited(r, 'verify', 30, 3600_000)
      const b = await form(req)
      try {
        const v = await cloud.free.verify(b.token)
        if (v.status === 'waitlisted') return page('Waitlist', `<h1>You are on the waitlist</h1><p>Free is full right now. We will write as soon as there is room. Can't wait? <a href="/signup">The Team plan</a> starts right away.</p>`)
        if (v.status === 'exists') return page('You already have one', `<h1>You already have a free team</h1><p>There is one free workspace per person: <a href="${esc(v.url)}/">${esc(v.url)}</a>. To grow it, <a href="/login">sign in</a> and upgrade.</p>`)
        return page('Starting', `<h1>Your Trina Drive is starting</h1><p><code>${esc(v.url)}</code></p><p>The setup link arrives by email in a minute or two (a little longer if a new server has to start). Later, <a href="/login">sign in with an email link</a> to upgrade or wake it.</p>`)
      } catch (e) { if (e instanceof CloudError) return page('Confirm your email', `<h1>That link did not work</h1><p class="err">${esc(e.message)}</p><p><a href="/free">Start again</a></p>`); throw e }
    }
    const wakePage = /^\/wake\/([a-z0-9-]{1,40})$/.exec(p)
    if (wakePage) {
      const t = teamBySlug(cloud.db, wakePage[1]!)
      if (m === 'POST') {
        limited(r, 'wake', 20, 3600_000)
        if (t && !rl.hit(`wake-team:${t.id}`, 12, 3600_000)) throw new CloudError('rate_limited', 'this workspace was woken many times this hour; try again later', 429)
        if (t) cloud.free.requestWake(t, `web:${r.ip}`)
      }
      const st = cloud.free.wakeState(t)
      if (st === 'starting') return page('Waking up', `<h1>Waking up ${esc(t!.slug)}</h1><p id="wake" data-slug="${esc(t!.slug)}">Starting…</p><p class="muted">Usually a few seconds. This page opens the workspace when it is ready.</p>`, { wake: true })
      if (st === 'running') return page('Running', `<h1>${esc(t!.slug)} is running</h1><p><a class="btn" href="${esc(cloud.url(t!))}/">Open it</a></p>`)
      if (st === 'paused') return page('Paused', `<h1>${esc(t!.slug)} is paused</h1><p>This free workspace was paused after ${Math.round(cfg.free.idlePauseMs / 86400_000)} days without activity. Nothing has been deleted.</p>
<form method="post" action="/wake/${esc(t!.slug)}"><button>Wake up</button></form><p class="muted">It starts in a few seconds. If nobody uses it, it pauses again.</p>`)
      return new Response(page('Unavailable', `<h1>This workspace is not available</h1><p>It may be paused by its owner's subscription. If you run it, <a href="/login">sign in</a> to see why.</p>`).body, { status: 404, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
    }
    if (p === '/dashboard' && m === 'GET') {
      if (!s) return redirect('/login')
      const teams = cloud.teamsOf(s.userId)
      const pc = cfg.paddle
      return page('Dashboard', `<h1>Your teams</h1>${url.searchParams.get('paid') ? '<p>Thanks! Your workspace is starting; the setup link arrives by email in a minute or two.</p>' : ''}
${s.verified ? '' : '<p class="err">Confirm your email address first (check your inbox).</p>'}
${teams.map((t) => teamCard(t, s.csrf)).join('') || '<p class="muted">No team yet.</p>'}
<div class="card"><h2>New team</h2><form method="post" action="/teams"><input type="hidden" name="csrf" value="${esc(s.csrf)}">
<label>Company or team name<input name="name" required maxlength="80"></label>
<label>Address<input name="slug" required pattern="[a-z0-9](?:[a-z0-9-]{1,30})[a-z0-9]" placeholder="acme"><span class="muted">https://<i>address</i>.${esc(cfg.domain)}</span></label>
<label>Plan<select name="plan"><option value="team">Team</option><option value="business">Business</option></select></label><button>Create</button></form>
<p class="muted">Or <a href="/free">start a free team</a> (one per person).</p></div>
<form method="post" action="/logout"><input type="hidden" name="csrf" value="${esc(s.csrf)}"><button class="plain">Sign out (${esc(s.email)})</button></form>
<div id="paddle-config" data-env="${esc(pc.env)}" data-token="${esc(pc.clientToken)}" data-email="${esc(s.email)}" data-success="${esc(cfg.controlUrl)}/dashboard?paid=1" hidden></div>`, { paddle: !!pc.clientToken })
    }
    if (p === '/teams' && m === 'POST') {
      const u = signedIn(); const b = await form(req); csrfOk(b)
      try { await cloud.createTeam(u.userId, b.name, b.slug || suggestSlug(b.name ?? ''), b.plan) } catch (e) {
        if (e instanceof CloudError) return page('New team', `<h1>New team</h1><p class="err">${esc(e.message)}</p><p><a href="/dashboard">Back</a></p>`)
        throw e
      }
      return redirect('/dashboard')
    }
    const wakeOwn = /^\/teams\/(team_[0-9a-f]{20})\/wake$/.exec(p)
    if (wakeOwn && m === 'POST') {
      const u = signedIn(); const b = await form(req); csrfOk(b)
      const t = teamByPublicId(cloud.db, wakeOwn[1]!)
      if (!t || t.owner_user_id !== u.userId) throw new CloudError('not_found', 'not found', 404)
      cloud.free.requestWake(t, `user:${u.userId}`)
      return redirect(`/wake/${t.slug}`)
    }
    const resend = /^\/teams\/(team_[0-9a-f]{20})\/resend-setup$/.exec(p)
    if (resend && m === 'POST') {
      const u = signedIn(); const b = await form(req); csrfOk(b)
      limited(r, 'resend', 5, 3600_000)
      const t = teamByPublicId(cloud.db, resend[1]!)
      if (!t || t.owner_user_id !== u.userId) throw new CloudError('not_found', 'not found', 404)
      try { await cloud.resendSetup(t, `user:${u.userId}`) } catch (e) { if (e instanceof CloudError) return page('Setup link', `<p class="err">${esc(e.message)}</p><p><a href="/dashboard">Back</a></p>`); throw e }
      return page('Setup link', `<p>A new setup link is on its way to your inbox. The old one no longer works.</p><p><a href="/dashboard">Back</a></p>`)
    }
    throw new CloudError('not_found', 'not found', 404)
  }

  async function paddleWebhook(r: Req): Promise<Response> {
    const pc = cfg.paddle
    if (pc.checkIp && !PADDLE_IPS[pc.env].includes(r.ip)) { cloud.log(`paddle webhook from ${r.ip} refused (not a Paddle address)`); return new Response('forbidden', { status: 403 }) }
    const raw = await r.req.text()
    if (raw.length > 1024 * 1024) return new Response('too large', { status: 413 })
    const v = verifyPaddle({ rawBody: raw, header: r.req.headers.get('paddle-signature'), secret: pc.webhookSecret, toleranceSec: pc.toleranceSec })
    if (!v.ok) { cloud.log(`paddle webhook signature rejected: ${v.reason}`); return new Response('invalid signature', { status: 401 }) }
    let e: PaddleEvent
    try { e = JSON.parse(raw) } catch { return new Response('bad json', { status: 400 }) }
    if (!e?.event_id || !e?.event_type || !e.occurred_at) return new Response('bad event', { status: 400 })
    const sum = summarize(e)
    const fresh = cloud.db.query('INSERT OR IGNORE INTO paddle_events (event_id, event_type, occurred_at, received_at, subscription_id, outcome) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sum.eventId, sum.type, sum.occurredAt, now(), sum.subscriptionId, 'received').changes === 1
    if (!fresh) return new Response('duplicate', { status: 200 })
    const outcome = cloud.applyPaddle(sum)
    cloud.db.query('UPDATE paddle_events SET outcome = ? WHERE event_id = ?').run(outcome, sum.eventId)
    cloud.log(`paddle ${sum.type} ${sum.subscriptionId ?? ''} → ${outcome}`)
    return new Response('ok', { status: 200 })
  }

  return async function handle(req: Request, peer: string | undefined): Promise<Response> {
    const url = new URL(req.url)
    const r: Req = { req, url, ip: clientIp(req, peer), cookie: readSessionCookie(req) }
    let res: Response
    try { res = await route(r) } catch (e) {
      const wantsJson = url.pathname.startsWith('/api/') || (req.headers.get('accept') ?? '').includes('application/json')
      if (e instanceof CloudError) res = wantsJson ? json({ error: e.code, message: e.message }, e.status) : page('Error', `<p class="err">${esc(e.message)}</p><p><a href="/">Home</a></p>`)
      else { cloud.log(`${req.method} ${url.pathname} failed: ${(e as Error).stack ?? e}`); res = json({ error: 'internal' }, 500) }
      if (e instanceof CloudError && !wantsJson) res = new Response(res.body, { status: e.status, headers: res.headers })
    }
    for (const [k, v] of Object.entries(HEADERS)) if (!res.headers.has(k)) res.headers.set(k, v)
    return res
  }
}

export function publicTeam(cloud: Cloud, t: TeamRow) {
  return { id: t.public_id, slug: t.slug, name: t.name, plan: t.plan, status: t.status, url: cloud.url(t), mcp: `${cloud.url(t)}/mcp`, grace_until: t.grace_until ? iso(t.grace_until) : null,
    ...(t.plan === 'free' ? { paused: cloud.free.isPaused(t), last_activity: t.last_activity_at ? iso(t.last_activity_at) : null } : {}) }
}

export function metrics(cloud: Cloud): string {
  const lines = ['# HELP tdcloud_teams Teams by status', '# TYPE tdcloud_teams gauge']
  for (const r of cloud.db.query<{ status: string; n: number }, []>('SELECT status, count(*) AS n FROM teams GROUP BY status').all()) lines.push(`tdcloud_teams{status="${r.status}"} ${r.n}`)
  lines.push('# HELP tdcloud_team_disk_bytes Disk used by a team volume', '# TYPE tdcloud_team_disk_bytes gauge')
  for (const t of cloud.db.query<{ slug: string; disk_bytes: number | null; plan: string }, []>("SELECT slug, disk_bytes, plan FROM teams WHERE status IN ('active', 'past_due') AND disk_bytes IS NOT NULL").all()) lines.push(`tdcloud_team_disk_bytes{team="${t.slug}",plan="${t.plan}"} ${t.disk_bytes}`)
  lines.push('# HELP tdcloud_jobs_pending Jobs waiting', '# TYPE tdcloud_jobs_pending gauge', `tdcloud_jobs_pending ${cloud.db.query<{ n: number }, []>('SELECT count(*) AS n FROM jobs WHERE done_at IS NULL').get()!.n}`)
  lines.push('# HELP tdcloud_jobs_failed_total Jobs that gave up', '# TYPE tdcloud_jobs_failed_total counter', `tdcloud_jobs_failed_total ${cloud.db.query<{ n: number }, []>('SELECT count(*) AS n FROM jobs WHERE done_at IS NOT NULL AND last_error IS NOT NULL AND attempts >= 5').get()!.n}`)
  if (cloud.scaler) {
    const hosts = cloud.scaler.view()
    lines.push('# HELP tdcloud_hosts Team hosts by state', '# TYPE tdcloud_hosts gauge')
    for (const st of ['booting', 'ready', 'draining', 'terminating', 'lost']) lines.push(`tdcloud_hosts{state="${st}"} ${hosts.filter((h) => h.state === st).length}`)
    lines.push('# HELP tdcloud_host_slots_free Free slots on ready hosts', '# TYPE tdcloud_host_slots_free gauge', `tdcloud_host_slots_free ${hosts.filter((h) => h.state === 'ready').reduce((a, h) => a + h.free, 0)}`)
    lines.push('# HELP tdcloud_teams_waiting_for_host Paid teams with no host yet', '# TYPE tdcloud_teams_waiting_for_host gauge', `tdcloud_teams_waiting_for_host ${cloud.scaler.waiting().length}`)
  }
  const fs = cloud.free.stats()
  lines.push('# HELP tdcloud_free_teams Free teams by state (and the waitlist)', '# TYPE tdcloud_free_teams gauge')
  for (const [k, v] of [['active', fs.active], ['paused', fs.paused], ['provisioning', fs.provisioning], ['waitlist', fs.waitlist]] as const) lines.push(`tdcloud_free_teams{state="${k}"} ${v}`)
  lines.push('# HELP tdcloud_free_teams_cap TDCLOUD_MAX_FREE_TEAMS', '# TYPE tdcloud_free_teams_cap gauge', `tdcloud_free_teams_cap ${fs.cap}`)
  lines.push('# HELP tdcloud_last_backup_age_seconds Age of each team\'s newest backup', '# TYPE tdcloud_last_backup_age_seconds gauge')
  for (const t of cloud.db.query<{ slug: string; last_backup_at: number | null }, []>("SELECT slug, last_backup_at FROM teams WHERE status IN ('active', 'past_due')").all()) lines.push(`tdcloud_last_backup_age_seconds{team="${t.slug}"} ${t.last_backup_at ? Math.round((now() - t.last_backup_at) / 1000) : -1}`)
  return lines.join('\n') + '\n'
}
