// OAuth clients: Client ID Metadata Documents (preferred; MCP 2025-11-25 / 2026-07-28 "Client Registration") and
// dynamic registration (RFC 7591, off unless enabled, deprecated in MCP 2026-07-28).
//
// CIMD: the client_id is an https URL with a path; the server fetches it under the SSRF guard (ssrf.ts), requires
// client_id in the document to equal the URL exactly, client_name and redirect_uris, refuses documents that carry a
// client secret, and caches it (Cache-Control max-age, 1 min .. 24 h, default 1 h). The consent page shows the
// document's HOST (what the fetch proved), not only the self-declared name. Hosts outside the trust list are refused.
// DCR clients are marked unverified: their name and redirect host are only what the registration said.
import crypto from 'node:crypto'
import type { DB } from '../db'
import { sha256 } from '../store'
import { MAX_DCR_CLIENTS, type OAuthRuntime } from './config'
import { FetchRefused, guardedGetJson } from './ssrf'

export interface Client {
  client_id: string; kind: 'cimd' | 'dcr'; name: string; redirect_uris: string[]; domain: string
  /** cimd: the domain was proven by fetching the document over https; dcr: self-declared */
  verified: boolean
}

export class OAuthError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message) }
}

interface ClientRow { client_id: string; kind: 'cimd' | 'dcr'; name: string; redirect_uris: string; domain: string; fresh_until: number | null }
const toClient = (r: ClientRow): Client => ({ client_id: r.client_id, kind: r.kind, name: r.name, redirect_uris: JSON.parse(r.redirect_uris), domain: r.domain, verified: r.kind === 'cimd' })

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
export const isLoopbackRedirect = (u: string) => { try { const x = new URL(u); return x.protocol === 'http:' && LOOPBACK_HOSTS.has(x.hostname) } catch { return false } }

/** A redirect URI a client may register: https, or http on a loopback host (RFC 8252); absolute, no fragment. */
function redirectOk(u: unknown): u is string {
  if (typeof u !== 'string' || u.length > 2000) return false
  let x: URL
  try { x = new URL(u) } catch { return false }
  if (x.hash || x.username || x.password) return false
  return x.protocol === 'https:' || isLoopbackRedirect(u)
}

/**
 * Does a requested redirect_uri match one the client registered? Exact string match, except that a loopback http
 * redirect matches with any port (RFC 8252 7.3; Claude Code registers http://localhost/callback and
 * http://127.0.0.1/callback and listens on a different port each time).
 */
export function redirectMatches(registered: string[], asked: string): boolean {
  if (registered.includes(asked)) return true
  if (!isLoopbackRedirect(asked)) return false
  const a = new URL(asked)
  return registered.some((r) => {
    if (!isLoopbackRedirect(r)) return false
    const x = new URL(r)
    return x.hostname === a.hostname && x.pathname === a.pathname && x.search === a.search
  })
}

/** A client_id that names a metadata document: https (http only under a test guard), a path, no fragment or user info. */
export function isCimdUrl(id: string, allowHttp = false): boolean {
  if (id.length > 2000 || !(id.startsWith('https://') || (allowHttp && id.startsWith('http://')))) return false
  let u: URL
  try { u = new URL(id) } catch { return false }
  if (u.hash || u.username || u.password || u.pathname === '/' || !u.pathname) return false
  // no dot segments (the parser would have removed them, so the string would not equal the URL)
  return u.href === id && !/\/\.\.?(\/|$)/.test(id)
}

const hostAllowed = (rt: OAuthRuntime, host: string) => rt.clientHosts === 'any' || rt.clientHosts.includes(host)

