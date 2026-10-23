// Control-database changes for operations (workstream G1), run by ./index.ts after db.ts's schema. Idempotent.
import type { ControlMigration } from './types'

export const opsMigrations: ControlMigration[] = []
