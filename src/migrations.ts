// Schema changes that feature modules contribute (W0 seams): each module keeps its own list, this file runs them all.
// A module adds a migration to its own list, never db.ts or web/schema.ts:
//   src/share/schema.ts    shareMigrations    (workstream A1: e.g. folders.editors_can_share)
//   src/tdcloud/schema.ts  cloudMigrations    (workstream B1: accounts.cloud_user, sso_used, …)
// phase 'core' runs in openDb (db.ts) after the core, in-place, managed and OAuth tables exist; phase 'web' runs in
// ensureWebSchema (web/schema.ts) after the web tables (accounts, sessions, …) exist. Every `up` runs on every open, so
// it must be idempotent: CREATE … IF NOT EXISTS, and addColumns() for columns on existing tables. Additive only (old
// images must keep working on a database a newer one touched: never drop, rename or tighten).
import type { Database } from 'bun:sqlite'
import { shareMigrations } from './share/schema'
import { cloudMigrations } from './tdcloud/schema'

export interface Migration {
  /** unique, e.g. 'share.editors_can_share' */
  id: string
  phase: 'core' | 'web'
  up: (db: Database) => void
}

export const MIGRATIONS: Migration[] = [...shareMigrations, ...cloudMigrations]

/** Columns added to an existing table when missing ([name, declaration], e.g. ['cloud_user', 'TEXT']). */
export function addColumns(db: Database, table: string, columns: [name: string, decl: string][]) {
  if (!/^[a-z_]+$/.test(table)) throw new Error(`bad table ${table}`)
  const have = new Set(db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((c) => c.name))
  for (const [name, decl] of columns) {
    if (!/^[a-z_]+$/.test(name)) throw new Error(`bad column ${name}`)
    if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`)
  }
}

export function runMigrations(db: Database, phase: Migration['phase'], list: Migration[] = MIGRATIONS) {
  for (const m of list) if (m.phase === phase) m.up(db)
}
