// Encrypted backups of what this server is the only holder of: the SQLite store (people, rules, tokens, drafts index,
// versions, trash, audit chain) and the draft contents. NOT included: the original files in registered folders (the
// NAS shares; the NAS's own backup covers them) and the text mirror (a cache, rebuilt on demand).
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NAME, VERSION } from '../config'
import { detectLayout, layoutFor, type Layout, type LayoutKind } from '../layout'
import { ArchiveWriter, readArchive, type InfoRecord } from './archive'
import { BackupError, decryptFile, Encryptor, parsePublic, type SecretKey } from './crypto'
import { archiveName, parseTarget, prune, type BackupTarget } from './target'

export { BackupError } from './crypto'

export const NOT_BACKED_UP = [
  'the original files in your registered folders (NAS shares): back those up with the NAS itself',
  'the text mirror (a cache; it is rebuilt from the originals)',
  'logs',
]

export interface BackupConfig {
  /** "/Volumes/Backup/<name>" or "s3://bucket/prefix" */
  target: string | null
  keep: number
  allowSameDisk?: boolean
}
export const DEFAULT_KEEP = 14

export function readConfig(layout: Layout): BackupConfig {
  try {
    const c = JSON.parse(fs.readFileSync(layout.backupConfig, 'utf8'))
    return { target: typeof c.target === 'string' ? c.target : null, keep: Number.isInteger(c.keep) && c.keep > 0 ? c.keep : DEFAULT_KEEP, allowSameDisk: c.allowSameDisk === true }
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return { target: null, keep: DEFAULT_KEEP }
    throw new BackupError('config', `cannot read ${layout.backupConfig}: ${(e as Error).message}`)
  }
}

export function writeConfig(layout: Layout, c: BackupConfig) {
  fs.mkdirSync(path.dirname(layout.backupConfig), { recursive: true, mode: 0o700 })
  const tmp = `${layout.backupConfig}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, layout.backupConfig)
}

export function readRecipient(layout: Layout): Uint8Array | null {
  let text: string
  try { text = fs.readFileSync(layout.backupRecipient, 'utf8') } catch { return null }
  return parsePublic(text)
}

// ---------------------------------------------------------------------------------------------------------------
// run

export interface RunOptions {
  dataDir: string
  target: BackupTarget
  recipient: Uint8Array
  /** keep the newest N archives in the target (default: none removed) */
  keep?: number
  now?: Date
}
export interface RunResult {
  name: string
  location: string
  bytes: number
  files: number
  dbBytes: number
  draftFiles: number
  draftBytes: number
  pruned: string[]
  warnings: string[]
  info: InfoRecord
}

const TEMP_NAME = /\.\d+\.[a-z0-9]+$|\.tmp$|\.partial$/

/** Regular files under `dir` as [relative path, absolute path], sorted; symlinks and temp files skipped. */
function walk(dir: string, warnings: string[]): [string, string][] {
  const out: [string, string][] = []
  const go = (abs: string, rel: string, depth: number) => {
    let names: string[]
    try { names = fs.readdirSync(abs).sort() } catch (e) {
      if ((e as { code?: string }).code === 'ENOENT') return
      throw e
    }
    for (const n of names) {
      const a = path.join(abs, n), r = rel ? `${rel}/${n}` : n
      const st = fs.lstatSync(a)
      if (st.isDirectory() && depth < 3) go(a, r, depth + 1)
      else if (st.isFile() && !TEMP_NAME.test(n)) out.push([r, a])
      else if (!st.isFile() || depth >= 3) warnings.push(`skipped ${r} (not a regular file)`)
    }
  }
  go(dir, '', 0)
  return out
}

function readSnapshotStats(file: string): InfoRecord['db'] {
  const db = new Database(file, { readonly: true })
  try {
    const tables = new Set(db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name))
    const count = (t: string) => (tables.has(t) ? db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${t}`).get()!.n : 0)
    const head = tables.has('audit') ? db.query<{ hash: string }, []>('SELECT hash FROM audit ORDER BY id DESC LIMIT 1').get()?.hash ?? null : null
    return { auditRows: count('audit'), auditHead: head, drafts: count('drafts'), versions: count('draft_versions') }
  } finally {
    db.close()
  }
}

