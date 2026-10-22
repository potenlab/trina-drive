// The agent's filesystem for one call (plan 5.1 "permission-filtered virtual shell"):
//   /<registered folder>/…   originals, read-only, filtered by policy; office files read as extracted text
//   /.raw/…                  the same files as original bytes
//   /drafts/…                this token's draft box (writable), plus other tokens' drafts it may see under @<token>/
//   /bin /usr /dev /proc     just-bash's command stubs (in memory, not listed at /)
// Hidden and nonexistent give the same answer everywhere: the policy simply returns nothing for both.
import { AsyncLocalStorage } from 'node:async_hooks'
import path from 'node:path'
import { Bash, InMemoryFs, type BufferEncoding, type ByteString, type CpOptions, type FileContent, type FsStat, type IFileSystem, type MkdirOptions, type RmOptions } from 'just-bash'

type DirentEntry = { name: string; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }
type ReadFileOptions = { encoding?: BufferEncoding | null }
type WriteFileOptions = { encoding?: BufferEncoding }
import { LIMITS } from './config'
import { ExtractError } from './extract'
import { isOffice, normalizeVirtual, splitVirtual } from './names'
import { Closed, entryName, type Entry, type FileEntry, type Node } from './policy'
import type { DraftItem, Session } from './session'

/** How the running command reads files: original bytes (raw) and/or as a weak touch (provenance label only). */
export interface Mode { raw: boolean; weak: boolean }
export const commandMode = new AsyncLocalStorage<Mode>()
const currentMode = (): Mode => commandMode.getStore() ?? { raw: false, weak: false }

export const MSG = {
  readOnly: 'Originals are read-only. Write to /drafts/ and a person will move it.',
  office: 'Office files cannot be written: write .md or .csv instead.',
  tokenReadOnly: 'This token is read-only: it cannot write drafts.',
  otherDraft: 'Drafts of other tokens are read-only: write your own copy under /drafts/.',
  links: 'Links are not supported.',
}

export class FsError extends Error {
  constructor(readonly code: string, message: string, readonly path: string) { super(message) }
}
const enoent = (syscall: string, p: string) => new FsError('ENOENT', `ENOENT: no such file or directory, ${syscall} '${p}'`, p)
const eisdir = (syscall: string, p: string) => new FsError('EISDIR', `EISDIR: illegal operation on a directory, ${syscall} '${p}'`, p)
const enotdir = (syscall: string, p: string) => new FsError('ENOTDIR', `ENOTDIR: not a directory, ${syscall} '${p}'`, p)
const eexist = (syscall: string, p: string) => new FsError('EEXIST', `EEXIST: file already exists, ${syscall} '${p}'`, p)

const SYSTEM_DIRS = new Set(['bin', 'usr', 'dev', 'proc'])
export const RESERVED = new Set([...SYSTEM_DIRS, 'drafts', '.raw', 'tmp', 'home'])

let sysFs: InMemoryFs | null = null
/** In-memory /bin, /usr/bin, /dev, /proc as just-bash lays them out (it looks commands up there). */
function sys(): InMemoryFs {
  if (!sysFs) { sysFs = new InMemoryFs(); new Bash({ fs: sysFs }) }
  return sysFs
}

export type Hit =
  | { t: 'root' } | { t: 'rawroot' }
  | { t: 'sys'; p: string }
  | { t: 'dir'; node: Node; raw: boolean }
  | { t: 'file'; f: FileEntry; raw: boolean }
  | { t: 'ddir'; rel: string }
  | { t: 'draft'; item: DraftItem }

const EPOCH = new Date(0)
const dirStat = (): FsStat => ({ isFile: false, isDirectory: true, isSymbolicLink: false, mode: 0o755, size: 0, mtime: EPOCH })
const fileStat = (size: number, mtimeMs: number): FsStat => ({ isFile: true, isDirectory: false, isSymbolicLink: false, mode: 0o644, size, mtime: new Date(mtimeMs) })
const toBytes = (c: FileContent, enc?: BufferEncoding) => typeof c === 'string' ? Buffer.from(c, enc === 'binary' || enc === 'latin1' ? 'latin1' : (enc ?? 'utf8') as BufferEncoding) : c
const encOf = (o?: WriteFileOptions | ReadFileOptions | BufferEncoding | null) => (typeof o === 'string' ? o : o?.encoding ?? undefined) as BufferEncoding | undefined

