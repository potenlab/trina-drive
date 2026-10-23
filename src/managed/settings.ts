// Settings of managed storage. The operator sets them (CLI `storage …` or the environment, which wins); a team admin
// sees them on the web but does not change the quota (in Trina Cloud the plan sets it).
import fs from 'node:fs'
import path from 'node:path'
import { ENV_PREFIX, NAME } from '../config'
import type { DB } from '../db'
import { detectLayout } from '../layout'

export type StorageMode = 'inplace' | 'managed'

const env = (k: string) => process.env[`${ENV_PREFIX}_${k}`]
const metaGet = (db: DB, key: string) => db.query<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?').get(key)?.value
export const metaSet = (db: DB, key: string, value: string | null) => value === null
  ? db.query('DELETE FROM meta WHERE key = ?').run(key)
  : db.query('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value)

/** "50GB", "1.5 TB", "800m", "1048576" -> bytes; "none"/"off"/"" -> null (no limit). */
export function parseBytes(s: string): number | null {
  const t = s.trim().toLowerCase()
  if (t === '' || t === 'none' || t === 'off' || t === 'unlimited') return null
  const m = /^(\d+(?:\.\d+)?)\s*(b|k|kb|kib|m|mb|mib|g|gb|gib|t|tb|tib)?$/.exec(t)
  if (!m) throw new Error(`not a size: ${s} (use e.g. 50GB, 800MB)`)
  const unit = (m[2] ?? 'b')[0]!
  const mult = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[unit as 'b' | 'k' | 'm' | 'g' | 't']
  return Math.floor(Number(m[1]) * mult)
}

const num = (v: string | undefined, dflt: number) => { const n = Number(v); return v !== undefined && v !== '' && Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt }

export const MANAGED_LIMITS = {
  /** one chunk of a resumable upload (the last one may be shorter) */
  chunkBytes: 8 * 1024 * 1024,
  /** a one-request (multipart) upload; larger files go through /api/uploads */
  simpleUploadBytes: 16 * 1024 * 1024,
  /** files in one multipart request */
  simpleUploadFiles: 100,
  /** an unfinished resumable upload is dropped after this */
  uploadTtlMs: 24 * 3600_000,
  /** open resumable uploads per person */
  uploadsPerPerson: 50,
  /** items in one move / copy / delete request */
  batchItems: 500,
  /** entries walked when a folder is moved, deleted or measured */
  walkEntries: 200_000,
}

export interface StorageSettings {
  mode: StorageMode
  /** managed root: one directory per managed team folder, plus .<name>/ for trash, versions and upload staging */
  root: string
  /** total bytes the team may keep (files, trash, earlier versions, unfinished uploads); null = no limit */
  quotaBytes: number | null
  /** earlier versions kept per file */
  versionsKept: number
  /** days a deleted item stays in the trash */
  trashDays: number
  /** largest single file */
  maxFileBytes: number
}

export function storageSettings(db: DB, dataDir: string): StorageSettings {
  const m = env('STORAGE') ?? metaGet(db, 'storage_mode')
  const quota = env('STORAGE_QUOTA') ?? metaGet(db, 'storage_quota')
  return {
    mode: m === 'managed' ? 'managed' : 'inplace',
    root: path.resolve(env('FILES_DIR') ?? metaGet(db, 'managed_root') ?? detectLayout(dataDir).filesDir),
    quotaBytes: quota === undefined ? null : parseBytes(quota),
    versionsKept: num(env('VERSIONS_KEPT') ?? metaGet(db, 'versions_kept'), 10),
    trashDays: num(env('TRASH_DAYS') ?? metaGet(db, 'trash_days'), 30),
    maxFileBytes: num(env('MAX_FILE_BYTES') ?? metaGet(db, 'max_file_bytes'), 10 * 1024 ** 3),
  }
}

/** Earlier versions kept per file (no data directory needed). */
export const versionsKept = (db: DB) => num(env('VERSIONS_KEPT') ?? metaGet(db, 'versions_kept'), 10)

/** Where the server keeps its own things inside the managed root (never a registered folder, never walked). */
export function systemDirs(root: string) {
  const sys = path.join(root, `.${NAME}`)
  return { sys, trash: path.join(sys, 'trash'), versions: path.join(sys, 'versions'), uploads: path.join(sys, 'uploads') }
}

/** Create the managed root and its system folders (0700: only the server account reads them). */
export function ensureRoot(root: string) {
  const d = systemDirs(root)
  for (const p of [root, d.sys, d.trash, d.versions, d.uploads]) fs.mkdirSync(p, { recursive: true, mode: 0o700 })
  return d
}
