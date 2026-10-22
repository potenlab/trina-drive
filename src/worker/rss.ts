// Memory of a worker and everything it started, for the RSS watchdog.
//   macOS: libproc through bun:ffi (a few microseconds per process; no subprocess per poll).
//   Linux: /proc.
// A process tree = the worker, its descendants, and anything still in its process group.
import { dlopen, FFIType, ptr } from 'bun:ffi'
import fs from 'node:fs'

export interface MemProbe {
  readonly kind: 'libproc' | 'procfs'
  /** Bytes in use by the tree rooted at `pid` (process group `pid`), and the pids in it. Null if the root is gone. */
  tree(pid: number): { bytes: number; pids: number[] } | null
}

const PROC_PGRP_ONLY = 2
const PROC_PPID_ONLY = 6
const RUSAGE_INFO_V2 = 2

function libprocProbe(): MemProbe | null {
  try {
    const lib = dlopen('/usr/lib/libproc.dylib', {
      proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
      proc_listpids: { args: [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    })
    const info = new BigUint64Array(32) // rusage_info_v2 is 152 bytes
    const list = new Int32Array(1024)
    const listPids = (type: number, arg: number): number[] => {
      const n = lib.symbols.proc_listpids(type, arg, ptr(list), list.byteLength)
      return n > 0 ? [...list.subarray(0, n / 4)].filter((p) => p > 0) : []
    }
    const bytes = (pid: number): number | null => {
      if (lib.symbols.proc_pid_rusage(pid, RUSAGE_INFO_V2, ptr(info)) !== 0) return null
      // ri_resident_size (index 8) and ri_phys_footprint (index 9): footprint keeps counting pages that were compressed
      return Math.max(Number(info[8]), Number(info[9]))
    }
    return {
      kind: 'libproc',
      tree(root) {
        const rootBytes = bytes(root)
        if (rootBytes === null) return null
        const seen = new Set([root])
        const queue = [root, ...listPids(PROC_PGRP_ONLY, root)]
        let total = 0
        for (let i = 0; i < queue.length && seen.size < 4096; i++) {
          const p = queue[i]!
          if (i > 0 && seen.has(p)) continue
          seen.add(p)
          total += (p === root ? rootBytes : bytes(p)) ?? 0
          for (const c of listPids(PROC_PPID_ONLY, p)) if (!seen.has(c)) queue.push(c)
        }
        return { bytes: total, pids: [...seen] }
      },
    }
  } catch {
    return null
  }
}

function procfsProbe(): MemProbe | null {
  if (!fs.existsSync('/proc/self/stat')) return null
  const page = 4096
  const stat = (pid: number) => {
    try {
      const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      const rest = s.slice(s.lastIndexOf(')') + 2).split(' ')
      return { ppid: Number(rest[1]), pgrp: Number(rest[2]), rssPages: Number(rest[21]) }
    } catch { return null }
  }
  return {
    kind: 'procfs',
    tree(root) {
      const r = stat(root)
      if (!r) return null
      const all = new Map<number, { ppid: number; pgrp: number; rssPages: number }>()
      for (const d of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(d)) continue
        const s = stat(Number(d))
        if (s) all.set(Number(d), s)
      }
      const inTree = new Set([root])
      for (const [p, s] of all) if (s.pgrp === root) inTree.add(p)
      let grew = true
      while (grew) { grew = false; for (const [p, s] of all) if (!inTree.has(p) && inTree.has(s.ppid)) { inTree.add(p); grew = true } }
      let total = 0
      for (const p of inTree) total += (all.get(p)?.rssPages ?? 0) * page
      return { bytes: total, pids: [...inTree] }
    },
  }
}

let probe: MemProbe | null | undefined
export function memProbe(): MemProbe | null {
  if (probe === undefined) probe = process.platform === 'darwin' ? libprocProbe() : process.platform === 'linux' ? procfsProbe() : null
  return probe
}