export class VirtualFs implements IFileSystem {
  constructor(readonly s: Session) {}

  // ---------- resolution ----------
  resolve(p: string): Hit | null {
    const parts = splitVirtual(p)
    if (!parts.length) return { t: 'root' }
    const top = parts[0]!
    if (SYSTEM_DIRS.has(top)) return { t: 'sys', p: '/' + parts.join('/') }
    if (top === 'drafts') return this.resolveDraft(parts.slice(1).join('/'))
    if (top === '.raw') return parts.length === 1 ? { t: 'rawroot' } : this.wrap(this.s.access.lookup(parts.slice(1)), true)
    if (RESERVED.has(top)) return null
    return this.wrap(this.s.access.lookup(parts), false)
  }
  private wrap(e: Entry | null, raw: boolean): Hit | null {
    if (!e) return null
    return e.kind === 'dir' ? { t: 'dir', node: e.node, raw } : { t: 'file', f: e, raw }
  }
  private resolveDraft(rel: string): Hit | null {
    if (rel === '') return { t: 'ddir', rel: '' }
    const items = this.s.draftItems()
    const item = items.get(rel)
    if (item) return { t: 'draft', item }
    if (this.s.pendingDirs.has(rel) || [...items.keys()].some((k) => k.startsWith(rel + '/'))) return { t: 'ddir', rel }
    return null
  }
  private hit(p: string, syscall: string): Hit {
    const h = this.resolve(p)
    if (!h) throw enoent(syscall, p)
    return h
  }

  /** Children of a directory hit (no provenance recorded here). */
  children(h: Hit): { name: string; dir: boolean; path: string }[] {
    const mk = (base: string, name: string, dir: boolean) => ({ name, dir, path: (base === '/' ? '' : base) + '/' + name })
    switch (h.t) {
      // /.raw is reachable by path but not listed (find / and ls -a / would show everything twice)
      case 'root': return [...this.mounts().map((n) => mk('/', n, true)), mk('/', 'drafts', true)].sort((a, b) => a.name.localeCompare(b.name))
      case 'rawroot': return this.mounts().map((n) => mk('/.raw', n, true))
      case 'dir': {
        const base = (h.raw ? '/.raw' : '') + h.node.vpath
        return this.s.access.list(h.node).map((e) => mk(base, entryName(e), e.kind === 'dir'))
      }
      case 'ddir': {
        const prefix = h.rel ? h.rel + '/' : ''
        const out = new Map<string, boolean>()
        for (const k of [...this.s.draftItems().keys(), ...this.s.pendingDirs]) {
          if (!k.startsWith(prefix) || k === h.rel) continue
          const rest = k.slice(prefix.length)
          const name = rest.split('/')[0]!
          out.set(name, (out.get(name) ?? false) || rest.includes('/') || this.s.pendingDirs.has(prefix + name))
        }
        return [...out].sort(([a], [b]) => a.localeCompare(b)).map(([n, d]) => mk('/drafts' + (h.rel ? '/' + h.rel : ''), n, d))
      }
      default: return []
    }
  }
  private mounts() { return this.s.access.rootEntries().map(entryName).filter((n) => !RESERVED.has(n)) }

  /** Bytes of a file hit as the current command should see them; records provenance. */
  async bytesOf(h: Hit, p: string): Promise<Uint8Array> {
    const m = currentMode()
    if (h.t === 'sys') return sys().readFileBuffer(h.p)
    if (h.t === 'draft') { this.s.touchDraft(h.item, !m.weak); return this.s.draftContent(h.item) }
    if (h.t !== 'file') throw eisdir('read', p)
    const f = h.f
    try {
      let bytes: Uint8Array
      if (h.raw || m.raw || !isOffice(f.name)) bytes = this.s.access.readBytes(f, LIMITS.fileBytes)
      else { bytes = await this.s.ctx.mirror.text(this.s.access, f); this.s.extracted.add(f.vpath) }
      this.s.touchFile(f, !m.weak)
      return bytes
    } catch (e) {
      if (e instanceof Closed) throw enoent('open', p)
      if (e instanceof ExtractError) { this.s.touchFile(f, false); throw new FsError('EIO', e.message, p) }
      throw e
    }
  }

