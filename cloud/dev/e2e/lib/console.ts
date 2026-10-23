// The Trina Cloud console as a person uses it: sign-up and confirmation (today's API), sign-in with the authenticator
// app owners/admins must have (D1), the members API (plan §2.3) and "Open drive" → SSO into a team (docs/SSO-CONTRACT.md).
//
// ADAPTER: D1 (feat/d1-console) is being written in parallel. The members API follows plan §2.3 exactly; the TOTP
// endpoints are not in the plan, so the candidates below are tried in order (first that is not 404 wins). When D1
// merges, fix the list here — no scenario needs to change.
import { Http, Jar, parseFormPost, type Res } from './http'
import { Drive } from './drive'
import { freshTotp } from './totp'
import type { Target } from './target'

const TOTP_SETUP = ['/api/me/totp/setup', '/api/account/totp/setup', '/api/totp/setup']
const TOTP_CONFIRM = ['/api/me/totp/confirm', '/api/account/totp/confirm', '/api/totp/confirm']
const LOGIN_SECOND = ['/api/login/second', '/api/login/totp']

export interface ConsoleCreds { email: string; password: string; totp?: string }

export class Console {
  csrf = ''
  constructor(public http: Http, public jar: Jar = new Jar()) {}
  get t(): Target { return this.http.t }
  get base() { return this.t.control }

  api(method: string, p: string, body?: unknown, o: { origin?: boolean | string } = {}): Promise<Res> {
    return this.http.req(method, `${this.base}${p}`, { jar: this.jar, csrf: this.csrf || undefined, body: body === undefined ? undefined : { ...(body as object), ...(this.csrf && method !== 'GET' ? { csrf: this.csrf } : {}) }, ...o })
  }

  /** sign up and confirm the address from the outbox (local only) */
  async signupConfirmed(email: string, password: string): Promise<{ signup: Res; verify: Res | null }> {
    const signup = await this.api('POST', '/api/signup', { email, password })
    const mail = this.t.outbox?.().filter((m) => m.to === email.toLowerCase() && /verify\?token=/.test(m.text)).at(-1)
    const token = mail?.text.match(/verify\?token=(\S+)/)?.[1]
    const verify = token ? await this.api('POST', '/api/verify', { token }) : null
    return { signup, verify }
  }

  /** password, then the authenticator code when the console asks for one (D1) */
  async login(c: ConsoleCreds): Promise<Res> {
    let r = await this.api('POST', '/api/login', { email: c.email, password: c.password })
    const sf = r.status === 200 ? r.json().second_factor : undefined
    if (sf) {
      if (!c.totp) return r
      const code = await freshTotp(c.totp)
      for (const p of LOGIN_SECOND) {
        r = await this.api('POST', p, { ticket: sf.ticket ?? sf, code, method: 'totp' })
        if (r.status !== 404) break
      }
    }
    if (r.status === 200) this.csrf = r.json().csrf ?? this.csrf
    return r
  }

  /** enrol an authenticator app; returns the base32 secret (D1) */
  async enrollTotp(): Promise<{ secret: string; res: Res }> {
    let r!: Res
    let i = 0
    for (; i < TOTP_SETUP.length; i++) { r = await this.api('POST', TOTP_SETUP[i]!, {}); if (r.status !== 404) break }
    if (r.status !== 200) return { secret: '', res: r }
    const secret = String(r.json().secret ?? '')
    const conf = await this.api('POST', TOTP_CONFIRM[Math.min(i, TOTP_CONFIRM.length - 1)]!, { code: await freshTotp(secret) })
    return { secret: conf.status === 200 ? secret : '', res: conf }
  }

  me() { return this.api('GET', '/api/me') }
  async teamId(slug: string): Promise<string> {
    const r = await this.api('GET', '/api/teams')
    return (r.json().teams as { id: string; slug: string }[]).find((x) => x.slug === slug)?.id ?? ''
  }
  members(teamId: string) { return this.api('GET', `/api/teams/${teamId}/members`) }
  invite(teamId: string, emails: string[], role: 'member' | 'admin' = 'member') { return this.api('POST', `/api/teams/${teamId}/invites`, { emails, role }) }
  setRole(teamId: string, userId: string, role: 'member' | 'admin') { return this.api('PATCH', `/api/teams/${teamId}/members/${userId}`, { role }) }
  remove(teamId: string, userId: string) { return this.api('DELETE', `/api/teams/${teamId}/members/${userId}`) }
  accept(token: string) { return this.api('POST', '/api/invites/accept', { token }) }
  /** the invite token from the newest console invite mail to `email` (local) */
  inviteToken(email: string): string {
    const m = this.t.outbox?.().filter((x) => x.to === email.toLowerCase() && /\/invite\/[A-Za-z0-9_-]+/.test(x.text)).at(-1)
    return m?.text.match(/\/invite\/([A-Za-z0-9_-]+)/)?.[1] ?? ''
  }

  /**
   * Open drive: console /open/<slug> → drive /api/sso/start → console /sso/authorize → form_post → drive
   * /api/sso/callback → the drive's return path. The browser's jar carries both sites' cookies. Returns the drive
   * (signed in, or not with `error` = the drive's #/sso-error/<code>), the assertion that was posted, and every hop.
   */
  async openDrive(slug: string, o: { returnPath?: string; reauth?: boolean } = {}): Promise<SsoResult> {
    const start = o.returnPath !== undefined || o.reauth
      ? `${this.t.teamUrl(slug)}/api/sso/start?return=${encodeURIComponent(o.returnPath ?? '/')}${o.reauth ? '&reauth=1' : ''}`
      : `${this.base}/open/${slug}`
    return ssoFrom(this.http, this.jar, slug, start)
  }
}

export interface SsoResult { drive: Drive | null; error: string; assertion: string; state: string; hops: string[]; landing: string; secondFactor: string; authorize: Res | null }

/** run an SSO round trip from `startUrl` in this browser jar (no console session → stops at the console's /login) */
export async function ssoFrom(http: Http, jar: Jar, slug: string, startUrl: string): Promise<SsoResult> {
  const team = new URL(http.t.teamUrl(slug))
  const out: SsoResult = { drive: null, error: '', assertion: '', state: '', hops: [], landing: '', secondFactor: '', authorize: null }
  const { last, hops } = await http.follow(startUrl, { jar })
  out.hops = hops
  out.authorize = last
  const post = last.status === 200 ? parseFormPost(last.text) : null
  if (!post) { out.error = last.status === 404 ? 'not_found' : `no_form_post (${last.status} ${last.location || last.url})`; return out }
  out.assertion = post.fields.assertion ?? ''
  out.state = post.fields.state ?? ''
  const cb = await postCallback(http, jar, new URL(post.action, last.url).toString(), post.fields)
  out.landing = cb.location
  const frag = new URL(cb.location || team.toString()).hash
  const err = /#\/sso-error\/([a-z_]+)/.exec(frag)
  const second = /#\/sso-second\/([^/?#]+)/.exec(frag)
  if (err) { out.error = err[1]!; return out }
  if (cb.status !== 303 && cb.status !== 302) { out.error = `callback_${cb.status}`; return out }
  if (second) { out.secondFactor = second[1]!; return out }
  const d = new Drive(http, slug, 'sso', jar)
  try { await d.session(); out.drive = d } catch (e) { out.error = (e as Error).message }
  return out
}

/** what the console's auto-submitting page does: a form POST from the console's origin */
export function postCallback(http: Http, jar: Jar, action: string, fields: Record<string, string>): Promise<Res> {
  return http.req('POST', action, { jar, form: fields, origin: http.t.control })
}
