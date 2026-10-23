// WebDAV (RFC 4918, class 1 and 2) at /dav/: mount Trina Drive's managed storage in Finder (Go → Connect to Server)
// or Windows Explorer (Map network drive). It is one more door to the same rooms:
//   - who: a person, by Basic auth with one of their app passwords (src/dav/apppw.ts), over HTTPS only (plain http is
//     refused before any password is looked at, except from this very machine); failed sign-ins are rate limited like
//     the web sign-in; agent tokens are never accepted (agents use MCP);
//   - what: Access.forPerson (R1), the same as the web: hidden == nonexistent (404, the same answer); only managed team
//     folders are shown (in-place NAS folders are hidden here: they change where they live, and a mount that shows
//     them read-only would invite saves that can only fail);
//   - every change goes through Managed (src/managed/ops.ts): write on the folder that changes, quota (507), versions
//     (a PUT over a file is a new version), trash (DELETE), the audit row in the same transaction, the text mirror;
//   - reads are audited too (each GET; ranged reads of one file coalesced per 10 minutes; a listing once per folder per
//     10 minutes — Finder lists all the time). Probes of names that are not there are not audited.
// Files a Mac or Office writes for itself (._*, .DS_Store, ~$*, Thumbs.db, desktop.ini …) are kept in memory for a day
// per person and never stored or shown to anyone else: clients need them to answer, Trina never keeps them.
import fs from 'node:fs'
import { PRODUCT } from '../config'
import { checkName, inManaged, ManagedError, openEntry, stageCopy, stageStream } from '../managed/core'
import { Managed, usage } from '../managed/ops'
import { ext, isSystemName, nfc } from '../names'
import { entryName, type Entry, type FileEntry, type Node } from '../policy'
import { RateLimiter } from '../ratelimit'
import { sha256 } from '../store'
import type { WebCtx } from '../web/http'
import { checkAppPassword } from './apppw'
import { locksOf, parseIf, parseTimeout, submittedTokens, type IfList, type Lock } from './locks'
import { davEnabled, isLoopbackAddr, isLoopbackHost } from './settings'
import { DAV, el, esc, kid, kids, parseXml, XML_HEAD, XmlError, type XNode } from './xml'

export const DAV_PREFIX = '/dav'
const BODY_MAX = 64 * 1024
const TEMP = { fileBytes: 1024 * 1024, perPerson: 1000, ttlMs: 24 * 3600_000 }
const COPY_MAX_ENTRIES = 10_000
const QUIET_MS = 10 * 60_000
const STARTED = Date.now()

const ALLOW = 'OPTIONS, GET, HEAD, PUT, DELETE, MKCOL, COPY, MOVE, PROPFIND, PROPPATCH, LOCK, UNLOCK'
const DAV_HEADERS = { dav: '1, 2', 'ms-author-via': 'DAV', allow: ALLOW }

// ---------- small answers ----------
const plain = (status: number, text: string, headers: Record<string, string> = {}) =>
  new Response(text ? text + '\n' : null, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers } })
const NOT_FOUND = () => plain(404, 'Not found')
const xml = (status: number, body: string, headers: Record<string, string> = {}) =>
  new Response(XML_HEAD + body, { status, headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'no-store', ...headers } })
const davError = (status: number, cond: string, inner = '') => xml(status, `<d:error xmlns:d="DAV:">${el(DAV, cond, inner)}</d:error>`)

/** A DAV request answered early. */
class Answer extends Error { constructor(readonly res: Response) { super('answer') } }
const answer = (res: Response): never => { throw new Answer(res) }

// ---------- per server: sign-in limits, listing/reads coalescing, the in-memory files of clients ----------
interface DavState { byName: RateLimiter; byAddr: RateLimiter; quiet: Map<string, number>; temp: Map<string, { bytes: Uint8Array; at: number }> }
const states = new WeakMap<object, DavState>()
function stateOf(w: WebCtx): DavState {
  let s = states.get(w.db)
  if (!s) {
    // like the web sign-in (src/web/server.ts), but only failures count: a mounted drive signs every request in
    s = { byName: new RateLimiter(10, 15 * 60_000, { db: w.db, scope: 'dav_name' }), byAddr: new RateLimiter(50, 15 * 60_000, { db: w.db, scope: 'dav_addr' }), quiet: new Map(), temp: new Map() }
    states.set(w.db, s)
  }
  return s
}
/** true the first time in QUIET_MS for this key (then it stays quiet) */
function firstIn(s: DavState, key: string): boolean {
  const t = Date.now(), last = s.quiet.get(key)
  if (last && t - last < QUIET_MS) return false
  s.quiet.set(key, t)
  if (s.quiet.size > 20_000) for (const [k, v] of s.quiet) if (t - v >= QUIET_MS) s.quiet.delete(k)
  return true
}

