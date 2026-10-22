// Text mirror on the server's disk (outside every registered folder), named by the sha256 of the original bytes.
// grep runs over these files; cat/read of office files show them. Every entry is reached through Access (policy).
import fs from 'node:fs'
import path from 'node:path'
import type { DB } from './db'
import { LIMITS } from './config'
import { ExtractError, extractText } from './extract'
import { isOffice } from './names'
import { Closed, type Access, type FileEntry } from './policy'
import { sha256 } from './store'

interface Row { sha256: string; status: string; message: string | null }

export class Mirror {
  constructor(private readonly db: DB, readonly dir: string) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }) }

  private file(sha: string) { return path.join(this.dir, sha.slice(0, 2), sha + '.txt') }

  /** Mirror file holding the text of `f` (extracted for office files, the bytes themselves otherwise). */
  async textPath(access: Access, f: FileEntry): Promise<string> {
    const key = [String(f.dev), String(f.ino), f.size, String(f.mtimeNs)] as const
    const row = this.db.query<Row, [string, string, number, string]>('SELECT sha256, status, message FROM mirror WHERE dev = ? AND ino = ? AND size = ? AND mtime_ns = ?').get(...key)
    if (row?.status === 'error') { access.recheck(f); throw new ExtractError(row.message ?? 'cannot extract text') }
    if (row && fs.existsSync(this.file(row.sha256))) { access.recheck(f); return this.file(row.sha256) }
    const bytes = access.readBytes(f, LIMITS.fileBytes)
    const sha = sha256(bytes)
    const out = this.file(sha)
    let status = 'ok', message: string | null = null
    if (!fs.existsSync(out)) {
      try {
        const text = isOffice(f.name) ? new TextEncoder().encode(await extractText(f.name, bytes)) : bytes
        fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 })
        const tmp = `${out}.${process.pid}.${Math.random().toString(36).slice(2)}`
        fs.writeFileSync(tmp, text, { mode: 0o600 })
        fs.renameSync(tmp, out)
      } catch (e) {
        if (!(e instanceof ExtractError)) throw e
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
  async ingest(f: { name: string; dev: bigint | string; ino: bigint | string; size: number; mtimeNs: bigint | string }, bytes: Uint8Array,
    extract: (name: string, bytes: Uint8Array) => Promise<string> = extractText): Promise<string | null> {
    const key = [String(f.dev), String(f.ino), f.size, String(f.mtimeNs)] as const
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
        if (!(e instanceof ExtractError)) throw e
        status = 'error'; message = e.message; text = null
      }
    }
    this.db.query('INSERT OR REPLACE INTO mirror (dev, ino, size, mtime_ns, sha256, status, message) VALUES (?, ?, ?, ?, ?, ?, ?)').run(...key, sha, status, message)
    return text
  }

  /** Text of `f` as bytes (office files: extracted; others: original bytes). */
  async text(access: Access, f: FileEntry): Promise<Uint8Array> {
    if (!isOffice(f.name)) return access.readBytes(f, LIMITS.fileBytes)
    const p = await this.textPath(access, f)
    try { return fs.readFileSync(p) } catch { throw new Closed() }
  }
}
