// Bulk-read alarm (plan 5.1, 7.1): per token, a sliding window of how much content left through committed calls —
// files whose content was output, their size in bytes, distinct folders. Crossing any threshold fires bulk_read once
// per window; optionally the token is revoked on the spot (off by default).
import type { DB } from '../db'
import { revokeToken } from '../store'
import type { NotifyConfig } from './config'
import type { EventBus } from './events'
import { ensureNotifySchema } from './schema'

export interface ReadBatch { files: number; bytes: number; folders: Iterable<string> }
export interface BulkTotals { files: number; bytes: number; folders: number }

export class BulkReadMonitor {
  constructor(readonly db: DB, readonly cfg: () => NotifyConfig['bulkRead'], readonly bus: EventBus, readonly now: () => number = Date.now) {
    ensureNotifySchema(db)
  }

  totals(tokenId: number, at = this.now()): BulkTotals {
    const rows = this.db.query<{ files: number; bytes: number; folders: string }, [number, number]>(
      'SELECT files, bytes, folders FROM notify_reads WHERE token_id = ? AND at > ?').all(tokenId, at - this.cfg().windowMs)
    const folders = new Set<string>()
    let files = 0, bytes = 0
    for (const r of rows) { files += r.files; bytes += r.bytes; for (const f of JSON.parse(r.folders) as string[]) folders.add(f) }
    return { files, bytes, folders: folders.size }
  }

  /** Record one call's reads; fires bulk_read when a threshold is crossed. Returns whether it fired. */
  record(token: { id: number; person_id: number }, batch: ReadBatch): boolean {
    const c = this.cfg()
    const folders = [...new Set(batch.folders)]
    if (!batch.files && !batch.bytes && !folders.length) return false
    const at = this.now()
    this.db.query('INSERT INTO notify_reads (token_id, at, files, bytes, folders) VALUES (?, ?, ?, ?, ?)').run(token.id, at, batch.files, batch.bytes, JSON.stringify(folders))
    this.db.query('DELETE FROM notify_reads WHERE at <= ?').run(at - 2 * c.windowMs)
    const t = this.totals(token.id, at)
    const over = (v: number, lim: number) => lim > 0 && v >= lim
    if (!(over(t.files, c.files) || over(t.bytes, c.bytes) || over(t.folders, c.folders))) return false
    const last = this.db.query<{ at: number }, [number]>('SELECT max(at) AS at FROM notify_bulk_alarms WHERE token_id = ?').get(token.id)?.at
    if (last != null && last > at - c.windowMs) return false
    this.db.query('INSERT INTO notify_bulk_alarms (token_id, at) VALUES (?, ?)').run(token.id, at)
    this.bus.emit({ kind: 'bulk_read', at, subjectPersonId: token.person_id, tokenId: token.id, detail: { ...t, windowMs: c.windowMs, autoSuspend: c.autoSuspend } })
    if (c.autoSuspend) {
      revokeToken(this.db, token.id)
      this.bus.emit({ kind: 'token_revoked', at, subjectPersonId: token.person_id, tokenId: token.id, detail: { reason: 'bulk_read' } })
    }
    return true
  }
}