// ---------- paths ----------
/** /dav/a/b%20c/ → { vpath: "/a/b c", dir: true }; null for anything that is not a plain path under /dav. */
export function vpathOf(pathname: string): { vpath: string; slash: boolean } | null {
  if (pathname !== DAV_PREFIX && !pathname.startsWith(DAV_PREFIX + '/')) return null
  const rest = pathname.slice(DAV_PREFIX.length)
  const parts: string[] = []
  for (const raw of rest.split('/')) {
    if (!raw) continue
    let p: string
    try { p = decodeURIComponent(raw) } catch { return null }
    if (p === '.' || p === '..' || p.includes('/') || p.includes('\0') || p.includes('\\')) return null
    parts.push(nfc(p))
  }
  const vpath = '/' + parts.join('/')
  return vpath.length > 4096 ? null : { vpath, slash: rest.endsWith('/') }
}
export const hrefOf = (vpath: string, dir: boolean) =>
  DAV_PREFIX + (vpath === '/' ? '/' : vpath.split('/').map((p) => encodeURIComponent(p)).join('/') + (dir ? '/' : ''))
const parentOf = (vpath: string) => vpath.slice(0, vpath.lastIndexOf('/')) || '/'
const baseName = (vpath: string) => vpath.slice(vpath.lastIndexOf('/') + 1)
/** Names clients write for themselves: kept in memory for the client, never stored */
export const isClientJunk = (name: string) => isSystemName(name) || /^(desktop\.ini|thumbs\.db|\.localized)$/i.test(name)

// ---------- resources ----------
type Res = { kind: 'root' } | { kind: 'dir'; node: Node } | { kind: 'file'; f: FileEntry }
interface Ctx { w: WebCtx; req: Request; url: URL; addr: string; personId: number; m: Managed; s: DavState; vpath: string; ifLists: IfList[] | null; tokens: Set<string> }

function find(m: Managed, vpath: string): Res | null {
  if (vpath === '/') return { kind: 'root' }
  const e = m.entry(vpath)
  if (!e) return null
  if (!inManaged(m.ids, e.kind === 'dir' ? e.node : e.parent)) return null // in-place folders are not on the mount
  return e.kind === 'dir' ? { kind: 'dir', node: e.node } : { kind: 'file', f: e }
}
const isDir = (r: Res) => r.kind !== 'file'
const resVpath = (r: Res) => r.kind === 'root' ? '/' : r.kind === 'dir' ? r.node.vpath : r.f.vpath
const etagOf = (f: FileEntry) => `"${sha256(`${f.dev}:${f.ino}:${f.size}:${f.mtimeNs}`).slice(0, 24)}"`
const ms = (ns: bigint) => Number(ns / 1_000_000n)

function children(m: Managed, r: Res): Res[] {
  const list: Entry[] = r.kind === 'root' ? m.access.rootEntries() : r.kind === 'dir' ? m.access.list(r.node) : []
  return list.filter((e) => inManaged(m.ids, e.kind === 'dir' ? e.node : e.parent)).map((e) => e.kind === 'dir' ? { kind: 'dir' as const, node: e.node } : { kind: 'file' as const, f: e })
}

/** The folder a resource changes when it is created, replaced, moved or deleted (null: the root / a top folder). */
const containerOf = (r: Res): Node | null => r.kind === 'file' ? r.f.parent : r.kind === 'dir' ? r.node.parent : null

// ---------- entry point ----------
export async function handleDav(w: WebCtx, req: Request, addr = 'unknown'): Promise<Response> {
  if (!davEnabled(w)) return NOT_FOUND()
  const url = new URL(req.url)
  const p = vpathOf(url.pathname)
  if (!p) return plain(400, 'Bad path')
  // passwords never travel over plain http to us (a client on this machine may: nothing crosses a network)
  const https = url.protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https'
  if (!https && !(isLoopbackAddr(addr) && isLoopbackHost(url.host))) return plain(403, `${PRODUCT} mounts over HTTPS only: use the https:// address`)
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: { ...DAV_HEADERS, 'content-length': '0' } })
  const s = stateOf(w)
  const personId = signIn(w, s, req, addr)
  if (typeof personId !== 'number') return personId
  let ifLists: IfList[] | null = null
  const ifh = req.headers.get('if')
  if (ifh) { ifLists = parseIf(ifh); if (!ifLists) return plain(400, 'Bad If header') }
  const c: Ctx = { w, req, url, addr, personId, m: new Managed(w, personId, 'webdav'), s, vpath: p.vpath, ifLists, tokens: submittedTokens(ifLists) }
  try {
    if (isClientJunk(baseName(p.vpath)) && p.vpath !== '/') return await junk(c)
    switch (req.method) {
      case 'PROPFIND': return await propfind(c)
      case 'GET': case 'HEAD': return get(c)
      case 'PUT': return await put(c)
      case 'MKCOL': return await mkcol(c)
      case 'DELETE': return del(c)
      case 'MOVE': case 'COPY': return await moveCopy(c, req.method === 'MOVE')
      case 'LOCK': return await lock(c)
      case 'UNLOCK': return unlock(c)
      case 'PROPPATCH': return await proppatch(c)
      default: return plain(405, 'Method not allowed', { allow: ALLOW })
    }
  } catch (e) {
    if (e instanceof Answer) return e.res
    if (e instanceof ManagedError) return fromManaged(e)
    if (e instanceof XmlError) return plain(400, `Bad XML: ${e.message}`)
    throw e
  }
}

/** The answer to OPTIONS anywhere (Windows asks the server root first). */
export const davOptions = () => new Response(null, { status: 200, headers: { ...DAV_HEADERS, 'content-length': '0' } })

