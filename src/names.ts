// Name rules shared by every path walk. Names are compared on NFC; files are opened by the original name.
import path from 'node:path'

export const nfc = (s: string) => s.normalize('NFC')

/** NAS and OS system entries that are never shown (R1 ⑥), compared case-insensitively. */
const SYSTEM = new Set(['#recycle', '#snapshot', '@recycle', '@recently-snapshot', '.snapshot', '~snapshot', '@eadir',
  '.@__thumb', '.trashes', '$recycle.bin', '.temporaryitems', '.ds_store', '.spotlight-v100', '.fseventsd', '.apdisk',
  // ZFS snapshot directory (TrueNAS with snapdir=visible lists it at every dataset root: read-only copies of everything)
  '.zfs'])

export function isSystemName(name: string): boolean {
  const n = nfc(name)
  return SYSTEM.has(n.toLowerCase()) || n.startsWith('._') || n.startsWith('~$')
}

/** Names in one directory listing that collide after NFC: all of them are closed. */
export function nfcCollisions(names: string[]): Set<string> {
  const seen = new Map<string, number>()
  for (const n of names) seen.set(nfc(n), (seen.get(nfc(n)) ?? 0) + 1)
  return new Set(names.filter((n) => seen.get(nfc(n))! > 1))
}

/** Normalize a virtual path: absolute, no '.', '..' or empty parts, NFC. */
export function normalizeVirtual(p: string): string {
  return nfc(path.posix.normalize('/' + p).replace(/\/+$/, '') || '/')
}

export const splitVirtual = (p: string) => normalizeVirtual(p).split('/').filter(Boolean)

export const OFFICE_EXT = ['docx', 'xlsx', 'pptx', 'hwp', 'hwpx', 'pdf'] as const
export const ext = (name: string) => (/\.([^./]+)$/.exec(name)?.[1] ?? '').toLowerCase()
export const isOffice = (name: string) => (OFFICE_EXT as readonly string[]).includes(ext(name))
