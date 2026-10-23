// "My files" in Trina Cloud mode (workstream B2, plan §10.3, A2 memo §9.2; documented in docs/MY-FILES.md).
//
// Every active console member gets one managed personal folder: a top folder named "<handle> (personal)" in managed
// storage, owned by them (R0: only the owner reads it, nobody can add a rule or share it — share API 'personal'). The
// app shows it as "My files" (`me.myFilesPath`). Its bytes count toward the team's quota like any team folder.
// The person's AI reads it like any folder of theirs: the token scope applies, and "No AI" on it closes it to agents.
//
// When the person leaves (deactivated by the member sync: removed in the console, or an invite withdrawn), the folder is
// kept and handed to the admins, the way Google Drive transfers a deleted user's files: it moves to
// "Former members/<handle>", a managed team folder (made on first need) where every active admin is an Editor (kept
// in step with the console's admins) and "No AI" is on (agents never read a former member's files by default). Its
// files, versions and trash entries keep their identities; the move is one audit row.
// When the person comes back (reactivated by the sync or a newer sign-in), the same folder moves back as their My files
// if it is still somewhere in Former members (admins may have taken files out, or added some; the person is told by a
// notice). If the admins moved or removed it, the person gets a new, empty My files.
//
// Everything runs through reconcileMyFiles(): after each member sync, after each SSO sign-in, and from the backfill
// CLI `cloud my-files`. It is idempotent and repairs itself (a crash between the disk move and the commit is undone at
// once; a missed transfer happens the next time). A self-hosted install (no TDRIVE_CLOUD_*) never gets here.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { appendAudit } from '../audit'
import type { DB } from '../db'
import { relocateFolderRows, taken } from '../managed/core'
import { isManagedFolder, makeMountDir, registerManaged } from '../managed/folders'
import { ensureRoot, storageSettings } from '../managed/settings'
import { nfc } from '../names'
import { applyJudgement, judge, relocateCopies, snapshotCopies, tellWidened, withRejudge, type Judgement } from '../share/rejudge'
import { folderById, type FolderRow } from '../store'
import { notify, type NoticeCtx } from '../web/notices'
import { ensureWebSchema, metaGet, metaSet } from '../web/schema'
import { cloudConfig } from './config'

export const FORMER_MEMBERS = 'Former members'
export const PERSONAL_SUFFIX = ' (personal)'
/** meta: the folders row of the "Former members" team folder */
export const FORMER_META = 'cloud_former_members_folder'
/** meta: people whose Editor rule on Former members this module wrote (so it can take it back when they stop being admin) */
export const FORMER_ADMINS_META = 'cloud_former_members_admins'

export interface MyFilesRow {
  folder_id: number; person_id: number; mount_name: string; state: 'mine' | 'former' | 'gone'
  created_at: number; former_at: number | null; former_name: string | null
}

const rowsOf = (db: DB, personId: number, state: MyFilesRow['state']) =>
  db.query<MyFilesRow, [number, string]>('SELECT * FROM cloud_my_files WHERE person_id = ? AND state = ? ORDER BY coalesce(former_at, created_at) DESC, folder_id DESC').all(personId, state)

const history = (db: DB, folderId: number, field: string, oldValue: string | null, newValue: string | null) =>
  db.query('INSERT INTO folder_history (folder_id, at, by_person, field, old_value, new_value) VALUES (?, ?, NULL, ?, ?, ?)').run(folderId, Date.now(), field, oldValue, newValue)
const audit = (db: DB, command: string, files: string[] = [], personId: number | null = null) =>
  appendAudit(db, { personId, tokenId: null, tool: 'cloud', command, files, outcome: 'ok' })

/** The folder on disk is still this row (same identity; a directory, not a link). */
function onDisk(f: FolderRow): boolean {
  try {
    const st = fs.lstatSync(f.path, { bigint: true })
    return st.isDirectory() && String(st.dev) === f.dev && String(st.ino) === f.ino
  } catch { return false }
}

/** The row is still this person's managed personal top folder (an admin may have released it or changed its owner). */
function stillMine(db: DB, row: MyFilesRow): FolderRow | null {
  const f = folderById(db, row.folder_id)
  return f && f.registered && f.personal_owner === row.person_id && isManagedFolder(db, f.id) ? f : null
}

