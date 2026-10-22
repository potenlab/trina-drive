// One tool call by one token: the policy view, what the call touched (provenance, R3), pending draft writes, and the
// commit that writes touches + drafts + the audit row in one transaction (if the audit row fails, nothing is kept).
import type { DB } from './db'
import { appendAudit } from './audit'
import { LIMITS } from './config'
import { Blobs, canSeeDraft, draftRel, liveDrafts, type Draft } from './drafts'
import { detectLayout } from './layout'
import { inheritedSources } from './inplace/closures'
import { Mirror } from './mirror'
import { Access, type FileEntry, type Node } from './policy'
import { ensureFolder, identityKey, type TokenRow } from './store'

/** A free draft path next to `rel` for a hidden draft moved out of the way: "a/b.md" -> "a/b (earlier 12).md". */
function asidePath(db: DB, tokenId: number, rel: string, id: number): string {
  const slash = rel.lastIndexOf('/') + 1
  const dot = rel.lastIndexOf('.')
  const [stem, ext] = dot > slash ? [rel.slice(0, dot), rel.slice(dot)] : [rel, '']
  const taken = db.query<{ id: number }, [number, string]>('SELECT id FROM drafts WHERE token_id = ? AND path = ? AND deleted_at IS NULL')
  for (let n = 0; ; n++) {
    const p = `${stem} (earlier ${id}${n ? '-' + n : ''})${ext}`
    if (!taken.get(tokenId, p)) return p
  }
}

/** `now` is injectable so the provenance simulation can replay a day. */
export interface Ctx {
  db: DB; dataDir: string; mirror: Mirror; blobs: Blobs; now: () => number
  /** after a call is committed (notify: bulk-read alarm, original-write attempts); errors are logged, never fail the call */
  onCommit?: (s: Session, tool: string, outcome: string) => void
}

export function makeCtx(db: DB, dataDir: string): Ctx {
  const l = detectLayout(dataDir)
  return { db, dataDir, mirror: new Mirror(db, l.mirrorDir), blobs: new Blobs(l.draftsDir), now: Date.now }
}

/** A draft as this call sees it: a stored one (maybe with pending new content) or a new pending one. */
export interface DraftItem { rel: string; own: boolean; draft?: Draft; pending?: Uint8Array }

export class Session {
  readonly access: Access
  private readonly folderTouches = new Map<string, { node: Node; strong: boolean }>()
  private readonly srcTouches = new Map<number, boolean>()
  readonly files = new Set<string>()
  readonly notes = new Set<string>()
  readonly extracted = new Set<string>()
  /** files whose content this call output: vpath -> original size, folder identity (bulk-read alarm) */
  readonly contentFiles = new Map<string, { size: number; folder: string }>()
  /** own draft path -> new content, or null = deleted */
  readonly pending = new Map<string, Uint8Array | null>()
  readonly pendingDirs = new Set<string>()
  private stored: Draft[] | null = null
  private inherited: Map<string, Map<number, boolean>> | null = null

  constructor(readonly ctx: Ctx, readonly token: TokenRow, readdir?: (p: string) => string[]) {
    this.access = Access.forToken(ctx.db, token, readdir)
  }

  // ---------- provenance (R3) ----------
  touchNode(node: Node, strong: boolean) {
    // a folder shown only as a path to something readable below it gives nothing away about itself
    if (!this.access.canRead(node)) return
    const k = identityKey(node.dev, node.ino)
    const t = this.folderTouches.get(k)
    if (!t || (strong && !t.strong)) this.folderTouches.set(k, { node, strong: strong || !!t?.strong })
  }
  touchFile(f: FileEntry, strong: boolean) {
    this.touchNode(f.parent, strong)
    this.files.add(f.vpath)
    if (strong) this.contentFiles.set(f.vpath, { size: f.size, folder: identityKey(f.parent.dev, f.parent.ino) })
    // a NAS copy of a draft (R6, tracked or confirmed) passes the draft's sources on to whoever reads it
    this.inherited ??= inheritedSources(this.ctx.db)
    for (const [id, s] of this.inherited.get(identityKey(f.dev, f.ino)) ?? []) this.srcTouches.set(id, (strong && s) || !!this.srcTouches.get(id))
  }
  /** Reading a draft brings its sources into this token's window. */
  touchDraft(item: DraftItem, strong: boolean) {
    this.files.add('/drafts/' + item.rel)
    for (const [f, s] of item.draft?.src ?? []) this.srcTouches.set(f, (strong && s) || !!this.srcTouches.get(f))
  }

