// Text of office documents for cat/grep/read. Plain files are used as they are.
// Converters get bytes (never a path): pdftotext reads stdin, the rest is in-process TypeScript with output caps.
import fs from 'node:fs'
import { ext } from '../names'
import { hwpText, hwpxText, tidy, unescapeXml, xmlParagraphs } from './hwp'
import { ArchiveError, readZip } from './zip'

export class ExtractError extends Error {}

/** External tools, found once at startup. */
export const TOOLS = {
  rg: findTool('rg'),
  pdftotext: findTool('pdftotext'),
}

function findTool(name: string): string | null {
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']) {
    try { fs.accessSync(`${dir}/${name}`, fs.constants.X_OK); return `${dir}/${name}` } catch {}
  }
  return null
}

/** Extracted text ends with a newline (so `cat a.docx b.pdf` keeps files apart). */
export async function extractText(name: string, bytes: Uint8Array): Promise<string> {
  const t = await extractRaw(name, bytes)
  return t && !t.endsWith('\n') ? t + '\n' : t
}

async function extractRaw(name: string, bytes: Uint8Array): Promise<string> {
  try {
    switch (ext(name)) {
      case 'pdf': return await pdfText(bytes)
      case 'docx': return docxText(bytes)
      case 'pptx': return pptxText(bytes)
      case 'xlsx': return xlsxText(bytes)
      case 'hwpx': return hwpxText(bytes)
      case 'hwp': return hwpText(bytes)
      default: return new TextDecoder().decode(bytes)
    }
  } catch (e) {
    if (e instanceof ArchiveError || e instanceof ExtractError) throw new ExtractError(`cannot extract text: ${e.message}`)
    throw e
  }
}

async function pdfText(bytes: Uint8Array): Promise<string> {
  if (!TOOLS.pdftotext) throw new ExtractError('pdftotext is not installed on the server')
  const p = Bun.spawn([TOOLS.pdftotext, '-layout', '-enc', 'UTF-8', '-', '-'], { stdin: bytes, stdout: 'pipe', stderr: 'pipe', env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } })
  const timer = setTimeout(() => p.kill('SIGKILL'), 20_000)
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  clearTimeout(timer)
  if (code !== 0) throw new ExtractError(`pdftotext failed (${err.trim().slice(0, 200) || 'exit ' + code})`)
  return out
}

const entryText = (zip: Map<string, () => Uint8Array>, name: string) => { const e = zip.get(name); return e ? new TextDecoder().decode(e()) : '' }
const numbered = (zip: Map<string, () => Uint8Array>, re: RegExp) =>
  [...zip.keys()].filter((k) => re.test(k)).sort((a, b) => Number(re.exec(a)![1]) - Number(re.exec(b)![1]))

function docxText(bytes: Uint8Array): string {
  const zip = readZip(bytes)
  const xml = entryText(zip, 'word/document.xml')
  if (!xml) throw new ExtractError('no word/document.xml')
  return tidy(xmlParagraphs(xml, { para: 'p', text: 't', tab: 'tab', br: 'br' }).join('\n'))
}

function pptxText(bytes: Uint8Array): string {
  const zip = readZip(bytes)
  return tidy(numbered(zip, /^ppt\/slides\/slide(\d+)\.xml$/).map((k, i) =>
    `# slide ${i + 1}\n` + xmlParagraphs(entryText(zip, k), { para: 'p', text: 't', tab: 'tab', br: 'br' }).join('\n')).join('\n\n'))
}

const colIndex = (ref: string) => [...(/^[A-Z]+/.exec(ref)?.[0] ?? 'A')].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1

/** Sheets as tab-separated rows (cached values only; no formulas are evaluated). */
function xlsxText(bytes: Uint8Array): string {
  const zip = readZip(bytes)
  const shared = [...entryText(zip, 'xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    unescapeXml([...m[1]!.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')))
  const names = [...entryText(zip, 'xl/workbook.xml').matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((m) => unescapeXml(m[1]!))
  return tidy(numbered(zip, /^xl\/worksheets\/sheet(\d+)\.xml$/).map((k, i) => {
    const rows = [...entryText(zip, k).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map((r) => {
      const cells: string[] = []
      for (const c of r[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1]!, body = c[2] ?? ''
        const t = /\bt="(\w+)"/.exec(attrs)?.[1]
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1]
        const val = t === 's' ? shared[Number(v)] ?? '' : t === 'inlineStr' ? [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join('') : (v ?? '')
        cells[colIndex(/\br="([A-Z]+)/.exec(attrs)?.[1] ?? '')] = unescapeXml(val)
      }
      return Array.from(cells, (c) => c ?? '').join('\t')
    })
    return `# sheet: ${names[i] ?? i + 1} (tab-separated)\n` + rows.join('\n')
  }).join('\n\n'))
}
