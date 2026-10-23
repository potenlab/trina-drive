// Importing picked Google Drive files into a managed team folder. Every file goes through the same write path as an
// upload (src/managed/ops.ts Managed.put): the person's rules decide (write on the target folder; hidden == missing),
// the quota and the largest file size apply, the bytes are staged and placed in one step, a replace keeps the old bytes
// as a version, every change is an audit row, and the text mirror reads the new file (docx/xlsx/pptx/pdf extraction,
// as for any upload). A name that is taken gets " (1)" (conflict = rename).
//
// Google Docs, Sheets and Slides are exported as docx, xlsx and pptx (Drawings as pdf); other Google types (Forms,
// Sites, shortcuts) are refused per item. Importing the same Google file into the same folder again makes a new version
// of the file it made before (found by its file row, wherever it was renamed to in that folder) — or nothing, when
// Google says the file did not change (modifiedTime and version).
//
// A job runs in the server after the request answers; the web app polls its progress. Jobs live in memory (a restart
// ends running ones: what was imported stays, the rest can be picked again).
import crypto from 'node:crypto'
import { appendAudit } from '../audit'
import type { DB } from '../db'
import { ManagedError, stageStream } from '../managed/core'
import { ensureRoom, Managed } from '../managed/ops'
import { checkName } from '../managed/core'
import { isSystemName, nfc } from '../names'
import type { FileEntry, Node } from '../policy'
import type { Ctx } from '../session'
import { ensureFolder } from '../store'
import { EXPORTS, FOLDER_MIME, GDRIVE_LIMITS, SCOPE_READONLY } from './config'
import { GoogleError, type DriveFile, type GoogleClient } from './google'
import { accessToken, connectionOf, ensureGdriveSchema, hasScope, NotConnected } from './store'

export type ItemStatus = 'queued' | 'importing' | 'imported' | 'updated' | 'unchanged' | 'folder' | 'failed'
export interface ImportItem { drive_id: string; name: string; folder: string; depth: number; status: ItemStatus; path?: string; version?: number; error?: string; message?: string; bytes?: number }
export interface Job {
  id: string; person_id: number; folder: string; state: 'running' | 'done'; created_at: number; finished_at: number | null
  items: ImportItem[]; error?: string
}

type JobCtx = Pick<Ctx, 'db' | 'dataDir' | 'mirror'>
const jobsByDb = new WeakMap<DB, Map<string, { job: Job; done: Promise<void> }>>()
const jobsOf = (db: DB) => { let m = jobsByDb.get(db); if (!m) { m = new Map(); jobsByDb.set(db, m) } return m }

/** A name Trina accepts, from a Google file's name (Google allows "/" and anything else in names). */
export function safeName(raw: string, ext?: string): string {
  let n = nfc(raw ?? '').replace(/[/\\]/g, '_').replace(/\p{Cc}/gu, '').trim()
  if (!n || n === '.' || n === '..') n = 'Untitled'
  if (isSystemName(n)) n = '_' + n
  let tail = ''
  if (ext && !n.toLowerCase().endsWith('.' + ext)) tail = '.' + ext
  while (Buffer.byteLength(n + tail) > 255) n = [...n].slice(0, -1).join('')
  n = n.trim() + tail
  try { return checkName(n) } catch { return 'Untitled' + tail }
}

export function jobView(j: Job) {
  const count = (s: ItemStatus[]) => j.items.filter((i) => s.includes(i.status)).length
  const files = j.items.filter((i) => i.status !== 'folder')
  return { id: j.id, folder: j.folder, state: j.state, created_at: j.created_at, finished_at: j.finished_at, error: j.error ?? null,
    total: files.length, done: count(['imported', 'updated', 'unchanged', 'failed']), imported: count(['imported']), updated: count(['updated']),
    unchanged: count(['unchanged']), failed: count(['failed']), items: j.items.map(({ depth: _d, ...i }) => i) }
}

export const jobOf = (db: DB, personId: number, id: string) => { const j = jobsOf(db).get(id)?.job; return j && j.person_id === personId ? j : null }
export const jobsOfPerson = (db: DB, personId: number) => [...jobsOf(db).values()].map((x) => x.job).filter((j) => j.person_id === personId).sort((a, b) => b.created_at - a.created_at)
/** Resolves when the job has finished (tests). */
export const jobDone = (db: DB, id: string) => jobsOf(db).get(id)?.done ?? Promise.resolve()