  // ---------- drafts as seen by this call (R4 + pending writes) ----------
  storedDrafts(): Draft[] {
    this.stored ??= liveDrafts(this.ctx.db, this.token.person_id).filter((d) => canSeeDraft(this.access, this.token, d))
    return this.stored
  }
  /** rel path under /drafts -> item */
  draftItems(): Map<string, DraftItem> {
    const out = new Map<string, DraftItem>()
    for (const d of this.storedDrafts()) out.set(draftRel(d, this.token), { rel: draftRel(d, this.token), own: d.token_id === this.token.id, draft: d })
    for (const [rel, content] of this.pending) {
      if (content === null) out.delete(rel)
      else out.set(rel, { ...(out.get(rel) ?? { rel, own: true }), pending: content })
    }
    return out
  }
  draftContent(item: DraftItem): Uint8Array {
    return item.pending ?? this.ctx.blobs.get(item.draft!.sha256)
  }

  // ---------- draft quota ----------
  private quotaBase: { own: Map<string, number>; others: number } | null = null
  /**
   * Why writing `size` bytes to own draft `rel` would take this token or its person over the draft quota (live drafts,
   * latest version; LIMITS.draftFilesPerToken / draftBytesPerToken / draftBytesPerPerson), or null if it may. A write
   * that does not grow the drafts (overwrite with the same or less) is always allowed, so a box over a lowered quota
   * can still be cleaned up. Counts every live draft of the token, also ones it cannot see right now (R4).
   */
  draftQuotaRefusal(rel: string, size: number): string | null {
    if (!this.quotaBase) {
      const own = new Map<string, number>()
      let others = 0
      for (const r of this.ctx.db.query<{ token_id: number; path: string; size: number }, [number]>(`
        SELECT d.token_id, d.path, v.size FROM drafts d
        JOIN draft_versions v ON v.draft_id = d.id AND v.version = (SELECT max(version) FROM draft_versions WHERE draft_id = d.id)
        WHERE d.person_id = ? AND d.deleted_at IS NULL`).all(this.token.person_id)) {
        if (r.token_id === this.token.id) own.set(r.path, r.size)
        else others += r.size
      }
      this.quotaBase = { own, others }
    }
    const own = new Map(this.quotaBase.own)
    for (const [k, c] of this.pending) { if (c === null) own.delete(k); else own.set(k, c.length) }
    const before = own.get(rel)
    if (before !== undefined && size <= before) return null
    own.set(rel, size)
    let bytes = 0
    for (const n of own.values()) bytes += n
    const MB = (n: number) => `${+(n / (1024 * 1024)).toFixed(1)} MB`
    const fix = 'Delete drafts that are no longer needed (rm under /drafts/) or ask a person to move them.'
    if (before === undefined && own.size > LIMITS.draftFilesPerToken) return `draft quota exceeded: a token may keep at most ${LIMITS.draftFilesPerToken} drafts (this one has ${own.size - 1}). ${fix}`
    if (bytes > LIMITS.draftBytesPerToken) return `draft quota exceeded: a token's drafts may hold at most ${MB(LIMITS.draftBytesPerToken)} (this one would hold ${MB(bytes)}). ${fix}`
    if (bytes + this.quotaBase.others > LIMITS.draftBytesPerPerson) return `draft quota exceeded: one person's drafts (all tokens) may hold at most ${MB(LIMITS.draftBytesPerPerson)} (would be ${MB(bytes + this.quotaBase.others)}). ${fix}`
    return null
  }

