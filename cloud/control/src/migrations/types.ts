import type { DB } from '../db'

/** A control-database change a module contributes; `up` runs on every open, so it must be idempotent and additive. */
export interface ControlMigration { id: string; up: (db: DB) => void }
