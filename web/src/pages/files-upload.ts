// Uploads from the browser into managed storage (src/managed): small files in one multipart request (with progress),
// large ones in resumable chunks (each with its sha256 where the browser can compute it; a dropped connection resumes
// from what the server says it has). Dropped folders are created first, top down. A name that exists waits for the
// person's choice (replace / keep both / skip). No React here: the panel subscribes to this store.
import { api, ApiError, csrfToken, signedOut } from '../api'

export type Conflict = 'fail' | 'rename' | 'replace'
export type Status = 'queued' | 'uploading' | 'done' | 'error' | 'conflict' | 'cancelled'
export interface UploadItem {
  id: number; name: string; folder: string; size: number; loaded: number; status: Status
  error?: string; path?: string; file: File; conflict: Conflict
  /** resumable upload id (large files) */
  uid?: string
  abort?: () => void
}

/** Files at or below this size go in one request; larger ones in chunks. */
export const SIMPLE_MAX = 8 * 1024 * 1024
const PARALLEL = 3

type Listener = () => void
class Uploads {
  items: UploadItem[] = []
  private seq = 0
  private listeners = new Set<Listener>()
  private changed: (folder: string) => void = () => {}
  subscribe = (f: Listener) => { this.listeners.add(f); return () => { this.listeners.delete(f) } }
  snapshot = () => this.items
  onChanged(f: (folder: string) => void) { this.changed = f }
  private emit() { this.items = [...this.items]; this.listeners.forEach((f) => f()) }
  private set(it: UploadItem, patch: Partial<UploadItem>) { Object.assign(it, patch); this.emit() }

  add(files: { file: File; folder: string }[], conflict: Conflict = 'fail') {
    for (const f of files) this.items.push({ id: ++this.seq, name: f.file.name, folder: f.folder, size: f.file.size, loaded: 0, status: 'queued', file: f.file, conflict })
    this.emit()
    this.pump()
  }
  get active() { return this.items.filter((i) => i.status === 'uploading' || i.status === 'queued').length }
  private pump() {
    while (this.items.filter((i) => i.status === 'uploading').length < PARALLEL) {
      const next = this.items.find((i) => i.status === 'queued')
      if (!next) return
      this.set(next, { status: 'uploading' })
      this.run(next).finally(() => this.pump())
    }
  }
  private async run(it: UploadItem) {
    try {
      const r = it.size <= SIMPLE_MAX && !it.uid ? await simpleUpload(it, (n) => this.set(it, { loaded: n })) : await chunkedUpload(it, (n) => this.set(it, { loaded: n }), (uid) => { it.uid = uid })
      this.set(it, { status: 'done', loaded: it.size, path: r.path })
      this.changed(it.folder)
    } catch (e) {
      if ((it.status as Status) === 'cancelled') return
      if (e instanceof ApiError && e.code === 'exists') this.set(it, { status: 'conflict', error: e.message })
      else this.set(it, { status: 'error', error: e instanceof ApiError ? e.message : String((e as Error)?.message ?? e) })
    }
  }
  /** The person chose what to do with names that exist (one item, or all waiting). */
  resolve(conflict: Conflict | 'skip', id?: number) {
    for (const it of this.items.filter((i) => i.status === 'conflict' && (id === undefined || i.id === id))) {
      if (conflict === 'skip') { it.status = 'cancelled'; if (it.uid) api('DELETE', `/uploads/${it.uid}`).catch(() => {}); continue }
      Object.assign(it, { status: 'queued', conflict, error: undefined })
    }
    this.emit()
    this.pump()
  }
  retry(id: number) { const it = this.items.find((i) => i.id === id); if (it) { this.set(it, { status: 'queued', error: undefined }); this.pump() } }
  cancel(id: number) {
    const it = this.items.find((i) => i.id === id)
    if (!it || it.status === 'done') return
    it.abort?.()
    if (it.uid) api('DELETE', `/uploads/${it.uid}`).catch(() => {})
    this.set(it, { status: 'cancelled' })
  }
  clearFinished() { this.items = this.items.filter((i) => i.status === 'uploading' || i.status === 'queued' || i.status === 'conflict'); this.emit() }
}
export const uploads = new Uploads()

// ---------- one file in one request (XHR: upload progress) ----------
function simpleUpload(it: UploadItem, progress: (n: number) => void): Promise<{ path: string }> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest()
    it.abort = () => x.abort()
    x.open('POST', `/api/files/upload?path=${encodeURIComponent(it.folder)}&conflict=${it.conflict}`)
    x.setRequestHeader('x-csrf-token', csrfToken())
    x.responseType = 'json'
    x.upload.onprogress = (e) => { if (e.lengthComputable) progress(Math.min(it.size, e.loaded)) }
    x.onload = () => {
      const d = x.response as { path?: string; error?: string; message?: string } | null
      if (x.status === 401) signedOut()
      if (x.status >= 200 && x.status < 300 && d?.path) resolve({ path: d.path })
      else reject(new ApiError(x.status, d?.error ?? 'error', d?.message ?? `upload failed (${x.status})`))
    }
    x.onerror = () => reject(new ApiError(0, 'network', 'the connection dropped'))
    x.onabort = () => reject(new ApiError(0, 'aborted', 'cancelled'))
    const form = new FormData()
    form.append('file', it.file, it.name)
    x.send(form)
  })
}

