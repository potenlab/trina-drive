// Tables and columns sharing adds (workstreams A1, A2), run by src/migrations.ts. Idempotent and additive only: an older
// image keeps working on a database this one touched (it never reads these columns).
//   folders.editors_can_share   O1: "Editors can change permissions and share" — NULL = as the folder above (a top
//                               folder's NULL = on), 0 = off here and everywhere below (cannot be turned on below), 1 = on
//   rules.granted_by/at,        who gave the access and when ("Shared with me", the share dialog); NULL = given before
//   manage_grants.granted_by/at  this feature (or by the CLI)
// In cloud mode the Everyone group ("Anyone in Trina") is kept by the member sync (src/tdcloud/people.ts syncEveryone).
//
// File-level sharing (A2, docs/SECURITY-MODEL.md "File shares"):
//   mfiles.uid          the file's identity for grants: 128 random bits, never reused (rowids are). A trigger fills it
//                       for rows an older image inserts; every open backfills any NULL left.
//   mfiles.folder_id,   where a SHARED file was last seen (its parent folder row + on-disk name). Only finds the file:
//   mfiles.name         a grant opens the file only when the walk reaches it with the row's dev/ino/size/mtime.
//   groups.uid          group ids are reused (people-ops deletes groups): a group grant stores the uid it was made for.
//   file_grants         no foreign key (deletes of mfiles rows must never fail: src/managed/core.ts dropRow deletes the
//                       row's grants itself; an older image's orphans match no live uid and are deleted on open).
//   touches.via_file,   provenance reached only through a file share (1) vs a direct read (NULL/0): R4 lets a token see
//   draft_src.via_file  such a draft while it still reads some shared file in that folder (src/drafts.ts).
import { addColumns, type Migration } from '../migrations'

export const shareMigrations: Migration[] = [
  { id: 'share.editors_can_share', phase: 'core', up: (db) => addColumns(db, 'folders', [['editors_can_share', 'INTEGER']]) },
  { id: 'share.rules_granted', phase: 'core', up: (db) => addColumns(db, 'rules', [['granted_by', 'INTEGER'], ['granted_at', 'INTEGER']]) },
  { id: 'share.manage_granted', phase: 'core', up: (db) => addColumns(db, 'manage_grants', [['granted_by', 'INTEGER'], ['granted_at', 'INTEGER']]) },
  // ---- A2: file-level sharing ----
  { id: 'share.mfiles_uid_location', phase: 'core', up: (db) => {
    addColumns(db, 'mfiles', [['uid', 'TEXT'], ['folder_id', 'INTEGER'], ['name', 'TEXT']])
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS mfiles_uid ON mfiles (uid);
      CREATE INDEX IF NOT EXISTS mfiles_folder ON mfiles (folder_id) WHERE folder_id IS NOT NULL;
      CREATE TRIGGER IF NOT EXISTS mfiles_uid_fill AFTER INSERT ON mfiles WHEN NEW.uid IS NULL
        BEGIN UPDATE mfiles SET uid = lower(hex(randomblob(16))) WHERE id = NEW.id; END;
      UPDATE mfiles SET uid = lower(hex(randomblob(16))) WHERE uid IS NULL;`)
  } },
  { id: 'share.groups_uid', phase: 'core', up: (db) => {
    addColumns(db, 'groups', [['uid', 'TEXT']])
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS groups_uid ON groups (uid);
      CREATE TRIGGER IF NOT EXISTS groups_uid_fill AFTER INSERT ON groups WHEN NEW.uid IS NULL
        BEGIN UPDATE groups SET uid = lower(hex(randomblob(16))) WHERE id = NEW.id; END;
      UPDATE groups SET uid = lower(hex(randomblob(16))) WHERE uid IS NULL;`)
  } },
  { id: 'share.file_grants', phase: 'core', up: (db) => db.exec(`
    CREATE TABLE IF NOT EXISTS file_grants (
      file_uid TEXT NOT NULL,
      subject_type TEXT NOT NULL CHECK (subject_type IN ('person','group')), subject_id INTEGER NOT NULL,
      subject_uid TEXT,
      level INTEGER NOT NULL CHECK (level IN (1,2)), granted_by INTEGER, granted_at INTEGER NOT NULL,
      PRIMARY KEY (file_uid, subject_type, subject_id));
    CREATE INDEX IF NOT EXISTS file_grants_subject ON file_grants (subject_type, subject_id);
    DELETE FROM file_grants WHERE file_uid NOT IN (SELECT uid FROM mfiles WHERE uid IS NOT NULL);
    DELETE FROM file_grants WHERE subject_type = 'group' AND NOT EXISTS
      (SELECT 1 FROM groups g WHERE g.id = file_grants.subject_id AND g.uid = file_grants.subject_uid);`) },
  { id: 'share.via_file', phase: 'core', up: (db) => { addColumns(db, 'touches', [['via_file', 'INTEGER']]); addColumns(db, 'draft_src', [['via_file', 'INTEGER']]) } },
  // S16: a share given by mail to someone who is not a member yet; applied when that address becomes an active person
  // (src/share/invites.ts applyShareInvites, called by the member sync), dropped after 30 days
  { id: 'share.invites', phase: 'core', up: (db) => db.exec(`CREATE TABLE IF NOT EXISTS share_invites (
      id INTEGER PRIMARY KEY, email TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('folder','file')), folder_id INTEGER, file_uid TEXT,
      level INTEGER NOT NULL CHECK (level IN (1,2)), granted_by INTEGER NOT NULL, granted_at INTEGER NOT NULL, applied_at INTEGER, dropped_at INTEGER);
    CREATE INDEX IF NOT EXISTS share_invites_email ON share_invites (email) WHERE applied_at IS NULL AND dropped_at IS NULL;`) },
  { id: 'share.audit_person', phase: 'core', up: (db) => db.exec('CREATE INDEX IF NOT EXISTS audit_person ON audit (person_id, id)') },
]