/**
 * Start an import of picked Drive ids into `folder` (a vpath). The folder is judged now (404/403 as for an upload) and
 * again for every file. Returns the job; it runs on after this returns.
 */
export function startImport(ctx: JobCtx, google: GoogleClient, personId: number, folder: unknown, ids: unknown): Job {
  ensureGdriveSchema(ctx.db)
  const list = Array.isArray(ids) ? ids.map((x) => typeof x === 'object' && x && 'id' in x ? (x as { id: unknown }).id : x) : []
  if (!list.length || list.length > GDRIVE_LIMITS.pickedItems || list.some((x) => typeof x !== 'string' || !/^[A-Za-z0-9_-]{8,200}$/.test(x)))
    throw new ManagedError(400, 'bad_items', `pick 1–${GDRIVE_LIMITS.pickedItems} files`)
  const m = new Managed(ctx, personId)
  const node = m.writable(folder, 'gdrive-import')
  if (!connectionOf(ctx.db, personId)) throw new ManagedError(409, 'not_connected', 'connect Google Drive first')
  const all = jobsOf(ctx.db)
  if (jobsOfPerson(ctx.db, personId).filter((j) => j.state === 'running').length >= GDRIVE_LIMITS.jobsPerPerson)
    throw new ManagedError(429, 'too_many_imports', 'wait for your other imports to finish')
  // finished jobs beyond the last few are forgotten
  const finished = [...all.values()].filter((x) => x.job.person_id === personId && x.job.state === 'done').sort((a, b) => b.job.created_at - a.job.created_at)
  for (const x of finished.slice(GDRIVE_LIMITS.jobsKept)) all.delete(x.job.id)
  const unique = [...new Set(list as string[])]
  const job: Job = { id: crypto.randomBytes(12).toString('base64url'), person_id: personId, folder: node.vpath, state: 'running', created_at: Date.now(), finished_at: null,
    items: unique.map((id) => ({ drive_id: id, name: id, folder: node.vpath, depth: 0, status: 'queued' as const })) }
  m.audit(`gdrive import into ${node.vpath}: ${unique.length} picked (drive ${unique.slice(0, 20).join(',')}${unique.length > 20 ? ',…' : ''})`, [node.vpath])
  const done = run(ctx, google, job).catch((e) => { job.error = e instanceof Error ? e.message : String(e) }).finally(() => {
    job.state = 'done'; job.finished_at = Date.now()
    for (const i of job.items) if (i.status === 'queued' || i.status === 'importing') Object.assign(i, { status: 'failed', error: 'stopped', message: job.error ?? 'the import stopped' })
    const v = jobView(job)
    try {
      appendAudit(ctx.db, { personId, tokenId: null, tool: 'web', command: `gdrive import into ${job.folder} finished: ${v.imported} new, ${v.updated} updated, ${v.unchanged} unchanged, ${v.failed} failed`, files: [job.folder], outcome: v.failed ? 'partial' : 'ok' })
    } catch (e) { console.error('[gdrive] could not write the audit row of an import:', e) }
  })
  all.set(job.id, { job, done })
  return job
}

async function run(ctx: JobCtx, google: GoogleClient, job: Job) {
  let token = await accessToken(ctx.db, ctx.dataDir, google, job.person_id)
  const conn = connectionOf(ctx.db, job.person_id)
  const folders = hasScope(conn, SCOPE_READONLY) && google.cfg.readonly
  /** a Drive call; an expired token is refreshed once */
  const g = async <T>(f: (t: string) => Promise<T>): Promise<T> => {
    try { return await f(token) } catch (e) {
      if (!(e instanceof GoogleError) || e.status !== 401) throw e
      token = await accessToken(ctx.db, ctx.dataDir, google, job.person_id, true)
      return f(token)
    }
  }
  for (let i = 0; i < job.items.length; i++) {
    const item = job.items[i]!
    item.status = 'importing'
    try {
      const meta = await g((t) => google.file(item.drive_id, t))
      item.name = meta.name
      if (meta.trashed) throw new ManagedError(410, 'trashed', 'this file is in the Google Drive trash')
      if (meta.mimeType === FOLDER_MIME) {
        if (!folders) throw new ManagedError(400, 'folder_needs_readonly', 'folders are not imported on this server: open the folder in the picker and pick the files inside')
        if (item.depth >= GDRIVE_LIMITS.depth) throw new ManagedError(400, 'too_deep', 'folders this deep are not imported')
        const made = new Managed(ctx, job.person_id).mkdir(item.folder, safeName(meta.name), true)
        const room = GDRIVE_LIMITS.jobFiles - job.items.filter((x) => x.status !== 'folder').length
        const kids = room > 0 ? await g((t) => google.children(meta.id, t, room)) : []
        for (const k of kids.slice(0, Math.max(0, room))) job.items.push({ drive_id: k.id, name: k.name, folder: made.path, depth: item.depth + 1, status: 'queued' })
        Object.assign(item, { status: 'folder', path: made.path })
        continue
      }
      Object.assign(item, await importFile(ctx, google, g, job.person_id, item.folder, meta))
    } catch (e) {
      if (e instanceof NotConnected) throw e
      const code = e instanceof ManagedError ? e.code : e instanceof GoogleError ? e.reason : 'failed'
      const message = e instanceof ManagedError || e instanceof GoogleError ? e.message : 'the file could not be imported'
      if (!(e instanceof ManagedError) && !(e instanceof GoogleError)) console.error('[gdrive] import of one file failed:', e)
      Object.assign(item, { status: 'failed', error: code, message })
    }
  }
}

