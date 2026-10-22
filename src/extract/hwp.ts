// Text of Hangul documents: .hwp (HWP 5.x: compound file of zlib record streams) and .hwpx (OWPML: zip of XML).
// Adapted from Team AX (server/src/files/hwp.ts), with its SheetJS CFB dependency replaced by ./cfb.ts.
// Distribution-only and password-protected .hwp keep the body encrypted: only the preview text comes out, with a note.
import zlib from 'node:zlib'
import { readCfb } from './cfb'
import { ArchiveError, readZip } from './zip'

const TEXT_MAX = 8 * 1024 * 1024
const STREAM_MAX = 64 * 1024 * 1024
const SECTIONS_MAX = 500
const sectionNo = (p: string) => Number(/(\d+)(?:\.xml)?$/.exec(p)?.[1] ?? 0)

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
export const unescapeXml = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e] ?? m))

/**
 * Paragraph text of OOXML/OWPML-style XML: `para` opens a line (nested paragraphs get their own line where they
 * open), text is inside `text` elements, `tab`/`br` elements become a tab / newline. Tag names without prefix.
 */
export function xmlParagraphs(xml: string, tags: { para: string; text: string; tab: string; br: string }): string[] {
  const re = new RegExp(`<(\\/?)(?:\\w+:)?(${tags.para}|${tags.text}|${tags.tab}|${tags.br})\\b[^>]*?(\\/?)>`, 'g')
  const out: string[] = []
  const open: number[] = []
  let inText = false
  let last = 0
  for (const m of xml.matchAll(re)) {
    const [tag, close, name, selfClose] = m as unknown as [string, string, string, string]
    if (inText && open.length) out[open.at(-1)!] += unescapeXml(xml.slice(last, m.index).replace(/<[^>]+>/g, ''))
    last = m.index! + tag.length
    if (name === tags.para) {
      if (close) open.pop()
      else if (!selfClose) { open.push(out.length); out.push('') }
    } else if (name === tags.text) inText = !close && !selfClose
    else if (open.length && !close) out[open.at(-1)!] += name === tags.tab ? '\t' : '\n'
  }
  return out
}

export function hwpxText(bytes: Uint8Array): string {
  const zip = readZip(bytes, STREAM_MAX)
  const sections = [...zip.keys()].filter((p) => /^Contents\/section\d+\.xml$/i.test(p)).sort((a, b) => sectionNo(a) - sectionNo(b))
  if (!sections.length) throw new ArchiveError('no sections found in the .hwpx')
  const out: string[] = []
  let size = 0
  for (const s of sections.slice(0, SECTIONS_MAX)) {
    const lines = xmlParagraphs(new TextDecoder().decode(zip.get(s)!()), { para: 'p', text: 't', tab: 'tab', br: 'lineBreak' })
    out.push(...lines)
    size += lines.reduce((n, l) => n + l.length, 0)
    if (size > TEXT_MAX) break
  }
  return tidy(out.join('\n'))
}

const TAG_PARA_HEADER = 66
const TAG_PARA_TEXT = 67
// PARA_TEXT control characters (HWP 5.0 spec 4.3.10.1.1): "char" controls take one WCHAR, inline/extended ones eight
const ONE_WCHAR = new Set([0, 10, 13, 24, 25, 26, 27, 28, 29, 30, 31])

function paraText(rec: Uint8Array): string {
  const v = new DataView(rec.buffer, rec.byteOffset, rec.byteLength)
  let s = ''
  for (let i = 0; i + 1 < rec.length;) {
    const c = v.getUint16(i, true)
    if (c >= 32) { s += String.fromCharCode(c); i += 2; continue }
    if (c === 9) s += '\t'
    else if (c === 10) s += '\n'
    i += ONE_WCHAR.has(c) ? 2 : 16
  }
  return s
}

/** The text records of one BodyText/SectionN stream, a paragraph per line. */
export function sectionText(stream: Uint8Array): string {
  const v = new DataView(stream.buffer, stream.byteOffset, stream.byteLength)
  const paras: string[] = []
  let cur: string | null = null
  let size = 0
  for (let i = 0; i + 4 <= stream.length;) {
    const h = v.getUint32(i, true)
    i += 4
    const tag = h & 0x3ff
    let len = h >>> 20
    if (len === 0xfff) { if (i + 4 > stream.length) break; len = v.getUint32(i, true); i += 4 }
    if (i + len > stream.length) break
    if (tag === TAG_PARA_HEADER) { if (cur !== null) paras.push(cur); cur = '' }
    else if (tag === TAG_PARA_TEXT) { const t = paraText(stream.subarray(i, i + len)); cur = (cur ?? '') + t; size += t.length }
    i += len
    if (size > TEXT_MAX) break
  }
  if (cur !== null) paras.push(cur)
  return paras.join('\n')
}

export function hwpText(bytes: Uint8Array): string {
  const all = readCfb(bytes)
  const header = all.get('FileHeader')
  if (!header || header.length < 40 || new TextDecoder('latin1').decode(header.subarray(0, 17)) !== 'HWP Document File') {
    throw new ArchiveError('not an HWP 5 file (HWP 3 and older are not supported)')
  }
  const flags = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(36, true)
  const compressed = (flags & 1) !== 0
  const preview = () => { const p = all.get('PrvText'); return p ? new TextDecoder('utf-16le').decode(p).replace(/\0+$/, '') : '' }
  if ((flags & 2) !== 0 || (flags & 4) !== 0) return tidy(`[Only the preview text can be read: this is a distribution-only or password-protected HWP file.]\n\n${preview()}`)
  const inflate = (d: Uint8Array) => { try { return zlib.inflateRawSync(d, { maxOutputLength: STREAM_MAX }) } catch { throw new ArchiveError('a body section is damaged or too large') } }
  const sections = [...all.keys()].filter((p) => /^BodyText\/Section\d+$/.test(p)).sort((a, b) => sectionNo(a) - sectionNo(b))
  if (!sections.length) return tidy(preview())
  return tidy(sections.slice(0, SECTIONS_MAX).map((s) => sectionText(compressed ? inflate(all.get(s)!) : all.get(s)!)).join('\n'))
}

/** No trailing spaces, at most one empty line in a row, capped. */
export function tidy(s: string): string {
  return s.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, TEXT_MAX)
}