function fromManaged(e: ManagedError): Response {
  if (e.status === 404) return NOT_FOUND()
  if (e.code === 'has_hidden') return plain(403, e.message)
  return plain(e.status, e.message)
}

// ---------- sign-in ----------
function signIn(w: WebCtx, s: DavState, req: Request, addr: string): number | Response {
  const challenge = { 'www-authenticate': `Basic realm="${PRODUCT}", charset="UTF-8"` }
  const h = req.headers.get('authorization') ?? ''
  const m = /^Basic\s+([A-Za-z0-9+/=]{1,512})$/i.exec(h.trim())
  if (!m) return plain(401, 'Sign in with your name and an app password (Settings → Mount as a drive)', challenge)
  const decoded = Buffer.from(m[1]!, 'base64').toString('utf8')
  const i = decoded.indexOf(':')
  const login = (i >= 0 ? decoded.slice(0, i) : decoded).trim().toLowerCase().slice(0, 254)
  const secret = i >= 0 ? decoded.slice(i + 1) : ''
  if (s.byName.blocked(login) || s.byAddr.blocked(addr)) {
    const after = Math.max(s.byName.retryAfter(login), s.byAddr.retryAfter(addr))
    return plain(429, 'Too many failed sign-ins; wait a few minutes', { 'retry-after': String(after) })
  }
  const pid = checkAppPassword(w.db, decoded.slice(0, Math.max(0, i)).trim(), secret, addr)
  if (pid === null) { s.byName.hit(login); s.byAddr.hit(addr); return plain(401, 'Wrong name or app password', challenge) }
  s.byName.reset(login)
  return pid
}

// ---------- locks and If ----------
function ifHolds(c: Ctx): boolean {
  if (!c.ifLists) return true
  return c.ifLists.some((l) => {
    let path = c.vpath
    if (l.resource) { try { const v = vpathOf(new URL(l.resource, c.url).pathname); if (!v) return false; path = v.vpath } catch { return false } }
    const locks = locksOf(c.w.db).covering(path)
    let etag: string | null = null
    if (l.conditions.some((x) => x.etag)) { const r = find(c.m, path); etag = r?.kind === 'file' ? etagOf(r.f) : null }
    return l.conditions.every((x) => {
      const ok = x.token !== undefined ? locks.some((k) => k.token === x.token) : etag !== null && etag === `"${x.etag!.replace(/^"|"$/g, '')}"`
      return x.not ? !ok : ok
    })
  })
}
/** 423 when a lock this person does not hold covers `vpath` (and below it, with `deep`). */
function mustUnlocked(c: Ctx, vpath: string, deep = false) {
  const l = locksOf(c.w.db).blocking(vpath, c.personId, c.tokens, deep)
  if (l) answer(davError(423, 'lock-token-submitted', el(DAV, 'href', esc(hrefOf(l.path, false)))))
}
function preconditions(c: Ctx) { if (!ifHolds(c)) answer(plain(412, 'Precondition failed')) }

// ---------- PROPFIND ----------
const LIVE = ['resourcetype', 'displayname', 'getcontentlength', 'getlastmodified', 'creationdate', 'getetag', 'getcontenttype', 'supportedlock', 'lockdiscovery'] as const
const QUOTA = ['quota-available-bytes', 'quota-used-bytes'] as const

const TYPES: Record<string, string> = {
  pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  hwp: 'application/x-hwp', hwpx: 'application/hwp+zip', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', zip: 'application/zip', mp4: 'video/mp4',
}

function activeLock(l: Lock) {
  return el(DAV, 'activelock', el(DAV, 'locktype', el(DAV, 'write')) + el(DAV, 'lockscope', el(DAV, l.exclusive ? 'exclusive' : 'shared')) +
    el(DAV, 'depth', l.deep ? 'infinity' : '0') + (l.owner ? el(DAV, 'owner', l.owner) : '') + el(DAV, 'timeout', `Second-${Math.max(0, Math.round((l.expires - Date.now()) / 1000))}`) +
    el(DAV, 'locktoken', el(DAV, 'href', esc(l.token))) + el(DAV, 'lockroot', el(DAV, 'href', esc(hrefOf(l.path, false)))))
}

function liveProp(c: Ctx, r: Res, name: string): string | null {
  const vp = resVpath(r)
  switch (name) {
    case 'resourcetype': return isDir(r) ? el(DAV, 'collection') : ''
    case 'displayname': return esc(r.kind === 'root' ? PRODUCT : baseName(vp))
    case 'getcontentlength': return r.kind === 'file' ? String(r.f.size) : null
    // a folder seen only as a path to something shared below it (a bare path) shows no time of its own: its birth
    // time would say when a folder the person cannot read was made (A2: names only)
    case 'getlastmodified': return new Date(r.kind === 'file' ? r.f.mtimeMs : r.kind === 'dir' && r.node.birth > 0n && c.m.access.canRead(r.node) ? ms(r.node.birth) : STARTED).toUTCString()
    case 'creationdate': return new Date(r.kind === 'dir' && r.node.birth > 0n && c.m.access.canRead(r.node) ? ms(r.node.birth) : r.kind === 'file' ? r.f.mtimeMs : STARTED).toISOString()
    case 'getetag': return r.kind === 'file' ? esc(etagOf(r.f)) : null
    case 'getcontenttype': return r.kind === 'file' ? TYPES[ext(r.f.name)] ?? 'application/octet-stream' : null
    case 'supportedlock': return el(DAV, 'lockentry', el(DAV, 'lockscope', el(DAV, 'exclusive')) + el(DAV, 'locktype', el(DAV, 'write'))) +
      el(DAV, 'lockentry', el(DAV, 'lockscope', el(DAV, 'shared')) + el(DAV, 'locktype', el(DAV, 'write')))
    case 'lockdiscovery': return locksOf(c.w.db).covering(vp).map(activeLock).join('')
    case 'quota-used-bytes': case 'quota-available-bytes': {
      if (!isDir(r)) return null
      const u = usage(c.w.db).total
      if (name === 'quota-used-bytes') return String(u)
      return c.m.s.quotaBytes === null ? null : String(Math.max(0, c.m.s.quotaBytes - u))
    }
  }
  return null
}

