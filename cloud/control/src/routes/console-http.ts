// The console's session cookie, security headers and Origin rule (W0 moved them here from web.ts; workstream D1 owns
// them). web.ts and the route registry (./index.ts) use these.
//
// Review #10: cloud.trina.app shares its site (trina.app) with *.cloud.trina.app team drives, drive.trina.app and
// console.trina.app (another product). So:
//   - the session cookie is __Host-tdcloud_session (Secure, Path=/, no Domain: no other host of the site can set or
//     overwrite it); a plain `tdcloud_session` cookie is ignored on https (only an http dev console uses it);
//   - every request that is not GET/HEAD must come from the console's own pages (Origin), and changes also carry the
//     session's CSRF token (web.ts / RouteCtx.csrfOk).
// Review #9: the SSO form_post goes to https://<slug>.<domain>/api/sso/callback, so the CSP of that one page allows
// form-action to the team hosts (ssoPostCsp); every other page keeps form-action 'self'.

export const SESSION_COOKIE = '__Host-tdcloud_session'
/** the cookie name an http (dev) console uses: browsers refuse __Host- cookies without Secure */
export const PLAIN_SESSION_COOKIE = 'tdcloud_session'

const CSP_PARTS = [
  "default-src 'self'", "script-src 'self' https://cdn.paddle.com https://challenges.cloudflare.com", "style-src 'self' 'unsafe-inline' https://cdn.paddle.com https://sandbox-cdn.paddle.com",
  "img-src 'self' data: https://cdn.paddle.com https://sandbox-cdn.paddle.com", "font-src 'self'", "frame-src https://buy.paddle.com https://sandbox-buy.paddle.com https://challenges.cloudflare.com",
  "connect-src 'self' https://api.paddle.com https://sandbox-api.paddle.com", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
]
export const CSP = CSP_PARTS.join('; ')

/** The CSP of the SSO hand-off page: it may post to the team drives (https://*.<domain>[:port]) and nowhere else. */
export function ssoPostCsp(teamOrigin: string): string {
  const u = new URL(teamOrigin)
  const host = u.hostname.split('.').slice(1).join('.')
  const src = `https://*.${host}${u.port ? `:${u.port}` : ''}`
  return CSP_PARTS.map((p) => (p === "form-action 'self'" ? `form-action 'self' ${src}` : p)).join('; ')
}

export const HEADERS: Record<string, string> = {
  'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
  'strict-transport-security': 'max-age=31536000; includeSubDomains', 'cross-origin-opener-policy': 'same-origin-allow-popups',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(self "https://buy.paddle.com" "https://sandbox-buy.paddle.com")',
}

function cookies(req: Request): Map<string, string> {
  const out = new Map<string, string>()
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=')
    // the first of a name wins (browsers send the most specific path first; __Host- has only one)
    if (i > 0) { const k = part.slice(0, i).trim(); if (!out.has(k)) out.set(k, part.slice(i + 1).trim()) }
  }
  return out
}

/**
 * The console session cookie's value in this request: the __Host- cookie, or — tagged `plain:` — the unprefixed dev
 * cookie, which Cloud.session accepts only when the console itself is not on https.
 */
export function readSessionCookie(req: Request): string | undefined {
  const c = cookies(req)
  const host = c.get(SESSION_COOKIE)
  if (host) return host
  const plain = c.get(PLAIN_SESSION_COOKIE)
  return plain ? `plain:${plain}` : undefined
}

/** Set-Cookie for the console session (maxAge 0 = sign out). secure: the console is served over https. */
export const sessionCookie = (v: string, maxAge: number, secure: boolean) =>
  secure
    ? `${SESSION_COOKIE}=${v}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`
    : `${PLAIN_SESSION_COOKIE}=${v}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`

/** A browser request from the console's own pages (or no browser headers at all: curl, the landing page's server). */
export function sameOrigin(req: Request, controlOrigin: string): boolean {
  const o = req.headers.get('origin')
  if (o) return o === controlOrigin
  const site = req.headers.get('sec-fetch-site')
  return !site || site === 'same-origin' || site === 'none'
}

/** true = refuse this request as cross-site (web.ts answers 403 bad_origin): every method but GET/HEAD (review #10).
 * The Paddle webhook is exempt; so are registered routes marked crossOrigin (web.ts checks that). */
export function originRefused(req: Request, path: string, controlOrigin: string): boolean {
  return req.method !== 'GET' && req.method !== 'HEAD' && !path.startsWith('/paddle/') && !sameOrigin(req, controlOrigin)
}
