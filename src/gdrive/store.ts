// People's Google connections: one per person, the refresh token (and the current access token) sealed with the
// server's data key (src/secretbox.ts, purpose bound to the person), the Google account's address for display, and
// OAuth round-trip states (only the sha256 of the state is kept; the browser that started it is bound by a cookie).
import crypto from 'node:crypto'
import type { DB } from '../db'
import { dataKey, open, seal } from '../secretbox'
import { sha256 } from '../store'
import { GDRIVE_LIMITS, SCOPE_FILE, SCOPE_READONLY, type GoogleConfig } from './config'
import { emailOfIdToken, GoogleClient, GoogleError, type TokenResponse } from './google'

export const GDRIVE_SCHEMA = `
CREATE TABLE IF NOT EXISTS gdrive_connections (
  person_id INTEGER PRIMARY KEY REFERENCES people(id), email TEXT, scope TEXT NOT NULL,
  refresh_sealed TEXT NOT NULL, access_sealed TEXT, access_expires INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, broken_at INTEGER);
CREATE TABLE IF NOT EXISTS gdrive_states (
  state_hash TEXT PRIMARY KEY, person_id INTEGER NOT NULL, browser_hash TEXT NOT NULL, verifier TEXT NOT NULL,
  redirect_uri TEXT NOT NULL, return_path TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
-- a Google file imported into a folder (folder row id): importing it into that folder again makes a new version of the
-- same Trina file (mfiles.id follows it through renames and replaces), unless Google says it did not change
CREATE TABLE IF NOT EXISTS gdrive_files (
  drive_id TEXT NOT NULL, folder_id INTEGER NOT NULL, file_id INTEGER NOT NULL, modified_time TEXT, drive_version TEXT,
  mime TEXT, imported_at INTEGER NOT NULL, imported_by INTEGER NOT NULL, PRIMARY KEY (drive_id, folder_id));
`
const ready = new WeakSet<DB>()
export function ensureGdriveSchema(db: DB) { if (!ready.has(db)) { db.exec(GDRIVE_SCHEMA); ready.add(db) } }

const b64u = (n: number) => crypto.randomBytes(n).toString('base64url')
const P = (personId: number, what: 'refresh' | 'access') => `gdrive:${what}:${personId}`

export interface Connection { person_id: number; email: string | null; scope: string; refresh_sealed: string; access_sealed: string | null; access_expires: number; created_at: number; updated_at: number; broken_at: number | null }

export const connectionOf = (db: DB, personId: number) => { ensureGdriveSchema(db); return db.query<Connection, [number]>('SELECT * FROM gdrive_connections WHERE person_id = ?').get(personId) }

