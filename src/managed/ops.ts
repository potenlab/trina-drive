// What people do to managed storage, decided with the one policy (plan 4.1, principle 1): a person's web session is
// Access.forPerson (R1 for a person: their rules, no token scope; "No AI" closes agents only). Then:
//   - hidden == missing: a path you cannot see answers exactly like one that is not there (404, also for targets);
//   - no write without `write` (R0 effective rule ≥ write on the folder that changes: where a file is created,
//     replaced, renamed, moved from or to, deleted from, restored to); a folder you can see but not write: 403;
//   - a folder is moved or deleted only by someone who can see and write everything in it (else 409 has_hidden);
//   - moving or copying something where more people read it is allowed for a person (they decide, as on a NAS), and
//     the audit row says it widens (R6/R10 for people: logged, not held). Agents never write here: they write drafts
//     and promote them (R2, src/promote.ts), where widening waits for an approval (R8).
// Every change is one audit row in the same transaction as its records; if that fails, the change on disk is undone.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { appendAudit } from '../audit'
import type { DB } from '../db'
import { hasText } from '../web/files'
import { ExtractQueue, openOriginal, readAll } from '../inplace/extractq'
import { sniffLink, SNIFF_BYTES } from '../inplace/linkish'
import { splitVirtual } from '../names'
import { Access, effectiveLevel, entryName, isWidening, readersOfChain, type Entry, type FileEntry, type Node } from '../policy'
import type { Ctx } from '../session'
import { ensureFolder, type FolderRow } from '../store'
import {
  checkName, diskWalk, dropRow, hashFd as hashOf, dropStaged, fileRowOf, freeName, gcBlobs, inManaged, managedMountIds, ManagedError, placeNew, placeReplace,
  recheckDir, relocateFolderRows, retireFolderRows, newUid, relocateShared, relocate, dropGrantsOf, grantsOn, stageCopy, stageVersion, taken, trackNew, trackReplace, blobPath, type Placed, type Staged,
} from './core'
import { ensureRoot, MANAGED_LIMITS, storageSettings, systemDirs, type StorageSettings } from './settings'
import { relocateCopies } from '../share/rejudge'

export type Conflict = 'fail' | 'rename' | 'replace'
export const asConflict = (v: unknown, dflt: Conflict = 'fail'): Conflict => v === 'rename' || v === 'replace' || v === 'fail' ? v : dflt

const notFound = () => new ManagedError(404, 'not_found', 'not found')

// ---------- extraction queue: the text mirror follows every change (search and "view text" see the new content) ----------
const queues = new WeakMap<DB, ExtractQueue>()
const queueOf = (db: DB) => { let q = queues.get(db); if (!q) { q = new ExtractQueue(2); queues.set(db, q) } return q }
/** Resolves when every queued extraction of this database is done (tests, CLI). */
export const managedIdle = (db: DB) => queueOf(db).drain()

/** Fill the text mirror for a file just written (by identity: if it changed meanwhile, the job does nothing). */
export function indexLater(ctx: Pick<Ctx, 'db' | 'mirror'>, p: { real: string; name: string; dev: string; ino: string; size: number; mtimeNs: string }) {
  if (!hasText(p.name, p.size)) return
  queueOf(ctx.db).push({ size: p.size, run: async () => {
    let fd: number
    try { fd = openOriginal(p.real, { dev: p.dev, ino: p.ino, size: p.size, mtimeNs: p.mtimeNs }) } catch { return }
    let bytes: Uint8Array, ctimeNs: string
    try { ctimeNs = String(fs.fstatSync(fd, { bigint: true }).ctimeNs); bytes = readAll(fd, p.size) } finally { fs.closeSync(fd) }
    await ctx.mirror.ingest({ name: p.name, dev: p.dev, ino: p.ino, size: p.size, mtimeNs: p.mtimeNs, ctimeNs }, bytes)
  } })
}

// ---------- usage and quota ----------
export interface Usage { files: number; count: number; trash: number; versions: number; uploads: number; total: number }
export function usage(db: DB): Usage {
  const one = (sql: string) => Number(db.query<{ n: number | null }, []>(sql).get()?.n ?? 0)
  const files = one('SELECT sum(size) AS n FROM mfiles')
  const count = one('SELECT count(*) AS n FROM mfiles')
  const trash = one('SELECT sum(size) AS n FROM mtrash WHERE restored_at IS NULL AND purged_at IS NULL')
  const versions = one('SELECT sum(size) AS n FROM (SELECT DISTINCT sha256, size FROM mversions)')
  const uploads = one("SELECT sum(size) AS n FROM muploads WHERE state = 'open'")
  // trashed files keep their rows (their bytes are still kept), so `files` includes the trash
  return { files: files - trash, count, trash, versions, uploads, total: files + versions + uploads }
}
export function ensureRoom(db: DB, s: StorageSettings, extra: number) {
  if (extra > s.maxFileBytes) throw new ManagedError(413, 'too_large', `files may be at most ${fmt(s.maxFileBytes)}`)
  if (s.quotaBytes === null) return
  const u = usage(db)
  if (u.total + extra > s.quotaBytes) throw new ManagedError(507, 'quota_exceeded', `team storage is full (${fmt(u.total)} of ${fmt(s.quotaBytes)} used); empty the trash or ask your admin`)
}
const fmt = (n: number) => n >= 1024 ** 3 ? `${+(n / 1024 ** 3).toFixed(1)} GB` : `${+(n / 1024 ** 2).toFixed(1)} MB`