type Want = { kind: 'all' } | { kind: 'names' } | { kind: 'props'; props: { ns: string; local: string }[] }

function responseFor(c: Ctx, r: Res, want: Want): string {
  const href = el(DAV, 'href', esc(hrefOf(resVpath(r), isDir(r))))
  const ok: string[] = [], missing: string[] = []
  if (want.kind === 'names') for (const n of [...LIVE, ...QUOTA]) { if (liveProp(c, r, n) !== null) ok.push(el(DAV, n)) }
  else if (want.kind === 'all') for (const n of LIVE) { const v = liveProp(c, r, n); if (v !== null) ok.push(el(DAV, n, v)) }
  else for (const p of want.props) {
    const v = p.ns === DAV ? liveProp(c, r, p.local) : null
    if (v === null) missing.push(el(p.ns, p.local)); else ok.push(el(p.ns, p.local, v))
  }
  const stat = (props: string[], status: string) => props.length ? el(DAV, 'propstat', el(DAV, 'prop', props.join('')) + el(DAV, 'status', status)) : ''
  return el(DAV, 'response', href + stat(ok, 'HTTP/1.1 200 OK') + stat(missing, 'HTTP/1.1 404 Not Found'))
}

async function readBody(c: Ctx): Promise<XNode | null> {
  const len = Number(c.req.headers.get('content-length') ?? 0)
  if (len > BODY_MAX) answer(plain(413, 'Request body too large'))
  const text = await readCapped(c.req, BODY_MAX)
  return text.trim() ? parseXml(text) : null
}
async function readCapped(req: Request, max: number): Promise<string> {
  if (!req.body) return ''
  const reader = req.body.getReader()
  const parts: Uint8Array[] = []
  let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    n += value.length
    if (n > max) { await reader.cancel().catch(() => {}); answer(plain(413, 'Request body too large')) }
    parts.push(value)
  }
  return Buffer.concat(parts).toString('utf8')
}

async function propfind(c: Ctx): Promise<Response> {
  const depth = (c.req.headers.get('depth') ?? 'infinity').toLowerCase()
  if (depth !== '0' && depth !== '1') return davError(403, 'propfind-finite-depth')
  const body = await readBody(c)
  let want: Want = { kind: 'all' }
  if (body) {
    if (body.ns !== DAV || body.local !== 'propfind') return plain(400, 'Expected a propfind element')
    const prop = kid(body, 'prop')
    if (kid(body, 'propname')) want = { kind: 'names' }
    else if (prop) want = { kind: 'props', props: prop.children.map((x) => ({ ns: x.ns, local: x.local })) }
  }
  const r = find(c.m, c.vpath)
  if (!r) return NOT_FOUND()
  const list = [r, ...(depth === '1' ? children(c.m, r) : [])]
  if (depth === '1' && isDir(r) && firstIn(c.s, `list:${c.personId}:${resVpath(r)}`))
    c.m.audit(`files list ${resVpath(r)}`, r.kind === 'root' ? [] : [resVpath(r)])
  return xml(207, `<d:multistatus xmlns:d="DAV:">${list.map((x) => responseFor(c, x, want)).join('')}</d:multistatus>`)
}

// ---------- GET / HEAD ----------
function parseRange(h: string | null, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec((h ?? '').trim())
  if (!m || (!m[1] && !m[2])) return null
  let start: number, end: number
  if (!m[1]) { const n = Number(m[2]); if (!n) return 'unsatisfiable'; start = Math.max(0, size - n); end = size - 1 }
  else { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1; if (m[2] && Number(m[2]) < start) return null }
  if (start >= size) return 'unsatisfiable'
  return { start, end }
}

