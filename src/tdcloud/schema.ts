// Tables and columns Trina Cloud mode adds to the product database (workstream B1), run by src/migrations.ts, e.g.
//   { id: 'tdcloud.accounts_cloud_user', phase: 'web', up: (db) => addColumns(db, 'accounts', [['cloud_user', 'TEXT']]) }
//   { id: 'tdcloud.sso_used', phase: 'core', up: (db) => db.exec('CREATE TABLE IF NOT EXISTS sso_used (…)') }
// ('web' for columns on accounts / web_sessions: those tables are made by src/web/schema.ts.)
import type { Migration } from '../migrations'

export const cloudMigrations: Migration[] = []
