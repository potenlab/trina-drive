// Tables of managed storage (plan 2.2 "관리 모드": the server owns the data folder; people put files in through the web).
// Additive only: created with the core schema (db.ts), nothing here changes a core table.
//
// Files are known by identity (dev + ino), like folders: a row follows a file through renames and moves (same inode) and
// is moved to the new inode when its content is replaced (write-new-then-rename). size + mtime_ns pin the row to the
// bytes the server wrote, so a file put there by hand (or a reused inode number) is never taken for a tracked one.
export const MANAGED_SCHEMA = `
-- registered folders whose files the server owns (team folders in the managed root)
CREATE TABLE IF NOT EXISTS managed_mounts (folder_id INTEGER PRIMARY KEY REFERENCES folders(id), created_at INTEGER NOT NULL, created_by INTEGER);
-- every live (or trashed) file in managed storage: the current version and who wrote it
CREATE TABLE IF NOT EXISTS mfiles (
  id INTEGER PRIMARY KEY, dev TEXT NOT NULL, ino TEXT NOT NULL, size INTEGER NOT NULL, mtime_ns TEXT NOT NULL, sha256 TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, created_by INTEGER, updated_at INTEGER NOT NULL, updated_by INTEGER,
  UNIQUE (dev, ino));
-- earlier versions of a file (the current one is the file itself); bytes in the versions store, keyed by sha256
CREATE TABLE IF NOT EXISTS mversions (
  file_id INTEGER NOT NULL, version INTEGER NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL,
  created_at INTEGER NOT NULL, created_by INTEGER, replaced_at INTEGER NOT NULL, replaced_by INTEGER,
  PRIMARY KEY (file_id, version));
CREATE INDEX IF NOT EXISTS mversions_sha ON mversions (sha256);
-- deleted items (a file or a whole folder), kept for trashDays. orig_parent = the folder row it was deleted from.
CREATE TABLE IF NOT EXISTS mtrash (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('file','dir')), name TEXT NOT NULL,
  orig_parent INTEGER NOT NULL, orig_vpath TEXT NOT NULL, trash_path TEXT NOT NULL, dev TEXT NOT NULL, ino TEXT NOT NULL,
  size INTEGER NOT NULL, files INTEGER NOT NULL, deleted_at INTEGER NOT NULL, deleted_by INTEGER NOT NULL, purge_after INTEGER NOT NULL,
  restored_at INTEGER, restored_by INTEGER, purged_at INTEGER);
CREATE INDEX IF NOT EXISTS mtrash_live ON mtrash (purge_after) WHERE restored_at IS NULL AND purged_at IS NULL;
-- resumable uploads: bytes arrive in chunks at increasing offsets into a staging file, then are placed in one step
CREATE TABLE IF NOT EXISTS muploads (
  id TEXT PRIMARY KEY, person_id INTEGER NOT NULL, folder_id INTEGER NOT NULL, folder_vpath TEXT NOT NULL, name TEXT NOT NULL,
  size INTEGER NOT NULL, sha256 TEXT, conflict TEXT NOT NULL, received INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open','done','cancelled','expired')), result_path TEXT);
`