/** The person's My files folder row, or null (self-hosted, not made yet, or released by an admin). */
export function myFilesOf(db: DB, personId: number): FolderRow | null {
  if (!hasTable(db)) return null
  for (const row of rowsOf(db, personId, 'mine')) { const f = stillMine(db, row); if (f) return f }
  return null
}

/** `me.myFilesPath`: "/<mount name>" — the path the files API, WebDAV and agents use — or null. */
export function myFilesPath(db: DB, personId: number): string | null {
  const f = myFilesOf(db, personId)
  return f?.mount_name ? nfc(`/${f.mount_name}`) : null
}

const hasTable = (db: DB) => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cloud_my_files'").get()

/** A top-folder name nobody has (registered folders compare after NFC and case folding: duplicates close both). */
export function freeMountName(db: DB, base: string): string {
  const names = new Set(db.query<{ mount_name: string | null }, []>('SELECT mount_name FROM folders WHERE registered = 1').all().map((r) => nfc(r.mount_name ?? '').toLowerCase()))
  for (let n = 1; ; n++) { const name = n === 1 ? base : `${base} ${n}`; if (!names.has(nfc(name).toLowerCase())) return nfc(name) }
}

/** A child name free in dir: base, "base 2", "base 3" … */
function freeChild(dir: string, base: string): string {
  for (let n = 1; ; n++) { const name = n === 1 ? base : `${base} ${n}`; if (!taken(dir, name)) return name }
}

const handleOf = (db: DB, personId: number) => db.query<{ name: string; active: number }, [number]>('SELECT name, active FROM people WHERE id = ?').get(personId)

/** Managed storage is how Trina Cloud teams keep files; an in-place install has no managed root to put My files in. */
const managedMode = (db: DB, dataDir: string) => storageSettings(db, dataDir).mode === 'managed'

// ---------- Former members ----------
/** The "Former members" team folder, made on first need: managed, admins are Editors (syncFormerAccess), No AI on. */
export function formerMembersFolder(db: DB, dataDir: string, create = true): FolderRow | null {
  const id = Number(metaGet(db, FORMER_META) ?? 0)
  const row = id ? folderById(db, id) : undefined
  if (row && row.registered && row.personal_owner == null && isManagedFolder(db, row.id) && onDisk(row)) return row
  if (!create) return null
  const dir = makeMountDir(db, dataDir)
  try {
    return db.transaction(() => {
      const name = freeMountName(db, FORMER_MEMBERS)
      const f = registerManaged(db, dir, { name, by: null })
      // agents never read a former member's files unless an admin turns this off (R9: that tells the managers);
      // Editors there (if an admin adds any) do not reshare them
      db.query('UPDATE folders SET no_ai = 1, editors_can_share = 0 WHERE id = ?').run(f.id)
      metaSet(db, FORMER_META, String(f.id))
      history(db, f.id, 'registered', null, JSON.stringify({ template: 'former-members' }))
      audit(db, `folder create (managed) as /${name} (former members: admins are Editors, No AI on)`, [`/${name}`])
      return folderById(db, f.id)!
    })()
  } catch (e) { try { fs.rmdirSync(dir) } catch {} throw e }
}

/**
 * Every active admin is an Editor of Former members (a rule this module wrote and remembers); someone who is no longer
 * an active admin loses the rule this module gave them. Rules an admin set by hand are left alone. In a `rules`
 * re-check (src/share/rejudge.ts): AI-draft copies there never open to more people without a source manager's word.
 */
export function syncFormerAccess(db: DB): Judgement | null {
  const id = Number(metaGet(db, FORMER_META) ?? 0)
  const f = id ? folderById(db, id) : undefined
  if (!f || !f.registered) return null
  const admins = new Set(db.query<{ id: number }, []>('SELECT id FROM people WHERE admin = 1 AND active = 1').all().map((p) => p.id))
  const tracked = new Set<number>(JSON.parse(metaGet(db, FORMER_ADMINS_META) ?? '[]') as number[])
  const has = (pid: number) => !!db.query("SELECT 1 FROM rules WHERE folder_id = ? AND subject_type = 'person' AND subject_id = ?").get(f.id, pid)
  const add = [...admins].filter((pid) => !has(pid))
  const drop = [...tracked].filter((pid) => !admins.has(pid))
  if (!add.length && !drop.length) return null
  return withRejudge(db, () => {
    for (const pid of add) {
      db.query("INSERT INTO rules (folder_id, subject_type, subject_id, level, granted_by, granted_at) VALUES (?, 'person', ?, 2, NULL, ?)").run(f.id, pid, Date.now())
      tracked.add(pid)
    }
    for (const pid of drop) { db.query("DELETE FROM rules WHERE folder_id = ? AND subject_type = 'person' AND subject_id = ?").run(f.id, pid); tracked.delete(pid) }
    metaSet(db, FORMER_ADMINS_META, JSON.stringify([...tracked].sort((a, b) => a - b)))
  }, { mode: 'rules', after: (j) => {
    audit(db, `former members: admins are Editors (${add.length} added, ${drop.length} removed)${j.pending.length ? `, ${j.pending.length} AI-draft cop${j.pending.length === 1 ? 'y' : 'ies'} closed (widening)` : ''}`, [`/${f.mount_name}`])
  } }).judgement
}

