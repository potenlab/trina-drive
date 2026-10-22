// Minimal OLE compound file (CFB) reader for .hwp (HWP 5.x), plus a small writer used for sample data and tests.
import { ArchiveError } from './zip'

const END = 0xfffffffe
const FREE = 0xffffffff
const FATSECT = 0xfffffffd
const SIG = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]

/** Stream path ("BodyText/Section0") -> bytes. */
export function readCfb(buf: Uint8Array, maxTotal = 256 * 1024 * 1024): Map<string, Uint8Array> {
  if (buf.length < 512 || SIG.some((b, i) => buf[i] !== b)) throw new ArchiveError('not a compound file')
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const u32 = (o: number) => v.getUint32(o, true)
  const ssz = 1 << v.getUint16(0x1e, true)
  const mss = 1 << v.getUint16(0x20, true)
  if (ssz !== 512 && ssz !== 4096) throw new ArchiveError('bad sector size')
  const sector = (s: number) => {
    const o = (s + 1) * ssz
    if (o + ssz > buf.length + ssz || o >= buf.length) throw new ArchiveError('sector out of range')
    return buf.subarray(o, Math.min(o + ssz, buf.length))
  }
  // FAT sector list: 109 in the header, the rest in the DIFAT chain
  const fatSectors: number[] = []
  for (let i = 0; i < 109; i++) { const s = u32(0x4c + i * 4); if (s !== FREE) fatSectors.push(s) }
  for (let d = u32(0x44), guard = 0; d !== END && d !== FREE && guard < 10000; guard++) {
    const sv = new DataView(sector(d).buffer, sector(d).byteOffset, ssz)
    for (let i = 0; i < ssz / 4 - 1; i++) { const s = sv.getUint32(i * 4, true); if (s !== FREE) fatSectors.push(s) }
    d = sv.getUint32(ssz - 4, true)
  }
  const fat: number[] = []
  for (const s of fatSectors) { const b = sector(s); const sv = new DataView(b.buffer, b.byteOffset, b.length); for (let i = 0; i + 4 <= b.length; i += 4) fat.push(sv.getUint32(i, true)) }
  const chain = (start: number, table: number[]) => {
    const out: number[] = []
    for (let s = start; s !== END && s !== FREE; s = table[s] ?? END) {
      if (out.length > table.length) throw new ArchiveError('sector chain loops')
      out.push(s)
    }
    return out
  }
  const readChain = (start: number) => Buffer.concat(chain(start, fat).map(sector))
  const dir = readChain(u32(0x30))
  const dv = new DataView(dir.buffer, dir.byteOffset, dir.byteLength)
  interface Ent { name: string; type: number; left: number; right: number; child: number; start: number; size: number }
  const ents: Ent[] = []
  for (let o = 0; o + 128 <= dir.length; o += 128) {
    const nlen = Math.max(0, Math.min(64, dv.getUint16(o + 0x40, true)) - 2)
    ents.push({ name: new TextDecoder('utf-16le').decode(dir.subarray(o, o + nlen)), type: dir[o + 0x42]!, left: dv.getUint32(o + 0x44, true),
      right: dv.getUint32(o + 0x48, true), child: dv.getUint32(o + 0x4c, true), start: dv.getUint32(o + 0x74, true), size: dv.getUint32(o + 0x78, true) })
  }
  const root = ents[0]
  if (!root || root.type !== 5) throw new ArchiveError('no root entry')
  const cutoff = u32(0x38)
  const miniStream = root.start === END ? new Uint8Array() : readChain(root.start).subarray(0, root.size)
  const miniFatBytes = u32(0x3c) === END ? Buffer.alloc(0) : readChain(u32(0x3c))
  const miniFat: number[] = []
  for (let i = 0; i + 4 <= miniFatBytes.length; i += 4) miniFat.push(miniFatBytes.readUInt32LE(i))
  let total = 0
  const content = (e: Ent) => {
    total += e.size
    if (total > maxTotal) throw new ArchiveError('compound file too large')
    if (e.size < cutoff) return Buffer.concat(chain(e.start, miniFat).map((s) => miniStream.subarray(s * mss, s * mss + mss))).subarray(0, e.size)
    return readChain(e.start).subarray(0, e.size)
  }
  const out = new Map<string, Uint8Array>()
  const seen = new Set<number>()
  const walk = (i: number, prefix: string) => {
    if (i === FREE || i >= ents.length || seen.has(i)) return
    seen.add(i)
    const e = ents[i]!
    walk(e.left, prefix)
    walk(e.right, prefix)
    if (e.type === 1) walk(e.child, prefix + e.name + '/')
    else if (e.type === 2) out.set(prefix + e.name, content(e))
  }
  walk(root.child, '')
  return out
}