// ---------- large files: resumable chunks ----------
async function sha256Hex(b: ArrayBuffer): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null // plain http on a LAN address: no SubtleCrypto (the server still checks sizes and offsets)
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', b))
  return [...d].map((x) => x.toString(16).padStart(2, '0')).join('')
}

async function chunkedUpload(it: UploadItem, progress: (n: number) => void, remember: (uid: string) => void): Promise<{ path: string }> {
  let uid = it.uid
  let chunk = 8 * 1024 * 1024
  if (!uid) {
    const s = await api<{ id: string; chunk_size: number }>('POST', '/uploads', { path: it.folder, name: it.name, size: it.size, conflict: 'fail' })
    uid = s.id
    chunk = s.chunk_size
    remember(uid)
  }
  let off = (await api<{ received: number; chunk_size: number; state: string }>('GET', `/uploads/${uid}`).then((s) => { chunk = s.chunk_size; return s.received }))
  let tries = 0
  while (off < it.size) {
    const part = await it.file.slice(off, Math.min(it.size, off + chunk)).arrayBuffer()
    const ctl = new AbortController()
    it.abort = () => ctl.abort()
    const h: Record<string, string> = { 'x-csrf-token': csrfToken(), 'content-type': 'application/octet-stream' }
    const sum = await sha256Hex(part)
    if (sum) h['x-chunk-sha256'] = sum
    let res: Response
    try { res = await fetch(`/api/uploads/${uid}?offset=${off}`, { method: 'PUT', headers: h, body: part, credentials: 'same-origin', signal: ctl.signal }) } catch (e) {
      if (ctl.signal.aborted) throw new ApiError(0, 'aborted', 'cancelled')
      if (++tries > 5) throw new ApiError(0, 'network', 'the connection keeps dropping; try again later')
      await new Promise((r) => setTimeout(r, 1000 * tries))
      off = (await api<{ received: number }>('GET', `/uploads/${uid}`)).received // resume where the server stands
      continue
    }
    if (res.status === 409 && res.headers.get('x-upload-received')) { off = Number(res.headers.get('x-upload-received')); continue }
    if (res.status === 422 && ++tries <= 5) continue // damaged on the way: send it again
    if (res.status === 401) signedOut()
    if (!res.ok) { const d = await res.json().catch(() => null); throw new ApiError(res.status, d?.error ?? 'error', d?.message ?? `upload failed (${res.status})`) }
    off = (await res.json()).received
    tries = 0
    progress(off)
  }
  const done = await api<{ path: string }>('POST', `/uploads/${uid}/complete`, it.conflict === 'fail' ? {} : { conflict: it.conflict })
  return { path: done.path }
}

// ---------- what was dropped: files, and folders walked (webkitGetAsEntry) ----------
export interface Dropped { file: File; dirs: string[] }

/** Files of a drop (or a folder picker), each with the folder names it sits in below the drop. */
export async function droppedFiles(dt: DataTransfer): Promise<Dropped[]> {
  const entries = [...dt.items].map((i) => (i.kind === 'file' ? i.webkitGetAsEntry?.() : null)).filter((x): x is FileSystemEntry => !!x)
  if (!entries.length) return [...dt.files].map((file) => ({ file, dirs: [] }))
  const out: Dropped[] = []
  const walk = async (e: FileSystemEntry, dirs: string[]): Promise<void> => {
    if (e.isFile) { out.push({ file: await new Promise<File>((r, j) => (e as FileSystemFileEntry).file(r, j)), dirs }); return }
    if (!e.isDirectory) return
    const reader = (e as FileSystemDirectoryEntry).createReader()
    const here = [...dirs, e.name]
    out.push({ file: null as unknown as File, dirs: here }) // the folder itself (also when empty)
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((r, j) => reader.readEntries(r, j))
      if (!batch.length) break
      for (const c of batch) await walk(c, here)
    }
  }
  for (const e of entries) await walk(e, [])
  return out
}

/** From <input type=file webkitdirectory>: webkitRelativePath gives the folders. */
export function pickedFiles(files: FileList): Dropped[] {
  return [...files].map((file) => {
    const parts = (file.webkitRelativePath || file.name).split('/')
    return { file, dirs: parts.slice(0, -1) }
  })
}

/**
 * Upload dropped / picked things into `folder`: folders are made first (an existing folder of that name is used),
 * then the files are queued. Returns the number of files queued, or throws the first folder error.
 */
export async function uploadInto(folder: string, items: Dropped[], conflict: Conflict = 'fail'): Promise<number> {
  const made = new Set<string>()
  const ensure = async (dirs: string[]) => {
    let at = folder
    for (const d of dirs) {
      const next = `${at === '/' ? '' : at}/${d.normalize('NFC')}`
      if (!made.has(next)) {
        await api('POST', '/files/folder', { path: at, name: d, exist_ok: true })
        made.add(next)
      }
      at = next
    }
    return at
  }
  const queue: { file: File; folder: string }[] = []
  for (const it of items) {
    const where = await ensure(it.dirs)
    if (it.file) queue.push({ file: it.file, folder: where })
  }
  if (queue.length) uploads.add(queue, conflict)
  return queue.length
}