function snapshotDb(dbFile: string, out: string) {
  let db: Database
  try { db = new Database(dbFile, { readonly: true }) } catch { db = new Database(dbFile, { readwrite: true, create: false }) }
  try {
    db.exec('PRAGMA busy_timeout = 10000')
    // VACUUM INTO: a consistent, compact copy taken inside one read transaction while the server keeps writing
    db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`)
  } finally {
    db.close()
  }
}

function pumpFile(file: string, size: number, write: (b: Uint8Array) => void) {
  const fd = fs.openSync(file, 'r')
  try {
    let pos = 0
    while (pos < size) {
      const buf = Buffer.allocUnsafe(Math.min(1 << 20, size - pos))
      const n = fs.readSync(fd, buf, 0, buf.length, pos)
      if (n === 0) break
      write(buf.subarray(0, n))
      pos += n
    }
  } finally {
    fs.closeSync(fd)
  }
}

export async function runBackup(o: RunOptions): Promise<RunResult> {
  const layout = detectLayout(o.dataDir)
  if (!fs.existsSync(layout.dbFile)) throw new BackupError('config', `no database at ${layout.dbFile}`)
  const warnings: string[] = []
  fs.mkdirSync(layout.stagingDir, { recursive: true, mode: 0o700 })
  const staging = fs.mkdtempSync(path.join(layout.stagingDir, 'run-'))
  try {
    const snap = path.join(staging, 'store.db')
    snapshotDb(layout.dbFile, snap)
    const dbBytes = fs.statSync(snap).size
    const info: Omit<InfoRecord, 't' | 'format'> = {
      product: NAME, productVersion: VERSION, createdAt: (o.now ?? new Date()).toISOString(), host: os.hostname(),
      layout: layout.kind, excludes: NOT_BACKED_UP, db: readSnapshotStats(snap),
    }
    const drafts = walk(layout.draftsDir, warnings)

    const existing = new Set(await o.target.list())
    let name = archiveName(o.now ?? new Date())
    for (let n = 1; existing.has(name); n++) name = archiveName(o.now ?? new Date(), n)
    const sink = o.target.create(name)
    let draftBytes = 0
    try {
      const enc = new Encryptor((b) => sink.write(b), o.recipient)
      const arch = new ArchiveWriter((b) => enc.write(b), info)
      arch.file('db/store.db', dbBytes, 0o600, (w) => pumpFile(snap, dbBytes, w))
      for (const [rel, abs] of drafts) {
        const st = fs.statSync(abs)
        arch.file(`drafts/${rel}`, st.size, 0o600, (w) => pumpFile(abs, st.size, w))
        draftBytes += st.size
      }
      arch.end()
      enc.close()
    } catch (e) {
      sink.abort()
      throw e
    }
    const { location, bytes } = await sink.commit()
    const pruned = o.keep ? await prune(o.target, o.keep) : []
    return { name, location, bytes, files: drafts.length + 1, dbBytes, draftFiles: drafts.length, draftBytes, pruned, warnings, info: { t: 'info', format: 1, ...info } }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}

/** Run with the data directory's own settings (recipient file + backup.json), overridable. */
export async function runConfigured(dataDir: string, over: { target?: string; recipient?: Uint8Array; keep?: number; allowSameDisk?: boolean; now?: Date } = {}) {
  const layout = detectLayout(dataDir)
  const cfg = readConfig(layout)
  const recipient = over.recipient ?? readRecipient(layout)
  if (!recipient) throw new BackupError('config', `no backup key: ${layout.backupRecipient} is missing (make one with \`${NAME} backup keygen --set\`)`)
  const spec = over.target ?? cfg.target
  if (!spec) throw new BackupError('config', `no backup target (set one with \`${NAME} backup target set /Volumes/<disk>/${NAME}-backup\`)`)
  const target = parseTarget(spec, { dataDir: layout.dataDir, allowSameDisk: over.allowSameDisk ?? cfg.allowSameDisk })
  return runBackup({ dataDir, target, recipient, keep: over.keep ?? cfg.keep, now: over.now })
}

// ---------------------------------------------------------------------------------------------------------------
// verify / restore

export interface CheckReport {
  ok: boolean
  info: InfoRecord
  files: number
  bytes: number
  draftFiles: number
  db: { integrity: string; auditRows: number; auditHead: string | null; drafts: number; versions: number } | null
  problems: string[]
}

const CONTENT_ADDRESSED = /^drafts\/([0-9a-f]{2})\/([0-9a-f]{64})$/

/** SQLite refuses to open a WAL-mode image from memory; the header's read/write versions say WAL (2) -> legacy (1). */
function deserializable(bytes: Uint8Array): Uint8Array {
  if (bytes.length >= 20 && bytes[18] === 2 && bytes[19] === 2) { bytes[18] = 1; bytes[19] = 1 }
  return bytes
}

function checkContent(db: Database | null, info: InfoRecord, drafts: Map<string, string>, problems: string[]): CheckReport['db'] {
  for (const [p, sha] of drafts) {
    const m = CONTENT_ADDRESSED.exec(p)
    if (m && (m[2] !== sha || m[1] !== sha.slice(0, 2))) problems.push(`${p}: content does not match its name (damaged on the server before the backup?)`)
  }
  if (!db) { problems.push('the archive has no database'); return null }
  let integrity: string
  try {
    integrity = db.query<{ integrity_check: string }, []>('PRAGMA integrity_check').all().map((r) => r.integrity_check).join('; ')
  } catch (e) {
    problems.push(`database cannot be read: ${(e as Error).message}`)
    return { integrity: 'unreadable', auditRows: 0, auditHead: null, drafts: 0, versions: 0 }
  }
  if (integrity !== 'ok') problems.push(`database integrity check: ${integrity.slice(0, 300)}`)
  const tables = new Set(db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name))
  const count = (t: string) => (tables.has(t) ? db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${t}`).get()!.n : 0)
  const auditHead = tables.has('audit') ? db.query<{ hash: string }, []>('SELECT hash FROM audit ORDER BY id DESC LIMIT 1').get()?.hash ?? null : null
  const stats = { integrity, auditRows: count('audit'), auditHead, drafts: count('drafts'), versions: count('draft_versions') }
  if (info.db && (info.db.auditRows !== stats.auditRows || info.db.auditHead !== stats.auditHead)) problems.push('the audit rows in the database differ from what the archive says it holds')
  if (tables.has('draft_versions')) {
    // versions are content-addressed by sha256 in drafts/<aa>/<sha>
    const shas = new Set([...drafts.keys()].map((p) => CONTENT_ADDRESSED.exec(p)?.[2]).filter(Boolean))
    const missing = db.query<{ sha256: string }, []>('SELECT DISTINCT sha256 FROM draft_versions').all().filter((r) => !shas.has(r.sha256))
    if (missing.length) problems.push(`${missing.length} draft version(s) have no content in the archive (first: ${missing[0]!.sha256.slice(0, 12)}…)`)
  }
  return stats
}

/** Decrypt the whole archive and check it: authentication of every byte, structure, hashes, SQLite integrity, references. */
export async function verifyArchive(file: string, key: SecretKey): Promise<CheckReport> {
  const drafts = new Map<string, string>()
  const dbParts: Uint8Array[] = []
  let dbBytes = 0
  let hasDb = false
  const r = readArchive(decryptFile(file, key), {
    file(rec) {
      if (rec.path === 'db/store.db') {
        hasDb = true
        return { write: (b) => { dbParts.push(Buffer.from(b)); dbBytes += b.length }, done() {} }
      }
      return { write() {}, done: (ok, sha) => { if (ok) drafts.set(rec.path, sha) } }
    },
  })
  const problems: string[] = []
  let db: Database | null = null
  if (hasDb) {
    const bytes = new Uint8Array(dbBytes)
    let at = 0
    for (const p of dbParts) { bytes.set(p, at); at += p.length }
    try { db = Database.deserialize(deserializable(bytes), { readonly: true }) } catch (e) { problems.push(`the database image does not open: ${(e as Error).message}`) }
  }
  let stats: CheckReport['db'] = null
  try { stats = checkContent(db, r.info, drafts, problems) } finally { db?.close() }
  return { ok: problems.length === 0, info: r.info, files: r.end.files, bytes: r.end.bytes, draftFiles: drafts.size, db: stats, problems }
}

export interface RestoreOptions {
  /** layout to write (default: the one the backup was made from) */
  layout?: LayoutKind
}

/** Restore into a NEW data directory (it must not exist, or be empty). Nothing is left behind on failure. */
export async function restoreArchive(file: string, key: SecretKey, into: string, o: RestoreOptions = {}): Promise<CheckReport & { dataDir: string; layout: LayoutKind }> {
  const dest = path.resolve(into)
  if (fs.existsSync(dest)) {
    if (!fs.statSync(dest).isDirectory() || fs.readdirSync(dest).length) throw new BackupError('config', `${dest} is not empty: restore only into a new, empty folder`)
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const partial = fs.mkdtempSync(path.join(path.dirname(dest), `.${path.basename(dest)}.restoring-`))
  fs.chmodSync(partial, 0o700)
  try {
    let layout: Layout | null = null
    const drafts = new Map<string, string>()
    const target = (logical: string) => {
      if (!layout) throw new BackupError('format', 'file before info record')
      return logical === 'db/store.db' ? layout.dbFile : path.join(layout.draftsDir, ...logical.slice('drafts/'.length).split('/'))
    }
    const r = readArchive(decryptFile(file, key), {
      info(info) {
        layout = layoutFor(partial, o.layout ?? (info.layout === 'flat' ? 'flat' : 'installed'))
        for (const d of [path.dirname(layout.dbFile), layout.draftsDir, layout.mirrorDir, layout.stagingDir, layout.logsDir]) fs.mkdirSync(d, { recursive: true, mode: 0o700 })
      },
      file(rec) {
        const p = target(rec.path)
        const rel = path.relative(partial, p)
        if (rel.startsWith('..') || path.isAbsolute(rel)) throw new BackupError('unsafe', `refusing to write outside the restore folder: ${rec.path}`)
        fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 })
        const fd = fs.openSync(p, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
        return {
          write: (b) => { let off = 0; while (off < b.length) off += fs.writeSync(fd, b, off, b.length - off) },
          done: (ok, sha) => {
            if (ok) fs.fsyncSync(fd)
            fs.closeSync(fd)
            if (ok && rec.path !== 'db/store.db') drafts.set(rec.path, sha)
          },
        }
      },
    })
    const l = layout as Layout | null
    if (!l) throw new BackupError('format', 'no info record')
    const problems: string[] = []
    let stats: CheckReport['db'] = null
    if (fs.existsSync(l.dbFile)) {
      const db = new Database(l.dbFile, { readonly: true })
      try { stats = checkContent(db, r.info, drafts, problems) } finally { db.close() }
    } else {
      checkContent(null, r.info, drafts, problems)
    }
    if (problems.length) throw new BackupError('format', `restore stopped, the archive is not consistent:\n  ${problems.join('\n  ')}`)
    if (fs.existsSync(dest)) fs.rmdirSync(dest)
    fs.renameSync(partial, dest)
    return { ok: true, info: r.info, files: r.end.files, bytes: r.end.bytes, draftFiles: drafts.size, db: stats, problems, dataDir: dest, layout: l.kind }
  } catch (e) {
    fs.rmSync(partial, { recursive: true, force: true })
    throw e
  }
}
