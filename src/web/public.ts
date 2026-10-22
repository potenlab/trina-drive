// The public listener (plan 5.2 "공개 주소", 7.1 "공개 노출", review-tech 4.3): a SEPARATE Bun listener meant for a
// Cloudflare tunnel (cloudflared → http://127.0.0.1:<port>), so "came through the tunnel" never has to be guessed from
// a peer address or a Host header. It serves only what claude.ai / ChatGPT and a person approving a connection need:
//   /mcp · /oauth/* · /.well-known/oauth-* · the sign-in and consent pages (the app shell and its /assets) · the few
//   /api calls those pages make (state, login, logout, session, oauth consent)
// Everything else — the admin screens' API, files, drafts, audit, /health — is 404 here. Requests are rebuilt on the
// configured public URL (https), so the same-origin checks and Secure cookies of /api work behind the tunnel.
// CF-Connecting-IP / X-Forwarded-For are believed only when the peer is the configured tunnel connector address.
//
// It starts only when the public gate passes: an HTTPS public URL, an admin who can sign in, admin 2FA (requireAdmin2FA,
// a TODO hook until the web records second factors) and the v0.2 security gate confirmed (plan 10: "통과 전에는 공개
// 주소를 열지 않는다").
import net from 'node:net'
import { LIMITS, NAME, VERSION } from '../config'
import type { DB } from '../db'
import { readPublicSettings, type PublicSettings } from '../oauth/settings'
import { setupDone } from './auth'
import type { WebCtx } from './http'
import { handleWeb } from './server'

/** Exact paths (any method the handler accepts) and prefixes the public listener passes on. */
export const PUBLIC_EXACT = new Set([
  '/mcp',
  '/', '/index.html', '/favicon.ico',
  '/oauth/authorize', '/oauth/token', '/oauth/revoke', '/oauth/register',
  '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server',
])
/** /api calls of the sign-in and consent pages. (Passkey sign-in endpoints, when they land, are added here.) */
export const PUBLIC_API = new Set(['GET /api/state', 'POST /api/login', 'POST /api/logout', 'GET /api/session'])
export const PUBLIC_PREFIXES = ['/assets/', '/api/oauth/requests/']

export function publicPathAllowed(method: string, pathname: string): boolean {
  if (PUBLIC_EXACT.has(pathname)) return true
  if (pathname.startsWith('/api/')) return PUBLIC_API.has(`${method} ${pathname}`) || pathname.startsWith('/api/oauth/requests/')
  return PUBLIC_PREFIXES.some((p) => pathname.startsWith(p)) && !pathname.includes('..')
}

/**
 * TODO(admin-2fa): replace with the web's own record once passkeys / TOTP for admins land (parallel stream): true when
 * every active admin has a second factor. Until then the operator confirms it (`public enable --confirm-admin-2fa`).
 */
export function requireAdmin2FA(db: DB): boolean {
  return readPublicSettings(db).admin2faConfirmedAt != null
}

export interface GateCheck { id: string; ok: boolean; required: boolean; text: string }

const isLoopbackHost = (h: string) => h === 'localhost' || h === '::1' || h === '[::1]' || /^127\./.test(h)

/** The public address check: https, a real host name, no path, query or fragment. */
export function publicUrlProblem(raw: string | null): string | null {
  if (!raw) return 'no public URL (public enable --url https://…)'
  let u: URL
  try { u = new URL(raw) } catch { return 'not a URL' }
  if (u.protocol !== 'https:') return 'the public URL must be https (the tunnel terminates TLS)'
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) return 'the public URL is an origin only (no path, query or fragment)'
  const h = u.hostname.replace(/^\[|\]$/g, '')
  if (net.isIP(h) || isLoopbackHost(h) || !h.includes('.')) return 'the public URL needs a public host name (not an IP address or localhost)'
  return null
}

