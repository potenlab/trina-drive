// Text mirror on the server's disk (outside every registered folder), named by the sha256 of the original bytes.
// grep runs over these files; cat/read of office files show them. Every entry is reached through Access (policy).
// Text is extracted in an isolated worker (extract/run.ts); a failure that belongs to the document is remembered, one
// that only means "not now" (ExtractUnavailable) is not.
import fs from 'node:fs'
import path from 'node:path'
import type { DB } from './db'
import { LIMITS } from './config'
import { ExtractError } from './extract'
import { extractDocument, ExtractUnavailable, INDEX_WHO, type ExtractWho } from './extract/run'
import { isOffice } from './names'
import { Closed, type Access, type FileEntry } from './policy'
import { sha256 } from './store'

interface Row { sha256: string; status: string; message: string | null }

/**
 * The version part of a mirror row's key (stored in its mtime_ns column): mtime and ctime. mtime alone can be put back
 * after a same-size rewrite in place (rsync --inplace, restore tools) or come with a reused inode; ctime moves on every
 * write and cannot be set. A caller without a ctime gets a key no read matches: a cache miss, never stale text.
 */
const stamp = (f: { mtimeNs: bigint | string; ctimeNs?: bigint | string }) => `${f.mtimeNs}:${f.ctimeNs ?? '-'}`
export type Extractor = (name: string, bytes: Uint8Array, who: ExtractWho) => Promise<string>

export class Mirror {
  constructor(private readonly db: DB, readonly dir: string, private readonly extract: Extractor = extractDocument) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }) }

  private file(sha: string) { return path.join(this.dir, sha.slice(0, 2), sha + '.txt') }

  /** Mirror file holding the text of `f` (extracted for office files, the bytes themselves otherwise). */
  async textPath(access: Access, f: FileEntry, who: ExtractWho = { token: `person:${access.personId}`, person: String(access.personId) }): Promise<string> {
    const key = [String(f.dev), String(f.ino), f.size, stamp(f)] as const
    const row = this.db.query<Row, [string, string, number, string]>('SELECT sha256, status, message FROM mirror WHERE dev = ? AND ino = ? AND size = ? AND mtime_ns = ?').get(...key)
    if (row?.status === 'error') { access.recheck(f); throw new ExtractError(row.message ?? 'cannot extract text') }
    if (row && fs.existsSync(this.file(row.sha256))) { access.recheck(f); return this.file(row.sha256) }
    const bytes = access.readBytes(f, LIMITS.fileBytes)
    const sha = sha256(bytes)
    const out = this.file(sha)
    let status = 'ok', message: string | null = null
    if (!fs.existsSync(out)) {
      try {
        const text = isOffice(f.name) ? new TextEncoder().encode(await this.extract(f.name, bytes, who)) : bytes
        fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 })
        const tmp = `${out}.${process.pid}.${Math.random().toString(36).slice(2)}`
        fs.writeFileSync(tmp, text, { mode: 0o600 })
        fs.renameSync(tmp, out)
      } catch (e) {
        if (!(e instanceof ExtractError) || e instanceof ExtractUnavailable) throw e
        status = 'error'; message = e.message
      }
    }
    this.db.query('INSERT OR REPLACE INTO mirror (dev, ino, size, mtime_ns, sha256, status, message) VALUES (?, ?, ?, ?, ?, ?, ?)').run(...key, sha, status, message)
    if (status === 'error') throw new ExtractError(message!)
    return out
  }

  /**
   * Fill the mirror for an original the reconciler found (bytes already read without following links and checked
   * against the identity by the caller). Returns the text, or null if it cannot be extracted. Nothing is served from
   * here: reads still go through textPath and the policy.
   */
  async ingest(f: { name: string; dev: bigint | string; ino: bigint | string; size: number; mtimeNs: bigint | string; ctimeNs?: bigint | string }, bytes: Uint8Array,
    extract: (name: string, bytes: Uint8Array) => Promise<string> = (n, b) => this.extract(n, b, INDEX_WHO)): Promise<string | null> {
    const key = [String(f.dev), String(f.ino), f.size, stamp(f)] as const
    const sha = sha256(bytes)
    const out = this.file(sha)
    let status = 'ok', message: string | null = null, text: string | null = null
    if (fs.existsSync(out)) text = fs.readFileSync(out, 'utf8')
    else {
      try {
        text = isOffice(f.name) ? await extract(f.name, bytes) : new TextDecoder().decode(bytes)
        fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 })
        const tmp = `${out}.${process.pid}.${Math.random().toString(36).slice(2)}`
        fs.writeFileSync(tmp, isOffice(f.name) ? text : bytes, { mode: 0o600 })
        fs.renameSync(tmp, out)
      } catch (e) {
        if (!(e instanceof ExtractError) || e instanceof ExtractUnavailable) throw e
        status = 'error'; message = e.message; text = null
      }
    }
    this.db.query('INSERT OR REPLACE INTO mirror (dev, ino, size, mtime_ns, sha256, status, message) VALUES (?, ?, ?, ?, ?, ?, ?)').run(...key, sha, status, message)
    return text
  }

  /**
   * Text of `f` as bytes (office files: extracted; others: original bytes). `charge` is told the size before anything
   * is read into memory and may refuse by throwing (the caller's read budget).
   */
  async text(access: Access, f: FileEntry, who?: ExtractWho, charge: (bytes: number) => void = () => {}): Promise<Uint8Array> {
    if (!isOffice(f.name)) { charge(f.size); return access.readBytes(f, LIMITS.fileBytes) }
    const p = await this.textPath(access, f, who)
    let size: number
    try { size = fs.statSync(p).size } catch { throw new Closed() }
    charge(size)
    try { return fs.readFileSync(p) } catch { throw new Closed() }
  }
}
