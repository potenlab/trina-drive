// In-place reconciler (plan 2.2, 4.1 R1 ⑤–⑦, R6, R10, 11-9): walk what the server can see, diff against the last
// walk by identity, and apply the safety rules.
//   - rename (same identity, same parent) and non-widening moves keep their rules (rules live on the identity);
//   - a move whose new readers are wider than the old location's → quarantined (R10);
//   - a rule-bearing folder whose identity vanished → its last path stays closed ("lost") until released;
//   - links (symlink, hard link, identity at two paths, XSym, Mac alias), NFC collisions → closed and reported;
//   - every outside change → one audit row ("outside-change"), Office lock files and Finder droppings filtered;
//   - new/changed files → hashed (small first), mirrored, matched against drafts (R6 widened copies).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { appendAudit } from '../audit'
import { LIMITS } from '../config'
import type { DB } from '../db'
import { Mirror } from '../mirror'
import { isOffice } from '../names'
import { onRecheckFailure, readersOfChain } from '../policy'
import { ensureFolder, identityKey, isFolder, sameBirth, StoreError, type FolderRow } from '../store'
import { addEvent, addQuarantine, adminIds, manageHolders } from './events'
import { ExtractQueue, extractForIndex, IdentityChanged, openOriginal, readAll } from './extractq'
import { appleDoubleSaysLink, isNoiseName, sniffLink, SNIFF_BYTES } from './linkish'
import { realFs, walkRoot, type FsOps, type Seen } from './walk'
import { blobsFor, DraftCorpus, detectWidened, rejudgeWidened, type IndexedFile } from './widened'

export interface ReconcileOptions {
  /** server data dir: enables the text mirror, extraction and paragraph matching against drafts */
  dataDir?: string
  ops?: FsOps
  /** stop hashing after this many bytes in one pass (the rest is hashed next pass). Default: no limit */
  hashBudgetBytes?: number
  /** extraction jobs at once */
  concurrency?: number
  /** installs that key folders by path + identity (unstable SMB identities): renames are quarantined too (R10) */
  quarantineRenames?: boolean
  now?: () => number
}

export interface ReconcileReport {
  roots: number; entries: number; files: number; dirs: number
  created: number; deleted: number; modified: number; renamed: number; moved: number
  quarantined: number; lost: number; found: number; closed: number; unavailable: string[]
  hashed: number; hashedBytes: number; hashPending: number; extracted: number; extractErrors: number
  widened: number; rejudged: number; flipped: number; audit: number
  ms: { walk: number; apply: number; hash: number; extract: number; total: number }
  baseline: boolean
}

interface PrevRow {
  path: string; root: string; dev: string; ino: string; kind: string; size: number; mtime_ns: string; birth_ns: string
  nlink: number; sha256: string | null; hashed_key: string | null; sniff: string | null; closed: string | null
}
interface Cur extends Seen { sha256: string | null; hashedKey: string | null; sniff: string | null; closed: string | null }

const idOf = (e: { dev: string; ino: string }) => identityKey(e.dev, e.ino)
/** An index entry as seen now (Cur) or by the last pass (PrevRow). */
type Ident = { dev: string; ino: string; birthNs?: string; birth_ns?: string }
const birthOf = (e: Ident) => e.birthNs ?? e.birth_ns ?? ''
/** The folder row of an index entry, if any: same identity and birth time (a reused inode number is another folder). */
type RowOf = (e: Ident) => FolderRow | undefined
/** What a stored hash belongs to. ctime too: mtime can be put back after a same-size rewrite in place (or a reused inode). */
const hashKey = (e: Seen) => `${e.dev}:${e.ino}:${e.size}:${e.mtimeNs}:${e.ctimeNs}`
const under = (p: string, dir: string) => p === dir || p.startsWith(dir + '/')
const sameObject = (p: PrevRow, c: Seen) =>
  p.dev === c.dev && p.ino === c.ino && p.kind === c.kind && (p.birth_ns === '0' || c.birthNs === '0' || p.birth_ns === c.birthNs)

const running = new WeakMap<DB, Promise<unknown>>()

/** One full pass. Passes on the same database never overlap (a second call waits for the first). */
export function reconcile(db: DB, opts: ReconcileOptions = {}): Promise<ReconcileReport> {
  const prev = running.get(db) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(() => runPass(db, opts))
  running.set(db, next)
  return next
}

// ---------- roots ----------
export function addShareRoot(db: DB, dir: string) {
  const real = fs.realpathSync(dir)
  const st = fs.lstatSync(real, { bigint: true })
  if (!st.isDirectory()) throw new StoreError(`${dir} is not a folder`)
  db.query('INSERT OR REPLACE INTO share_roots (path, dev, ino, added_at) VALUES (?, ?, ?, ?)').run(real, String(st.dev), String(st.ino), Date.now())
  return real
}
export const shareRoots = (db: DB) => db.query<{ path: string; dev: string; ino: string }, []>('SELECT path, dev, ino FROM share_roots ORDER BY path').all()

