// Managed storage, the file system side (plan 2.2 "관리 모드"): the server owns the team folders, so people's uploads,
// renames, moves, deletions (to the trash) and versions all go through here. Who may do what is decided by the caller
// with the one policy (policy.ts Access, src/managed/ops.ts); this module only does it, safely:
//   - every new file is written to a staging file first (O_EXCL|O_NOFOLLOW, fsync, sha256 on the way), then placed in
//     one step: link() for a new name (it refuses an existing one: a no-replace rename) or rename() over an existing
//     file (an atomic replace). Readers see the old bytes or the new ones, never half a file;
//   - before a replace the old bytes go to the versions store (content-addressed), so every replace can be undone;
//   - a deleted file or folder is moved (renamed: same inode, rules on folders follow) into the trash;
//   - each change returns an undo, so the caller can put things back when its audit row cannot be written.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { DB } from '../db'
import { isSystemName, nfc } from '../names'
import type { FileEntry, Node } from '../policy'
import { sha256 } from '../store'
import { ensureRoot, MANAGED_LIMITS } from './settings'

export class ManagedError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

// ---------- which folders are managed ----------
export function managedMountIds(db: DB): Set<number> {
  return new Set(db.query<{ folder_id: number }, []>('SELECT folder_id FROM managed_mounts').all().map((r) => r.folder_id))
}
/** A node (as policy walks it) lies in managed storage: its mount (rows[0], walks start at a mount) is a managed folder. */
export const inManaged = (ids: Set<number>, node: Node) => node.rows.length > 0 && ids.has(node.rows[0]!.id)

// ---------- names ----------
/** A name people may give a file or folder: one path part, NFC, no control characters, not a hidden system name. */
export function checkName(name: unknown, what = 'name'): string {
  if (typeof name !== 'string') throw new ManagedError(400, 'bad_name', `give a ${what}`)
  const n = nfc(name)
  const bad = (why: string) => new ManagedError(400, 'bad_name', `bad ${what}: ${why}`)
  if (!n || n !== n.trim()) throw bad('empty, or starts or ends with a space')
  if (n === '.' || n === '..' || /[/\\]/.test(n)) throw bad('a name, not a path (no / or \\)')
  if (/\p{Cc}/u.test(n)) throw bad('control characters are not allowed')
  if (Buffer.byteLength(n) > 255) throw bad('longer than 255 bytes')
  if (isSystemName(n)) throw bad('this is a system name (hidden on every NAS and Mac): choose another')
  return n
}

const key = (n: string) => nfc(n).toLowerCase()
/** The listed name equal to `name` after NFC and case folding (APFS and SMB compare names that way), if any. */
export function taken(dir: string, name: string, except?: string): string | null {
  let names: string[]
  try { names = fs.readdirSync(dir) } catch { throw new ManagedError(409, 'target_changed', 'the folder cannot be listed; nothing was changed') }
  const k = key(name)
  return names.find((n) => key(n) === k && n !== except) ?? null
}
/** "a.txt" -> "a (1).txt", "a (2).txt" … the first one free in dir. */
export function freeName(dir: string, name: string): string {
  if (!taken(dir, name)) return name
  const dot = name.lastIndexOf('.')
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  for (let i = 1; i < 10_000; i++) {
    const n = `${stem} (${i})${ext}`
    if (Buffer.byteLength(n) <= 255 && !taken(dir, n)) return n
  }
  throw new ManagedError(409, 'exists', `${name} exists`)
}

// ---------- identity checks ----------
/** R1 ⑦ for folders: every step from the mount down is still the same folder and not a link. */
export function recheckDir(node: Node) {
  for (let n: Node | null = node; n; n = n.parent) {
    let st: fs.BigIntStats
    try { st = fs.lstatSync(n.real, { bigint: true }) } catch { throw changed() }
    if (st.isSymbolicLink() || !st.isDirectory() || st.dev !== n.dev || st.ino !== n.ino || st.birthtimeNs !== n.birth) throw changed()
  }
}
const changed = () => new ManagedError(409, 'target_changed', 'the folder changed meanwhile; nothing was changed. Reload and try again.')

/** The file the walk saw, opened without following links (identity and one link checked). */
export function openEntry(f: { real: string; dev: bigint | string; ino: bigint | string }): number {
  let fd: number
  try { fd = fs.openSync(f.real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK) } catch { throw changed() }
  const st = fs.fstatSync(fd, { bigint: true })
  if (!st.isFile() || st.nlink !== 1n || String(st.dev) !== String(f.dev) || String(st.ino) !== String(f.ino)) { fs.closeSync(fd); throw changed() }
  return fd
}