/**
 * A compound file holding the given streams ("Storage/Stream" paths). Every stream is padded to at least 4096 bytes
 * so no mini stream is needed (callers pad with data that readers ignore).
 */
export function writeCfb(streams: Record<string, Uint8Array>): Uint8Array {
  interface Node { name: string; type: number; children: Node[]; data?: Uint8Array; start?: number; idx?: number }
  const root: Node = { name: 'Root Entry', type: 5, children: [] }
  for (const [p, data] of Object.entries(streams)) {
    if (data.length < 4096) throw new Error('writeCfb: streams must be at least 4096 bytes')
    let cur = root
    const parts = p.split('/')
    for (const s of parts.slice(0, -1)) {
      let n = cur.children.find((c) => c.name === s)
      if (!n) { n = { name: s, type: 1, children: [] }; cur.children.push(n) }
      cur = n
    }
    cur.children.push({ name: parts.at(-1)!, type: 2, children: [], data })
  }
  const all: Node[] = []
  const number = (n: Node) => { n.idx = all.length; all.push(n); n.children.forEach(number) }
  number(root)
  const dirSectors = Math.ceil((all.length * 128) / 512)
  const streamNodes = all.filter((n) => n.type === 2)
  const dataSectors = streamNodes.reduce((k, n) => k + Math.ceil(n.data!.length / 512), 0)
  let fatSectors = 1
  while (fatSectors * 128 < fatSectors + dirSectors + dataSectors) fatSectors++
  const fat = new Array<number>(fatSectors * 128).fill(FREE)
  for (let i = 0; i < fatSectors; i++) fat[i] = FATSECT
  const link = (start: number, count: number) => { for (let i = 0; i < count; i++) fat[start + i] = i === count - 1 ? END : start + i + 1 }
  link(fatSectors, dirSectors)
  let next = fatSectors + dirSectors
  for (const n of streamNodes) { const c = Math.ceil(n.data!.length / 512); n.start = next; link(next, c); next += c }
  const out = Buffer.alloc(512 * (1 + next))
  SIG.forEach((b, i) => (out[i] = b))
  out.writeUInt16LE(0x3e, 0x18); out.writeUInt16LE(3, 0x1a); out.writeUInt16LE(0xfffe, 0x1c); out.writeUInt16LE(9, 0x1e); out.writeUInt16LE(6, 0x20)
  out.writeUInt32LE(fatSectors, 0x2c); out.writeUInt32LE(fatSectors, 0x30); out.writeUInt32LE(4096, 0x38)
  out.writeUInt32LE(END, 0x3c); out.writeUInt32LE(0, 0x40); out.writeUInt32LE(END, 0x44); out.writeUInt32LE(0, 0x48)
  for (let i = 0; i < 109; i++) out.writeUInt32LE(i < fatSectors ? i : FREE, 0x4c + i * 4)
  fat.forEach((x, i) => out.writeUInt32LE(x, 512 + i * 4))
  const dirBase = 512 * (1 + fatSectors)
  for (const n of all) {
    const o = dirBase + n.idx! * 128
    const name = Buffer.from(n.name, 'utf16le')
    name.copy(out, o); out.writeUInt16LE(name.length + 2, o + 0x40); out[o + 0x42] = n.type; out[o + 0x43] = 1
    // siblings as a right-leaning chain (all black): valid for readers that walk the tree
    const sibs = all.find((p) => p.children.includes(n))?.children ?? []
    const right = sibs[sibs.indexOf(n) + 1]
    out.writeUInt32LE(FREE, o + 0x44); out.writeUInt32LE(right ? right.idx! : FREE, o + 0x48)
    out.writeUInt32LE(n.children[0] ? n.children[0].idx! : FREE, o + 0x4c)
    out.writeUInt32LE(n.type === 2 ? n.start! : END, o + 0x74); out.writeUInt32LE(n.data?.length ?? 0, o + 0x78)
  }
  for (const n of streamNodes) Buffer.from(n.data!).copy(out, 512 * (1 + n.start!))
  return out
}
