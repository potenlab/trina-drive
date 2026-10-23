// The people's file view on the web (plan 5.2 "웹 파일 보기", read only): list, stat, download, extracted text, search
// (file names + full text over the text mirror) and "who can see". Every decision is policy.ts R1 through
// Access.forPerson: the person's web session is a token of their own whose scope is everything (the same rule the
// drafts page uses), and "No AI" does not close folders here (it closes AI connections only; plan 5.1 "AI 연결 금지
// (웹의 사람만)"). Quarantined and widened-pending folders/files, links, NAS system folders stay closed.
//
// Hidden and nonexistent are the same answer: 404 with the same body. Bytes and text are re-checked (R1 ⑦) right
// before they leave. Downloads are always attachments with a generic type and nosniff: nothing a file holds is ever
// rendered on this origin (a preview needs a separate origin and a sandbox, plan 7.1, v0.3).
//
// Every call is audited (person, "web", action, path; files whose content left). These reads add NO provenance window
// (R3): provenance follows what an agent's token touched so its drafts carry their sources; a person reading in a
// browser writes no drafts through this server, and what they carry in their head is out of reach either way (4, 5).
import fs from 'node:fs'
import { appendAudit } from '../audit'
import { LIMITS } from '../config'
import { ExtractError, TOOLS } from '../extract'
import { evText, runRg } from '../grep'
import { ext, isOffice, nfc, splitVirtual } from '../names'
import { Access, Closed, effectiveLevel, entryName, type Entry, type FileEntry, type Node } from '../policy'
import { Rights, type Actor } from '../rights'
import type { FolderRow } from '../store'
import { ApiError, bad, notFound, type WebCtx } from './http'
import { draftsView } from './views'
import { inManaged, managedMountIds, openEntry } from '../managed/core'

export const FILES_LIMITS = {
  /** extracted text returned by /files/text */
  textBytes: 1024 * 1024,
  /** files a search looks at (names and text) */
  searchFiles: 5000,
  /** folders a search walks */
  searchFolders: 2000,
  /** results one search returns */
  searchResults: 50,
  snippetsPerFile: 3,
  snippetChars: 160,
  /** wall clock for filling the text mirror during one search (extraction on first use) */
  searchMs: 15_000,
  queryChars: 200,
  pathChars: 4096,
}

/** Plain-text files shown and searched as they are (office files go through extraction). */
const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'xml', 'yaml', 'yml', 'ini', 'toml', 'html', 'htm',
  'sql', 'sh', 'py', 'js', 'ts', 'css', 'tex', 'srt', 'vtt'])
export const hasText = (name: string, size: number) => (isOffice(name) || TEXT_EXT.has(ext(name))) && size <= LIMITS.fileBytes

// ---------- paths ----------
function parts(raw: string | null): string[] {
  const p = raw ?? '/'
  if (p.length > FILES_LIMITS.pathChars || p.includes('\0')) throw notFound()
  return splitVirtual(p)
}

/** The entry at a path for this person, or null for "not there" (hidden and nonexistent alike). */
function resolve(access: Access, ps: string[]): Entry | null {
  return ps.length ? access.lookup(ps) : null
}

const vpathOf = (e: Entry) => e.kind === 'dir' ? e.node.vpath : e.vpath

/** Managed storage: a person may change this folder (managed, readable, rule ≥ write: src/managed/ops.ts). */
const writableNode = (access: Access, ids: Set<number>, n: Node) => inManaged(ids, n) && access.canRead(n) && access.level(n) >= 2

function entryJson(access: Access, e: Entry, ids?: Set<number>) {
  const name = entryName(e)
  // folder size and time are not shown: they would change with files the person cannot see (policy: synthetic stat)
  if (e.kind === 'dir') return { name, path: e.node.vpath, kind: 'folder' as const, size: null, mtime: null, ext: null, has_text: false, readable: access.canRead(e.node),
    ...(ids ? { writable: writableNode(access, ids, e.node), managed: inManaged(ids, e.node) } : {}) }
  return { name, path: e.vpath, kind: 'file' as const, size: e.size, mtime: Math.round(e.mtimeMs), ext: ext(name) || null, has_text: hasText(name, e.size), readable: true }
}

// ---------- audit ----------
function audit(w: WebCtx, a: Actor, command: string, files: string[], outcome = 'ok') {
  // closed by default: if the row cannot be written the call fails (appendAudit throws)
  appendAudit(w.db, { personId: a.personId, tokenId: null, tool: 'web', command, files, outcome })
}

/** Resolve or answer 404 (audited, with the path as typed: it is the person's own row). */
function must(w: WebCtx, a: Actor, access: Access, action: string, raw: string | null): Entry {
  const ps = parts(raw)
  const e = resolve(access, ps)
  if (!e) { audit(w, a, `files ${action} ${raw ?? '/'}`, [], 'not_found'); throw notFound() }
  return e
}

