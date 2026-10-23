// Codes, grants, access and refresh tokens. Opaque random secrets with a prefix (secret scanners can spot them); only
// their sha256 is stored and every request looks the token up, so revoking works on the next call.
//
//   code     <name>_oac_…  one use, 60 s, bound to client, redirect_uri, PKCE S256 challenge and resource
//   access   <name>_oat_…  1 h (never past the grant), bound to the resource (RFC 8707 audience)
//   refresh  <name>_ort_…  until the grant expires; used once: each refresh returns a new one (rotation). Presenting a
//                          spent one again (after a short grace for two refreshes racing) revokes the whole grant.
// The grant is a `tokens` row of kind 'oauth' (person, folder scope, read-only, expiry, client): Access.forToken judges it
// exactly like a personal access token.
import crypto from 'node:crypto'
import type { DB } from '../db'
import { SECRET_TAG } from '../config'
import { sha256, type TokenRow } from '../store'
import { canonicalUrl, CODE_TTL_MS, type OAuthRuntime } from './config'
import { OAuthError, type Client } from './clients'

export const CODE_PREFIX = `${SECRET_TAG}_oac_`
export const ACCESS_PREFIX = `${SECRET_TAG}_oat_`
export const REFRESH_PREFIX = `${SECRET_TAG}_ort_`
const secret = (prefix: string) => prefix + crypto.randomBytes(32).toString('base64url')

/** PKCE S256: BASE64URL(SHA256(verifier)) === challenge; verifier 43–128 unreserved characters (RFC 7636 4.1). */
export function pkceOk(verifier: unknown, challenge: string): boolean {
  if (typeof verifier !== 'string' || !/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false
  const h = crypto.createHash('sha256').update(verifier).digest('base64url')
  return h.length === challenge.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(challenge))
}

export interface Approval {
  client: Client; redirectUri: string; codeChallenge: string; resource: string; personId: number
  scopeFolders: number[] | null; readOnly: boolean; grantedScope: string; grantTtlMs: number
}