function get(c: Ctx): Response {
  const r = find(c.m, c.vpath)
  if (!r) return NOT_FOUND()
  if (r.kind !== 'file') return plain(200, `${PRODUCT}: this is a folder. Mount ${hrefOf(resVpath(r), true)} as a network drive to see its files.`)
  const f = r.f
  const etag = etagOf(f)
  const head = c.req.method === 'HEAD'
  const base: Record<string, string> = {
    // never rendered on this origin: the app's session lives here (same rules as every download)
    'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'cache-control': 'no-store',
    etag, 'last-modified': new Date(f.mtimeMs).toUTCString(), 'accept-ranges': 'bytes',
  }
  const inm = c.req.headers.get('if-none-match')
  if (inm && inm.split(',').map((x) => x.trim()).some((x) => x === etag || x === '*')) return new Response(null, { status: 304, headers: { etag } })
  let fd: number
  try { fd = openEntry(f); c.m.access.recheck(f) } catch { return NOT_FOUND() }
  const size = Number(fs.fstatSync(fd).size)
  const ifRange = c.req.headers.get('if-range')
  let range = ifRange && ifRange !== etag ? null : parseRange(c.req.headers.get('range'), size)
  if (range === 'unsatisfiable') { fs.closeSync(fd); return plain(416, 'Range not satisfiable', { 'content-range': `bytes */${size}` }) }
  if (head) {
    fs.closeSync(fd)
    return new Response(null, { status: 200, headers: { ...base, 'content-length': String(size) } })
  }
  try {
    const ranged = range !== null
    if (!ranged || firstIn(c.s, `read:${c.personId}:${f.vpath}:${etag}`))
      c.m.audit(`files download ${f.vpath}${ranged ? ` (bytes ${range!.start}-${range!.end})` : ''}`, [f.vpath])
  } catch (e) { fs.closeSync(fd); throw e }
  const start = range?.start ?? 0, end = range?.end ?? size - 1
  let off = start, open = true
  const close = () => { if (open) { open = false; fs.closeSync(fd) } }
  const body = new ReadableStream<Uint8Array>({
    pull(ctl) {
      const want = Math.min(1024 * 1024, end + 1 - off)
      if (want <= 0) { close(); ctl.close(); return }
      const buf = Buffer.alloc(want)
      const n = fs.readSync(fd, buf, 0, want, off)
      if (n <= 0) { close(); ctl.close(); return }
      off += n
      ctl.enqueue(buf.subarray(0, n))
    },
    cancel() { close() },
  })
  if (size === 0) { close(); return new Response(null, { status: 200, headers: { ...base, 'content-length': '0' } }) }
  return range
    ? new Response(body, { status: 206, headers: { ...base, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) } })
    : new Response(body, { status: 200, headers: { ...base, 'content-length': String(size) } })
}

// ---------- PUT ----------
/** The folder a new name goes into: 409 when it is not there (hidden alike), 403 when it cannot be written. */
function parentFor(c: Ctx, vpath: string): Node {
  const pr = find(c.m, parentOf(vpath))
  if (!pr || pr.kind === 'file') answer(plain(409, 'The folder this goes into does not exist'))
  if (pr!.kind === 'root') answer(plain(403, 'Team folders are made by the admin'))
  c.m.mayWrite((pr as { node: Node }).node)
  return (pr as { node: Node }).node
}

async function put(c: Ctx): Promise<Response> {
  if (c.req.headers.get('content-range')) return plain(400, 'Partial PUT is not supported')
  const len = c.req.headers.get('content-length')
  if (len !== null && Number(len) > c.m.s.maxFileBytes) return plain(413, 'File too large')
  preconditions(c)
  const existing = find(c.m, c.vpath)
  if (existing && isDir(existing)) return plain(405, 'A folder is there')
  // a new version of a file shared with this person as Editor (A2): the folder itself stays read-only to them
  const parent = existing?.kind === 'file' && c.m.canWriteFile(existing.f) ? existing.f.parent : parentFor(c, c.vpath)
  mustUnlocked(c, c.vpath)
  if (!existing) mustUnlocked(c, parent.vpath)
  const name = checkName(baseName(c.vpath))
  const staged = await stageStream(c.m.s.root, c.req.body, c.m.s.maxFileBytes, 'dav')
  // judged again after the bytes arrived (the folder, the rules and the name may have changed meanwhile)
  const m = new Managed(c.w, c.personId, 'webdav')
  const now = find(m, c.vpath)
  const r = now?.kind === 'file' ? m.put(parent.vpath, now.f.name, staged, 'replace', 'webdav-put') : m.put(parent.vpath, name, staged, 'fail', 'webdav-put')
  const after = find(m, r.path)
  return new Response(null, { status: r.replaced ? 204 : 201, headers: after?.kind === 'file' ? { etag: etagOf(after.f) } : {} })
}

// ---------- MKCOL ----------
async function mkcol(c: Ctx): Promise<Response> {
  if (c.req.body && (await readCapped(c.req, BODY_MAX)).length) return plain(415, 'MKCOL takes no body')
  preconditions(c)
  if (find(c.m, c.vpath)) return plain(405, 'Something is there already')
  const parent = parentFor(c, c.vpath)
  mustUnlocked(c, parent.vpath)
  try { c.m.mkdir(parent.vpath, baseName(c.vpath)) } catch (e) {
    if (e instanceof ManagedError && e.code === 'exists') return plain(405, 'Something is there already')
    throw e
  }
  return new Response(null, { status: 201 })
}

// ---------- DELETE ----------
function del(c: Ctx): Response {
  const depth = c.req.headers.get('depth')
  const r = find(c.m, c.vpath)
  if (!r) return NOT_FOUND()
  if (isDir(r) && depth !== null && depth.toLowerCase() !== 'infinity') return plain(400, 'Folders are deleted with Depth: infinity')
  if (r.kind === 'root' || !containerOf(r)) return plain(403, 'Team folders are removed by the admin')
  preconditions(c)
  mustUnlocked(c, c.vpath, true)
  mustUnlocked(c, parentOf(c.vpath))
  removeOrThrow(c.m, resVpath(r))
  locksOf(c.w.db).dropUnder(resVpath(r))
  return new Response(null, { status: 204 })
}
const removeOrThrow = (m: Managed, vpath: string) => m.removeOne(vpath)