// ---------- the person's view ----------
export class Managed {
  readonly s: StorageSettings
  readonly access: Access
  readonly ids: Set<number>
  readonly db: DB

  /** `tool`: how the person reached us, for the audit rows (the web app: 'web'; a mounted drive: 'webdav') */
  constructor(readonly ctx: Pick<Ctx, 'db' | 'dataDir' | 'mirror'>, readonly personId: number, readonly tool = 'web') {
    this.db = ctx.db
    this.s = storageSettings(ctx.db, ctx.dataDir)
    this.access = Access.forPerson(ctx.db, personId)
    this.ids = managedMountIds(ctx.db)
  }

  // ---- audit (closed by default: appendAudit throws, and the caller's transaction with it) ----
  audit(command: string, files: string[], outcome = 'ok') {
    appendAudit(this.db, { personId: this.personId, tokenId: null, tool: this.tool, command, files, outcome })
  }
  /** 404, with the attempt in the person's own audit trail. */
  missing(command: string): never {
    this.audit(command, [], 'not_found')
    throw notFound()
  }

  // ---- resolving ----
  entry(vpath: unknown): Entry | null {
    if (typeof vpath !== 'string' || vpath.length > 4096 || vpath.includes('\0')) return null
    const ps = splitVirtual(vpath)
    return ps.length ? this.access.lookup(ps) : null
  }
  /** A folder the person may write into (managed, rule ≥ write, readable). */
  writable(vpath: unknown, action: string): Node {
    const e = this.entry(vpath)
    if (!e || e.kind !== 'dir') this.missing(`files ${action} ${String(vpath)}`)
    this.mayWrite(e.node)
    return e.node
  }
  mayWrite(node: Node) {
    if (!this.access.canRead(node)) throw new ManagedError(403, 'no_write', 'you cannot change this folder')
    if (!inManaged(this.ids, node)) throw new ManagedError(403, 'not_managed', 'this folder is not in managed storage: its files are changed where they live (the NAS), not here')
    if (this.access.level(node) < 2) throw new ManagedError(403, 'no_write', 'you can open this folder but not change it (your rule here is read)')
  }
  canWrite(node: Node) { return this.access.canRead(node) && inManaged(this.ids, node) && this.access.level(node) >= 2 }
  /**
   * A file this person may give a new version (upload a replacement, restore an earlier version): write on its folder,
   * or a file share as Editor on exactly this file (A2 F7). Rename, move, delete and new files still need the folder.
   */
  canWriteFile(f: FileEntry) { return this.access.canReadFile(f) && inManaged(this.ids, f.parent) && this.access.levelOfFile(f) >= 2 }
  mayWriteFile(f: FileEntry) {
    if (this.canWriteFile(f)) return
    if (!inManaged(this.ids, f.parent)) throw new ManagedError(403, 'not_managed', 'this folder is not in managed storage: its files are changed where they live (the NAS), not here')
    throw new ManagedError(403, 'no_write', 'you can open this file but not change it (you are a viewer)')
  }
  /** File-only access: the person reads this file through a file share, not through its folder (A2 F7: no history). */
  fileOnly(f: FileEntry) { return !this.access.canRead(f.parent) }
  /**
   * The folder a staged file goes into: writable, or — for a replace of an existing file — a folder whose file this
   * person may write by a file share (the folder itself stays read-only to them: 403 for anything else).
   */
  writableFor(vpath: unknown, name: unknown, conflict: Conflict, action: string): Node {
    const e = this.entry(vpath)
    if (!e || e.kind !== 'dir') this.missing(`files ${action} ${String(vpath)}`)
    if (conflict === 'replace' && !this.canWrite(e.node) && typeof name === 'string') {
      let there: string | null = null
      try { there = taken(e.node.real, name) } catch {}
      const f = there ? this.access.child(e.node, there) : null
      if (f?.kind === 'file' && this.canWriteFile(f)) return e.node
    }
    this.mayWrite(e.node)
    return e.node
  }
  /** The folder an entry lives in (its parent node); a top folder has none. */
  parentOf(e: Entry): Node | null { return e.kind === 'file' ? e.parent : e.node.parent }
  vpathOf(e: Entry) { return e.kind === 'dir' ? e.node.vpath : e.vpath }

