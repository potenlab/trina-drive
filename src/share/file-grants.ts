// File-level sharing in managed storage (Trina Cloud v1, workstream A2; design memo a2-file-sharing-design.md).
//
// A file in a team folder can be shared with a person or a group as Viewer or Editor, or with the whole team (General
// access = a grant to the Everyone group). The policy (src/policy.ts R0′/R1′) gives level(P, f) = max(folder rule,
// file share) — never in a personal folder, never on in-place (NAS) folders — and shows the folders above the file as
// bare paths (names only). A grant names the file by `mfiles.uid` (random, never reused) and opens only the file the
// walk reaches with the row's dev/ino/size/mtime; its remembered location (`mfiles.folder_id/name`) only finds it.
//
// Who may change a file's sharing (memo §5, owner decision O1):
//   admin, manager of F    everything for files (Viewer/Editor, General access, removing grants, confirming a widening)
//   folder Editor of F,    where "Editors can change permissions and share" is on (F and above): Viewer/Editor,
//   file Editor (FG = 2)   removing direct grants, General access (opening it to the team needs a step-up); never a
//                          widening, never inviting. A file-only Editor sees direct entries only.
//   anyone who sees it     `leave` (remove their own person grant)
//   agents                 never: /api reads no Bearer token (S43), MCP has no sharing tool, WebDAV has no ACL.
// The actor must see the file through their own Access.forPerson (else 404, exactly like a missing path) — admins too.
// Every change is one transaction with one audit row per change; R6 (W2): adding readers to a file that is an AI-draft
// copy, where some new reader cannot read some source, is a widening (409; managers and admins confirm).
import type { DB } from '../db'
import { inManaged, managedMountIds, fileRowOf, dropRow, newUid, openEntry, hashFd } from '../managed/core'
import { splitVirtual } from '../names'
import { Access, fileGrantees, readersSource, readersTarget, type FileEntry } from '../policy'
import { Rights, type Actor } from '../rights'
import { ensureFolder, type FolderRow } from '../store'
import { ApiError, bad, json, notFound, type WebCtx } from '../web/http'
import { folderLink, now, record, tell, type Op } from '../web/op-common'
import { consumeStepUp } from '../web/mfa'
import fs from 'node:fs'
import type { FileShareEntry, FileShareView, FileSharedItem } from './api-types'
import { inviteHandler } from './invite'
import { recordShareInvite } from './invites'
import { applyJudgement, locateCopies, type Judgement, type Snapshot } from './rejudge'
import type { WidenedRow } from '../inplace/widened'

export const FILE_GRANTS_MAX = 200
const LEVEL = { viewer: 1, editor: 2 } as const
const roleOf = (level: number): 'viewer' | 'editor' | null => level >= 2 ? 'editor' : level >= 1 ? 'viewer' : null
const roleName = (level: number) => roleOf(level) ?? 'none'
const err = (status: number, code: string, message: string) => new ApiError(status, code, message)

export type FileKind = 'admin' | 'manager' | 'editor' | 'file_editor' | 'none'

// ---------- finding the file (hidden == nonexistent) ----------
export interface FileItem {
  e: FileEntry; access: Access; r: Rights; vpath: string; name: string
  /** the parent folder's row (made here if it had none: grants keep their location by it) */
  F: FolderRow
  managed: boolean; personal: boolean
}

/** The file at `vpath` as this person sees it, or null when the path is not a file they can see (a folder, or 404). */
export function fileAt(w: WebCtx, a: Actor, vpath: unknown): FileItem | null {
  if (typeof vpath !== 'string' || vpath.length > 4096 || vpath.includes('\0')) return null
  const parts = splitVirtual(vpath)
  if (parts.length < 2) return null
  const access = Access.forPerson(w.db, a.personId)
  const e = access.lookup(parts)
  if (!e || e.kind !== 'file') return null
  const p = e.parent
  const id = ensureFolder(w.db, p.real, p.dev, p.ino, p.birth)
  const r = new Rights(w.db)
  return { e, access, r, vpath: e.vpath, name: e.vpath.slice(e.vpath.lastIndexOf('/') + 1), F: r.folders.get(id)!,
    managed: inManaged(managedMountIds(w.db), p), personal: p.rows.some((x) => x.personal_owner != null) }
}

/** Is `vpath` a file this person sees? (the share routes' dispatcher: files here, folders in ./service.ts) */
export const isVisibleFile = (w: WebCtx, a: Actor, vpath: unknown) => {
  if (typeof vpath !== 'string' || vpath.length > 4096 || vpath.includes('\0')) return false
  const parts = splitVirtual(vpath)
  return parts.length >= 2 && Access.forPerson(w.db, a.personId).lookup(parts)?.kind === 'file'
}