// ---------- endpoints ----------
export function list(w: WebCtx, a: Actor, url: URL) {
  const access = Access.forPerson(w.db, a.personId)
  const raw = url.searchParams.get('path')
  const ps = parts(raw)
  const ids = managedMountIds(w.db)
  if (!ps.length) {
    const entries = access.rootEntries()
    audit(w, a, 'files list /', [])
    return { path: '/', writable: false, managed: false, entries: entries.map((x) => entryJson(access, x, ids)), drafts: draftsView(w, a).drafts.length }
  }
  const e = must(w, a, access, 'list', raw)
  if (e.kind !== 'dir') throw bad('not_folder', 'this is a file')
  const entries = access.list(e.node)
  audit(w, a, `files list ${e.node.vpath}`, [e.node.vpath])
  return { path: e.node.vpath, readable: access.canRead(e.node), writable: writableNode(access, ids, e.node), managed: inManaged(ids, e.node),
    entries: entries.map((x) => entryJson(access, x, ids)) }
}

export function stat(w: WebCtx, a: Actor, url: URL) {
  const access = Access.forPerson(w.db, a.personId)
  const e = must(w, a, access, 'stat', url.searchParams.get('path'))
  audit(w, a, `files stat ${vpathOf(e)}`, [vpathOf(e)])
  return entryJson(access, e)
}

/** Content-Disposition for any name: an ASCII fallback plus RFC 5987 UTF-8 (Korean and NFD names arrive as NFC). */
export function attachment(name: string) {
  return `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\%;]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(nfc(name))}`
}

function readFile(access: Access, f: FileEntry): Uint8Array {
  try { return access.readBytes(f, LIMITS.fileBytes) } catch (e) {
    if (e instanceof Closed) throw e.message === 'too large' ? new ApiError(413, 'too_large', 'this file is too large to download here') : notFound()
    throw e
  }
}

export function download(w: WebCtx, a: Actor, url: URL): Response {
  const access = Access.forPerson(w.db, a.personId)
  const e = must(w, a, access, 'download', url.searchParams.get('path'))
  if (e.kind !== 'file') throw bad('is_folder', 'folders cannot be downloaded')
  if (inManaged(managedMountIds(w.db), e.parent)) return streamManaged(w, a, access, e)
  const bytes = readFile(access, e) // R1 ⑤ ⑦: opened without following links, re-checked after reading
  audit(w, a, `files download ${e.vpath}`, [e.vpath])
  return new Response(bytes, {
    headers: {
      // never rendered on this origin: a generic type, attachment always, no sniffing, and a sandbox if anything tries
      'content-type': 'application/octet-stream',
      'content-disposition': attachment(entryName(e)),
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'no-store',
      'content-length': String(bytes.length),
    },
  })
}

/**
 * Managed storage holds files of any size (uploads up to the max file size): they are streamed, not read into memory.
 * Opened without following links, identity and one link checked, the folder chain re-checked (R1 ⑤ ⑦) before the
 * first byte leaves; only the server writes there, so the file cannot change under the stream except by its own API,
 * which replaces by rename (the open file keeps its bytes).
 */
function streamManaged(w: WebCtx, a: Actor, access: Access, e: FileEntry): Response {
  let fd: number
  try { fd = openEntry(e); access.recheck(e) } catch { throw notFound() }
  const size = Number(fs.fstatSync(fd).size)
  try { audit(w, a, `files download ${e.vpath}`, [e.vpath]) } catch (err) { fs.closeSync(fd); throw err }
  let off = 0
  let open = true
  const close = () => { if (open) { open = false; fs.closeSync(fd) } }
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      const buf = Buffer.alloc(Math.min(1024 * 1024, Math.max(0, size - off)))
      const n = buf.length ? fs.readSync(fd, buf, 0, buf.length, off) : 0
      if (n <= 0) { close(); c.close(); return }
      off += n
      c.enqueue(buf.subarray(0, n))
    },
    cancel() { close() },
  })
  return new Response(body, { headers: {
    'content-type': 'application/octet-stream', 'content-disposition': attachment(entryName(e)), 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox", 'cache-control': 'no-store', 'content-length': String(size),
  } })
}

/** Cut at a UTF-8 character boundary. */
function cutUtf8(b: Uint8Array, max: number): { text: string; truncated: boolean } {
  if (b.length <= max) return { text: new TextDecoder().decode(b), truncated: false }
  let end = max
  while (end > 0 && (b[end]! & 0xc0) === 0x80) end--
  return { text: new TextDecoder().decode(b.subarray(0, end)), truncated: true }
}

export async function text(w: WebCtx, a: Actor, url: URL) {
  const access = Access.forPerson(w.db, a.personId)
  const e = must(w, a, access, 'text', url.searchParams.get('path'))
  if (e.kind !== 'file') throw bad('is_folder', 'folders have no text')
  if (!hasText(entryName(e), e.size)) throw new ApiError(422, 'no_text', 'this file has no text to show')
  let bytes: Uint8Array
  try { bytes = await w.mirror.text(access, e) } catch (err) {
    if (err instanceof Closed) throw notFound()
    if (err instanceof ExtractError) { audit(w, a, `files text ${e.vpath}`, [e.vpath], 'cannot_extract'); throw new ApiError(422, 'cannot_extract', 'the text of this file could not be read') }
    throw err
  }
  const out = cutUtf8(bytes, FILES_LIMITS.textBytes)
  audit(w, a, `files text ${e.vpath}`, [e.vpath])
  // a JSON string: the app shows it as plain text, never as HTML
  return { path: e.vpath, extracted: isOffice(entryName(e)), text: out.text, truncated: out.truncated, bytes: bytes.length }
}

// ---------- who can see (R5 as the folder view shows it) ----------
interface PersonG { id: number; name: string; groups: Set<number> }
function activePeople(w: WebCtx): PersonG[] {
  const ms = w.db.query<{ group_id: number; person_id: number }, []>('SELECT * FROM memberships').all()
  return w.db.query<{ id: number; name: string }, []>('SELECT id, name FROM people WHERE active = 1 ORDER BY name').all()
    .map((p) => ({ ...p, groups: new Set(ms.filter((m) => m.person_id === p.id).map((m) => m.group_id)) }))
}

export function who(w: WebCtx, a: Actor, url: URL) {
  const access = Access.forPerson(w.db, a.personId)
  const e = must(w, a, access, 'who', url.searchParams.get('path'))
  const node: Node = e.kind === 'dir' ? e.node : e.parent
  const path = vpathOf(e)
  audit(w, a, `files who ${path}`, [path])
  // A folder shown only as a path to something below it: the person cannot read it, so its readers stay private
  // (the admin's folder pages show every folder to the admin anyway).
  if (!access.canRead(node) && !a.admin) return { path, folder: node.vpath, restricted: true }
  const rows = node.rows
  const rules = access.rulesMap()
  const people = activePeople(w)
  const groups = w.db.query<{ id: number; name: string }, []>('SELECT id, name FROM groups ORDER BY name').all()
  const has = (k: 'no_ai' | 'quarantine' | 'widened_pending') => rows.some((r: FolderRow) => !!r[k])
  const flags = { no_ai: has('no_ai'), quarantine: has('quarantine'), widened_pending: has('widened_pending') }
  const ruleReaders = people.filter((p) => effectiveLevel(rows, p.id, p.groups, rules) >= 1)
  const aiBlocked = flags.no_ai || flags.quarantine || flags.widened_pending
  const webClosed = flags.quarantine || flags.widened_pending
  const reg = [...rows].reverse().find((r) => r.registered)
  const owner = rows.find((r) => r.personal_owner != null)?.personal_owner ?? null
  let nas: { mode: 'all' | 'unknown' | 'chosen'; people: string[] | null }
  if (!reg || reg.nas_readers == null || reg.nas_readers === 'unknown') nas = { mode: 'unknown', people: null }
  else if (reg.nas_readers === 'all') nas = { mode: 'all', people: null }
  else { const ids = new Set(JSON.parse(reg.nas_readers) as number[]); nas = { mode: 'chosen', people: people.filter((p) => ids.has(p.id)).map((p) => p.name) } }
  const managed = inManaged(managedMountIds(w.db), node)
  const r = new Rights(w.db)
  const nearest = r.folders.get(rows[rows.length - 1]!.id)
  // managed storage has no NAS: readers are the rule readers (R5 with no NAS readers), and "who can see" says so
  return {
    path, folder: node.vpath, restricted: false, flags, managed,
    // the folder page (rules) is for the admin and manage holders (R7); never inside a personal folder
    can_share: !rows.some((x) => x.personal_owner != null) && (a.admin || (!!nearest && r.manages(a.personId, nearest))),
    personal_owner: owner == null ? null : people.find((p) => p.id === owner)?.name ?? null,
    // AI readers: what agents of these people may read here (none while a flag closes the folder to agents)
    ai: {
      blocked: aiBlocked,
      people: aiBlocked ? [] : ruleReaders.map((p) => p.name),
      groups: aiBlocked ? [] : groups.filter((g) => effectiveLevel(rows, -1, new Set([g.id]), rules) >= 1).map((g) => g.name),
    },
    // people who open it in this web view (the same rules; "No AI" does not close it for people)
    web: webClosed ? [] : ruleReaders.map((p) => p.name),
    nas: managed ? null : nas,
  }
}

