// A person on a team drive: their browser session (cookie jar + CSRF) and the three other ways in — MCP with a token
// (their AI), WebDAV with an app password (a mounted drive), and the web API itself. Request shapes are the product's
// (src/web/api.ts, src/managed/web.ts, src/dav/handler.ts); the sharing API is plan §3.7 (A1).
import crypto from 'node:crypto'
import { Http, Jar, type Res } from './http'
import { freshTotp } from './totp'
import type { Target } from './target'

export interface PersonCreds { name: string; email: string; password: string; totp?: string }

let rpcId = 1

export class Drive {
  csrf = ''
  personId = 0
  constructor(public http: Http, public slug: string, public who: string, public jar: Jar = new Jar()) {}
  get base() { return this.http.t.teamUrl(this.slug) }
  get t(): Target { return this.http.t }

  api(method: string, p: string, body?: unknown, o: { origin?: boolean | string; raw?: BodyInit; headers?: Record<string, string> } = {}): Promise<Res> {
    return this.http.req(method, `${this.base}/api${p}`, { jar: this.jar, csrf: this.csrf || undefined, body, ...o })
  }
  get(p: string) { return this.api('GET', p) }

  /** password sign-in (+ authenticator code when asked); throws with the answer when it does not work */
  async login(c: PersonCreds): Promise<this> {
    let r = await this.api('POST', '/login', { login: c.name, password: c.password })
    if (r.status === 200 && r.json().second_factor) {
      if (!c.totp) throw new Error(`${c.name}: the drive asks for a second factor and the fixture has none`)
      r = await this.api('POST', '/login/second', { ticket: r.json().second_factor.ticket, method: 'totp', code: await freshTotp(c.totp) })
    }
    if (r.status !== 200) throw new Error(`${c.name}: sign-in ${r.status} ${r.text.slice(0, 200)}`)
    this.csrf = r.json().csrf ?? ''
    await this.session()
    return this
  }

  /** adopt a session the SSO callback started (cookie in the jar); reads csrf + me */
  async session(): Promise<any> {
    const s = await this.get('/session')
    if (s.status !== 200) throw new Error(`${this.who}: /api/session ${s.status} ${s.text.slice(0, 200)}`)
    const j = s.json()
    this.csrf = j.csrf
    this.personId = j.me?.id ?? j.me?.person_id ?? 0
    return j
  }

  // ---------- files ----------
  list(p: string) { return this.get(`/files?path=${encodeURIComponent(p)}`) }
  stat(p: string) { return this.get(`/files/stat?path=${encodeURIComponent(p)}`) }
  download(p: string) { return this.get(`/files/download?path=${encodeURIComponent(p)}`) }
  text(p: string) { return this.get(`/files/text?path=${encodeURIComponent(p)}`) }
  who_(p: string) { return this.get(`/files/who?path=${encodeURIComponent(p)}`) }
  search(q: string) { return this.get(`/search?q=${encodeURIComponent(q)}`) }
  mkdir(p: string, name: string) { return this.api('POST', '/files/folder', { path: p, name, exist_ok: true }) }
  async upload(folder: string, name: string, content: string | Uint8Array, conflict: 'fail' | 'rename' | 'replace' = 'replace'): Promise<Res> {
    const fd = new FormData()
    fd.append('file', new File([typeof content === 'string' ? new TextEncoder().encode(content) : content], name))
    const body = new Response(fd)
    const type = body.headers.get('content-type')! // read before the body: Bun drops it once the body is consumed
    const bytes = new Uint8Array(await body.arrayBuffer())
    return this.api('POST', `/files/upload?path=${encodeURIComponent(folder)}&conflict=${conflict}`, undefined, { raw: bytes, headers: { 'content-type': type } })
  }
  /** resumable upload (POST /uploads → PUT chunks → complete), as the web app does for big files */
  async uploadResumable(folder: string, name: string, bytes: Uint8Array, opts: { conflict?: string; stopAfter?: number } = {}): Promise<{ id: string; res: Res }> {
    const sha = crypto.createHash('sha256').update(bytes).digest('hex')
    const st = await this.api('POST', '/uploads', { path: folder, name, size: bytes.length, sha256: sha, conflict: opts.conflict ?? 'replace' })
    if (st.status !== 200) return { id: '', res: st }
    const { id, chunk_size: cs } = st.json() as { id: string; chunk_size: number }
    let off = 0, n = 0
    while (off < bytes.length) {
      if (opts.stopAfter !== undefined && n >= opts.stopAfter) return { id, res: st }
      const chunk = bytes.subarray(off, Math.min(off + cs, bytes.length))
      const r = await this.api('PUT', `/uploads/${id}?offset=${off}`, undefined, { raw: chunk, headers: { 'content-type': 'application/octet-stream', 'x-chunk-sha256': crypto.createHash('sha256').update(chunk).digest('hex') } })
      if (r.status !== 200) return { id, res: r }
      off += chunk.length; n++
    }
    return { id, res: await this.api('POST', `/uploads/${id}/complete`, {}) }
  }
  async resumeUpload(id: string, bytes: Uint8Array): Promise<Res> {
    const st = await this.get(`/uploads/${id}`)
    if (st.status !== 200) return st
    let off = st.json().received as number
    const cs = st.json().chunk_size as number
    while (off < bytes.length) {
      const chunk = bytes.subarray(off, Math.min(off + cs, bytes.length))
      const r = await this.api('PUT', `/uploads/${id}?offset=${off}`, undefined, { raw: chunk, headers: { 'content-type': 'application/octet-stream' } })
      if (r.status !== 200) return r
      off += chunk.length
    }
    return this.api('POST', `/uploads/${id}/complete`, {})
  }