// ---------- a person's folder ----------
/**
 * Move a managed folder on disk and its rows with it, in one transaction with `then` and the R6 re-check of AI-draft
 * copies (src/share/rejudge.ts, mode 'rules'): a copy someone moved into their My files does not open to the admins
 * when it is handed over — it closes until a source manager confirms. The disk move is undone if anything fails.
 */
function moveWith<T>(db: DB, from: string, to: string, then: () => T): { value: T; judgement: Judgement } {
  let moved = false
  try {
    return db.transaction(() => {
      const before = snapshotCopies(db)
      fs.renameSync(from, to)
      moved = true
      relocateFolderRows(db, from, to)
      const value = then()
      const judgement = judge(db, before, 'rules')
      applyJudgement(db, before, judgement, null)
      relocateCopies(db, from, to) // AI-draft copies are found where they are now (after: the judgement wrote the old path)
      return { value, judgement }
    })()
  } catch (e) { if (moved) try { fs.renameSync(to, from) } catch {} throw e }
}

/** Rules, manage grants (ignored inside a personal folder, R0) are cleared when a folder becomes personal again. */
function clearSharing(db: DB, real: string): number {
  const ids = db.query<{ id: number }, [string, number, string]>('SELECT id FROM folders WHERE path = ? OR substr(path, 1, ?) = ?').all(real, real.length + 1, real + '/').map((r) => r.id)
  let n = 0
  for (const id of ids) {
    n += db.query('DELETE FROM rules WHERE folder_id = ?').run(id).changes
    n += db.query('DELETE FROM manage_grants WHERE folder_id = ?').run(id).changes
  }
  return n
}

export type Ensured = { folder: FolderRow; how: 'exists' | 'created' | 'adopted' | 'restored'; judgement?: Judgement }

/**
 * The person's My files, made if needed (active console members only): their existing one; else a managed personal
 * folder an admin made for them earlier (adopted); else their old one, back from Former members (restored); else new.
 */
export function ensureMyFiles(db: DB, dataDir: string, personId: number): Ensured | null {
  if (!cloudConfig(db) || !managedMode(db, dataDir)) return null
  ensureWebSchema(db)
  const who = db.query<{ name: string; active: number; cloud_user: string | null }, [number]>(
    'SELECT p.name, p.active, a.cloud_user FROM people p LEFT JOIN accounts a ON a.person_id = p.id WHERE p.id = ?').get(personId)
  if (!who || !who.active || !who.cloud_user) return null
  for (const row of rowsOf(db, personId, 'mine')) {
    const f = stillMine(db, row)
    if (f) return { folder: f, how: 'exists' }
    // an admin released it (unregistered it, or gave it to someone else): no longer this person's My files
    db.transaction(() => {
      db.query("UPDATE cloud_my_files SET state = 'gone' WHERE folder_id = ?").run(row.folder_id)
      audit(db, `my files of ${who.name}: released by an admin, no longer tracked`)
    })()
  }
  // a managed personal folder of theirs that nobody tracks (an admin made it before My files existed)
  const own = db.query<FolderRow, [number]>(`SELECT f.* FROM folders f JOIN managed_mounts m ON m.folder_id = f.id
    WHERE f.registered = 1 AND f.personal_owner = ? AND f.id NOT IN (SELECT folder_id FROM cloud_my_files WHERE state = 'mine') ORDER BY f.id`).all(personId)[0]
  if (own) {
    const done = db.transaction(() => {
      if (rowsOf(db, personId, 'mine').length) return false
      db.query("INSERT INTO cloud_my_files (folder_id, person_id, mount_name, state, created_at) VALUES (?, ?, ?, 'mine', ?) ON CONFLICT (folder_id) DO UPDATE SET person_id = excluded.person_id, mount_name = excluded.mount_name, state = 'mine', former_at = NULL, former_name = NULL")
        .run(own.id, personId, own.mount_name ?? '', Date.now())
      audit(db, `my files of ${who.name}: their personal folder /${own.mount_name}`, [`/${own.mount_name}`])
      return true
    }).immediate()
    const f = myFilesOf(db, personId)
    if (f) return { folder: f, how: done ? 'adopted' : 'exists' }
  }
  const back = restore(db, dataDir, personId, who.name)
  if (back) return { folder: back.value, how: 'restored', judgement: back.judgement }
  return create(db, dataDir, personId, who.name)
}