/** A new round trip: the state for Google, the binding for this browser's cookie, PKCE. */
export function newState(db: DB, personId: number, redirectUri: string, returnPath: string | null) {
  ensureGdriveSchema(db)
  const state = b64u(32), browser = b64u(32), verifier = b64u(48), now = Date.now()
  db.query('DELETE FROM gdrive_states WHERE expires_at <= ? OR person_id = ?').run(now, personId)
  db.query('INSERT INTO gdrive_states (state_hash, person_id, browser_hash, verifier, redirect_uri, return_path, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(sha256(state), personId, sha256(browser), verifier, redirectUri, returnPath, now, now + GDRIVE_LIMITS.stateTtlMs)
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  return { state, browser, challenge }
}

/** Use a state up (once), checking that the same browser started it. */
export function takeState(db: DB, state: unknown, browser: string | undefined) {
  ensureGdriveSchema(db)
  if (typeof state !== 'string' || state.length > 100 || !browser || browser.length > 100) return null
  const r = db.query<{ person_id: number; browser_hash: string; verifier: string; redirect_uri: string; return_path: string | null; expires_at: number; used_at: number | null }, [string]>(
    'SELECT * FROM gdrive_states WHERE state_hash = ?').get(sha256(state))
  if (!r || r.used_at || r.expires_at <= Date.now()) return null
  if (!crypto.timingSafeEqual(Buffer.from(sha256(browser)), Buffer.from(r.browser_hash))) return null
  if (db.query('UPDATE gdrive_states SET used_at = ? WHERE state_hash = ? AND used_at IS NULL').run(Date.now(), sha256(state)).changes !== 1) return null
  return r
}

export class NotConnected extends Error {}

/** Keep (or replace) a person's connection from a token response. */
export function saveConnection(db: DB, dataDir: string, personId: number, t: TokenResponse) {
  ensureGdriveSchema(db)
  const granted = new Set((t.scope ?? '').split(/\s+/))
  if (!granted.has(SCOPE_FILE) && !granted.has(SCOPE_READONLY)) throw new GoogleError(403, 'scope_not_granted', 'Google Drive access was not granted (the box for Drive was left unticked)')
  const key = dataKey(dataDir), now = Date.now()
  const before = connectionOf(db, personId)
  const refresh = t.refresh_token ?? (before ? open(key, P(personId, 'refresh'), before.refresh_sealed) : null)
  if (!refresh) throw new GoogleError(400, 'no_refresh_token', 'Google did not hand out a lasting grant; disconnect the app in your Google account and connect again')
  const scope = [...granted].filter((s) => s === SCOPE_FILE || s === SCOPE_READONLY).join(' ')
  db.query(`INSERT INTO gdrive_connections (person_id, email, scope, refresh_sealed, access_sealed, access_expires, created_at, updated_at, broken_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL) ON CONFLICT (person_id) DO UPDATE SET email = coalesce(excluded.email, email), scope = excluded.scope,
    refresh_sealed = excluded.refresh_sealed, access_sealed = excluded.access_sealed, access_expires = excluded.access_expires, updated_at = excluded.updated_at, broken_at = NULL`)
    .run(personId, emailOfIdToken(t.id_token), scope, seal(key, P(personId, 'refresh'), refresh), seal(key, P(personId, 'access'), t.access_token),
      now + Math.max(60, (t.expires_in ?? 3600) - 120) * 1000, now, now)
}

/** A live access token for this person (refreshed when it has under two minutes left, or when `force`). */
export async function accessToken(db: DB, dataDir: string, google: GoogleClient, personId: number, force = false): Promise<string> {
  const c = connectionOf(db, personId)
  if (!c || c.broken_at) throw new NotConnected('connect Google Drive first')
  const key = dataKey(dataDir)
  if (!force && c.access_sealed && c.access_expires > Date.now()) return open(key, P(personId, 'access'), c.access_sealed)
  let t: TokenResponse
  try { t = await google.refresh(open(key, P(personId, 'refresh'), c.refresh_sealed)) } catch (e) {
    // the person revoked the app at Google, or the grant expired: they connect again
    if (e instanceof GoogleError && (e.reason === 'invalid_grant' || e.status === 400 || e.status === 401)) db.query('UPDATE gdrive_connections SET broken_at = ? WHERE person_id = ?').run(Date.now(), personId)
    throw e instanceof GoogleError && e.reason === 'invalid_grant' ? new NotConnected('Google no longer accepts this connection; connect Google Drive again') : e
  }
  const now = Date.now()
  db.query('UPDATE gdrive_connections SET access_sealed = ?, access_expires = ?, updated_at = ? WHERE person_id = ?')
    .run(seal(key, P(personId, 'access'), t.access_token), now + Math.max(60, (t.expires_in ?? 3600) - 120) * 1000, now, personId)
  if (t.refresh_token) db.query('UPDATE gdrive_connections SET refresh_sealed = ? WHERE person_id = ?').run(seal(key, P(personId, 'refresh'), t.refresh_token), personId)
  return t.access_token
}

/** Forget a person's connection; the grant is revoked at Google too (best effort). Returns whether there was one. */
export async function disconnect(db: DB, dataDir: string, google: GoogleClient | null, personId: number): Promise<boolean> {
  const c = connectionOf(db, personId)
  if (!c) return false
  db.query('DELETE FROM gdrive_connections WHERE person_id = ?').run(personId)
  if (google) { try { await google.revoke(open(dataKey(dataDir), P(personId, 'refresh'), c.refresh_sealed)) } catch {} }
  return true
}

export const hasScope = (c: Connection | null | undefined, scope: string) => !!c && c.scope.split(' ').includes(scope)