  // ---------- tokens, app passwords ----------
  async token(name: string, o: { scope?: string[] | null; read_only?: boolean; ttl?: string; password?: string } = {}): Promise<string> {
    let r = await this.api('POST', '/tokens', { name, ttl: o.ttl ?? '1d', ...(o.scope ? { scope: o.scope } : {}), ...(o.read_only ? { read_only: true } : {}) })
    if (r.status === 403 && /reauth/.test(r.text) && o.password) {
      await this.api('POST', '/me/reauth', { password: o.password })
      r = await this.api('POST', '/tokens', { name, ttl: o.ttl ?? '1d', ...(o.scope ? { scope: o.scope } : {}), ...(o.read_only ? { read_only: true } : {}) })
    }
    if (r.status !== 200) throw new Error(`${this.who}: token ${r.status} ${r.text.slice(0, 200)}`)
    return r.json().token
  }
  async appPassword(name: string, password: string): Promise<string> {
    const r = await this.api('POST', '/me/app-passwords', { name, password })
    if (r.status !== 200) throw new Error(`${this.who}: app password ${r.status} ${r.text.slice(0, 200)}`)
    return r.json().password
  }
}

// ---------- MCP (raw JSON-RPC; the SDK client is lib/mcp.ts) ----------
export async function mcpRaw(http: Http, slug: string, token: string, method: string, params?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  return http.req('POST', `${http.t.teamUrl(slug)}/mcp`, { origin: false, headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', ...headers }, body: { jsonrpc: '2.0', id: rpcId++, method, ...(params ? { params } : {}) } })
}
export async function bash(http: Http, slug: string, token: string, command: string): Promise<{ status: number; stdout: string; stderr: string; exit: number | null; raw: string; isError: boolean }> {
  const r = await mcpRaw(http, slug, token, 'tools/call', { name: 'bash', arguments: { command } })
  let sc: { stdout?: string; stderr?: string; exitCode?: number; exit_code?: number } = {}
  let isError = false
  try { const j = r.json(); sc = j.result?.structuredContent ?? {}; isError = !!j.result?.isError } catch { /* not JSON */ }
  return { status: r.status, stdout: sc.stdout ?? '', stderr: sc.stderr ?? '', exit: sc.exitCode ?? sc.exit_code ?? null, raw: r.text, isError }
}
export async function tool(http: Http, slug: string, token: string, name: string, args: Record<string, unknown>): Promise<{ status: number; text: string; isError: boolean; structured: any; raw: string }> {
  const r = await mcpRaw(http, slug, token, 'tools/call', { name, arguments: args })
  let j: any = {}
  try { j = r.json() } catch { /* not JSON */ }
  const text = (j.result?.content ?? []).map((c: { text?: string }) => c.text ?? '').join('\n')
  return { status: r.status, text, isError: !!j.result?.isError || !!j.error, structured: j.result?.structuredContent, raw: r.text }
}

// ---------- WebDAV ----------
export function davAuth(login: string, secret: string) { return `Basic ${Buffer.from(`${login}:${secret}`).toString('base64')}` }
export async function dav(http: Http, slug: string, auth: string, method: string, vpath: string, o: { body?: BodyInit; headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<Res> {
  const enc = vpath.split('/').map(encodeURIComponent).join('/')
  return http.req(method, `${http.t.teamUrl(slug)}/dav${enc}`, { origin: false, raw: o.body, headers: { authorization: auth, ...o.headers }, timeoutMs: o.timeoutMs })
}
export const propfindBody = '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:allprop/></d:propfind>'
/** the hrefs a PROPFIND multistatus lists (decoded) */
export const davHrefs = (xml: string) => [...xml.matchAll(/<d:href>([^<]+)<\/d:href>/g)].map((m) => decodeURIComponent(m[1]!))