export function publicGate(db: DB, s: PublicSettings = readPublicSettings(db)): { ok: boolean; checks: GateCheck[] } {
  const urlProblem = publicUrlProblem(s.url)
  const checks: GateCheck[] = [
    { id: 'enabled', ok: s.enabled, required: true, text: 'public listener enabled (public enable)' },
    { id: 'https_url', ok: !urlProblem, required: true, text: urlProblem ? `public URL: ${urlProblem}` : `public URL ${s.url} (OAuth issuer; MCP resource ${s.url}/mcp)` },
    { id: 'admin', ok: setupDone(db), required: true, text: 'an admin can sign in on the web' },
    { id: 'admin_2fa', ok: requireAdmin2FA(db), required: true, text: 'admins use a second factor (until the web records it: public enable --confirm-admin-2fa)' },
    { id: 'security_gate', ok: s.gateConfirmedAt != null, required: true,
      text: s.gateConfirmedAt != null ? `v0.2 security gate confirmed ${new Date(s.gateConfirmedAt).toISOString().slice(0, 10)}${s.gateVersion ? ` for ${s.gateVersion}` : ''}` : 'v0.2 security gate passed (plan 10; public enable --confirm-security-gate)' },
    { id: 'loopback_listener', ok: isLoopbackHost(s.host), required: false, text: `public listener on ${s.host}:${s.port} (loopback recommended: the tunnel connector runs on this machine)` },
    { id: 'trusted_proxy', ok: !!s.trustedProxy, required: false, text: s.trustedProxy ? `client addresses taken from CF-Connecting-IP when the peer is ${s.trustedProxy}` : 'no --trusted-proxy: every request counts as the tunnel connector\'s address (sign-in rate limits per address become one shared limit)' },
  ]
  return { ok: checks.every((c) => c.ok || !c.required), checks }
}

/** The v0.2 security gate (plan 10, 7.4) — what `--confirm-security-gate` asserts. */
export const SECURITY_GATE_CHECKLIST = [
  'permission matrix widened to OAuth, the tunnel and the approval inbox passes (bun test, test/security)',
  'CIMD SSRF and consent-screen tests pass (test/oauth-cimd.test.ts, test/oauth.test.ts)',
  'public listener exposes only its allowlist (test/public-listener.test.ts)',
  'external review (2–3 days) done and findings fixed',
  'SECURITY.md and a private advisory channel exist',
]

/** The client's address: the peer, or what the tunnel connector says when the peer IS the configured connector. */
export function clientAddress(req: Request, peer: string | undefined, trustedProxy: string | null): string {
  const p = peer ?? 'unknown'
  if (!trustedProxy || p !== trustedProxy) return p
  const cf = req.headers.get('cf-connecting-ip')?.trim()
  if (cf && net.isIP(cf)) return cf
  const xff = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  return xff && net.isIP(xff) ? xff : p
}

const HSTS = 'max-age=31536000'
const notFound = () => new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'strict-transport-security': HSTS } })

export async function handlePublic(w: WebCtx, req: Request, peer: string | undefined, cfg: { url: string; trustedProxy: string | null }): Promise<Response> {
  const inUrl = new URL(req.url)
  if (!publicPathAllowed(req.method, inUrl.pathname)) return notFound()
  const addr = clientAddress(req, peer, cfg.trustedProxy)
  // seen from here the request is http://127.0.0.1:<port>/…; the browser and the OAuth client used the public https URL
  const rebuilt = new Request(cfg.url.replace(/\/$/, '') + inUrl.pathname + inUrl.search, req)
  let res = await handleWeb(w, rebuilt, addr)
  if (req.method === 'GET' && inUrl.pathname === '/api/state' && res.ok) {
    // the app shows only sign-in and consent on this address
    const body = await res.json() as Record<string, unknown>
    res = new Response(JSON.stringify({ ...body, public_listener: true }), { status: 200, headers: res.headers })
  }
  res.headers.set('strict-transport-security', HSTS)
  return res
}

/** Start the public listener if the gate passes; otherwise say why (and start nothing). */
export function startPublicListener(w: WebCtx, s: PublicSettings = readPublicSettings(w.db)): { server: ReturnType<typeof Bun.serve> | null; gate: ReturnType<typeof publicGate> } {
  const gate = publicGate(w.db, s)
  if (!gate.ok || !s.url || !w.oauth) return { server: null, gate }
  const cfg = { url: s.url, trustedProxy: s.trustedProxy }
  const server = Bun.serve({
    port: s.port, hostname: s.host, development: false, maxRequestBodySize: LIMITS.requestBytes,
    fetch: async (req, srv) => {
      try { return await handlePublic(w, req, srv.requestIP(req)?.address, cfg) } catch (e) {
        console.error(`[${NAME}] public request failed:`, e)
        return Response.json({ error: 'internal error' }, { status: 500 })
      }
    },
  })
  return { server, gate }
}

export const publicBanner = (s: PublicSettings, port: number) =>
  `${NAME} ${VERSION} public listener: http://${s.host}:${port}/ for the tunnel → ${s.url}  (MCP ${s.url}/mcp; only /mcp, /oauth, /.well-known, sign-in and consent)`
