// Tables and columns sharing adds (workstream A1), run by src/migrations.ts. Idempotent and additive only: an older
// image keeps working on a database this one touched (it never reads these columns).
//   folders.editors_can_share   O1: "Editors can change permissions and share" — NULL = as the folder above (a top
//                               folder's NULL = on), 0 = off here and everywhere below (cannot be turned on below), 1 = on
//   rules.granted_by/at,        who gave the access and when ("Shared with me", the share dialog); NULL = given before
//   manage_grants.granted_by/at  this feature (or by the CLI)
// Cloud mode (TDRIVE_CLOUD_TEAM set): the Everyone group ("Anyone in Trina") exists and holds every active person who is
// not just invited (plan 3.2, finding 13). The member sync keeps it so (workstream B1); this only makes sure at start.
import type { Database } from 'bun:sqlite'
import { addColumns, type Migration } from '../migrations'

export function ensureEveryoneGroup(db: Database): number {
  const known = db.query<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?').get('everyone_group')?.value
  let id = known && db.query('SELECT 1 FROM groups WHERE id = ?').get(Number(known)) ? Number(known) : undefined
  id ??= db.query<{ id: number }, []>(`SELECT id FROM groups WHERE name IN ('everyone', '전체', '전원') ORDER BY id LIMIT 1`).get()?.id
  id ??= Number(db.query('INSERT INTO groups (name) VALUES (?)').run('everyone').lastInsertRowid)
  db.query('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run('everyone_group', String(id))
  return id
}

/** Cloud mode: every active person who is not only invited is in Everyone. Never removes anyone (the sync does). */
export function fillEveryone(db: Database) {
  const id = ensureEveryoneGroup(db)
  const accounts = new Set(db.query<{ name: string }, []>('PRAGMA table_info(accounts)').all().map((c) => c.name))
  const invitedOnly = accounts.has('cloud_invite') && accounts.has('cloud_user')
    ? 'AND id NOT IN (SELECT person_id FROM accounts WHERE cloud_invite IS NOT NULL AND cloud_user IS NULL)' : ''
  db.query(`INSERT OR IGNORE INTO memberships (group_id, person_id) SELECT ?, id FROM people WHERE active = 1 ${invitedOnly}`).run(id)
}

export const shareMigrations: Migration[] = [
  { id: 'share.editors_can_share', phase: 'core', up: (db) => addColumns(db, 'folders', [['editors_can_share', 'INTEGER']]) },
  { id: 'share.rules_granted', phase: 'core', up: (db) => addColumns(db, 'rules', [['granted_by', 'INTEGER'], ['granted_at', 'INTEGER']]) },
  { id: 'share.manage_granted', phase: 'core', up: (db) => addColumns(db, 'manage_grants', [['granted_by', 'INTEGER'], ['granted_at', 'INTEGER']]) },
  { id: 'share.everyone_cloud', phase: 'web', up: (db) => { if (process.env.TDRIVE_CLOUD_TEAM) fillEveryone(db) } },
]
