// A fake Google (OAuth token endpoint, revoke, Drive API v3: files.get, alt=media, export, list) for the Google Drive
// import tests: no network. It checks what the real one would (PKCE, client secret, bearer tokens) so the server's side
// of the conversation is exercised, and it can be told to misbehave (429, an expired grant, a too-large export).
import crypto from 'node:crypto'
import type { GoogleConfig } from '../src/gdrive/config'
import { managedSetup } from './managed-helpers'

export const GCFG: GoogleConfig = { clientId: '123456789012-abc.apps.googleusercontent.com', clientSecret: 'shh-client-secret', apiKey: 'AIza-test-key', appId: '123456789012', readonly: false }

export interface FakeFile { id: string; name: string; mimeType: string; modifiedTime: string; version: string; bytes?: Uint8Array; exports?: Record<string, Uint8Array>; parents?: string[]; size?: string; trashed?: boolean }

export class FakeGoogle {
  files = new Map<string, FakeFile>()
  challenges = new Map<string, string>() // code → PKCE challenge
  access = new Set<string>()
  refresh = new Set<string>()
  revoked: string[] = []
  calls: string[] = []
  scope = 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/drive.file'
  failNext: { match: RegExp; status: number; reason: string; times: number } | null = null
  bigExports = new Set<string>()
  refreshFails = false
  expiresIn = 3600

  add(f: Omit<FakeFile, 'version' | 'modifiedTime'> & Partial<Pick<FakeFile, 'version' | 'modifiedTime'>>) {
    this.files.set(f.id, { version: '1', modifiedTime: '2026-10-01T00:00:00.000Z', ...f })
  }
  /** Google sends the person back with a code for this challenge. */
  code(challenge: string) { const c = 'code-' + crypto.randomBytes(6).toString('hex'); this.challenges.set(c, challenge); return c }

  private tokens(scope: string, withRefresh: boolean) {
    const a = 'ya29.' + crypto.randomBytes(8).toString('hex'), r = '1//' + crypto.randomBytes(8).toString('hex')
    this.access.add(a)
    if (withRefresh) this.refresh.add(r)
    const idToken = ['x', Buffer.from(JSON.stringify({ email: 'kim@gmail.example' })).toString('base64url'), 'sig'].join('.')
    return Response.json({ access_token: a, expires_in: this.expiresIn, scope, token_type: 'Bearer', id_token: idToken, ...(withRefresh ? { refresh_token: r } : {}) })
  }
  private err(status: number, reason: string) { return Response.json({ error: { code: status, message: `fake: ${reason}`, errors: [{ reason }] } }, { status }) }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = init?.method ?? 'GET'
    this.calls.push(`${method} ${url.pathname}${url.search}`)
    if (this.failNext && this.failNext.match.test(url.pathname + url.search) && this.failNext.times > 0) {
      this.failNext.times--
      return this.err(this.failNext.status, this.failNext.reason)
    }
    if (url.href === 'https://oauth2.googleapis.com/token') {
      const f = new URLSearchParams(String(init?.body))
      if (f.get('client_id') !== GCFG.clientId || f.get('client_secret') !== GCFG.clientSecret) return Response.json({ error: 'invalid_client' }, { status: 401 })
      if (f.get('grant_type') === 'authorization_code') {
        const ch = this.challenges.get(f.get('code') ?? '')
        this.challenges.delete(f.get('code') ?? '')
        const v = crypto.createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url')
        if (!ch || ch !== v) return Response.json({ error: 'invalid_grant', error_description: 'bad code or verifier' }, { status: 400 })
        return this.tokens(this.scope, true)
      }
      if (f.get('grant_type') === 'refresh_token') {
        if (this.refreshFails || !this.refresh.has(f.get('refresh_token') ?? '')) return Response.json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, { status: 400 })
        return this.tokens(this.scope, false)
      }
      return Response.json({ error: 'unsupported_grant_type' }, { status: 400 })
    }
    if (url.href === 'https://oauth2.googleapis.com/revoke') { const t = new URLSearchParams(String(init?.body)).get('token') ?? ''; this.revoked.push(t); this.refresh.delete(t); return new Response('') }
    const auth = new Headers(init?.headers).get('authorization') ?? ''
    if (!this.access.has(auth.replace(/^Bearer /, ''))) return this.err(401, 'authError')
    let m: RegExpExecArray | null
    if (url.pathname === '/drive/v3/files') {
      const parent = /'([^']+)' in parents/.exec(url.searchParams.get('q') ?? '')?.[1]
      const kids = [...this.files.values()].filter((f) => f.parents?.includes(parent ?? '') && !f.trashed)
      return Response.json({ files: kids.map((f) => this.meta(f)) })
    }
    if ((m = /^\/drive\/v3\/files\/([^/]+)\/export$/.exec(url.pathname))) {
      const f = this.files.get(decodeURIComponent(m[1]!))
      if (!f) return this.err(404, 'notFound')
      if (this.bigExports.has(f.id)) return this.err(403, 'exportSizeLimitExceeded')
      const b = f.exports?.[url.searchParams.get('mimeType') ?? '']
      return b ? new Response(b) : this.err(400, 'badRequest')
    }
    if ((m = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname))) {
      const f = this.files.get(decodeURIComponent(m[1]!))
      if (!f) return this.err(404, 'notFound')
      if (url.searchParams.get('alt') === 'media') return f.bytes ? new Response(f.bytes) : this.err(403, 'fileNotDownloadable')
      return Response.json(this.meta(f))
    }
    if (url.hostname === 'docs.google.com' && (m = /^\/export\/([^/]+)$/.exec(url.pathname))) {
      const f = this.files.get(m[1]!)
      const b = f?.exports?.[url.searchParams.get('mimeType') ?? '']
      return b ? new Response(b) : this.err(404, 'notFound')
    }
    return this.err(404, 'notFound')
  }
  meta(f: FakeFile) {
    const exportLinks = f.exports ? Object.fromEntries(Object.keys(f.exports).map((mt) => [mt, `https://docs.google.com/export/${f.id}?mimeType=${encodeURIComponent(mt)}`])) : undefined
    return { id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime, version: f.version, trashed: !!f.trashed, size: f.bytes ? String(f.bytes.length) : f.size, exportLinks }
  }
}

