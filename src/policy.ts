// The one place that decides what an agent may see (plan 4.1 R0, R1, R4 ①–④, R5, R6).
// Shell, read tool, grep, mirror and drafts all go through Access. Token scope is computed in here, never outside.
//
// Folders are known by filesystem identity (dev+ino). A walk always starts at a registered folder whose identity is
// checked, lstat's every step (a symlink anywhere is closed, never followed), and uses names from readdir: the name
// an agent typed is only compared (on NFC) against the listing, never handed to the OS.
import fs from 'node:fs'
import path from 'node:path'
import type { DB } from './db'
import { loadClosures, type Closures } from './inplace/closures'
import { appleDoubleSaysLink, sniffLink, SNIFF_BYTES } from './inplace/linkish'
import { isSystemName, nfc, nfcCollisions } from './names'
import { identityKey, isFolder, sameBirth, type FolderRow, type RuleRow, type TokenRow } from './store'

export interface Node {
  real: string
  vpath: string
  dev: bigint
  ino: bigint
  /** birth time (0n where the file system has none): with dev + ino, which folder this is (store.sameBirth) */
  birth: bigint
  /** known folder rows from the mount down to this folder (inclusive when it has a row) */
  rows: FolderRow[]
  parent: Node | null
}
export interface FileEntry {
  kind: 'file'; parent: Node; name: string; real: string; vpath: string; dev: bigint; ino: bigint; size: number; mtimeMs: number; mtimeNs: bigint
  /** change time: moves whenever the content (or metadata) is written, and cannot be set back like mtime */
  ctimeNs: bigint
}
export interface DirEntry { kind: 'dir'; node: Node }
export type Entry = FileEntry | DirEntry

export class Closed extends Error {}

/** Called with the real path when a re-check (⑦) fails, so the reconciler can look at that folder again right away. */
let recheckFailed: ((real: string) => void) | null = null
export function onRecheckFailure(fn: ((real: string) => void) | null) { recheckFailed = fn }

/** Called when deciding about a path failed unexpectedly (the path is then closed). Default: the server log. */
let policyError: ((real: string, e: unknown) => void) | null = (real, e) => console.error(`[policy] closed after an error at ${real}:`, e)
export function onPolicyError(fn: ((real: string, e: unknown) => void) | null) { policyError = fn }

type Readdir = (real: string) => string[]

/** Some step of an absolute server path is a NAS/OS system folder (R1 ⑥). */
const onSystemPath = (real: string) => real.split(path.sep).some((n) => n !== '' && isSystemName(n))

const FLAGGED = (r: FolderRow) => r.no_ai || r.quarantine || r.widened_pending
/** People on the web: "No AI" closes AI connections only (plan 5.1 "AI 연결 금지(웹의 사람만)"); the other flags still close. */
const FLAGGED_FOR_PEOPLE = (r: FolderRow) => r.quarantine || r.widened_pending

/** Who is reading: an agent through a token (the default), or a person in their own web session (no token scope). */
export type Audience = 'agent' | 'person'

/** A Minshall-French symlink ("XSym") as macOS smbfs stores links on SMB shares: 1067 bytes, "XSym\n" + 4-digit length. */
const XSYM_SIZE = 1067
const isXSymHeader = (b: Uint8Array) => b.length >= 10 && Buffer.from(b.subarray(0, 10)).toString('latin1').match(/^XSym\n\d{4}\n$/) !== null

/** R1 ⑤: a regular file that is really a link written by a Mac (XSym). Read without following, from the exact entry. */
function isXSymFile(real: string, size: bigint): boolean {
  if (size !== BigInt(XSYM_SIZE)) return false
  let fd: number
  try { fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK) } catch { return true }
  try {
    const b = Buffer.alloc(10)
    return isXSymHeader(b.subarray(0, fs.readSync(fd, b, 0, 10, 0)))
  } catch { return true } finally { fs.closeSync(fd) }
}

/** Bytes of an AppleDouble sidecar read for its Finder info (the entry sits near the start). */
const SIDECAR_BYTES = 64 * 1024

/**
 * R1 ⑤: the `._name` AppleDouble sidecar next to a file (how SMB/NAS keep a Mac's Finder info) says the file is an alias
 * or a Mac symlink. Read without following; a sidecar that cannot be read says nothing.
 */
