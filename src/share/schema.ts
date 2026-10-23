// Tables and columns sharing adds (workstream A1), run by src/migrations.ts. Idempotent and additive, e.g.
//   { id: 'share.editors_can_share', phase: 'core', up: (db) => addColumns(db, 'folders', [['editors_can_share', 'INTEGER']]) }
import type { Migration } from '../migrations'

export const shareMigrations: Migration[] = []
