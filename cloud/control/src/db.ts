// The control plane's own database (SQLite, WAL). It never holds a team's files or a team's setup token: only
// accounts, teams, billing state, jobs, backups (object keys and the backup key wrapped by the master key) and the
// audit log of control-plane actions.
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import path from 'node:path'

export type DB = Database

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL,
  verified_at INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS email_tokens (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), kind TEXT NOT NULL,
  secret_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), csrf TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER);
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY, public_id TEXT NOT NULL UNIQUE, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  owner_user_id INTEGER NOT NULL REFERENCES users(id), plan TEXT NOT NULL DEFAULT 'team',
  -- pending_payment | provisioning | active | past_due | suspended | deleting | deleted | failed
  status TEXT NOT NULL,
  -- the per-team uid is uid_base + number; numbers are never reused
  number INTEGER NOT NULL UNIQUE,
  host TEXT, public_ip TEXT,
  subscription_id TEXT UNIQUE, customer_id TEXT, sub_status TEXT, sub_occurred_at TEXT,
  grace_until INTEGER, suspended_at INTEGER, suspend_reason TEXT, delete_after INTEGER, deleted_at INTEGER,
  backup_pub TEXT, backup_key_enc TEXT, last_backup_at INTEGER,
  disk_bytes INTEGER, disk_checked_at INTEGER, over_quota_since INTEGER,
  error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS paddle_events (
  event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, occurred_at TEXT NOT NULL, received_at INTEGER NOT NULL,
  subscription_id TEXT, team_id INTEGER, outcome TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, team_id INTEGER REFERENCES teams(id), run_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, done_at INTEGER, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS jobs_due ON jobs (done_at, run_at);
CREATE TABLE IF NOT EXISTS backups (
  id INTEGER PRIMARY KEY, team_id INTEGER NOT NULL REFERENCES teams(id), at INTEGER NOT NULL, kind TEXT NOT NULL,
  object_key TEXT NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY, at INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, team_id INTEGER,
  detail TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rate (
  key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL);
`

export function openDb(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const db = new Database(file, { create: true, strict: true })
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  db.exec(SCHEMA)
  if (file !== ':memory:') try { fs.chmodSync(file, 0o600) } catch { /* not ours to fix */ }
  return db
}

export interface TeamRow {
  id: number; public_id: string; slug: string; name: string; owner_user_id: number; plan: string; status: TeamStatus
  number: number; host: string | null; public_ip: string | null
  subscription_id: string | null; customer_id: string | null; sub_status: string | null; sub_occurred_at: string | null
  grace_until: number | null; suspended_at: number | null; suspend_reason: string | null; delete_after: number | null; deleted_at: number | null
  backup_pub: string | null; backup_key_enc: string | null; last_backup_at: number | null
  disk_bytes: number | null; disk_checked_at: number | null; over_quota_since: number | null
  error: string | null; created_at: number; updated_at: number
}
export type TeamStatus = 'pending_payment' | 'provisioning' | 'active' | 'past_due' | 'suspended' | 'deleting' | 'deleted' | 'failed'

export const teamBySlug = (db: DB, slug: string) => db.query<TeamRow, [string]>('SELECT * FROM teams WHERE slug = ?').get(slug)
export const teamById = (db: DB, id: number) => db.query<TeamRow, [number]>('SELECT * FROM teams WHERE id = ?').get(id)
export const teamByPublicId = (db: DB, pid: string) => db.query<TeamRow, [string]>('SELECT * FROM teams WHERE public_id = ?').get(pid)
export const teamBySubscription = (db: DB, sub: string) => db.query<TeamRow, [string]>('SELECT * FROM teams WHERE subscription_id = ?').get(sub)

export function updateTeam(db: DB, id: number, fields: Partial<Omit<TeamRow, 'id'>>) {
  const keys = Object.keys(fields)
  if (!keys.length) return
  for (const k of keys) if (!/^[a-z_]+$/.test(k)) throw new Error(`bad column ${k}`)
  db.query(`UPDATE teams SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...(keys.map((k) => (fields as Record<string, string | number | null>)[k] ?? null)), Date.now(), id)
}
