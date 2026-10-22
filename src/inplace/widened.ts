// R6 widened-draft detection: a NAS file that holds a draft's content (same sha256, or ≥ 30% paragraph overlap)
// sitting in a folder whose readers are wider than the draft's sources. Such a copy is closed to agents
// ("widened_pending", R1 ②) until the admin or a manager of every source folder confirms it; after that, reading it
// brings the draft's sources into the reader's window (session.ts). Records are never deleted.
import path from 'node:path'
import type { DB } from '../db'
import { Blobs } from '../drafts'
import { isWidening } from '../policy'
import { nfc } from '../names'
import { ensureFolder } from '../store'
import { addEvent, addQuarantine, adminIds, chainByPath, manageHolders } from './events'

/** Share of the draft's paragraphs (or of the file's text) that must reappear for a copy to count (plan 5.1). */
export const WIDEN_OVERLAP = 0.3
/** A draft paragraph reappears when this share of its shingles is in the file (tolerates small edits). */
export const PARA_MATCH = 0.6
const K = 8 // characters per shingle (whitespace removed, so reflowed lines still match)
const MIN_PARA = 12 // shorter paragraphs (headings, "---") are not evidence
const ANCHORS = 4
const MAX_TEXT = 8 * 1024 * 1024

const norm = (s: string) => nfc(s).toLowerCase().replace(/\s+/g, '')

/** Rolling polynomial hash of every K-character window. */
export function shingles(normalized: string): Int32Array {
  const n = normalized.length - K + 1
  if (n <= 0) return new Int32Array(0)
  const out = new Int32Array(n)
  const B = 1000003
  let pow = 1
  for (let i = 0; i < K - 1; i++) pow = Math.imul(pow, B)
  let h = 0
  for (let i = 0; i < K; i++) h = (Math.imul(h, B) + normalized.charCodeAt(i)) | 0
  out[0] = h
  for (let i = 1; i < n; i++) {
    h = (Math.imul(h - Math.imul(normalized.charCodeAt(i - 1), pow), B) + normalized.charCodeAt(i + K - 1)) | 0
    out[i] = h
  }
  return out
}

/** Paragraphs = blocks separated by blank lines, whitespace-normalized; short ones dropped. */
export function paragraphs(text: string): string[] {
  return text.split(/\r?\n[ \t　]*\r?\n/).map(norm).filter((p) => p.length >= MIN_PARA)
}

interface Para { sh: Int32Array; chars: number }
interface DraftDoc { draftId: number; version: number; paras: Para[] }

const parsed = new Map<string, Para[]>() // by blob sha256: drafts do not change under a sha

function parseDraft(text: string): Para[] {
  return paragraphs(text).map((p) => ({ sh: Int32Array.from(new Set(shingles(p))), chars: p.length }))
}

/** All kept draft versions (also of deleted drafts: a deleted draft can still have been copied), indexed by anchors. */
export class DraftCorpus {
  readonly docs: DraftDoc[] = []
  private readonly anchors = new Map<number, number[]>()

  static load(db: DB, blobs: Blobs): DraftCorpus {
    const c = new DraftCorpus()
    for (const v of db.query<{ draft_id: number; version: number; sha256: string }, []>('SELECT draft_id, version, sha256 FROM draft_versions').all()) {
      let paras = parsed.get(v.sha256)
      if (!paras) {
        let text: string
        try { text = new TextDecoder().decode(blobs.get(v.sha256)) } catch { continue }
        paras = parseDraft(text)
        parsed.set(v.sha256, paras)
      }
      c.add({ draftId: v.draft_id, version: v.version, paras })
    }
    return c
  }

  add(doc: DraftDoc) {
    if (!doc.paras.length) return
    const i = this.docs.push(doc) - 1
    for (const p of doc.paras) {
      for (const h of [...p.sh].sort((a, b) => a - b).slice(0, ANCHORS)) {
        const l = this.anchors.get(h)
        if (!l) this.anchors.set(h, [i])
        else if (l[l.length - 1] !== i) l.push(i)
      }
    }
  }

