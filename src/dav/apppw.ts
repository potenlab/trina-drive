// App passwords for mounting Trina Drive as a drive (WebDAV, src/dav). A person makes one per computer in Settings
// ("Mount as a drive"), sees it once, and types it into Finder / Windows Explorer with their sign-in name or mail
// address. Only its sha256 is kept (it is 160 random bits, like a token: a slow hash buys nothing). One works only for
// WebDAV, only for its own person, only while that person is active; a password reset revokes them all.
// Agent tokens (tdrive_pat_…, OAuth) are never accepted there: agents use MCP, where their scope and provenance apply.
import crypto from 'node:crypto'
import { appendAudit } from '../audit'
import { SECRET_TAG } from '../config'
import type { DB } from '../db'
import { nfc } from '../names'
import { sha256 } from '../store'
import { freshLogin } from '../web/auth'
import { ApiError, bad, notFound, type WebCtx } from '../web/http'
import { reauth } from '../web/people-ops'
import type { Op } from '../web/ops'
import type { Actor } from '../rights'
import { davEnabled, davSecureBase } from './settings'

export const APP_PASSWORD_PREFIX = `${SECRET_TAG}_app_`
export const APP_PASSWORDS_PER_PERSON = 20

const SCHEMA = `CREATE TABLE IF NOT EXISTS app_passwords (
  id INTEGER PRIMARY KEY, person_id INTEGER NOT NULL REFERENCES people(id), name TEXT NOT NULL, secret_hash TEXT NOT NULL UNIQUE,
  hint TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER, last_used_addr TEXT, revoked_at INTEGER)`
const ready = new WeakSet<DB>()
export function ensureAppPwSchema(db: DB) { if (!ready.has(db)) { db.exec(SCHEMA); ready.add(db) } }

// 32 characters from an alphabet without look-alikes (160 bits), in groups of four: easy to read off a screen
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'
function newSecret(): string {
  const b = crypto.randomBytes(32)
  const chars = [...b].map((x) => ALPHABET[x & 31]!).join('')
  return APP_PASSWORD_PREFIX + chars.match(/.{4}/g)!.join('-')
}

export interface AppPasswordRow { id: number; person_id: number; name: string; hint: string; created_at: number; last_used_at: number | null; last_used_addr: string | null; revoked_at: number | null }

/** The person an app password belongs to, if `login` (name or mail address) names that same person and both are live. */
export function checkAppPassword(db: DB, login: string, secret: string, addr: string): number | null {
  ensureAppPwSchema(db)
  if (!secret.startsWith(APP_PASSWORD_PREFIX) || secret.length > 100 || !login || login.length > 254) return null
  const r = db.query<{ id: number; person_id: number; last_used_at: number | null; name: string; email: string | null; active: number }, [string]>(
    `SELECT a.id, a.person_id, a.last_used_at, p.name, acc.email, p.active FROM app_passwords a JOIN people p ON p.id = a.person_id
     LEFT JOIN accounts acc ON acc.person_id = a.person_id WHERE a.secret_hash = ? AND a.revoked_at IS NULL`).get(sha256(secret))
  if (!r || !r.active) return null
  const l = nfc(login.trim())
  if (l !== nfc(r.name) && l.toLowerCase() !== (r.email ?? '').toLowerCase()) return null
  const t = Date.now()
  if (!r.last_used_at || t - r.last_used_at > 60_000) db.query('UPDATE app_passwords SET last_used_at = ?, last_used_addr = ? WHERE id = ?').run(t, addr.slice(0, 64), r.id)
  return r.person_id
}

export function revokeAppPasswordsOf(db: DB, personId: number): number {
  ensureAppPwSchema(db)
  return db.query('UPDATE app_passwords SET revoked_at = ? WHERE person_id = ? AND revoked_at IS NULL').run(Date.now(), personId).changes
}

export function view(w: WebCtx, a: Actor, base: string) {
  ensureAppPwSchema(w.db)
  const rows = w.db.query<AppPasswordRow, [number]>('SELECT * FROM app_passwords WHERE person_id = ? AND revoked_at IS NULL ORDER BY id DESC').all(a.personId)
  const me = w.db.query<{ name: string }, [number]>('SELECT name FROM people WHERE id = ?').get(a.personId)
  const url = davSecureBase(base) + '/dav/'
  return { enabled: davEnabled(w), url, https: url.startsWith('https://'), username: me?.name ?? '',
    passwords: rows.map((r) => ({ id: r.id, name: r.name, hint: r.hint, created_at: r.created_at, last_used_at: r.last_used_at })) }
}

/** A new app password (needs a fresh login: the password typed within 5 minutes; `password` in the body counts). */
export async function create(op: Op, sessionIdHash: string, body: { name?: unknown; password?: unknown }) {
  const db = op.w.db
  ensureAppPwSchema(db)
  if (!davEnabled(op.w)) throw notFound()
  if (typeof body.name !== 'string' || !body.name.trim() || [...body.name].length > 64 || /\p{Cc}/u.test(body.name)) throw bad('bad_name', 'give it a name (which computer it is for)')
  if (body.password !== undefined) await reauth(op, sessionIdHash, body)
  if (!freshLogin(db, sessionIdHash)) throw new ApiError(403, 'reauth_required', 'type your password again to make an app password')
  const live = db.query<{ n: number }, [number]>('SELECT count(*) AS n FROM app_passwords WHERE person_id = ? AND revoked_at IS NULL').get(op.actor.personId)!.n
  if (live >= APP_PASSWORDS_PER_PERSON) throw new ApiError(409, 'too_many', `you have ${live} app passwords; revoke one you no longer use`)
  const secret = newSecret(), name = nfc(body.name.trim())
  let id = 0
  db.transaction(() => {
    id = Number(db.query('INSERT INTO app_passwords (person_id, name, secret_hash, hint, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(op.actor.personId, name, sha256(secret), secret.slice(-4), Date.now()).lastInsertRowid)
    appendAudit(db, { personId: op.actor.personId, tokenId: null, tool: 'web', command: `app password create "${name}" (WebDAV)`, files: [], outcome: 'ok' })
  })()
  return { id, name, password: secret }
}

export function revoke(w: WebCtx, a: Actor, id: number) {
  ensureAppPwSchema(w.db)
  const r = w.db.query<AppPasswordRow, [number]>('SELECT * FROM app_passwords WHERE id = ?').get(id)
  if (!r || r.person_id !== a.personId || r.revoked_at) throw notFound()
  w.db.transaction(() => {
    w.db.query('UPDATE app_passwords SET revoked_at = ? WHERE id = ?').run(Date.now(), id)
    appendAudit(w.db, { personId: a.personId, tokenId: null, tool: 'web', command: `app password revoke "${r.name}"`, files: [], outcome: 'ok' })
  })()
  return { ok: true }
}
