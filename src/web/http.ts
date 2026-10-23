import type { ServerOptions } from '../mcp'
import type { OAuthOptions, OAuthRuntime } from '../oauth/config'
import type { GoogleConfig } from '../gdrive/config'
import type { Fetch } from '../gdrive/google'
// Shared bits of the web side: the context the handlers get, errors that map to HTTP statuses, JSON replies.
import type { Ctx } from '../session'
import type { DriveEvent } from '../notify/events'
import type { McpLimiter } from '../ratelimit'
import type { RateLimiter } from './auth'
import type { Mailer } from './mail'
import type { TrustedProxies } from './proxy'

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
  /** /mcp rate and concurrency limits (default: MCP_LIMITS) */
  mcpLimiter?: McpLimiter
  /** the notify bus (src/notify): events whose channel payloads follow R11 */
  emit?: (e: DriveEvent) => void
  /** the OAuth authorization server (src/oauth): default from `public enable` (meta), null = off */
  oauth?: OAuthOptions | null
  /** reverse proxies whose forwarded client address is believed on the main listener (proxy.ts); default none */
  trustedProxy?: TrustedProxies | null
  /** hosted mode (hosted.ts): admins must enrol a second factor before anything else */
  hosted?: boolean
  /** Google Drive import (src/gdrive): default from GOOGLE_CLIENT_ID / _SECRET / GOOGLE_API_KEY, null = off */
  google?: GoogleConfig | null
  /** how the server reaches Google (tests: a mock) and the first retry delay after "slow down" */
  googleFetch?: Fetch
  googleRetryMs?: number
  /** WebDAV mount (src/dav): on in managed storage unless <PREFIX>_WEBDAV=off; false = off */
  webdav?: boolean
}

export interface WebCtx extends Ctx {
  mailer: Mailer
  /** sign-in failures per login name and per client address */
  loginByName: RateLimiter
  loginByAddr: RateLimiter
  /** uses of one-time links and the setup token per client address */
  linkByAddr: RateLimiter
  /** Trina Cloud sign-ins started (GET /api/sso/start) per client address: one office NAT carries the whole team */
  ssoByAddr: RateLimiter
  mcpLimiter: McpLimiter
  opts: WebOptions
  /** null when no public HTTPS address is configured */
  oauth: OAuthRuntime | null
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message = code, readonly headers?: Record<string, string>) { super(message) }
}
/** 429 with Retry-After (seconds). */
export const rateLimited = (retryAfterS: number, message = 'too many attempts; wait a few minutes') =>
  new ApiError(429, 'rate_limited', message, { 'retry-after': String(Math.max(1, Math.ceil(retryAfterS))) })
/** 404 for anything the caller may not know exists (never 403). */
export const notFound = () => new ApiError(404, 'not_found', 'not found')
export const forbidden = (what = 'not allowed') => new ApiError(403, 'forbidden', what)
export const bad = (code: string, message = code) => new ApiError(400, code, message)

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } })
