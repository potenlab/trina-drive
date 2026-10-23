// Resumable uploads for large files: start (name, size, target folder, optional sha256), then chunks at increasing
// offsets (each ≤ chunkBytes, optionally with its own sha256), then complete — which checks the size and the whole
// file's sha256 and places it in one step through Managed.put (the same checks as any upload, judged again now).
// A dropped connection resumes: GET tells how much arrived. Unfinished uploads expire after a day.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ensureFolder } from '../store'
import { checkName, hashFd, ManagedError, taken } from './core'
import { asConflict, ensureRoom, type Managed } from './ops'
import { ensureRoot, MANAGED_LIMITS, systemDirs } from './settings'

interface UploadRow {
  id: string; person_id: number; folder_id: number; folder_vpath: string; name: string; size: number; sha256: string | null
  conflict: string; received: number; created_at: number; updated_at: number; expires_at: number; state: string; result_path: string | null
}

const HEX64 = /^[0-9a-f]{64}$/
const staging = (m: Managed, id: string) => path.join(systemDirs(m.s.root).uploads, `${id}.part`)

function own(m: Managed, id: unknown): UploadRow {
  const u = typeof id === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(id)
    ? m.db.query<UploadRow, [string]>('SELECT * FROM muploads WHERE id = ?').get(id) : null
  if (!u || u.person_id !== m.personId) throw new ManagedError(404, 'not_found', 'no such upload')
  if (u.state === 'open' && u.expires_at <= Date.now()) {
    m.db.query("UPDATE muploads SET state = 'expired' WHERE id = ?").run(u.id)
    try { fs.unlinkSync(staging(m, u.id)) } catch {}
    u.state = 'expired'
  }
  return u
}
const view = (u: UploadRow, m: Managed) => ({ id: u.id, name: u.name, folder: u.folder_vpath, size: u.size, received: u.received, state: u.state,
  chunk_size: MANAGED_LIMITS.chunkBytes, expires_at: u.expires_at, path: u.result_path, quota: m.s.quotaBytes })

export function startUpload(m: Managed, body: { path?: unknown; name?: unknown; size?: unknown; sha256?: unknown; conflict?: unknown }) {
  // a file Editor (file share, A2) may upload a new version of that file into a folder they cannot write
  const node = m.writableFor(body.path, body.name, asConflict(body.conflict), 'upload-start')
  const name = checkName(body.name, 'file name')
  const size = Number(body.size)
  if (!Number.isSafeInteger(size) || size < 0) throw new ManagedError(400, 'bad_size', 'give the file size in bytes')
  const sha = body.sha256 === undefined || body.sha256 === null || body.sha256 === '' ? null : String(body.sha256).toLowerCase()
  if (sha !== null && !HEX64.test(sha)) throw new ManagedError(400, 'bad_sha256', 'sha256: 64 hex characters')
  const conflict = asConflict(body.conflict)
  const open = m.db.query<{ n: number }, [number]>("SELECT count(*) AS n FROM muploads WHERE person_id = ? AND state = 'open'").get(m.personId)!.n
  if (open >= MANAGED_LIMITS.uploadsPerPerson) throw new ManagedError(429, 'too_many_uploads', 'too many unfinished uploads; finish or cancel some')
  ensureRoom(m.db, m.s, size)
  const id = crypto.randomBytes(18).toString('base64url')
  ensureRoot(m.s.root)
  fs.closeSync(fs.openSync(staging(m, id), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600))
  const now = Date.now()
  const vpath = `${node.vpath}/${name}`
  try {
    m.db.transaction(() => {
      const fid = ensureFolder(m.db, node.real, node.dev, node.ino, node.birth)
      m.db.query(`INSERT INTO muploads (id, person_id, folder_id, folder_vpath, name, size, sha256, conflict, received, created_at, updated_at, expires_at, state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'open')`).run(id, m.personId, fid, node.vpath, name, size, sha, conflict, now, now, now + MANAGED_LIMITS.uploadTtlMs)
      m.audit(`files upload-start ${vpath} (${size} bytes)`, [vpath])
    })()
  } catch (e) { try { fs.unlinkSync(staging(m, id)) } catch {} throw e }
  return view(m.db.query<UploadRow, [string]>('SELECT * FROM muploads WHERE id = ?').get(id)!, m)
}