  /** Everything in a folder, all visible and writable to this person (moving or deleting it changes all of it). */
  subtree(node: Node): { files: FileEntry[]; dirs: Node[]; bytes: number } {
    const files: FileEntry[] = [], dirs: Node[] = []
    let bytes = 0, n = 0
    const hidden = () => new ManagedError(409, 'has_hidden', 'this folder holds items you cannot see or change; ask someone who manages it')
    const walk = (d: Node) => {
      if (!this.access.canRead(d) || this.access.level(d) < 2) throw hidden()
      let raw: string[]
      try { raw = fs.readdirSync(d.real) } catch { throw hidden() }
      const listed = this.access.list(d)
      if (listed.length !== raw.length) throw hidden()
      dirs.push(d)
      for (const c of listed) {
        if (++n > MANAGED_LIMITS.walkEntries) throw new ManagedError(413, 'too_many', 'this folder holds too many items to move or delete at once')
        if (c.kind === 'dir') walk(c.node)
        else { files.push(c); bytes += c.size }
      }
    }
    walk(node)
    return { files, dirs, bytes }
  }

  /** R6 for a person's move or copy: do people who could not read it before read it now? (allowed, but logged) */
  widens(fromRows: FolderRow[], toRows: FolderRow[]): number {
    const before = readersOfChain(this.db, fromRows, 'source'), after = readersOfChain(this.db, toRows, 'target')
    let n = 0
    for (const u of after) if (!before.has(u)) n++
    return n
  }

  /** Content equal to a draft version (sha256): record the copy so readers inherit the draft's sources (R3/R6). */
  private noteDraftCopies(p: Placed, node: Node, now: number): string {
    const found = this.db.query<{ draft_id: number; version: number }, [string]>('SELECT draft_id, max(version) AS version FROM draft_versions WHERE sha256 = ? GROUP BY draft_id').all(p.sha256)
    if (!found.length) return ''
    const target = ensureFolder(this.db, node.real, node.dev, node.ino, node.birth)
    let widening = false
    for (const f of found) {
      const d = this.db.query<{ person_id: number; token_id: number }, [number]>('SELECT person_id, token_id FROM drafts WHERE id = ?').get(f.draft_id)
      if (!d) continue
      const src = this.db.query<{ folder_id: number }, [number]>('SELECT folder_id FROM draft_src WHERE draft_id = ?').all(f.draft_id).map((r) => r.folder_id)
      const w = src.length > 0 && isWidening(this.db, src, target)
      widening ||= w
      this.db.query(`INSERT INTO widened (at, dev, ino, path, sha256, draft_id, draft_version, writer_person_id, writer_token_id, target_folder_id, match, overlap,
          widening, ever_widening, status, judged_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sha256', 1, ?, ?, 'tracked', ?)
        ON CONFLICT (dev, ino, draft_id) DO UPDATE SET path = excluded.path, sha256 = excluded.sha256, widening = excluded.widening,
          ever_widening = max(ever_widening, excluded.widening), judged_at = excluded.judged_at`)
        .run(now, p.dev, p.ino, p.real, p.sha256, f.draft_id, f.version, d.person_id, d.token_id, target, w ? 1 : 0, w ? 1 : 0, now)
    }
    return ` (a copy of ${found.length} draft${found.length === 1 ? '' : 's'}${widening ? ', wider than its sources' : ''})`
  }

  /** Commit records + audit for a placed file; undo the placement if that fails. Then GC and index. */
  private commitPlaced(p: Placed, node: Node, command: string, vpath: string): { version: number; fileId: number } {
    const now = Date.now()
    let version = 1, dropped: string[] = [], fileId = 0
    try {
      this.db.transaction(() => {
        if (p.replaced) ({ version, dropped, fileId } = trackReplace(this.db, p, this.personId, now, this.s.versionsKept))
        else fileId = trackNew(this.db, p, this.personId, now)
        const copies = this.noteDraftCopies(p, node, now)
        this.audit(command + copies, [vpath])
      })()
    } catch (e) { p.undo(); throw e }
    gcBlobs(this.db, this.s.root, dropped)
    indexLater(this.ctx, p)
    return { version, fileId }
  }

  // ---------- operations ----------
  mkdir(parent: unknown, name: unknown, existOk = false) {
    const node = this.writable(parent, 'mkdir')
    const n = checkName(name, 'folder name')
    const vpath = `${node.vpath}/${n}`
    const there = taken(node.real, n)
    if (there) {
      const e = this.access.child(node, there)
      if (existOk && e?.kind === 'dir' && this.access.visible(e.node)) return { path: e.node.vpath, created: false }
      throw new ManagedError(409, 'exists', `${there} already exists here`)
    }
    recheckDir(node)
    const real = path.join(node.real, n)
    fs.mkdirSync(real, { mode: 0o700 })
    try { this.db.transaction(() => this.audit(`files mkdir ${vpath}`, [vpath]))() } catch (e) { try { fs.rmdirSync(real) } catch {} throw e }
    return { path: vpath, created: true }
  }

