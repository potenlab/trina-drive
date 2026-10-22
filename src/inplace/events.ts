// Admin-facing records of the reconciler: events (who should hear: admins, manage holders) and quarantine
// (closed to agents until released). No authentication layer yet: callers pass the acting person's id.
import path from 'node:path'
import type { DB } from '../db'
import { StoreError, type FolderRow } from '../store'

export type EventKind =
  | 'renamed' | 'moved' | 'quarantined' | 'lost' | 'found' | 'unavailable' | 'available'
  | 'closed' | 'widened' | 'widened_tracked' | 'confirmed' | 'released'

export interface EventRow {
  id: number; at: number; kind: EventKind; path: string | null; old_path: string | null
  dev: string | null; ino: string | null; folder_id: number | null; detail: string; notify: string
}

export interface Notify { admins?: number[]; manage?: number[]; sourceManage?: number[]; targetManage?: number[] }

export function addEvent(db: DB, e: { kind: EventKind; path?: string | null; oldPath?: string | null; dev?: string | null; ino?: string | null
  folderId?: number | null; detail?: Record<string, unknown>; notify?: Notify; at?: number }): number {
  const r = db.query('INSERT INTO fs_events (at, kind, path, old_path, dev, ino, folder_id, detail, notify) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(e.at ?? Date.now(), e.kind, e.path ?? null, e.oldPath ?? null, e.dev ?? null, e.ino ?? null, e.folderId ?? null,
      JSON.stringify(e.detail ?? {}), JSON.stringify(e.notify ?? {}))
  return Number(r.lastInsertRowid)
}

export function listEvents(db: DB, opts: { sinceId?: number; kind?: string; limit?: number } = {}): EventRow[] {
  return db.query<EventRow, [number, string | null, string | null, number]>(
    'SELECT * FROM fs_events WHERE id > ? AND (? IS NULL OR kind = ?) ORDER BY id DESC LIMIT ?')
    .all(opts.sinceId ?? 0, opts.kind ?? null, opts.kind ?? null, opts.limit ?? 200)
}

export const adminIds = (db: DB) => db.query<{ id: number }, []>('SELECT id FROM people WHERE admin = 1 AND active = 1').all().map((r) => r.id)

/** manage holders of these folders (R7: manage is inherited downward, so pass the whole chain). */
export function manageHolders(db: DB, folderIds: Iterable<number>): number[] {
  const ids = [...new Set(folderIds)]
  if (!ids.length) return []
  return db.query<{ person_id: number }, number[]>(
    `SELECT DISTINCT g.person_id FROM manage_grants g JOIN people p ON p.id = g.person_id
     WHERE p.active = 1 AND g.folder_id IN (${ids.map(() => '?').join(',')})`).all(...ids).map((r) => r.person_id)
}

/** Folder rows from the mount down to `dir` by stored path (for manage lookups of folders that still exist). */
export function chainByPath(db: DB, dir: string): FolderRow[] {
  const rows = db.query<FolderRow, []>('SELECT * FROM folders').all()
    .filter((f) => dir === f.path || dir.startsWith(f.path + '/'))
    .sort((a, b) => a.path.length - b.path.length)
  const top = rows.findIndex((r) => r.registered)
  return top < 0 ? [] : rows.slice(top)
}

export interface QuarantineRow {
  id: number; kind: 'moved' | 'widened' | 'lost'; item: 'file' | 'dir'; dev: string; ino: string; path: string
  folder_id: number | null; widened_id: number | null; event_id: number | null; reason: string
  created_at: number; released_at: number | null; released_by: number | null
}