function sidecarSaysLink(dir: string, name: string): boolean {
  let fd: number
  try { fd = fs.openSync(path.join(dir, '._' + name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK) } catch { return false }
  try {
    if (!fs.fstatSync(fd).isFile()) return false
    const b = Buffer.alloc(SIDECAR_BYTES)
    return appleDoubleSaysLink(b.subarray(0, fs.readSync(fd, b, 0, b.length, 0)))
  } catch { return false } finally { fs.closeSync(fd) }
}

/** R0: max over the person and their groups of the rules from F up to the nearest break (inclusive). */
export function effectiveLevel(rows: FolderRow[], personId: number, groups: Set<number>, rules: Map<number, RuleRow[]>): number {
  // Inside a personal folder only its owner counts, whatever lies below it (R0: no registration, rule or break may sit
  // inside one — but rows made before the folder became personal, or by another path, must not reopen it).
  const personal = rows.filter((r) => r.personal_owner != null)
  if (personal.length) return personal.every((r) => r.personal_owner === personId) ? 2 : 0
  let best = 0
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!
    for (const rule of rules.get(r.id) ?? []) {
      if ((rule.subject_type === 'person' && rule.subject_id === personId) || (rule.subject_type === 'group' && groups.has(rule.subject_id))) best = Math.max(best, rule.level)
    }
    if (r.registered || r.inherit_break) break
  }
  return best
}

/**
 * A file shared with this principal (A2, src/share/file-grants.ts): the file's row (identity, size, mtime as the server
 * wrote it) and the best level over the person's own grant and their groups' (a group's grant counts only while the
 * group is the one it was made for: same groups.uid). `folder`/`name`: where it was last seen (finds; never opens).
 */
export interface FileGrant { uid: string; dev: string; ino: string; size: number; mtime_ns: string; level: number; folder_id: number | null; name: string | null; folder?: FolderRow }

export class Access {
  readonly personId: number
  readonly groups: Set<number>
  readonly scope: Set<number> | null
  readonly audience: Audience
  private readonly byIdentity = new Map<string, FolderRow>()
  private readonly byId = new Map<number, FolderRow>()
  private readonly rules = new Map<number, RuleRow[]>()
  private readonly listCache = new Map<string, { names: string[]; collide: Set<string>; sidecars: Set<string> } | null>()
  private readonly visibleCache = new Map<string, boolean>()
  private mountMap: Map<string, FolderRow> | null = null
  /** reconciler findings: closed identities (R1 ⑤, R6, R10) and paths of lost rule-bearing folders */
  private readonly closures: Closures
  private readonly indexedAt: (dev: bigint, ino: bigint) => { path: string }[]
  /** files shared with this principal, by identity (dev:ino) */
  private readonly fileGrants = new Map<string, FileGrant>()
  private readonly managedIds: Set<number>

  constructor(readonly db: DB, principal: { personId: number; token?: TokenRow; audience?: Audience }, private readonly readdir: Readdir = (p) => fs.readdirSync(p)) {
    this.personId = principal.personId
    this.audience = principal.audience ?? 'agent'
    this.groups = new Set(db.query<{ group_id: number }, [number]>('SELECT group_id FROM memberships WHERE person_id = ?').all(this.personId).map((g) => g.group_id))
    const scope = principal.token?.scope
    this.scope = scope ? new Set(JSON.parse(scope) as number[]) : null
    for (const f of db.query<FolderRow, []>('SELECT * FROM folders').all()) { this.byIdentity.set(identityKey(f.dev, f.ino), f); this.byId.set(f.id, f) }
    for (const r of db.query<RuleRow, []>('SELECT * FROM rules').all()) this.rules.set(r.folder_id, [...(this.rules.get(r.folder_id) ?? []), r])
    this.closures = loadClosures(db)
    const q = db.query<{ path: string }, [string, string]>('SELECT path FROM fs_index WHERE dev = ? AND ino = ?')
    this.indexedAt = (dev, ino) => q.all(String(dev), String(ino))
    this.managedIds = new Set(db.query<{ folder_id: number }, []>('SELECT folder_id FROM managed_mounts').all().map((r) => r.folder_id))
    // R0′ (A2): file shares of this person (the server principal, -1, has none)
    if (this.personId > 0) {
      for (const g of db.query<Omit<FileGrant, 'folder'>, [number]>(`
          SELECT m.uid, m.dev, m.ino, m.size, m.mtime_ns, m.folder_id, m.name, max(g.level) AS level
          FROM file_grants g JOIN mfiles m ON m.uid = g.file_uid
          WHERE (g.subject_type = 'person' AND g.subject_id = ?1)
             OR (g.subject_type = 'group' AND g.subject_id IN (SELECT group_id FROM memberships WHERE person_id = ?1)
                 AND EXISTS (SELECT 1 FROM groups x WHERE x.id = g.subject_id AND x.uid = g.subject_uid))
          GROUP BY m.uid`).all(this.personId)) {
        this.fileGrants.set(identityKey(g.dev, g.ino), { ...g, folder: g.folder_id == null ? undefined : this.byId.get(g.folder_id) })
      }
    }
  }