  /** A staged file into a folder (upload, chunked upload, promote). The staging file is consumed either way. */
  put(parent: unknown, name: unknown, staged: Staged, conflict: Conflict, via = 'upload') {
    try {
      const node = this.writableFor(parent, typeof name === 'string' ? name : undefined, conflict, via)
      let n = checkName(name, 'file name')
      refuseLinkLike(staged)
      const there = taken(node.real, n)
      const folderWrite = this.canWrite(node)
      if (there && conflict === 'replace') {
        const e = this.access.child(node, there)
        if (!e || e.kind !== 'file') throw new ManagedError(409, 'exists', `${there} exists here and is not a file you can replace`)
        if (!folderWrite) this.mayWriteFile(e) // a file Editor (A2): this file only
        ensureRoom(this.db, this.s, staged.size)
        const p = placeReplace(this.s.root, node, e, staged)
        const { version, fileId } = this.commitPlaced(p, node, `files ${via} ${e.vpath} (new version, ${staged.size} bytes, sha256 ${staged.sha256})`, e.vpath)
        return { path: e.vpath, name: e.name, version, replaced: true, file_id: fileId }
      }
      if (!folderWrite) this.mayWrite(node) // a new file needs write on the folder
      if (there && conflict === 'rename') n = freeName(node.real, n)
      else if (there) throw new ManagedError(409, 'exists', `${there} already exists here`)
      ensureRoom(this.db, this.s, staged.size)
      const p = placeNew(node, n, staged)
      const vpath = `${node.vpath}/${n}`
      const { fileId } = this.commitPlaced(p, node, `files ${via} ${vpath} (${staged.size} bytes, sha256 ${staged.sha256})`, vpath)
      return { path: vpath, name: n, version: 1, replaced: false, file_id: fileId }
    } finally { dropStaged(staged) }
  }

  rename(vpath: unknown, name: unknown) {
    const e = this.entry(vpath)
    if (!e) this.missing(`files rename ${String(vpath)}`)
    const parent = this.parentOf(e)
    if (!parent) throw new ManagedError(403, 'top_folder', 'team folders are renamed by the admin (Folders)')
    this.mayWrite(parent)
    const n = checkName(name, 'name')
    const oldName = entryName(e), from = this.vpathOf(e)
    const real = e.kind === 'dir' ? e.node.real : e.real
    if (n === oldName) return { path: from }
    if (taken(parent.real, n, path.basename(real))) throw new ManagedError(409, 'exists', `${n} already exists here`)
    recheckDir(parent)
    const to = path.join(parent.real, n)
    fs.renameSync(real, to)
    if (e.kind === 'dir') relocateFolderRows(this.db, real, to)
    const vto = `${parent.vpath}/${n}`
    try { this.db.transaction(() => {
      relocateCopies(this.db, real, to)
      if (e.kind === 'file') relocate(this.db, String(e.dev), String(e.ino), () => ensureFolder(this.db, parent.real, parent.dev, parent.ino, parent.birth), n)
      this.audit(`files rename ${from} -> ${vto}`, [from, vto])
    })() } catch (err) {
      fs.renameSync(to, real); if (e.kind === 'dir') relocateFolderRows(this.db, to, real); throw err
    }
    return { path: vto }
  }