  /** Best version per draft whose overlap with `text` reaches WIDEN_OVERLAP. */
  match(text: string): { draftId: number; version: number; overlap: number }[] {
    if (!this.docs.length) return []
    const t = norm(text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text)
    if (t.length < MIN_PARA) return []
    const fileSet = new Set(shingles(t))
    const cand = new Set<number>()
    for (const h of fileSet) for (const i of this.anchors.get(h) ?? []) cand.add(i)
    const best = new Map<number, { draftId: number; version: number; overlap: number }>()
    for (const i of cand) {
      const d = this.docs[i]!
      let matched = 0, matchedChars = 0
      for (const p of d.paras) {
        let hit = 0
        for (const h of p.sh) if (fileSet.has(h)) hit++
        if (hit >= PARA_MATCH * p.sh.length) { matched++; matchedChars += p.chars }
      }
      const overlap = Math.max(matched / d.paras.length, Math.min(1, matchedChars / t.length))
      if (overlap >= WIDEN_OVERLAP && overlap > (best.get(d.draftId)?.overlap ?? -1)) best.set(d.draftId, { draftId: d.draftId, version: d.version, overlap })
    }
    return [...best.values()]
  }
}

export interface IndexedFile { path: string; dev: string; ino: string; sha256: string; parent: { path: string; dev: string; ino: string } }

interface WidenedRow {
  id: number; dev: string; ino: string; path: string; sha256: string; draft_id: number; draft_version: number
  writer_person_id: number; writer_token_id: number; target_folder_id: number; match: string; overlap: number
  widening: number; ever_widening: number; status: 'tracked' | 'pending' | 'confirmed'
}

const sourcesOf = (db: DB, draftId: number) =>
  db.query<{ folder_id: number }, [number]>('SELECT folder_id FROM draft_src WHERE draft_id = ?').all(draftId).map((r) => r.folder_id)

function notifyFor(db: DB, src: number[], target: number) {
  const chainIds = (id: number) => {
    const f = db.query<{ path: string }, [number]>('SELECT path FROM folders WHERE id = ?').get(id)
    return f ? chainByPath(db, f.path).map((r) => r.id) : []
  }
  return { admins: adminIds(db), sourceManage: manageHolders(db, src.flatMap(chainIds)), targetManage: manageHolders(db, chainIds(target)) }
}

/** Put a copy into "widened pending": close it to agents and tell the source managers (R6, R11). */
function markPending(db: DB, w: WidenedRow, src: number[], now: number, rejudged: boolean) {
  db.query("UPDATE widened SET status = 'pending', widening = 1, ever_widening = 1, judged_at = ? WHERE id = ?").run(now, w.id)
  const ev = addEvent(db, { kind: 'widened', path: w.path, dev: w.dev, ino: w.ino, folderId: w.target_folder_id, at: now,
    detail: { widened: w.id, draft: w.draft_id, version: w.draft_version, writer: w.writer_person_id, token: w.writer_token_id,
      sources: src, target: w.target_folder_id, match: w.match, overlap: Math.round(w.overlap * 100) / 100, rejudged },
    notify: notifyFor(db, src, w.target_folder_id) })
  if (!db.query('SELECT 1 FROM quarantine WHERE widened_id = ? AND released_at IS NULL').get(w.id)) {
    addQuarantine(db, { kind: 'widened', item: 'file', dev: w.dev, ino: w.ino, path: w.path, folder_id: w.target_folder_id, widened_id: w.id, event_id: ev,
      reason: `holds draft ${w.draft_id} v${w.draft_version} (${w.match}) and its readers are wider than the draft's sources` }, now)
  }
}

const targetFolder = (db: DB, f: IndexedFile) => ensureFolder(db, f.parent.path, BigInt(f.parent.dev), BigInt(f.parent.ino))

/**
 * Judge one new or changed NAS file against every draft: exact sha256 first, then paragraph overlap of `text`
 * (null when the file has no text). Returns the widened rows that are pending now.
 */
