// HTTP through the public front (Caddy), never around it. A Jar is one browser's cookies (host-only, like a browser:
// a cookie set by acme.… is sent only to acme.…), so SSO flows that hop between the console and a team keep two jars'
// worth of state the way a real browser does.
import type { Target } from './target'

export interface Res { status: number; headers: Headers; text: string; url: string; json: () => any; location: string }

export interface ReqOpts {
  body?: unknown
  raw?: BodyInit
  form?: Record<string, string>
  headers?: Record<string, string>
  /** send Origin = the URL's origin on changing methods (default true); a string sends that Origin */
  origin?: boolean | string
  jar?: Jar
  csrf?: string
  timeoutMs?: number
}

const CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE', 'PROPPATCH', 'MKCOL', 'MOVE', 'COPY', 'LOCK', 'UNLOCK'])

export class Jar {
  /** host → name → value */
  private c = new Map<string, Map<string, string>>()
  /** raw Set-Cookie lines seen, for attribute checks (Secure, HttpOnly, __Host-) */
  seen: string[] = []
  header(host: string): string {
    const m = this.c.get(host)
    return m ? [...m].map(([k, v]) => `${k}=${v}`).join('; ') : ''
  }
  get(host: string, name: string) { return this.c.get(host)?.get(name) }
  set(host: string, name: string, value: string) {
    let m = this.c.get(host)
    if (!m) this.c.set(host, (m = new Map()))
    if (value === '') m.delete(name)
    else m.set(name, value)
  }
  take(host: string, h: Headers) {
    for (const line of h.getSetCookie?.() ?? []) {
      this.seen.push(line)
      const [nv, ...attrs] = line.split(';')
      const i = nv!.indexOf('=')
      const name = nv!.slice(0, i).trim(), value = nv!.slice(i + 1).trim()
      const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || attrs.some((a) => /^\s*expires=Thu, 01 Jan 1970/i.test(a))
      this.set(host, name, expired ? '' : value)
    }
  }
  clear(host?: string) { if (host) this.c.delete(host); else this.c.clear() }
}

export class Http {
  constructor(public t: Target) {}

  async req(method: string, url: string, o: ReqOpts = {}): Promise<Res> {
    const u = new URL(url)
    const headers: Record<string, string> = {}
    let body: BodyInit | undefined
    if (o.form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(o.form).toString() }
    else if (o.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(o.body) }
    else if (o.raw !== undefined) body = o.raw
    Object.assign(headers, o.headers)
    const ck = o.jar?.header(u.host)
    if (ck) headers.cookie = ck
    if (o.csrf) headers['x-csrf-token'] = o.csrf
    if (o.origin !== false && CHANGING.has(method)) headers.origin = typeof o.origin === 'string' ? o.origin : u.origin
    const r = await fetch(url, { method, headers, body, redirect: 'manual', tls: this.t.tls, signal: AbortSignal.timeout(o.timeoutMs ?? 60_000) } as RequestInit)
    o.jar?.take(u.host, r.headers)
    const text = method === 'HEAD' ? '' : await r.text()
    const loc = r.headers.get('location') ?? ''
    return { status: r.status, headers: r.headers, text, url, location: loc ? new URL(loc, url).toString() : '', json: () => JSON.parse(text) }
  }

  /** follow 30x (GET after 303/302/301, like a browser), keeping cookies in the jar; stops at a non-redirect or `stopAt` */
  async follow(url: string, o: ReqOpts & { method?: string; max?: number; stopAt?: (u: URL) => boolean } = {}): Promise<{ last: Res; hops: string[] }> {
    const hops: string[] = []
    let method = o.method ?? 'GET'
    let r = await this.req(method, url, o)
    hops.push(url)
    for (let i = 0; i < (o.max ?? 10) && r.status >= 300 && r.status < 400 && r.location; i++) {
      const next = r.location
      if (o.stopAt?.(new URL(next))) { hops.push(next); break }
      if (r.status !== 307 && r.status !== 308) method = 'GET'
      r = await this.req(method, next, { jar: o.jar, headers: o.headers })
      hops.push(next)
    }
    return { last: r, hops }
  }

  /** TLS handshake succeeds for this name */
  async tlsOk(url: string): Promise<boolean> {
    try { await fetch(url, { tls: this.t.tls, signal: AbortSignal.timeout(10_000) } as RequestInit); return true } catch { return false }
  }
}

/** the auto-POST form a console answers /sso/authorize with (form_post): action + hidden inputs */
export function parseFormPost(html: string): { action: string; fields: Record<string, string> } | null {
  const forms = [...html.matchAll(/<form[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/gi)]
  if (!forms.length) return null
  const form = forms.find((f) => /name="assertion"/.test(f[2]!)) ?? forms.find((f) => /name="password"/.test(f[2]!)) ?? forms[0]!
  const fields: Record<string, string> = {}
  for (const m of form[2]!.matchAll(/<input[^>]*>/gi)) {
    const name = /name="([^"]+)"/.exec(m[0])?.[1], value = /value="([^"]*)"/.exec(m[0])?.[1]
    if (name) fields[name] = decodeEntities(value ?? '')
  }
  return { action: decodeEntities(form[1]!), fields }
}
const decodeEntities = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x2F;/gi, '/').replace(/&amp;/g, '&')
