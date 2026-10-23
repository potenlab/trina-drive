// Trina Cloud mode on top of the web test setup (test/web-helpers.ts): the fixture's console keys and environment
// (test/fixtures/sso-v1.json), a console stand-in that signs assertions with the TEST keys, and a browser that goes
// through GET /api/sso/start → (console) → POST /api/sso/callback like a real one, cookies included.
import crypto from 'node:crypto'
import { parseKeys, setCloudConfig, type CloudConfig } from '../src/tdcloud/config'
import type { Claims } from '../src/tdcloud/assertion'
import { stateHash } from '../src/tdcloud/assertion'
import { handleWeb } from '../src/web/server'
import { metaSet } from '../src/web/schema'
import fx from './fixtures/sso-v1.json'
import { ORIGIN, webSetup } from './web-helpers'

export const ISSUER = fx.issuer
export const TEAM = fx.team
export const CONSOLE_ORIGIN = 'https://cloud.trina.app'
export const USERS = { dion: 'usr_1c0ffee0d15ea5e0b0a7', mina: 'usr_9a41c2e07d5b3f8e6a10', kim: 'usr_00000000000000000a11', lee: 'usr_00000000000000000b22', jae: 'usr_00000000000000000c33' } as const

export function fixtureConfig(clock: { t: number }, extra: Partial<CloudConfig> = {}): CloudConfig {
  return { issuer: fx.env.TDRIVE_CLOUD_ISSUER, team: fx.env.TDRIVE_CLOUD_TEAM, keys: parseKeys(fx.env.TDRIVE_CLOUD_SSO_KEYS), callbackToken: fx.env.TDRIVE_CLOUD_CALLBACK_TOKEN,
    consoleUrl: fx.env.TDRIVE_CLOUD_CONSOLE_URL, ssoOnly: true, now: () => clock.t, ...extra }
}

const privateKey = (kid: 'k1' | 'k2') => crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(fx.test_keys[kid].seed, 'base64url')]), format: 'der', type: 'pkcs8' })

/** What the console would sign (TEST keys). */
export function sign(claims: Record<string, unknown>, kid: 'k1' | 'k2' = 'k1'): string {
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')
  const sig = crypto.sign(null, Buffer.from('tdcloud-sso-v1.' + payload, 'ascii'), privateKey(kid)).toString('base64url')
  return `v1.${payload}.${sig}`
}

export interface Person { sub: string; email: string; name?: string; role?: Claims['role'] }
export function claimsFor(p: Person, o: { nowS: number; state: string; syncSeq: number; authTime?: number; amr?: Claims['amr'] } & Partial<Claims>): Claims {
  const { nowS, state, syncSeq, authTime, amr, ...rest } = o
  return { iss: ISSUER, aud: TEAM, kid: 'k1', sub: p.sub, email: p.email, name: p.name ?? '', role: p.role ?? 'member', iat: nowS, nbf: nowS, exp: nowS + 60,
    auth_time: authTime ?? nowS - 600, jti: crypto.randomBytes(16).toString('base64url'), state_hash: stateHash(state), amr: amr ?? ['pwd'], sync_seq: syncSeq, ...rest }
}

export async function cloudSetup(opts: { hosted?: boolean; ssoOnly?: boolean; publicUrl?: string } = {}) {
  const e = await webSetup({ publicUrl: opts.publicUrl })
  const clock = { t: Date.now() }
  const cfg = fixtureConfig(clock, { ssoOnly: opts.ssoOnly ?? true })
  setCloudConfig(e.db, cfg)
  e.w.opts.hosted = !!opts.hosted
  // app passwords need managed storage (WebDAV)
  metaSet(e.db, 'storage_mode', 'managed')
  /** Tie a demo person to a console account (as a first sync would). */
  const bind = (name: string, sub: string) => e.db.query('UPDATE accounts SET cloud_user = ? WHERE person_id = ?').run(sub, e.pid(name))
  const nowS = () => Math.floor(clock.t / 1000)
  const syncSeq = () => Number(e.db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'cloud_sync_seq'").get()?.value ?? 0)

  /** A browser with cookies by name (session and SSO state), talking to the drive at ORIGIN. */
  class SsoBrowser extends e.Browser {
    jar: Record<string, string> = {}
    /** GET /api/sso/start: the state the drive made (and keeps in this browser's cookie). */
    async start(query = '') {
      const res = await handleWeb(e.w, new Request(`${ORIGIN}/api/sso/start${query}`, { headers: this.cookieHeader() }), '10.0.0.1')
      this.take(res)
      const loc = res.headers.get('location') ?? ''
      return { status: res.status, location: loc, state: new URL(loc, ORIGIN).searchParams.get('state') ?? '' }
    }
    /** The console's form_post to /api/sso/callback. */
    async post(form: Record<string, string>, headers: Record<string, string> = {}) {
      const res = await handleWeb(e.w, new Request(`${ORIGIN}/api/sso/callback`, {
        method: 'POST', body: new URLSearchParams(form).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: CONSOLE_ORIGIN, ...this.cookieHeader(), ...headers },
      }), '10.0.0.1')
      this.take(res)
      return { status: res.status, location: res.headers.get('location') ?? '' }
    }
    /** start → console signs for this person → callback; then reads /api/session for the CSRF token. */
    async sso(p: Person, o: { query?: string; syncSeq?: number; authTime?: number; amr?: Claims['amr']; claims?: Partial<Claims> } = {}) {
      const { state } = await this.start(o.query ?? '')
      const c = claimsFor(p, { nowS: nowS(), state, syncSeq: o.syncSeq ?? syncSeq(), authTime: o.authTime, amr: o.amr, ...(o.claims ?? {}) })
      const r = await this.post({ assertion: sign(c as unknown as Record<string, unknown>), state })
      if (this.jar.tdrive_session) await this.call('GET', '/api/session')
      return { ...r, claims: c }
    }
    cookieHeader(): Record<string, string> {
      const all = { ...this.jar, ...(this.cookie ? { tdrive_session: this.cookie } : {}) }
      const s = Object.entries(all).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('; ')
      return s ? { cookie: s } : {}
    }
    take(res: Response) {
      for (const c of res.headers.getSetCookie()) {
        const m = /^([^=]+)=([^;]*)/.exec(c)
        if (!m) continue
        this.jar[m[1]!] = m[2]!
        if (m[1] === 'tdrive_session') this.cookie = m[2] || undefined
      }
    }
  }
  return { ...e, clock, cfg, bind, nowS, syncSeq, SsoBrowser }
}
export type CloudEnv = Awaited<ReturnType<typeof cloudSetup>>

/** A member-sync payload (version 2) for the fixture team. */
export function payload(seq: number, members: { cloud_user?: string | null; invite?: string | null; email: string; name?: string; role?: 'owner' | 'admin' | 'member'; status?: 'active' | 'invited' }[], events: unknown[] = []) {
  return { version: 2, team: TEAM, seq, at: Date.now(), members: members.map((m) => ({ cloud_user: m.cloud_user ?? null, invite: m.invite ?? null, email: m.email, name: m.name ?? '', role: m.role ?? 'member', status: m.status ?? (m.cloud_user ? 'active' : 'invited') })), events }
}
