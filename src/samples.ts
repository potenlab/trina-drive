// Small, valid office files generated in code, for `demo seed` and tests (no binary fixtures in the repo).
import { writeCfb } from './extract/cfb'
import { writeZip } from './extract/zip'

const xmlEsc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!)

/** One-page PDF with Helvetica text (ASCII only: the standard 14 fonts have no Hangul). */
export function samplePdf(lines: string[]): Uint8Array {
  const esc = (s: string) => s.replace(/[\\()]/g, '\\$&')
  const stream = `BT /F1 12 Tf 72 720 Td 16 TL\n${lines.map((l) => `(${esc(l)}) Tj T*`).join('\n')}\nET`
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(out)
}

const CT = (parts: string) => `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${parts}</Types>`
const rels = (target: string, type: string) => `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${type}" Target="${target}"/></Relationships>`
const OFFICE_DOC = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument'

export function sampleDocx(paragraphs: string[]): Uint8Array {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${xmlEsc(p)}</w:t></w:r></w:p>`).join('')
  return writeZip({
    '[Content_Types].xml': CT('<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'),
    '_rels/.rels': rels('word/document.xml', OFFICE_DOC),
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  })
}

export function sampleXlsx(sheet: string, rows: (string | number)[][]): Uint8Array {
  const col = (i: number) => String.fromCharCode(65 + i)
  const data = rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => typeof v === 'number'
    ? `<c r="${col(ci)}${ri + 1}"><v>${v}</v></c>`
    : `<c r="${col(ci)}${ri + 1}" t="inlineStr"><is><t>${xmlEsc(v)}</t></is></c>`).join('')}</row>`).join('')
  return writeZip({
    '[Content_Types].xml': CT('<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'),
    '_rels/.rels': rels('xl/workbook.xml', OFFICE_DOC),
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEsc(sheet)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': rels('worksheets/sheet1.xml', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet'),
    'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${data}</sheetData></worksheet>`,
  })
}

export function sampleHwpx(paragraphs: string[]): Uint8Array {
  const body = paragraphs.map((p) => `<hp:p><hp:run><hp:t>${xmlEsc(p)}</hp:t></hp:run></hp:p>`).join('')
  return writeZip({
    mimetype: 'application/hwp+zip',
    'Contents/section0.xml': `<?xml version="1.0" encoding="UTF-8"?><hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">${body}</hs:sec>`,
  })
}

/** HWP 5 with an uncompressed body section (enough for text extraction; Hangul itself would want more records). */
export function sampleHwp(paragraphs: string[]): Uint8Array {
  const rec = (tag: number, data: Uint8Array) => {
    const ext = data.length >= 0xfff
    const h = Buffer.alloc(ext ? 8 : 4)
    h.writeUInt32LE((tag | ((ext ? 0xfff : data.length) << 20)) >>> 0, 0)
    if (ext) h.writeUInt32LE(data.length, 4)
    return Buffer.concat([h, data])
  }
  const parts = paragraphs.flatMap((p) => [rec(66, Buffer.alloc(22)), rec(67, Buffer.from(p + '\r', 'utf16le'))])
  let body = Buffer.concat(parts)
  if (body.length < 4096) body = Buffer.concat([body, rec(99, Buffer.alloc(4096 - body.length))])
  const header = Buffer.alloc(4096)
  header.write('HWP Document File', 0, 'latin1')
  header.writeUInt32LE(0x05000300, 32)
  return writeCfb({ FileHeader: header, 'BodyText/Section0': body })
}
