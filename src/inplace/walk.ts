// Walk the roots the server can see and record every entry's identity (lstat only: links are never followed).
// NAS/OS system entries (R1 ⑥) are skipped and not descended into. Names are kept as listed (original bytes).
import fs from 'node:fs'
import path from 'node:path'
import { isSystemName, nfcCollisions } from '../names'

export type Kind = 'file' | 'dir' | 'symlink' | 'other'

export interface Seen {
  path: string; root: string; dev: string; ino: string; kind: Kind
  size: number; mtimeNs: string; birthNs: string; nlink: number
  /** another name in the same folder is equal after NFC */
  nfcCollision: boolean
}

/** Filesystem access used by the walk (injectable: tests simulate listings APFS cannot hold). */
export interface FsOps {
  readdir(p: string): Promise<string[]>
  lstat(p: string): Promise<fs.BigIntStats>
}

export const realFs: FsOps = {
  readdir: (p) => fs.promises.readdir(p),
  lstat: (p) => fs.promises.lstat(p, { bigint: true }),
}

export const kindOf = (st: fs.BigIntStats): Kind => st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other'

export function seenFrom(p: string, root: string, st: fs.BigIntStats, nfcCollision = false): Seen {
  return { path: p, root, dev: String(st.dev), ino: String(st.ino), kind: kindOf(st), size: Number(st.size), mtimeNs: String(st.mtimeNs),
    birthNs: String(st.birthtimeNs), nlink: Number(st.nlink), nfcCollision }
}

const BATCH = 64

/**
 * Walk one root. Returns null when the root itself is not a folder (missing, replaced by a file or a link).
 * Folders that cannot be listed are returned in `unreadable` so the caller does not take their children as deleted.
 */
export async function walkRoot(root: string, ops: FsOps = realFs, dirConcurrency = 8):
  Promise<{ entries: Seen[]; unreadable: string[]; sidecars: Set<string> } | null> {
  let st: fs.BigIntStats
  try { st = await ops.lstat(root) } catch { return null }
  if (!st.isDirectory() || st.isSymbolicLink()) return null
  const entries: Seen[] = [seenFrom(root, root, st)]
  const unreadable: string[] = []
  const sidecars = new Set<string>() // files that have an AppleDouble `._name` next to them
  const stack: string[] = [root]
  let active = 0
  await new Promise<void>((resolve, reject) => {
    const pump = () => {
      if (!stack.length && !active) return resolve()
      while (stack.length && active < dirConcurrency) {
        const dir = stack.pop()!
        active++
        listDir(dir).then(() => { active--; pump() }, reject)
      }
    }
    const listDir = async (dir: string) => {
      let names: string[]
      try { names = await ops.readdir(dir) } catch { unreadable.push(dir); return }
      const collide = nfcCollisions(names)
      for (const n of names) if (n.startsWith('._') && n.length > 2) sidecars.add(path.join(dir, n.slice(2)))
      const keep = names.filter((n) => !isSystemName(n))
      for (let i = 0; i < keep.length; i += BATCH) {
        const part = keep.slice(i, i + BATCH)
        const stats = await Promise.all(part.map((n) => ops.lstat(path.join(dir, n)).catch(() => null)))
        part.forEach((n, j) => {
          const s = stats[j]
          if (!s) return // vanished between readdir and lstat: the next walk decides
          const p = path.join(dir, n)
          const e = seenFrom(p, root, s, collide.has(n))
          entries.push(e)
          if (e.kind === 'dir') stack.push(p)
        })
      }
    }
    pump()
  })
  return { entries, unreadable, sidecars }
}