function create(db: DB, dataDir: string, personId: number, handle: string): Ensured {
  const dir = makeMountDir(db, dataDir)
  try {
    const made = db.transaction(() => {
      // another process (the server and the sync CLI share the database) may have made it a moment ago
      const other = rowsOf(db, personId, 'mine').map((r) => stillMine(db, r)).find(Boolean)
      if (other) return null
      const name = freeMountName(db, handle + PERSONAL_SUFFIX)
      const f = registerManaged(db, dir, { name, personalOwner: handle, by: null })
      db.query("INSERT INTO cloud_my_files (folder_id, person_id, mount_name, state, created_at) VALUES (?, ?, ?, 'mine', ?)").run(f.id, personId, name, Date.now())
      history(db, f.id, 'registered', null, JSON.stringify({ template: 'my-files', owner: personId }))
      audit(db, `my files of ${handle}: folder create (managed) as /${name} (personal)`, [`/${name}`])
      return f
    }).immediate()
    if (made) return { folder: made, how: 'created' }
  } catch (e) { try { fs.rmdirSync(dir) } catch {} throw e }
  try { fs.rmdirSync(dir) } catch {}
  return { folder: myFilesOf(db, personId)!, how: 'exists' }
}

/** Their last folder handed to Former members, if it is still there (same folder on disk), moves back as My files. */
function restore(db: DB, dataDir: string, personId: number, handle: string): { value: FolderRow; judgement: Judgement } | null {
  const fm = formerMembersFolder(db, dataDir, false)
  if (!fm) return null
  for (const row of rowsOf(db, personId, 'former')) {
    const f = folderById(db, row.folder_id)
    if (!f || f.registered || !f.path.startsWith(fm.path + '/') || !onDisk(f)) continue
    const root = storageSettings(db, dataDir).root
    ensureRoot(root)
    const dest = path.join(root, crypto.randomUUID())
    const from = f.path
    return moveWith(db, from, dest, () => {
      const name = freeMountName(db, row.mount_name || handle + PERSONAL_SUFFIX)
      const cleared = clearSharing(db, dest)
      const g = registerManaged(db, dest, { name, personalOwner: handle, by: null })
      db.query('UPDATE folders SET inherit_break = 0 WHERE id = ?').run(g.id)
      db.query("UPDATE cloud_my_files SET state = 'mine', mount_name = ?, former_at = NULL, former_name = NULL WHERE folder_id = ?").run(name, g.id)
      history(db, g.id, 'personal_owner', null, String(personId))
      audit(db, `my files of ${handle}: back from /${fm.mount_name}/${path.basename(from)} as /${name}${cleared ? ` (${cleared} rules or manage grants there cleared: a personal folder has none)` : ''}`, [`/${fm.mount_name}/${path.basename(from)}`, `/${name}`])
      return folderById(db, g.id)!
    })
  }
  return null
}

