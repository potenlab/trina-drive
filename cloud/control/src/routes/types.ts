// A control-plane HTTP route that a feature module contributes (W0 seams): web.ts asks the registry (index.ts) before
// its own pages, so a module adds pages and JSON endpoints — or takes over an existing path such as / or /dashboard —
// without editing web.ts. Everything a handler needs comes in RouteCtx.
import type { Cloud } from '../cloud'
import type { Config } from '../config'
import type { RateLimit } from '../web'

export type ControlSession = NonNullable<ReturnType<Cloud['session']>>

export interface RouteCtx {
  cloud: Cloud
  cfg: Config
  req: Request
  url: URL
  /** the client address (Caddy's X-Forwarded-For entry when the peer is a trusted proxy) */
  ip: string
  /** the path's capture groups (a RegExp path) or [path] */
  match: RegExpExecArray
  /** the console session cookie's session, if any */
  session: ControlSession | null
  /** the session, or 401 signed_out */
  signedIn: () => ControlSession
  /** the session's CSRF token in the form field `csrf` or the X-CSRF-Token header, or 403 bad_csrf */
  csrfOk: (body: Record<string, string>) => void
  /** the body as fields (JSON object or a form), at most 64 KiB */
  form: () => Promise<Record<string, string>>
  /** counted per client address under `key`; 429 when over */
  limited: (key: string, limit: number, windowMs: number) => void
  rateLimit: RateLimit
  json: (body: unknown, status?: number, headers?: Record<string, string>) => Response
  redirect: (to: string, headers?: Record<string, string>) => Response
}

export interface ControlRoute {
  /** 'GET', 'POST', … ('*' = any) */
  method: string
  /** an exact path, or a RegExp anchored by you (^…$) */
  path: string | RegExp
  /**
   * Requests that are not GET/HEAD must come from the console's own pages (Origin = TDCLOUD_CONTROL_URL, or no browser
   * headers at all); the registry checks it. true = skip (a Bearer-authenticated callback from a team instance).
   */
  crossOrigin?: boolean
  fn: (c: RouteCtx) => Promise<Response> | Response
}