  static forToken(db: DB, token: TokenRow, readdir?: Readdir) { return new Access(db, { personId: token.person_id, token }, readdir) }
  /** A person on the web: a full-scope "token" of their own; "No AI" does not apply (it closes AI connections only). */
  static forPerson(db: DB, personId: number, readdir?: Readdir) { return new Access(db, { personId, audience: 'person' }, readdir) }

  // ---------- R0 / R1 on a folder node ----------
  level(node: Node, personId = this.personId, groups = this.groups) { return effectiveLevel(node.rows, personId, groups, this.rules) }
  flagged(node: Node) { return node.rows.some(this.audience === 'person' ? FLAGGED_FOR_PEOPLE : FLAGGED) }
  inScope(node: Node) { return this.scope === null || node.rows.some((r) => this.scope!.has(r.id)) }
  /** R1 ①–④ for files directly in this folder (① holds for every node: walks start at a registered folder) */
  canRead(node: Node) { return !this.flagged(node) && this.level(node) >= 1 && this.inScope(node) }

  // ---------- R0′ / R1′ on a file (A2: file shares in managed storage) ----------
  /**
   * FG(P, f): the level a share gives on exactly this file — the same identity, size and mtime as its row (a file
   * replaced by hand, or another file on a reused inode number, gets nothing). Managed storage only, never inside a
   * personal folder (only its owner reads there, R0).
   */
  fileLevel(f: FileEntry): number {
    if (!this.fileGrants.size) return 0
    const g = this.fileGrants.get(identityKey(f.dev, f.ino))
    if (!g || g.size !== f.size || g.mtime_ns !== String(f.mtimeNs)) return 0
    const rows = f.parent.rows
    if (!rows.length || !this.managedIds.has(rows[0]!.id) || rows.some((r) => r.personal_owner != null)) return 0
    return g.level
  }
  /** R0′: level(P, f) = max(level(P, F), FG(P, f)). */
  levelOfFile(f: FileEntry) { return Math.max(this.level(f.parent), this.fileLevel(f)) }
  /** R1′ for a file: its folder's flags (for this audience) and token scope, and R0′ ≥ read. */
  canReadFile(f: FileEntry) { return !this.flagged(f.parent) && this.inScope(f.parent) && this.levelOfFile(f) >= 1 }
  /** Has file shares at all (cheap checks skip the file-level work for everyone else). */
  hasFileGrants() { return this.fileGrants.size > 0 }
  /**
   * R4 for a source reached through a file share (via_file): this principal reads, right now, some file shared with
   * them directly in folder `id` (found by its location, opened only by its identity).
   */
  canReadSharedIn(id: number): boolean {
    if (!this.fileGrants.size) return false
    let node: Node | null | undefined
    for (const g of this.fileGrants.values()) {
      if (g.folder_id !== id || g.name == null) continue
      if (node === undefined) node = this.nodeForFolder(id)
      if (!node) return false
      const e = this.child(node, g.name)
      if (e?.kind === 'file' && this.canReadFile(e)) return true
    }
    return false
  }
  /** A file shared with this principal lies at or below `node` and can be read: the folder is a bare path to it. */
  private sharedBelow(node: Node): boolean {
    for (const g of this.fileGrants.values()) {
      if (!g.folder || g.name == null || !(g.folder.path === node.real || g.folder.path.startsWith(node.real + '/'))) continue
      const dir = g.folder.path === node.real ? node : this.descend(node, path.relative(node.real, g.folder.path).split(path.sep))
      if (!dir || !isFolder(g.folder, dir.dev, dir.ino, dir.birth)) continue // the row is that folder on disk
      const e = this.child(dir, g.name) // lstat, links closed, identity: the location only finds
      if (e?.kind === 'file' && this.canReadFile(e)) return true // the file is the shared one (fileLevel checks it)
    }
    return false
  }