export function issueCode(rt: OAuthRuntime, db: DB, a: Approval): string {
  const code = secret(CODE_PREFIX), t = rt.now()
  db.query('DELETE FROM oauth_codes WHERE expires_at < ?').run(t - 86400_000)
  db.query(`INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, resource, person_id, scope_folders, read_only, granted_scope, grant_ttl_ms, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(sha256(code), a.client.client_id, a.redirectUri, a.codeChallenge, a.resource, a.personId,
    a.scopeFolders ? JSON.stringify(a.scopeFolders) : null, a.readOnly ? 1 : 0, a.grantedScope, a.grantTtlMs, t, t + CODE_TTL_MS)
  return code
}

export interface TokenResponse { access_token: string; token_type: 'Bearer'; expires_in: number; refresh_token: string; scope: string }

function mint(rt: OAuthRuntime, db: DB, grantId: number, resource: string, grantExpires: number | null, scope: string): TokenResponse {
  const t = rt.now()
  const access = secret(ACCESS_PREFIX), refresh = secret(REFRESH_PREFIX)
  const accessExp = Math.min(t + rt.accessTtlMs, grantExpires ?? Infinity)
  // expired access tokens are of no use to anyone (refresh tokens stay: a spent one must still be recognised as reuse)
  db.query(`DELETE FROM oauth_tokens WHERE kind = 'access' AND expires_at < ?`).run(t - 86400_000)
  const ins = db.query('INSERT INTO oauth_tokens (hash, grant_id, kind, resource, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
  ins.run(sha256(access), grantId, 'access', resource, t, accessExp)
  ins.run(sha256(refresh), grantId, 'refresh', resource, t, grantExpires ?? t + 365 * 86400_000)
  return { access_token: access, token_type: 'Bearer', expires_in: Math.max(1, Math.floor((accessExp - t) / 1000)), refresh_token: refresh, scope }
}

/** Revoke a grant and everything issued under it. */
export function revokeGrant(rt: OAuthRuntime, db: DB, grantId: number) {
  const t = rt.now()
  db.transaction(() => {
    db.query('UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(t, grantId)
    db.query('UPDATE oauth_tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL').run(t, grantId)
  })()
}

/**
 * Every OAuth grant of a person, and everything issued under them: access and refresh tokens, and codes not yet
 * exchanged (Trina Cloud member removal, review finding 5: a person let back in later must not find an old connection
 * working). Returns the number of grants that were live.
 */
export function revokeGrantsOf(db: DB, personId: number, t = Date.now()): number {
  let n = 0
  db.transaction(() => {
    db.query(`UPDATE oauth_tokens SET revoked_at = ? WHERE revoked_at IS NULL AND grant_id IN (SELECT id FROM tokens WHERE person_id = ? AND kind = 'oauth')`).run(t, personId)
    db.query('DELETE FROM oauth_codes WHERE person_id = ? AND used_at IS NULL').run(personId)
    n = db.query(`UPDATE tokens SET revoked_at = ? WHERE person_id = ? AND kind = 'oauth' AND revoked_at IS NULL`).run(t, personId).changes
  })()
  return n
}

const grantName = (db: DB, personId: number, base: string) => {
  const taken = db.query<{ id: number }, [number, string]>('SELECT id FROM tokens WHERE person_id = ? AND name = ?')
  for (let n = 1; ; n++) { const name = n === 1 ? base : `${base} ${n}`; if (!taken.get(personId, name)) return name }
}

/** Authorization code + PKCE → the grant (a tokens row) and its first access and refresh tokens. */
export function exchangeCode(rt: OAuthRuntime, db: DB, p: { code: unknown; clientId: unknown; redirectUri: unknown; verifier: unknown; resource: unknown }): TokenResponse {
  if (typeof p.code !== 'string' || !p.code.startsWith(CODE_PREFIX) || p.code.length > 200) throw new OAuthError('invalid_grant', 'unknown or expired code')
  const row = db.query<{ code_hash: string; client_id: string; redirect_uri: string; code_challenge: string; resource: string; person_id: number; scope_folders: string | null; read_only: number; granted_scope: string; grant_ttl_ms: number; expires_at: number; used_at: number | null; grant_id: number | null }, [string]>(
    'SELECT * FROM oauth_codes WHERE code_hash = ?').get(sha256(p.code))
  if (!row) throw new OAuthError('invalid_grant', 'unknown or expired code')
  const t = rt.now()
  if (row.used_at != null) {
    // a code used twice: whoever holds it is not alone; cut what the first use made (OAuth 2.1 4.1.3)
    if (row.grant_id != null) revokeGrant(rt, db, row.grant_id)
    throw new OAuthError('invalid_grant', 'this code was already used')
  }
  if (row.expires_at <= t) throw new OAuthError('invalid_grant', 'unknown or expired code')
  if (p.clientId !== row.client_id) throw new OAuthError('invalid_grant', 'the code was issued to another client')
  if (p.redirectUri !== undefined && p.redirectUri !== row.redirect_uri) throw new OAuthError('invalid_grant', 'redirect_uri does not match the authorization request')
  if (!pkceOk(p.verifier, row.code_challenge)) throw new OAuthError('invalid_grant', 'code_verifier does not match the code challenge (PKCE S256)')
  if (p.resource !== undefined && canonicalUrl(String(p.resource)) !== row.resource) throw new OAuthError('invalid_target', 'resource does not match the authorization request')
  const person = db.query<{ active: number }, [number]>('SELECT active FROM people WHERE id = ?').get(row.person_id)
  if (!person?.active) throw new OAuthError('invalid_grant', 'the person who approved is no longer active')
  const client = db.query<{ name: string; domain: string }, [string]>('SELECT name, domain FROM oauth_clients WHERE client_id = ?').get(row.client_id)
  let out: TokenResponse | null = null
  db.transaction(() => {
    // exactly once, even with two exchanges at the same moment
    if (db.query('UPDATE oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL').run(t, row.code_hash).changes !== 1) return
    const expires = t + row.grant_ttl_ms
    const r = db.query(`INSERT INTO tokens (person_id, name, hash, hint, scope, read_only, created_at, expires_at, kind, client_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'oauth', ?)`)
      .run(row.person_id, grantName(db, row.person_id, `${client?.name ?? 'OAuth client'} (${client?.domain ?? '?'})`),
        sha256(crypto.randomBytes(32)), `oauth:${client?.domain ?? '?'}`.slice(0, 64), row.scope_folders, row.read_only, t, expires, row.client_id)
    const grantId = Number(r.lastInsertRowid)
    db.query('UPDATE oauth_codes SET grant_id = ? WHERE code_hash = ?').run(grantId, row.code_hash)
    out = mint(rt, db, grantId, row.resource, expires, row.granted_scope)
  })()
  if (!out) throw new OAuthError('invalid_grant', 'this code was already used')
  return out
}

interface TokRow { hash: string; grant_id: number; kind: 'access' | 'refresh'; resource: string; expires_at: number; used_at: number | null; revoked_at: number | null }
interface GrantRow extends TokenRow { active: number }
const grantOf = (db: DB, id: number) => db.query<GrantRow, [number]>('SELECT t.*, p.active FROM tokens t JOIN people p ON p.id = t.person_id WHERE t.id = ?').get(id)
const grantLive = (g: GrantRow | null | undefined, t: number): g is GrantRow =>
  !!g && g.kind === 'oauth' && g.revoked_at == null && !!g.active && (g.expires_at == null || g.expires_at > t)

/** Refresh with rotation and reuse detection. */
export function refreshTokens(rt: OAuthRuntime, db: DB, p: { refreshToken: unknown; clientId: unknown; resource: unknown; scope: unknown }): TokenResponse {
  if (typeof p.refreshToken !== 'string' || !p.refreshToken.startsWith(REFRESH_PREFIX) || p.refreshToken.length > 200) throw new OAuthError('invalid_grant', 'unknown refresh token')
  const row = db.query<TokRow, [string]>(`SELECT * FROM oauth_tokens WHERE hash = ? AND kind = 'refresh'`).get(sha256(p.refreshToken))
  if (!row) throw new OAuthError('invalid_grant', 'unknown refresh token')
  const t = rt.now()
  const g = grantOf(db, row.grant_id)
  if (row.used_at != null) {
    // spent already. Right after its rotation it is most likely the same client refreshing twice at once: refuse, keep
    // the grant. Later it means two parties hold the token: revoke the whole grant (OAuth 2.1 4.3.1, BCP 4.14.2).
    if (t - row.used_at > rt.refreshGraceMs) revokeGrant(rt, db, row.grant_id)
    throw new OAuthError('invalid_grant', 'this refresh token was already used')
  }
  if (row.revoked_at != null || row.expires_at <= t || !grantLive(g, t)) throw new OAuthError('invalid_grant', 'the connection was revoked or has expired')
  // public clients identify themselves with client_id on every token request (RFC 6749 3.2.1)
  if (p.clientId !== g.client_id) throw new OAuthError('invalid_grant', 'the refresh token was issued to another client')
  if (p.resource !== undefined && canonicalUrl(String(p.resource)) !== row.resource) throw new OAuthError('invalid_target', 'resource does not match the grant')
  const granted = g.read_only ? 'files:read' : 'files:read drafts:write'
  // RFC 6749 6: a refresh may narrow the scope, never widen it; folders and read-only stay as the person granted
  if (typeof p.scope === 'string' && p.scope.trim() && !p.scope.trim().split(/\s+/).every((s) => granted.split(' ').includes(s) || s === 'offline_access')) {
    throw new OAuthError('invalid_scope', 'a refresh cannot ask for more than was granted')
  }
  let out: TokenResponse | null = null
  db.transaction(() => {
    if (db.query('UPDATE oauth_tokens SET used_at = ? WHERE hash = ? AND used_at IS NULL').run(t, row.hash).changes !== 1) return
    out = mint(rt, db, row.grant_id, row.resource, g.expires_at, granted)
  })()
  if (!out) throw new OAuthError('invalid_grant', 'this refresh token was already used')
  return out
}

/** RFC 7009: an access token is revoked alone; a refresh token takes its whole grant with it. Unknown tokens: no-op. */
export function revokeOAuthToken(rt: OAuthRuntime, db: DB, raw: unknown, clientId: unknown) {
  if (typeof raw !== 'string' || raw.length > 200) return
  const row = db.query<TokRow, [string]>('SELECT * FROM oauth_tokens WHERE hash = ?').get(sha256(raw))
  if (!row) return
  const g = grantOf(db, row.grant_id)
  if (typeof clientId === 'string' && g && g.client_id !== clientId) return // not this client's token
  if (row.kind === 'refresh') revokeGrant(rt, db, row.grant_id)
  else db.query('UPDATE oauth_tokens SET revoked_at = ? WHERE hash = ? AND revoked_at IS NULL').run(rt.now(), row.hash)
}

export type AccessCheck = { ok: true; token: TokenRow } | { ok: false; reason: 'invalid' | 'audience' }

/**
 * The grant behind a presented access token, if the token is live, its grant is live (not revoked or expired, person
 * active) and it was issued for `resource` (RFC 8707 audience: a token for another resource is refused).
 */
export function verifyAccessToken(rt: OAuthRuntime, db: DB, raw: string, client?: string): AccessCheck {
  if (!raw.startsWith(ACCESS_PREFIX) || raw.length > 200) return { ok: false, reason: 'invalid' }
  const row = db.query<TokRow, [string]>(`SELECT * FROM oauth_tokens WHERE hash = ? AND kind = 'access'`).get(sha256(raw))
  const t = rt.now()
  if (!row || row.revoked_at != null || row.expires_at <= t) return { ok: false, reason: 'invalid' }
  const g = grantOf(db, row.grant_id)
  if (!grantLive(g, t)) return { ok: false, reason: 'invalid' }
  if (row.resource !== rt.resource) return { ok: false, reason: 'audience' }
  db.query('UPDATE tokens SET last_used_at = ?, last_client = coalesce(?, last_client) WHERE id = ?').run(t, client ?? null, g.id)
  const { active: _a, ...token } = g
  return { ok: true, token }
}
