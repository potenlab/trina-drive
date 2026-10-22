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
  const src = draftSources(db, rows.map((r) => r.id))
  return rows.map((r) => ({ ...r, src: src.get(r.id) ?? new Map() }))
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

/**
 * R4: token T sees draft d ⇔ same person ∧ T can read every source folder right now
 * ∧ (no sources ⇒ T wrote it). Other people and admins never see it.
 */
export function canSeeDraft(access: Access, token: TokenRow, d: Draft): boolean {
  if (d.person_id !== token.person_id) return false
  if (d.src.size === 0) return d.token_id === token.id
  for (const f of d.src.keys()) if (!access.canReadFolder(f)) return false
  return true
}

/** Where a draft appears under /drafts for this token: own drafts at the top, other tokens' under @<token name>/. */
export const draftRel = (d: Draft, token: TokenRow) => d.token_id === token.id ? d.path : `@${d.token_name.replace(/[/\s]/g, '_')}/${d.path}`

export function draftVersions(db: DB, draftId: number) {
  return db.query<{ version: number; sha256: string; size: number; created_at: number }, [number]>(
    'SELECT version, sha256, size, created_at FROM draft_versions WHERE draft_id = ? ORDER BY version').all(draftId)
}
