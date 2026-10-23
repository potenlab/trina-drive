// Test helpers for the console (workstream D1): a browser with a cookie jar that reads the CSRF token from pages, a
// reference team drive that answers `cloud sync-members` / `cloud usage` the way docs/SSO-CONTRACT.md says (seq
// ordering, events, deactivation), and accounts with or without TOTP.
import { setup, type Env } from './helpers'
import { totpAt } from '../src/totp'
import type { SyncPayload } from '../src/sync'
import type { TeamRow } from '../src/db'
import { teamBySlug } from '../src/db'

export const ORIGIN = 'https://cloud.example.com'
export const PW = 'correct horse battery'

/** One team drive as the contract describes its side of member sync. */
export class RefDrive {
  applied = 0
  people = new Map<string, { email: string; name: string; admin: boolean; active: boolean; invite: string | null; cloud_user: string | null; tokens: number }>()
  payloads: SyncPayload[] = []
  eventsSeen = new Set<string>()
  fail: string | null = null
  usage: Record<string, number> | null = null
  constructor(readonly team: string) {}
  key(m: { cloud_user: string | null; invite: string | null }) { return m.cloud_user ?? `invite:${m.invite}` }
  apply(p: SyncPayload): { code: number; out: unknown } {
    if (this.fail) return { code: 1, out: { ok: false, error: this.fail } }
    if (p.version !== 2) return { code: 1, out: { ok: false, error: 'bad_version' } }
    if (p.team !== this.team) return { code: 1, out: { ok: false, error: 'wrong_team' } }
    if (p.seq <= this.applied) return { code: 0, out: { ok: true, applied: false, seq: p.seq, current_seq: this.applied, reason: 'stale' } }
    this.payloads.push(p)
    let created = 0, deactivated = 0
    const listed = new Set<string>()
    for (const m of p.members) {
      // the first payload after acceptance carries both ids: the invited row becomes the member's row
      if (m.cloud_user && m.invite && this.people.has(`invite:${m.invite}`)) { this.people.set(m.cloud_user, this.people.get(`invite:${m.invite}`)!); this.people.delete(`invite:${m.invite}`) }
      const k = this.key(m)
      listed.add(k)
      const cur = this.people.get(k)
      if (!cur) created++
      this.people.set(k, { email: m.email, name: m.name, admin: m.role !== 'member', active: true, invite: m.invite, cloud_user: m.cloud_user, tokens: cur?.active ? cur.tokens : 0 })
    }
    for (const [k, v] of this.people) if (!listed.has(k) && v.active) { v.active = false; v.tokens = 0; deactivated++ }
    for (const e of p.events) {
      if (this.eventsSeen.has(e.id)) continue
      this.eventsSeen.add(e.id)
      if (e.type === 'member.removed') { const v = this.people.get(String(e.cloud_user)); if (v?.active) { v.active = false; v.tokens = 0; deactivated++ } }
    }
    this.applied = p.seq
    return { code: 0, out: { ok: true, applied: true, seq: p.seq, created, updated: 0, deactivated, reactivated: 0, people: [...this.people.values()].filter((v) => v.active).length, unmanaged: [] } }
  }
  member(email: string) { return [...this.people.values()].find((v) => v.email === email) }
}

/** setup() with SSO on and the fake driver's exec answering as reference drives (one per team, made on first use). */
export function setupConsole(extra: Record<string, string> = {}, o: { pool?: boolean; clock?: () => number } = {}) {
  const env = setup({ TDCLOUD_SSO: '1', ...extra }, o)
  const drives = new Map<string, RefDrive>()
  const drive = (slug: string) => {
    let d = drives.get(slug)
    if (!d) { d = new RefDrive(teamBySlug(env.cloud.db, slug)!.public_id); drives.set(slug, d) }
    return d
  }
  const orig = env.driver.exec.bind(env.driver)
  env.driver.exec = async (h, slug, args) => {
    if (args[0] === 'cloud' && args[1] === 'sync-members') {
      env.driver.calls.push(`exec ${slug} cloud sync-members`)
      if (env.driver.instances.get(slug)?.state !== 'running') return { code: 1, stdout: '', stderr: 'not running' }
      const p = JSON.parse(Buffer.from(args[3]!, 'base64url').toString('utf8')) as SyncPayload
      const r = drive(slug).apply(p)
      return { code: r.code, stdout: JSON.stringify(r.out) + '\n', stderr: '' }
    }
    if (args[0] === 'cloud' && args[1] === 'usage') {
      const u = drive(slug).usage
      return u ? { code: 0, stdout: JSON.stringify(u) + '\n', stderr: '' } : { code: 1, stdout: '', stderr: 'unknown command' }
    }
    return orig(h, slug, args)
  }
  return Object.assign(env, { drive, drives })
}
export type ConsoleEnv = ReturnType<typeof setupConsole>

