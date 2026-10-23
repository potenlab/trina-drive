// HTTP side of managed storage (/api, a person's session; CSRF + same-origin like every change). Routes in
// src/web/api.ts; deciding and doing in ops.ts / uploads.ts. Agents have no route here: they write drafts (MCP).
import fs from 'node:fs'
import path from 'node:path'
import { splitVirtual } from '../names'
import { Access } from '../policy'
import { Rights, type Actor } from '../rights'
import { ensureFolder } from '../store'
import { ApiError, bad, forbidden, type WebCtx } from '../web/http'
import { attachment } from '../web/files'
import { ManagedError, diskWalk, managedMountIds, stageBytes, type Staged } from './core'
import { asConflict, Managed, usage } from './ops'
import { MANAGED_LIMITS, storageSettings } from './settings'
import { cancelUpload, completeUpload, startUpload, uploadStatus, writeChunk } from './uploads'

/** Errors of managed storage as HTTP errors (hidden == missing stays a plain 404). */
export function wrap<T>(f: () => T): T {
  try { return f() } catch (e) {
    if (e instanceof ManagedError) throw new ApiError(e.status, e.code, e.message, 'received' in e ? { 'x-upload-received': String((e as { received: number }).received) } : undefined)
    throw e
  }
}
const M = (w: WebCtx, a: Actor) => new Managed(w, a.personId)

// ---------- simple JSON operations ----------
export const mkdir = (w: WebCtx, a: Actor, b: Record<string, unknown>) => wrap(() => M(w, a).mkdir(b.path, b.name, b.exist_ok === true))
export const rename = (w: WebCtx, a: Actor, b: Record<string, unknown>) => wrap(() => M(w, a).rename(b.path, b.name))
export const move = (w: WebCtx, a: Actor, b: Record<string, unknown>) => wrap(() => M(w, a).move(b.paths, b.to, asConflict(b.conflict)))
export const copy = (w: WebCtx, a: Actor, b: Record<string, unknown>) => wrap(() => M(w, a).copy(b.paths, b.to))
export const remove = (w: WebCtx, a: Actor, b: Record<string, unknown>) => wrap(() => M(w, a).remove(b.paths))
export const versions = (w: WebCtx, a: Actor, url: URL) => wrap(() => M(w, a).versions(url.searchParams.get('path')))
export const restoreVersion = (w: WebCtx, a: Actor, b: Record<string, unknown>) => wrap(() => M(w, a).restoreVersion(b.path, b.version))
export const trash = (w: WebCtx, a: Actor) => wrap(() => M(w, a).trash())
export const restore = (w: WebCtx, a: Actor, id: number) => wrap(() => M(w, a).restore(id))
export const purge = (w: WebCtx, a: Actor, id: number) => wrap(() => M(w, a).purge(id))
export const emptyTrash = (w: WebCtx, a: Actor) => wrap(() => M(w, a).emptyTrash())

/** An earlier version, as an attachment (the same headers as every download: never rendered here). */
export function versionDownload(w: WebCtx, a: Actor, url: URL): Response {
  const v = wrap(() => M(w, a).versionFile(url.searchParams.get('path'), url.searchParams.get('v')))
  return new Response(Bun.file(v.file), { headers: downloadHeaders(v.name, v.size) })
}
export const downloadHeaders = (name: string, size: number) => ({
  'content-type': 'application/octet-stream', 'content-disposition': attachment(name), 'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; sandbox", 'cache-control': 'no-store', 'content-length': String(size),
})

// ---------- uploads ----------
/**
 * One request, one or more files (multipart/form-data, field "file"; ≤ simpleUploadBytes in all). `?path=` is the
 * folder, `?conflict=fail|rename|replace`. One file: its error is the answer; several: results per file.
 */
