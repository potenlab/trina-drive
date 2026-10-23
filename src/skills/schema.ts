// Tables of team skills (plan 4.2 "저장", workstream I1), run by src/migrations.ts. Idempotent and additive only.
//   skill_libraries  folders an Admin made a skill library (slug = the first segment of the skill's qualified name)
//   skill_versions   every version of a skill the server has seen, by manifest digest; agents get only 'approved' ones.
//                    The bytes of each file live content-addressed in the drafts blob store (<aa>/<sha256>; backed up with it).
//   skill_problems   the latest reason a skill folder could not be read as a skill (shown on the web, never served)
import type { Migration } from '../migrations'

export const SKILLS_SCHEMA = `
CREATE TABLE IF NOT EXISTS skill_libraries (
  folder_id INTEGER PRIMARY KEY REFERENCES folders(id), slug TEXT NOT NULL UNIQUE, by_person INTEGER, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS skill_versions (
  id INTEGER PRIMARY KEY, library_id INTEGER NOT NULL, name TEXT NOT NULL, digest TEXT NOT NULL,
  manifest TEXT NOT NULL,      -- JSON [{path, sha256, size}] sorted by path; digest = sha256 of this text
  frontmatter TEXT NOT NULL,   -- JSON, the SKILL.md frontmatter as written
  description TEXT NOT NULL,
  editors TEXT NOT NULL,       -- JSON [person id | null]: who changed the files since the approved version (null = unknown)
  warnings TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','superseded')),
  proposed_at INTEGER NOT NULL, decided_by INTEGER, decided_at INTEGER, reason TEXT,
  UNIQUE (library_id, name, digest));
CREATE INDEX IF NOT EXISTS skill_versions_status ON skill_versions (status);
CREATE TABLE IF NOT EXISTS skill_problems (
  library_id INTEGER NOT NULL, name TEXT NOT NULL, error TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (library_id, name));
`

export const skillMigrations: Migration[] = [
  { id: 'skills.tables', phase: 'core', up: (db) => db.exec(SKILLS_SCHEMA) },
]
