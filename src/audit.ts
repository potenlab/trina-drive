// Audit log with a hash chain: each row's hash covers its fields and the previous row's hash.
import type { DB } from './db'
import { LIMITS } from './config'
import { sha256 } from './store'

const GENESIS = '0'.repeat(64)

export interface AuditEntry { personId: number | null; tokenId: number | null; tool: string; command: string; files: string[]; outcome: string }
interface Row { id: number; at: number; person_id: number | null; token_id: number | null; tool: string; command: string; command_sha256: string; files: string; outcome: string; prev_hash: string; hash: string }

const rowHash = (prev: string, r: Omit<Row, 'id' | 'prev_hash' | 'hash'>) =>
  sha256(prev + '\n' + JSON.stringify([r.at, r.person_id, r.token_id, r.tool, r.command, r.command_sha256, r.files, r.outcome]))

/** Keep at most `max` UTF-8 bytes without splitting a character. */
export function truncateUtf8(s: string, max: number): string {
  const b = Buffer.from(s)
  if (b.length <= max) return s
  return new TextDecoder().decode(b.subarray(0, max)).replace(/�$/, '') + '…'
}

/** Append one entry. Throws if it cannot be written: callers fail the whole call then (closed by default). */
export function appendAudit(db: DB, e: AuditEntry) {
  const prev = db.query<{ hash: string }, []>('SELECT hash FROM audit ORDER BY id DESC LIMIT 1').get()?.hash ?? GENESIS
  const files = e.files.length > LIMITS.auditFiles ? [...e.files.slice(0, LIMITS.auditFiles), `… ${e.files.length - LIMITS.auditFiles} more`] : e.files
  const r = { at: Date.now(), person_id: e.personId, token_id: e.tokenId, tool: e.tool, command: truncateUtf8(e.command, LIMITS.auditCommandBytes),
    command_sha256: sha256(e.command), files: JSON.stringify(files), outcome: e.outcome }
  db.query('INSERT INTO audit (at, person_id, token_id, tool, command, command_sha256, files, outcome, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(r.at, r.person_id, r.token_id, r.tool, r.command, r.command_sha256, r.files, r.outcome, prev, rowHash(prev, r))
}

/** Recompute the chain. Returns the first broken row id, if any. */
export function verifyAudit(db: DB): { ok: boolean; rows: number; brokenAt?: number; head: string } {
  let prev = GENESIS
  let n = 0
  for (const r of db.query<Row, []>('SELECT * FROM audit ORDER BY id').iterate()) {
    if (r.prev_hash !== prev || rowHash(prev, r) !== r.hash) return { ok: false, rows: n, brokenAt: r.id, head: prev }
    prev = r.hash
    n++
  }
  return { ok: true, rows: n, head: prev }
}
