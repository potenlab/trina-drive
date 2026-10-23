// SKILL.md frontmatter (agentskills.io specification): a small YAML subset read without a YAML library, and the checks
// a skill must pass before it can be proposed for approval (plan 4.2 "검증"). Anything this reader does not understand
// is an error, never a guess: the frontmatter served to hosts (SEP-2640 `frontmatter`) must be the file's own.
//
// Read: `key: value` (plain, 'single' or "double" quoted), `key: |` / `key: >` block scalars, one level of nested map
// (`metadata:` + indented `k: v`), lists (`- item` lines or `[a, b]`), and comments. Values stay strings except the
// YAML core scalars true/false/null/numbers, as a YAML reader would render them in JSON.

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json }

export class FrontmatterError extends Error {}

/** The frontmatter block and the body after it. No block (or an unterminated one) is an error. */
export function splitSkillMd(text: string): { yaml: string; body: string } {
  const t = text.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  if (!t.startsWith('---\n')) throw new FrontmatterError('SKILL.md must start with a frontmatter block (a line "---")')
  const end = t.indexOf('\n---', 4)
  if (end < 0) throw new FrontmatterError('the frontmatter block has no closing "---" line')
  const after = t.indexOf('\n', end + 4)
  const closing = t.slice(end + 1, after < 0 ? undefined : after)
  if (closing.trim() !== '---') throw new FrontmatterError('the frontmatter block has no closing "---" line')
  return { yaml: t.slice(4, end + 1), body: after < 0 ? '' : t.slice(after + 1) }
}