  /** Move items into a folder. Each item is its own change (and audit row); results per item. */
  move(vpaths: unknown, to: unknown, conflict: Conflict = 'fail') {
    const list = this.batch(vpaths)
    const target = this.writable(to, 'move')
    const out: { from: string; to?: string; error?: string; message?: string; widens?: number; shared_with?: number; unshared?: number }[] = []
    for (const v of list) {
      try { out.push({ from: v, ...this.moveOne(v, target, conflict) }) } catch (e) {
        if (!(e instanceof ManagedError)) throw e
        out.push({ from: v, error: e.code, message: e.message })
      }
    }
    return { results: out }
  }
  /** One item into a folder under a new name (a mounted drive's MOVE): the same checks as move, then the name. */
  moveTo(vpath: string, to: unknown, name: unknown) {
    const target = this.writable(to, 'move')
    return this.moveOne(vpath, target, 'fail', checkName(name))
  }
  private moveOne(vpath: string, target: Node, conflict: Conflict, newName?: string) {
    const e = this.entry(vpath)
    if (!e) this.missing(`files move ${vpath}`)
    const parent = this.parentOf(e)
    if (!parent) throw new ManagedError(403, 'top_folder', 'team folders are moved by the admin')
    this.mayWrite(parent)
    const real = e.kind === 'dir' ? e.node.real : e.real
    if (parent.real === target.real) return newName === undefined ? { to: vpath } : { to: this.rename(vpath, newName).path, widens: 0 }
    let files: FileEntry[] = e.kind === 'file' ? [e] : []
    if (e.kind === 'dir') {
      if (target.real === real || target.real.startsWith(real + '/')) throw new ManagedError(400, 'into_itself', 'a folder cannot be moved into itself')
      files = this.subtree(e.node).files
    }
    // file shares (A2): grantees see the new place's folder names; into a personal folder they are removed (R0: only
    // its owner reads there, and moving it back out must not silently share it again)
    const sharedWith = grantsOn(this.db, files)
    const intoPersonal = target.rows.some((r) => r.personal_owner != null)
    let n = newName ?? entryName(e)
    if (taken(target.real, n)) {
      if (conflict !== 'rename') throw new ManagedError(409, 'exists', `${n} already exists in ${target.vpath}`)
      n = freeName(target.real, n)
    }
    recheckDir(parent); recheckDir(target)
    const dest = path.join(target.real, n)
    fs.renameSync(real, dest)
    if (e.kind === 'dir') relocateFolderRows(this.db, real, dest)
    const vto = `${target.vpath}/${n}`
    const widens = this.widens(parent.rows, target.rows)
    let unshared = 0
    try {
      this.db.transaction(() => {
        relocateCopies(this.db, real, dest) // AI-draft copies are found where they are now (src/share/rejudge.ts)
        if (e.kind === 'file') relocate(this.db, String(e.dev), String(e.ino), () => ensureFolder(this.db, target.real, target.dev, target.ino, target.birth), n)
        if (intoPersonal && sharedWith) unshared = dropGrantsOf(this.db, files)
        const shareNote = unshared ? ` (unshared: ${unshared})` : sharedWith ? ` (shared with: ${sharedWith})` : ''
        this.audit(`files move ${vpath} -> ${vto}${widens ? ` (widens: ${widens} more ${widens === 1 ? 'person reads' : 'people read'} it)` : ''}${shareNote}`, [vpath, vto])
      })()
    } catch (err) { fs.renameSync(dest, real); if (e.kind === 'dir') relocateFolderRows(this.db, dest, real); throw err }
    return { to: vto, widens, ...(sharedWith ? { shared_with: sharedWith } : {}), ...(unshared ? { unshared } : {}) }
  }

  /** Copy files (not folders) into a folder; a name that is taken gets " (1)". */
  copy(vpaths: unknown, to: unknown) {
    const list = this.batch(vpaths)
    const target = this.writable(to, 'copy')
    const out: { from: string; to?: string; error?: string; message?: string; widens?: number }[] = []
    for (const v of list) {
      try {
        const e = this.entry(v)
        if (!e) this.missing(`files copy ${v}`)
        if (e.kind !== 'file') throw new ManagedError(400, 'is_folder', 'folders are not copied; make a folder and copy the files')
        ensureRoom(this.db, this.s, e.size)
        const staged = stageCopy(this.s.root, e)
        let p: Placed
        try { p = placeNew(target, freeName(target.real, e.name), staged) } catch (err) { dropStaged(staged); throw err }
        const vto = `${target.vpath}/${p.name}`
        const widens = this.widens(e.parent.rows, target.rows)
        this.commitPlaced(p, target, `files copy ${v} -> ${vto}${widens ? ` (widens: ${widens} more ${widens === 1 ? 'person reads' : 'people read'} it)` : ''}`, vto)
        out.push({ from: v, to: vto, widens })
      } catch (err) {
        if (!(err instanceof ManagedError)) throw err
        out.push({ from: v, error: err.code, message: err.message })
      }
    }
    return { results: out }
  }

