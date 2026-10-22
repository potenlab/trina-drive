// Links that do not look like links to lstat (R1 ⑤): SMB "XSym" files, Mac alias files, AppleDouble alias/symlink
// markers. Also the names whose churn is not worth an "outside change" record.
import { isSystemName, nfc } from '../names'

const XSYM_SIZE = 1067
const XSYM_MAGIC = [0x58, 0x53, 0x79, 0x6d, 0x0a] // "XSym\n"
// macOS alias / bookmark data: "book" 0000 "mark" 0000
const BOOK = [0x62, 0x6f, 0x6f, 0x6b, 0, 0, 0, 0, 0x6d, 0x61, 0x72, 0x6b, 0, 0, 0, 0]

const startsWith = (b: Uint8Array, magic: number[]) => b.length >= magic.length && magic.every((v, i) => b[i] === v)

/** 'xsym' | 'alias' when the first bytes of a file (with its full size) mark it as a link, else null. */
export function sniffLink(head: Uint8Array, size: number): 'xsym' | 'alias' | null {
  if (size === XSYM_SIZE && startsWith(head, XSYM_MAGIC)) return 'xsym'
  if (startsWith(head, BOOK)) return 'alias'
  return null
}

/** Bytes needed by sniffLink. */
export const SNIFF_BYTES = 16

/**
 * An AppleDouble sidecar (`._name`, how SMB/NAS keep Mac metadata) whose Finder info says the file is an alias
 * (kIsAlias flag, type 'alis') or a Mac symlink (type 'slnk').
 */
export function appleDoubleSaysLink(b: Uint8Array): boolean {
  if (b.length < 26) return false
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  if (v.getUint32(0) !== 0x00051607) return false
  const n = v.getUint16(24)
  for (let i = 0; i < n; i++) {
    const at = 26 + i * 12
    if (at + 12 > b.length) return false
    if (v.getUint32(at) !== 9) continue // 9 = Finder info
    const off = v.getUint32(at + 4)
    if (off + 10 > b.length) return false
    const type = String.fromCharCode(b[off]!, b[off + 1]!, b[off + 2]!, b[off + 3]!)
    const flags = v.getUint16(off + 8)
    return type === 'alis' || type === 'slnk' || (flags & 0x8000) !== 0
  }
  return false
}

/** Office lock/temp files, Finder and SMB droppings: indexed or not, they never make an outside-change record. */
export function isNoiseName(name: string): boolean {
  const n = nfc(name)
  return isSystemName(n) || /^\.~lock\..*#$/.test(n) || /^~WRL\d+\.tmp$/i.test(n) || /^\.smbdelete/i.test(n) || /^\.nfs/.test(n) || /^~\$/.test(n)
}
