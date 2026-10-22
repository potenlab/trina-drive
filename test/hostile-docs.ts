// Malicious documents for the extraction tests: each one is small on disk and makes a parser in src/extract either
// allocate without bound or run (practically) forever. In the server process any of them would stall every other
// token's command; the isolated extractor must kill them (plan 6 "추출·셸 작업자는 모두 격리", 7.1).
import zlib from 'node:zlib'
import { writeZip } from '../src/extract/zip'

/** A zip whose entries are deflated (writeZip only stores). CRCs are left 0: the reader does not check them. */
export function deflateZip(files: Record<string, string | Uint8Array>): Uint8Array {
  const enc = new TextEncoder()
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  const cache = new Map<string | Uint8Array, Uint8Array>()
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const nameB = enc.encode(name)
    const raw = typeof content === 'string' ? enc.encode(content) : content
    const data = cache.get(content) ?? zlib.deflateRawSync(raw, { level: 9 })
    cache.set(content, data)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8)
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nameB.length, 26)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10)
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nameB.length, 28); ch.writeUInt32LE(offset, 42)
    parts.push(lh, nameB, data)
    central.push(ch, nameB)
    offset += 30 + nameB.length + data.length
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, ...central, end])
}

/** `unit` repeated up to `bytes`. */
const repeat = (unit: string, bytes: number) => Buffer.from(unit.repeat(Math.floor(bytes / unit.length)))

/** docx zip bomb: word/document.xml inflates to 60 MB of one-letter paragraphs (millions of strings). ~60 KB on disk. */
export function docxBomb(): Uint8Array {
  return deflateZip({ 'word/document.xml': repeat('<w:p><w:t>a</w:t></w:p>', 60 << 20) })
}

/** xlsx zip bomb: `sheets` worksheets that each inflate to 60 MB of rows. ~60 KB per sheet on disk. */
export function xlsxBomb(sheets = 16): Uint8Array {
  const rows = repeat('<row><c><v>1</v></c><c><v>2</v></c></row>', 60 << 20)
  const files: Record<string, string | Uint8Array> = { 'xl/workbook.xml': '<workbook><sheets><sheet name="s"/></sheets></workbook>' }
  for (let i = 1; i <= sheets; i++) files[`xl/worksheets/sheet${i}.xml`] = rows
  return deflateZip(files)
}

/**
 * docx whose text run is `n` '<' characters: the tag-stripping regex (/<[^>]+>/) is quadratic on it, ~10 minutes of
 * synchronous work for n = 1M. A parser that never returns.
 */
export function regexLoopDocx(n = 1_000_000): Uint8Array {
  return writeZip({ 'word/document.xml': `<w:document><w:body><w:p><w:t>${'<'.repeat(n)}</w:t></w:p></w:body></w:document>` })
}

/**
 * .hwp (compound file) of 1 KB whose DIFAT chain points to itself: the reader follows it 10 000 times and builds a FAT
 * of ~160 million entries (> 1 GB) before anything else. A huge allocation from a tiny file.
 */
export function difatLoopHwp(): Uint8Array {
  const b = Buffer.alloc(1024)
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(b, 0)
  b.writeUInt16LE(0x3e, 0x18); b.writeUInt16LE(3, 0x1a); b.writeUInt16LE(0xfffe, 0x1c); b.writeUInt16LE(9, 0x1e); b.writeUInt16LE(6, 0x20)
  b.writeUInt32LE(0, 0x30) // directory at sector 0
  b.writeUInt32LE(4096, 0x38)
  b.writeUInt32LE(0xfffffffe, 0x3c)
  b.writeUInt32LE(0, 0x44) // first DIFAT sector: 0
  for (let i = 0; i < 109; i++) b.writeUInt32LE(0xffffffff, 0x4c + i * 4)
  // sector 0 (file offset 512): 127 FAT sector numbers, all 0, and "next DIFAT sector" = 0 (itself)
  for (let i = 0; i < 128; i++) b.writeUInt32LE(0, 512 + i * 4)
  return b
}
