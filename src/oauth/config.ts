// OAuth runtime settings. The issuer is the public HTTPS address (plan 5.2 "공개 주소"); the protected resource is
// <issuer>/mcp. Both are fixed by `public enable --url` and kept in the meta table: changing the address later makes
// every OAuth token issued for the old one stop working (RFC 8707 audience), which `public enable` warns about.
import type { DB } from '../db'
import { RateLimiter } from '../ratelimit'
import { DEFAULT_GUARD, type FetchGuard } from './ssrf'

/** Scopes this server understands. The consent page decides the actual folders and read-only; a client that does not
 * ask for drafts:write cannot be given write. */
export const SCOPES = ['files:read', 'drafts:write'] as const
/** Hosts whose Client ID Metadata Documents are accepted by default (review-tech 4.1): claude.ai (also hosts Claude
 * Code's) and chatgpt.com. Others need `public enable --client-host H` or `--any-client`. */
export const DEFAULT_CLIENT_HOSTS = ['claude.ai', 'chatgpt.com']

export interface OAuthOptions {
  /** https://files.example.com (no trailing slash) */
  issuer: string
  /** default <issuer>/mcp */
  resource?: string
  /** SSRF guard for metadata documents (tests inject a resolver and allow a local fixture) */
  guard?: Partial<FetchGuard>
  /** CIMD hosts accepted, or 'any' */
  clientHosts?: string[] | 'any'
  /** open dynamic client registration (RFC 7591), off by default (deprecated in MCP 2026-07-28; consent phishing) */
  dcr?: boolean
  accessTtlMs?: number
  /** a refresh token presented again this soon after it was rotated is refused without revoking the grant (two
   * refreshes racing in one client); later, reuse revokes the whole grant */
  refreshGraceMs?: number
  now?: () => number
}

export interface OAuthRuntime {
  issuer: string
  resource: string
  /** RFC 9728 document for the resource (path-specific form, /mcp) */
  prmUrl: string
  guard: FetchGuard
  clientHosts: string[] | 'any'
  dcr: boolean
  accessTtlMs: number
  refreshGraceMs: number
  now: () => number
  limits: { authorize: RateLimiter; token: RateLimiter; register: RateLimiter; cimdHost: RateLimiter }
}

export const ACCESS_TTL_MS = 3600_000
export const CODE_TTL_MS = 60_000
export const REQUEST_TTL_MS = 10 * 60_000
export const GRANT_TTLS = { '1d': 86400_000, '7d': 7 * 86400_000, '30d': 30 * 86400_000, '90d': 90 * 86400_000 } as const
export type GrantTtl = keyof typeof GRANT_TTLS
export const MAX_DCR_CLIENTS = 500

/** Lower-case scheme and host, no trailing slash, no fragment or query (RFC 8707 resource / RFC 8414 issuer). */
export function canonicalUrl(raw: string): string | null {
  let u: URL
  try { u = new URL(raw) } catch { return null }
  if (u.hash || u.search || u.username || u.password) return null
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  // the URL parser already lower-cases scheme and host and drops a default port
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`
}

export function makeOAuthRuntime(o: OAuthOptions, db?: DB): OAuthRuntime {
  const issuer = canonicalUrl(o.issuer)
  if (!issuer) throw new Error(`bad issuer URL: ${o.issuer}`)
  const resource = canonicalUrl(o.resource ?? `${issuer}/mcp`)!
  const now = o.now ?? Date.now
  const path = new URL(resource).pathname
  return {
    issuer, resource, prmUrl: `${issuer}/.well-known/oauth-protected-resource${path === '/' ? '' : path}`,
    guard: { ...DEFAULT_GUARD, ...o.guard }, clientHosts: o.clientHosts ?? DEFAULT_CLIENT_HOSTS, dcr: !!o.dcr,
    accessTtlMs: o.accessTtlMs ?? ACCESS_TTL_MS, refreshGraceMs: o.refreshGraceMs ?? 10_000, now,
    limits: {
      authorize: new RateLimiter(60, 60_000, { now }),
      token: new RateLimiter(120, 60_000, { now }),
      // kept in SQLite: a restart does not hand out a fresh registration budget
      register: new RateLimiter(10, 3600_000, { db, scope: 'oauth_register', now }),
      cimdHost: new RateLimiter(30, 60_000, { now }),
    },
  }
}
