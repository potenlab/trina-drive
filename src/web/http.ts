import type { ServerOptions } from '../mcp'
// Shared bits of the web side: the context the handlers get, errors that map to HTTP statuses, JSON replies.
import type { Ctx } from '../session'
import type { RateLimiter } from './auth'
import type { Mailer } from './mail'

export interface WebOptions {
  /** extra origins allowed to call /api and /mcp (besides the server's own) */
  allowedOrigins?: string[]
  /** base URL used in mailed links (else the request's own origin) */
  publicUrl?: string
  /** directory with the built web app (index.html); default web/dist next to src */
  webDir?: string
  mailer?: Mailer
  /** called for each authenticated MCP request (connections, new-client alerts) */
  onRequest?: ServerOptions['onRequest']
}

export interface WebCtx extends Ctx {
  mailer: Mailer
  /** sign-in failures per login name and per client address */
  loginByName: RateLimiter
  loginByAddr: RateLimiter
  /** uses of one-time links and the setup token per client address */
  linkByAddr: RateLimiter
  opts: WebOptions
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message = code) { super(message) }
}
/** 404 for anything the caller may not know exists (never 403). */
export const notFound = () => new ApiError(404, 'not_found', 'not found')
export const forbidden = (what = 'not allowed') => new ApiError(403, 'forbidden', what)
export const bad = (code: string, message = code) => new ApiError(400, code, message)

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } })
