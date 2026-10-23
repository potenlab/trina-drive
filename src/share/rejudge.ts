// R6 re-check on every change of who reads what (finding 1 of the Trina Cloud v1 review, plan 3.4 / 10.2-1).
//
// A copy of an AI draft (a `widened` row: promoted, uploaded with the same bytes, or found by the reconciler) may be
// read by people (and their AI) only when they can read every source folder of the draft, unless a person who manages
// those sources (or the admin) confirmed it. Before this module, rule changes on the web never re-judged copies, and
// copies in managed storage were never found at all (the reconciler does not walk managed folders), so an Editor
// could narrow a folder, have their AI promote a draft there (not widening: written at once), then open the folder to
// the team: the sources' content reached everyone and their AI with no approval (review-permissions A3).
//
// withRejudge(db, change) runs a change and the re-check in ONE transaction:
//   1. before: every live copy (tracked or confirmed) is located (NAS: the reconciler's index; managed storage: its
//      last path checked by identity, else a walk of the managed folders) and its "excess readers" are computed:
//      people who read the copy's folder (R5 target readers) but cannot read some source (R5 source readers);
//   2. the change is made;
//   3. after: the excess readers are computed again. A copy whose excess readers grew WIDENS:
//        mode 'rules'      (rules, General access, restrict-here, No AI, NAS readers): any growth;
//        mode 'membership' (people and group membership): only a tracked copy that had no excess reader before —
//                           a copy people already placed wide on purpose, or one a source manager confirmed for its
//                           folder's audience, is not reopened because someone joined that audience;
//   4. `decide` sees the result and may throw (the whole change rolls back: the share API's 409 `widening`);
//   5. each widening copy becomes pending (closed to agents and people until a source manager or the admin confirms,
//      R6/R1 ②), unless `confirmBy` may confirm it (the admin, or someone managing every source): then confirmed.
// The caller's audit row goes in through `after`, inside the same transaction. Nothing here sends mail: the caller
// emits `widened_draft` (kind + count + link, R11) after the commit with `notifyWidened`.
import fs from 'node:fs'
import path from 'node:path'
import type { DB } from '../db'
import { addEvent, canConfirmWidened } from '../inplace/events'
import { markPending, type WidenedRow } from '../inplace/widened'
import { diskWalk } from '../managed/core'
import { Access, readersSource, readersTarget, type Node } from '../policy'
import { ensureFolder } from '../store'
import type { DriveEvent } from '../notify/events'
import { manageHolders } from '../notify/recipients'
import { notify, type NoticeCtx } from '../web/notices'

export type RejudgeMode = 'rules' | 'membership'

interface Located { w: WidenedRow; real: string; folderId: number; src: number[]; excess: Set<number> }
export type Snapshot = Map<number, Located>

export interface Judgement {
  /** copies that widen with this change */
  copies: { id: number; folderId: number; sources: number[]; gained: number[] }[]
  /** people who would read some draft's content without reading its sources, because of this change */
  people: Set<number>
  /** the copies' source folders (for the 409 answer: named when the actor reads them, else counted) */
  sources: Set<number>
  /** after applying: copies now pending, and copies the actor confirmed */
  pending: number[]
  confirmed: number[]
}

const LIVE = "status IN ('tracked', 'confirmed')"
const sourcesOf = (db: DB, draftId: number) =>
  db.query<{ folder_id: number }, [number]>('SELECT folder_id FROM draft_src WHERE draft_id = ?').all(draftId).map((r) => r.folder_id)

/** The node of an existing folder by its real path, walked from its mount by the server (links and closed steps: null). */
function nodeAt(server: Access, real: string): Node | null {
  const mount = [...server.mounts().values()].find((m) => real === m.path || real.startsWith(m.path + '/'))
  if (!mount) return null
  let node = server.mountNode(mount)
  if (!node || real === mount.path) return node
  for (const name of path.relative(mount.path, real).split(path.sep)) {
    const e = server.child(node, name)
    if (!e || e.kind !== 'dir') return null
    node = e.node
  }
  return node
}

const sameFile = (real: string, dev: string, ino: string) => {
  try { const st = fs.lstatSync(real, { bigint: true }); return st.isFile() && st.nlink === 1n && String(st.dev) === dev && String(st.ino) === ino } catch { return false }
}

/**
 * Where each live copy is now. NAS: the reconciler's index (one path, else closed anyway). Managed storage: the copy's
 * file row must still exist (a replaced or purged file is not this copy any more); its recorded path is checked by
 * identity, and if it moved, one walk of the managed folders finds it. Trashed or closed copies are not located.
 */