  /** A folder is shown when it can be read, or when something readable lies below it (then it is a bare path). */
  visible(node: Node): boolean {
    const hit = this.visibleCache.get(node.real)
    if (hit !== undefined) return hit
    let v = this.canRead(node)
    if (!v) {
      for (const a of this.anchorsBelow(node)) {
        const below = this.descend(node, path.relative(node.real, a.path).split(path.sep))
        if (below && isFolder(a, below.dev, below.ino, below.birth) && this.canRead(below)) { v = true; break }
      }
    }
    if (!v && this.fileGrants.size) v = this.sharedBelow(node)
    this.visibleCache.set(node.real, v)
    return v
  }

  /** Folders below `node` where read access could start again for this principal. */
  private anchorsBelow(node: Node): FolderRow[] {
    const mine = (r: RuleRow) => r.level >= 1 && ((r.subject_type === 'person' && r.subject_id === this.personId) || (r.subject_type === 'group' && this.groups.has(r.subject_id)))
    return [...this.byId.values()].filter((f) => f.path.startsWith(node.real + '/') &&
      ((this.rules.get(f.id) ?? []).some(mine) || f.personal_owner === this.personId || !!this.scope?.has(f.id)))
  }

  private descend(node: Node, names: string[]): Node | null {
    let cur: Node = node
    for (const n of names) {
      const e = this.child(cur, n)
      if (!e || e.kind !== 'dir') return null
      cur = e.node
    }
    return cur
  }

  // ---------- walking ----------
  /** Top-level registered folders by NFC name; two with the same name are both closed. */
  mounts(): Map<string, FolderRow> {
    if (this.mountMap) return this.mountMap
    // R1 ⑥: a folder registered at or below a NAS system folder (a snapshot or recycle-bin copy) is never opened
    const reg = [...this.byId.values()].filter((f) => f.registered && !onSystemPath(f.path))
    const top = reg.filter((f) => !reg.some((o) => o !== f && f.path.startsWith(o.path + '/')))
    const count = new Map<string, number>()
    for (const f of top) count.set(nfc(f.mount_name!), (count.get(nfc(f.mount_name!)) ?? 0) + 1)
    this.mountMap = new Map(top.filter((f) => count.get(nfc(f.mount_name!)) === 1).map((f) => [nfc(f.mount_name!), f]))
    return this.mountMap
  }

  mountNode(row: FolderRow): Node | null {
    if (onSystemPath(row.path)) return null
    let st: fs.BigIntStats
    try { st = fs.lstatSync(row.path, { bigint: true }) } catch { return null }
    if (!st.isDirectory() || st.isSymbolicLink() || !isFolder(row, st.dev, st.ino, st.birthtimeNs)) return null
    if (this.closures.identities.has(identityKey(st.dev, st.ino))) return null
    return { real: row.path, vpath: '/' + nfc(row.mount_name!), dev: st.dev, ino: st.ino, birth: st.birthtimeNs, rows: [row], parent: null }
  }

  private listing(real: string) {
    if (this.listCache.has(real)) return this.listCache.get(real)!
    let v: { names: string[]; collide: Set<string>; sidecars: Set<string> } | null = null
    try {
      const names = this.readdir(real)
      v = { names, collide: nfcCollisions(names), sidecars: new Set(names.filter((n) => n.startsWith('._') && n.length > 2).map((n) => n.slice(2))) }
    } catch { v = null }
    this.listCache.set(real, v)
    return v
  }