export function detectWidened(db: DB, corpus: DraftCorpus | null, f: IndexedFile, text: string | null, now = Date.now()): number[] {
  const found = new Map<number, { version: number; match: string; overlap: number }>()
  for (const r of db.query<{ draft_id: number; version: number }, [string]>('SELECT draft_id, version FROM draft_versions WHERE sha256 = ? ORDER BY version DESC').all(f.sha256)) {
    if (!found.has(r.draft_id)) found.set(r.draft_id, { version: r.version, match: 'sha256', overlap: 1 })
  }
  if (text && corpus) for (const m of corpus.match(text)) if (!found.has(m.draftId)) found.set(m.draftId, { version: m.version, match: 'paragraphs', overlap: m.overlap })
  const pending: number[] = []
  if (!found.size) return pending
  db.transaction(() => {
    const target = targetFolder(db, f)
    for (const [draftId, m] of found) {
      const d = db.query<{ person_id: number; token_id: number }, [number]>('SELECT person_id, token_id FROM drafts WHERE id = ?').get(draftId)
      if (!d) continue
      const src = sourcesOf(db, draftId)
      const widening = src.length > 0 && isWidening(db, src, target)
      db.query(`INSERT INTO widened (at, dev, ino, path, sha256, draft_id, draft_version, writer_person_id, writer_token_id, target_folder_id, match, overlap,
          widening, ever_widening, status, judged_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'tracked', ?)
        ON CONFLICT (dev, ino, draft_id) DO UPDATE SET path = excluded.path, sha256 = excluded.sha256, draft_version = excluded.draft_version,
          target_folder_id = excluded.target_folder_id, match = excluded.match, overlap = excluded.overlap, widening = excluded.widening,
          ever_widening = max(ever_widening, excluded.widening), judged_at = excluded.judged_at`)
        .run(now, f.dev, f.ino, f.path, f.sha256, draftId, m.version, d.person_id, d.token_id, target, m.match, m.overlap, widening ? 1 : 0, widening ? 1 : 0, now)
      const w = db.query<WidenedRow, [string, string, number]>('SELECT * FROM widened WHERE dev = ? AND ino = ? AND draft_id = ?').get(f.dev, f.ino, draftId)!
      if (widening && w.status === 'tracked') { markPending(db, w, src, now, false); pending.push(w.id) }
      else if (w.status === 'pending') pending.push(w.id)
    }
  })()
  return pending
}

/**
 * Judge every tracked or pending copy again (R6: when rules, groups or NAS readers change, and on every reconcile).
 * A tracked copy that widens now becomes pending; a pending one stays pending until confirmed. Never deletes.
 * The admin layer calls this after any rule / group / NAS-reader / flag change.
 */
export function rejudgeWidened(db: DB, now = Date.now()): { judged: number; flipped: number[] } {
  const flipped: number[] = []
  let judged = 0
  const rows = db.query<WidenedRow, []>("SELECT * FROM widened WHERE status IN ('tracked', 'pending')").all()
  if (!rows.length) return { judged, flipped }
  db.transaction(() => {
    for (const w of rows) {
      const at = db.query<{ path: string }, [string, string]>("SELECT path FROM fs_index WHERE dev = ? AND ino = ? AND kind = 'file'").all(w.dev, w.ino)
      if (at.length !== 1) continue // gone, or at several paths (closed anyway)
      const p = at[0]!.path
      const parent = db.query<{ dev: string; ino: string }, [string]>('SELECT dev, ino FROM fs_index WHERE path = ?').get(path.dirname(p))
      if (!parent) continue
      const target = ensureFolder(db, path.dirname(p), BigInt(parent.dev), BigInt(parent.ino))
      const src = sourcesOf(db, w.draft_id)
      const widening = src.length > 0 && isWidening(db, src, target)
      judged++
      db.query('UPDATE widened SET path = ?, target_folder_id = ?, widening = ?, ever_widening = max(ever_widening, ?), judged_at = ? WHERE id = ?')
        .run(p, target, widening ? 1 : 0, widening ? 1 : 0, now, w.id)
      if (widening && w.status === 'tracked') { markPending(db, { ...w, path: p, target_folder_id: target }, src, now, true); flipped.push(w.id) }
    }
  })()
  return { judged, flipped }
}

export function listWidened(db: DB) {
  return db.query<WidenedRow & { at: number; judged_at: number; confirmed_at: number | null; confirmed_by: number | null }, []>('SELECT * FROM widened ORDER BY id').all()
}

export const blobsFor = (dataDir: string) => new Blobs(path.join(dataDir, 'blobs'))