export function locateCopies(db: DB, rows = db.query<WidenedRow, []>(`SELECT * FROM widened WHERE ${LIVE}`).all()): Map<number, { w: WidenedRow; real: string; folderId: number }> {
  const out = new Map<number, { w: WidenedRow; real: string; folderId: number }>()
  if (!rows.length) return out
  const server = new Access(db, { personId: -1 })
  const managedRoots = db.query<{ path: string }, []>('SELECT f.path FROM managed_mounts m JOIN folders f ON f.id = m.folder_id').all().map((r) => r.path)
  let walked: Map<string, string> | null = null
  const byIdentity = () => {
    if (walked) return walked
    walked = new Map()
    for (const top of managedRoots) for (const f of diskWalk(top).files) walked.set(`${f.dev}:${f.ino}`, f.real)
    return walked
  }
  for (const w of rows) {
    let real: string | null = null
    const indexed = db.query<{ path: string }, [string, string]>("SELECT path FROM fs_index WHERE dev = ? AND ino = ? AND kind = 'file'").all(w.dev, w.ino)
    if (indexed.length === 1) real = indexed[0]!.path
    else if (!indexed.length && db.query('SELECT 1 FROM mfiles WHERE dev = ? AND ino = ?').get(w.dev, w.ino)) {
      const inManaged = (p: string) => managedRoots.some((r) => p.startsWith(r + '/'))
      if (inManaged(w.path) && sameFile(w.path, w.dev, w.ino)) real = w.path
      else {
        const found = byIdentity().get(`${w.dev}:${w.ino}`)
        if (found && sameFile(found, w.dev, w.ino)) real = found
      }
    }
    if (!real) continue
    const node = nodeAt(server, path.dirname(real))
    if (!node) continue
    out.set(w.id, { w, real, folderId: ensureFolder(db, node.real, node.dev, node.ino, node.birth) })
  }
  return out
}

/** R5 readers, computed once per folder while nothing changes. */
function readerCache(db: DB) {
  const t = new Map<number, Set<number>>(), s = new Map<number, Set<number>>()
  return {
    target: (id: number) => { let v = t.get(id); if (!v) { v = readersTarget(db, id); t.set(id, v) } return v },
    source: (id: number) => { let v = s.get(id); if (!v) { v = readersSource(db, id); s.set(id, v) } return v },
  }
}

function excessOf(cache: ReturnType<typeof readerCache>, src: number[], target: number): Set<number> {
  const out = new Set<number>()
  const rt = cache.target(target)
  for (const s of src) {
    if (s === target) continue
    const rs = cache.source(s)
    for (const u of rt) if (!rs.has(u)) out.add(u)
  }
  return out
}

/** Every live copy with its excess readers now. */
export function snapshotCopies(db: DB): Snapshot {
  const snap: Snapshot = new Map()
  const at = locateCopies(db)
  if (!at.size) return snap
  const cache = readerCache(db)
  for (const [id, l] of at) {
    const src = sourcesOf(db, l.w.draft_id)
    if (!src.length) continue
    snap.set(id, { ...l, src, excess: excessOf(cache, src, l.folderId) })
  }
  return snap
}

/** Compare a snapshot with the state now (inside the same transaction). */
export function judge(db: DB, before: Snapshot, mode: RejudgeMode): Judgement {
  const j: Judgement = { copies: [], people: new Set(), sources: new Set(), pending: [], confirmed: [] }
  if (!before.size) return j
  const cache = readerCache(db)
  for (const [id, b] of before) {
    const after = excessOf(cache, b.src, b.folderId)
    const gained = [...after].filter((u) => !b.excess.has(u))
    const widens = mode === 'rules' ? gained.length > 0 : b.w.status === 'tracked' && b.excess.size === 0 && after.size > 0
    if (!widens) continue
    j.copies.push({ id, folderId: b.folderId, sources: b.src, gained })
    gained.forEach((u) => j.people.add(u))
    b.src.forEach((s) => j.sources.add(s))
  }
  return j
}

