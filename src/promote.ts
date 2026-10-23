// Draft promote and the approval inbox (plan 5.2 "초안 반영 + 승인함", 4.1 R2 v0.2, R5, R6, R8, R11; principle 5).
//
// A draft becomes a NEW file in a team folder (never an overwrite). The target folder must have "promote" turned on
// (admin only; it holds for the folder and everything below, never inside a personal folder) and the person's rule
// there must be `write` (R2: in v0.2 `write` marks where a person's drafts may land). Then:
//   - not widening (R6 with S ≠ F over R5 readers): written at once — a temp file in the target folder, fsync, then a
//     no-replace rename (link + unlink; exclusive create where the share has no hard links), the draft's version hash
//     checked right before, the folder chain re-checked around it. Audited, and the file's identity is recorded as a
//     tracked copy of the draft (the `widened` table, match 'promote'), so whoever reads it later inherits Src(d)
//     exactly as with a confirmed NAS copy, and R6 re-judges it when rules change.
//   - widening: an approval request. The server keeps the bytes (content-addressed blob of that version), and a person
//     eligible under R8 approves it on the web with a fresh passkey (or, LAN-only, TOTP) step-up. Approval re-judges at
//     click time and writes exactly that version hash. No eligible person → closed ("no one can approve").
// Agents can ask (MCP `promote`), never approve: approval APIs need a web session and a step-up minted for that click.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { appendAudit } from './audit'
import { NAME } from './config'
import type { DB } from './db'
import { sourcesFor, type Blobs, type Draft } from './drafts'
import { sniffLink, SNIFF_BYTES } from './inplace/linkish'
import { ext, isSystemName, nfc, splitVirtual } from './names'
import { Access, isWidening, widenedReaders, type FileEntry, type Node } from './policy'
import { Rights } from './rights'
import { ensureFolder, sha256, type FolderRow } from './store'
import { dropStaged, fileUidAt, gcBlobs, inManaged, managedMountIds, ManagedError, placeNew, placeReplace, stageBytes, taken as mTaken, trackNew, trackReplace, type Placed as ManagedPlaced } from './managed/core'
import { indexLater } from './managed/ops'
import { versionsKept } from './managed/settings'
import type { Mirror } from './mirror'
import { ensureWebSchema } from './web/schema'
import { addColumns } from './migrations'
import { applyShareApproval, shareApprovalDetail, shareApproverStatus } from './share/approvals'

export const APPROVAL_TTL_MS = 7 * 86400_000
export const MAX_PENDING_PER_PERSON = 20
export const REASON_MAX = 2000
export const PREVIEW_BYTES = 256 * 1024
/** What a promoted file may be called: text formats only (drafts are text; no executables, shortcuts or office names). */
export const PROMOTE_EXT = ['md', 'markdown', 'txt', 'csv', 'tsv', 'json', 'yaml', 'yml', 'log'] as const

const SCHEMA = `
-- folders where drafts may be promoted (admin only); holds for the folder and everything below it
CREATE TABLE IF NOT EXISTS promote_folders (folder_id INTEGER PRIMARY KEY REFERENCES folders(id), by_person INTEGER, at INTEGER NOT NULL);
-- a widening promote waiting for a person (R8). sha256 = the draft version promoted (its blob is kept); src = Src(d) at request
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','expired','closed','cancelled','stale','failed')),
  draft_id INTEGER NOT NULL, draft_version INTEGER NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, draft_path TEXT NOT NULL,
  requester_person_id INTEGER NOT NULL, requester_token_id INTEGER,
  target_folder_id INTEGER NOT NULL, target_vpath TEXT NOT NULL, name TEXT NOT NULL, reason TEXT,
  src TEXT NOT NULL, gain INTEGER NOT NULL,
  decided_at INTEGER, decided_by INTEGER, decision_reason TEXT, promotion_id INTEGER);
CREATE INDEX IF NOT EXISTS approvals_status ON approvals (status);
-- every file this server wrote into a team folder (new files only)
CREATE TABLE IF NOT EXISTS promotions (
  id INTEGER PRIMARY KEY, at INTEGER NOT NULL, approval_id INTEGER, draft_id INTEGER NOT NULL, draft_version INTEGER NOT NULL,
  sha256 TEXT NOT NULL, size INTEGER NOT NULL, by_person INTEGER NOT NULL, token_id INTEGER, target_folder_id INTEGER NOT NULL,
  path TEXT NOT NULL, vpath TEXT NOT NULL, dev TEXT NOT NULL, ino TEXT NOT NULL, widening INTEGER NOT NULL);
`
const done = new WeakSet<DB>()
export function ensurePromoteSchema(db: DB) {
  if (done.has(db)) return
  ensureWebSchema(db) // approvers are people with a web sign-in (accounts)
  db.exec(SCHEMA)
  // managed storage: a promote may replace an existing file (it becomes an earlier version, so nothing is lost)
  if (!db.query<{ name: string }, []>('PRAGMA table_info(approvals)').all().some((c) => c.name === 'overwrite'))
    db.exec('ALTER TABLE approvals ADD COLUMN overwrite INTEGER NOT NULL DEFAULT 0')
  // sharing (src/share/approvals.ts): an Editor's sharing change that widens AI-draft copies waits here too.
  // kind NULL = a promote; 'share' = payload holds the change (draft columns are 0/'' for those rows)
  addColumns(db, 'approvals', [['kind', 'TEXT'], ['payload', 'TEXT']])
  done.add(db)
}