  /** The token's window now: stored touches in the last 8 hours plus this call's. */
  window(now = this.ctx.now()): Map<number, boolean> {
    const cutoff = now - LIMITS.windowMs
    const out = new Map<number, boolean>()
    for (const r of this.ctx.db.query<{ folder_id: number; strong_at: number | null; weak_at: number | null }, [number, number, number]>(
      'SELECT folder_id, strong_at, weak_at FROM touches WHERE token_id = ? AND (strong_at > ? OR weak_at > ?)').all(this.token.id, cutoff, cutoff)) {
      out.set(r.folder_id, (r.strong_at ?? 0) > cutoff)
    }
    return out
  }

  /** Write touches, pending drafts and the audit row atomically. Throws (and keeps nothing) if any part fails. */
  commit(tool: string, command: string, outcome: string) {
    const db = this.ctx.db
    const shas = new Map<string, string>()
    for (const [rel, c] of this.pending) if (c) shas.set(rel, this.ctx.blobs.put(c))
    db.transaction(() => {
      const now = this.ctx.now()
      const touched = new Map(this.srcTouches)
      for (const { node, strong } of this.folderTouches.values()) {
        const id = ensureFolder(db, node.real, node.dev, node.ino)
        touched.set(id, strong || !!touched.get(id))
      }
      for (const [id, strong] of touched) {
        db.query(`INSERT INTO touches (token_id, folder_id, strong_at, weak_at) VALUES (?, ?, ?, ?)
          ON CONFLICT DO UPDATE SET strong_at = coalesce(excluded.strong_at, strong_at), weak_at = coalesce(excluded.weak_at, weak_at)`)
          .run(this.token.id, id, strong ? now : null, strong ? null : now)
      }
      if (this.pending.size) {
        const win = this.window(now)
        for (const [rel, content] of this.pending) {
          let existing = db.query<{ id: number }, [number, string]>('SELECT id FROM drafts WHERE token_id = ? AND path = ? AND deleted_at IS NULL').get(this.token.id, rel)
          // R4: an own draft this token cannot see now is not there for it. Writing its path starts a new draft (its own
          // sources only); the hidden one is moved aside untouched and shows up there once the token can see it again.
          if (existing && !this.storedDrafts().some((d) => d.id === existing!.id)) {
            if (content === null) continue
            db.query('UPDATE drafts SET path = ? WHERE id = ?').run(asidePath(db, this.token.id, rel, existing.id), existing.id)
            existing = null
          }
          if (content === null) {
            if (existing) db.query('UPDATE drafts SET deleted_at = ? WHERE id = ?').run(now, existing.id)
            continue
          }
          const id = existing?.id ?? Number(db.query('INSERT INTO drafts (token_id, person_id, path, created_at) VALUES (?, ?, ?, ?)').run(this.token.id, this.token.person_id, rel, now).lastInsertRowid)
          const v = (db.query<{ v: number | null }, [number]>('SELECT max(version) AS v FROM draft_versions WHERE draft_id = ?').get(id)?.v ?? 0) + 1
          db.query('INSERT INTO draft_versions (draft_id, version, sha256, size, created_at) VALUES (?, ?, ?, ?, ?)').run(id, v, shas.get(rel)!, content.length, now)
          db.query('DELETE FROM draft_versions WHERE draft_id = ? AND version <= ?').run(id, v - LIMITS.draftVersionsKept)
          for (const [f, strong] of win) {
            db.query('INSERT INTO draft_src (draft_id, folder_id, strong) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET strong = max(strong, excluded.strong)').run(id, f, strong ? 1 : 0)
          }
        }
      }
      appendAudit(db, { personId: this.token.person_id, tokenId: this.token.id, tool, command, files: [...this.files], outcome })
    })()
    try { this.ctx.onCommit?.(this, tool, outcome) } catch (e) { console.error('[onCommit] failed:', e) }
  }
}