export function fileKind(it: FileItem, a: Actor): FileKind {
  const { r, F } = it
  if (!it.managed || it.personal || !r.top(F) || r.personal(F)) return 'none'
  if (a.admin) return 'admin'
  if (r.manages(a.personId, F)) return 'manager'
  const toggle = r.editorsCanShare(F) && !r.closedForPeople(F)
  if (!toggle) return 'none'
  if (it.access.level(it.e.parent) >= 2) return 'editor'
  if (it.access.fileLevel(it.e) >= 2) return 'file_editor'
  return 'none'
}

// ---------- grants ----------
export interface GrantRow { file_uid: string; subject_type: 'person' | 'group'; subject_id: number; subject_uid: string | null; level: number; granted_by: number | null; granted_at: number }

/** The file's row as it is on disk now (same identity, size, mtime), or undefined (a file the server does not track yet). */
const rowOf = (db: DB, e: FileEntry) => fileRowOf(db, e)

/** Live grants of a file (group grants only while the group is the one they were made for). */
export function grantsOf(db: DB, uid: string): GrantRow[] {
  return db.query<GrantRow, [string]>(`SELECT g.* FROM file_grants g WHERE g.file_uid = ? AND (g.subject_type = 'person'
    OR EXISTS (SELECT 1 FROM groups x WHERE x.id = g.subject_id AND x.uid = g.subject_uid)) ORDER BY g.granted_at`).all(uid)
}

const groupUid = (db: DB, id: number): string => {
  db.query('UPDATE groups SET uid = ? WHERE id = ? AND uid IS NULL').run(newUid(), id)
  return db.query<{ uid: string }, [number]>('SELECT uid FROM groups WHERE id = ?').get(id)!.uid
}

/**
 * The file's tracked row with a uid, made now if the server did not write it (a file put there by hand gets a row, as
 * rescan would give it). Hashing happens before the caller's transaction; the row is written inside it.
 */
function prepareRow(db: DB, e: FileEntry): () => { id: number; uid: string } {
  const have = rowOf(db, e)
  let h: { sha256: string } | null = null
  if (!have) {
    let fd: number
    try { fd = openEntry(e) } catch { throw notFound() }
    try { h = hashFd(fd) } finally { fs.closeSync(fd) }
  }
  return () => {
    const row = rowOf(db, e)
    if (row) {
      if (row.uid == null) db.query('UPDATE mfiles SET uid = ? WHERE id = ? AND uid IS NULL').run(newUid(), row.id)
      return { id: row.id, uid: db.query<{ uid: string }, [number]>('SELECT uid FROM mfiles WHERE id = ?').get(row.id)!.uid }
    }
    if (!h) throw notFound()
    dropRow(db, String(e.dev), String(e.ino))
    const t = now()
    const uid = newUid()
    const id = Number(db.query('INSERT INTO mfiles (dev, ino, size, mtime_ns, sha256, version, created_at, created_by, updated_at, updated_by, uid) VALUES (?, ?, ?, ?, ?, 1, ?, NULL, ?, NULL, ?)')
      .run(String(e.dev), String(e.ino), e.size, String(e.mtimeNs), h.sha256, t, t, uid).lastInsertRowid)
    return { id, uid }
  }
}

// ---------- the view (GET /api/share?path=<file>) ----------
const personName = (db: DB, id: number) => db.query<{ name: string }, [number]>('SELECT name FROM people WHERE id = ?').get(id)?.name ?? '?'
const groupInfo = (db: DB, id: number) => db.query<{ name: string; n: number }, [number]>(
  'SELECT g.name, (SELECT count(*) FROM memberships m JOIN people p ON p.id = m.person_id WHERE m.group_id = g.id AND p.active = 1) AS n FROM groups g WHERE g.id = ?').get(id)
const emailOf = (db: DB, id: number) => {
  try { return db.query<{ email: string | null }, [number]>('SELECT email FROM accounts WHERE person_id = ?').get(id)?.email ?? undefined } catch { return undefined }
}

