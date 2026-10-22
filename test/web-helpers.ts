// The demo company plus the web side: accounts for the demo people, and a tiny browser (cookie jar + CSRF header)
// that calls the server's fetch handler directly.
import { grantManage } from '../src/store'
import { hashPassword } from '../src/web/auth'
import { OutboxMailer } from '../src/web/mail'
import { handleWeb, makeWebCtx } from '../src/web/server'
import { setup } from './helpers'

export const ORIGIN = 'http://shelf.test'
export const PASSWORD = 'correct horse battery'
let sharedHash: string | null = null

export async function webSetup(opts: { webDir?: string } = {}) {
  const e = setup()
  const mailer = new OutboxMailer(e.dir, true)
  const w = makeWebCtx(e.ctx, { mailer, webDir: opts.webDir ?? '/nonexistent' })
  sharedHash ??= await hashPassword(PASSWORD)
  const pid = (name: string) => e.db.query<{ id: number }, [string]>('SELECT id FROM people WHERE name = ?').get(name)!.id
  for (const n of ['dion', 'kim', 'boss', 'lee', 'park'])
    e.db.query('INSERT INTO accounts (person_id, email, password_hash, created_at, password_set_at) VALUES (?, ?, ?, ?, ?)').run(pid(n), `${n}@example.com`, sharedHash, Date.now(), Date.now())
  grantManage(e.db, `${e.root}/경영`, 'boss')
  const fid = (name: string) => e.folderId(name)

  /** A browser: keeps the session cookie, sends the CSRF token and a same-origin Origin on changes. */
  class Browser {
    cookie?: string
    csrf?: string
    lastSetCookie: string | null = null
    async raw(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
      const h: Record<string, string> = { ...headers }
      if (this.cookie) h.cookie = `shelf_session=${this.cookie}`
      if (body !== undefined) h['content-type'] = 'application/json'
      if (method !== 'GET' && !('origin' in h)) h.origin = ORIGIN
      if (method !== 'GET' && this.csrf && !('x-csrf-token' in h)) h['x-csrf-token'] = this.csrf
      for (const [k, v] of Object.entries(h)) if (v === '') delete h[k]
      const res = await handleWeb(w, new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), '10.0.0.1')
      this.lastSetCookie = res.headers.get('set-cookie')
      const m = /shelf_session=([^;]*)/.exec(this.lastSetCookie ?? '')
      if (m) this.cookie = m[1] || undefined
      return res
    }
    async call(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
      const res = await this.raw(method, path, body, headers)
      const text = await res.text()
      let data: any = null
      try { data = JSON.parse(text) } catch { data = text }
      if (data && typeof data === 'object' && typeof data.csrf === 'string') this.csrf = data.csrf
      return { status: res.status, data, headers: res.headers }
    }
    async login(name: string, password = PASSWORD) {
      const r = await this.call('POST', '/api/login', { login: name, password })
      if (r.status !== 200) throw new Error(`login ${name}: ${r.status} ${JSON.stringify(r.data)}`)
      return this
    }
  }
  const as = (name: string) => new Browser().login(name)
  return { ...e, w, mailer, pid, fid, Browser, as }
}
export type WebEnv = Awaited<ReturnType<typeof webSetup>>