  /**
   * One step down by an original name from the listing. Closed (null): system names, NFC collisions, links of any kind,
   * non-regular files, and anything that fails while deciding (fail closed: the same answer as a name that is not there).
   */
  child(parent: Node, name: string): Entry | null {
    try { return this.childUnguarded(parent, name) } catch (e) {
      policyError?.(path.join(parent.real, name), e)
      return null
    }
  }
  private childUnguarded(parent: Node, name: string): Entry | null {
    if (isSystemName(name)) return null
    const l = this.listing(parent.real)
    if (!l || !l.names.includes(name) || l.collide.has(name)) return null
    const real = path.join(parent.real, name)
    let st: fs.BigIntStats
    try { st = fs.lstatSync(real, { bigint: true }) } catch { return null }
    const vpath = (parent.vpath === '/' ? '' : parent.vpath) + '/' + nfc(name)
    if (st.isSymbolicLink()) return null
    const key = identityKey(st.dev, st.ino)
    if (this.closures.identities.has(key)) return null
    // ⑦ against the index: something the last reconcile saw elsewhere moved since; closed until it is judged (R10)
    const known = this.indexedAt(st.dev, st.ino)
    if (known.length && !known.some((k) => k.path === real)) { recheckFailed?.(parent.real); return null }
    if (st.isDirectory()) {
      // a lost rule-bearing folder's path: only that folder itself (same identity and birth time) opens it again
      const lost = this.closures.lostPaths.get(real)
      if (lost !== undefined && (lost.key !== key || !sameBirth(lost.birth, st.birthtimeNs))) return null
      const row = this.rowFor(st.dev, st.ino, st.birthtimeNs)
      return { kind: 'dir', node: { real, vpath, dev: st.dev, ino: st.ino, birth: st.birthtimeNs, rows: row ? [...parent.rows, row] : parent.rows, parent } }
    }
    if (!st.isFile() || st.nlink !== 1n || isXSymFile(real, st.size)) return null
    if (l.sidecars.has(name) && sidecarSaysLink(parent.real, name)) return null // a Mac alias by its Finder info
    return { kind: 'file', parent, name, real, vpath, dev: st.dev, ino: st.ino, size: Number(st.size), mtimeMs: Number(st.mtimeMs), mtimeNs: st.mtimeNs, ctimeNs: st.ctimeNs }
  }

  /** Resolve virtual path parts under the mounts. Hidden and nonexistent are the same: null. */
  lookup(parts: string[]): Entry | null {
    const row = parts.length ? this.mounts().get(nfc(parts[0]!)) : undefined
    let node = row ? this.mountNode(row) : null
    if (!node || !this.visible(node)) return null
    for (let i = 1; i < parts.length; i++) {
      const want = nfc(parts[i]!)
      const matches = (this.listing(node.real)?.names ?? []).filter((n) => nfc(n) === want)
      if (matches.length !== 1) return null
      const e = this.child(node, matches[0]!)
      if (!e) return null
      if (e.kind === 'file') return i === parts.length - 1 && (this.canRead(node) || this.canReadFile(e)) ? e : null
      if (!this.visible(e.node)) return null
      node = e.node
    }
    return { kind: 'dir', node }
  }

  /** Visible children of a folder, sorted by name. */
  list(node: Node): Entry[] {
    if (!this.visible(node)) return []
    const readable = this.canRead(node)
    const out: Entry[] = []
    for (const name of this.listing(node.real)?.names ?? []) {
      const e = this.child(node, name)
      if (!e) continue
      if (e.kind === 'dir' ? this.visible(e.node) : readable || this.canReadFile(e)) out.push(e)
    }
    return out.sort((a, b) => entryName(a).localeCompare(entryName(b)))
  }

  /** Visible top-level folders. */
  rootEntries(): Entry[] {
    const out: Entry[] = []
    for (const row of this.mounts().values()) {
      const n = this.mountNode(row)
      if (n && this.visible(n)) out.push({ kind: 'dir', node: n })
    }
    return out.sort((a, b) => entryName(a).localeCompare(entryName(b)))
  }

