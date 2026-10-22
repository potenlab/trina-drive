// Minimal zip reader (stored + deflate, with output caps) for docx/xlsx/pptx/hwpx, and a stored-only writer for sample data.
import zlib from 'node:zlib'

export class ArchiveError extends Error {}

/** Entry name -> lazy content. Each entry is capped at `maxEntry` bytes once inflated. */
export function readZip(buf: Uint8Array, maxEntry = 64 * 1024 * 1024): Map<string, () => Uint8Array> {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  if (eocd < 0) throw new ArchiveError('not a zip file')
  const count = v.getUint16(eocd + 10, true)
  let p = v.getUint32(eocd + 16, true)
  const out = new Map<string, () => Uint8Array>()
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || v.getUint32(p, true) !== 0x02014b50) throw new ArchiveError('damaged zip directory')
    const method = v.getUint16(p + 10, true)
    const csize = v.getUint32(p + 20, true)
    const nameLen = v.getUint16(p + 28, true)
    const local = v.getUint32(p + 42, true)
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen))
    p += 46 + nameLen + v.getUint16(p + 30, true) + v.getUint16(p + 32, true)
    out.set(name, () => {
      if (local + 30 > buf.length || v.getUint32(local, true) !== 0x04034b50) throw new ArchiveError('damaged zip entry')
      const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true)
      const data = buf.subarray(start, start + csize)
      if (method === 0) return data.subarray(0, maxEntry)
      if (method !== 8) throw new ArchiveError(`unsupported zip compression (${method})`)
      try { return zlib.inflateRawSync(data, { maxOutputLength: maxEntry }) } catch { throw new ArchiveError('zip entry too large or damaged') }
    })
  }
  return out
}

/** A zip with stored (uncompressed) entries. */
export function writeZip(files: Record<string, string | Uint8Array>): Uint8Array {
  const enc = new TextEncoder()
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const nameB = enc.encode(name)
    const data = typeof content === 'string' ? enc.encode(content) : content
    const crc = Bun.hash.crc32(data)
    const lh = new DataView(new ArrayBuffer(30))
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x800, true)
    lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, nameB.length, true)
    const ch = new DataView(new ArrayBuffer(46))
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x800, true)
    ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true)
    ch.setUint16(28, nameB.length, true); ch.setUint32(42, offset, true)
    parts.push(new Uint8Array(lh.buffer), nameB, data)
    central.push(new Uint8Array(ch.buffer), nameB)
    offset += 30 + nameB.length + data.length
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, Object.keys(files).length, true); end.setUint16(10, Object.keys(files).length, true)
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true)
  return Buffer.concat([...parts, ...central, new Uint8Array(end.buffer)])
}
