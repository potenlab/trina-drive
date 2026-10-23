// One Bun server: /mcp and /health (Bearer tokens only, src/mcp.ts — the session cookie is scoped to /api and is never
// read there), /oauth/* and /.well-known/* (the OAuth authorization server, src/oauth, when a public address is set),
// /api (sessions, src/web/api.ts; /api/oauth/* is the consent decision), and the built web app (web/dist) for
// everything else. Security headers on every response. The public listener (public.ts) serves a subset of this.
import { LIMITS, NAME } from '../config'
import fs from 'node:fs'
import path from 'node:path'
import { handleRequest } from '../mcp'
import type { Ctx } from '../session'
import { handleApi } from './api'
import { McpLimiter } from '../ratelimit'
import { RateLimiter } from './auth'
import type { WebCtx, WebOptions } from './http'
import { OutboxMailer } from './mail'
import { forwardedClient } from './proxy'
import { hostedGate } from './hosted'
import { ensureWebSchema } from './schema'
import { handleConsentApi, handleOAuth, isOAuthPath, makeOAuthRuntime, mcpOAuth } from '../oauth'
import { oauthOptionsFromSettings, readPublicSettings } from '../oauth/settings'

export const DEFAULT_WEB_DIR = path.join(import.meta.dir, '..', '..', 'web', 'dist')

export const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; " +
    "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
}

export function makeWebCtx(ctx: Ctx, opts: WebOptions = {}): WebCtx {
  ensureWebSchema(ctx.db)
  return {
    ...ctx, opts,
    // links handed to agents (approval pages) use the public address
    publicUrl: opts.publicUrl ?? ctx.publicUrl,
    mailer: opts.mailer ?? new OutboxMailer(ctx.dataDir),
    // in SQLite: a restart does not reset them
    loginByName: new RateLimiter(5, 15 * 60_000, { db: ctx.db, scope: 'login_name' }),
    loginByAddr: new RateLimiter(50, 15 * 60_000, { db: ctx.db, scope: 'login_addr' }),
    linkByAddr: new RateLimiter(30, 15 * 60_000, { db: ctx.db, scope: 'link_addr' }),
    mcpLimiter: opts.mcpLimiter ?? new McpLimiter(),
    oauth: oauthRuntime(ctx, opts),
  }
}

function oauthRuntime(ctx: Ctx, opts: WebOptions) {
  const o = opts.oauth === undefined ? oauthOptionsFromSettings(readPublicSettings(ctx.db)) : opts.oauth
  return o ? makeOAuthRuntime(o, ctx.db) : null
}

function withHeaders(res: Response): Response {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!res.headers.has(k)) res.headers.set(k, v)
  return res
}

function serveStatic(w: WebCtx, req: Request): Response {
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } })
  const dir = w.opts.webDir ?? DEFAULT_WEB_DIR
  const index = path.join(dir, 'index.html')
  if (!fs.existsSync(index)) return new Response('The web app is not built. Run: bun run build:web\n', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } })
  let rel: string
  try { rel = decodeURIComponent(new URL(req.url).pathname) } catch { return new Response('bad path', { status: 400 }) }
  const file = path.resolve(dir, '.' + rel)
  if ((file === dir || file.startsWith(dir + path.sep)) && rel !== '/' && fs.existsSync(file) && fs.statSync(file).isFile()) {
    const immutable = rel.startsWith('/assets/')
    return new Response(Bun.file(file), { headers: { 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' } })
  }
  // the app routes with #fragments, so any other path is the app itself
  return new Response(Bun.file(index), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } })
}

export async function handleWeb(w: WebCtx, req: Request, addr?: string): Promise<Response> {
  const { pathname } = new URL(req.url)
  if (pathname === '/mcp' || pathname === '/health') return withHeaders(await handleRequest(w, req, { allowedOrigins: w.opts.allowedOrigins, onRequest: w.opts.onRequest, limiter: w.mcpLimiter, oauth: w.oauth ? mcpOAuth(w.oauth, w.db) : undefined }, addr))
  if (isOAuthPath(pathname)) return withHeaders(w.oauth ? await handleOAuth(w.oauth, w.db, req, addr ?? 'unknown') : Response.json({ error: 'not_found' }, { status: 404 }))
  // hosted: an admin without a second factor reaches only enrolment (hosted.ts)
  const gate = pathname === '/api' || pathname.startsWith('/api/') ? hostedGate(w, req, pathname) : null
  if (gate) return withHeaders(gate)
  if (pathname.startsWith('/api/oauth/')) return withHeaders(await handleConsentApi(w, w.oauth, req))
  if (pathname === '/api' || pathname.startsWith('/api/')) return withHeaders(await handleApi(w, req, addr))
  return withHeaders(serveStatic(w, req))
}

export function serveWeb(ctx: Ctx, port: number, hostname = '127.0.0.1', opts: WebOptions = {}) {
  const w = makeWebCtx(ctx, opts)
  const server = Bun.serve({
    port, hostname,
    // never Bun's development error page (it shows source and stack traces to the caller)
    development: false,
    // bodies without a Content-Length are cut here too
    maxRequestBodySize: LIMITS.requestBytes,
    fetch: async (req, srv) => {
      try { return await handleWeb(w, req, forwardedClient(req, srv.requestIP(req)?.address, w.opts.trustedProxy)) } catch (e) {
        console.error(`[${NAME}] request failed:`, e)
        return Response.json({ error: 'internal error' }, { status: 500 })
      }
    },
  })
  return { server, w }
}