  // ---------- IFileSystem: reading ----------
  async readFile(p: string, o?: ReadFileOptions | BufferEncoding): Promise<string> {
    const b = await this.bytesOf(this.hit(p, 'open'), p)
    const enc = encOf(o)
    return enc === 'binary' || enc === 'latin1' ? Buffer.from(b).toString('latin1') : new TextDecoder().decode(b)
  }
  async readFileBytes(p: string): Promise<ByteString> {
    return Buffer.from(await this.bytesOf(this.hit(p, 'open'), p)).toString('latin1') as unknown as ByteString
  }
  async readFileBuffer(p: string): Promise<Uint8Array> { return this.bytesOf(this.hit(p, 'open'), p) }

  async exists(p: string): Promise<boolean> {
    const h = this.resolve(p)
    if (h) this.touchMeta(h)
    return !!h
  }
  private touchMeta(h: Hit) {
    if (h.t === 'file') this.s.touchFile(h.f, false)
    else if (h.t === 'dir') this.s.touchNode(h.node, false)
    else if (h.t === 'draft') this.s.touchDraft(h.item, false)
  }
  async stat(p: string): Promise<FsStat> {
    const h = this.hit(p, 'stat')
    this.touchMeta(h)
    switch (h.t) {
      case 'sys': return sys().stat(h.p)
      case 'file': return fileStat(h.f.size, h.f.mtimeMs)
      case 'draft': return fileStat(this.s.draftContent(h.item).length, h.item.draft?.updated_at ?? Date.now())
      default: return dirStat()
    }
  }
  lstat(p: string) { return this.stat(p) }
  async readdir(p: string): Promise<string[]> { return (await this.readdirWithFileTypes(p)).map((d) => d.name) }
  async readdirWithFileTypes(p: string): Promise<DirentEntry[]> {
    const h = this.hit(p, 'scandir')
    if (h.t === 'sys') return sys().readdirWithFileTypes(h.p)
    if (h.t === 'file' || h.t === 'draft') throw enotdir('scandir', p)
    if (h.t === 'dir') this.s.touchNode(h.node, false)
    return this.children(h).map((c) => ({ name: c.name, isFile: !c.dir, isDirectory: c.dir, isSymbolicLink: false }))
  }
  async readlink(p: string): Promise<string> {
    this.hit(p, 'readlink')
    throw new FsError('EINVAL', `EINVAL: invalid argument, readlink '${p}'`, p)
  }
  async realpath(p: string): Promise<string> { this.hit(p, 'realpath'); return normalizeVirtual(p) }
  resolvePath(base: string, p: string): string { return path.posix.normalize(p.startsWith('/') ? p : `${base}/${p}`).replace(/(.)\/+$/, '$1') }
  getAllPaths(): string[] { return [] }

  // ---------- IFileSystem: writing (only /drafts/) ----------
  async writeFile(p: string, c: FileContent, o?: WriteFileOptions | BufferEncoding) { this.write(p, toBytes(c, encOf(o)), false) }
  async appendFile(p: string, c: FileContent, o?: WriteFileOptions | BufferEncoding) { this.write(p, toBytes(c, encOf(o)), true) }

  /** Every write lands here. Outside /drafts/: ENOENT if the parent folder does not exist (or is hidden), else read-only. */
  write(p: string, bytes: Uint8Array, append: boolean) {
    const n = normalizeVirtual(p)
    if (n === '/dev/null') return
    const rel = this.draftRel(n)
    if (rel === null) return this.denyOriginal(n, 'open')
    if (rel === '') throw eisdir('open', p)
    this.checkDraftWrite(rel, p)
    const h = this.resolveDraft(rel)
    if (h?.t === 'ddir') throw eisdir('open', p)
    const dir = path.posix.dirname(rel)
    if (dir !== '.' && this.resolveDraft(dir)?.t !== 'ddir') throw enoent('open', p)
    const base = append && h?.t === 'draft' ? this.s.draftContent(h.item) : new Uint8Array()
    const content = append ? Buffer.concat([base, bytes]) : bytes
    if (content.length > LIMITS.draftBytes) throw new FsError('EFBIG', `EFBIG: file too large (drafts are limited to ${LIMITS.draftBytes} bytes), open '${p}'`, p)
    this.s.pending.set(rel, content)
    this.s.files.add('/drafts/' + rel)
  }
  private draftRel(n: string): string | null {
    if (n === '/drafts') return ''
    return n.startsWith('/drafts/') ? n.slice('/drafts/'.length) : null
  }
  private checkDraftWrite(rel: string, p: string) {
    const deny = (code: string, msg: string) => { this.s.notes.add(msg); return new FsError(code, msg, p) }
    if (this.s.token.read_only) throw deny('EROFS', MSG.tokenReadOnly)
    if (rel.startsWith('@')) throw deny('EROFS', MSG.otherDraft)
    if (isOffice(rel)) throw deny('EPERM', MSG.office)
  }
  private denyOriginal(n: string, syscall: string): never {
    const parent = this.resolve(path.posix.dirname(n))
    const self = this.resolve(n)
    if (!self && (!parent || parent.t === 'file' || parent.t === 'draft')) throw enoent(syscall, n)
    if (self?.t === 'sys' || parent?.t === 'sys') throw new FsError('EROFS', `EROFS: read-only file system, ${syscall} '${n}'`, n)
    this.s.notes.add(MSG.readOnly)
    throw new FsError('EROFS', MSG.readOnly, n)
  }

