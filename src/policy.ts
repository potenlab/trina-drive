// The one place that decides what an agent may see (plan 4.1 R0, R1, R4 ①–④, R5, R6).
// Shell, read tool, grep, mirror and drafts all go through Access. Token scope is computed in here, never outside.
//
// Folders are known by filesystem identity (dev+ino). A walk always starts at a registered folder whose identity is
// checked, lstat's every step (a symlink anywhere is closed, never followed), and uses names from readdir: the name
// an agent typed is only compared (on NFC) against the listing, never handed to the OS.
import fs from 'node:fs'
import path from 'node:path'
import type { DB } from './db'
import { isSystemName, nfc, nfcCollisions } from './names'
import { identityKey, type FolderRow, type RuleRow, type TokenRow } from './store'

export interface Node {
  real: string
  vpath: string
  dev: bigint
  ino: bigint
  /** known folder rows from the mount down to this folder (inclusive when it has a row) */
  rows: FolderRow[]
  parent: Node | null
}
export interface FileEntry { kind: 'file'; parent: Node; name: string; real: string; vpath: string; dev: bigint; ino: bigint; size: number; mtimeMs: number; mtimeNs: bigint }
export interface DirEntry { kind: 'dir'; node: Node }
export type Entry = FileEntry | DirEntry

export class Closed extends Error {}

type Readdir = (real: string) => string[]

const FLAGGED = (r: FolderRow) => r.no_ai || r.quarantine || r.widened_pending

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

/** R0: max over the person and their groups of the rules from F up to the nearest break (inclusive). */
export function effectiveLevel(rows: FolderRow[], personId: number, groups: Set<number>, rules: Map<number, RuleRow[]>): number {
  let best = 0
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!
    if (r.personal_owner != null) return r.personal_owner === personId ? 2 : 0
    for (const rule of rules.get(r.id) ?? []) {
      if ((rule.subject_type === 'person' && rule.subject_id === personId) || (rule.subject_type === 'group' && groups.has(rule.subject_id))) best = Math.max(best, rule.level)
    }
    if (r.registered || r.inherit_break) break
  }
  return best
}

export class Access {
  readonly personId: number
  readonly groups: Set<number>
  readonly scope: Set<number> | null
  private readonly byIdentity = new Map<string, FolderRow>()
  private readonly byId = new Map<number, FolderRow>()
  private readonly rules = new Map<number, RuleRow[]>()
  private readonly listCache = new Map<string, { names: string[]; collide: Set<string> } | null>()
  private readonly visibleCache = new Map<string, boolean>()
  private mountMap: Map<string, FolderRow> | null = null

  constructor(readonly db: DB, principal: { personId: number; token?: TokenRow }, private readonly readdir: Readdir = (p) => fs.readdirSync(p)) {
    this.personId = principal.personId
    this.groups = new Set(db.query<{ group_id: number }, [number]>('SELECT group_id FROM memberships WHERE person_id = ?').all(this.personId).map((g) => g.group_id))
    const scope = principal.token?.scope
    this.scope = scope ? new Set(JSON.parse(scope) as number[]) : null
    for (const f of db.query<FolderRow, []>('SELECT * FROM folders').all()) { this.byIdentity.set(identityKey(f.dev, f.ino), f); this.byId.set(f.id, f) }
    for (const r of db.query<RuleRow, []>('SELECT * FROM rules').all()) this.rules.set(r.folder_id, [...(this.rules.get(r.folder_id) ?? []), r])
  }

  static forToken(db: DB, token: TokenRow, readdir?: Readdir) { return new Access(db, { personId: token.person_id, token }, readdir) }

  // ---------- R0 / R1 on a folder node ----------
  level(node: Node, personId = this.personId, groups = this.groups) { return effectiveLevel(node.rows, personId, groups, this.rules) }
  flagged(node: Node) { return node.rows.some(FLAGGED) }
  inScope(node: Node) { return this.scope === null || node.rows.some((r) => this.scope!.has(r.id)) }
  /** R1 ①–④ for files directly in this folder (① holds for every node: walks start at a registered folder) */
  canRead(node: Node) { return !this.flagged(node) && this.level(node) >= 1 && this.inScope(node) }

  /** A folder is shown when it can be read, or when something readable lies below it (then it is a bare path). */
  visible(node: Node): boolean {
    const hit = this.visibleCache.get(node.real)
    if (hit !== undefined) return hit
    let v = this.canRead(node)
    if (!v) {
      for (const a of this.anchorsBelow(node)) {
        const below = this.descend(node, path.relative(node.real, a.path).split(path.sep))
        if (below && identityKey(below.dev, below.ino) === identityKey(a.dev, a.ino) && this.canRead(below)) { v = true; break }
      }
    }
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
    const reg = [...this.byId.values()].filter((f) => f.registered)
    const top = reg.filter((f) => !reg.some((o) => o !== f && f.path.startsWith(o.path + '/')))
    const count = new Map<string, number>()
    for (const f of top) count.set(nfc(f.mount_name!), (count.get(nfc(f.mount_name!)) ?? 0) + 1)
    this.mountMap = new Map(top.filter((f) => count.get(nfc(f.mount_name!)) === 1).map((f) => [nfc(f.mount_name!), f]))
    return this.mountMap
  }