/** The client for a client_id, fetching (or re-fetching a stale) metadata document when it is a URL. */
export async function resolveClient(rt: OAuthRuntime, db: DB, clientId: unknown): Promise<Client> {
  if (typeof clientId !== 'string' || !clientId) throw new OAuthError('invalid_client', 'client_id is missing')
  if (isCimdUrl(clientId, rt.guard.allowHttp)) {
    const host = new URL(clientId).hostname
    if (!hostAllowed(rt, host)) throw new OAuthError('invalid_client', `clients from ${host} are not allowed on this server (an admin can allow them: public enable --client-host ${host})`)
    const cached = db.query<ClientRow, [string]>(`SELECT * FROM oauth_clients WHERE client_id = ? AND kind = 'cimd'`).get(clientId)
    if (cached && (cached.fresh_until ?? 0) > rt.now()) return toClient(cached)
    if (!rt.limits.cimdHost.hit(host)) throw new OAuthError('temporarily_unavailable', 'too many client metadata fetches for this host; try again in a minute', 429)
    let doc: { body: unknown; maxAgeS: number | null }
    try { doc = await guardedGetJson(clientId, rt.guard) } catch (e) {
      throw new OAuthError('invalid_client', `the client metadata document could not be used: ${e instanceof FetchRefused ? e.message : 'fetch failed'}`)
    }
    const c = validateCimd(clientId, doc.body)
    const t = rt.now()
    const ttlS = Math.min(24 * 3600, Math.max(60, doc.maxAgeS ?? 3600))
    db.query(`INSERT INTO oauth_clients (client_id, kind, name, redirect_uris, domain, created_at, fetched_at, fresh_until) VALUES (?, 'cimd', ?, ?, ?, ?, ?, ?)
      ON CONFLICT (client_id) DO UPDATE SET name = excluded.name, redirect_uris = excluded.redirect_uris, domain = excluded.domain, fetched_at = excluded.fetched_at, fresh_until = excluded.fresh_until`)
      .run(clientId, c.name, JSON.stringify(c.redirect_uris), c.domain, t, t, t + ttlS * 1000)
    return c
  }
  const row = db.query<ClientRow, [string]>(`SELECT * FROM oauth_clients WHERE client_id = ? AND kind = 'dcr'`).get(clientId)
  if (!row || !rt.dcr) throw new OAuthError('invalid_client', 'unknown client')
  return toClient(row)
}

export function validateCimd(url: string, body: unknown): Client {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new OAuthError('invalid_client', 'the client metadata document is not a JSON object')
  const d = body as Record<string, unknown>
  if (d.client_id !== url) throw new OAuthError('invalid_client', 'client_id in the metadata document does not equal its URL')
  if ('client_secret' in d || 'client_secret_expires_at' in d) throw new OAuthError('invalid_client', 'a client metadata document must not carry a client secret')
  const name = typeof d.client_name === 'string' ? d.client_name.replace(/\p{Cc}/gu, '').trim().slice(0, 100) : ''
  if (!name) throw new OAuthError('invalid_client', 'the client metadata document has no client_name')
  const uris = d.redirect_uris
  if (!Array.isArray(uris) || !uris.length || uris.length > 20 || !uris.every(redirectOk)) throw new OAuthError('invalid_client', 'redirect_uris must list https (or loopback http) URLs')
  return { client_id: url, kind: 'cimd', name, redirect_uris: uris as string[], domain: new URL(url).hostname, verified: true }
}

/** RFC 7591 registration (public clients only: token_endpoint_auth_method "none"). */
export function registerClient(rt: OAuthRuntime, db: DB, body: Record<string, unknown>, addr: string): Record<string, unknown> {
  const uris = body.redirect_uris
  if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every(redirectOk)) throw new OAuthError('invalid_redirect_uri', 'redirect_uris must list https (or loopback http) URLs')
  const name = typeof body.client_name === 'string' ? body.client_name.replace(/\p{Cc}/gu, '').trim().slice(0, 100) : ''
  const n = db.query<{ n: number }, []>(`SELECT count(*) AS n FROM oauth_clients WHERE kind = 'dcr'`).get()!.n
  if (n >= MAX_DCR_CLIENTS) throw new OAuthError('temporarily_unavailable', 'this server has too many registered clients', 503)
  const id = 'dcr_' + crypto.randomBytes(18).toString('base64url')
  const domain = new URL(uris[0] as string).hostname
  const t = rt.now()
  db.query(`INSERT INTO oauth_clients (client_id, kind, name, redirect_uris, domain, created_at, created_ip_hash) VALUES (?, 'dcr', ?, ?, ?, ?, ?)`)
    .run(id, name || domain, JSON.stringify(uris), domain, t, sha256(addr))
  return {
    client_id: id, client_id_issued_at: Math.floor(t / 1000), client_name: name || domain, redirect_uris: uris,
    token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
  }
}