/** The Everyone group's id without creating it (reads never write). */
function everyoneId(db: DB): number | null {
  let v: string | undefined
  try { v = db.query<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?').get('everyone_group')?.value } catch {}
  if (v && db.query('SELECT 1 FROM groups WHERE id = ?').get(Number(v))) return Number(v)
  return db.query<{ id: number }, []>(`SELECT id FROM groups WHERE name IN ('everyone', '전체', '전원') ORDER BY id LIMIT 1`).get()?.id ?? null
}

export interface FileShareDeps {
  /** A1's folder entries (src/share/service.ts entriesOf), shown as "inherited" to people who read the folder */
  folderEntries: (db: DB, r: Rights, f: FolderRow, a: Actor) => { subject: { type: 'person' | 'group'; id: number; name: string; email?: string; members?: number }; role: 'viewer' | 'editor' | 'manager'; source: string; from_path?: string }[]
}

export function fileShareView(w: WebCtx, a: Actor, it: FileItem, deps: FileShareDeps): FileShareView {
  const db = w.db
  const item = { path: it.vpath, kind: 'file' as const, name: it.name }
  if (!it.managed) return { mode: 'inplace', item } as FileShareView
  const lf = it.access.levelOfFile(it.e)
  if (it.personal) return { mode: 'personal', item, my_role: roleOf(lf), can_manage: false, entries: [], general: null } as FileShareView
  const { r, F } = it
  const kind = fileKind(it, a)
  const myRole: FileShareView['my_role'] = r.manages(a.personId, F) ? 'manager' : roleOf(lf) ?? (a.admin ? 'admin' : null)
  if (kind === 'none') return { mode: 'managed', item, my_role: myRole, can_manage: false, entries: [], general: null } as FileShareView
  const E = everyoneId(db)
  const row = rowOf(db, it.e)
  const grants = row?.uid ? grantsOf(db, row.uid) : []
  const readsFolder = a.admin || it.access.canRead(it.e.parent)
  const fvp = r.vpath(F) ?? it.vpath.slice(0, it.vpath.lastIndexOf('/'))
  const sharer = true
  const entries = new Map<string, FileShareEntry>()
  for (const g of grants) {
    if (g.subject_type === 'group' && g.subject_id === E) continue
    if (g.subject_type === 'person' && !db.query('SELECT 1 FROM people WHERE id = ? AND active = 1').get(g.subject_id)) continue
    const gi = g.subject_type === 'group' ? groupInfo(db, g.subject_id) : null
    if (g.subject_type === 'group' && !gi) continue
    entries.set(`${g.subject_type}:${g.subject_id}`, {
      subject: { type: g.subject_type, id: g.subject_id, name: gi ? gi.name : personName(db, g.subject_id), ...(gi ? { members: gi.n } : {}),
        ...(g.subject_type === 'person' ? { email: a.admin ? emailOf(db, g.subject_id) ?? null : null } : {}) },
      role: roleOf(g.level)!, source: 'direct',
      granted_by: g.granted_by == null ? null : { id: g.granted_by, name: personName(db, g.granted_by) }, granted_at: g.granted_at, editable: sharer,
    })
  }
  if (readsFolder) {
    for (const x of deps.folderEntries(db, r, F, a)) {
      const k = `${x.subject.type}:${x.subject.id}`
      const d = entries.get(k)
      if (d) { d.inherited_role = x.role; continue }
      entries.set(k, { subject: { ...x.subject }, role: x.role, source: 'inherited', from_path: x.from_path ?? fvp, editable: false })
    }
  }
  const order = { manager: 0, editor: 1, viewer: 2 }
  const own = E == null ? 0 : grants.find((g) => g.subject_type === 'group' && g.subject_id === E)?.level ?? 0
  const above = E == null ? { level: 0, from: null } : r.subjectLevel('group', E, F)
  const fromVp = (id: number | null) => { const x = id == null ? undefined : r.folders.get(id); return (x && r.vpath(x)) || fvp }
  const eff = Math.max(own, above.level)
  const chain = r.chain(F)
  const offFrom = chain.find((x) => (x as FolderRow & { editors_can_share?: number | null }).editors_can_share === 0)
  const noAiRow = chain.find((x) => x.no_ai)
  return {
    mode: 'managed', item, my_role: myRole,
    can_manage: true, manage_as: kind === 'file_editor' ? 'editor' : kind,
    can_grant_manager: false, can_invite: kind === 'admin' && !!inviteHandler(db), can_confirm_widening: kind === 'admin' || kind === 'manager', can_ai_off: false,
    editors_can_share: { effective: r.editorsCanShare(F), from_path: offFrom ? r.vpath(offFrom) : null },
    general: {
      effective: eff > 0 ? { role: roleOf(eff)!, from_path: own >= above.level && own > 0 ? it.vpath : fromVp(above.from) } : null,
      own: roleOf(own), can_restrict: above.level === 0, editor_step_up: kind === 'editor' || kind === 'file_editor',
    },
    entries: [...entries.values()].sort((x, y) => order[x.role] - order[y.role] || x.subject.type.localeCompare(y.subject.type) || x.subject.name.localeCompare(y.subject.name)),
    inherited: readsFolder ? 'shown' : 'hidden',
    ai: { no_ai: !!noAiRow, inherited_no_ai_from: noAiRow ? r.vpath(noAiRow) : null },
    path_names_visible: fvp,
    warnings: copiesOfFile(db, it.e).length ? [{ code: 'draft_copy' }] : [],
  }
}

// ---------- R6 (W2): a file that is an AI-draft copy ----------
const LIVE = "status IN ('tracked', 'confirmed')"
function copiesOfFile(db: DB, e: FileEntry): WidenedRow[] {
  return db.query<WidenedRow, [string, string]>(`SELECT * FROM widened WHERE ${LIVE} AND dev = ? AND ino = ?`).all(String(e.dev), String(e.ino))
}
const sourcesOf = (db: DB, draftId: number) =>
  db.query<{ folder_id: number }, [number]>('SELECT folder_id FROM draft_src WHERE draft_id = ?').all(draftId).map((r) => r.folder_id)

/** Readers of the file before and after a change of its grants: who gains it without reading some draft source. */
function judgeCopies(db: DB, e: FileEntry, F: FolderRow, before: Set<number>, after: Set<number>): { snap: Snapshot; j: Judgement } {
  const snap: Snapshot = new Map()
  const j: Judgement = { copies: [], people: new Set(), sources: new Set(), pending: [], confirmed: [] }
  const gainedAll = [...after].filter((u) => !before.has(u))
  if (!gainedAll.length) return { snap, j }
  const copies = copiesOfFile(db, e)
  if (!copies.length) return { snap, j }
  const located = locateCopies(db, copies)
  for (const w of copies) {
    const src = sourcesOf(db, w.draft_id)
    if (!src.length) continue
    const gained = new Set<number>()
    for (const s of src) {
      // the file's folder as a source too: the people gaining the file through a share do not read it
      const rs = readersSource(db, s)
      for (const u of gainedAll) if (!rs.has(u)) gained.add(u)
    }
    if (!gained.size) continue
    const l = located.get(w.id)
    snap.set(w.id, { w, real: l?.real ?? e.real, folderId: l?.folderId ?? F.id, src, excess: new Set(), readers: before })
    j.copies.push({ id: w.id, folderId: l?.folderId ?? F.id, sources: src, gained: [...gained] })
    gained.forEach((u) => j.people.add(u))
    src.forEach((s) => j.sources.add(s))
  }
  return { snap, j }
}

// ---------- changing (POST /api/share with a file path) ----------
type FStep = { type: 'person' | 'group'; id: number; name: string; level: number; prev: number }

const isRef = (x: unknown): x is { type: 'person' | 'group'; id: number } =>
  !!x && typeof x === 'object' && ((x as { type?: unknown }).type === 'person' || (x as { type?: unknown }).type === 'group') && Number.isSafeInteger((x as { id?: unknown }).id)

function subjectOf(db: DB, ref: { type: 'person' | 'group'; id: number }): { type: 'person' | 'group'; id: number; name: string } {
  if (ref.type === 'person') {
    const p = db.query<{ id: number; name: string; active: number }, [number]>('SELECT id, name, active FROM people WHERE id = ?').get(ref.id)
    if (!p) throw bad('unknown_subject', 'no such person')
    if (!p.active) throw bad('not_a_member', `${p.name} is not active in this team`)
    return { type: 'person', id: p.id, name: p.name }
  }
  const g = db.query<{ id: number; name: string }, [number]>('SELECT id, name FROM groups WHERE id = ?').get(ref.id)
  if (!g) throw bad('unknown_subject', 'no such group')
  return { type: 'group', id: g.id, name: g.name }
}

/** What a step-up for a file binds to (the share dialog's passkey for "Anyone in Trina"). */
export const fileStepKey = (db: DB, e: FileEntry) => `file:${rowOf(db, e)?.uid ?? `${e.dev}:${e.ino}`}`

export interface FileChangeDeps extends FileShareDeps {
  /** A1's step-up binding check: consumes the assertion for (session, person, key, general) or returns false */
  consumeStepUp: (key: string, general: unknown, token: unknown) => boolean
  emit?: WebCtx['opts']['emit']
}

class WideningFile extends Error { constructor(readonly j: Judgement) { super('widening') } }

export async function applyFileShare(op: Op, it: FileItem, body: Record<string, unknown>, deps: FileChangeDeps): Promise<unknown> {
  const { w, actor: a } = op
  const db = w.db
  if (!it.managed) throw err(409, 'inplace', 'files on the NAS (in place) are shared by their folder there, not one by one')
  if (it.personal) throw err(409, 'personal', 'a file in a personal folder is not shared: move it to a team folder to share it')
  for (const k of ['restrict_here', 'ai_access', 'editors_can_share']) if (body[k] !== undefined) throw bad('not_for_files', `${k} is set on the folder, not on a file`)
  const { r, F, e } = it
  const kind = fileKind(it, a)
  const mgr = kind === 'admin' || kind === 'manager'
  const E = everyoneId(db)
  const ownRow = rowOf(db, e)
  const current = new Map<string, GrantRow>((ownRow?.uid ? grantsOf(db, ownRow.uid) : []).map((g) => [`${g.subject_type}:${g.subject_id}`, g]))
  const steps: FStep[] = []
  const invites: { email: string; role: 'viewer' | 'editor' }[] = []
  const seen = new Set<string>()
  let stepUp: { general: unknown } | null = null

  const changes = body.add !== undefined || body.set !== undefined || body.general !== undefined
  if (changes && kind === 'none') {
    const editorish = it.access.levelOfFile(e) >= 2
    throw err(403, editorish && !r.editorsCanShare(F) ? 'editors_cannot_share' : 'not_manager',
      editorish && !r.editorsCanShare(F) ? 'Editors cannot change sharing here (a manager turned it off)' : 'you cannot change sharing on this file')
  }
  const wantRole = (role: unknown, allowRemove: boolean): 'viewer' | 'editor' | 'remove' => {
    if (role === 'manager') throw bad('not_for_files', 'a file has Viewers and Editors; Managers are set on folders')
    if (role === 'viewer' || role === 'editor' || (allowRemove && role === 'remove')) return role
    throw bad('bad_role', `role: viewer or editor${allowRemove ? ' or remove' : ''}`)
  }
  const step = (s: { type: 'person' | 'group'; id: number; name: string }, role: 'viewer' | 'editor' | 'remove', isAdd: boolean) => {
    const key = `${s.type}:${s.id}`
    if (seen.has(key)) throw bad('duplicate', `${s.name} appears twice in this change`)
    seen.add(key)
    const prev = current.get(key)?.level ?? 0
    if (role === 'remove') {
      if (!prev) throw err(400, 'inherited', `${s.name} has no share on this file itself; their access comes from the folder`)
      steps.push({ ...s, level: 0, prev })
      return
    }
    const level = LEVEL[role]
    const inherited = r.subjectLevel(s.type, s.id, F).level
    if (level < inherited) throw err(400, 'inherited', `${s.name} is ${roleName(inherited)} from the folder; change it there`)
    if (level === prev) return
    if (isAdd && level <= inherited && !prev) return // the folder already gives this
    steps.push({ ...s, level, prev })
  }
  if (body.add !== undefined) {
    if (!Array.isArray(body.add) || body.add.length > 100) throw bad('bad_add', 'add: a list of { subject, role } (at most 100)')
    for (const x of body.add as { subject?: unknown; role?: unknown }[]) {
      const role = wantRole(x?.role, false) as 'viewer' | 'editor'
      const sub = x?.subject as { email?: unknown } | undefined
      if (sub && typeof sub === 'object' && 'email' in sub) {
        if (kind !== 'admin') throw err(403, 'invite_admin_only', 'only an admin shares with someone outside the team (an invitation)')
        const email = typeof sub.email === 'string' ? sub.email.trim() : ''
        if (!/^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) throw bad('bad_email', 'a valid mail address is required')
        const known = db.query<{ person_id: number; active: number }, [string]>('SELECT a.person_id, p.active FROM accounts a JOIN people p ON p.id = a.person_id WHERE lower(a.email) = lower(?)').get(email)
        if (known?.active) { step(subjectOf(db, { type: 'person', id: known.person_id }), role, true); continue }
        if (!inviteHandler(db)) throw err(409, 'invites_unavailable', 'this server cannot invite people by mail; add them as people first')
        invites.push({ email, role })
        continue
      }
      if (!isRef(sub)) throw bad('bad_subject', 'subject: { type: person | group, id } or { email }')
      if (sub.type === 'group' && sub.id === E) throw bad('bad_subject', 'the whole team is General access (general: { mode: "team", role })')
      step(subjectOf(db, sub), role, true)
    }
  }
  if (body.set !== undefined) {
    if (!Array.isArray(body.set) || body.set.length > 100) throw bad('bad_set', 'set: a list of { subject, role } (at most 100)')
    for (const x of body.set as { subject?: unknown; role?: unknown }[]) {
      if (!isRef(x?.subject)) throw bad('bad_subject', 'subject: { type: person | group, id }')
      if (x.subject.type === 'group' && x.subject.id === E) throw bad('bad_subject', 'the whole team is General access (general: { mode: "team", role })')
      step(subjectOf(db, x.subject), wantRole(x.role, true), false)
    }
  }
  if (body.general !== undefined) {
    const g = body.general as { mode?: unknown; role?: unknown } | null
    const mode = g && typeof g === 'object' ? g.mode : undefined
    if (!(mode === 'restricted' || (mode === 'team' && (g!.role === 'viewer' || g!.role === 'editor')))) throw bad('bad_general', "general: { mode: 'restricted' } or { mode: 'team', role: 'viewer' | 'editor' }")
    const above = E == null ? { level: 0, from: null as number | null } : r.subjectLevel('group', E, F)
    const level = mode === 'team' ? LEVEL[g!.role as 'viewer' | 'editor'] : 0
    if (level < above.level) {
      const from = above.from == null ? undefined : r.folders.get(above.from)
      throw new ApiError(400, 'inherited_general', `Anyone in Trina has access from the folder${from ? ` ${r.vpath(from)}` : ''}; a file cannot be narrower than its folder`, undefined)
    }
    const prev = E == null ? 0 : current.get(`group:${E}`)?.level ?? 0
    const lv = level <= above.level ? 0 : level // the folder already gives it: no grant of its own
    if (lv !== prev) {
      if (seen.has(`group:${E}`)) throw bad('duplicate', 'General access appears twice in this change')
      steps.push({ type: 'group', id: E ?? -1, name: 'Anyone in Trina', level: lv, prev })
      // an Editor opening the file to the whole team proves it is a person (passkey or TOTP), not a script with a session
      if ((kind === 'editor' || kind === 'file_editor') && lv > prev) stepUp = { general: g }
    }
  }
  let leave = false
  if (body.leave === true) {
    if (!current.has(`person:${a.personId}`)) throw err(400, 'nothing_to_leave', 'this file is not shared with you directly; your access comes from its folder')
    if (seen.has(`person:${a.personId}`)) throw bad('duplicate', 'you appear twice in this change')
    leave = true
    steps.push({ type: 'person', id: a.personId, name: personName(db, a.personId), level: 0, prev: current.get(`person:${a.personId}`)!.level })
  }
  if (!steps.length && !invites.length) return { ...fileShareView(w, a, it, deps), widens: 0, invited: [] }
  const after = new Map(current)
  for (const s of steps) { const k = `${s.type}:${s.id}`; if (s.level) after.set(k, { level: s.level } as GrantRow); else after.delete(k) }
  if (after.size > FILE_GRANTS_MAX) throw bad('too_many', `a file can be shared with at most ${FILE_GRANTS_MAX} people and groups; share its folder instead`)
  if (stepUp && typeof body.step_up !== 'string') throw err(403, 'step_up_required', 'opening this file to the whole team needs your passkey: confirm it first (POST /api/share/step-up)')
  const stepKey = fileStepKey(db, e) // bound before a row is made for the file (the step-up was asked with this key)
  const prepare = steps.some((s) => s.level > 0) ? prepareRow(db, e) : null
  const notifyOn = body.notify !== false

  // R5 readers of the file before and after (folder readers ∪ grantees), for the R6 check and "shared with you"
  const folderReaders = readersTarget(db, F.id)
  const before = new Set(folderReaders)
  if (ownRow?.uid) fileGrantees(db, ownRow.uid).forEach((u) => before.add(u))
  let gainedPeople: number[] = []
  let j: Judgement | null = null
  try {
    db.transaction(() => {
      if (stepUp && !deps.consumeStepUp(stepKey, stepUp.general, body.step_up)) throw err(403, 'step_up_required', 'opening this file to the whole team needs your passkey: confirm it first (POST /api/share/step-up)')
      const row = prepare ? prepare() : ownRow ? { id: ownRow.id, uid: ownRow.uid! } : null
      if (!row) return
      if (prepare) db.query('UPDATE mfiles SET folder_id = ?, name = ? WHERE id = ?').run(F.id, e.real.slice(e.real.lastIndexOf('/') + 1), row.id)
      const t = now()
      for (const s of steps) {
        if (s.level === 0) db.query('DELETE FROM file_grants WHERE file_uid = ? AND subject_type = ? AND subject_id = ?').run(row.uid, s.type, s.id)
        else {
          const id = s.type === 'group' && s.id === -1 ? (E ?? everyoneGroupId(db)) : s.id
          db.query(`INSERT INTO file_grants (file_uid, subject_type, subject_id, subject_uid, level, granted_by, granted_at) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT DO UPDATE SET level = excluded.level, subject_uid = excluded.subject_uid, granted_by = excluded.granted_by, granted_at = excluded.granted_at`)
            .run(row.uid, s.type, id, s.type === 'group' ? groupUid(db, id) : null, s.level, a.personId, t)
        }
      }
      const afterReaders = new Set(folderReaders)
      fileGrantees(db, row.uid).forEach((u) => afterReaders.add(u))
      gainedPeople = [...afterReaders].filter((u) => !before.has(u))
      const judged = judgeCopies(db, e, F, before, afterReaders)
      j = judged.j
      if (j.copies.length) {
        if (!(mgr && body.confirm_widening === true)) throw new WideningFile(j)
        applyJudgement(db, judged.snap, j, a.personId)
      }
      const by = kind === 'editor' || kind === 'file_editor' ? ' by editor' : ''
      const widens = ` widens:${j.people.size}`
      for (const s of steps) {
        const what = leave && s.id === a.personId && s.type === 'person' && s.level === 0 ? 'leave'
          : s.type === 'group' && (s.id === E || s.id === -1) ? `general ${s.level ? `team:${roleName(s.level)}` : 'restricted'}`
          : `${s.type}:${s.id} ${roleName(s.prev)}→${roleName(s.level)}`
        record(op, `share ${it.vpath} (file) ${what}${by}${widens}`, [it.vpath])
      }
    })()
  } catch (x) {
    if (!(x instanceof WideningFile)) throw x
    if (body.confirm_widening === true && !mgr) throw err(403, 'editors_cannot_confirm', 'only a manager of this folder or an admin can confirm a widening')
    const shown: string[] = []
    let hidden = 0
    for (const s of x.j.sources) { const n = it.access.nodeForFolder(s); if (n && it.access.canRead(n)) shown.push(n.vpath); else hidden++ }
    return json({
      error: 'widening', code: 'widening',
      message: mgr ? 'this file is a copy of an AI draft: sharing it lets people read its content without reading its sources; send again with confirm_widening to go ahead'
        : 'this file is a copy of an AI draft: sharing it lets people read its content without reading its sources; ask a manager of this folder',
      count: x.j.copies.length, people: x.j.people.size, sources: shown.sort(), sources_hidden: hidden, can_confirm: mgr, needs_approval: !mgr,
    }, 409)
  }
  // after the commit: notices (R11/O7: kind + count + link, never names)
  const newReaders = gainedPeople.filter((u) => u !== a.personId)
  if (notifyOn && newReaders.length) await tell(op, newReaders, 'shared', '/#/shared')
  const managers = r.managersOf(F).filter((m) => m !== a.personId)
  if ((kind === 'editor' || kind === 'file_editor') && managers.length && !leave) await tell(op, managers, 'rules_changed', folderLink(F))
  const jj = j as Judgement | null
  if (jj && jj.copies.length) emitWidened(deps.emit, jj)
  const invited = await runFileInvites(op, it, invites, notifyOn)
  const again = fileAt(w, a, it.vpath)
  const view = again ? fileShareView(w, a, again, deps) : null
  return { ...(view ?? { mode: 'managed', item: { path: it.vpath, kind: 'file', name: it.name }, my_role: null, can_manage: false, entries: [], general: null }),
    widens: jj?.people.size ?? 0, invited }
}

const everyoneGroupId = (db: DB): number => {
  const id = Number(db.query('INSERT INTO groups (name) VALUES (?)').run('everyone').lastInsertRowid)
  db.query('INSERT OR IGNORE INTO memberships (group_id, person_id) SELECT ?, id FROM people WHERE active = 1').run(id)
  db.query("INSERT INTO meta (key, value) VALUES ('everyone_group', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(String(id))
  return id
}

/** Source managers hear about the copies this change widened (kind + count + link only, R11). */
function emitWidened(emit: WebCtx['opts']['emit'] | undefined, j: Judgement) {
  if (!emit) return
  const sources = new Set<number>()
  for (const c of j.copies) c.sources.forEach((s) => sources.add(s))
  const target = j.copies[0]!.folderId
  try { emit({ kind: 'widened_draft', count: j.copies.length, sourceFolderIds: [...sources], targetFolderId: target }) } catch (e) { console.error('[notify] widened_draft emit failed:', e) }
}

/**
 * Non-members by mail (admin only): the team's invite flow; when it hands back the invited person's row, the file is
 * shared with them now. Otherwise `granted: false` and a pending invite is kept (S16): the member sync applies it when
 * that address becomes a member (src/share/invites.ts applyShareInvites).
 */
async function runFileInvites(op: Op, it: FileItem, invites: { email: string; role: 'viewer' | 'editor' }[], notifyOn: boolean) {
  const out: { email: string; status: 'invited' | 'member'; granted: boolean }[] = []
  const h = inviteHandler(op.w.db)
  if (!h || !invites.length) return out
  const db = op.w.db
  for (const inv of invites) {
    const res = await h(op.w, { email: inv.email, role: 'member', by: op.actor.personId })
    let granted = false
    if (res.personId != null && db.query('SELECT 1 FROM people WHERE id = ? AND active = 1').get(res.personId)) {
      const again = fileAt(op.w, op.actor, it.vpath)
      if (again) {
        const prepare = prepareRow(db, again.e)
        db.transaction(() => {
          const row = prepare()
          db.query('UPDATE mfiles SET folder_id = ?, name = ? WHERE id = ?').run(again.F.id, again.e.real.slice(again.e.real.lastIndexOf('/') + 1), row.id)
          db.query(`INSERT INTO file_grants (file_uid, subject_type, subject_id, subject_uid, level, granted_by, granted_at) VALUES (?, 'person', ?, NULL, ?, ?, ?)
            ON CONFLICT DO UPDATE SET level = max(level, excluded.level)`).run(row.uid, res.personId!, LEVEL[inv.role], op.actor.personId, now())
          record(op, `share ${it.vpath} (file) person:${res.personId} →${inv.role} (invited) widens:0`, [it.vpath])
        })()
        granted = true
        if (notifyOn) await tell(op, [res.personId], 'shared', '/#/shared')
      }
    }
    if (!granted) {
      // S16: given when this address becomes a member (src/share/invites.ts, called by the member sync)
      const again = fileAt(op.w, op.actor, it.vpath)
      if (again) {
        const prepare = prepareRow(db, again.e)
        db.transaction(() => {
          const row = prepare()
          db.query('UPDATE mfiles SET folder_id = ?, name = ? WHERE id = ?').run(again.F.id, again.e.real.slice(again.e.real.lastIndexOf('/') + 1), row.id)
          recordShareInvite(db, inv.email, { kind: 'file', fileUid: row.uid, level: LEVEL[inv.role], by: op.actor.personId, vpath: it.vpath })
        })()
      }
    }
    out.push({ email: inv.email, status: res.status, granted })
  }
  return out
}

// ---------- Shared with me (files) ----------
/**
 * Files shared with this person directly or through one of their groups (not Everyone), that they can open right now:
 * each grant's file is found by its location and must be the walk's file with the row's identity (hidden == missing).
 */
export function sharedFilesWithMe(w: WebCtx, a: Actor, everyone: number | null): FileSharedItem[] {
  const db = w.db
  const rows = db.query<{ uid: string; dev: string; ino: string; folder_id: number | null; name: string | null; level: number; granted_by: number | null; granted_at: number }, [number, number]>(`
    SELECT m.uid, m.dev, m.ino, m.folder_id, m.name, g.level, g.granted_by, g.granted_at FROM file_grants g JOIN mfiles m ON m.uid = g.file_uid
    WHERE (g.subject_type = 'person' AND g.subject_id = ?1)
       OR (g.subject_type = 'group' AND g.subject_id != ?2 AND g.subject_id IN (SELECT group_id FROM memberships WHERE person_id = ?1)
           AND EXISTS (SELECT 1 FROM groups x WHERE x.id = g.subject_id AND x.uid = g.subject_uid))`).all(a.personId, everyone ?? -1)
  const best = new Map<string, typeof rows[number]>()
  for (const x of rows) {
    if (x.granted_by === a.personId) continue
    const cur = best.get(x.uid)
    if (!cur || x.granted_at > cur.granted_at) best.set(x.uid, x)
  }
  const access = Access.forPerson(db, a.personId)
  const r = new Rights(db)
  const out: FileSharedItem[] = []
  for (const [uid, x] of best) {
    if (x.folder_id == null || x.name == null) continue
    const f = r.folders.get(x.folder_id)
    const fvp = f ? r.vpath(f) : null
    if (!f || !fvp) continue
    const vp = `${fvp}/${x.name.normalize('NFC')}`
    const e = access.lookup(splitVirtual(vp))
    if (!e || e.kind !== 'file' || String(e.dev) !== x.dev || String(e.ino) !== x.ino || rowOf(db, e)?.uid !== uid) continue
    const role = roleOf(access.levelOfFile(e))
    if (!role) continue
    out.push({ kind: 'file', path: e.vpath, name: e.vpath.slice(e.vpath.lastIndexOf('/') + 1), role,
      shared_by: x.granted_by == null ? null : { id: x.granted_by, name: personName(db, x.granted_by) }, shared_at: x.granted_at,
      size: e.size, mtime: Math.round(e.mtimeMs) })
  }
  return out
}

/** For the A1 dispatcher's not-found handling: the file branch never reveals anything about a path it cannot see. */
export const fileNotFound = notFound
