// What the reconciler closes, as the policy reads it (one query per Access), and the provenance a tracked NAS copy
// of a draft passes on to whoever reads it (R3/R6).
import type { DB } from '../db'
import { identityKey } from '../store'

export interface Closures {
  /** identities closed to agents: R1 ⑤ index findings, R10 widening moves, R6 pending copies */
  identities: Set<string>
  /** last path of a lost rule-bearing folder -> its identity; any other identity at that path is closed */
  lostPaths: Map<string, string>
}

export function loadClosures(db: DB): Closures {
  const identities = new Set<string>()
  for (const r of db.query<{ dev: string; ino: string }, []>('SELECT dev, ino FROM fs_index WHERE closed IS NOT NULL').all()) identities.add(identityKey(r.dev, r.ino))
  const lostPaths = new Map<string, string>()
  for (const r of db.query<{ kind: string; dev: string; ino: string; path: string }, []>('SELECT kind, dev, ino, path FROM quarantine WHERE released_at IS NULL').all()) {
    if (r.kind === 'lost') lostPaths.set(r.path, identityKey(r.dev, r.ino))
    else identities.add(identityKey(r.dev, r.ino))
  }
  return { identities, lostPaths }
}

/** identity -> (folder id -> strong) for NAS copies of drafts that agents may read (tracked or confirmed). */
export function inheritedSources(db: DB): Map<string, Map<number, boolean>> {
  const out = new Map<string, Map<number, boolean>>()
  for (const r of db.query<{ dev: string; ino: string; folder_id: number; strong: number }, []>(`
    SELECT w.dev, w.ino, s.folder_id, s.strong FROM widened w JOIN draft_src s ON s.draft_id = w.draft_id
    WHERE w.status IN ('tracked', 'confirmed')`).all()) {
    const k = identityKey(r.dev, r.ino)
    if (!out.has(k)) out.set(k, new Map())
    const m = out.get(k)!
    m.set(r.folder_id, !!r.strong || !!m.get(r.folder_id))
  }
  return out
}