/** The file this Google file became in this folder before (by its file row), if it is still there. */
function previous(m: Managed, node: Node, fileId: number): FileEntry | null {
  const r = m.db.query<{ dev: string; ino: string }, [number]>('SELECT dev, ino FROM mfiles WHERE id = ?').get(fileId)
  if (!r) return null
  for (const e of m.access.list(node)) if (e.kind === 'file' && String(e.dev) === r.dev && String(e.ino) === r.ino) return e
  return null
}

async function importFile(ctx: JobCtx, google: GoogleClient, g: <T>(f: (t: string) => Promise<T>) => Promise<T>, personId: number, folder: string, meta: DriveFile): Promise<Partial<ImportItem>> {
  const exp = EXPORTS[meta.mimeType]
  if (!exp && meta.mimeType.startsWith('application/vnd.google-apps.'))
    throw new ManagedError(415, 'not_exportable', meta.mimeType.endsWith('.shortcut') ? 'a shortcut: pick the file it points to' : 'this kind of Google file cannot be exported as a file')
  const db = ctx.db
  const m = new Managed(ctx, personId)
  const node = m.writable(folder, 'gdrive-import')
  const folderId = ensureFolder(db, node.real, node.dev, node.ino, node.birth)
  const map = db.query<{ file_id: number; modified_time: string | null; drive_version: string | null }, [string, number]>(
    'SELECT file_id, modified_time, drive_version FROM gdrive_files WHERE drive_id = ? AND folder_id = ?').get(meta.id, folderId)
  const before = map ? previous(m, node, map.file_id) : null
  if (before && map!.modified_time === (meta.modifiedTime ?? null) && map!.drive_version === (meta.version ?? null)) return { status: 'unchanged', path: before.vpath }
  if (meta.size) ensureRoom(db, m.s, Number(meta.size))
  const res = await g((t) => exp ? google.exported(meta, exp.mime, t) : google.media(meta.id, t))
  const staged = await stageStream(m.s.root, res.body, m.s.maxFileBytes, 'gdrive')
  // judged again now: the download took a while (rules, names and the quota may have changed)
  const now = new Managed(ctx, personId)
  const again = before && now.entry(before.vpath)
  const r = again && again.kind === 'file' && String(again.dev) === String(before!.dev) && String(again.ino) === String(before!.ino)
    ? now.put(folder, again.name, staged, 'replace', 'gdrive-import')
    : now.put(folder, safeName(meta.name, exp?.ext), staged, 'rename', 'gdrive-import')
  db.query(`INSERT INTO gdrive_files (drive_id, folder_id, file_id, modified_time, drive_version, mime, imported_at, imported_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (drive_id, folder_id) DO UPDATE SET file_id = excluded.file_id, modified_time = excluded.modified_time, drive_version = excluded.drive_version,
      mime = excluded.mime, imported_at = excluded.imported_at, imported_by = excluded.imported_by`)
    .run(meta.id, folderId, r.file_id, meta.modifiedTime ?? null, meta.version ?? null, meta.mimeType, Date.now(), personId)
  return { status: r.replaced ? 'updated' : 'imported', path: r.path, version: r.version, bytes: staged.size }
}