export function addQuarantine(db: DB, q: Omit<QuarantineRow, 'id' | 'created_at' | 'released_at' | 'released_by'>, at = Date.now()): number {
  const r = db.query('INSERT INTO quarantine (kind, item, dev, ino, path, folder_id, widened_id, event_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(q.kind, q.item, q.dev, q.ino, q.path, q.folder_id, q.widened_id, q.event_id, q.reason, at)
  return Number(r.lastInsertRowid)
}

export function listQuarantine(db: DB, opts: { all?: boolean } = {}): QuarantineRow[] {
  return db.query<QuarantineRow, []>(`SELECT * FROM quarantine ${opts.all ? '' : 'WHERE released_at IS NULL'} ORDER BY id`).all()
}

const isAdmin = (db: DB, personId: number) => !!db.query<{ admin: number }, [number]>('SELECT admin FROM people WHERE id = ? AND active = 1').get(personId)?.admin

/**
 * Release one quarantine item. moved/lost: the admin only (R9). widened: the admin or someone who manages every
 * source folder of the draft (R6) — this is the "confirm" of a widened copy (see confirmWidened).
 */
export function releaseQuarantine(db: DB, id: number, actorId: number, now = Date.now()) {
  const q = db.query<QuarantineRow, [number]>('SELECT * FROM quarantine WHERE id = ?').get(id)
  if (!q) throw new StoreError(`no quarantine item ${id}`)
  if (q.released_at != null) throw new StoreError(`quarantine item ${id} was already released`)
  if (q.kind === 'widened') {
    if (!canConfirmWidened(db, q.widened_id!, actorId)) throw new StoreError('only the admin or a manager of every source folder can confirm a widened copy')
    db.transaction(() => {
      db.query('UPDATE widened SET status = ?, confirmed_at = ?, confirmed_by = ? WHERE id = ?').run('confirmed', now, actorId, q.widened_id)
      db.query('UPDATE quarantine SET released_at = ?, released_by = ? WHERE widened_id = ? AND released_at IS NULL').run(now, actorId, q.widened_id)
      addEvent(db, { kind: 'confirmed', path: q.path, dev: q.dev, ino: q.ino, folderId: q.folder_id, detail: { quarantine: id, widened: q.widened_id, by: actorId }, at: now })
    })()
    return
  }
  if (!isAdmin(db, actorId)) throw new StoreError('only the admin can release a quarantined or lost item')
  db.transaction(() => {
    db.query('UPDATE quarantine SET released_at = ?, released_by = ? WHERE id = ?').run(now, actorId, id)
    // a released lost registered folder: forget its index rows so the next reconcile does not report it lost again
    if (q.kind === 'lost') db.query('DELETE FROM fs_index WHERE root = ?').run(q.path)
    addEvent(db, { kind: 'released', path: q.path, dev: q.dev, ino: q.ino, folderId: q.folder_id, detail: { quarantine: id, kind: q.kind, by: actorId }, at: now })
  })()
}

/** R6 confirm: the admin, or a person holding manage on (an ancestor of) every source folder of the draft. */
export function canConfirmWidened(db: DB, widenedId: number, actorId: number): boolean {
  if (isAdmin(db, actorId)) return true
  const w = db.query<{ draft_id: number }, [number]>('SELECT draft_id FROM widened WHERE id = ?').get(widenedId)
  if (!w) return false
  const src = db.query<{ folder_id: number }, [number]>('SELECT folder_id FROM draft_src WHERE draft_id = ?').all(w.draft_id)
  if (!src.length) return false
  for (const { folder_id } of src) {
    const f = db.query<FolderRow, [number]>('SELECT * FROM folders WHERE id = ?').get(folder_id)
    if (!f || !manageHolders(db, chainByPath(db, f.path).map((r) => r.id)).includes(actorId)) return false
  }
  return true
}

/** Confirm a widened copy by its widened id (same as releasing its quarantine item). */
export function confirmWidened(db: DB, widenedId: number, actorId: number, now = Date.now()) {
  const q = db.query<{ id: number }, [number]>('SELECT id FROM quarantine WHERE widened_id = ? AND released_at IS NULL ORDER BY id LIMIT 1').get(widenedId)
  if (q) return releaseQuarantine(db, q.id, actorId, now)
  if (!canConfirmWidened(db, widenedId, actorId)) throw new StoreError('only the admin or a manager of every source folder can confirm a widened copy')
  db.query("UPDATE widened SET status = 'confirmed', confirmed_at = ?, confirmed_by = ? WHERE id = ? AND status = 'pending'").run(now, actorId, widenedId)
}

export const parentOf = (p: string) => path.dirname(p)