  mountNode(row: FolderRow): Node | null {
    let st: fs.BigIntStats
    try { st = fs.lstatSync(row.path, { bigint: true }) } catch { return null }
    if (!st.isDirectory() || st.isSymbolicLink() || identityKey(st.dev, st.ino) !== identityKey(row.dev, row.ino)) return null
    return { real: row.path, vpath: '/' + nfc(row.mount_name!), dev: st.dev, ino: st.ino, rows: [row], parent: null }
  }

  private listing(real: string) {
    if (this.listCache.has(real)) return this.listCache.get(real)!
    let v: { names: string[]; collide: Set<string> } | null = null
    try { const names = this.readdir(real); v = { names, collide: nfcCollisions(names) } } catch { v = null }
    this.listCache.set(real, v)
    return v
  }

  /** One step down by an original name from the listing. Closed (null): system names, NFC collisions, links of any kind, non-regular files. */
  child(parent: Node, name: string): Entry | null {
    if (isSystemName(name)) return null
    const l = this.listing(parent.real)
    if (!l || !l.names.includes(name) || l.collide.has(name)) return null
    const real = path.join(parent.real, name)
    let st: fs.BigIntStats
    try { st = fs.lstatSync(real, { bigint: true }) } catch { return null }
    const vpath = (parent.vpath === '/' ? '' : parent.vpath) + '/' + nfc(name)
    if (st.isSymbolicLink()) return null
    if (st.isDirectory()) {
      const row = this.byIdentity.get(identityKey(st.dev, st.ino))
      return { kind: 'dir', node: { real, vpath, dev: st.dev, ino: st.ino, rows: row ? [...parent.rows, row] : parent.rows, parent } }
    }
    if (!st.isFile() || st.nlink !== 1n || isXSymFile(real, st.size)) return null
    return { kind: 'file', parent, name, real, vpath, dev: st.dev, ino: st.ino, size: Number(st.size), mtimeMs: Number(st.mtimeMs), mtimeNs: st.mtimeNs }
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
      if (e.kind === 'file') return i === parts.length - 1 && this.canRead(node) ? e : null
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
      if (e.kind === 'dir' ? this.visible(e.node) : readable) out.push(e)
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
      if (off === XSYM_SIZE && isXSymHeader(buf)) throw new Closed()
      this.recheck(f)
      return buf.subarray(0, off)
    } finally { fs.closeSync(fd) }
  }

  /** ⑦: every step from the mount down is still the same folder (and not a link), and the file is still there. */
  recheck(f: FileEntry) {
    const same = (p: string, dev: bigint, ino: bigint, dir: boolean) => {
      const st = fs.lstatSync(p, { bigint: true })
      if (st.isSymbolicLink() || (dir ? !st.isDirectory() : !st.isFile() || st.nlink !== 1n) || st.dev !== dev || st.ino !== ino) throw new Closed()
    }
    try {
      same(f.real, f.dev, f.ino, false)
      for (let n: Node | null = f.parent; n; n = n.parent) same(n.real, n.dev, n.ino, true)
    } catch (e) { throw e instanceof Closed ? e : new Closed() }
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
    return n && identityKey(n.dev, n.ino) === identityKey(f.dev, f.ino) ? n : null
  }

  /** R4: can this token read files in folder `id` right now (R1 ①–④)? */
  canReadFolder(id: number): boolean {
    const n = this.nodeForFolder(id)
    return !!n && this.canRead(n)
  }

  folderRow(id: number) { return this.byId.get(id) }
  rowForNode(n: Node) { return this.byIdentity.get(identityKey(n.dev, n.ino)) }
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
  const people = activePeople(db)
  const everyone = people.map((p) => p.id)
  const a = new Access(db, { personId: -1 })
  const node = a.nodeForFolder(folderId)
  // unknown, unregistered or vanished: everyone as a target, nobody as a source
  if (!node) return new Set(as === 'target' ? everyone : [])
  const out = new Set<number>()
  const aiClosed = as === 'source' && node.rows.some((r) => r.no_ai || r.quarantine)
  if (!aiClosed) for (const p of people) if (a.level(node, p.id, p.groups) >= 1) out.add(p.id)
  const nas = nasReaders(node.rows, everyone)
  if (nas === 'unknown') { if (as === 'target') everyone.forEach((id) => out.add(id)) }
  else nas.forEach((id) => out.add(id))
  return out
}

export const readersTarget = (db: DB, folderId: number) => readers(db, folderId, 'target')
export const readersSource = (db: DB, folderId: number) => readers(db, folderId, 'source')

/** R6: putting content with sources `src` into folder `target` widens it if some target reader cannot read some source. */
export function isWidening(db: DB, src: Iterable<number>, target: number): boolean {
  const rt = readersTarget(db, target)
  for (const s of src) {
    if (s === target) continue
    const rs = readersSource(db, s)
    for (const u of rt) if (!rs.has(u)) return true
  }
  return false
}
