// Admin-side records: people, groups, folders, rules, tokens. No read decision is made here (that is policy.ts).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { DB } from './db'
import { TOKEN_PREFIX } from './config'
import { nfc } from './names'

export interface Person { id: number; name: string; admin: number; active: number }
export interface FolderRow {
  id: number; dev: string; ino: string; path: string; registered: number; mount_name: string | null
  inherit_break: number; no_ai: number; quarantine: number; widened_pending: number
  personal_owner: number | null; nas_readers: string | null
}
export interface RuleRow { folder_id: number; subject_type: 'person' | 'group'; subject_id: number; level: number }
export interface TokenRow {
  id: number; person_id: number; name: string; hint: string; scope: string | null; read_only: number
  created_at: number; expires_at: number | null; revoked_at: number | null; last_used_at: number | null
}

export const LEVELS = { none: 0, read: 1, write: 2 } as const
export type LevelName = keyof typeof LEVELS

export const sha256 = (data: string | Uint8Array) => crypto.createHash('sha256').update(data).digest('hex')
export const identityKey = (dev: bigint | string, ino: bigint | string) => `${dev}:${ino}`

export class StoreError extends Error {}

// ---------- people & groups ----------
export function addPerson(db: DB, name: string, admin = false): Person {
  db.query('INSERT INTO people (name, admin, created_at) VALUES (?, ?, ?)').run(nfc(name), admin ? 1 : 0, Date.now())
  return person(db, name)
}
export function person(db: DB, name: string): Person {
  const p = db.query<Person, [string]>('SELECT * FROM people WHERE name = ?').get(nfc(name))
  if (!p) throw new StoreError(`no person named ${name}`)
  return p
}
export function addGroup(db: DB, name: string): number {
  db.query('INSERT INTO groups (name) VALUES (?)').run(nfc(name))
  return group(db, name)
}
export function group(db: DB, name: string): number {
  const g = db.query<{ id: number }, [string]>('SELECT id FROM groups WHERE name = ?').get(nfc(name))
  if (!g) throw new StoreError(`no group named ${name}`)
  return g.id
}
export function addMember(db: DB, groupName: string, personName: string) {
  db.query('INSERT OR IGNORE INTO memberships (group_id, person_id) VALUES (?, ?)').run(group(db, groupName), person(db, personName).id)
}

// ---------- folders ----------
function dirIdentity(p: string) {
  const st = fs.lstatSync(p, { bigint: true })
  if (!st.isDirectory()) throw new StoreError(`${p} is not a folder`)
  return st
}

/** The folder row for a directory (created if new); the stored path is refreshed. */
export function ensureFolder(db: DB, realPath: string, dev: bigint, ino: bigint): number {
  db.query('INSERT INTO folders (dev, ino, path) VALUES (?, ?, ?) ON CONFLICT (dev, ino) DO UPDATE SET path = excluded.path')
    .run(String(dev), String(ino), realPath)
  return db.query<{ id: number }, [string, string]>('SELECT id FROM folders WHERE dev = ? AND ino = ?').get(String(dev), String(ino))!.id
}

export const allFolders = (db: DB) => db.query<FolderRow, []>('SELECT * FROM folders').all()
export const folderById = (db: DB, id: number) => db.query<FolderRow, [number]>('SELECT * FROM folders WHERE id = ?').get(id)

/** The registered folder that contains realPath (deepest first), if any. */
export function containingRegistered(db: DB, realPath: string): FolderRow | undefined {
  return db.query<FolderRow, []>('SELECT * FROM folders WHERE registered = 1').all()
    .filter((f) => realPath === f.path || realPath.startsWith(f.path + '/'))
    .sort((a, b) => b.path.length - a.path.length)[0]
}

export type NasReaders = 'all' | 'unknown' | string[]

export function registerFolder(db: DB, dir: string, opts: { name?: string; personalOwner?: string; nasReaders?: NasReaders } = {}): FolderRow {
  const real = fs.realpathSync(dir)
  const st = dirIdentity(real)
  const outer = containingRegistered(db, real)
  if (outer && outer.personal_owner != null) throw new StoreError('cannot register a folder inside a personal folder')
  const owner = opts.personalOwner ? person(db, opts.personalOwner).id : null
  let nas: string
  if (opts.nasReaders === undefined) nas = owner != null ? JSON.stringify([owner]) : 'unknown'
  else if (Array.isArray(opts.nasReaders)) nas = JSON.stringify(opts.nasReaders.map((n) => person(db, n).id))
  else nas = opts.nasReaders
  const id = ensureFolder(db, real, st.dev, st.ino)
  db.query('UPDATE folders SET registered = 1, mount_name = ?, personal_owner = ?, nas_readers = ? WHERE id = ?')
    .run(nfc(opts.name ?? path.basename(real)), owner, nas, id)
  return folderById(db, id)!
}