export async function upload(w: WebCtx, a: Actor, req: Request, url: URL) {
  const len = Number(req.headers.get('content-length') ?? NaN)
  if (!Number.isFinite(len)) throw new ApiError(411, 'length_required', 'send Content-Length')
  if (len > MANAGED_LIMITS.simpleUploadBytes + 64 * 1024) throw new ApiError(413, 'too_large', `one request carries at most ${MANAGED_LIMITS.simpleUploadBytes} bytes; use /api/uploads for larger files`)
  if (!(req.headers.get('content-type') ?? '').startsWith('multipart/form-data')) throw new ApiError(415, 'multipart_only', 'send multipart/form-data')
  let form: Awaited<ReturnType<Request['formData']>>
  try { form = await req.formData() } catch { throw bad('bad_form', 'could not read the upload') }
  const files = (form.getAll('file') as unknown[]).filter((f): f is File => typeof f === 'object' && f !== null && 'arrayBuffer' in f)
  if (!files.length || files.length > MANAGED_LIMITS.simpleUploadFiles) throw bad('no_file', `send 1–${MANAGED_LIMITS.simpleUploadFiles} files in the field "file"`)
  const m = M(w, a)
  const where = url.searchParams.get('path'), conflict = asConflict(url.searchParams.get('conflict'))
  const results: Record<string, unknown>[] = []
  for (const f of files) {
    const bytes = new Uint8Array(await f.arrayBuffer())
    let staged: Staged | null = null
    try {
      staged = stageBytes(m.s.root, bytes)
      results.push({ ok: true, ...m.put(where, f.name, staged, conflict) })
    } catch (e) {
      if (files.length === 1) wrap(() => { throw e })
      if (!(e instanceof ManagedError)) throw e
      results.push({ ok: false, name: f.name, error: e.code, message: e.message })
    }
  }
  return files.length === 1 ? results[0] : { results }
}

export const uploadStart = (w: WebCtx, a: Actor, b: Record<string, unknown>) => wrap(() => startUpload(M(w, a), b))
export const uploadGet = (w: WebCtx, a: Actor, id: string) => wrap(() => uploadStatus(M(w, a), id))
export const uploadComplete = (w: WebCtx, a: Actor, id: string, b: Record<string, unknown>) => wrap(() => completeUpload(M(w, a), id, b.conflict))
export const uploadCancel = (w: WebCtx, a: Actor, id: string) => wrap(() => cancelUpload(M(w, a), id))
export async function uploadChunk(w: WebCtx, a: Actor, id: string, req: Request, url: URL) {
  const len = Number(req.headers.get('content-length') ?? NaN)
  if (!Number.isFinite(len)) throw new ApiError(411, 'length_required', 'send Content-Length')
  if (len > MANAGED_LIMITS.chunkBytes) throw new ApiError(413, 'chunk_too_large', `chunks are at most ${MANAGED_LIMITS.chunkBytes} bytes`)
  const bytes = new Uint8Array(await req.arrayBuffer())
  return wrap(() => writeChunk(M(w, a), id, url.searchParams.get('offset'), bytes, req.headers.get('x-chunk-sha256')))
}

/**
 * "Share settings" from the file view: the folder page (#/folders/<id>) of a folder the person may change rules on
 * (R7: admin or manage; never inside a personal folder). The folder gets its row here (rules attach to rows).
 */
export function shareSettings(w: WebCtx, a: Actor, b: Record<string, unknown>) {
  const access = Access.forPerson(w.db, a.personId)
  const e = typeof b.path === 'string' && b.path.length <= 4096 ? access.lookup(splitVirtual(b.path)) : null
  const node = e ? (e.kind === 'dir' ? e.node : e.parent) : null
  if (!node || !access.canRead(node)) throw new ApiError(404, 'not_found', 'not found')
  const id = ensureFolder(w.db, node.real, node.dev, node.ino, node.birth)
  const r = new Rights(w.db)
  const f = r.folders.get(id)!
  if (!r.canEditRules(a, f)) throw forbidden(r.personal(f) ? 'only the owner reads a personal folder' : 'you do not manage this folder')
  return { folder_id: id }
}

// ---------- storage: usage and quota (the admin sees it; the operator sets the quota) ----------
export function storageView(w: WebCtx, a: Actor) {
  if (!a.admin) throw forbidden('only an admin sees team storage')
  const s = storageSettings(w.db, w.dataDir)
  const u = usage(w.db)
  const r = new Rights(w.db)
  const ids = managedMountIds(w.db)
  const folders = [...ids].map((id) => r.folders.get(id)).filter((f) => !!f).map((f) => {
    const walk = fs.existsSync(f!.path) ? diskWalk(f!.path) : { files: [], dirs: [], partial: false }
    return { id: f!.id, name: f!.mount_name, vpath: r.vpath(f!), bytes: walk.files.reduce((n, x) => n + x.size, 0), files: walk.files.length, partial: walk.partial }
  }).sort((x, y) => y.bytes - x.bytes)
  return {
    mode: s.mode, quota: s.quotaBytes, usage: u, max_file_bytes: s.maxFileBytes, versions_kept: s.versionsKept, trash_days: s.trashDays,
    chunk_bytes: MANAGED_LIMITS.chunkBytes, simple_upload_bytes: MANAGED_LIMITS.simpleUploadBytes, folders,
    ...(a.admin ? { root: path.resolve(s.root) } : {}),
  }
}