/** The person left: their My files moves to Former members/<handle> (admins are Editors there). */
export function transferToFormer(db: DB, dataDir: string, personId: number): { folder: FolderRow; path: string; judgement: Judgement } | null {
  if (!cloudConfig(db)) return null
  ensureWebSchema(db)
  const who = handleOf(db, personId)
  if (!who || who.active) return null
  let out: { folder: FolderRow; path: string; judgement: Judgement } | null = null
  for (const row of rowsOf(db, personId, 'mine')) {
    const f = stillMine(db, row)
    if (!f || !onDisk(f)) {
      db.transaction(() => { db.query("UPDATE cloud_my_files SET state = 'gone' WHERE folder_id = ?").run(row.folder_id); audit(db, `my files of ${who.name}: released by an admin, no longer tracked`) })()
      continue
    }
    const fm = formerMembersFolder(db, dataDir)!
    const label = freeChild(fm.path, who.name)
    const dest = path.join(fm.path, label)
    const from = f.path
    const { judgement } = moveWith(db, from, dest, () => {
      history(db, f.id, 'personal_owner', String(personId), null)
      history(db, f.id, 'registered', JSON.stringify({ mount: f.mount_name }), JSON.stringify({ moved_to: `/${fm.mount_name}/${label}` }))
      db.query('UPDATE folders SET registered = 0, mount_name = NULL, personal_owner = NULL, nas_readers = NULL, inherit_break = 0 WHERE id = ?').run(f.id)
      db.query('DELETE FROM managed_mounts WHERE folder_id = ?').run(f.id)
      db.query("UPDATE cloud_my_files SET state = 'former', former_at = ?, former_name = ? WHERE folder_id = ?").run(Date.now(), label, f.id)
      audit(db, `my files of ${who.name} (left the team): /${f.mount_name} moved to /${fm.mount_name}/${label} (admins are Editors there)`, [`/${f.mount_name}`, `/${fm.mount_name}/${label}`])
    })
    out = { folder: folderById(db, f.id)!, path: `/${fm.mount_name}/${label}`, judgement }
  }
  return out
}

export interface Reconciled {
  created: number; adopted: number; restored: number; transferred: number
  /** people whose old folder came back (told after the commit, afterReconcile) */
  restoredPeople: number[]
  failed: string[]
  /** AI-draft copies the admin-rule change closed (told after the commit, afterReconcile) */
  judgements: Judgement[]
}

/**
 * Bring My files in line with membership (idempotent): every active console member has one, every person who left has
 * theirs in Former members, admins are Editors there. `only`: one person (an SSO sign-in) plus the admin rules.
 * Errors are collected per person (one broken folder never stops the rest, nor the sign-in or sync that called this).
 */
export function reconcileMyFiles(db: DB, dataDir: string, opts: { only?: number } = {}): Reconciled {
  const out: Reconciled = { created: 0, adopted: 0, restored: 0, transferred: 0, restoredPeople: [], failed: [], judgements: [] }
  if (!cloudConfig(db) || !managedMode(db, dataDir) || !hasTable(db)) return out
  ensureWebSchema(db)
  const members = db.query<{ id: number; name: string }, []>(
    'SELECT p.id, p.name FROM people p JOIN accounts a ON a.person_id = p.id WHERE p.active = 1 AND a.cloud_user IS NOT NULL ORDER BY p.id').all()
  const leavers = db.query<{ id: number; name: string }, []>(
    "SELECT DISTINCT p.id, p.name FROM people p JOIN cloud_my_files c ON c.person_id = p.id WHERE p.active = 0 AND c.state = 'mine' ORDER BY p.id").all()
  const pick = <T extends { id: number }>(l: T[]) => opts.only === undefined ? l : l.filter((p) => p.id === opts.only)
  for (const p of pick(leavers)) {
    try {
      const t = transferToFormer(db, dataDir, p.id)
      if (t) { out.transferred++; out.judgements.push(t.judgement) }
    } catch (e) { out.failed.push(`${p.name}: ${(e as Error).message}`) }
  }
  for (const p of pick(members)) {
    try {
      const r = ensureMyFiles(db, dataDir, p.id)
      if (r?.how === 'created') out.created++
      else if (r?.how === 'adopted') out.adopted++
      else if (r?.how === 'restored') { out.restored++; out.restoredPeople.push(p.id); if (r.judgement) out.judgements.push(r.judgement) }
    } catch (e) { out.failed.push(`${p.name}: ${(e as Error).message}`) }
  }
  try { const j = syncFormerAccess(db); if (j) out.judgements.push(j) } catch (e) { out.failed.push(`former members access: ${(e as Error).message}`) }
  if (out.failed.length) console.error(`[tdcloud] my files: ${out.failed.join('; ')}`)
  return out
}

/**
 * After reconcileMyFiles: a person whose folder came back hears of it (the admins had it meanwhile; R9, kind and link
 * only), and source managers hear of AI-draft copies the admin-rule change closed (R6/R11).
 */
export async function afterReconcile(n: NoticeCtx, r: Reconciled) {
  if (r.restoredPeople.length) await notify(n, r.restoredPeople, 'personal_folder_changed', '/#/my')
  for (const j of r.judgements) await tellWidened(n, j)
}
