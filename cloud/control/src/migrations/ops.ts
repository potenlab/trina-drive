// Control-database changes for operations (workstream G1), run by ./index.ts after db.ts's schema. Idempotent and
// additive (an older control image ignores these tables).
import type { ControlMigration } from './types'

export const opsMigrations: ControlMigration[] = [
  {
    // `teams retry --reset-host` provisions a team again from scratch, which gives it new backup keys: the old ones
    // stay here (wrapped by the master key exactly as before), so the backups made before the reset can still be
    // opened (`teams export` reads teams.backup_key_enc; an operator restores old ones with these, README "Restore").
    id: 'ops-retired-backup-keys',
    up: (db) => db.exec(`CREATE TABLE IF NOT EXISTS retired_backup_keys (
      id INTEGER PRIMARY KEY, team_id INTEGER NOT NULL REFERENCES teams(id), backup_pub TEXT NOT NULL,
      backup_key_enc TEXT NOT NULL, host TEXT, retired_at INTEGER NOT NULL, reason TEXT NOT NULL)`),
  },
]
