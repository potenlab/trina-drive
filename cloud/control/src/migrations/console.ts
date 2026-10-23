// Control-database tables and columns of the console (workstream D1): team_members, invites, sso_keys, team_usage,
// sync_events, login_tickets, users.public_id / users.name / TOTP, sessions.amr / auth_time / totp_at,
// teams.callback_hash / sync_seq … (plan 2.2, 10.2). Run by ./index.ts after db.ts's schema. Idempotent and additive
// only (CREATE … IF NOT EXISTS, addColumns): an older control image still runs on a database this one touched.
import crypto from 'node:crypto'
import type { DB } from '../db'
import { addColumns } from './index'
import type { ControlMigration } from './types'

const TABLES = `
-- who belongs to which team (plan 2.2; the console is the source, a team's drive gets a projection by member sync).
-- role: owner | admin | member. status: active | removed. Exactly one active owner per team (teams.owner_user_id).
CREATE TABLE IF NOT EXISTS team_members (
  team_id INTEGER NOT NULL REFERENCES teams(id), user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
  status TEXT NOT NULL CHECK (status IN ('active','removed')),
  added_by INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, synced_at INTEGER,
  PRIMARY KEY (team_id, user_id));
CREATE INDEX IF NOT EXISTS team_members_user ON team_members (user_id, status);
-- an invite is bound to one address (review #7): only an account whose confirmed email is that address can accept it.
-- Only the secret's hash is kept. via: console | drive (the drive's share dialog through the team callback)
CREATE TABLE IF NOT EXISTS invites (
  id INTEGER PRIMARY KEY, team_id INTEGER NOT NULL REFERENCES teams(id), email TEXT NOT NULL COLLATE NOCASE,
  role TEXT NOT NULL CHECK (role IN ('admin','member')), secret_hash TEXT NOT NULL UNIQUE,
  invited_by INTEGER NOT NULL, via TEXT NOT NULL DEFAULT 'console',
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_sent_at INTEGER,
  accepted_at INTEGER, accepted_user_id INTEGER, revoked_at INTEGER, linked_at INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS invites_open ON invites (team_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL;
-- SSO signing keys (Ed25519). The private key is wrapped by the KeyWrapper (KMS in production, context
-- {purpose: 'sso', kid}). state: next (published to teams, not signing yet) | active (signs) | retired
CREATE TABLE IF NOT EXISTS sso_keys (
  kid TEXT PRIMARY KEY, public_key TEXT NOT NULL, private_key_enc TEXT NOT NULL, state TEXT NOT NULL,
  created_at INTEGER NOT NULL, activated_at INTEGER, retired_at INTEGER);
-- what the team's drive reported (cloud usage --json), shown on Plan & usage
CREATE TABLE IF NOT EXISTS team_usage (
  team_id INTEGER PRIMARY KEY REFERENCES teams(id), at INTEGER NOT NULL,
  people INTEGER, ai_people_30d INTEGER, files_bytes INTEGER, trash_bytes INTEGER, versions_bytes INTEGER,
  quota_bytes INTEGER, last_activity_at INTEGER);
-- member-sync events a desired state cannot say (contract: member.removed, member.sessions_revoked, invite.revoked).
-- Sent with every payload until a payload carrying them is applied (delivered_seq).
CREATE TABLE IF NOT EXISTS sync_events (
  id INTEGER PRIMARY KEY, team_id INTEGER NOT NULL REFERENCES teams(id), type TEXT NOT NULL,
  cloud_user TEXT, invite TEXT, reason TEXT, at INTEGER NOT NULL, sent_seq INTEGER, delivered_seq INTEGER);
CREATE INDEX IF NOT EXISTS sync_events_pending ON sync_events (team_id, delivered_seq);
-- early-access requests from /signup while Free sign-up is closed and payment is not live (plan 10.1, O2)
CREATE TABLE IF NOT EXISTS access_requests (
  id INTEGER PRIMARY KEY, email TEXT NOT NULL COLLATE NOCASE, team_name TEXT NOT NULL, team_size TEXT, note TEXT,
  plan TEXT, ip TEXT, created_at INTEGER NOT NULL, handled_at INTEGER);
-- the second step of a sign-in (password or email link, then the authenticator code); only the hash is kept
CREATE TABLE IF NOT EXISTS login_tickets (
  id_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), amr TEXT NOT NULL, next TEXT,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0);
`

export const consoleMigrations: ControlMigration[] = [
  {
    id: 'console-v1',
    up(db: DB) {
      db.exec(TABLES)
      addColumns(db, 'users', [
        // usr_ + 20 hex: the SSO subject (assertion sub, the drive's accounts.cloud_user); never reused
        ['public_id', 'TEXT'], ['name', 'TEXT'],
        // TOTP (finding 3): the secret wrapped by the KeyWrapper; a pending one while enrolling; the last step used
        // (replay); recovery codes as sha256 hashes (JSON array)
        ['totp_secret_enc', 'TEXT'], ['totp_pending_enc', 'TEXT'], ['totp_enabled_at', 'INTEGER'], ['totp_last_step', 'INTEGER'],
        ['recovery_hashes', 'TEXT'], ['password_set', 'INTEGER'],
      ])
      // how a console session was made (assertion amr), when the password/link was last used (auth_time), and when an
      // authenticator code was last checked in it (TOTP step-up, 5 minutes)
      addColumns(db, 'sessions', [['amr', 'TEXT'], ['auth_time', 'INTEGER'], ['totp_at', 'INTEGER'], ['last_seen_at', 'INTEGER'], ['ip', 'TEXT']])
      addColumns(db, 'teams', [
        // the team callback token's sha256 (the drive's TDRIVE_CLOUD_CALLBACK_TOKEN); the previous one stays valid until
        // the next env write, so a failed recreate does not lock the drive out
        ['callback_hash', 'TEXT'], ['callback_prev_hash', 'TEXT'],
        // member sync (sync.ts): the per-team strictly increasing seq; the newest the drive applied; membership version
        // (bumped on every change) and the version the drive has; last success; failures (shown red in Members)
        ['sync_seq', 'INTEGER NOT NULL DEFAULT 0'], ['sync_applied_seq', 'INTEGER'],
        ['member_version', 'INTEGER NOT NULL DEFAULT 0'], ['synced_version', 'INTEGER NOT NULL DEFAULT 0'],
        ['sync_at', 'INTEGER'], ['sync_error', 'TEXT'], ['sync_failing_since', 'INTEGER'], ['sync_unmanaged', 'TEXT'],
        ['usage_checked_at', 'INTEGER'],
      ])
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_public_id ON users (public_id) WHERE public_id IS NOT NULL')
      // backfill: every account gets its public id; every team its owner as a member (plan 2.2 "이전")
      for (const u of db.query<{ id: number }, []>('SELECT id FROM users WHERE public_id IS NULL').all()) {
        db.query('UPDATE users SET public_id = ? WHERE id = ?').run(`usr_${crypto.randomBytes(10).toString('hex')}`, u.id)
      }
      db.exec(`INSERT OR IGNORE INTO team_members (team_id, user_id, role, status, created_at, updated_at)
        SELECT id, owner_user_id, 'owner', 'active', created_at, created_at FROM teams WHERE status != 'deleted'`)
    },
  },
]
