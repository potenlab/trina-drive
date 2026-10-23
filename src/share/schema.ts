// Tables and columns sharing adds (workstream A1), run by src/migrations.ts. Idempotent and additive only: an older
// image keeps working on a database this one touched (it never reads these columns).
//   folders.editors_can_share   O1: "Editors can change permissions and share" — NULL = as the folder above (a top
//                               folder's NULL = on), 0 = off here and everywhere below (cannot be turned on below), 1 = on
//   rules.granted_by/at,        who gave the access and when ("Shared with me", the share dialog); NULL = given before
//   manage_grants.granted_by/at  this feature (or by the CLI)
// In cloud mode the Everyone group ("Anyone in Trina") is kept by the member sync (src/tdcloud/people.ts syncEveryone).
import { addColumns, type Migration } from '../migrations'

export const shareMigrations: Migration[] = [
  { id: 'share.editors_can_share', phase: 'core', up: (db) => addColumns(db, 'folders', [['editors_can_share', 'INTEGER']]) },
  { id: 'share.rules_granted', phase: 'core', up: (db) => addColumns(db, 'rules', [['granted_by', 'INTEGER'], ['granted_at', 'INTEGER']]) },
  { id: 'share.manage_granted', phase: 'core', up: (db) => addColumns(db, 'manage_grants', [['granted_by', 'INTEGER'], ['granted_at', 'INTEGER']]) },
]
