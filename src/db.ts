import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { INPLACE_SCHEMA } from './inplace/schema'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, admin INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS groups (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS memberships (
  group_id INTEGER NOT NULL REFERENCES groups(id), person_id INTEGER NOT NULL REFERENCES people(id),
  PRIMARY KEY (group_id, person_id));
-- Every folder the server knows, keyed by filesystem identity; path is only where it was last seen.
-- registered = an admin registered it (a mount at / unless it sits inside another registered folder).
CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY, dev TEXT NOT NULL, ino TEXT NOT NULL, path TEXT NOT NULL,
  registered INTEGER NOT NULL DEFAULT 0, mount_name TEXT,
  inherit_break INTEGER NOT NULL DEFAULT 0,
  no_ai INTEGER NOT NULL DEFAULT 0, quarantine INTEGER NOT NULL DEFAULT 0, widened_pending INTEGER NOT NULL DEFAULT 0,
  personal_owner INTEGER REFERENCES people(id),
  nas_readers TEXT, -- registered folders: "all" | "unknown" | JSON array of person ids
  UNIQUE (dev, ino));
CREATE TABLE IF NOT EXISTS rules (
  folder_id INTEGER NOT NULL REFERENCES folders(id), subject_type TEXT NOT NULL CHECK (subject_type IN ('person','group')),
  subject_id INTEGER NOT NULL, level INTEGER NOT NULL CHECK (level IN (0,1,2)),
  PRIMARY KEY (folder_id, subject_type, subject_id));
CREATE TABLE IF NOT EXISTS manage_grants (
  folder_id INTEGER NOT NULL REFERENCES folders(id), person_id INTEGER NOT NULL REFERENCES people(id),
  PRIMARY KEY (folder_id, person_id));
CREATE TABLE IF NOT EXISTS tokens (
  id INTEGER PRIMARY KEY, person_id INTEGER NOT NULL REFERENCES people(id), name TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE, hint TEXT NOT NULL, scope TEXT, read_only INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, expires_at INTEGER, revoked_at INTEGER, last_used_at INTEGER, last_client TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS tokens_name ON tokens (person_id, name);
-- provenance window: the last time each token touched each folder, strongly (content out) or weakly
CREATE TABLE IF NOT EXISTS touches (
  token_id INTEGER NOT NULL, folder_id INTEGER NOT NULL, strong_at INTEGER, weak_at INTEGER,
  PRIMARY KEY (token_id, folder_id));
CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY, token_id INTEGER NOT NULL REFERENCES tokens(id), person_id INTEGER NOT NULL REFERENCES people(id),
  path TEXT NOT NULL, created_at INTEGER NOT NULL, deleted_at INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS drafts_live ON drafts (token_id, path) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS draft_versions (
  draft_id INTEGER NOT NULL REFERENCES drafts(id), version INTEGER NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL,
  created_at INTEGER NOT NULL, PRIMARY KEY (draft_id, version));
-- Src(d): only ever grows (strong stays strong)
CREATE TABLE IF NOT EXISTS draft_src (
  draft_id INTEGER NOT NULL REFERENCES drafts(id), folder_id INTEGER NOT NULL, strong INTEGER NOT NULL,
  PRIMARY KEY (draft_id, folder_id));
-- text mirror: file identity + size + mtime -> content hash (mirror file named by hash)
CREATE TABLE IF NOT EXISTS mirror (
  dev TEXT NOT NULL, ino TEXT NOT NULL, size INTEGER NOT NULL, mtime_ns TEXT NOT NULL,
  sha256 TEXT NOT NULL, status TEXT NOT NULL, message TEXT,
  PRIMARY KEY (dev, ino, size, mtime_ns));
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY, at INTEGER NOT NULL, person_id INTEGER, token_id INTEGER, tool TEXT NOT NULL,
  command TEXT NOT NULL, command_sha256 TEXT NOT NULL, files TEXT NOT NULL, outcome TEXT NOT NULL,
  prev_hash TEXT NOT NULL, hash TEXT NOT NULL);
`

export type DB = Database

export function openDb(dataDir: string): DB {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const db = new Database(path.join(dataDir, 'store.db'), { create: true, strict: true })
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  db.exec(SCHEMA)
  db.exec(INPLACE_SCHEMA)
  return db
}