  /** Delete = move to the trash (kept trashDays days; restore puts it back). */
  remove(vpaths: unknown) {
    const list = this.batch(vpaths)
    const out: { path: string; trash_id?: number; error?: string; message?: string }[] = []
    for (const v of list) {
      try { out.push({ path: v, trash_id: this.removeOne(v) }) } catch (e) {
        if (!(e instanceof ManagedError)) throw e
        out.push({ path: v, error: e.code, message: e.message })
      }
    }
    return { results: out }
  }
  /** One item to the trash (throws, with its status); returns the trash item's id. */
  removeOne(vpath: string): number {
    const e = this.entry(vpath)
    if (!e) this.missing(`files delete ${vpath}`)
    const parent = this.parentOf(e)
    if (!parent) throw new ManagedError(403, 'top_folder', 'team folders are removed by the admin')
    this.mayWrite(parent)
    let bytes = 0, count = 1
    if (e.kind === 'dir') { const t = this.subtree(e.node); bytes = t.bytes; count = t.files.length } else bytes = e.size
    const real = e.kind === 'dir' ? e.node.real : e.real
    const name = entryName(e)
    recheckDir(parent)
    const box = path.join(ensureRoot(this.s.root).trash, crypto.randomUUID())
    fs.mkdirSync(box, { mode: 0o700 })
    const dest = path.join(box, path.basename(real))
    const st = fs.lstatSync(real, { bigint: true })
    fs.renameSync(real, dest)
    if (e.kind === 'dir') relocateFolderRows(this.db, real, dest)
    const now = Date.now()
    let id = 0
    try {
      this.db.transaction(() => {
        const pid = ensureFolder(this.db, parent.real, parent.dev, parent.ino, parent.birth)
        id = Number(this.db.query(`INSERT INTO mtrash (kind, name, orig_parent, orig_vpath, trash_path, dev, ino, size, files, deleted_at, deleted_by, purge_after)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(e.kind, name, pid, vpath, dest, String(st.dev), String(st.ino), bytes, count, now, this.personId,
          now + this.s.trashDays * 86400_000).lastInsertRowid)
        relocateCopies(this.db, real, dest)
        this.audit(`files delete ${vpath} (to the trash${e.kind === 'dir' ? `, ${count} files` : ''})`, [vpath])
      })()
    } catch (err) {
      fs.renameSync(dest, real); if (e.kind === 'dir') relocateFolderRows(this.db, dest, real); try { fs.rmdirSync(box) } catch {}
      throw err
    }
    return id
  }

  private batch(vpaths: unknown): string[] {
    const list = Array.isArray(vpaths) ? vpaths : [vpaths]
    if (!list.length || list.length > MANAGED_LIMITS.batchItems || list.some((x) => typeof x !== 'string')) throw new ManagedError(400, 'bad_paths', `give 1–${MANAGED_LIMITS.batchItems} paths`)
    return list as string[]
  }

  // ---------- versions ----------
  private fileAt(vpath: unknown, action: string): FileEntry {
    const e = this.entry(vpath)
    if (!e || e.kind !== 'file') this.missing(`files ${action} ${String(vpath)}`)
    return e
  }
  /** Earlier versions are shown to folder readers and to file Editors; a file-only Viewer sees the current one only
   * (earlier versions may hold content removed before the file was shared: A2 F7). */
  seesHistory(f: FileEntry) { return !this.fileOnly(f) || this.access.levelOfFile(f) >= 2 }
  versions(vpath: unknown) {
    const f = this.fileAt(vpath, 'versions')
    const row = fileRowOf(this.db, f)
    const who = (id: number | null) => id == null ? null : this.db.query<{ name: string }, [number]>('SELECT name FROM people WHERE id = ?').get(id)?.name ?? null
    const current = { version: row?.version ?? 1, size: f.size, at: row?.updated_at ?? Math.round(f.mtimeMs), by: who(row?.updated_by ?? null), sha256: row?.sha256 ?? null, current: true }
    const history = this.seesHistory(f)
    const older = row && history ? this.db.query<{ version: number; sha256: string; size: number; created_at: number; created_by: number | null }, [number]>(
      'SELECT version, sha256, size, created_at, created_by FROM mversions WHERE file_id = ? ORDER BY version DESC').all(row.id) : []
    this.audit(`files versions ${f.vpath}`, [f.vpath])
    return { path: f.vpath, managed: inManaged(this.ids, f.parent), writable: this.canWriteFile(f), history: history ? 'all' as const : 'editors_only' as const, kept: this.s.versionsKept,
      versions: [current, ...older.map((v) => ({ version: v.version, size: v.size, at: v.created_at, by: who(v.created_by), sha256: v.sha256, current: false }))] }
  }
  /** An earlier version's bytes (a path in the versions store, read by the caller), audited like a download. */
  versionFile(vpath: unknown, version: unknown): { file: string; size: number; name: string } {
    const f = this.fileAt(vpath, 'version-download')
    const v = this.olderVersion(f, version)
    this.audit(`files download ${f.vpath} v${v.version}`, [f.vpath])
    return { file: blobPath(this.s.root, v.sha256), size: v.size, name: f.name }
  }
  private olderVersion(f: FileEntry, version: unknown) {
    if (!this.seesHistory(f)) throw new ManagedError(404, 'no_version', 'no such version')
    const row = fileRowOf(this.db, f)
    const v = row && this.db.query<{ version: number; sha256: string; size: number }, [number, number]>('SELECT version, sha256, size FROM mversions WHERE file_id = ? AND version = ?').get(row.id, Number(version))
    if (!v) throw new ManagedError(404, 'no_version', 'no such version')
    return v
  }
  restoreVersion(vpath: unknown, version: unknown) {
    const f = this.fileAt(vpath, 'version-restore')
    this.mayWriteFile(f)
    const v = this.olderVersion(f, version)
    ensureRoom(this.db, this.s, v.size)
    const staged = stageVersion(this.s.root, v.sha256)
    try {
      const p = placeReplace(this.s.root, f.parent, f, staged)
      const r = this.commitPlaced(p, f.parent, `files restore-version ${f.vpath} v${v.version} (as a new version)`, f.vpath)
      return { path: f.vpath, version: r.version }
    } finally { dropStaged(staged) }
  }

  // ---------- trash ----------
  /** R1 for a trash item: the person reads its folder now and, for a folder, every rule-bearing folder that was in it. */
  private trashParent(t: TrashRow): Node | null {
    const parent = this.access.nodeForFolder(t.orig_parent)
    if (!parent || !this.access.canRead(parent)) return null
    if (t.kind === 'dir') {
      const inside = this.db.query<FolderRow, [string, number, string]>('SELECT * FROM folders WHERE path = ? OR substr(path, 1, ?) = ?')
        .all(t.trash_path, t.trash_path.length + 1, t.trash_path + '/').sort((a, b) => a.path.length - b.path.length)
      for (const r of inside) {
        const chain = [...parent.rows, ...inside.filter((x) => r.path === x.path || r.path.startsWith(x.path + '/'))]
        if (chain.some((x) => x.quarantine || x.widened_pending)) return null
        if (effectiveLevel(chain, this.personId, this.access.groups, this.access.rulesMap()) < 1) return null
      }
    }
    return parent
  }
  trash() {
    purgeExpired(this.ctx)
    const who = (id: number) => this.db.query<{ name: string }, [number]>('SELECT name FROM people WHERE id = ?').get(id)?.name ?? null
    const items = []
    for (const t of liveTrash(this.db)) {
      const parent = this.trashParent(t)
      if (!parent) continue
      items.push({ id: t.id, name: t.name, kind: t.kind === 'dir' ? 'folder' : 'file', from: parent.vpath, size: t.size, files: t.files,
        deleted_at: t.deleted_at, deleted_by: who(t.deleted_by), purge_after: t.purge_after, can_restore: this.canWrite(parent) })
    }
    this.audit('files trash', [])
    return { items, days: this.s.trashDays }
  }
  private trashItem(id: unknown, action: string): { t: TrashRow; parent: Node } {
    const t = liveTrash(this.db).find((x) => x.id === Number(id))
    const parent = t && this.trashParent(t)
    if (!t || !parent) this.missing(`trash ${action} #${String(id)}`)
    this.mayWrite(parent)
    return { t, parent }
  }
  restore(id: unknown) {
    const { t, parent } = this.trashItem(id, 'restore')
    const name = freeName(parent.real, t.name)
    recheckDir(parent)
    const dest = path.join(parent.real, name)
    fs.renameSync(t.trash_path, dest)
    if (t.kind === 'dir') relocateFolderRows(this.db, t.trash_path, dest)
    const vto = `${parent.vpath}/${name}`
    try {
      this.db.transaction(() => {
        this.db.query('UPDATE mtrash SET restored_at = ?, restored_by = ? WHERE id = ?').run(Date.now(), this.personId, t.id)
        relocateCopies(this.db, t.trash_path, dest)
        // a shared file comes back with its shares (its location points where it is again; a folder's rows moved back)
        if (t.kind === 'file') relocate(this.db, t.dev, t.ino, () => ensureFolder(this.db, parent.real, parent.dev, parent.ino, parent.birth), name)
        this.audit(`trash restore #${t.id} -> ${vto}`, [vto])
      })()
    } catch (e) { fs.renameSync(dest, t.trash_path); if (t.kind === 'dir') relocateFolderRows(this.db, dest, t.trash_path); throw e }
    try { fs.rmdirSync(path.dirname(t.trash_path)) } catch {}
    return { path: vto }
  }
  /** Delete forever (needs write where it came from). */
  purge(id: unknown) {
    const { t, parent } = this.trashItem(id, 'purge')
    purgeItem(this.ctx, t, () => this.audit(`trash delete-forever #${t.id} (${parent.vpath}/${t.name})`, [`${parent.vpath}/${t.name}`]))
    return { ok: true }
  }
  /** Delete forever everything in the trash this person may restore. */
  emptyTrash() {
    let n = 0
    for (const t of liveTrash(this.db)) {
      const parent = this.trashParent(t)
      if (!parent || !this.canWrite(parent)) continue
      purgeItem(this.ctx, t, () => this.audit(`trash delete-forever #${t.id} (${parent.vpath}/${t.name})`, [`${parent.vpath}/${t.name}`]))
      n++
    }
    return { deleted: n }
  }
}

/** R1 ⑤: bytes that a Mac or an SMB share would take for a link (XSym, alias) are closed on read; refuse them up front. */
function refuseLinkLike(staged: Staged) {
  const fd = fs.openSync(staged.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const b = Buffer.alloc(Math.min(SNIFF_BYTES, staged.size))
    const n = b.length ? fs.readSync(fd, b, 0, b.length, 0) : 0
    if (sniffLink(b.subarray(0, n), staged.size)) throw new ManagedError(422, 'bad_content', 'this file looks like a link (XSym / Mac alias) and cannot be stored here')
  } finally { fs.closeSync(fd) }
}

// ---------- trash rows, purge ----------
export interface TrashRow {
  id: number; kind: 'file' | 'dir'; name: string; orig_parent: number; orig_vpath: string; trash_path: string; dev: string; ino: string
  size: number; files: number; deleted_at: number; deleted_by: number; purge_after: number
}
export const liveTrash = (db: DB) => db.query<TrashRow, []>('SELECT * FROM mtrash WHERE restored_at IS NULL AND purged_at IS NULL ORDER BY deleted_at DESC').all()

/** Remove a trash item's bytes for good: file rows and their versions go, folder rows inside are retired. */
export function purgeItem(ctx: Pick<Ctx, 'db' | 'dataDir'>, t: TrashRow, auditRow: () => void) {
  const db = ctx.db
  const root = storageSettings(db, ctx.dataDir).root
  const walk = diskWalk(t.trash_path)
  let shas: string[] = []
  db.transaction(() => {
    for (const f of walk.files) shas = shas.concat(dropRow(db, f.dev, f.ino))
    if (t.kind === 'dir') retireFolderRows(db, t.trash_path)
    db.query('UPDATE mtrash SET purged_at = ? WHERE id = ?').run(Date.now(), t.id)
    auditRow()
  })()
  fs.rmSync(path.dirname(t.trash_path), { recursive: true, force: true })
  gcBlobs(db, root, shas)
}

/** Items past their days in the trash (lazily, on every trash view, and on a timer in `serve`). */
export function purgeExpired(ctx: Pick<Ctx, 'db' | 'dataDir'>, now = Date.now()): number {
  const due = ctx.db.query<TrashRow, [number]>('SELECT * FROM mtrash WHERE restored_at IS NULL AND purged_at IS NULL AND purge_after <= ?').all(now)
  for (const t of due) purgeItem(ctx, t, () => appendAudit(ctx.db, { personId: null, tokenId: null, tool: 'web', command: `trash expired #${t.id} (${t.orig_vpath})`, files: [t.orig_vpath], outcome: 'ok' }))
  // unfinished uploads past their time
  for (const u of ctx.db.query<{ id: string }, [number]>("SELECT id FROM muploads WHERE state = 'open' AND expires_at <= ?").all(now)) {
    ctx.db.query("UPDATE muploads SET state = 'expired' WHERE id = ?").run(u.id)
    try { fs.unlinkSync(path.join(systemDirs(storageSettings(ctx.db, ctx.dataDir).root).uploads, `${u.id}.part`)) } catch {}
  }
  return due.length
}

/**
 * Bring the file rows in line with the disk (files put into the managed root by hand, or a database restored from an
 * older backup): every regular file in the managed folders and the trash has a row with its sha256; rows of files
 * that are gone are dropped (with their versions and file grants). When a walk stopped early (more entries than
 * MANAGED_LIMITS.walkEntries), rows it did not see are NOT dropped: unseen is not gone (`partial: true`). Shared files
 * found at another place have their location updated (relocateShared). Returns how many rows were added and dropped.
 */
export function rescan(ctx: Pick<Ctx, 'db' | 'dataDir'>): { added: number; dropped: number; partial?: true; relocated?: number } {
  const db = ctx.db
  const root = storageSettings(db, ctx.dataDir).root
  const mounts = db.query<{ path: string }, []>('SELECT f.path FROM managed_mounts m JOIN folders f ON f.id = m.folder_id').all().map((r) => r.path)
  const seen = new Set<string>()
  let added = 0, dropped = 0, partial = false
  const now = Date.now()
  for (const top of [...mounts, systemDirs(root).trash]) {
    const walk = diskWalk(top)
    partial ||= walk.partial
    for (const f of walk.files) {
      if (path.basename(f.real).endsWith('.part')) continue
      seen.add(`${f.dev}:${f.ino}`)
      const st = fs.lstatSync(f.real, { bigint: true })
      if (fileRowOf(db, { dev: f.dev, ino: f.ino, size: f.size, mtimeNs: st.mtimeNs })) continue
      let fd: number
      try { fd = openOriginal(f.real, { dev: f.dev, ino: f.ino }) } catch { continue }
      let h: { sha256: string }
      try { h = hashOf(fd) } finally { fs.closeSync(fd) }
      db.transaction(() => {
        dropRow(db, f.dev, f.ino)
        db.query('INSERT INTO mfiles (dev, ino, size, mtime_ns, sha256, version, created_at, created_by, updated_at, updated_by, uid) VALUES (?, ?, ?, ?, ?, 1, ?, NULL, ?, NULL, ?)')
          .run(f.dev, f.ino, f.size, String(st.mtimeNs), h.sha256, now, now, newUid())
      })()
      added++
    }
  }
  let shas: string[] = []
  if (!partial) {
    for (const r of db.query<{ dev: string; ino: string }, []>('SELECT dev, ino FROM mfiles').all()) {
      if (seen.has(`${r.dev}:${r.ino}`)) continue
      db.transaction(() => { shas = shas.concat(dropRow(db, r.dev, r.ino)) })()
      dropped++
    }
  }
  gcBlobs(db, root, shas)
  const relocated = partial ? 0 : relocateShared(db).moved
  return { added, dropped, ...(partial ? { partial: true as const } : {}), ...(relocated ? { relocated } : {}) }
}