// ---------- search ----------
interface Hit {
  path: string; name: string; kind: 'file' | 'folder'; size: number | null; mtime: number | null
  name_match: boolean; snippets: { line: number; text: string }[]
}

function snippet(line: string, q: string): string {
  const l = line.replace(/\s+/g, ' ').trim()
  const max = FILES_LIMITS.snippetChars
  if (l.length <= max) return l
  const at = Math.max(0, l.toLocaleLowerCase().indexOf(q.toLocaleLowerCase()))
  const start = Math.max(0, Math.min(at - Math.floor((max - q.length) / 2), l.length - max))
  return (start > 0 ? '…' : '') + l.slice(start, start + max) + (start + max < l.length ? '…' : '')
}

export async function search(w: WebCtx, a: Actor, url: URL) {
  const q = nfc((url.searchParams.get('q') ?? '').trim())
  if (!q) throw bad('empty_query', 'type something to search for')
  if (q.length > FILES_LIMITS.queryChars) throw bad('query_too_long', 'the search text is too long')
  const access = Access.forPerson(w.db, a.personId)
  const raw = url.searchParams.get('path')
  const ps = parts(raw)
  let start: Entry[]
  let where = '/'
  if (ps.length) {
    const e = must(w, a, access, 'search', raw)
    where = vpathOf(e)
    start = [e]
  } else start = access.rootEntries()

  // walk what this person may see (Access.list only returns readable files; bare-path folders list only their path)
  const ql = q.toLocaleLowerCase()
  const nameHit = (n: string) => n.toLocaleLowerCase().includes(ql)
  const hits = new Map<string, Hit>()
  const candidates: FileEntry[] = []
  let partial = false
  let files = 0, folders = 0
  const queue: Entry[] = [...start]
  const visit = (e: Entry) => {
    const name = entryName(e)
    if (e.kind === 'dir') {
      if (++folders > FILES_LIMITS.searchFolders) { partial = true; return }
      if (nameHit(name) && e.node.vpath !== where) hits.set(e.node.vpath, { path: e.node.vpath, name, kind: 'folder', size: null, mtime: null, name_match: true, snippets: [] })
      queue.push(...access.list(e.node))
      return
    }
    if (++files > FILES_LIMITS.searchFiles) { partial = true; return }
    if (nameHit(name)) hits.set(e.vpath, { path: e.vpath, name, kind: 'file', size: e.size, mtime: Math.round(e.mtimeMs), name_match: true, snippets: [] })
    if (hasText(name, e.size)) candidates.push(e)
  }
  for (let i = 0; i < queue.length && !partial; i++) visit(queue[i]!)

  // full text: the text mirror of each readable candidate (filled on first use, within a time budget), then ripgrep
  // over exactly those mirror files with a fixed string
  const deadline = Date.now() + FILES_LIMITS.searchMs
  const byMirror = new Map<string, FileEntry[]>()
  for (const f of candidates) {
    if (Date.now() > deadline) { partial = true; break }
    try {
      const mp = await w.mirror.textPath(access, f)
      byMirror.set(mp, [...byMirror.get(mp) ?? [], f])
    } catch (err) {
      if (err instanceof ExtractError || err instanceof Closed) continue
      throw err
    }
  }
  if (byMirror.size && TOOLS.rg) {
    const r = await runRg(['--json', '--no-config', '--no-ignore', '--hidden', '--no-follow', '--max-filesize', '50M', '-F', '-i',
      '-m', String(FILES_LIMITS.snippetsPerFile), '-e', q], [...byMirror.keys()], null, false)
    if (r.timedOut) partial = true
    for (const [mp, fs] of byMirror) {
      const evs = (r.events.get(mp) ?? []).filter((x) => x.type === 'match').slice(0, FILES_LIMITS.snippetsPerFile)
      if (!evs.length) continue
      for (const f of fs) {
        // R1 ⑦ right before content leaves: a file that changed under us is dropped (as if never there)
        try { access.recheck(f) } catch { continue }
        const snippets = evs.map((x) => ({ line: x.data.line_number ?? 0, text: snippet(evText(x.data.lines), q) }))
        const prev = hits.get(f.vpath)
        hits.set(f.vpath, prev ? { ...prev, snippets } : { path: f.vpath, name: entryName(f), kind: 'file', size: f.size, mtime: Math.round(f.mtimeMs), name_match: false, snippets })
      }
    }
  }
  const all = [...hits.values()].sort((x, y) => Number(y.name_match) - Number(x.name_match) || x.path.localeCompare(y.path))
  const results = all.slice(0, FILES_LIMITS.searchResults)
  audit(w, a, `files search ${JSON.stringify(q)} in ${where}`, results.filter((h) => h.snippets.length).map((h) => h.path))
  return { q, path: where, results, more: all.length > results.length, partial }
}