/**
 * Where walks start: share roots, then registered folders that no share root or other registered folder contains.
 * Managed team folders (src/managed) are never walked: only this server writes there and audits each change as it
 * makes it, and a person's move there is theirs to make (not an R10 quarantine).
 */
export function walkRoots(db: DB): { path: string; folder: FolderRow | null }[] {
  const shares = shareRoots(db)
  const reg = db.query<FolderRow, []>('SELECT * FROM folders WHERE registered = 1 AND id NOT IN (SELECT folder_id FROM managed_mounts)').all()
  const out: { path: string; folder: FolderRow | null }[] = shares.map((s) => ({ path: s.path, folder: null }))
  for (const f of reg) {
    if (shares.some((s) => under(f.path, s.path))) continue
    if (reg.some((o) => o !== f && f.path.startsWith(o.path + '/'))) continue
    out.push({ path: f.path, folder: f })
  }
  return out
}

/** The last 'unavailable'/'available' event for a root, so each transition is reported once. */
const lastAvailability = (db: DB, p: string) =>
  db.query<{ kind: string }, [string]>("SELECT kind FROM fs_events WHERE path = ? AND kind IN ('unavailable', 'available') ORDER BY id DESC LIMIT 1").get(p)?.kind

// ---------- the pass ----------
async function runPass(db: DB, opts: ReconcileOptions): Promise<ReconcileReport> {
  const now = opts.now ?? Date.now
  const ops = opts.ops ?? realFs
  const t0 = performance.now()
  const rep: ReconcileReport = { roots: 0, entries: 0, files: 0, dirs: 0, created: 0, deleted: 0, modified: 0, renamed: 0, moved: 0,
    quarantined: 0, lost: 0, found: 0, closed: 0, unavailable: [], hashed: 0, hashedBytes: 0, hashPending: 0, extracted: 0, extractErrors: 0,
    widened: 0, rejudged: 0, flipped: 0, audit: 0, ms: { walk: 0, apply: 0, hash: 0, extract: 0, total: 0 }, baseline: false }
  const audit: { command: string; files: string[]; outcome: string }[] = []
  const admins = adminIds(db)

  const prevRows = db.query<PrevRow, []>('SELECT * FROM fs_index').all()
  const prevByPath = new Map(prevRows.map((r) => [r.path, r]))
  const prevRootsWithRows = new Set(prevRows.map((r) => r.root))

  // ---- 1. roots: registered roots are checked by identity; a renamed root is followed, a vanished one is lost
  const roots = walkRoots(db)
  const walked: { path: string; oldPath: string }[] = []
  const skipped = new Set<string>() // roots whose old rows are kept untouched (unavailable or lost)
  for (const r of roots) {
    let st: fs.BigIntStats | null = null
    try { st = await ops.lstat(r.path) } catch {}
    const okHere = !!st && st.isDirectory() && !st.isSymbolicLink() && (!r.folder || isFolder(r.folder, st.dev, st.ino, st.birthtimeNs))
    if (okHere) {
      if (lastAvailability(db, r.path) === 'unavailable') addEvent(db, { kind: 'available', path: r.path, at: now() })
      walked.push({ path: r.path, oldPath: r.path })
      continue
    }
    if (!r.folder) { // a share root that is not there (mount dropped?)
      if (lastAvailability(db, r.path) !== 'unavailable') addEvent(db, { kind: 'unavailable', path: r.path, at: now(), notify: { admins } })
      rep.unavailable.push(r.path); skipped.add(r.path); continue
    }
    // look for the same identity next to it (a renamed registered folder keeps its rules)
    const parent = path.dirname(r.path)
    let names: string[] | null = null
    try { names = await ops.readdir(parent) } catch {}
    let moved: string | null = null
    for (const n of names ?? []) {
      const p = path.join(parent, n)
      try { const s = await ops.lstat(p); if (s.isDirectory() && !s.isSymbolicLink() && isFolder(r.folder, s.dev, s.ino, s.birthtimeNs)) { moved = p; break } } catch {}
    }
    if (moved) {
      const old = r.folder.path
      renameFolderRows(db, old, moved) // the diff below reports it (event + audit) like any other rename
      walked.push({ path: moved, oldPath: old })
      continue
    }
    skipped.add(r.path)
    const seenBefore = prevByPath.get(r.path)
    const hasLive = db.query("SELECT 1 FROM quarantine WHERE kind = 'lost' AND folder_id = ? AND released_at IS NULL").get(r.folder.id)
    if (names !== null && seenBefore && isFolder(r.folder, seenBefore.dev, seenBefore.ino, seenBefore.birth_ns) && !hasLive) {
      db.transaction(() => {
        const ev = addEvent(db, { kind: 'lost', path: r.path, dev: r.folder!.dev, ino: r.folder!.ino, folderId: r.folder!.id, at: now(),
          detail: { registered: true, replaced: !!st }, notify: { admins, manage: manageHolders(db, [r.folder!.id]) } })
        addQuarantine(db, { kind: 'lost', item: 'dir', dev: r.folder!.dev, ino: r.folder!.ino, path: r.path, folder_id: r.folder!.id, widened_id: null, event_id: ev,
          reason: st ? 'registered folder replaced by another folder of the same name (new identity)' : 'registered folder vanished' }, now())
      })()
      audit.push({ command: `lost: ${r.path}`, files: [r.path], outcome: 'closed' })
      rep.lost++
    } else if (names === null && lastAvailability(db, r.path) !== 'unavailable') {
      addEvent(db, { kind: 'unavailable', path: r.path, folderId: r.folder.id, at: now(), notify: { admins } })
      rep.unavailable.push(r.path)
    }
  }
  rep.roots = walked.length

  // ---- 2. walk
  const cur = new Map<string, Cur>()
  const unreadable: string[] = []
  const sidecars = new Set<string>()
  for (const w of walked) {
    const res = await walkRoot(w.path, ops)
    if (!res) { skipped.add(w.oldPath); continue }
    for (const e of res.entries) cur.set(e.path, { ...e, sha256: null, hashedKey: null, sniff: null, closed: null })
    unreadable.push(...res.unreadable)
    res.sidecars.forEach((x) => sidecars.add(x))
  }
  const walkedOld = new Set(walked.filter((w) => !skipped.has(w.oldPath)).flatMap((w) => [w.path, w.oldPath]))
  // rows under a folder we could not list are kept as they were
  for (const r of prevRows) {
    if (!walkedOld.has(r.root) || cur.has(r.path)) continue
    if (unreadable.some((u) => r.path.startsWith(u + '/'))) cur.set(r.path, fromPrev(r))
  }
  const t1 = performance.now()
  rep.ms.walk = t1 - t0
  rep.baseline = prevRows.length === 0

  // carry hashes forward where the content key (identity, size, mtime) is unchanged, also across renames and moves
  const prevByKey = new Map(prevRows.filter((r) => r.hashed_key).map((r) => [r.hashed_key!, r]))
  for (const c of cur.values()) {
    const p = c.kind === 'file' ? prevByKey.get(hashKey(c)) : undefined
    if (p) { c.sha256 = p.sha256; c.hashedKey = p.hashed_key; c.sniff = p.sniff }
  }

  // ---- 3. diff by identity
  const considered = prevRows.filter((r) => walkedOld.has(r.root))
  const curById = groupBy([...cur.values()], idOf)
  const prevIdx = new Map(considered.map((r) => [r.path, r]))
  const unresolved: Cur[] = []
  const modified: Cur[] = []
  for (const c of cur.values()) {
    const p = prevIdx.get(c.path)
    if (p && sameObject(p, c)) {
      if (c.kind === 'file' && (p.size !== c.size || p.mtime_ns !== c.mtimeNs)) modified.push(c)
    } else unresolved.push(c)
  }
  const gone = considered.filter((r) => { const c = cur.get(r.path); return !c || !sameObject(r, c) })
  const goneById = groupBy(gone, idOf)
  const consumed = new Set<string>()
  const moves: { from: string; to: string; c: Cur }[] = []
  const created: Cur[] = []
  for (const c of unresolved) {
    const cands = (goneById.get(idOf(c)) ?? []).filter((q) => !consumed.has(q.path) && sameObject(q, c))
    const q = cands.find((x) => path.basename(x.path) === path.basename(c.path)) ?? cands[0]
    if (q) { consumed.add(q.path); moves.push({ from: q.path, to: c.path, c }) }
    else {
      const p = prevIdx.get(c.path)
      if (p && p.kind === 'file' && c.kind === 'file') modified.push(c) // same path, new identity: saved by write-new-then-rename
      else created.push(c)
    }
  }
  const deleted = gone.filter((r) => !consumed.has(r.path) && !(r.kind === 'file' && cur.get(r.path)?.kind === 'file'))

  // top-level only: children of a moved/created/deleted folder travel with it
  const movedDirs = new Map(moves.filter((m) => m.c.kind === 'dir').map((m) => [m.to, m.from]))
  const topMoves = moves.filter((m) => movedDirs.get(path.dirname(m.to)) !== path.dirname(m.from))
  const createdSet = new Set(created.map((c) => c.path))
  const deletedSet = new Set(deleted.map((r) => r.path))
  const topOf = (p: string, set: Set<string>) => { let t = p; while (set.has(path.dirname(t))) t = path.dirname(t); return t }
  const createdTop = countTops(created.map((c) => c.path), createdSet, topOf)
  const deletedTop = countTops(deleted.map((r) => r.path), deletedSet, topOf)
  const oldRoot = new Map(walked.map((w) => [w.path, w.oldPath]))
  const silentRoot = (root: string) => !prevRootsWithRows.has(oldRoot.get(root) ?? root) // first walk of this root: a baseline, not changes
  const quiet = (p: string) => isNoiseName(path.basename(p))

  // ---- 4. apply (one transaction): folder paths, lost/found, R10, closures, index, audit
  const folderRows = db.query<FolderRow, []>('SELECT * FROM folders').all()
  const rowById = new Map(folderRows.map((r) => [identityKey(r.dev, r.ino), r]))
  const rowOf: RowOf = (e) => { const r = rowById.get(idOf(e)); return r && sameBirth(r.birth_ns, birthOf(e)) ? r : undefined }
  /** where a folder row's folder is now: same identity and birth time */
  const curOf = (r: FolderRow) => (curById.get(identityKey(r.dev, r.ino)) ?? []).filter((c) => sameBirth(r.birth_ns, c.birthNs))
  const ruleBearing = ruleBearingIds(db)
  const closedEvents = new Map<string, string[]>()
  db.transaction(() => {
    // folder rows follow their identity
    for (const r of folderRows) {
      const at = curOf(r).filter((c) => c.kind === 'dir')
      if (at.length === 1 && at[0]!.path !== r.path) db.query('UPDATE folders SET path = ? WHERE id = ?').run(at[0]!.path, r.id)
      // rows from before birth times were kept: record it while the folder is where the row says
      if (at.length === 1 && r.birth_ns === '') db.query('UPDATE folders SET birth_ns = ? WHERE id = ?').run(at[0]!.birthNs, r.id)
    }

    // lost: a rule-bearing folder seen last time whose identity is nowhere now
    const prevById = groupBy(considered, idOf)
    for (const r of folderRows) {
      if (!ruleBearing.has(r.id) || curOf(r).length) continue
      const before = (prevById.get(identityKey(r.dev, r.ino)) ?? []).find((p) => p.kind === 'dir' && sameBirth(r.birth_ns, p.birth_ns))
      if (!before || unreadable.some((u) => under(before.path, u))) continue
      if (roots.some((x) => x.folder?.id === r.id)) continue // registered roots were judged in step 1
      const ev = addEvent(db, { kind: 'lost', path: before.path, dev: r.dev, ino: r.ino, folderId: r.id, at: now(),
        notify: { admins, manage: manageHolders(db, chain(before.path, prevIdx, rowOf).map((x) => x.id)) } })
      addQuarantine(db, { kind: 'lost', item: 'dir', dev: r.dev, ino: r.ino, path: before.path, folder_id: r.id, widened_id: null, event_id: ev,
        reason: 'a folder with rules vanished; its path stays closed to agents until the admin releases it' }, now())
      audit.push({ command: `lost: ${before.path}`, files: [before.path], outcome: 'closed' })
      rep.lost++
    }
    // found: a lost identity is back (same or another path)
    for (const q of db.query<{ id: number; dev: string; ino: string; path: string; folder_id: number | null; birth: string | null }, []>(
      `SELECT q.id, q.dev, q.ino, q.path, q.folder_id, f.birth_ns AS birth FROM quarantine q LEFT JOIN folders f ON f.id = q.folder_id
       WHERE q.kind = 'lost' AND q.released_at IS NULL`).all()) {
      const at = (curById.get(identityKey(q.dev, q.ino)) ?? []).filter((c) => c.kind === 'dir' && sameBirth(q.birth ?? '', c.birthNs))
      if (at.length !== 1) continue
      const c = at[0]!
      db.query('UPDATE quarantine SET released_at = ?, reason = reason || ? WHERE id = ?').run(now(), ` (found again at ${c.path})`, q.id)
      addEvent(db, { kind: 'found', path: c.path, oldPath: q.path, dev: q.dev, ino: q.ino, folderId: q.folder_id, at: now(), notify: { admins } })
      rep.found++
      if (c.path !== q.path && !moves.some((m) => m.to === c.path)) topMoves.push({ from: q.path, to: c.path, c })
    }

    // R10: renames keep rules; moves that widen readers are quarantined
    for (const m of topMoves) {
      const sameParent = path.dirname(m.from) === path.dirname(m.to) ||
        idOfPath(prevIdx, path.dirname(m.from)) === idOfPath(cur, path.dirname(m.to))
      const row = rowOf(m.c)
      const bearing = !!row && ruleBearing.has(row.id)
      // path + identity installs (unstable SMB identities) quarantine every rename too (R10, last sentence)
      const widen = sameParent ? !!opts.quarantineRenames : movesWiden(db, m, prevIdx, cur, folderRows, rowOf, ruleBearing)
      if (sameParent) rep.renamed++; else rep.moved++
      const oldChain = chain(m.c.kind === 'dir' ? m.from : path.dirname(m.from), prevIdx, rowOf)
      if (widen) {
        const folderId = m.c.kind === 'dir' ? ensureFolder(db, m.to, m.c.dev, m.c.ino, m.c.birthNs) : null
        const ev = addEvent(db, { kind: 'quarantined', path: m.to, oldPath: m.from, dev: m.c.dev, ino: m.c.ino, folderId, at: now(),
          detail: { item: m.c.kind === 'dir' ? 'dir' : 'file', why: sameParent ? 'rename (path + identity install)' : 'move widens readers' },
          notify: { admins, manage: manageHolders(db, oldChain.map((x) => x.id)) } })
        addQuarantine(db, { kind: 'moved', item: m.c.kind === 'dir' ? 'dir' : 'file', dev: m.c.dev, ino: m.c.ino, path: m.to, folder_id: folderId, widened_id: null,
          event_id: ev, reason: sameParent ? 'renamed (path + identity install)' : 'moved to a place with wider readers' }, now())
        rep.quarantined++
      } else if (bearing) {
        addEvent(db, { kind: sameParent ? 'renamed' : 'moved', path: m.to, oldPath: m.from, dev: m.c.dev, ino: m.c.ino, folderId: row!.id, at: now(),
          notify: { admins, manage: manageHolders(db, oldChain.map((x) => x.id)) } })
      }
      if (!quiet(m.to) && !silentRoot(m.c.root)) audit.push({ command: `${sameParent ? 'renamed' : 'moved'}: ${m.from} -> ${m.to}`, files: [m.to, m.from], outcome: widen ? 'quarantined' : 'rules kept' })
    }

    // R1 ⑤ / NFC closures
    for (const c of cur.values()) {
      const shared = (curById.get(idOf(c))?.length ?? 0) > 1
      c.closed = c.kind === 'symlink' ? 'symlink' : c.kind === 'other' ? 'special' : c.nfcCollision ? 'nfc_collision'
        : c.kind === 'file' && c.nlink > 1 ? 'hardlink' : shared ? 'shared_identity' : c.sniff
      if (c.closed && prevByPath.get(c.path)?.closed !== c.closed) noteClosed(closedEvents, c.closed, c.path)
    }

    // the index itself
    const del = db.query('DELETE FROM fs_index WHERE path = ?')
    for (const r of prevRows) {
      if (skipped.has(r.root) && !walkedOld.has(r.root)) continue
      if (!cur.has(r.path)) del.run(r.path)
    }
    const put = db.query(`INSERT OR REPLACE INTO fs_index (path, root, dev, ino, kind, size, mtime_ns, birth_ns, nlink, sha256, hashed_key, sniff, closed, seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    const at = now()
    for (const c of cur.values()) put.run(c.path, c.root, c.dev, c.ino, c.kind, c.size, c.mtimeNs, c.birthNs, c.nlink, c.sha256, c.hashedKey, c.sniff, c.closed, at)

    // outside changes
    for (const [top, n] of createdTop) {
      const c = cur.get(top)!
      if (silentRoot(c.root) || quiet(top)) continue
      audit.push({ command: `created: ${top}${n > 1 ? ` (+${n - 1} inside)` : ''}`, files: [top], outcome: 'recorded' })
    }
    for (const [top, n] of deletedTop) {
      if (quiet(top)) continue
      audit.push({ command: `deleted: ${top}${n > 1 ? ` (+${n - 1} inside)` : ''}`, files: [top], outcome: 'recorded' })
    }
    for (const c of modified) if (!quiet(c.path) && !silentRoot(c.root)) audit.push({ command: `modified: ${c.path}`, files: [c.path], outcome: 'recorded' })
    flushClosed(db, closedEvents, admins, now(), rep)
    for (const a of audit) appendAudit(db, { personId: null, tokenId: null, tool: 'outside-change', command: a.command, files: a.files, outcome: a.outcome })
  })()
  rep.audit = audit.length
  rep.created = [...createdTop.keys()].filter((t) => !silentRoot(cur.get(t)!.root)).length
  rep.deleted = deletedTop.size; rep.modified = modified.length
  rep.entries = cur.size
  for (const c of cur.values()) { if (c.kind === 'file') rep.files++; else if (c.kind === 'dir') rep.dirs++ }
  const t2 = performance.now()
  rep.ms.apply = t2 - t1

  // ---- 5. hash new/changed files (small first), sniff link-files, then mirror + widened matching
  const registered = db.query<{ path: string }, []>('SELECT path FROM folders WHERE registered = 1').all().map((r) => r.path)
  const todo = [...cur.values()].filter((c) => c.kind === 'file' && !c.sha256).sort((a, b) => a.size - b.size)
  const budget = opts.hashBudgetBytes ?? Infinity
  const fresh: { c: Cur; texty: boolean; bytes: Uint8Array | null }[] = []
  const upd = db.query('UPDATE fs_index SET sha256 = ?, hashed_key = ?, sniff = ?, closed = coalesce(closed, ?) WHERE path = ? AND dev = ? AND ino = ?')
  // hashes are written in batches (one transaction per batch), yielding to the event loop between batches
  let batch: Cur[] = []
  let batchBytes = 0
  const flush = () => {
    db.transaction(() => { for (const c of batch) upd.run(c.sha256, c.hashedKey, c.sniff, c.sniff, c.path, c.dev, c.ino) })()
    batch = []; batchBytes = 0
  }
  for (const c of todo) {
    if (rep.hashedBytes + c.size > budget && rep.hashed > 0) { rep.hashPending++; continue }
    const h = hashFile(c)
    if (!h) continue
    rep.hashed++; rep.hashedBytes += c.size
    c.sha256 = h.sha; c.hashedKey = hashKey(c); c.sniff = h.sniff ?? (sidecars.has(c.path) ? appleDoubleSniff(c.path) : null)
    if (c.sniff && !c.closed) { c.closed = c.sniff; noteClosed(closedEvents, c.sniff, c.path) }
    batch.push(c)
    if (!c.closed) fresh.push({ c, texty: isOffice(c.path) || !h.binary, bytes: h.bytes })
    if (batch.length >= 500 || (batchBytes += c.size) > 32 * 1024 * 1024) { flush(); await new Promise((r) => setImmediate(r)) }
  }
  flush()
  db.transaction(() => flushClosed(db, closedEvents, admins, now(), rep))()
  const t3 = performance.now()
  rep.ms.hash = t3 - t2

  const parentOf = (c: Cur) => { const p = cur.get(path.dirname(c.path)); return p ? { path: p.path, dev: p.dev, ino: p.ino, birthNs: p.birthNs } : null }
  const mirror = opts.dataDir ? new Mirror(db, path.join(opts.dataDir, 'mirror')) : null
  let corpus: DraftCorpus | null = null
  const corpusFor = () => (corpus ??= opts.dataDir ? DraftCorpus.load(db, blobsFor(opts.dataDir)) : null)
  const q = new ExtractQueue(opts.concurrency ?? 2)
  const hasDrafts = !!db.query('SELECT 1 FROM draft_versions LIMIT 1').get()
  for (const { c, texty, bytes } of fresh) {
    const parent = parentOf(c)
    if (!parent) continue
    const f: IndexedFile = { path: c.path, dev: c.dev, ino: c.ino, sha256: c.sha256!, parent }
    const inRegistered = registered.some((r) => under(c.path, r))
    if (!mirror || !texty || !inRegistered || c.size > LIMITS.fileBytes) {
      if (hasDrafts) rep.widened += detectWidened(db, null, f, null, now()).length
      continue
    }
    q.push({ size: c.size, run: async () => {
      const b = bytes ?? readOriginalBytes(c)
      if (!b) return
      const text = await mirror.ingest({ name: path.basename(c.path), dev: c.dev, ino: c.ino, size: c.size, mtimeNs: c.mtimeNs, ctimeNs: c.ctimeNs }, b, extractForIndex)
      rep.extracted++
      if (hasDrafts) rep.widened += detectWidened(db, corpusFor(), f, text, now()).length
    } })
  }
  await q.drain()
  rep.extractErrors = q.errors
  const r = rejudgeWidened(db, now())
  rep.rejudged = r.judged; rep.flipped = r.flipped.length
  const t4 = performance.now()
  rep.ms.extract = t4 - t3
  rep.ms.total = t4 - t0
  return rep
}

// ---------- helpers ----------
function fromPrev(r: PrevRow): Cur {
  return { path: r.path, root: r.root, dev: r.dev, ino: r.ino, kind: r.kind as Cur['kind'], size: r.size, mtimeNs: r.mtime_ns, ctimeNs: '', birthNs: r.birth_ns,
    nlink: r.nlink, nfcCollision: r.closed === 'nfc_collision', sha256: r.sha256, hashedKey: r.hashed_key, sniff: r.sniff, closed: r.closed }
}

function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>()
  for (const x of xs) { const k = key(x); const l = m.get(k); if (l) l.push(x); else m.set(k, [x]) }
  return m
}

function countTops(paths: string[], set: Set<string>, topOf: (p: string, s: Set<string>) => string) {
  const m = new Map<string, number>()
  for (const p of paths) { const t = topOf(p, set); m.set(t, (m.get(t) ?? 0) + 1) }
  return m
}

const idOfPath = (m: Map<string, Ident>, p: string) => { const e = m.get(p); return e ? `${idOf(e)}:${birthOf(e)}` : `missing:${p}` }

/** Update a folder row and every row below it after the folder was found under a new path. */
function renameFolderRows(db: DB, from: string, to: string) {
  for (const r of db.query<{ id: number; path: string }, []>('SELECT id, path FROM folders').all()) {
    if (under(r.path, from)) db.query('UPDATE folders SET path = ? WHERE id = ?').run(to + r.path.slice(from.length), r.id)
  }
}

/** Folder rows (by identity) of `p` and its ancestors as an index saw them, from the top registered folder down. */
function chain(p: string, idx: Map<string, Ident>, rowOf: RowOf): FolderRow[] {
  const parts: string[] = []
  for (let c = p; ; c = path.dirname(c)) { parts.unshift(c); if (path.dirname(c) === c) break }
  const out: FolderRow[] = []
  for (const a of parts) {
    const e = idx.get(a)
    const r = e && rowOf(e)
    if (r) out.push(r)
  }
  const top = out.findIndex((r) => r.registered)
  return top < 0 ? [] : out.slice(top)
}

/** R10: does some reader of the new location (R5 target) not read the old location (R5 source)? */
function widens(db: DB, oldChain: FolderRow[], newChain: FolderRow[]): boolean {
  const src = readersOfChain(db, oldChain, 'source')
  for (const u of readersOfChain(db, newChain, 'target')) if (!src.has(u)) return true
  return false
}

function movesWiden(db: DB, m: { from: string; to: string; c: Cur }, prevIdx: Map<string, PrevRow>, cur: Map<string, Cur>,
  rows: FolderRow[], rowOf: RowOf, ruleBearing: Set<number>): boolean {
  if (m.c.kind !== 'dir') return widens(db, chain(path.dirname(m.from), prevIdx, rowOf), chain(path.dirname(m.to), cur, rowOf))
  if (widens(db, chain(m.from, prevIdx, rowOf), chain(m.to, cur, rowOf))) return true
  // folders with their own rules inside the moved folder are judged too (their readers can change differently)
  for (const r of rows) {
    if (!ruleBearing.has(r.id)) continue
    const at = findByIdentity(cur, r)
    if (!at || !at.path.startsWith(m.to + '/')) continue
    const oldP = m.from + at.path.slice(m.to.length)
    if (widens(db, chain(oldP, prevIdx, rowOf), chain(at.path, cur, rowOf))) return true
  }
  return false
}

const identityCache = new WeakMap<Map<string, Cur>, Map<string, Cur>>()
function findByIdentity(cur: Map<string, Cur>, r: FolderRow): Cur | null {
  let m = identityCache.get(cur)
  if (!m) { m = new Map([...cur.values()].filter((c) => c.kind === 'dir').map((c) => [idOf(c), c])); identityCache.set(cur, m) }
  const c = m.get(identityKey(r.dev, r.ino))
  return c && sameBirth(r.birth_ns, c.birthNs) ? c : null
}

/** Folder ids that carry something an identity loss would orphan: rules, flags, breaks, manage, scopes, registration. */
function ruleBearingIds(db: DB): Set<number> {
  const s = new Set<number>()
  for (const r of db.query<{ folder_id: number }, []>('SELECT DISTINCT folder_id FROM rules UNION SELECT DISTINCT folder_id FROM manage_grants').all()) s.add(r.folder_id)
  for (const r of db.query<{ id: number }, []>('SELECT id FROM folders WHERE registered = 1 OR inherit_break = 1 OR no_ai = 1 OR quarantine = 1 OR widened_pending = 1 OR personal_owner IS NOT NULL').all()) s.add(r.id)
  for (const t of db.query<{ scope: string }, []>('SELECT scope FROM tokens WHERE scope IS NOT NULL AND revoked_at IS NULL').all()) for (const id of JSON.parse(t.scope) as number[]) s.add(id)
  return s
}

function noteClosed(m: Map<string, string[]>, reason: string, p: string) {
  const l = m.get(reason)
  if (l) l.push(p); else m.set(reason, [p])
}

/** One 'closed' event per reason per pass (a first walk over a big share can find many). */
function flushClosed(db: DB, m: Map<string, string[]>, admins: number[], at: number, rep: ReconcileReport) {
  for (const [reason, paths] of m) {
    addEvent(db, { kind: 'closed', at, path: paths[0], detail: { reason, count: paths.length, paths: paths.slice(0, 100) }, notify: { admins } })
    rep.closed += paths.length
  }
  m.clear()
}

/** sha256 + link sniff of one file, opened without following links and checked against the walk. */
function hashFile(c: Cur): { sha: string; sniff: 'xsym' | 'alias' | null; binary: boolean; bytes: Uint8Array | null } | null {
  let fd: number
  try { fd = openOriginal(c.path, { dev: c.dev, ino: c.ino, size: c.size, mtimeNs: c.mtimeNs }) } catch { return null }
  try {
    const h = crypto.createHash('sha256')
    const chunk = Buffer.alloc(Math.min(Math.max(c.size, 1), 1024 * 1024))
    let off = 0, head: Uint8Array | null = null, keep: Buffer | null = c.size <= 256 * 1024 ? Buffer.alloc(c.size) : null
    while (off < c.size) {
      const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, c.size - off), off)
      if (n <= 0) break
      if (!head) head = Uint8Array.from(chunk.subarray(0, Math.min(n, 8192)))
      if (keep) chunk.copy(keep, off, 0, n)
      h.update(chunk.subarray(0, n))
      off += n
    }
    if (off !== c.size) return null // changed under us: next pass
    head ??= new Uint8Array(0)
    return { sha: h.digest('hex'), sniff: sniffLink(head.subarray(0, SNIFF_BYTES), c.size), binary: head.includes(0), bytes: keep }
  } finally { fs.closeSync(fd) }
}

function readOriginalBytes(c: Cur): Uint8Array | null {
  try {
    const fd = openOriginal(c.path, { dev: c.dev, ino: c.ino, size: c.size, mtimeNs: c.mtimeNs })
    try { return readAll(fd, c.size) } finally { fs.closeSync(fd) }
  } catch (e) { if (e instanceof IdentityChanged || (e as { code?: string }).code) return null; throw e }
}

/** The `._name` AppleDouble sidecar (kept by SMB/NAS for Mac clients) marks the file as an alias or Mac symlink. */
function appleDoubleSniff(p: string): 'alias' | null {
  const side = path.join(path.dirname(p), '._' + path.basename(p))
  try {
    const st = fs.lstatSync(side, { bigint: true })
    if (!st.isFile() || st.size > 64n * 1024n) return null
    const fd = openOriginal(side, { dev: String(st.dev), ino: String(st.ino) })
    try { return appleDoubleSaysLink(readAll(fd, Number(st.size))) ? 'alias' : null } finally { fs.closeSync(fd) }
  } catch { return null }
}

// ---------- the loop ----------
export interface Reconciler { runNow(): void; stop(): void; last: () => ReconcileReport | null; idle(): Promise<void> }

/**
 * Reconcile on start, every `intervalMs` (default 5 min), and soon after an fs.watch hint (local disks; SMB does not
 * deliver other people's changes, so the interval is what counts there) or a failed read-time re-check (R1 ⑦).
 */
export function startReconciler(db: DB, opts: ReconcileOptions & { intervalMs?: number; watch?: boolean; debounceMs?: number; log?: (s: string) => void } = {}): Reconciler {
  const log = opts.log ?? ((s: string) => console.error(s))
  let last: ReconcileReport | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let current: Promise<unknown> = Promise.resolve()
  const watchers: fs.FSWatcher[] = []
  const run = () => {
    timer = null
    current = reconcile(db, opts).then((r) => {
      last = r
      if (r.audit || r.quarantined || r.lost || r.closed || r.widened || r.flipped) log(`reconcile: ${summary(r)}`)
    }, (e) => log(`reconcile failed: ${(e as Error).message}`))
    return current
  }
  const soon = () => { if (!stopped && !timer) timer = setTimeout(run, opts.debounceMs ?? 2000) }
  const interval = setInterval(() => { if (!stopped) run() }, opts.intervalMs ?? 5 * 60_000)
  if (opts.watch !== false) {
    for (const r of walkRoots(db)) {
      try { watchers.push(fs.watch(r.path, { recursive: true, persistent: false }, () => soon())) } catch {}
    }
  }
  onRecheckFailure(() => soon())
  run()
  return {
    runNow: () => { if (timer) clearTimeout(timer); run() },
    stop: () => { stopped = true; clearInterval(interval); if (timer) clearTimeout(timer); watchers.forEach((w) => w.close()); onRecheckFailure(null) },
    last: () => last,
    idle: () => current.then(() => {}),
  }
}

export function summary(r: ReconcileReport): string {
  const parts = [`${r.entries} entries (${r.files} files, ${r.dirs} folders) in ${r.roots} roots`, `${Math.round(r.ms.total)} ms`]
  const n = (k: keyof ReconcileReport, label: string) => { const v = r[k]; if (typeof v === 'number' && v) parts.push(`${v} ${label}`) }
  n('created', 'created'); n('deleted', 'deleted'); n('modified', 'modified'); n('renamed', 'renamed'); n('moved', 'moved')
  n('quarantined', 'quarantined'); n('lost', 'lost'); n('found', 'found'); n('closed', 'closed'); n('hashed', 'hashed'); n('hashPending', 'left to hash')
  n('extracted', 'extracted'); n('widened', 'widened'); n('flipped', 'flipped by re-judging')
  if (r.unavailable.length) parts.push(`unavailable: ${r.unavailable.join(', ')}`)
  if (r.baseline) parts.push('baseline')
  return parts.join(', ')
}