// ---------- MOVE / COPY ----------
async function moveCopy(c: Ctx, move: boolean): Promise<Response> {
  const dh = c.req.headers.get('destination')
  if (!dh) return plain(400, 'Destination header required')
  let du: URL
  try { du = new URL(dh, c.url) } catch { return plain(400, 'Bad Destination') }
  const pub = c.w.opts.publicUrl ? new URL(c.w.opts.publicUrl).host : null
  if (du.host !== c.url.host && du.host !== pub) return plain(502, 'Destination is on another server')
  const dp = vpathOf(du.pathname)
  if (!dp || dp.vpath === '/') return plain(403, 'Bad Destination')
  const overwrite = (c.req.headers.get('overwrite') ?? 'T').toUpperCase() !== 'F'
  const depth = (c.req.headers.get('depth') ?? 'infinity').toLowerCase()
  const src = find(c.m, c.vpath)
  if (!src) return NOT_FOUND()
  if (src.kind === 'root') return plain(403, 'The root cannot be moved')
  const dest = dp.vpath
  const sv = resVpath(src)
  if (dest === sv) return plain(403, 'Source and destination are the same')
  if (isDir(src) && (dest + '/').toLowerCase().startsWith(sv.toLowerCase() + '/')) return plain(403, 'A folder cannot go into itself')
  if (isClientJunk(baseName(dest))) return plain(403, 'That name is reserved for system files')
  preconditions(c)
  if (move) { mustUnlocked(c, sv, true); mustUnlocked(c, parentOf(sv)) }
  const destParent = parentFor(c, dest)
  if (move) c.m.mayWrite(containerOf(src) ?? answer(plain(403, 'Team folders are moved by the admin')))
  const there = find(c.m, dest)
  mustUnlocked(c, dest, true)
  if (!there) mustUnlocked(c, destParent.vpath)
  const name = checkName(baseName(dest))
  if (there && !overwrite) return plain(412, 'The destination exists (Overwrite: F)')
  const status = there ? 204 : 201
  // a file onto a file: a new version of the destination (its history stays), then the source goes to the trash
  if (there && there.kind === 'file' && src.kind === 'file') {
    const staged = stageCopy(c.m.s.root, src.f)
    c.m.put(destParent.vpath, there.f.name, staged, 'replace', move ? 'webdav-move' : 'webdav-copy')
    if (move) { removeOrThrow(new Managed(c.w, c.personId, 'webdav'), sv); locksOf(c.w.db).dropUnder(sv) }
    return new Response(null, { status })
  }
  if (there) { removeOrThrow(c.m, resVpath(there)); locksOf(c.w.db).dropUnder(resVpath(there)) }
  const m = there ? new Managed(c.w, c.personId, 'webdav') : c.m
  if (move) {
    m.moveTo(sv, destParent.vpath, name)
    locksOf(c.w.db).dropUnder(sv)
    return new Response(null, { status })
  }
  if (src.kind === 'file') {
    m.put(destParent.vpath, name, stageCopy(m.s.root, src.f), 'fail', 'webdav-copy')
    return new Response(null, { status })
  }
  copyTree(m, src as { kind: 'dir'; node: Node }, destParent.vpath, name, depth === '0' ? 0 : Infinity)
  return new Response(null, { status })
}

/** A folder copied: what this person sees of it (hidden items are not theirs to copy), up to COPY_MAX_ENTRIES. */
function copyTree(m0: Managed, src: { kind: 'dir'; node: Node }, into: string, name: string, depth: number) {
  let n = 0
  const walk = (s: Node, parent: string, nm: string, d: number) => {
    const made = new Managed(m0.ctx, m0.personId, m0.tool).mkdir(parent, nm).path
    if (d <= 0) return
    // a new folder: a fresh view (the policy caches listings per request)
    const m = new Managed(m0.ctx, m0.personId, m0.tool)
    for (const e of m0.access.list(s)) {
      if (++n > COPY_MAX_ENTRIES) throw new ManagedError(413, 'too_many', 'this folder holds too many items to copy at once')
      if (e.kind === 'dir') walk(e.node, made, entryName(e), d - 1)
      else m.put(made, e.name, stageCopy(m.s.root, e), 'fail', 'webdav-copy')
    }
  }
  walk(src.node, into, name, depth)
}

// ---------- LOCK / UNLOCK ----------
function ownerOf(n: XNode | undefined): string {
  if (!n) return ''
  const href = kid(n, 'href')
  if (href) return el(DAV, 'href', esc(href.text.trim().slice(0, 512)))
  return esc(n.text.trim().slice(0, 512))
}