// ---------- staging ----------
export interface Staged { path: string; size: number; sha256: string }

const W_EXCL = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW
const rand = () => crypto.randomBytes(9).toString('hex')

function writeAll(fd: number, bytes: Uint8Array, at = 0) {
  let off = 0
  while (off < bytes.length) off += fs.writeSync(fd, bytes, off, bytes.length - off, at + off)
}

/** Bytes into a fresh staging file (fsynced), with their sha256. */
export function stageBytes(root: string, bytes: Uint8Array): Staged {
  const p = path.join(ensureRoot(root).uploads, `put-${rand()}.part`)
  const fd = fs.openSync(p, W_EXCL, 0o600)
  try { writeAll(fd, bytes); fs.fsyncSync(fd) } catch (e) { fs.closeSync(fd); try { fs.unlinkSync(p) } catch {} throw e }
  fs.closeSync(fd)
  return { path: p, size: bytes.length, sha256: sha256(bytes) }
}

/** sha256 of a file, read in 1 MB pieces (never the whole file in memory). */
export function hashFd(fd: number): { sha256: string; size: number } {
  const h = crypto.createHash('sha256')
  const buf = Buffer.alloc(1024 * 1024)
  let off = 0
  for (;;) { const n = fs.readSync(fd, buf, 0, buf.length, off); if (n <= 0) break; h.update(buf.subarray(0, n)); off += n }
  return { sha256: h.digest('hex'), size: off }
}

/** A copy of an existing file into staging (copy = new inode, new identity). */
export function stageCopy(root: string, f: FileEntry): Staged {
  const src = openEntry(f)
  const p = path.join(ensureRoot(root).uploads, `copy-${rand()}.part`)
  const fd = fs.openSync(p, W_EXCL, 0o600)
  const h = crypto.createHash('sha256')
  let off = 0
  try {
    const buf = Buffer.alloc(1024 * 1024)
    for (;;) { const n = fs.readSync(src, buf, 0, buf.length, off); if (n <= 0) break; writeAll(fd, buf.subarray(0, n), off); h.update(buf.subarray(0, n)); off += n }
    fs.fsyncSync(fd)
  } catch (e) { fs.closeSync(fd); try { fs.unlinkSync(p) } catch {} throw e } finally { fs.closeSync(src) }
  fs.closeSync(fd)
  return { path: p, size: off, sha256: h.digest('hex') }
}

export const dropStaged = (s: Staged) => { try { fs.unlinkSync(s.path) } catch {} }

// ---------- the versions store ----------
export const blobPath = (root: string, sha: string) => path.join(ensureRoot(root).versions, sha.slice(0, 2), sha)

/** Keep the bytes of an existing file in the versions store (content-addressed). Returns their sha256 and size. */
export function keepVersion(root: string, f: { real: string; dev: bigint | string; ino: bigint | string }): { sha256: string; size: number } {
  const src = openEntry(f)
  const tmpDir = ensureRoot(root).versions
  const tmp = path.join(tmpDir, `v-${rand()}.tmp`)
  const fd = fs.openSync(tmp, W_EXCL, 0o600)
  const h = crypto.createHash('sha256')
  let off = 0
  try {
    const buf = Buffer.alloc(1024 * 1024)
    for (;;) { const n = fs.readSync(src, buf, 0, buf.length, off); if (n <= 0) break; writeAll(fd, buf.subarray(0, n), off); h.update(buf.subarray(0, n)); off += n }
    fs.fsyncSync(fd)
  } catch (e) { fs.closeSync(fd); try { fs.unlinkSync(tmp) } catch {} throw e } finally { fs.closeSync(src) }
  fs.closeSync(fd)
  const sha = h.digest('hex')
  const final = blobPath(root, sha)
  if (fs.existsSync(final)) fs.unlinkSync(tmp)
  else { fs.mkdirSync(path.dirname(final), { recursive: true, mode: 0o700 }); fs.renameSync(tmp, final) }
  return { sha256: sha, size: off }
}

/** A version's bytes into staging (to restore it), checked against its hash. */
export function stageVersion(root: string, sha: string): Staged {
  const src = blobPath(root, sha)
  const p = path.join(ensureRoot(root).uploads, `ver-${rand()}.part`)
  try { fs.copyFileSync(src, p, fs.constants.COPYFILE_EXCL) } catch { throw new ManagedError(410, 'version_gone', 'the bytes of this version are no longer kept') }
  fs.chmodSync(p, 0o600)
  const fd = fs.openSync(p, fs.constants.O_RDONLY)
  try {
    const h = hashFd(fd)
    if (h.sha256 !== sha) { try { fs.unlinkSync(p) } catch {} throw new ManagedError(500, 'version_corrupt', 'the stored version does not match its hash') }
    return { path: p, size: h.size, sha256: sha }
  } finally { fs.closeSync(fd) }
}

