// Where encrypted archives go. v0.1: a directory (an external disk). S3-compatible storage has the interface only.
import fs from 'node:fs'
import path from 'node:path'
import { NAME } from '../config'
import { BackupError } from './crypto'

export interface ArchiveSink {
  write(b: Uint8Array): void
  /** Make the archive visible under its final name (atomically for a directory). */
  commit(): Promise<{ location: string; bytes: number }>
  abort(): void
}

export interface BackupTarget {
  readonly description: string
  create(name: string): ArchiveSink
  /** Archive names, oldest first. */
  list(): Promise<string[]>
  /** A local file to read the archive from (remote targets download it first). */
  fetch(name: string): Promise<string>
  remove(name: string): Promise<void>
}

export const ARCHIVE_EXT = '.bkp'
const ARCHIVE_RE = new RegExp(`^${NAME.replace(/[^a-z0-9]/gi, '\\$&')}-\\d{8}T\\d{6}Z(-\\d+)?\\${ARCHIVE_EXT}$`)
export const isArchiveName = (n: string) => ARCHIVE_RE.test(n)

export function archiveName(now: Date, n = 0): string {
  const s = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  return `${NAME}-${s}${n ? `-${n}` : ''}${ARCHIVE_EXT}`
}

/** Oldest first: by timestamp, then by the same-second counter. */
export function sortArchives(names: string[]): string[] {
  const key = (n: string) => { const m = /-(\d{8}T\d{6}Z)(?:-(\d+))?\./.exec(n); return [m?.[1] ?? '', Number(m?.[2] ?? 0)] as const }
  return [...names].sort((a, b) => { const x = key(a), y = key(b); return x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] - y[1] })
}

export interface DirTargetOptions {
  /** the data directory: the target may not be inside it, nor (unless allowSameDisk) on the same disk */
  dataDir?: string
  allowSameDisk?: boolean
}

export class DirTarget implements BackupTarget {
  readonly description: string
  constructor(readonly dir: string, o: DirTargetOptions = {}) {
    this.dir = path.resolve(dir)
    this.description = `directory ${this.dir}`
    let st: fs.Stats
    try { st = fs.statSync(this.dir) } catch {
      throw new BackupError('config', `backup folder ${this.dir} does not exist (is the external disk connected?)`)
    }
    if (!st.isDirectory()) throw new BackupError('config', `${this.dir} is not a folder`)
    if (o.dataDir) {
      const data = fs.realpathSync(o.dataDir)
      const real = fs.realpathSync(this.dir)
      if (real === data || real.startsWith(data + path.sep)) throw new BackupError('config', 'the backup folder cannot be inside the data folder')
      if (!o.allowSameDisk && fs.statSync(data).dev === st.dev) {
        throw new BackupError('config', `${this.dir} is on the same disk as the data; use an external disk (or --allow-same-disk for a test)`)
      }
    }
  }

  create(name: string): ArchiveSink {
    if (!isArchiveName(name)) throw new BackupError('unsafe', `bad archive name ${name}`)
    const final = path.join(this.dir, name)
    if (fs.existsSync(final)) throw new BackupError('io', `${final} already exists`)
    const partial = `${final}.partial`
    const fd = fs.openSync(partial, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
    let bytes = 0
    let open = true
    return {
      write(b) {
        let off = 0
        while (off < b.length) off += fs.writeSync(fd, b, off, b.length - off)
        bytes += b.length
      },
      async commit() {
        fs.fsyncSync(fd)
        fs.closeSync(fd)
        open = false
        fs.renameSync(partial, final)
        try { const d = fs.openSync(path.dirname(final), 'r'); fs.fsyncSync(d); fs.closeSync(d) } catch {}
        return { location: final, bytes }
      },
      abort() {
        if (open) { try { fs.closeSync(fd) } catch {} open = false }
        fs.rmSync(partial, { force: true })
      },
    }
  }

  async list(): Promise<string[]> {
    return sortArchives(fs.readdirSync(this.dir).filter(isArchiveName))
  }
  async fetch(name: string): Promise<string> {
    if (!isArchiveName(name)) throw new BackupError('unsafe', `bad archive name ${name}`)
    return path.join(this.dir, name)
  }
  async remove(name: string): Promise<void> {
    if (!isArchiveName(name)) throw new BackupError('unsafe', `bad archive name ${name}`)
    fs.rmSync(path.join(this.dir, name), { force: true })
  }
}

/**
 * S3-compatible storage (AWS S3, Cloudflare R2, Backblaze B2, MinIO). Interface only in v0.1.
 * Planned: Bun.S3Client with credentials from the environment (<NAME>_S3_ACCESS_KEY_ID, _SECRET_ACCESS_KEY, _ENDPOINT,
 * _REGION), multipart upload of the encrypted stream, the same naming and retention as DirTarget.
 */
export class S3Target implements BackupTarget {
  readonly description: string
  constructor(readonly bucket: string, readonly prefix: string) {
    this.description = `s3://${bucket}/${prefix}`
  }
  private no(): never {
    throw new BackupError('config', 'S3-compatible backup targets are not available in v0.1; use a folder on an external disk')
  }
  create(_name: string): ArchiveSink { this.no() }
  async list(): Promise<string[]> { this.no() }
  async fetch(_name: string): Promise<string> { this.no() }
  async remove(_name: string): Promise<void> { this.no() }
}

export function parseTarget(spec: string, o: DirTargetOptions = {}): BackupTarget {
  const m = /^s3:\/\/([a-z0-9][a-z0-9.-]{1,62})(?:\/(.*))?$/.exec(spec)
  if (m) return new S3Target(m[1]!, (m[2] ?? '').replace(/\/+$/, ''))
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(spec)) throw new BackupError('config', `unsupported backup target ${spec}`)
  if (!path.isAbsolute(spec)) throw new BackupError('config', 'the backup folder must be an absolute path')
  return new DirTarget(spec, o)
}

/** Keep the newest `keep` archives. */
export async function prune(target: BackupTarget, keep: number): Promise<string[]> {
  if (!(keep >= 1)) return []
  const all = await target.list()
  const old = all.slice(0, Math.max(0, all.length - keep))
  for (const n of old) await target.remove(n)
  return old
}
