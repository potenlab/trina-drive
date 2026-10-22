// One Bun server: /mcp and /health (Bearer tokens only, src/mcp.ts — the session cookie is scoped to /api and is never
// read there), /api (sessions, src/web/api.ts), and the built web app (web/dist) for everything else. Security headers
// on every response.
import fs from 'node:fs'
import path from 'node:path'
import { handleRequest } from '../mcp'
import type { Ctx } from '../session'
import { handleApi } from './api'
import { RateLimiter } from './auth'
import type { WebCtx, WebOptions } from './http'
import { OutboxMailer } from './mail'
import { ensureWebSchema } from './schema'

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
    mailer: opts.mailer ?? new OutboxMailer(ctx.dataDir),
    loginByName: new RateLimiter(5, 15 * 60_000),
    loginByAddr: new RateLimiter(50, 15 * 60_000),
    linkByAddr: new RateLimiter(30, 15 * 60_000),
  }
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
  if (pathname === '/mcp' || pathname === '/health') return withHeaders(await handleRequest(w, req, { allowedOrigins: w.opts.allowedOrigins }))
  if (pathname === '/api' || pathname.startsWith('/api/')) return withHeaders(await handleApi(w, req, addr))
  return withHeaders(serveStatic(w, req))
}

export function serveWeb(ctx: Ctx, port: number, hostname = '127.0.0.1', opts: WebOptions = {}) {
  const w = makeWebCtx(ctx, opts)
  const server = Bun.serve({ port, hostname, fetch: (req, srv) => handleWeb(w, req, srv.requestIP(req)?.address) })
  return { server, w }
}
