// S16 (workstream A2): sharing with someone who is not a member yet. An admin's share by mail asks the team's invite
// flow (./invite.ts) and, when the person does not exist yet, keeps a pending row here; when that address becomes an
// active person, the member sync calls applyShareInvites and the share is given with its original giver and time
// (one audit row each, in one transaction). Rows older than 30 days are dropped. Files only reach their grantee if
// the file is still the same one (its uid); a file purged meanwhile is dropped.
import { appendAudit } from '../audit'
import type { DB } from '../db'

export const INVITE_TTL_MS = 30 * 86400_000

export interface PendingInvite { kind: 'folder' | 'file'; folderId?: number; fileUid?: string; level: 1 | 2; by: number; vpath: string }

/** Inside or outside a transaction: remember a share for an address that has no active person yet. */
export function recordShareInvite(db: DB, email: string, inv: PendingInvite, now = Date.now()) {
  db.query('INSERT INTO share_invites (email, kind, folder_id, file_uid, level, granted_by, granted_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(email.trim().toLowerCase(), inv.kind, inv.folderId ?? null, inv.fileUid ?? null, inv.level, inv.by, now)
  appendAudit(db, { personId: inv.by, tokenId: null, tool: 'web', command: `share ${inv.vpath} (${inv.kind}) invite pending →${inv.level >= 2 ? 'editor' : 'viewer'}`, files: [inv.vpath], outcome: 'ok' })
}

/**
 * The member sync (B2) calls this when `email` became active person `personId`. Gives every pending share for that
 * address (file grants, folder rules — never lowering what is there), marks them applied, drops expired ones.
 * Returns how many were applied (the caller sends one "Items were shared with you" notice: kind + count + link).
 */
export function applyShareInvites(db: DB, personId: number, email: string, now = Date.now()): number {
  const rows = db.query<{ id: number; kind: 'folder' | 'file'; folder_id: number | null; file_uid: string | null; level: number; granted_by: number; granted_at: number }, [string]>(
    'SELECT * FROM share_invites WHERE email = ? AND applied_at IS NULL AND dropped_at IS NULL ORDER BY id').all(email.trim().toLowerCase())
  if (!rows.length) return 0
  const active = db.query<{ active: number }, [number]>('SELECT active FROM people WHERE id = ?').get(personId)?.active === 1
  if (!active) return 0
  let n = 0
  db.transaction(() => {
    for (const r of rows) {
      const drop = () => db.query('UPDATE share_invites SET dropped_at = ? WHERE id = ?').run(now, r.id)
      if (now - r.granted_at > INVITE_TTL_MS) { drop(); continue }
      if (r.kind === 'file') {
        if (!r.file_uid || !db.query('SELECT 1 FROM mfiles WHERE uid = ?').get(r.file_uid)) { drop(); continue }
        db.query(`INSERT INTO file_grants (file_uid, subject_type, subject_id, subject_uid, level, granted_by, granted_at) VALUES (?, 'person', ?, NULL, ?, ?, ?)
          ON CONFLICT DO UPDATE SET level = max(level, excluded.level)`).run(r.file_uid, personId, r.level, r.granted_by, r.granted_at)
      } else {
        if (r.folder_id == null || !db.query('SELECT 1 FROM folders WHERE id = ?').get(r.folder_id)) { drop(); continue }
        db.query(`INSERT INTO rules (folder_id, subject_type, subject_id, level, granted_by, granted_at) VALUES (?, 'person', ?, ?, ?, ?)
          ON CONFLICT DO UPDATE SET level = max(level, excluded.level)`).run(r.folder_id, personId, r.level, r.granted_by, r.granted_at)
      }
      db.query('UPDATE share_invites SET applied_at = ? WHERE id = ?').run(now, r.id)
      appendAudit(db, { personId: r.granted_by, tokenId: null, tool: 'web', command: `share invite #${r.id} applied: person:${personId} →${r.level >= 2 ? 'editor' : 'viewer'} (${r.kind})`, files: [], outcome: 'ok' })
      n++
    }
  })()
  return n
}
