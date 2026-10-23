// Control-database changes that modules contribute (W0 seams), run by openDb (db.ts) after its SCHEMA and
// ADDED_COLUMNS. A module adds to its own list:
//   ./console.ts  consoleMigrations  (workstream D1)
//   ./ops.ts      opsMigrations      (workstream G1)
// Additive only: an older control image must still run on a database a newer one touched.
import type { DB } from '../db'
import { consoleMigrations } from './console'
import { opsMigrations } from './ops'
import type { ControlMigration } from './types'

export const CONTROL_MIGRATIONS: ControlMigration[] = [...consoleMigrations, ...opsMigrations]

/** Columns added to an existing table when missing. */
export function addColumns(db: DB, table: string, columns: [name: string, decl: string][]) {
  if (!/^[a-z_]+$/.test(table)) throw new Error(`bad table ${table}`)
  const have = new Set(db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((c) => c.name))
  for (const [name, decl] of columns) {
    if (!/^[a-z_]+$/.test(name)) throw new Error(`bad column ${name}`)
    if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`)
  }
}

export function runControlMigrations(db: DB, list: ControlMigration[] = CONTROL_MIGRATIONS) {
  for (const m of list) m.up(db)
}
