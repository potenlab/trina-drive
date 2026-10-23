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
-- the team hosts as the scaler knows them (scaler.ts); the pool (ASG) is the truth for what runs, this is what the
-- control plane decided and saw: booting | ready | draining | terminating | gone | lost
CREATE TABLE IF NOT EXISTS hosts (
  id TEXT PRIMARY KEY, state TEXT NOT NULL, first_seen INTEGER NOT NULL, ready_at INTEGER, empty_since INTEGER,
  last_probe INTEGER, online INTEGER NOT NULL DEFAULT 1, public_ip TEXT, volumes TEXT,
  -- 1: never scaled in (operator's \`hosts keep\`, or team data found that no team row names)
  keep INTEGER NOT NULL DEFAULT 0,
  note TEXT, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
-- Free plan sign-ups (free.ts): email + team name, confirmed by a one-time link (only its hash here), then a team.
-- email_key: the address as one mailbox (lower case, no +tag, no dots for Gmail) for "one free team per email".
-- status: pending | provisioned | waitlisted | refused | admitted
CREATE TABLE IF NOT EXISTS free_signups (
  id INTEGER PRIMARY KEY, email TEXT NOT NULL COLLATE NOCASE, email_key TEXT NOT NULL, name TEXT NOT NULL, slug TEXT,
  ip TEXT, secret_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  verified_at INTEGER, status TEXT NOT NULL, team_id INTEGER REFERENCES teams(id), note TEXT);
CREATE INDEX IF NOT EXISTS free_signups_key ON free_signups (email_key);
`

/** columns added after a table was first made (CREATE TABLE IF NOT EXISTS leaves an existing table alone) */
const ADDED_COLUMNS: [table: string, column: string, decl: string][] = [
  // a paid team with no host to go on yet (scale-out in progress, or the host limit reached)
  ['teams', 'waiting_since', 'INTEGER'],
  ['teams', 'wait_alerted_at', 'INTEGER'],
  // Free plan (free.ts): when people last used the team (the product's `tdrive activity`, or the time it started),
  // when that was last asked, the idle warning, the inactivity pause (kept across a wake nobody followed up on), the
  // deletion warnings sent while paused, and a wake from the paused page that still waits for real use
  ['teams', 'last_activity_at', 'INTEGER'],
  ['teams', 'activity_checked_at', 'INTEGER'],
  ['teams', 'idle_warned_at', 'INTEGER'],
  ['teams', 'paused_at', 'INTEGER'],
  ['teams', 'delete_warnings', 'INTEGER NOT NULL DEFAULT 0'],
  ['teams', 'woke_at', 'INTEGER'],
]

export function openDb(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const db = new Database(file, { create: true, strict: true })
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  db.exec(SCHEMA)
  for (const [table, column, decl] of ADDED_COLUMNS) {
    if (!db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`)
  }
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
  waiting_since: number | null; wait_alerted_at: number | null
  last_activity_at: number | null; activity_checked_at: number | null; idle_warned_at: number | null; paused_at: number | null
  delete_warnings: number; woke_at: number | null
}

export type HostState = 'booting' | 'ready' | 'draining' | 'terminating' | 'gone' | 'lost'
export interface HostRow {
  id: string; state: HostState; first_seen: number; ready_at: number | null; empty_since: number | null
  last_probe: number | null; online: number; public_ip: string | null; volumes: string | null; keep: number
  note: string | null; updated_at: number
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