async function lock(c: Ctx): Promise<Response> {
  const body = await readBody(c)
  const locks = locksOf(c.w.db)
  const timeoutS = parseTimeout(c.req.headers.get('timeout'))
  if (!body) {
    // a refresh: the If header names the lock
    const r = find(c.m, c.vpath)
    if (!r) return NOT_FOUND()
    const l = locks.covering(c.vpath).find((x) => c.tokens.has(x.token) && x.personId === c.personId)
    if (!l) return davError(412, 'lock-token-matches-request-uri')
    locks.refresh(l, timeoutS)
    return xml(200, `<d:prop xmlns:d="DAV:">${el(DAV, 'lockdiscovery', activeLock(l))}</d:prop>`)
  }
  if (body.ns !== DAV || body.local !== 'lockinfo') return plain(400, 'Expected a lockinfo element')
  const scope = kid(body, 'lockscope')
  const exclusive = !!(scope && kid(scope, 'exclusive'))
  if (!scope || (!exclusive && !kid(scope, 'shared'))) return plain(400, 'lockscope: exclusive or shared')
  const lt = kid(body, 'locktype')
  if (!lt || !kid(lt, 'write')) return plain(400, 'Only write locks')
  const depth = (c.req.headers.get('depth') ?? 'infinity').toLowerCase()
  if (depth !== '0' && depth !== 'infinity') return plain(400, 'Depth: 0 or infinity')
  preconditions(c)
  let r = find(c.m, c.vpath)
  let created = false
  if (r) {
    const box = r.kind === 'dir' ? r.node : containerOf(r)
    if (!box) return plain(403, 'The root cannot be locked')
    c.m.mayWrite(box)
  } else {
    // an unmapped name: lock it by creating an empty file (RFC 4918 §7.3); its folder must be there and writable
    const parent = parentFor(c, c.vpath)
    mustUnlocked(c, parent.vpath)
    c.m.put(parent.vpath, checkName(baseName(c.vpath)), await stageStream(c.m.s.root, null, 0, 'dav'), 'fail', 'webdav-lock')
    r = find(new Managed(c.w, c.personId, 'webdav'), c.vpath)
    created = true
  }
  const l = locks.create(r ? resVpath(r) : c.vpath, c.personId, { exclusive, deep: depth === 'infinity' && !!r && isDir(r), owner: ownerOf(kid(body, 'owner')), timeoutS })
  if (!l) return davError(423, 'no-conflicting-lock')
  return xml(created ? 201 : 200, `<d:prop xmlns:d="DAV:">${el(DAV, 'lockdiscovery', activeLock(l))}</d:prop>`, { 'lock-token': `<${l.token}>` })
}

function unlock(c: Ctx): Response {
  const t = /^<([^>]+)>$/.exec((c.req.headers.get('lock-token') ?? '').trim())?.[1]
  if (!t) return plain(400, 'Lock-Token header required')
  const r = isClientJunk(baseName(c.vpath)) ? true : find(c.m, c.vpath)
  if (!r) return NOT_FOUND()
  const locks = locksOf(c.w.db)
  const l = locks.get(t)
  if (!l || !locks.covering(c.vpath).includes(l)) return davError(409, 'lock-token-matches-request-uri')
  if (l.personId !== c.personId) return plain(403, 'This lock is someone else’s')
  locks.remove(t)
  return new Response(null, { status: 204 })
}

// ---------- PROPPATCH ----------
// Dead properties are not kept (Windows sets its file times and attributes this way and only needs a yes); the live
// DAV: properties are protected.
async function proppatch(c: Ctx): Promise<Response> {
  const body = await readBody(c)
  if (!body || body.ns !== DAV || body.local !== 'propertyupdate') return plain(400, 'Expected a propertyupdate element')
  const r = isClientJunk(baseName(c.vpath)) ? null : find(c.m, c.vpath)
  if (!r) return NOT_FOUND()
  const box = r.kind === 'dir' ? r.node : containerOf(r)
  if (!box) return plain(403, 'The root has no properties to change')
  c.m.mayWrite(box)
  preconditions(c)
  mustUnlocked(c, c.vpath)
  return xml(207, `<d:multistatus xmlns:d="DAV:">${proppatchResponse(resVpath(r), isDir(r), body)}</d:multistatus>`)
}
function proppatchResponse(vpath: string, dir: boolean, body: XNode): string {
  const props = [...kids(body, 'set'), ...kids(body, 'remove')].flatMap((x) => kid(x, 'prop')?.children ?? [])
  const prot = props.filter((p) => p.ns === DAV), free = props.filter((p) => p.ns !== DAV)
  const stat = (ps: XNode[], status: string) => ps.length ? el(DAV, 'propstat', el(DAV, 'prop', ps.map((p) => el(p.ns, p.local)).join('')) + el(DAV, 'status', status)) : ''
  // one protected property fails the whole request (RFC 4918 §9.2): the others answer 424
  return el(DAV, 'response', el(DAV, 'href', esc(hrefOf(vpath, dir))) +
    (prot.length ? stat(prot, 'HTTP/1.1 403 Forbidden') + stat(free, 'HTTP/1.1 424 Failed Dependency') : stat(free, 'HTTP/1.1 200 OK')))
}