/** A browser: cookie jar, Origin header on changes, the CSRF token read from the last page or JSON answer. */
export class Browser {
  cookies = new Map<string, string>()
  csrf = ''
  constructor(readonly env: Env) {}
  private header() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') }
  private take(r: Response) {
    for (const c of r.headers.getSetCookie?.() ?? [r.headers.get('set-cookie')].filter(Boolean) as string[]) {
      const [kv] = c.split(';'); const i = kv!.indexOf('=')
      const k = kv!.slice(0, i), v = kv!.slice(i + 1)
      if (/Max-Age=0/.test(c) || !v) this.cookies.delete(k); else this.cookies.set(k, v)
    }
  }
  async get(path: string, headers: Record<string, string> = {}) {
    const r = await this.env.handle(new Request(`${ORIGIN}${path}`, { headers: { cookie: this.header(), ...headers } }), '203.0.113.9')
    this.take(r)
    const text = await r.text()
    const m = /name="csrf" value="([^"]+)"/.exec(text)
    if (m) this.csrf = m[1]!
    return { status: r.status, headers: r.headers, text, location: r.headers.get('location') }
  }
  /** a form post from a console page (CSRF added unless given) */
  async post(path: string, form: Record<string, string> = {}, o: { origin?: string | null; csrf?: boolean } = {}) {
    const body = new URLSearchParams({ ...(o.csrf === false ? {} : { csrf: this.csrf }), ...form })
    const r = await this.env.handle(new Request(`${ORIGIN}${path}`, { method: 'POST', body, headers: { cookie: this.header(), 'content-type': 'application/x-www-form-urlencoded', ...(o.origin === null ? {} : { origin: o.origin ?? ORIGIN }) } }), '203.0.113.9')
    this.take(r)
    const text = await r.text()
    const m = /name="csrf" value="([^"]+)"/.exec(text)
    if (m) this.csrf = m[1]!
    return { status: r.status, headers: r.headers, text, location: r.headers.get('location') }
  }
  /** a JSON API call (X-CSRF-Token) */
  async api(method: string, path: string, body?: unknown, o: { origin?: string | null } = {}) {
    const r = await this.env.handle(new Request(`${ORIGIN}${path}`, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { cookie: this.header(), 'x-csrf-token': this.csrf, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(o.origin === null ? {} : { origin: o.origin ?? ORIGIN }) },
    }), '203.0.113.9')
    this.take(r)
    const text = await r.text()
    let json: Record<string, unknown> = {}
    try { json = JSON.parse(text) } catch { /* html */ }
    if (typeof json.csrf === 'string') this.csrf = json.csrf
    return { status: r.status, headers: r.headers, json: json as Record<string, any>, text }
  }
}

/** signup → confirm → sign in (password); optionally turn TOTP on. */
export async function account(env: Env, email: string, o: { totp?: boolean; name?: string } = {}) {
  const b = new Browser(env)
  await env.call('POST', '/api/signup', { body: { email, password: PW } })
  const token = env.mailer.sent.filter((m) => m.to === email).at(-1)!.text.match(/verify\?token=(\S+)/)![1]!
  await env.call('POST', '/api/verify', { body: { token } })
  const l = await b.api('POST', '/api/login', { email, password: PW })
  if (l.status !== 200) throw new Error(`login ${l.status} ${l.text}`)
  if (o.name) await b.post('/account/name', { name: o.name })
  let secret = ''
  if (o.totp) secret = await enrollTotp(b)
  const userId = env.cloud.db.query<{ id: number }, [string]>('SELECT id FROM users WHERE email = ?').get(email)!.id
  return { b, email, secret, userId, code: () => freshCode(env, userId, secret) }
}

/** a code for now that the account will accept (each step works once: the test forgets the last step used) */
export function freshCode(env: Env, userId: number, secret: string) {
  env.cloud.db.query('UPDATE users SET totp_last_step = NULL WHERE id = ?').run(userId)
  return totpAt(secret, Date.now())
}

export async function enrollTotp(b: Browser): Promise<string> {
  const s = await b.api('POST', '/api/me/totp/setup', {})
  if (s.status !== 200) throw new Error(`totp setup ${s.status} ${s.text}`)
  const secret = s.json.secret as string
  const e = await b.api('POST', '/api/me/totp/enable', { code: totpAt(secret, Date.now() - 30_000) })
  if (e.status !== 200) throw new Error(`totp enable ${e.status} ${e.text}`)
  return secret
}

/** a complimentary team for this owner, provisioned (the fake driver) and its first member sync applied */
export async function opsTeam(env: ConsoleEnv, owner: string, slug: string, plan: 'team' | 'business' | 'free' = 'team'): Promise<TeamRow> {
  await env.cloud.adminCreateTeam({ email: owner, slug, name: slug[0]!.toUpperCase() + slug.slice(1), plan, actor: 'admin:test', allowReserved: true })
  await runJobs(env)
  return teamBySlug(env.cloud.db, slug)!
}

export async function runJobs(env: Env) {
  for (let i = 0; i < 5; i++) {
    env.cloud.db.query('UPDATE jobs SET run_at = 0 WHERE done_at IS NULL').run()
    if (!(await env.cloud.runDueJobs(100))) break
  }
}