  /**
   * File bytes (R1 ⑤ ⑦): opened without following links, the open file must be the one the walk saw (identity,
   * one link), and every folder on the path is lstat'ed again after reading, before anything is returned.
   */
  readBytes(f: FileEntry, maxBytes: number): Uint8Array {
    let fd: number
    try { fd = fs.openSync(f.real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK) } catch { throw new Closed() }
    try {
      const st = fs.fstatSync(fd, { bigint: true })
      if (!st.isFile() || st.nlink !== 1n || st.dev !== f.dev || st.ino !== f.ino) throw new Closed()
      if (st.size > BigInt(maxBytes)) throw new Closed('too large')
      const buf = Buffer.alloc(Number(st.size))
      let off = 0
      while (off < buf.length) { const n = fs.readSync(fd, buf, off, buf.length - off, off); if (n <= 0) break; off += n }
      if (sniffLink(buf.subarray(0, SNIFF_BYTES), off)) throw new Closed() // XSym / alias: a link in a file's clothes
      if (off === XSYM_SIZE && isXSymHeader(buf)) throw new Closed()
      this.recheck(f)
      return buf.subarray(0, off)
    } finally { fs.closeSync(fd) }
  }

  /** ⑦: every step from the mount down is still the same folder (and not a link), and the file is still there. */
  recheck(f: FileEntry) {
    const same = (p: string, dev: bigint, ino: bigint, birth: bigint | null) => {
      const st = fs.lstatSync(p, { bigint: true })
      if (st.isSymbolicLink() || (birth !== null ? !st.isDirectory() || st.birthtimeNs !== birth : !st.isFile() || st.nlink !== 1n) || st.dev !== dev || st.ino !== ino) throw new Closed()
    }
    try {
      same(f.real, f.dev, f.ino, null)
      for (let n: Node | null = f.parent; n; n = n.parent) same(n.real, n.dev, n.ino, n.birth)
    } catch (e) {
      recheckFailed?.(f.parent.real)
      throw e instanceof Closed ? e : new Closed()
    }
  }

  // ---------- folders by id (drafts R4, widening R5/R6) ----------
  /** The node for a folder row, walked from its mount; null if it moved, vanished, or sits behind a link. */
  nodeForFolder(id: number): Node | null {
    const f = this.byId.get(id)
    if (!f) return null
    const mount = [...this.mounts().values()].find((m) => f.path === m.path || f.path.startsWith(m.path + '/'))
    const start = mount && this.mountNode(mount)
    if (!start) return null
    const n = f.path === mount.path ? start : this.descend(start, path.relative(mount.path, f.path).split(path.sep))
    return n && isFolder(f, n.dev, n.ino, n.birth) ? n : null
  }

  /** R4: can this token read files in folder `id` right now (R1 ①–④)? */
  canReadFolder(id: number): boolean {
    const n = this.nodeForFolder(id)
    return !!n && this.canRead(n)
  }

  folderRow(id: number) { return this.byId.get(id) }
  rowForNode(n: Node) { return this.rowFor(n.dev, n.ino, n.birth) }
  /** The folder row of a folder on disk: same identity and birth time (a reused inode number is another folder). */
  private rowFor(dev: bigint, ino: bigint, birth: bigint) {
    const row = this.byIdentity.get(identityKey(dev, ino))
    return row && sameBirth(row.birth_ns, birth) ? row : undefined
  }
  rulesMap() { return this.rules }
}

export const entryName = (e: Entry) => e.kind === 'dir' ? e.node.vpath.slice(e.node.vpath.lastIndexOf('/') + 1) : e.vpath.slice(e.vpath.lastIndexOf('/') + 1)

// ---------- R5 readers, R6 widening ----------
interface PersonGroups { id: number; groups: Set<number> }

function activePeople(db: DB): PersonGroups[] {
  const people = db.query<{ id: number }, []>('SELECT id FROM people WHERE active = 1').all()
  const ms = db.query<{ group_id: number; person_id: number }, []>('SELECT * FROM memberships').all()
  return people.map((p) => ({ id: p.id, groups: new Set(ms.filter((m) => m.person_id === p.id).map((m) => m.group_id)) }))
}

/** NAS readers of the nearest registered folder: a set, or 'unknown'. */
function nasReaders(rows: FolderRow[], everyone: number[]): Set<number> | 'unknown' {
  const reg = [...rows].reverse().find((r) => r.registered)
  if (!reg || reg.nas_readers == null || reg.nas_readers === 'unknown') return 'unknown'
  if (reg.nas_readers === 'all') return new Set(everyone)
  const active = new Set(everyone)
  return new Set((JSON.parse(reg.nas_readers) as number[]).filter((id) => active.has(id)))
}

