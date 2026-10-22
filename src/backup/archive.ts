// The plaintext inside an encrypted backup (docs/BACKUP-FORMAT.md): a flat sequence of records.
//
//   inner magic "BKPTAR01"
//   record := u32 BE length of JSON | JSON object
//             (t = "file": then exactly `size` bytes of content, then the 32-byte SHA-256 of that content)
//   first record t = "info", then any number of t = "file", last record t = "end" {files, bytes}; nothing after it.
//
// Readers treat everything as untrusted: whoever has the public key can make a well-encrypted archive, so names are
// checked against an allow-list before anything touches the disk.
import crypto from 'node:crypto'
import { BackupError } from './crypto'

export const INNER_MAGIC = new TextEncoder().encode('BKPTAR01')
const MAX_JSON = 64 * 1024

export interface InfoRecord {
  t: 'info'
  format: 1
  product: string
  productVersion: string
  createdAt: string
  host: string
  layout: 'installed' | 'flat'
  /** what is NOT in the archive, said in the archive itself */
  excludes: string[]
  db: { auditRows: number; auditHead: string | null; drafts: number; versions: number } | null
}
export interface FileRecord { t: 'file'; path: string; size: number; mode: number }
export interface EndRecord { t: 'end'; files: number; bytes: number }

/** Logical paths an archive may contain. */
export function isAllowedPath(p: string): boolean {
  if (p === 'db/store.db') return true
  if (!p.startsWith('drafts/')) return false
  const parts = p.slice('drafts/'.length).split('/')
  return parts.length >= 1 && parts.length <= 4 && parts.every((s) => /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(s) && s !== '..')
}

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b }

export class ArchiveWriter {
  private files = 0
  private bytes = 0
  private ended = false

  constructor(private readonly out: (b: Uint8Array) => void, info: Omit<InfoRecord, 't' | 'format'>) {
    out(INNER_MAGIC)
    this.record({ t: 'info', format: 1, ...info })
  }

  private record(r: object) {
    const json = Buffer.from(JSON.stringify(r))
    if (json.length > MAX_JSON) throw new Error('record too large')
    this.out(u32(json.length))
    this.out(json)
  }

  /** Add one file whose content arrives through `pump` (called with a writer; must write exactly `size` bytes). */
  file(path: string, size: number, mode: number, pump: (write: (b: Uint8Array) => void) => void) {
    if (this.ended) throw new Error('archive already ended')
    if (!isAllowedPath(path)) throw new BackupError('unsafe', `refusing to archive ${path}`)
    this.record({ t: 'file', path, size, mode } satisfies FileRecord)
    const h = crypto.createHash('sha256')
    let n = 0
    pump((b) => {
      n += b.length
      if (n > size) throw new BackupError('io', `${path} grew while it was being backed up`)
      h.update(b)
      this.out(b)
    })
    if (n !== size) throw new BackupError('io', `${path} shrank while it was being backed up (${n} of ${size} bytes)`)
    this.out(h.digest())
    this.files++
    this.bytes += size
  }

  end() {
    if (this.ended) return
    this.ended = true
    this.record({ t: 'end', files: this.files, bytes: this.bytes } satisfies EndRecord)
  }
}

/** Pull bytes out of a stream of plaintext pieces. */
class Bytes {
  private cur: Uint8Array = new Uint8Array(0)
  private off = 0
  constructor(private readonly src: Iterator<Uint8Array>) {}

  private fill(): boolean {
    while (this.off >= this.cur.length) {
      const r = this.src.next()
      if (r.done) return false
      this.cur = r.value
      this.off = 0
    }
    return true
  }
  /** Exactly n bytes, delivered in pieces to `each`. */
  take(n: number, each: (b: Uint8Array) => void) {
    while (n > 0) {
      if (!this.fill()) throw new BackupError('truncated', 'the archive ends in the middle of a record')
      const k = Math.min(n, this.cur.length - this.off)
      each(this.cur.subarray(this.off, this.off + k))
      this.off += k
      n -= k
    }
  }
  read(n: number): Uint8Array {
    const out = new Uint8Array(n)
    let at = 0
    this.take(n, (b) => { out.set(b, at); at += b.length })
    return out
  }
  atEnd(): boolean { return !this.fill() }
}

export interface ReadHandlers {
  info?(info: InfoRecord): void
  /** Called per file; returns a sink for its content, or null to only hash it. */
  file?(rec: FileRecord): { write(b: Uint8Array): void; done(ok: boolean, sha256: string): void } | null
}

/** Read a whole archive, checking structure and every content hash. Returns the info and end records. */
export function readArchive(pieces: Iterator<Uint8Array>, on: ReadHandlers = {}): { info: InfoRecord; end: EndRecord; files: FileRecord[] } {
  const r = new Bytes(pieces)
  const magic = r.read(INNER_MAGIC.length)
  if (!INNER_MAGIC.every((b, i) => magic[i] === b)) throw new BackupError('format', 'the decrypted content is not a backup archive')
  const next = (): Record<string, unknown> => {
    const len = Buffer.from(r.read(4)).readUInt32BE()
    if (len === 0 || len > MAX_JSON) throw new BackupError('format', 'bad record length')
    try {
      const v = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(r.read(len)))
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error()
      return v
    } catch (e) {
      if (e instanceof BackupError) throw e
      throw new BackupError('format', 'bad record')
    }
  }
  const info = next() as unknown as InfoRecord
  if (info.t !== 'info' || info.format !== 1) throw new BackupError('format', 'the archive does not start with a supported info record')
  on.info?.(info)
  const files: FileRecord[] = []
  const seen = new Set<string>()
  let bytes = 0
  for (;;) {
    const rec = next()
    if (rec.t === 'end') {
      const end = rec as unknown as EndRecord
      if (end.files !== files.length || end.bytes !== bytes) throw new BackupError('format', `the archive's end record does not match its content (${files.length} files, ${bytes} bytes)`)
      if (!r.atEnd()) throw new BackupError('format', 'data after the end of the archive')
      return { info, end, files }
    }
    if (rec.t !== 'file') throw new BackupError('format', `unknown record type ${String(rec.t)}`)
    const f = rec as unknown as FileRecord
    if (typeof f.path !== 'string' || !isAllowedPath(f.path)) throw new BackupError('unsafe', `the archive contains a path that is not allowed: ${JSON.stringify(f.path)}`)
    if (!Number.isSafeInteger(f.size) || f.size < 0) throw new BackupError('format', `bad size for ${f.path}`)
    if (seen.has(f.path)) throw new BackupError('format', `${f.path} appears twice`)
    seen.add(f.path)
    const sink = on.file?.(f) ?? null
    const h = crypto.createHash('sha256')
    let ok = false
    let digest = ''
    try {
      r.take(f.size, (b) => { h.update(b); sink?.write(b) })
      const want = r.read(32)
      const got = h.digest()
      digest = got.toString('hex')
      ok = got.equals(Buffer.from(want))
      if (!ok) throw new BackupError('tampered', `${f.path}: content does not match its checksum`)
    } finally {
      sink?.done(ok, digest)
    }
    files.push(f)
    bytes += f.size
  }
}
