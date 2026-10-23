// Control-database tables and columns of the console (workstream D1): team_members, invites, sso_keys, team_usage,
// users.public_id / users.name, teams.callback_hash, teams.sync_seq … (plan 2.2, 10.2). Run by ./index.ts after
// db.ts's schema. Idempotent: CREATE … IF NOT EXISTS, addColumns().
import type { ControlMigration } from './types'

export const consoleMigrations: ControlMigration[] = []
