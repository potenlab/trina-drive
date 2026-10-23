// Team folders in managed storage: the admin names one, the server makes its directory in the managed root and
// registers it (a mount, like any registered folder: rules, flags, manage, promote and token scopes work unchanged).
// There are no NAS readers here: R5's readers are the rule readers (nas_readers = []), and the reconciler never walks
// managed folders (nothing but this server writes there; its own changes are audited as they happen).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { DB } from '../db'
import { registerFolder, StoreError, type FolderRow } from '../store'
import { ManagedError } from './core'
import { ensureRoot, storageSettings } from './settings'

/** Make a directory for a new team folder (named by a random id; people see the folder's name, not this). */
export function makeMountDir(db: DB, dataDir: string): string {
  const root = storageSettings(db, dataDir).root
  ensureRoot(root)
  const dir = path.join(root, crypto.randomUUID())
  fs.mkdirSync(dir, { mode: 0o700 })
  return dir
}

/** Inside the caller's transaction (or alone): register `dir` as a managed team folder. */
export function registerManaged(db: DB, dir: string, opts: { name: string; personalOwner?: string; by?: number | null }): FolderRow {
  const f = registerFolder(db, dir, { name: opts.name, personalOwner: opts.personalOwner, nasReaders: [] })
  db.query('INSERT OR IGNORE INTO managed_mounts (folder_id, created_at, created_by) VALUES (?, ?, ?)').run(f.id, Date.now(), opts.by ?? null)
  return db.query<FolderRow, [number]>('SELECT * FROM folders WHERE id = ?').get(f.id)!
}

/** CLI / tests: a new managed team folder in one step. */
export function createManagedFolder(db: DB, dataDir: string, opts: { name: string; personalOwner?: string; by?: number | null }): FolderRow {
  const taken = db.query<{ mount_name: string }, []>('SELECT mount_name FROM folders WHERE registered = 1').all()
    .some((r) => (r.mount_name ?? '').normalize('NFC') === opts.name.normalize('NFC'))
  if (taken) throw new StoreError(`a top folder named ${opts.name} exists`)
  const dir = makeMountDir(db, dataDir)
  try { return db.transaction(() => registerManaged(db, dir, opts))() } catch (e) { try { fs.rmdirSync(dir) } catch {} throw e }
}

export const isManagedFolder = (db: DB, folderId: number) => !!db.query('SELECT 1 FROM managed_mounts WHERE folder_id = ?').get(folderId)

/** Unregistering a managed team folder removes it: only when it is empty (its files would be left where nobody sees them). */
export function removeManagedMount(db: DB, f: FolderRow) {
  let names: string[] = []
  try { names = fs.readdirSync(f.path) } catch {}
  if (names.length) throw new ManagedError(409, 'not_empty', 'this team folder still holds files: delete them (or move them) first')
  db.query('DELETE FROM managed_mounts WHERE folder_id = ?').run(f.id)
  try { fs.rmdirSync(f.path) } catch {}
}