export async function gdriveSetup(cfg: Partial<GoogleConfig> = {}) {
  const e = await managedSetup()
  const g = new FakeGoogle()
  Object.assign(e.w.opts, { google: { ...GCFG, ...cfg }, googleFetch: g.fetch, googleRetryMs: 1 })
  type B = InstanceType<typeof e.Browser>
  /** The whole round trip: connect, consent at (fake) Google, back to the callback with the browser's cookie. */
  async function connect(b: B, opts: { cookie?: string | null; returnPath?: string } = {}) {
    const r = await b.call('POST', '/api/gdrive/connect', { return_path: opts.returnPath ?? '/files?path=%2F%ED%8C%80' })
    if (r.status !== 200) throw new Error(`connect: ${r.status} ${JSON.stringify(r.data)}`)
    const u = new URL(r.data.url)
    const cookie = /tdrive_gdrive=([^;]+)/.exec(r.headers.get('set-cookie') ?? '')?.[1]
    const code = g.code(u.searchParams.get('code_challenge')!)
    const back = await callback(u.searchParams.get('state')!, code, opts.cookie === undefined ? cookie : opts.cookie)
    return { url: u, cookie, back, state: u.searchParams.get('state')! }
  }
  async function callback(state: string, code: string | null, cookie: string | null | undefined, extra = '') {
    const h: Record<string, string> = {}
    if (cookie) h.cookie = `tdrive_gdrive=${cookie}`
    const { handleWeb } = await import('../src/web/server')
    const res = await handleWeb(e.w, new Request(`http://drive.test/api/gdrive/callback?state=${encodeURIComponent(state)}${code ? `&code=${code}` : ''}${extra}`, { headers: h }), '10.0.0.1')
    return { status: res.status, location: res.headers.get('location') ?? '', setCookie: res.headers.get('set-cookie') ?? '' }
  }
  /** Start an import and wait for it to finish; the job as the progress view sees it. */
  async function importAndWait(b: B, folder: string, ids: string[]) {
    const r = await b.call('POST', '/api/gdrive/import', { path: folder, items: ids.map((id) => ({ id })) })
    if (r.status !== 200) return r
    const { jobDone } = await import('../src/gdrive/importer')
    await jobDone(e.db, r.data.id)
    await e.idle()
    return b.call('GET', `/api/gdrive/jobs/${r.data.id}`)
  }
  return { ...e, g, connect, callback, importAndWait }
}
export type GEnv = Awaited<ReturnType<typeof gdriveSetup>>