export function uploadStatus(m: Managed, id: unknown) { return view(own(m, id), m) }

/** One chunk at `offset` (must be where the upload stands; a resent chunk that already arrived answers 409 with `received`). */
export function writeChunk(m: Managed, id: unknown, offset: unknown, bytes: Uint8Array, chunkSha?: string | null) {
  const u = own(m, id)
  if (u.state !== 'open') throw new ManagedError(409, 'not_open', `this upload is ${u.state}`)
  const off = Number(offset)
  if (!Number.isSafeInteger(off) || off !== u.received) throw Object.assign(new ManagedError(409, 'bad_offset', `expected offset ${u.received}`), { received: u.received })
  if (bytes.length > MANAGED_LIMITS.chunkBytes) throw new ManagedError(413, 'chunk_too_large', `chunks are at most ${MANAGED_LIMITS.chunkBytes} bytes`)
  if (!bytes.length && u.size > 0) throw new ManagedError(400, 'empty_chunk', 'empty chunk')
  if (off + bytes.length > u.size) throw new ManagedError(400, 'too_much', 'more bytes than the size given at the start')
  if (chunkSha && crypto.createHash('sha256').update(bytes).digest('hex') !== chunkSha.toLowerCase()) throw new ManagedError(422, 'chunk_checksum', 'this chunk arrived damaged (sha256 differs); send it again')
  const fd = fs.openSync(staging(m, u.id), fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW)
  try {
    let w = 0
    while (w < bytes.length) w += fs.writeSync(fd, bytes, w, bytes.length - w, off + w)
    fs.fsyncSync(fd)
  } finally { fs.closeSync(fd) }
  m.db.query('UPDATE muploads SET received = ?, updated_at = ? WHERE id = ?').run(off + bytes.length, Date.now(), u.id)
  return { received: off + bytes.length, size: u.size }
}

export function completeUpload(m: Managed, id: unknown, conflictNow?: unknown) {
  const u = own(m, id)
  if (u.state === 'done') return { path: u.result_path, already: true }
  if (u.state !== 'open') throw new ManagedError(409, 'not_open', `this upload is ${u.state}`)
  if (u.received !== u.size) throw new ManagedError(409, 'incomplete', `${u.received} of ${u.size} bytes arrived`)
  const p = staging(m, u.id)
  const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  let h: { sha256: string; size: number }
  try { h = hashFd(fd) } finally { fs.closeSync(fd) }
  if (h.size !== u.size || (u.sha256 && h.sha256 !== u.sha256)) {
    m.db.query("UPDATE muploads SET state = 'cancelled' WHERE id = ?").run(u.id)
    try { fs.unlinkSync(p) } catch {}
    m.audit(`files upload ${u.folder_vpath}/${u.name}`, [], 'checksum_mismatch')
    throw new ManagedError(422, 'checksum_mismatch', 'the file that arrived is not the one that was sent (sha256 differs); upload it again')
  }
  // the folder is judged again now (rules may have changed since the start); it is found by identity, then by its path
  const node = m.access.nodeForFolder(u.folder_id)
  const where = node && m.access.visible(node) ? node.vpath : u.folder_vpath
  const conflict = conflictNow === undefined ? asConflict(u.conflict) : asConflict(conflictNow)
  // a name taken meanwhile: the upload stays open, so it can be completed again as "replace" or "keep both"
  if (conflict === 'fail' && node && m.canWrite(node) && taken(node.real, u.name)) throw new ManagedError(409, 'exists', `${u.name} already exists here`)
  // the upload no longer reserves room once its bytes are placed (put counts them as a file)
  m.db.query("UPDATE muploads SET state = 'cancelled' WHERE id = ?").run(u.id)
  let r
  try { r = m.put(where, u.name, { path: p, size: h.size, sha256: h.sha256 }, conflict) } catch (e) {
    try { fs.unlinkSync(p) } catch {}
    throw e
  }
  m.db.query("UPDATE muploads SET state = 'done', result_path = ? WHERE id = ?").run(r.path, u.id)
  return r
}

export function cancelUpload(m: Managed, id: unknown) {
  const u = own(m, id)
  if (u.state === 'open') {
    m.db.query("UPDATE muploads SET state = 'cancelled' WHERE id = ?").run(u.id)
    try { fs.unlinkSync(staging(m, u.id)) } catch {}
  }
  return { ok: true }
}
