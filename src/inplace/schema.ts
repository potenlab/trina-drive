// Tables of the in-place reconciler (plan 2.2, 4.1 R1 ⑤–⑦, R6, R10). Additive only: nothing here changes a core table.
export const INPLACE_SCHEMA = `
-- Roots walked besides the registered folders (e.g. the whole NAS share the server account sees).
CREATE TABLE IF NOT EXISTS share_roots (path TEXT PRIMARY KEY, dev TEXT NOT NULL, ino TEXT NOT NULL, added_at INTEGER NOT NULL);
-- File identity index: one row per path seen by the last reconcile (identity + hash only, never content).
CREATE TABLE IF NOT EXISTS fs_index (
  path TEXT PRIMARY KEY, root TEXT NOT NULL, dev TEXT NOT NULL, ino TEXT NOT NULL,
  kind TEXT NOT NULL,                -- file | dir | symlink | other
  size INTEGER NOT NULL, mtime_ns TEXT NOT NULL, birth_ns TEXT NOT NULL, nlink INTEGER NOT NULL,
  sha256 TEXT, hashed_key TEXT,      -- hashed_key = dev:ino:size:mtime:ctime the hash belongs to
  sniff TEXT,                        -- 'xsym' | 'alias' found in the content (with the hash)
  closed TEXT,                       -- why R1 ⑤ / NFC closes this path, if it does
  seen_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS fs_index_identity ON fs_index (dev, ino);
CREATE INDEX IF NOT EXISTS fs_index_root ON fs_index (root);
CREATE INDEX IF NOT EXISTS fs_index_closed ON fs_index (dev, ino) WHERE closed IS NOT NULL;
-- Things the admin (and manage holders) should hear about. notify: JSON {admins, manage, sourceManage, targetManage}.
CREATE TABLE IF NOT EXISTS fs_events (
  id INTEGER PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL,
  path TEXT, old_path TEXT, dev TEXT, ino TEXT, folder_id INTEGER,
  detail TEXT NOT NULL DEFAULT '{}', notify TEXT NOT NULL DEFAULT '{}');
-- Closed for agents until released. kind: moved (R10 widening move, identity closed), widened (R6 copy pending,
-- identity closed), lost (a rule-bearing folder's identity vanished: its last path stays closed for any other identity).
CREATE TABLE IF NOT EXISTS quarantine (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('moved','widened','lost')),
  item TEXT NOT NULL CHECK (item IN ('file','dir')), dev TEXT NOT NULL, ino TEXT NOT NULL, path TEXT NOT NULL,
  folder_id INTEGER, widened_id INTEGER, event_id INTEGER, reason TEXT NOT NULL,
  created_at INTEGER NOT NULL, released_at INTEGER, released_by INTEGER);
CREATE INDEX IF NOT EXISTS quarantine_live ON quarantine (dev, ino) WHERE released_at IS NULL;
-- R6: a NAS file whose content came from a draft. Never deleted. status: tracked (not widening when last judged),
-- pending (widening, closed to agents until a source manage holder or the admin confirms), confirmed.
CREATE TABLE IF NOT EXISTS widened (
  id INTEGER PRIMARY KEY, at INTEGER NOT NULL, dev TEXT NOT NULL, ino TEXT NOT NULL, path TEXT NOT NULL, sha256 TEXT NOT NULL,
  draft_id INTEGER NOT NULL, draft_version INTEGER NOT NULL, writer_person_id INTEGER NOT NULL, writer_token_id INTEGER NOT NULL,
  target_folder_id INTEGER NOT NULL, match TEXT NOT NULL, overlap REAL NOT NULL,
  widening INTEGER NOT NULL, ever_widening INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('tracked','pending','confirmed')),
  judged_at INTEGER NOT NULL, confirmed_at INTEGER, confirmed_by INTEGER,
  UNIQUE (dev, ino, draft_id));
CREATE INDEX IF NOT EXISTS draft_versions_sha ON draft_versions (sha256);
`
