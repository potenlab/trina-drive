// Who hears about an event (plan 4.1 R11, R9, R10). Decides only person ids and a level:
//   detail = may open the detail screen (still behind login and R7), count = gets the count and a generic link.
import type { DB } from '../db'
import type { FolderRow } from '../store'
import type { ShelfEvent } from './events'
import type { Level } from './messages'

export interface Recipient { personId: number; level: Level; count: number; digest: boolean }

const activeAdmins = (db: DB) => db.query<{ id: number }, []>('SELECT id FROM people WHERE admin = 1 AND active = 1').all().map((r) => r.id)
const isActive = (db: DB, id: number) => !!db.query<{ id: number }, [number]>('SELECT id FROM people WHERE id = ? AND active = 1').get(id)

/**
 * `manage` holders of a folder: grants on it or on any known ancestor within its registered folder (R7, manage is
 * inherited down). Folders in a personal folder have none. Uses stored paths, so it works for a folder that vanished.
 */
export function manageHolders(db: DB, folderId: number): number[] {
  const f = db.query<FolderRow, [number]>('SELECT * FROM folders WHERE id = ?').get(folderId)
  if (!f) return []
  const chain = db.query<FolderRow, []>('SELECT * FROM folders').all().filter((a) => f.path === a.path || f.path.startsWith(a.path + '/'))
  const reg = chain.filter((a) => a.registered).sort((a, b) => b.path.length - a.path.length)[0]
  if (!reg || chain.some((a) => a.personal_owner != null)) return []
  const ids = chain.filter((a) => a.path.length >= reg.path.length).map((a) => a.id)
  const q = db.query<{ person_id: number }, [number]>('SELECT g.person_id FROM manage_grants g JOIN people p ON p.id = g.person_id WHERE g.folder_id = ? AND p.active = 1')
  return [...new Set(ids.flatMap((id) => q.all(id).map((r) => r.person_id)))]
}

export function resolveRecipients(db: DB, e: ShelfEvent): Recipient[] {
  const n = Math.max(1, e.count ?? 1)
  const out = new Map<number, Recipient>()
  const add = (personId: number, level: Level, count: number, digest = false) => {
    if (!isActive(db, personId)) return
    const cur = out.get(personId)
    if (!cur || (cur.level === 'count' && level === 'detail')) out.set(personId, { personId, level, count, digest })
  }
  const subject = (level: Level = 'detail') => { if (e.subjectPersonId != null) add(e.subjectPersonId, level, n) }
  const admins = (level: Level) => activeAdmins(db).forEach((id) => add(id, level, n))

  switch (e.kind) {
    case 'widened_draft': {
      // R11: source-folder manage holders; a source without one → admins, count only; target manage → "1 item" only
      const digest = !!e.weakOnly
      for (const s of new Set(e.sourceFolderIds ?? [])) {
        if (s === e.targetFolderId) continue
        const holders = manageHolders(db, s)
        if (holders.length) holders.forEach((id) => add(id, 'detail', n, digest))
        else activeAdmins(db).forEach((id) => add(id, 'count', n, digest))
      }
      if (e.targetFolderId != null) manageHolders(db, e.targetFolderId).forEach((id) => add(id, 'count', 1, digest))
      break
    }
    case 'quarantine': // R10: admins and the folder's manage holders
      admins('detail')
      if (e.folderId != null) manageHolders(db, e.folderId).forEach((id) => add(id, 'detail', n))
      break
    case 'admin_self_grant': // R9: the folder's manage holders and the person concerned, right away
      if (e.folderId != null) manageHolders(db, e.folderId).forEach((id) => add(id, 'detail', n))
      subject()
      break
    case 'password_reset': // R9: only the person, at their own address
    case 'new_client':
    case 'token_revoked':
      subject()
      break
    case 'original_write_attempt':
    case 'bulk_read':
      subject()
      admins('count')
      break
    case 'audit_anchor':
      admins('detail')
      break
  }
  return [...out.values()]
}
