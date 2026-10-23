// Tables the web side adds (people's sign-in, sessions, links, notices, folder history). Kept apart from db.ts so the
// core schema stays the agent side's; ensureWebSchema is idempotent and runs when the web handler is made.
import type { DB } from '../db'
import { runMigrations } from '../migrations'

const WEB_SCHEMA = `
-- a person who can sign in on the web; people made only by the CLI have no row here until invited
CREATE TABLE IF NOT EXISTS accounts (
  person_id INTEGER PRIMARY KEY REFERENCES people(id), email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT, created_at INTEGER NOT NULL, password_set_at INTEGER);
-- web sessions: only the sha256 of the cookie value is kept
CREATE TABLE IF NOT EXISTS web_sessions (
  id_hash TEXT PRIMARY KEY, person_id INTEGER NOT NULL REFERENCES people(id), csrf TEXT NOT NULL,
  created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER,
  user_agent TEXT);
-- one-time links: invite (set a first password) and reset (set a new one); only the hash of the secret is kept
CREATE TABLE IF NOT EXISTS web_links (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('invite','reset')), secret_hash TEXT NOT NULL UNIQUE,
  person_id INTEGER NOT NULL REFERENCES people(id), created_by INTEGER, created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, used_at INTEGER);
-- in-web notices (R9/R11): kind, count and a link only; details are behind sign-in and the R7 filter
CREATE TABLE IF NOT EXISTS notices (
  id INTEGER PRIMARY KEY, person_id INTEGER NOT NULL REFERENCES people(id), kind TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1, link TEXT NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER);
-- the last time a session's person typed their password again (fresh login for sensitive actions, e.g. provenance reset)
CREATE TABLE IF NOT EXISTS web_reauth (id_hash TEXT PRIMARY KEY, at INTEGER NOT NULL);
-- what changed on a folder and the value before (R5 "keep the previous NAS readers", R9 former personal folders)
CREATE TABLE IF NOT EXISTS folder_history (
  id INTEGER PRIMARY KEY, folder_id INTEGER NOT NULL, at INTEGER NOT NULL, by_person INTEGER, field TEXT NOT NULL,
  old_value TEXT, new_value TEXT);
`

const done = new WeakSet<DB>()

export function ensureWebSchema(db: DB) {
  if (done.has(db)) return
  db.exec(WEB_SCHEMA)
  // feature modules' columns on the web tables (src/migrations.ts)
  runMigrations(db, 'web')
  done.add(db)
}

export const metaGet = (db: DB, key: string) => db.query<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?').get(key)?.value
export const metaSet = (db: DB, key: string, value: string | null) => value === null
  ? db.query('DELETE FROM meta WHERE key = ?').run(key)
  : db.query('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value)
