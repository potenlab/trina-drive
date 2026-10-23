// Recent (Trina Cloud v1, workstream A2, memo §9.1): the files this person opened or changed themselves, on the web or
// on a mounted drive, newest first. Built from their own audit rows (person, no token: agent reads belong to the token,
// not to the person's own opening), every path re-resolved now with the one policy (Access.forPerson): nothing hidden
// now ever appears, and a file renamed or moved since drops out (v1: Recent is by path).
import type { DB } from '../db'
import { splitVirtual } from '../names'
import { Access } from '../policy'
import type { Actor } from '../rights'
import type { WebCtx } from '../web/http'
import type { RecentItem } from './api-types'

export const RECENT_LIMITS = { scan: 2000, max: 100, dflt: 50 }

/** What an audit command says the person did to a file (null: not a file open or change). */
export function recentAction(command: string): 'opened' | 'edited' | null {
  const m = /^files (\S+) /.exec(command)
  if (!m) return null
  switch (m[1]) {
    case 'download': case 'text': case 'versions': case 'version-download': return 'opened'
    case 'upload': case 'webdav-put': case 'restore-version': case 'copy': case 'webdav-copy': case 'webdav-move': return 'edited'
    default: return null
  }
}

export function recent(w: WebCtx, a: Actor, url: URL): { items: RecentItem[]; partial: boolean } {
  const want = Number(url.searchParams.get('limit') ?? RECENT_LIMITS.dflt)
  const limit = Number.isSafeInteger(want) && want > 0 ? Math.min(want, RECENT_LIMITS.max) : RECENT_LIMITS.dflt
  return recentFor(w.db, a.personId, limit)
}

export function recentFor(db: DB, personId: number, limit: number = RECENT_LIMITS.dflt): { items: RecentItem[]; partial: boolean } {
  const rows = db.query<{ at: number; command: string; files: string }, [number, number]>(`
    SELECT at, command, files FROM audit WHERE person_id = ? AND token_id IS NULL AND tool IN ('web', 'webdav') AND outcome = 'ok'
    ORDER BY id DESC LIMIT ?`).all(personId, RECENT_LIMITS.scan)
  const access = Access.forPerson(db, personId)
  const seen = new Set<string>()
  const items: RecentItem[] = []
  for (const r of rows) {
    const action = recentAction(r.command)
    if (!action) continue
    let files: unknown
    try { files = JSON.parse(r.files) } catch { continue }
    if (!Array.isArray(files) || !files.length) continue
    // a copy's audit row names the new file; every other row names the one file it touched
    const p = String(files[files.length - 1] ?? '')
    if (!p || seen.has(p)) continue
    seen.add(p)
    const e = p.length <= 4096 ? access.lookup(splitVirtual(p)) : null
    if (!e || e.kind !== 'file') continue
    items.push({ path: e.vpath, name: e.vpath.slice(e.vpath.lastIndexOf('/') + 1), kind: 'file', at: r.at, action, size: e.size, mtime: Math.round(e.mtimeMs) })
    if (items.length >= limit) break
  }
  return { items, partial: rows.length >= RECENT_LIMITS.scan && items.length < limit }
}