/** Close (pending) or confirm each widening copy. Inside the caller's transaction. */
export function applyJudgement(db: DB, before: Snapshot, j: Judgement, confirmBy: number | null, now = Date.now()) {
  for (const c of j.copies) {
    const b = before.get(c.id)!
    const w = db.query<WidenedRow, [number]>('SELECT * FROM widened WHERE id = ?').get(c.id)
    if (!w) continue
    db.query('UPDATE widened SET path = ?, target_folder_id = ?, judged_at = ? WHERE id = ?').run(b.real, c.folderId, now, c.id)
    if (confirmBy != null && canConfirmWidened(db, c.id, confirmBy)) {
      db.query("UPDATE widened SET status = 'confirmed', widening = 1, ever_widening = 1, confirmed_at = ?, confirmed_by = ? WHERE id = ?").run(now, confirmBy, c.id)
      db.query('UPDATE quarantine SET released_at = ?, released_by = ? WHERE widened_id = ? AND released_at IS NULL').run(now, confirmBy, c.id)
      addEvent(db, { kind: 'confirmed', path: b.real, dev: w.dev, ino: w.ino, folderId: c.folderId, at: now, detail: { widened: c.id, by: confirmBy, with: 'share' } })
      j.confirmed.push(c.id)
    } else {
      markPending(db, { ...w, path: b.real, target_folder_id: c.folderId }, c.sources, now, true)
      j.pending.push(c.id)
    }
  }
}

export interface RejudgeOpts<T> {
  mode: RejudgeMode
  /** who may confirm widening copies at once (the admin or a manager of every source); null: they become pending */
  confirmBy?: number | null
  /** look at the result before anything is closed; throw to roll the whole change back */
  decide?: (j: Judgement, value: T) => void
  /** inside the transaction, after the copies were closed or confirmed: the change's audit row */
  after?: (j: Judgement, value: T) => void
}

/** Run `change` and the R6 re-check of every live copy in one transaction (see the top of this file). */
export function withRejudge<T>(db: DB, change: () => T, opts: RejudgeOpts<T>): { value: T; judgement: Judgement } {
  return db.transaction(() => {
    const before = snapshotCopies(db)
    const value = change()
    const j = judge(db, before, opts.mode)
    opts.decide?.(j, value)
    applyJudgement(db, before, j, opts.confirmBy ?? null)
    opts.after?.(j, value)
    return { value, judgement: j }
  })()
}

/** After the commit: source managers hear "N widened drafts to review" (kind + count + link only, R11). */
export function notifyWidened(emit: ((e: DriveEvent) => void) | undefined, j: Judgement) {
  if (!emit || !j.pending.length) return
  const byTarget = new Map<number, { sources: Set<number>; n: number }>()
  for (const c of j.copies) {
    if (!j.pending.includes(c.id)) continue
    const t = byTarget.get(c.folderId) ?? { sources: new Set<number>(), n: 0 }
    c.sources.forEach((s) => t.sources.add(s))
    t.n++
    byTarget.set(c.folderId, t)
  }
  for (const [target, t] of byTarget) {
    try { emit({ kind: 'widened_draft', count: t.n, sourceFolderIds: [...t.sources], targetFolderId: target }) } catch (e) { console.error('[notify] widened_draft emit failed:', e) }
  }
}

/**
 * Where there is no notify bus (the member sync, the SSO callback, the CLI): the source managers of every copy closed
 * by this change hear "AI-draft copies need your review" (inbox + mail; kind, count, link only — R11); a source
 * without a manager → the admins.
 */
export async function tellWidened(n: NoticeCtx, j: Judgement) {
  if (!j.pending.length) return
  const to = new Map<number, number>()
  const admins = n.db.query<{ id: number }, []>('SELECT id FROM people WHERE admin = 1 AND active = 1').all().map((x) => x.id)
  for (const c of j.copies) {
    if (!j.pending.includes(c.id)) continue
    const heard = new Set<number>()
    for (const s of c.sources) { const m = manageHolders(n.db, s); (m.length ? m : admins).forEach((id) => heard.add(id)) }
    for (const id of heard) to.set(id, (to.get(id) ?? 0) + 1)
  }
  for (const [id, count] of to) await notify(n, [id], 'widened', '/#/folders', { count })
}

/** Live copies at or below a folder (the share dialog's warning: how many AI-draft copies sit here). */
export function copiesUnder(db: DB, real: string): { count: number; sources: Set<number> } {
  const out = { count: 0, sources: new Set<number>() }
  for (const l of locateCopies(db).values()) {
    if (l.real === real || l.real.startsWith(real + '/')) {
      out.count++
      sourcesOf(db, l.w.draft_id).forEach((s) => out.sources.add(s))
    }
  }
  return out
}

/** A managed item moved (rename, move, trash, restore): recorded copy paths follow it (an optimisation: located by identity anyway). */
export function relocateCopies(db: DB, oldReal: string, newReal: string) {
  db.query('UPDATE widened SET path = ? || substr(path, ?) WHERE path = ? OR substr(path, 1, ?) = ?')
    .run(newReal, oldReal.length + 1, oldReal, oldReal.length + 1, oldReal + '/')
}