  async mkdir(p: string, o?: MkdirOptions) {
    const n = normalizeVirtual(p)
    const rel = this.draftRel(n)
    if (rel === null) {
      if (this.resolve(n)) { if (o?.recursive) return; throw eexist('mkdir', p) }
      return this.denyOriginal(n, 'mkdir')
    }
    const h = this.resolveDraft(rel)
    if (h) { if (o?.recursive && h.t === 'ddir') return; throw eexist('mkdir', p) }
    this.checkDraftWrite(rel, p)
    const parts = rel.split('/')
    for (let i = 1; i <= parts.length; i++) {
      const sub = parts.slice(0, i).join('/')
      const sh = this.resolveDraft(sub)
      if (sh?.t === 'draft') throw enotdir('mkdir', p)
      if (!sh && i < parts.length && !o?.recursive) throw enoent('mkdir', p)
      if (!sh) this.s.pendingDirs.add(sub)
    }
  }

  async rm(p: string, o?: RmOptions) {
    const n = normalizeVirtual(p)
    const rel = this.draftRel(n)
    const h = this.resolve(n)
    if (!h) { if (o?.force) return; throw enoent('rm', p) }
    if (rel === null || rel === '') return this.denyOriginal(n, 'rm')
    this.checkDraftWrite(rel, p)
    if (h.t === 'draft') { this.s.pending.set(rel, null); return }
    if (!o?.recursive) throw eisdir('rm', p)
    for (const k of this.s.draftItems().keys()) if (k.startsWith(rel + '/')) { this.checkDraftWrite(k, p); this.s.pending.set(k, null) }
    for (const d of [...this.s.pendingDirs]) if (d === rel || d.startsWith(rel + '/')) this.s.pendingDirs.delete(d)
  }

  async cp(src: string, dest: string, o?: CpOptions) {
    const h = this.hit(src, 'cp')
    if (h.t === 'file' || h.t === 'draft' || h.t === 'sys') return this.write(dest, await this.bytesOf(h, src), false)
    if (!o?.recursive) throw new FsError('EISDIR', `EISDIR: is a directory, cp '${src}'`, src)
    await this.mkdir(dest, { recursive: true })
    for (const c of this.children(h)) await this.cp(c.path, path.posix.join(dest, c.name), o)
  }

  async mv(src: string, dest: string) {
    const n = normalizeVirtual(src)
    const h = this.hit(src, 'mv')
    const rel = this.draftRel(n)
    if (rel === null || rel === '') return this.denyOriginal(n, 'rename')
    this.checkDraftWrite(rel, src)
    await this.cp(src, dest, { recursive: true })
    await this.rm(src, { recursive: h.t === 'ddir', force: true })
  }

  async chmod(p: string) { this.metaWrite(p, 'chmod') }
  async utimes(p: string) { this.metaWrite(p, 'utime') }
  private metaWrite(p: string, syscall: string) {
    const n = normalizeVirtual(p)
    this.hit(p, syscall)
    const rel = this.draftRel(n)
    if (rel === null || rel === '') this.denyOriginal(n, syscall)
  }
  async symlink(_t: string, link: string): Promise<void> { this.s.notes.add(MSG.links); throw new FsError('EPERM', MSG.links, link) }
  async link(_e: string, link: string): Promise<void> { this.s.notes.add(MSG.links); throw new FsError('EPERM', MSG.links, link) }
}
