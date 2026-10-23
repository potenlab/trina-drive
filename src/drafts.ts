// Draft box (R2–R4): agents write only here. A draft belongs to the token that wrote it; its sources (Src) only grow.
import fs from 'node:fs'
import path from 'node:path'
import type { DB } from './db'
import type { Access } from './policy'
import { sha256, type TokenRow } from './store'

export interface Draft {
  id: number; token_id: number; token_name: string; person_id: number; path: string
  version: number; sha256: string; size: number; updated_at: number
  src: Map<number, boolean> // folder id -> strong
  /** sources reached only through file shares (A2 via_file): R4 asks canReadSharedIn for these */
  via?: Set<number>
}

export class Blobs {
  constructor(readonly dir: string) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }) }
  path(sha: string) { return path.join(this.dir, sha.slice(0, 2), sha) }
  put(bytes: Uint8Array): string {
    const sha = sha256(bytes)
    const p = this.path(sha)
    if (!fs.existsSync(p)) {
      fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 })
      const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2)}`
      fs.writeFileSync(tmp, bytes, { mode: 0o600 })
      fs.renameSync(tmp, p)
    }
    return sha
  }
  get(sha: string): Uint8Array { return fs.readFileSync(this.path(sha)) }
}

/** Live drafts of one person, with their latest version and sources. */
export function liveDrafts(db: DB, personId: number): Draft[] {
  const rows = db.query<Omit<Draft, 'src'>, [number]>(`
    SELECT d.id, d.token_id, t.name AS token_name, d.person_id, d.path, v.version, v.sha256, v.size, v.created_at AS updated_at
    FROM drafts d JOIN tokens t ON t.id = d.token_id
    JOIN draft_versions v ON v.draft_id = d.id AND v.version = (SELECT max(version) FROM draft_versions WHERE draft_id = d.id)
    WHERE d.person_id = ? AND d.deleted_at IS NULL ORDER BY d.path`).all(personId)
  const ids = rows.map((r) => r.id)
  const src = draftSources(db, ids)
  const via = viaFileSources(db, ids)
  return rows.map((r) => ({ ...r, src: src.get(r.id) ?? new Map(), via: via.get(r.id) ?? new Set() }))
}

export function draftSources(db: DB, ids: number[]): Map<number, Map<number, boolean>> {
  const out = new Map<number, Map<number, boolean>>()
  if (!ids.length) return out
  for (const s of db.query<{ draft_id: number; folder_id: number; strong: number }, number[]>(
    `SELECT * FROM draft_src WHERE draft_id IN (${ids.map(() => '?').join(',')})`).all(...ids)) {
    if (!out.has(s.draft_id)) out.set(s.draft_id, new Map())
    out.get(s.draft_id)!.set(s.folder_id, !!s.strong)
  }
  return out
}

/** Sources of each draft that were reached only through file shares (draft_src.via_file = 1, A2). */
export function viaFileSources(db: DB, ids: number[]): Map<number, Set<number>> {
  const out = new Map<number, Set<number>>()
  if (!ids.length) return out
  for (const s of db.query<{ draft_id: number; folder_id: number }, number[]>(
    `SELECT draft_id, folder_id FROM draft_src WHERE via_file = 1 AND draft_id IN (${ids.map(() => '?').join(',')})`).all(...ids)) {
    if (!out.has(s.draft_id)) out.set(s.draft_id, new Set())
    out.get(s.draft_id)!.add(s.folder_id)
  }
  return out
}

/**
 * R4: token T sees draft d ⇔ same person ∧ T can read every source folder right now
 * ∧ (no sources ⇒ T wrote it). Other people and admins never see it.
 * A source reached only through a file share (via_file, A2 F9) counts as readable while T still reads some file shared
 * with its person in that folder (closed again once every share there is revoked); a direct source needs the folder.
 */
export function canSeeDraft(access: Access, token: TokenRow, d: Draft): boolean {
  if (d.person_id !== token.person_id) return false
  if (d.src.size === 0) return d.token_id === token.id
  for (const f of d.src.keys()) if (!access.canReadFolder(f) && !(d.via?.has(f) && access.canReadSharedIn(f))) return false
  return true
}

/**
 * A draft's sources as one caller may be shown them (원칙 2). Src(d) can hold folders the caller cannot see: a NAS
 * copy of someone else's draft passes its sources on to whoever reads it (R3/R6), and rules change after a draft
 * was written. Only folders `access` can read right now (R1 ①–④, the same test as R4) are named, by the path the
 * caller sees; every other source (hidden, unregistered, moved or gone alike) is only counted, so the answer is the
 * same whether such a folder exists or not. Src itself is unchanged; this is for showing it.
 */
export interface SourcesView { shown: { folder: string; strong: boolean; via_file?: true }[]; hidden: number }
export function sourcesFor(access: Access, src: Map<number, boolean>): SourcesView {
  const shown: SourcesView['shown'] = []
  let hidden = 0
  for (const [id, strong] of src) {
    const n = access.nodeForFolder(id)
    if (n && access.canRead(n)) shown.push({ folder: n.vpath, strong })
    // a folder the caller reaches only through a file shared with them (A2): its name is on that file's path anyway
    else if (n && access.canReadSharedIn(id)) shown.push({ folder: n.vpath, strong, via_file: true })
    else hidden++
  }
  return { shown: shown.sort((x, y) => x.folder.localeCompare(y.folder)), hidden }
}

/** The "Draft sources: …" line an agent gets after writing (write, edit, history restore). */
export function sourcesLine(v: SourcesView): string {
  const parts = v.shown.map((s) => s.folder.replace(/^\//, '') + (s.via_file ? ' (a file shared with you)' : '') + (s.strong ? '' : ' (weak)'))
  if (v.hidden) parts.push(`${v.hidden} folder${v.hidden === 1 ? '' : 's'} this token cannot see`)
  if (!parts.length) return 'Draft sources: none (only this token can see it)'
  return `Draft sources: ${parts.join(', ')}` +
    (v.hidden ? '. The draft is kept, but this token cannot open it until it can read every source.' : '')
}

/** Where a draft appears under /drafts for this token: own drafts at the top, other tokens' under @<token name>/. */
export const draftRel = (d: Draft, token: TokenRow) => d.token_id === token.id ? d.path : `@${d.token_name.replace(/[/\s]/g, '_')}/${d.path}`

export function draftVersions(db: DB, draftId: number) {
  return db.query<{ version: number; sha256: string; size: number; created_at: number }, [number]>(
    'SELECT version, sha256, size, created_at FROM draft_versions WHERE draft_id = ? ORDER BY version').all(draftId)
}