const scalar = (raw: string, line: number): Json => {
  const v = raw.trim()
  if (v === '') return null
  if (v.startsWith('"')) {
    if (!/^"(?:[^"\\]|\\.)*"$/.test(v)) throw new FrontmatterError(`line ${line}: unterminated "quoted" value`)
    try { return JSON.parse(v.replace(/\\'/g, "'")) as string } catch { throw new FrontmatterError(`line ${line}: bad escape in a "quoted" value`) }
  }
  if (v.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(v)) throw new FrontmatterError(`line ${line}: unterminated 'quoted' value`)
    return v.slice(1, -1).replace(/''/g, "'")
  }
  if (v.startsWith('[')) {
    if (!v.endsWith(']')) throw new FrontmatterError(`line ${line}: unterminated [list]`)
    const inner = v.slice(1, -1).trim()
    return inner ? inner.split(',').map((x) => scalar(x, line)) : []
  }
  if (/^[{&*!|>%@`]/.test(v)) throw new FrontmatterError(`line ${line}: this YAML form is not supported here; use key: value`)
  const plain = v.replace(/\s+#.*$/, '')
  if (/^(true|True|TRUE)$/.test(plain)) return true
  if (/^(false|False|FALSE)$/.test(plain)) return false
  if (/^(null|Null|NULL|~)$/.test(plain)) return null
  if (/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?$/.test(plain)) return Number(plain)
  if (/: /.test(plain)) throw new FrontmatterError(`line ${line}: a plain value cannot contain ": " (quote it)`)
  return plain
}

const KEY = /^([A-Za-z0-9_][A-Za-z0-9_.\-/]*)\s*:(?:\s+(.*))?$/

/** Parse the frontmatter YAML subset into a JSON object (keys in file order). */
export function parseFrontmatter(yaml: string): Record<string, Json> {
  const lines = yaml.split('\n')
  const out: Record<string, Json> = {}
  let i = 0
  const indentOf = (s: string) => s.length - s.trimStart().length
  const blank = (s: string) => s.trim() === '' || s.trimStart().startsWith('#')
  while (i < lines.length) {
    const line = lines[i]!
    if (blank(line)) { i++; continue }
    if (line.includes('\t')) throw new FrontmatterError(`line ${i + 1}: tabs are not allowed in YAML indentation`)
    if (indentOf(line) !== 0) throw new FrontmatterError(`line ${i + 1}: unexpected indentation`)
    const m = KEY.exec(line)
    if (!m) throw new FrontmatterError(`line ${i + 1}: expected "key: value"`)
    const key = m[1]!, rest = (m[2] ?? '').trim()
    if (Object.hasOwn(out, key)) throw new FrontmatterError(`line ${i + 1}: "${key}" appears twice`)
    i++
    if (/^[|>][+-]?$/.test(rest)) {
      // block scalar: the indented lines that follow
      const block: string[] = []
      let ind = -1
      while (i < lines.length && (lines[i]!.trim() === '' || indentOf(lines[i]!) > 0)) {
        const l = lines[i]!
        if (l.trim() !== '' && ind < 0) ind = indentOf(l)
        block.push(l.trim() === '' ? '' : l.slice(Math.max(0, ind)))
        i++
      }
      while (block.length && block.at(-1) === '') block.pop()
      const keep = rest.endsWith('+'), strip = rest.endsWith('-')
      let text = rest[0] === '|' ? block.join('\n') : block.reduce((acc, l, k) => k === 0 ? l : l === '' ? acc + '\n' : acc.endsWith('\n') ? acc + l : acc + ' ' + l, '')
      if (!strip) text += '\n'
      if (keep) { /* trailing blank lines were dropped above; close enough for a description */ }
      out[key] = text
      continue
    }
    if (rest === '' || rest.startsWith('#')) {
      // a nested map or a list on the following indented lines (or an empty value)
      const kids: string[] = []
      const startLine = i + 1
      while (i < lines.length && (blank(lines[i]!) || indentOf(lines[i]!) > 0)) { if (!blank(lines[i]!)) kids.push(lines[i]!); i++ }
      if (!kids.length) { out[key] = null; continue }
      const ind = indentOf(kids[0]!)
      if (kids.some((k) => indentOf(k) !== ind)) throw new FrontmatterError(`line ${startLine}: "${key}" may hold one level of keys or list items only`)
      if (kids.every((k) => k.trimStart().startsWith('- ') || k.trim() === '-')) { out[key] = kids.map((k) => scalar(k.trimStart().slice(1), startLine)); continue }
      const map: Record<string, Json> = {}
      for (const k of kids) {
        const km = KEY.exec(k.trimStart())
        if (!km || /^[|>]/.test((km[2] ?? '').trim()) || (km[2] ?? '').trim() === '') throw new FrontmatterError(`line ${startLine}: under "${key}" write "name: value" lines`)
        if (Object.hasOwn(map, km[1]!)) throw new FrontmatterError(`line ${startLine}: "${key}.${km[1]}" appears twice`)
        map[km[1]!] = scalar(km[2]!, startLine)
      }
      out[key] = map
      continue
    }
    out[key] = scalar(rest, i)
  }
  return out
}

// ---------- agentskills.io rules ----------
export const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const LIMITS = {
  nameChars: 64,
  descriptionChars: 1024,
  compatibilityChars: 500,
  /** SKILL.md itself (the text an agent loads) */
  skillMdBytes: 256 * 1024,
  /** one supporting file */
  fileBytes: 2 * 1024 * 1024,
  /** SEP-2640 limits a host must accept: 512 files, 16 MiB in total */
  files: 512,
  totalBytes: 16 * 1024 * 1024,
  /** advice, not an error */
  skillMdLines: 500,
  depth: 6,
} as const

export interface Parsed { frontmatter: Record<string, Json>; body: string; name: string; description: string; warnings: string[] }

/** Read and check a SKILL.md in a directory called `dirName`. Throws FrontmatterError with the first problem. */
export function checkSkillMd(bytes: Uint8Array, dirName: string): Parsed {
  if (bytes.length > LIMITS.skillMdBytes) throw new FrontmatterError(`SKILL.md is larger than ${LIMITS.skillMdBytes / 1024} KB`)
  if (bytes.subarray(0, 8000).includes(0)) throw new FrontmatterError('SKILL.md is not a text file')
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new FrontmatterError('SKILL.md is not UTF-8 text') }
  const { yaml, body } = splitSkillMd(text)
  const fm = parseFrontmatter(yaml)
  const name = fm.name, description = fm.description
  if (typeof name !== 'string' || !name) throw new FrontmatterError('frontmatter needs a "name"')
  if (name.length > LIMITS.nameChars || !NAME_RE.test(name)) throw new FrontmatterError(`name "${name.slice(0, 80)}": 1–64 characters, lowercase letters, digits and single hyphens (not at either end)`)
  if (name !== dirName) throw new FrontmatterError(`name "${name}" must be the folder's name ("${dirName}")`)
  if (typeof description !== 'string' || !description.trim()) throw new FrontmatterError('frontmatter needs a "description" (what the skill does and when to use it)')
  if (description.length > LIMITS.descriptionChars) throw new FrontmatterError(`description is longer than ${LIMITS.descriptionChars} characters`)
  if (fm.compatibility !== undefined && (typeof fm.compatibility !== 'string' || fm.compatibility.length > LIMITS.compatibilityChars)) throw new FrontmatterError('compatibility: text of at most 500 characters')
  if (fm.metadata !== undefined && (fm.metadata === null || typeof fm.metadata !== 'object' || Array.isArray(fm.metadata))) throw new FrontmatterError('metadata: a map of names to values')
  const warnings: string[] = []
  const lines = body.split('\n').length
  if (lines > LIMITS.skillMdLines) warnings.push(`SKILL.md has ${lines} lines (keep it under ${LIMITS.skillMdLines}; move detail into references/)`)
  if (fm['allowed-tools'] !== undefined) warnings.push('allowed-tools is ignored: this server never grants tools from a skill')
  return { frontmatter: fm, body, name, description, warnings }
}