/** Remove version blobs no row refers to any more. */
export function gcBlobs(db: DB, root: string, shas: Iterable<string>) {
  const used = db.query<{ n: number }, [string]>('SELECT count(*) AS n FROM mversions WHERE sha256 = ?')
  for (const s of new Set(shas)) if (!used.get(s)!.n) try { fs.unlinkSync(blobPath(root, s)) } catch {}
}

// ---------- placing ----------
export interface Placed {
  real: string; name: string; dev: string; ino: string; size: number; mtimeNs: string; sha256: string
  /** a replace: what was there before (its bytes are in the versions store) */
  replaced: { dev: string; ino: string; size: number; mtimeNs: string; sha256: string } | null
  /** put things back as they were (the caller's record could not be written) */
  undo: () => void
}

function statPlaced(final: string, staged: Staged, name: string, replaced: Placed['replaced'], undo: () => void): Placed {
  const st = fs.lstatSync(final, { bigint: true })
  if (!st.isFile() || st.nlink !== 1n || Number(st.size) !== staged.size) throw new ManagedError(500, 'write_check', 'the written file did not check out')
  return { real: final, name, dev: String(st.dev), ino: String(st.ino), size: staged.size, mtimeNs: String(st.mtimeNs), sha256: staged.sha256, replaced, undo }
}

/** A new file `name` in `node` from staging, never replacing anything (link refuses an existing name). */
export function placeNew(node: Node, name: string, staged: Staged): Placed {
  recheckDir(node)
  if (taken(node.real, name)) throw exists(name)
  const final = path.join(node.real, name)
  try { fs.linkSync(staged.path, final) } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw exists(name)
    throw e
  }
  dropStaged(staged)
  const ino = String(fs.lstatSync(final, { bigint: true }).ino)
  return statPlaced(final, staged, name, null, () => {
    try { if (String(fs.lstatSync(final, { bigint: true }).ino) === ino) fs.unlinkSync(final) } catch {}
  })
}

/**
 * Replace the file `old` (a visible file in `node`) with the staged bytes: the old bytes are kept in the versions store
 * first, then rename() puts the new file over the old name in one step.
 */
export function placeReplace(root: string, node: Node, old: FileEntry, staged: Staged): Placed {
  recheckDir(node)
  const kept = keepVersion(root, old)
  const final = old.real
  const before = fs.lstatSync(final, { bigint: true })
  if (String(before.ino) !== String(old.ino)) { throw changed() }
  fs.renameSync(staged.path, final)
  const replaced = { dev: String(old.dev), ino: String(old.ino), size: kept.size, mtimeNs: String(old.mtimeNs), sha256: kept.sha256 }
  return statPlaced(final, staged, old.name, replaced, () => {
    // put the old bytes back (a new inode; the record of the old one was not changed either way)
    try { const back = stageVersion(root, kept.sha256); fs.renameSync(back.path, final) } catch (e) { console.error('[managed] undo of a replace failed:', e) }
  })
}

const exists = (name: string) => new ManagedError(409, 'exists', `${name} already exists here`)

// ---------- file rows ----------
export interface FileRow { id: number; dev: string; ino: string; size: number; mtime_ns: string; sha256: string; version: number; created_at: number; created_by: number | null; updated_at: number; updated_by: number | null }

/** The row of a file as it is on disk now (same identity, size and mtime), if the server wrote it. */
export function fileRowOf(db: DB, f: { dev: bigint | string; ino: bigint | string; size: number; mtimeNs: bigint | string }): FileRow | undefined {
  const r = db.query<FileRow, [string, string]>('SELECT * FROM mfiles WHERE dev = ? AND ino = ?').get(String(f.dev), String(f.ino))
  return r && r.size === f.size && r.mtime_ns === String(f.mtimeNs) ? r : undefined
}

/** Inside the caller's transaction: the row for a newly placed file. */
export function trackNew(db: DB, p: Placed, by: number | null, now: number): number {
  // a stale row on the same identity (a reused inode number, or a file changed by hand) is another file: drop it
  dropRow(db, p.dev, p.ino)
  return Number(db.query('INSERT INTO mfiles (dev, ino, size, mtime_ns, sha256, version, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)')
    .run(p.dev, p.ino, p.size, p.mtimeNs, p.sha256, now, by, now, by).lastInsertRowid)
}

