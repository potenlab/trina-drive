// Tables of the OAuth 2.1 authorization server (src/oauth). An OAuth grant is a row in `tokens` (kind 'oauth') so the
// one policy path (Access.forToken: person ∩ token scope, read-only, "No AI") applies to it exactly as to a personal
// access token, provenance and drafts attach to it, the connection list shows it and revoking it cuts every access
// and refresh token issued under it at once. Only sha256 hashes of secrets (codes, access and refresh tokens) are kept.
import type { DB } from '../db'

const OAUTH_SCHEMA = `
-- clients: a Client ID Metadata Document (client_id = its https URL, fetched and cached) or a dynamically registered one
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('cimd','dcr')), name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL, -- JSON array
  domain TEXT NOT NULL,        -- cimd: host of the client_id URL (fetched over https); dcr: host of the first redirect URI (self-declared)
  created_at INTEGER NOT NULL, fetched_at INTEGER, fresh_until INTEGER, created_ip_hash TEXT);
-- an authorization request waiting for a signed-in person's decision (the consent page reads it by its id)
CREATE TABLE IF NOT EXISTS oauth_requests (
  id_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, state TEXT, code_challenge TEXT NOT NULL,
  resource TEXT NOT NULL, scope TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, decided_at INTEGER);
-- authorization codes: one use, 60 s; the grant is made when the code is exchanged
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, code_challenge TEXT NOT NULL,
  resource TEXT NOT NULL, person_id INTEGER NOT NULL REFERENCES people(id), scope_folders TEXT, read_only INTEGER NOT NULL,
  granted_scope TEXT NOT NULL, grant_ttl_ms INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  used_at INTEGER, grant_id INTEGER);
-- access and refresh tokens under a grant (tokens.id); a refresh token is used once (rotation), used_at marks it spent
CREATE TABLE IF NOT EXISTS oauth_tokens (
  hash TEXT PRIMARY KEY, grant_id INTEGER NOT NULL REFERENCES tokens(id), kind TEXT NOT NULL CHECK (kind IN ('access','refresh')),
  resource TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER, revoked_at INTEGER);
CREATE INDEX IF NOT EXISTS oauth_tokens_grant ON oauth_tokens (grant_id);
`

const done = new WeakSet<DB>()

/** Idempotent; openDb runs it, so `tokens.kind` exists everywhere. */
export function ensureOAuthSchema(db: DB) {
  if (done.has(db)) return
  const cols = new Set(db.query<{ name: string }, []>('PRAGMA table_info(tokens)').all().map((c) => c.name))
  // 'pat' = personal access token (Bearer secret shown once); 'oauth' = a grant made on the consent page
  if (!cols.has('kind')) db.exec(`ALTER TABLE tokens ADD COLUMN kind TEXT NOT NULL DEFAULT 'pat'`)
  if (!cols.has('client_id')) db.exec('ALTER TABLE tokens ADD COLUMN client_id TEXT')
  db.exec(OAUTH_SCHEMA)
  done.add(db)
}