/** A folder at or below a registered folder (rules, flags, token scopes attach to these). */
export function folderAt(db: DB, dir: string): FolderRow {
  const real = fs.realpathSync(dir)
  if (!containingRegistered(db, real)) throw new StoreError(`${dir} is not inside a registered folder`)
  const st = dirIdentity(real)
  return folderById(db, ensureFolder(db, real, st.dev, st.ino))!
}

export function setFlag(db: DB, dir: string, flag: 'no_ai' | 'quarantine' | 'widened_pending' | 'inherit_break', on: boolean) {
  db.query(`UPDATE folders SET ${flag} = ? WHERE id = ?`).run(on ? 1 : 0, folderAt(db, dir).id)
}

/** subject: a person name, or @group */
export function setRule(db: DB, dir: string, subject: string, level: LevelName, opts: { breakInherit?: boolean } = {}) {
  const f = folderAt(db, dir)
  const outer = containingRegistered(db, f.path)!
  if (outer.personal_owner != null) throw new StoreError('rules cannot be set inside a personal folder (only its owner reads it)')
  const [type, id] = subject.startsWith('@') ? ['group', group(db, subject.slice(1))] as const : ['person', person(db, subject).id] as const
  db.query('INSERT INTO rules (folder_id, subject_type, subject_id, level) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET level = excluded.level')
    .run(f.id, type, id, LEVELS[level])
  if (opts.breakInherit) db.query('UPDATE folders SET inherit_break = 1 WHERE id = ?').run(f.id)
}

export function grantManage(db: DB, dir: string, personName: string) {
  db.query('INSERT OR IGNORE INTO manage_grants (folder_id, person_id) VALUES (?, ?)').run(folderAt(db, dir).id, person(db, personName).id)
}

// ---------- tokens ----------
export function createToken(db: DB, personName: string, opts: { name?: string; scope?: string[]; readOnly?: boolean; ttlMs?: number } = {}) {
  const p = person(db, personName)
  const raw = TOKEN_PREFIX + crypto.randomBytes(24).toString('base64url')
  const scope = opts.scope?.length ? JSON.stringify(opts.scope.map((d) => folderAt(db, d).id)) : null
  const now = Date.now()
  const r = db.query('INSERT INTO tokens (person_id, name, hash, hint, scope, read_only, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(p.id, opts.name ?? `${p.name}-${now.toString(36)}`, sha256(raw), raw.slice(0, TOKEN_PREFIX.length + 4), scope,
      opts.readOnly ? 1 : 0, now, opts.ttlMs ? now + opts.ttlMs : null)
  return { id: Number(r.lastInsertRowid), token: raw }
}

/** The live token for a presented secret, or null (unknown, revoked, expired, or person inactive). */
export function verifyToken(db: DB, raw: string, client?: string): TokenRow | null {
  if (!raw.startsWith(TOKEN_PREFIX)) return null
  const t = db.query<TokenRow & { active: number }, [string]>(
    'SELECT t.*, p.active FROM tokens t JOIN people p ON p.id = t.person_id WHERE t.hash = ?').get(sha256(raw))
  const now = Date.now()
  if (!t || t.revoked_at != null || !t.active || (t.expires_at != null && t.expires_at <= now)) return null
  db.query('UPDATE tokens SET last_used_at = ?, last_client = coalesce(?, last_client) WHERE id = ?').run(now, client ?? null, t.id)
  return t
}

export function revokeToken(db: DB, id: number) {
  db.query('UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(Date.now(), id)
}

export const tokenById = (db: DB, id: number) => db.query<TokenRow, [number]>('SELECT * FROM tokens WHERE id = ?').get(id)

export function parseDuration(s: string): number {
  const m = /^(\d+)([smhd])$/.exec(s)
  if (!m) throw new StoreError(`bad duration ${s} (use e.g. 30m, 8h, 7d)`)
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3600_000, d: 86400_000 }[m[2] as 's' | 'm' | 'h' | 'd']
}