/**
 * Inside the caller's transaction: a replace. The file's row moves to the new inode with version + 1; the old bytes
 * become an earlier version. Versions beyond `keep` are dropped (returns their hashes for gcBlobs after the commit).
 */
export function trackReplace(db: DB, p: Placed, by: number | null, now: number, keep: number): { fileId: number; version: number; dropped: string[] } {
  const old = p.replaced!
  let row = fileRowOf(db, { dev: old.dev, ino: old.ino, size: old.size, mtimeNs: old.mtimeNs })
  if (!row) {
    // a file the server did not write (put there by hand before): it starts its history now
    dropRow(db, old.dev, old.ino)
    const id = Number(db.query('INSERT INTO mfiles (dev, ino, size, mtime_ns, sha256, version, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, 1, ?, NULL, ?, NULL)')
      .run(old.dev, old.ino, old.size, old.mtimeNs, old.sha256, now, now).lastInsertRowid)
    row = db.query<FileRow, [number]>('SELECT * FROM mfiles WHERE id = ?').get(id)!
  }
  dropRow(db, p.dev, p.ino, row.id)
  db.query('INSERT OR REPLACE INTO mversions (file_id, version, sha256, size, created_at, created_by, replaced_at, replaced_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(row.id, row.version, old.sha256, old.size, row.updated_at, row.updated_by, now, by)
  const version = row.version + 1
  db.query('UPDATE mfiles SET dev = ?, ino = ?, size = ?, mtime_ns = ?, sha256 = ?, version = ?, updated_at = ?, updated_by = ? WHERE id = ?')
    .run(p.dev, p.ino, p.size, p.mtimeNs, p.sha256, version, now, by, row.id)
  const dropped = db.query<{ sha256: string }, [number, number]>('SELECT sha256 FROM mversions WHERE file_id = ? AND version <= ?').all(row.id, version - 1 - keep).map((r) => r.sha256)
  db.query('DELETE FROM mversions WHERE file_id = ? AND version <= ?').run(row.id, version - 1 - keep)
  return { fileId: row.id, version, dropped }
}

/** Forget a row (and its earlier versions) at an identity, except row `keepId`. Returns the version hashes dropped. */
export function dropRow(db: DB, dev: string, ino: string, keepId?: number): string[] {
  const r = db.query<{ id: number }, [string, string]>('SELECT id FROM mfiles WHERE dev = ? AND ino = ?').get(dev, ino)
  if (!r || r.id === keepId) return []
  const shas = db.query<{ sha256: string }, [number]>('SELECT sha256 FROM mversions WHERE file_id = ?').all(r.id).map((x) => x.sha256)
  db.query('DELETE FROM mversions WHERE file_id = ?').run(r.id)
  db.query('DELETE FROM mfiles WHERE id = ?').run(r.id)
  return shas
}

// ---------- folder rows follow a moved folder ----------
/** Folder rows at or below oldReal now live under newReal (rules, flags and scopes follow the identity; paths follow here). */
export function relocateFolderRows(db: DB, oldReal: string, newReal: string) {
  db.query('UPDATE folders SET path = ? || substr(path, ?) WHERE path = ? OR substr(path, 1, ?) = ?')
    .run(newReal, oldReal.length + 1, oldReal, oldReal.length + 1, oldReal + '/')
}

/** Folder rows at or below `real` stop matching anything (their folder is gone for good; an inode number may come back). */
export function retireFolderRows(db: DB, real: string) {
  db.query("UPDATE folders SET ino = ino || '@gone' || id, path = path || '@gone' WHERE (path = ? OR substr(path, 1, ?) = ?) AND registered = 0")
    .run(real, real.length + 1, real + '/')
}

// ---------- walking a subtree on disk (server side, no policy: for sizes and purges) ----------
export interface DiskFile { real: string; dev: string; ino: string; size: number }
export function diskWalk(top: string, limit = MANAGED_LIMITS.walkEntries): { files: DiskFile[]; dirs: string[]; partial: boolean } {
  const files: DiskFile[] = [], dirs: string[] = []
  let n = 0, partial = false
  const visit = (p: string) => {
    let st: fs.BigIntStats
    try { st = fs.lstatSync(p, { bigint: true }) } catch { return }
    if (++n > limit) { partial = true; return }
    if (st.isDirectory()) {
      dirs.push(p)
      let names: string[] = []
      try { names = fs.readdirSync(p) } catch {}
      for (const c of names) visit(path.join(p, c))
    } else if (st.isFile()) files.push({ real: p, dev: String(st.dev), ino: String(st.ino), size: Number(st.size) })
  }
  visit(top)
  return { files, dirs, partial }
}
