// Worker side: a just-bash filesystem whose every call goes over the wire to the parent, which answers from the
// permission-filtered VFS. Only just-bash's own command stubs (/bin, /usr, /dev, /proc) are answered locally: they hold
// no team data, and just-bash stats /usr/bin/<name> before every command, so serving them here saves round trips.
import { AsyncLocalStorage } from 'node:async_hooks'
import path from 'node:path'
import type { BufferEncoding, ByteString, CpOptions, FileContent, FsStat, IFileSystem, InMemoryFs, MkdirOptions, RmOptions } from 'just-bash'
import type { FsOp, WireDirent, WireError, WireStat } from './protocol'

type DirentEntry = { name: string; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }
type Enc = { encoding?: BufferEncoding | null } | BufferEncoding | undefined | null

export interface Rpc {
  fs(op: FsOp, args: unknown[], body?: Uint8Array, cmd?: string[]): Promise<{ value: unknown; body?: Uint8Array }>
}

/** The command line of the wrapped command currently running (sent with every fs call made inside it). */
export const currentCommand = new AsyncLocalStorage<string[]>()

export const LOCAL_PREFIXES = ['/bin', '/usr', '/dev', '/proc']

/** Error the shell sees; same shape as the server's FsError (code + message + path). */
export class WorkerFsError extends Error {
  constructor(readonly code: string, message: string, readonly path?: string) { super(message) }
}
export const fromWire = (e: WireError) => new WorkerFsError(e.code, e.message, e.path)

const encOf = (o: Enc) => (typeof o === 'string' ? o : o?.encoding ?? undefined) as BufferEncoding | undefined
const toBytes = (c: FileContent, enc?: BufferEncoding): Uint8Array =>
  typeof c === 'string' ? Buffer.from(c, enc === 'binary' || enc === 'latin1' ? 'latin1' : (enc ?? 'utf8') as BufferEncoding) : c
const toStat = (s: WireStat): FsStat => ({ isFile: s.isFile, isDirectory: s.isDirectory, isSymbolicLink: s.isSymbolicLink, mode: s.mode, size: s.size, mtime: new Date(s.mtimeMs) })

export class ProxyFs implements IFileSystem {
  constructor(private readonly rpc: Rpc, private readonly sys: InMemoryFs, private readonly localPrefixes = LOCAL_PREFIXES) {}

  private local(p: string): string | null {
    const n = path.posix.normalize('/' + p)
    return this.localPrefixes.some((pre) => n === pre || n.startsWith(pre + '/')) ? n : null
  }
  private async call(op: FsOp, args: unknown[], body?: Uint8Array) {
    return this.rpc.fs(op, args, body, currentCommand.getStore())
  }
  private readOnly(syscall: string, p: string): never {
    throw new WorkerFsError('EROFS', `EROFS: read-only file system, ${syscall} '${p}'`, p)
  }

  // ---------- reading ----------
  async readFileBuffer(p: string): Promise<Uint8Array> {
    const l = this.local(p)
    if (l) return this.sys.readFileBuffer(l)
    const r = await this.call('read', [p])
    return r.body ?? new Uint8Array()
  }
  async readFile(p: string, o?: Enc): Promise<string> {
    const b = await this.readFileBuffer(p)
    const enc = encOf(o)
    if (enc === 'binary' || enc === 'latin1') return Buffer.from(b).toString('latin1')
    if (enc && enc !== 'utf8' && enc !== 'utf-8') return Buffer.from(b).toString(enc)
    return new TextDecoder().decode(b)
  }
  async readFileBytes(p: string): Promise<ByteString> {
    return Buffer.from(await this.readFileBuffer(p)).toString('latin1') as unknown as ByteString
  }
  async exists(p: string): Promise<boolean> {
    const l = this.local(p)
    if (l) return this.sys.exists(l)
    return (await this.call('exists', [p])).value === true
  }
  async stat(p: string): Promise<FsStat> {
    const l = this.local(p)
    if (l) return this.sys.stat(l)
    return toStat((await this.call('stat', [p])).value as WireStat)
  }
  async lstat(p: string): Promise<FsStat> {
    const l = this.local(p)
    if (l) return this.sys.lstat(l)
    return toStat((await this.call('lstat', [p])).value as WireStat)
  }
  async readdir(p: string): Promise<string[]> { return (await this.readdirWithFileTypes(p)).map((d) => d.name) }
  async readdirWithFileTypes(p: string): Promise<DirentEntry[]> {
    const l = this.local(p)
    if (l) return this.sys.readdirWithFileTypes(l)
    return ((await this.call('readdir', [p])).value as WireDirent[]).map((d) => ({ name: d.name, isFile: d.isFile, isDirectory: d.isDirectory, isSymbolicLink: d.isSymbolicLink }))
  }
  async readlink(p: string): Promise<string> {
    const l = this.local(p)
    if (l) return this.sys.readlink(l)
    return (await this.call('readlink', [p])).value as string
  }
  async realpath(p: string): Promise<string> {
    const l = this.local(p)
    if (l) return this.sys.realpath(l)
    return (await this.call('realpath', [p])).value as string
  }
  resolvePath(base: string, p: string): string {
    return path.posix.normalize(p.startsWith('/') ? p : `${base}/${p}`).replace(/(.)\/+$/, '$1')
  }
  getAllPaths(): string[] { return [] }

  // ---------- writing (the parent decides what is allowed) ----------
  async writeFile(p: string, c: FileContent, o?: Enc) {
    const l = this.local(p)
    if (l === '/dev/null') return
    if (l) this.readOnly('open', p)
    await this.call('write', [p], toBytes(c, encOf(o)))
  }
  async appendFile(p: string, c: FileContent, o?: Enc) {
    const l = this.local(p)
    if (l === '/dev/null') return
    if (l) this.readOnly('open', p)
    await this.call('append', [p], toBytes(c, encOf(o)))
  }
  async mkdir(p: string, o?: MkdirOptions) {
    const l = this.local(p)
    if (l) { if (o?.recursive && await this.sys.exists(l)) return; this.readOnly('mkdir', p) }
    await this.call('mkdir', [p, !!o?.recursive])
  }
  async rm(p: string, o?: RmOptions) {
    if (this.local(p)) this.readOnly('rm', p)
    await this.call('rm', [p, !!o?.recursive, !!o?.force])
  }
  async cp(src: string, dest: string, o?: CpOptions) {
    if (this.local(dest)) this.readOnly('cp', dest)
    const l = this.local(src)
    // copying a local stub to the backend: read here, write there
    if (l) return this.writeFile(dest, await this.sys.readFileBuffer(l))
    await this.call('cp', [src, dest, !!o?.recursive])
  }
  async mv(src: string, dest: string) {
    if (this.local(src)) this.readOnly('rename', src)
    if (this.local(dest)) this.readOnly('rename', dest)
    await this.call('mv', [src, dest])
  }
  async chmod(p: string, mode: number) {
    if (this.local(p)) this.readOnly('chmod', p)
    await this.call('chmod', [p, mode])
  }
  async utimes(p: string, atime: Date, mtime: Date) {
    if (this.local(p)) this.readOnly('utime', p)
    await this.call('utimes', [p, atime.getTime(), mtime.getTime()])
  }
  async symlink(target: string, link: string) {
    if (this.local(link)) this.readOnly('symlink', link)
    await this.call('symlink', [target, link])
  }
  async link(existing: string, newPath: string) {
    if (this.local(newPath)) this.readOnly('link', newPath)
    await this.call('link', [existing, newPath])
  }
}