// ---------- the clients' own files (._*, .DS_Store, ~$*): in memory, never stored ----------
async function junk(c: Ctx): Promise<Response> {
  const s = c.s
  const k = `${c.personId}\0${nfc(c.vpath).toLowerCase()}`
  const t = Date.now()
  for (const [key, v] of s.temp) if (t - v.at > TEMP.ttlMs) s.temp.delete(key)
  const hit = s.temp.get(k)
  const parentOk = () => { const node = parentFor(c, c.vpath); return node }
  switch (c.req.method) {
    case 'PUT': {
      parentOk()
      const len = Number(c.req.headers.get('content-length') ?? 0)
      if (len > TEMP.fileBytes) return plain(507, 'System files are kept small')
      const text = c.req.body ? new Uint8Array(await new Response(c.req.body).arrayBuffer()) : new Uint8Array()
      if (text.length > TEMP.fileBytes) return plain(507, 'System files are kept small')
      if (!hit && [...s.temp.keys()].filter((x) => x.startsWith(`${c.personId}\0`)).length >= TEMP.perPerson) return plain(507, 'Too many system files')
      s.temp.set(k, { bytes: text, at: t })
      return new Response(null, { status: hit ? 204 : 201 })
    }
    case 'GET': case 'HEAD':
      if (!hit) return NOT_FOUND()
      return new Response(c.req.method === 'HEAD' ? null : hit.bytes, { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(hit.bytes.length),
        'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'cache-control': 'no-store' } })
    case 'DELETE':
      if (!hit) return NOT_FOUND()
      s.temp.delete(k)
      return new Response(null, { status: 204 })
    case 'PROPFIND': {
      if (!hit) return NOT_FOUND()
      const href = el(DAV, 'href', esc(hrefOf(c.vpath, false)))
      const props = el(DAV, 'resourcetype') + el(DAV, 'getcontentlength', String(hit.bytes.length)) + el(DAV, 'getlastmodified', new Date(hit.at).toUTCString()) + el(DAV, 'displayname', esc(baseName(c.vpath)))
      return xml(207, `<d:multistatus xmlns:d="DAV:">${el(DAV, 'response', href + el(DAV, 'propstat', el(DAV, 'prop', props) + el(DAV, 'status', 'HTTP/1.1 200 OK')))}</d:multistatus>`)
    }
    case 'LOCK': {
      const body = await readBody(c)
      const locks = locksOf(c.w.db)
      if (!body) {
        const l = locks.covering(c.vpath).find((x) => c.tokens.has(x.token) && x.personId === c.personId)
        if (!l) return davError(412, 'lock-token-matches-request-uri')
        locks.refresh(l, parseTimeout(c.req.headers.get('timeout')))
        return xml(200, `<d:prop xmlns:d="DAV:">${el(DAV, 'lockdiscovery', activeLock(l))}</d:prop>`)
      }
      parentOk()
      if (!hit) s.temp.set(k, { bytes: new Uint8Array(), at: t })
      const scope = kid(body, 'lockscope')
      const l = locks.create(c.vpath, c.personId, { exclusive: !!(scope && kid(scope, 'exclusive')), deep: false, owner: ownerOf(kid(body, 'owner')), timeoutS: parseTimeout(c.req.headers.get('timeout')) })
      if (!l) return davError(423, 'no-conflicting-lock')
      return xml(hit ? 200 : 201, `<d:prop xmlns:d="DAV:">${el(DAV, 'lockdiscovery', activeLock(l))}</d:prop>`, { 'lock-token': `<${l.token}>` })
    }
    case 'UNLOCK': return unlock(c)
    case 'PROPPATCH': {
      if (!hit) return NOT_FOUND()
      const body = await readBody(c)
      if (!body) return plain(400, 'Expected a propertyupdate element')
      return xml(207, `<d:multistatus xmlns:d="DAV:">${proppatchResponse(c.vpath, false, body)}</d:multistatus>`)
    }
    case 'MOVE': case 'COPY': {
      if (!hit) return NOT_FOUND()
      const dh = c.req.headers.get('destination')
      let dp: { vpath: string } | null = null
      try { dp = dh ? vpathOf(new URL(dh, c.url).pathname) : null } catch {}
      if (!dp) return plain(400, 'Bad Destination')
      if (!isClientJunk(baseName(dp.vpath))) {
        // a client's temporary file saved under a real name: now it is a real file
        const parent = parentFor(c, dp.vpath)
        const there = find(c.m, dp.vpath)
        const over = (c.req.headers.get('overwrite') ?? 'T').toUpperCase() !== 'F'
        if (there && (!over || there.kind !== 'file')) return plain(412, 'The destination exists')
        mustUnlocked(c, dp.vpath)
        const staged = await stageStream(c.m.s.root, new Response(hit.bytes).body, c.m.s.maxFileBytes, 'dav')
        c.m.put(parent.vpath, there?.kind === 'file' ? there.f.name : checkName(baseName(dp.vpath)), staged, there ? 'replace' : 'fail', 'webdav-move')
        if (c.req.method === 'MOVE') s.temp.delete(k)
        return new Response(null, { status: there ? 204 : 201 })
      }
      parentFor(c, dp.vpath)
      const dk = `${c.personId}\0${nfc(dp.vpath).toLowerCase()}`
      const existed = s.temp.has(dk)
      s.temp.set(dk, { bytes: hit.bytes, at: t })
      if (c.req.method === 'MOVE') s.temp.delete(k)
      return new Response(null, { status: existed ? 204 : 201 })
    }
    case 'MKCOL': return plain(403, 'That name is reserved for system files')
    default: return plain(405, 'Method not allowed', { allow: ALLOW })
  }
}
