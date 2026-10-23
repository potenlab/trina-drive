// The console's session cookie, security headers and Origin rule, moved unchanged from web.ts (W0 seams) so the console
// work (workstream D1: __Host- cookies, form-action for the SSO form_post, Origin on every changing method; plan 10.2
// #9, #10) changes this file and not web.ts. web.ts and the route registry (./index.ts) use these.

export const SESSION_COOKIE = 'tdcloud_session'

export const CSP = [
  "default-src 'self'", "script-src 'self' https://cdn.paddle.com https://challenges.cloudflare.com", "style-src 'self' 'unsafe-inline' https://cdn.paddle.com https://sandbox-cdn.paddle.com",
  "img-src 'self' data: https://cdn.paddle.com https://sandbox-cdn.paddle.com", "frame-src https://buy.paddle.com https://sandbox-buy.paddle.com https://challenges.cloudflare.com",
  "connect-src 'self' https://api.paddle.com https://sandbox-api.paddle.com", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ')
export const HEADERS: Record<string, string> = {
  'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
  'strict-transport-security': 'max-age=31536000; includeSubDomains', 'cross-origin-opener-policy': 'same-origin-allow-popups',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(self "https://buy.paddle.com" "https://sandbox-buy.paddle.com")',
}

/** The console session cookie's value in this request. */
export function readSessionCookie(req: Request): string | undefined {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === SESSION_COOKIE) return part.slice(i + 1).trim()
  }
  return undefined
}

/** Set-Cookie for the console session (maxAge 0 = sign out). secure: the console is served over https. */
export const sessionCookie = (v: string, maxAge: number, secure: boolean) => `${SESSION_COOKIE}=${v}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`

/** A browser request from the console's own pages (or no browser headers at all: curl, the landing page's server). */
export function sameOrigin(req: Request, controlOrigin: string): boolean {
  const o = req.headers.get('origin')
  if (o) return o === controlOrigin
  const site = req.headers.get('sec-fetch-site')
  return !site || site === 'same-origin' || site === 'none'
}

/** true = refuse this request as cross-site (web.ts answers 403 bad_origin). The Paddle webhook is exempt. */
export function originRefused(req: Request, path: string, controlOrigin: string): boolean {
  return req.method === 'POST' && !path.startsWith('/paddle/') && !sameOrigin(req, controlOrigin)
}
