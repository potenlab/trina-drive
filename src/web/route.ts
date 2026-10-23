// One /api route: what api.ts dispatches. Kept apart from api.ts so feature modules (auth-routes.ts, src/share/http.ts,
// src/tdcloud/http.ts, …) define their own route lists and src/web/routes.ts collects them; api.ts imports that registry
// once. A module never edits api.ts to add a route (docs: research plan w0-seams-map).
import type { Actor } from '../rights'
import type { WebSession } from './auth'
import { notFound, type WebCtx } from './http'
import type { Op } from './ops'

export interface RouteOpts {
  /** the handler reads the body itself (uploads: multipart or bytes, with their own size limits; form posts) */
  raw?: boolean
  /**
   * The browser comes here from another origin on purpose (the SSO callback, a form_post from the Trina Cloud console):
   * the Origin check is skipped for this route. The handler must then prove the request itself (a state cookie, a
   * signature). No route sets this today.
   */
  crossOrigin?: boolean
}

export type Route = { method: string; re: RegExp; auth: boolean; fn: (c: Call) => Promise<Response | unknown> | Response | unknown; raw?: boolean; crossOrigin?: boolean }
export interface Call { w: WebCtx; req: Request; m: RegExpExecArray; body: Record<string, unknown>; s: WebSession | null; actor: Actor; op: Op; addr: string; url: URL }

/** R('GET', '/folders/:id', true, fn): `:name` matches one path segment, read with id(c, 'name') or c.m.groups. */
export const R = (method: string, path: string, auth: boolean, fn: Route['fn'], opts: boolean | RouteOpts = false): Route => {
  const o: RouteOpts = typeof opts === 'boolean' ? { raw: opts } : opts
  return { method, re: new RegExp('^/api' + path.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), auth, fn, raw: !!o.raw, ...(o.crossOrigin ? { crossOrigin: true } : {}) }
}

/** A positive integer path parameter (else 404). */
export const id = (c: Call, k = 'id') => { const v = Number(c.m.groups?.[k]); if (!Number.isSafeInteger(v) || v <= 0) throw notFound(); return v }