function readers(db: DB, folderId: number, as: 'target' | 'source'): Set<number> {
  const node = new Access(db, { personId: -1 }).nodeForFolder(folderId)
  return readersOfChain(db, node?.rows ?? null, as)
}

/**
 * R5 readers of a location given its folder rows from the mount down (as Node.rows). null or no registered row:
 * unknown, unregistered or vanished, so everyone as a target, nobody as a source. Used by the reconciler (R10) to
 * judge a location that no longer exists on disk.
 */
export function readersOfChain(db: DB, rows: FolderRow[] | null, as: 'target' | 'source'): Set<number> {
  const people = activePeople(db)
  const everyone = people.map((p) => p.id)
  if (!rows || !rows.some((r) => r.registered)) return new Set(as === 'target' ? everyone : [])
  const rules = new Map<number, RuleRow[]>()
  for (const r of db.query<RuleRow, []>('SELECT * FROM rules').all()) rules.set(r.folder_id, [...(rules.get(r.folder_id) ?? []), r])
  const out = new Set<number>()
  const aiClosed = as === 'source' && rows.some((r) => r.no_ai || r.quarantine)
  if (!aiClosed) for (const p of people) if (effectiveLevel(rows, p.id, p.groups, rules) >= 1) out.add(p.id)
  const nas = nasReaders(rows, everyone)
  if (nas === 'unknown') { if (as === 'target') everyone.forEach((id) => out.add(id)) }
  else nas.forEach((id) => out.add(id))
  return out
}

/**
 * R5 for a file (A2): the active people a file share gives read on file `uid` (in person, or through a group that is
 * still the one the grant was made for). Conservative for targets: it does not ask whether the file is reachable now.
 */
export function fileGrantees(db: DB, uid: string): Set<number> {
  return new Set(db.query<{ id: number }, [string]>(`
    SELECT p.id FROM people p WHERE p.active = 1 AND (
      EXISTS (SELECT 1 FROM file_grants g WHERE g.file_uid = ?1 AND g.subject_type = 'person' AND g.subject_id = p.id)
      OR EXISTS (SELECT 1 FROM file_grants g JOIN groups x ON x.id = g.subject_id AND x.uid = g.subject_uid
                 JOIN memberships m ON m.group_id = g.subject_id AND m.person_id = p.id
                 WHERE g.file_uid = ?1 AND g.subject_type = 'group'))`).all(uid).map((r) => r.id))
}

/** R5 target readers of folder `folderId`; with `fileUid`, of that file in it: Readers(F) ∪ G(f) (A2 W1). */
export const readersTarget = (db: DB, folderId: number, fileUid?: string | null) => {
  const r = readers(db, folderId, 'target')
  if (fileUid) for (const id of fileGrantees(db, fileUid)) r.add(id)
  return r
}
export const readersSource = (db: DB, folderId: number) => readers(db, folderId, 'source')

/**
 * R6: putting content with sources `src` into folder `target` widens it if some target reader cannot read some source.
 * `fileUid`: the content replaces that (shared) file, whose readers include its grantees.
 */
export function isWidening(db: DB, src: Iterable<number>, target: number, fileUid?: string | null): boolean {
  return widenedReaders(db, src, target, fileUid, true).size > 0
}

/**
 * The people a write into `target` (replacing the shared file `fileUid`, if given) gives the content to without them
 * reading some source. A source that is the target folder itself widens nothing for the folder's own readers, but the
 * people the file is shared with beyond them do count (A2: a file share is wider than its folder).
 */
export function widenedReaders(db: DB, src: Iterable<number>, target: number, fileUid?: string | null, first = false): Set<number> {
  const folder = readers(db, target, 'target')
  const extra = fileUid ? [...fileGrantees(db, fileUid)].filter((u) => !folder.has(u)) : []
  const out = new Set<number>()
  for (const s of src) {
    const rs = readersSource(db, s)
    for (const u of s === target ? extra : [...folder, ...extra]) if (!rs.has(u)) { out.add(u); if (first) return out }
  }
  return out
}