export class PromoteError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message) }
}

/** Test hooks (race simulation). Never set in production. */
export const promoteHooks: { beforePlace?: (finalPath: string) => void; noHardLinks?: boolean } = {}

// ---------- the promote flag (admin only, inherited down, not inside personal folders) ----------
export function promoteFolderIds(db: DB): Set<number> {
  ensurePromoteSchema(db)
  return new Set(db.query<{ folder_id: number }, []>('SELECT folder_id FROM promote_folders').all().map((r) => r.folder_id))
}
export const promoteOn = (ids: Set<number>, rows: FolderRow[]) => !rows.some((r) => r.personal_owner != null) && rows.some((r) => ids.has(r.id))

export function setPromote(db: DB, folderId: number, on: boolean, by: number | null) {
  ensurePromoteSchema(db)
  if (on) db.query('INSERT OR IGNORE INTO promote_folders (folder_id, by_person, at) VALUES (?, ?, ?)').run(folderId, by, Date.now())
  else db.query('DELETE FROM promote_folders WHERE folder_id = ?').run(folderId)
}

// ---------- names ----------
export function checkTargetName(name: unknown): string {
  if (typeof name !== 'string') throw new PromoteError('bad_name', 'give the new file a name')
  const n = nfc(name)
  const bad = (why: string) => new PromoteError('bad_name', `bad file name: ${why}`)
  if (!n || n !== n.trim()) throw bad('empty, or starts or ends with a space')
  if (/[/\\]/.test(n) || n === '.' || n === '..') throw bad('a name, not a path (no / or \\)')
  if (/\p{Cc}/u.test(n) || /[<>:"|?*]/.test(n)) throw bad('control characters and < > : " | ? * are not allowed')
  if (Buffer.byteLength(n) > 255) throw bad('longer than 255 bytes')
  if (n.startsWith('.') || n.startsWith('~') || isSystemName(n) || n.endsWith('.')) throw bad('hidden, system or temporary names are not allowed')
  if (!(PROMOTE_EXT as readonly string[]).includes(ext(n))) throw bad(`text files only (${PROMOTE_EXT.map((e) => '.' + e).join(', ')})`)
  return n
}

/** A name already there (any spelling equal after NFC, case-insensitively), or its Mac sidecar. */
const nameTakenSafe = (dir: string, name: string) => { try { return nameTaken(dir, name) } catch { return false } }
function nameTaken(dir: string, name: string): boolean {
  const want = nfc(name).toLowerCase()
  let names: string[]
  try { names = fs.readdirSync(dir) } catch { throw new PromoteError('target_changed', 'the target folder cannot be listed; nothing was written', 409) }
  return names.some((n) => { const k = nfc(n).toLowerCase(); return k === want || k === '._' + want })
}

// ---------- targets ----------
export interface Promoter {
  personId: number
  /** the agent's token, or null for a person on the web */
  tokenId: number | null
  /** the token's view (agent) or the person's (web): the target must be readable in it */
  access: Access
}

export interface Target { node: Node; folderId: number; vpath: string }

/** The folder a promoter may promote into, by the path they see. Hidden or missing folders answer the same. */
export function resolveTarget(db: DB, p: Promoter, folder: unknown): Target {
  if (typeof folder !== 'string' || !folder.trim()) throw new PromoteError('bad_folder', 'give the target folder, e.g. /프로젝트/2026')
  const e = p.access.lookup(splitVirtual(folder))
  if (!e || e.kind !== 'dir' || !p.access.canRead(e.node)) throw new PromoteError('no_folder', `No such folder: ${folder}`, 404)
  const node = e.node
  if (!promoteOn(promoteFolderIds(db), node.rows)) throw new PromoteError('promote_off', `Promote is not turned on for ${node.vpath}; an admin turns it on for the folder (Folders → Promote).`, 403)
  if (p.access.level(node) < 2) throw new PromoteError('no_write', `Your rule on ${node.vpath} is not "write": drafts can be promoted only where you have write.`, 403)
  return { node, folderId: ensureFolder(db, node.real, node.dev, node.ino, node.birth), vpath: node.vpath }
}

/** Folders (by id and the path this person sees) where this person may promote. */
export function promoteTargets(db: DB, personId: number) {
  const access = Access.forPerson(db, personId)
  const out: { id: number; vpath: string }[] = []
  for (const id of promoteFolderIds(db)) {
    const n = access.nodeForFolder(id)
    if (n && access.canRead(n) && access.level(n) >= 2 && promoteOn(promoteFolderIds(db), n.rows)) out.push({ id, vpath: n.vpath })
  }
  return out.sort((a, b) => a.vpath.localeCompare(b.vpath))
}

// ---------- readers ----------
/** R5/R6: people who would read the file at `target` but cannot read some source S ≠ target. */
export function readerGain(db: DB, src: Iterable<number>, target: number, fileUid?: string | null): number[] {
  return [...widenedReaders(db, src, target, fileUid)]
}

// ---------- the draft ----------
const latest = (db: DB, draftId: number) => db.query<{ version: number; sha256: string; deleted_at: number | null }, [number]>(
  `SELECT v.version, v.sha256, d.deleted_at FROM draft_versions v JOIN drafts d ON d.id = v.draft_id
   WHERE v.draft_id = ? ORDER BY v.version DESC LIMIT 1`).get(draftId)

function checkContent(bytes: Uint8Array) {
  if (sniffLink(bytes.subarray(0, SNIFF_BYTES), bytes.length)) throw new PromoteError('bad_content', 'this draft looks like a link file (XSym / alias) and cannot be promoted')
}

// ---------- writing ----------
export interface Placed {
  real: string; dev: string; ino: string
  /** managed storage (src/managed): placed through its staging and versions; recorded as a file row (and a version) */
  managed?: { placed: ManagedPlaced; keep: number }
}

/** ⑦ for folders: every step from the mount down is still the same folder and not a link. */
function recheckDir(node: Node) {
  for (let n: Node | null = node; n; n = n.parent) {
    let st: fs.BigIntStats
    try { st = fs.lstatSync(n.real, { bigint: true }) } catch { throw new PromoteError('target_changed', 'the target folder changed; nothing was written', 409) }
    if (st.isSymbolicLink() || !st.isDirectory() || st.dev !== n.dev || st.ino !== n.ino || st.birthtimeNs !== n.birth) throw new PromoteError('target_changed', 'the target folder changed; nothing was written', 409)
  }
}

const exists = (name: string, vpath: string) => new PromoteError('exists', `${vpath}/${name} already exists. Promote writes new files only; choose another name.`, 409)
const NO_HARDLINK = new Set(['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV', 'ENOSYS', 'EMLINK'])

function writeAll(fd: number, bytes: Uint8Array) {
  let off = 0
  while (off < bytes.length) off += fs.writeSync(fd, bytes, off, bytes.length - off)
  fs.fsyncSync(fd)
}

/**
 * Put `bytes` at <node>/<name> as a new file, never replacing anything: write a temp file in the same folder (opened
 * O_EXCL|O_NOFOLLOW), re-check the folder chain, then link it to the final name (link refuses an existing name, so
 * this is a no-replace rename) and unlink the temp. Shares without hard links get an exclusive create of the final name.
 * The result is checked (a regular file, one link, same identity, same bytes).
 */
export function placeNewFile(node: Node, name: string, bytes: Uint8Array): Placed {
  recheckDir(node)
  const vp = node.vpath
  if (nameTaken(node.real, name)) throw exists(name, vp)
  const final = path.join(node.real, name)
  const tmp = path.join(node.real, `~$${NAME}-promote-${crypto.randomBytes(6).toString('hex')}.tmp`)
  const W = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW
  const fd = fs.openSync(tmp, W, 0o644)
  try {
    try { writeAll(fd, bytes) } finally { fs.closeSync(fd) }
    recheckDir(node)
    promoteHooks.beforePlace?.(final)
    try {
      if (promoteHooks.noHardLinks) throw Object.assign(new Error('simulated share without hard links'), { code: 'ENOTSUP' })
      fs.linkSync(tmp, final)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? ''
      if (code === 'EEXIST') throw exists(name, vp)
      if (!NO_HARDLINK.has(code)) throw e
      let fd2: number
      try { fd2 = fs.openSync(final, W, 0o644) } catch (e2) {
        if ((e2 as NodeJS.ErrnoException).code === 'EEXIST') throw exists(name, vp)
        throw e2
      }
      try { writeAll(fd2, bytes) } catch (e3) { try { fs.unlinkSync(final) } catch {} throw e3 } finally { fs.closeSync(fd2) }
    }
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch {}
    throw e
  }
  try { fs.unlinkSync(tmp) } catch {}
  const st = fs.lstatSync(final, { bigint: true })
  const back = fs.readFileSync(final)
  if (!st.isFile() || st.nlink !== 1n || sha256(back) !== sha256(bytes)) {
    throw new PromoteError('write_check', 'the written file did not check out (link count or content); it was left in place for the admin to look at', 500)
  }
  return { real: final, dev: String(st.dev), ino: String(st.ino) }
}

/** Undo a placement whose record could not be written (only if it is still the file we wrote). */
export function unplace(p: Placed) {
  if (p.managed) { p.managed.placed.undo(); return }
  try {
    const st = fs.lstatSync(p.real, { bigint: true })
    if (String(st.dev) === p.dev && String(st.ino) === p.ino) fs.unlinkSync(p.real)
  } catch {}
}

// ---------- records ----------
interface RecordArgs {
  draft: { id: number; version: number; sha256: string; size: number; token_id: number; person_id: number }
  byPerson: number; tokenId: number | null; targetId: number; vpath: string; placed: Placed; widening: boolean
  approvalId: number | null; now: number
}

/** Inside the caller's transaction: the promotion row and the tracked/confirmed copy that passes Src(d) on (R3/R6). */
export function recordPromotion(db: DB, a: RecordArgs): number {
  ensurePromoteSchema(db)
  if (a.placed.managed) {
    const m = a.placed.managed
    if (m.placed.replaced) { const r = trackReplace(db, m.placed, a.byPerson, a.now, m.keep); gcLater.set(m.placed, r.dropped) }
    else trackNew(db, m.placed, a.byPerson, a.now)
  }
  const id = Number(db.query(`INSERT INTO promotions (at, approval_id, draft_id, draft_version, sha256, size, by_person, token_id, target_folder_id, path, vpath, dev, ino, widening)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(a.now, a.approvalId, a.draft.id, a.draft.version, a.draft.sha256, a.draft.size, a.byPerson, a.tokenId,
    a.targetId, a.placed.real, a.vpath, a.placed.dev, a.placed.ino, a.widening ? 1 : 0).lastInsertRowid)
  const status = a.approvalId != null ? 'confirmed' : 'tracked'
  db.query(`INSERT INTO widened (at, dev, ino, path, sha256, draft_id, draft_version, writer_person_id, writer_token_id, target_folder_id, match, overlap,
      widening, ever_widening, status, judged_at, confirmed_at, confirmed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'promote', 1, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (dev, ino, draft_id) DO UPDATE SET path = excluded.path, sha256 = excluded.sha256, draft_version = excluded.draft_version,
      target_folder_id = excluded.target_folder_id, match = excluded.match, widening = excluded.widening,
      ever_widening = max(ever_widening, excluded.widening), status = excluded.status, judged_at = excluded.judged_at,
      confirmed_at = excluded.confirmed_at, confirmed_by = excluded.confirmed_by`)
    .run(a.now, a.placed.dev, a.placed.ino, a.placed.real, a.draft.sha256, a.draft.id, a.draft.version, a.draft.person_id, a.draft.token_id, a.targetId,
      a.widening ? 1 : 0, a.widening ? 1 : 0, status, a.now, a.approvalId != null ? a.now : null, a.approvalId != null ? a.byPerson : null)
  return id
}

// ---------- requests ----------
export type Plan =
  | { kind: 'write'; target: Target; bytes: Uint8Array; draft: Draft; name: string; overwrite: boolean }
  | { kind: 'approval'; target: Target; bytes: Uint8Array; draft: Draft; name: string; gain: number[]; overwrite: boolean }

/**
 * Decide what a promote does (nothing is written here): the draft's current version, a valid new name, a target the
 * promoter may promote into, and whether it widens. `expectedSha` (optional) must be the draft's current version.
 */
export function planPromote(db: DB, blobs: Blobs, p: Promoter, draft: Draft, folder: unknown, name: unknown, expectedSha?: unknown, overwrite?: unknown): Plan {
  ensurePromoteSchema(db)
  const n = checkTargetName(name)
  if (expectedSha !== undefined && expectedSha !== null && expectedSha !== '' && expectedSha !== draft.sha256)
    throw new PromoteError('draft_changed', `The draft changed since you read it (sha256 is now ${draft.sha256}); read it again.`, 409)
  const target = resolveTarget(db, p, folder)
  const bytes = blobs.get(draft.sha256)
  if (sha256(bytes) !== draft.sha256) throw new PromoteError('draft_changed', 'the stored draft does not match its hash', 500)
  checkContent(bytes)
  // managed storage keeps every earlier version, so a promote may replace a file there (asked for explicitly);
  // on a NAS (in place) it never does: the file there has no earlier version this server could give back
  const managed = inManaged(managedMountIds(db), target.node)
  let replace = false
  if (nameTaken(target.node.real, n)) {
    if (overwrite !== true || !managed) throw managed ? new PromoteError('exists', `${target.vpath}/${n} already exists. Pass overwrite: true to replace it (the current file is kept as an earlier version), or choose another name.`, 409) : exists(n, target.vpath)
    existingFile(p.access, target.node, n)
    replace = true
  }
  const src = [...draft.src.keys()]
  // overwriting a shared file (A2 W1): its readers are the folder's plus the people it is shared with
  const uid = replace ? fileUidAt(db, target.node.real, n) : null
  const widening = src.length > 0 && isWidening(db, src, target.folderId, uid)
  return widening ? { kind: 'approval', target, bytes, draft, name: n, gain: readerGain(db, src, target.folderId, uid), overwrite: replace } : { kind: 'write', target, bytes, draft, name: n, overwrite: replace }
}

/** Right before writing: the draft is still at the version planned (base-hash check). */
export function checkBase(db: DB, draftId: number, sha: string) {
  const l = latest(db, draftId)
  if (!l || l.deleted_at != null || l.sha256 !== sha) throw new PromoteError('draft_changed', 'The draft changed (or was deleted) while promoting; nothing was written. Read it again.', 409)
}

/** The visible file a replace would overwrite (a folder or a closed entry of that name is never replaced). */
function existingFile(access: Access, node: Node, name: string): FileEntry {
  const there = mTaken(node.real, name)
  const e = there ? access.child(node, there) : null
  if (!e || e.kind !== 'file') throw new PromoteError('exists', `${node.vpath}/${name} exists and is not a file that can be replaced`, 409)
  return e
}

/** Write a non-widening plan now. Returns the placement; the caller records it (recordPromotion) with its audit row. */
export function executeWrite(db: DB, plan: Extract<Plan, { kind: 'write' }>, access?: Access): Placed {
  checkBase(db, plan.draft.id, plan.draft.sha256)
  return place(db, plan.target.node, plan.name, plan.bytes, plan.overwrite, access ?? new Access(db, { personId: -1 }))
}

/** Into managed storage through its staging (new file, or a replace that keeps the old bytes); elsewhere a new file. */
function place(db: DB, node: Node, name: string, bytes: Uint8Array, overwrite: boolean, access: Access): Placed {
  if (!inManaged(managedMountIds(db), node)) return placeNewFile(node, name, bytes)
  const root = path.dirname(node.rows[0]!.path) // a managed team folder is a directory right in the managed root (folders.ts)
  const staged = stageBytes(root, bytes)
  let mp: ManagedPlaced
  try {
    if (overwrite) mp = placeReplace(root, node, existingFile(access, node, name), staged)
    else {
      if (mTaken(node.real, name)) throw exists(name, node.vpath)
      mp = placeNew(node, name, staged)
    }
  } catch (e) {
    dropStaged(staged)
    if (e instanceof ManagedError) throw new PromoteError(e.code, e.message, e.status)
    throw e
  }
  return { real: mp.real, dev: mp.dev, ino: mp.ino, managed: { placed: mp, keep: versionsKept(db) } }
}

/** After the commit: drop version bytes no row needs, and fill the text mirror for the new content. */
export function afterPromote(ctx: { db: DB; mirror: Mirror }, p: Placed) {
  if (!p.managed) return
  const dropped = gcLater.get(p.managed.placed)
  if (dropped?.length) gcBlobs(ctx.db, rootOf(ctx.db, p.managed.placed.real), dropped)
  indexLater(ctx, p.managed.placed)
}
const gcLater = new WeakMap<ManagedPlaced, string[]>()
/** The managed root holding a file (the parent of its team folder). */
function rootOf(db: DB, real: string): string {
  const mount = db.query<{ path: string }, []>('SELECT f.path FROM managed_mounts m JOIN folders f ON f.id = m.folder_id').all()
    .find((r) => real.startsWith(r.path + '/'))
  return mount ? path.dirname(mount.path) : path.dirname(path.dirname(real))
}

export interface ApprovalRow {
  id: number; created_at: number; expires_at: number; status: string; draft_id: number; draft_version: number; sha256: string; size: number
  draft_path: string; requester_person_id: number; requester_token_id: number | null; target_folder_id: number; target_vpath: string
  name: string; reason: string | null; src: string; gain: number; decided_at: number | null; decided_by: number | null
  decision_reason: string | null; promotion_id: number | null; overwrite?: number
  /** null = a draft promote; 'share' = a sharing change (payload = the change as JSON) */
  kind?: string | null; payload?: string | null
}

export const approvalById = (db: DB, id: number) => { ensurePromoteSchema(db); return db.query<ApprovalRow, [number]>('SELECT * FROM approvals WHERE id = ?').get(id) }

/**
 * Inside the caller's transaction: a pending request (or the same one again, when this draft version, target and name
 * already wait). Closed at once when nobody could approve it (R8: no stand-in approver).
 */
export function createApproval(db: DB, plan: Extract<Plan, { kind: 'approval' }>, p: Promoter, reason: unknown, now: number): { id: number; status: 'pending' | 'closed'; again: boolean } {
  ensurePromoteSchema(db)
  const same = db.query<{ id: number; status: string }, [number, string, number, string]>(
    "SELECT id, status FROM approvals WHERE draft_id = ? AND sha256 = ? AND target_folder_id = ? AND name = ? AND status = 'pending'").get(plan.draft.id, plan.draft.sha256, plan.target.folderId, plan.name)
  if (same) return { id: same.id, status: 'pending', again: true }
  const waiting = db.query<{ n: number }, [number]>("SELECT count(*) AS n FROM approvals WHERE requester_person_id = ? AND status = 'pending'").get(p.personId)!.n
  if (waiting >= MAX_PENDING_PER_PERSON) throw new PromoteError('too_many_pending', `You already have ${waiting} promote requests waiting; wait for them or cancel some on the web.`, 429)
  const why = typeof reason === 'string' ? reason.slice(0, REASON_MAX) : null
  const src = JSON.stringify([...plan.draft.src].map(([id, strong]) => [id, strong ? 1 : 0]))
  const id = Number(db.query(`INSERT INTO approvals (created_at, expires_at, status, draft_id, draft_version, sha256, size, draft_path, requester_person_id, requester_token_id,
      target_folder_id, target_vpath, name, reason, src, gain, overwrite) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(now, now + APPROVAL_TTL_MS, plan.draft.id, plan.draft.version, plan.draft.sha256, plan.draft.size, plan.draft.path, p.personId, p.tokenId,
      plan.target.folderId, plan.target.vpath, plan.name, why, src, plan.gain.length, plan.overwrite ? 1 : 0).lastInsertRowid)
  const a = approvalById(db, id)!
  if (!eligibleApprovers(db, a).length) {
    db.query("UPDATE approvals SET status = 'closed', decided_at = ?, decision_reason = 'no one can approve' WHERE id = ?").run(now, id)
    return { id, status: 'closed', again: false }
  }
  return { id, status: 'pending', again: false }
}

// ---------- R8 eligibility ----------
/** Src(d) for a request: the sources recorded at request time plus any the draft has gained since (Src only grows). */
export function approvalSources(db: DB, a: ApprovalRow): number[] {
  const s = new Set((JSON.parse(a.src) as [number, number][]).map(([id]) => id))
  for (const r of db.query<{ folder_id: number }, [number]>('SELECT folder_id FROM draft_src WHERE draft_id = ?').all(a.draft_id)) s.add(r.folder_id)
  return [...s]
}

export interface Eligibility { eligible: boolean; via: 'target' | 'sources' | null; why: string | null }

/**
 * R8, judged now: A is a person (an active one with a web account — never a token) who can read every source S of the
 * draft by rule with no flag on S or above (agents' R1 ①–③: "No AI", quarantine, widened-pending all count), and who
 * manages the target folder or every source. Approving one's own request needs the second way.
 */
export function approverStatus(db: DB, a: ApprovalRow, personId: number, rights = new Rights(db), src = approvalSources(db, a)): Eligibility {
  ensurePromoteSchema(db)
  if (a.kind === 'share') return shareApproverStatus(db, a, personId, rights)
  const p = db.query<{ active: number }, [number]>('SELECT p.active FROM people p JOIN accounts a ON a.person_id = p.id WHERE p.id = ?').get(personId)
  if (!p || !p.active) return { eligible: false, via: null, why: 'not an active person with a sign-in' }
  const access = new Access(db, { personId })
  if (!src.length || !src.every((s) => access.canReadFolder(s))) return { eligible: false, via: null, why: 'cannot read every source folder' }
  const f = (id: number) => rights.folders.get(id)
  const target = f(a.target_folder_id)
  const allSources = src.every((s) => { const r = f(s); return !!r && rights.manages(personId, r) })
  if (allSources) return { eligible: true, via: 'sources', why: null }
  if (personId === a.requester_person_id) return { eligible: false, via: null, why: 'your own request: only someone who manages every source folder approves their own' }
  if (target && rights.manages(personId, target)) return { eligible: true, via: 'target', why: null }
  return { eligible: false, via: null, why: 'manages neither the target folder nor every source folder' }
}

export function eligibleApprovers(db: DB, a: ApprovalRow): number[] {
  const rights = new Rights(db)
  const src = approvalSources(db, a)
  const people = db.query<{ id: number }, []>('SELECT p.id FROM people p JOIN accounts a ON a.person_id = p.id WHERE p.active = 1').all()
  return people.map((x) => x.id).filter((id) => approverStatus(db, a, id, rights, src).eligible)
}

/** Managers (target or any source) who cannot approve: they hear "1 pending" and a link, nothing else (R11). */
export function countOnlyManagers(db: DB, a: ApprovalRow, eligible = eligibleApprovers(db, a)): number[] {
  const rights = new Rights(db)
  const out = new Set<number>()
  for (const id of [a.target_folder_id, ...approvalSources(db, a)]) {
    const f = rights.folders.get(id)
    if (f) for (const m of rights.managersOf(f)) out.add(m)
  }
  for (const e of eligible) out.delete(e)
  return [...out].filter((id) => !!db.query('SELECT 1 FROM people WHERE id = ? AND active = 1').get(id))
}

/** Lazy expiry (7 days). */
export function expireApprovals(db: DB, now = Date.now()) {
  ensurePromoteSchema(db)
  db.query("UPDATE approvals SET status = 'expired', decided_at = ? WHERE status = 'pending' AND expires_at <= ?").run(now, now)
}

// ---------- decisions ----------
function pendingOr(db: DB, id: number, now: number): ApprovalRow {
  expireApprovals(db, now)
  const a = approvalById(db, id)
  if (!a) throw new PromoteError('not_found', 'not found', 404)
  if (a.status !== 'pending') throw new PromoteError('not_pending', `this request is ${a.status}`, 409)
  return a
}

export interface ApproveResult { approval: ApprovalRow; promotionId: number; vpath: string; placed: Placed }

/**
 * Approve (the caller has checked the session and consumed a step-up minted for this approval and hash). Everything
 * is judged again now: R8 for the approver, the draft still at the requested version, the target still there, still
 * open for promote, the requester still with `write` on it, the name still free. Writes exactly the stored bytes.
 */
export function approve(db: DB, blobs: Blobs, id: number, approverId: number, sha: unknown, now = Date.now()): ApproveResult {
  const a = pendingOr(db, id, now)
  if (sha !== a.sha256) throw new PromoteError('hash_mismatch', 'this approval is for another version of the draft; reload the page', 409)
  const el = approverStatus(db, a, approverId)
  if (!el.eligible) throw new PromoteError('not_eligible', `you cannot approve this request (${el.why})`, 403)
  if (a.kind === 'share') {
    const { vpath } = applyShareApproval(db, a, approverId, now)
    return { approval: approvalById(db, a.id)!, promotionId: 0, vpath, placed: { real: '', dev: '', ino: '' } }
  }
  const l = latest(db, a.draft_id)
  if (!l || l.deleted_at != null || l.sha256 !== a.sha256) {
    db.query("UPDATE approvals SET status = 'stale', decided_at = ?, decided_by = ?, decision_reason = 'the draft changed after the request' WHERE id = ?").run(now, approverId, a.id)
    throw new PromoteError('draft_changed', 'the draft changed (or was deleted) after this request; the request is closed — ask for a new one', 409)
  }
  const server = new Access(db, { personId: -1 })
  const node = server.nodeForFolder(a.target_folder_id)
  if (!node) throw new PromoteError('target_changed', 'the target folder is gone or moved', 409)
  if (node.rows.some((r) => r.quarantine || r.widened_pending)) throw new PromoteError('target_closed', 'the target folder is quarantined', 409)
  if (!promoteOn(promoteFolderIds(db), node.rows)) throw new PromoteError('promote_off', 'promote was turned off for the target folder', 409)
  if (new Access(db, { personId: a.requester_person_id }).level(node) < 2) throw new PromoteError('no_write', 'the requester no longer has write on the target folder', 409)
  const bytes = blobs.get(a.sha256)
  if (sha256(bytes) !== a.sha256) throw new PromoteError('blob', 'the stored draft bytes do not match their hash', 500)
  checkContent(bytes)
  const draft = db.query<{ token_id: number; person_id: number }, [number]>('SELECT token_id, person_id FROM drafts WHERE id = ?').get(a.draft_id)!
  const widening = isWidening(db, approvalSources(db, a), a.target_folder_id, a.overwrite ? fileUidAt(db, node.real, a.name) : null)
  let placed: Placed
  try { placed = place(db, node, a.name, bytes, !!a.overwrite && !!nameTakenSafe(node.real, a.name), server) } catch (e) {
    if (e instanceof PromoteError && e.code === 'exists') db.query("UPDATE approvals SET status = 'failed', decided_at = ?, decided_by = ?, decision_reason = 'a file with that name exists now' WHERE id = ?").run(now, approverId, a.id)
    throw e
  }
  const vpath = `${node.vpath}/${a.name}`
  let promotionId = 0
  try {
    db.transaction(() => {
      const r = db.query("UPDATE approvals SET status = 'approved', decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'").run(now, approverId, a.id)
      if (r.changes !== 1) throw new PromoteError('not_pending', 'this request was decided meanwhile', 409)
      promotionId = recordPromotion(db, { draft: { id: a.draft_id, version: a.draft_version, sha256: a.sha256, size: a.size, token_id: draft.token_id, person_id: draft.person_id },
        byPerson: approverId, tokenId: null, targetId: a.target_folder_id, vpath, placed, widening, approvalId: a.id, now })
      db.query('UPDATE approvals SET promotion_id = ? WHERE id = ?').run(promotionId, a.id)
      appendAudit(db, { personId: approverId, tokenId: null, tool: 'web', outcome: 'ok', files: [vpath],
        command: `approve promote #${a.id}: draft v${a.draft_version} (sha256 ${a.sha256}) -> ${vpath} (${placed.managed?.placed.replaced ? 'new version' : 'new file'}${widening ? ', widening' : ''})` })
    })()
  } catch (e) { unplace(placed); throw e }
  return { approval: approvalById(db, a.id)!, promotionId, vpath, placed }
}

/** Reject (an eligible approver, with a reason) or cancel (the requester). Narrows nothing, writes nothing. */
export function reject(db: DB, id: number, personId: number, reason: unknown, now = Date.now()): ApprovalRow {
  const a = pendingOr(db, id, now)
  const own = a.requester_person_id === personId
  if (!own && !approverStatus(db, a, personId).eligible) throw new PromoteError('not_found', 'not found', 404)
  const why = typeof reason === 'string' ? reason.trim().slice(0, REASON_MAX) : ''
  if (!own && !why) throw new PromoteError('reason_required', 'say why you reject it (the requester sees this)')
  db.transaction(() => {
    db.query('UPDATE approvals SET status = ?, decided_at = ?, decided_by = ?, decision_reason = ? WHERE id = ?').run(own ? 'cancelled' : 'rejected', now, personId, why || null, a.id)
    appendAudit(db, { personId, tokenId: null, tool: 'web', outcome: 'ok', files: [], command: `${own ? 'cancel' : 'reject'} ${a.kind === 'share' ? 'share' : 'promote'} #${a.id}` })
  })()
  return approvalById(db, a.id)!
}

// ---------- what a person sees (R8 "the one exception" of R4, R11) ----------
const nameOf = (db: DB, id: number | null) => id == null ? null : db.query<{ name: string }, [number]>('SELECT name FROM people WHERE id = ?').get(id)?.name ?? '?'
const tokenName = (db: DB, id: number | null) => id == null ? null : db.query<{ name: string }, [number]>('SELECT name FROM tokens WHERE id = ?').get(id)?.name ?? '?'

/** The list for one person: requests they may decide or made, plus a bare count of others pending in folders they manage. */
export function approvalsFor(db: DB, personId: number, now = Date.now()) {
  expireApprovals(db, now)
  const rights = new Rights(db)
  const rows = db.query<ApprovalRow, []>('SELECT * FROM approvals ORDER BY id DESC LIMIT 500').all()
  const items: ReturnType<typeof summary>[] = []
  let countOnly = 0
  for (const a of rows) {
    const mine = a.requester_person_id === personId
    const decidedByMe = a.decided_by === personId
    const el = a.status === 'pending' ? approverStatus(db, a, personId, rights) : { eligible: false, via: null, why: null }
    if (mine || decidedByMe || el.eligible) { items.push(summary(db, a, el.eligible, mine)); continue }
    if (a.status === 'pending' && countOnlyManagers(db, a).includes(personId)) countOnly++
  }
  return { items, others_pending: countOnly }
}

function summary(db: DB, a: ApprovalRow, canDecide: boolean, mine: boolean) {
  return {
    id: a.id, kind: a.kind === 'share' ? 'share' as const : 'promote' as const, status: a.status, created_at: a.created_at, expires_at: a.expires_at, decided_at: a.decided_at,
    target: a.target_vpath, name: a.name, size: a.size, gain: a.gain, can_decide: canDecide, mine, overwrite: !!a.overwrite,
    requester: nameOf(db, a.requester_person_id), via: a.requester_token_id != null ? 'agent' : 'web',
  }
}

/** How many requests this person can decide right now (the nav badge). */
export function decidableCount(db: DB, personId: number, now = Date.now()): number {
  expireApprovals(db, now)
  const rights = new Rights(db)
  return db.query<ApprovalRow, []>("SELECT * FROM approvals WHERE status = 'pending'").all().filter((a) => approverStatus(db, a, personId, rights).eligible).length
}

/** Text shown to an approver: the draft as plain text (never HTML), and a diff against nothing (a new file). */
export function previewOf(bytes: Uint8Array) {
  const cut = bytes.length > PREVIEW_BYTES
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, PREVIEW_BYTES))
  return { text, truncated: cut, binary: bytes.subarray(0, 8000).includes(0) }
}
export function diffAgainstNothing(text: string, label: string): string {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return `--- /dev/null\n+++ ${label}\n@@ -0,0 +1,${lines.length} @@\n` + lines.map((l) => '+' + l).join('\n')
}

/**
 * One request in full, for someone who may decide it now (R8): sources named (they can read them all), who gains
 * access (count and names), provenance, the agent's stated reason (labelled as its claim), the text. The requester
 * sees their own request without names of other people. Anyone else: not found.
 */
export function approvalDetail(db: DB, blobs: Blobs, id: number, personId: number, now = Date.now()) {
  expireApprovals(db, now)
  const a = approvalById(db, id)
  if (!a) throw new PromoteError('not_found', 'not found', 404)
  const el = a.status === 'pending' ? approverStatus(db, a, personId) : { eligible: false, via: null, why: null }
  const mine = a.requester_person_id === personId
  if (!el.eligible && !mine && a.decided_by !== personId) throw new PromoteError('not_found', 'not found', 404)
  if (a.kind === 'share') return { ...summary(db, a, el.eligible, mine), sha256: a.sha256, decided_by: nameOf(db, a.decided_by), decision_reason: a.decision_reason,
    approvers_exist: a.status === 'pending' ? eligibleApprovers(db, a).length > 0 : null, via_eligibility: el.via, ...shareApprovalDetail(db, a, personId, el.eligible) }
  const src = approvalSources(db, a)
  const access = new Access(db, { personId })
  const base = {
    ...summary(db, a, el.eligible, mine), sha256: a.sha256, draft_version: a.draft_version, draft_path: a.draft_path,
    decided_by: nameOf(db, a.decided_by), decision_reason: a.decision_reason,
    approvers_exist: a.status === 'pending' ? eligibleApprovers(db, a).length > 0 : null,
  }
  if (!el.eligible) {
    // the requester (or the person who decided it): their own view, people's names withheld
    const s = sourcesFor(Access.forPerson(db, personId), new Map(src.map((x) => [x, true])))
    return { ...base, sources: s.shown.map((x) => x.folder), hidden_sources: s.hidden, gainers: null, preview: null, diff: null, agent_claim: mine ? a.reason : null, via_eligibility: null }
  }
  const s = sourcesFor(access, new Map((JSON.parse(a.src) as [number, number][]).map(([id, strong]) => [id, !!strong])))
  const extra = src.filter((x) => !(JSON.parse(a.src) as [number, number][]).some(([id]) => id === x))
  const tnode = a.overwrite ? new Access(db, { personId: -1 }).nodeForFolder(a.target_folder_id) : null
  const uid = tnode ? fileUidAt(db, tnode.real, a.name) : null
  const gain = readerGain(db, src, a.target_folder_id, uid)
  const pv = previewOf(blobs.get(a.sha256))
  return {
    ...base,
    sources: s.shown.map((x) => ({ folder: x.folder, strong: x.strong })), hidden_sources: s.hidden + extra.length,
    gainers: { count: gain.length, names: gain.map((g) => nameOf(db, g)!).sort() },
    widening_now: isWidening(db, src, a.target_folder_id, uid),
    requester_token: tokenName(db, a.requester_token_id),
    agent_claim: a.reason,
    preview: pv, diff: pv.binary ? null : diffAgainstNothing(pv.text, `${a.target_vpath}/${a.name}`),
    via_eligibility: el.via,
  }
}
