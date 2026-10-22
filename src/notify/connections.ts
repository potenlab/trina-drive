// MCP connections per token: client name/version (from initialize), user-agent product, source IP. The first request
// from a client a token has not used before fires new_client (plan 7.1 token leak). Revoking is the core token
// revocation, which mcp.ts checks on every request (verifyToken), so the next request fails.
import type { DB } from '../db'
import { revokeToken, tokenById } from '../store'
import type { EventBus } from './events'
import { ensureNotifySchema } from './schema'

export interface ClientSeen { clientName?: string; clientVersion?: string; userAgent?: string | null; ip?: string | null }
export interface ConnectionRow {
  id: number; token_id: number; token_name: string; person: string; client_name: string; client_version: string | null
  ua_product: string; user_agent: string | null; ip: string; first_seen: number; last_seen: number; requests: number; revoked_at: number | null
}

/** "claude-code/2.0.14 (darwin)" → "claude-code"; versions change on update and must not look like a new client. */
export function uaProduct(ua: string | null | undefined): string {
  const first = (ua ?? '').trim().split(/\s+/)[0] ?? ''
  return first.split('/')[0]!.toLowerCase().slice(0, 64)
}

export class Connections {
  constructor(readonly db: DB, readonly bus: EventBus, readonly opts: () => { byIp: boolean }, readonly now: () => number = Date.now) {
    ensureNotifySchema(db)
  }

  /** Record one authenticated request. Returns true when it was a new client for this token. */
  seen(token: { id: number; person_id: number }, c: ClientSeen): boolean {
    const db = this.db
    const at = this.now()
    const product = uaProduct(c.userAgent)
    const ip = this.opts().byIp ? (c.ip ?? '') : ''
    const rows = db.query<{ id: number; client_name: string }, [number, string, string]>(
      'SELECT id, client_name FROM notify_connections WHERE token_id = ? AND ua_product = ? AND ip = ? ORDER BY last_seen DESC').all(token.id, product, ip)
    let row: { id: number; client_name: string } | undefined
    if (c.clientName) row = rows.find((r) => r.client_name === c.clientName) ?? rows.find((r) => r.client_name === '')
    else row = rows[0]
    if (row) {
      db.query(`UPDATE notify_connections SET last_seen = ?, requests = requests + 1, user_agent = coalesce(?, user_agent),
        client_name = CASE WHEN ? != '' THEN ? ELSE client_name END, client_version = coalesce(?, client_version) WHERE id = ?`)
        .run(at, c.userAgent ?? null, c.clientName ?? '', c.clientName ?? '', c.clientVersion ?? null, row.id)
      return false
    }
    db.query('INSERT INTO notify_connections (token_id, client_name, client_version, ua_product, user_agent, ip, first_seen, last_seen, requests) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)')
      .run(token.id, c.clientName ?? '', c.clientVersion ?? null, product, c.userAgent ?? null, ip, at, at)
    this.bus.emit({ kind: 'new_client', at, subjectPersonId: token.person_id, tokenId: token.id, detail: { client: c.clientName ?? null, ua: product, ip } })
    return true
  }

  list(opts: { includeRevoked?: boolean } = {}): ConnectionRow[] {
    return this.db.query<ConnectionRow, []>(`SELECT c.*, t.name AS token_name, p.name AS person, t.revoked_at FROM notify_connections c
      JOIN tokens t ON t.id = c.token_id JOIN people p ON p.id = t.person_id
      ${opts.includeRevoked ? '' : 'WHERE t.revoked_at IS NULL'} ORDER BY c.last_seen DESC`).all()
  }

  /** Revoke a token now (the next request with it fails) and tell its owner. */
  revoke(tokenId: number, reason = 'admin'): boolean {
    const t = tokenById(this.db, tokenId)
    if (!t || t.revoked_at != null) return false
    revokeToken(this.db, tokenId)
    this.bus.emit({ kind: 'token_revoked', subjectPersonId: t.person_id, tokenId, detail: { reason } })
    return true
  }
}
