// Audit log of control-plane actions (signups, team creation, billing transitions, provisioning, suspend/resume,
// exports, deletions, admin CLI). Hash-chained like the product's audit (each row's hash covers the previous one), so
// an edited or deleted row shows up in `audit verify`. Secrets never go in `detail`.
import type { DB } from './db'
import { sha256 } from './util'

export interface AuditEntry { actor: string; action: string; teamId?: number | null; detail?: Record<string, unknown> }

const rowHash = (prev: string, at: number, actor: string, action: string, teamId: number | null, detail: string) =>
  sha256(JSON.stringify([prev, at, actor, action, teamId, detail]))

export function audit(db: DB, e: AuditEntry) {
  const at = Date.now()
  const detail = JSON.stringify(e.detail ?? {})
  db.transaction(() => {
    const prev = db.query<{ hash: string }, []>('SELECT hash FROM audit ORDER BY id DESC LIMIT 1').get()?.hash ?? 'genesis'
    db.query('INSERT INTO audit (at, actor, action, team_id, detail, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(at, e.actor, e.action, e.teamId ?? null, detail, prev, rowHash(prev, at, e.actor, e.action, e.teamId ?? null, detail))
  })()
}

export function verifyAudit(db: DB): { ok: boolean; rows: number; brokenAt?: number } {
  let prev = 'genesis', rows = 0
  for (const r of db.query<{ id: number; at: number; actor: string; action: string; team_id: number | null; detail: string; prev_hash: string; hash: string }, []>('SELECT * FROM audit ORDER BY id').all()) {
    if (r.prev_hash !== prev || r.hash !== rowHash(prev, r.at, r.actor, r.action, r.team_id, r.detail)) return { ok: false, rows, brokenAt: r.id }
    prev = r.hash
    rows++
  }
  return { ok: true, rows }
}

export function listAudit(db: DB, opts: { teamId?: number; limit?: number } = {}) {
  const limit = Math.min(opts.limit ?? 50, 1000)
  return opts.teamId != null
    ? db.query<{ id: number; at: number; actor: string; action: string; team_id: number | null; detail: string }, [number, number]>('SELECT id, at, actor, action, team_id, detail FROM audit WHERE team_id = ? ORDER BY id DESC LIMIT ?').all(opts.teamId, limit)
    : db.query<{ id: number; at: number; actor: string; action: string; team_id: number | null; detail: string }, [number]>('SELECT id, at, actor, action, team_id, detail FROM audit ORDER BY id DESC LIMIT ?').all(limit)
}
