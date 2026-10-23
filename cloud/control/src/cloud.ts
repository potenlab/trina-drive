// The control plane's service layer: accounts, teams, the billing state machine, and the jobs that act on instances
// (provision, suspend, resume, limits, backup, delete). HTTP (web.ts) and the admin CLI (cli.ts) both call this.
//
// Team lifecycle
//   pending_payment ──(subscription active/trialing)──▶ provisioning ──▶ active
//   provisioning: waits (no attempts used) while no host has room; the scaler (scaler.ts) launches one
//   active ──(past_due)──▶ past_due ──(grace over, still unpaid)──▶ suspended
//   active/past_due ──(canceled)──▶ (grace) ──▶ suspended ──(deleteAfterDays)──▶ final export ──▶ deleted
//   suspended ──(active again)──▶ active          paused ──▶ suspended ──(resumed)──▶ active
//   provisioning ──(driver failed 5×)──▶ failed (ops alerted; `teams retry <slug>`)
//   Free (free.ts): sign-up without Paddle ──▶ provisioning ──▶ active ──(7 days idle)──▶ suspended (reason inactive)
//     ──(Wake up)──▶ active;  paused 90 days ──▶ final backup ──▶ deleted;  Paddle checkout ──▶ Team/Business, same team
import { audit } from './audit'
import type { BackupTarget } from './backup'
import { teamUrl, type Config, type PlanId } from './config'
import { teamById, teamByPublicId, teamBySlug, teamBySubscription, updateTeam, type DB, type TeamRow } from './db'
import type { Driver, HostPool, TeamSpec } from './drivers/types'
import { hashPassword, verifyPassword, type KeyWrapper } from './keys'
import type { Mailer } from './mailer'
import type { EventSummary } from './paddle'
import { FreeTier } from './free'
import { planOf, type PlanLimits } from './plans'
import { Scaler } from './scaler'
import { generateTeamKey } from './seal'
import { slugProblem } from './slug'
import { teamNet, type TeamNet } from './teamnet'
import { DAY, EMAIL_RE, HOUR, iso, now, publicId, random, sha256 } from './util'
import { Invites } from './invites'
import { SsoKeys } from './sso'
import { MemberSync } from './sync'
import { TeamMembers } from './team-members'
import { ConsoleMfa } from './totp'
import fs from 'node:fs'

export class CloudError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message) }
}

export interface Deps {
  cfg: Config; db: DB; driver: Driver; mailer: Mailer; keys: KeyWrapper; target: BackupTarget; log?: (s: string) => void
  /** the host pool: with one, teams are placed by the scaler (scale-out / scale-in); without, by driver.pickHost */
  pool?: HostPool | null
  clock?: () => number
}

/** No host has room for the team yet: its provision job waits (and is retried) without using up an attempt. */
export class WaitingForHost extends Error {
  constructor(readonly retryInMs: number) { super('waiting for a host with room (the scaler is launching one)') }
}

export const VERIFY_TTL = 2 * DAY
export const SESSION_TTL = 7 * DAY
export const MAX_TEAMS_PER_USER = 5
export const LOGIN_LINK_TTL = 15 * 60_000
export const JOB_MAX_ATTEMPTS = 5

type JobKind = 'provision' | 'suspend' | 'resume' | 'limits' | 'grace_check' | 'delete' | 'backup' | 'wake' | 'sync_members' | 'usage'

/** How a console session was authenticated (the SSO assertion's amr). */
export type SessionAmr = ('pwd' | 'link' | 'totp')[]
export interface ConsoleSession {
  userId: number; csrf: string; idHash: string; email: string; verified: boolean
  publicId: string | null; name: string | null; amr: SessionAmr
  /** when the password or the email link was last used in this session (ms) */
  authTime: number
  /** when an authenticator code was last checked in this session (ms; null = never) */
  totpAt: number | null
}

export class Cloud {
  readonly cfg: Config; readonly db: DB; readonly driver: Driver; readonly mailer: Mailer; readonly keys: KeyWrapper; readonly target: BackupTarget
  readonly log: (s: string) => void
  readonly scaler: Scaler | null
  /** the Free plan: sign-up, waitlist, inactivity pause, wake (free.ts) */
  readonly free: FreeTier
  /** the time the Free plan's lifecycle and the scaler go by (tests move it) */
  readonly clock: () => number
  /** the console (workstream D1): team membership, invites, member sync to the drives, SSO keys, TOTP */
  readonly members: TeamMembers
  readonly invites: Invites
  readonly sync: MemberSync
  readonly sso: SsoKeys
  readonly mfa: ConsoleMfa
  constructor(d: Deps) {
    this.cfg = d.cfg; this.db = d.db; this.driver = d.driver; this.mailer = d.mailer; this.keys = d.keys; this.target = d.target
    this.log = d.log ?? ((s) => console.log(`${new Date().toISOString()} ${s}`))
    this.clock = d.clock ?? Date.now
    this.scaler = d.pool ? new Scaler({ cfg: d.cfg, db: d.db, pool: d.pool, alert: (s, t) => this.alertOps(s, t), log: this.log, clock: d.clock }) : null
    this.free = new FreeTier(this)
    this.members = new TeamMembers(this)
    this.invites = new Invites(this)
    this.sync = new MemberSync(this)
    this.sso = new SsoKeys(this)
    this.mfa = new ConsoleMfa(this)
  }

  // ---------------------------------------------------------------- accounts
  async signup(emailIn: unknown, password: unknown, actor = 'web'): Promise<{ userId: number }> {
    const email = typeof emailIn === 'string' ? emailIn.trim().toLowerCase() : ''
    if (!EMAIL_RE.test(email) || email.length > 254) throw new CloudError('bad_email', 'a valid email address is required')
    const pw = checkPassword(password)
    const existing = this.db.query<{ id: number; verified_at: number | null }, [string]>('SELECT id, verified_at FROM users WHERE email = ?').get(email)
    if (existing) {
      // no account enumeration: same answer; an unverified account gets a fresh link, a verified one a "you already have
      // an account" note
      if (!existing.verified_at) await this.sendVerify(existing.id, email)
      else await this.mailer.send({ to: email, subject: 'Your Trina Cloud account', text: `Someone (maybe you) tried to sign up with this address. You already have an account: sign in at ${this.cfg.controlUrl}/login\n\nIf this wasn't you, you can ignore this mail.` })
      return { userId: existing.id }
    }
    const userId = Number(this.db.query('INSERT INTO users (email, password_hash, created_at, public_id, password_set) VALUES (?, ?, ?, ?, 1)').run(email, await hashPassword(pw), now(), publicId('usr')).lastInsertRowid)
    audit(this.db, { actor, action: 'user.signup', detail: { user: userId } })
    await this.sendVerify(userId, email)
    return { userId }
  }

  private async sendVerify(userId: number, email: string) {
    const secret = random(32)
    this.db.query("UPDATE email_tokens SET used_at = ? WHERE user_id = ? AND kind = 'verify' AND used_at IS NULL").run(now(), userId)
    this.db.query("INSERT INTO email_tokens (user_id, kind, secret_hash, created_at, expires_at) VALUES (?, 'verify', ?, ?, ?)").run(userId, sha256(secret), now(), now() + VERIFY_TTL)
    await this.mailer.send({ to: email, subject: 'Confirm your email for Trina Cloud', text: `Confirm your email address to create your team's Trina Drive:\n\n${this.cfg.controlUrl}/verify?token=${secret}\n\nThe link works once, for 48 hours.` })
  }

  verifyEmail(token: unknown): number {
    if (typeof token !== 'string' || token.length > 100) throw new CloudError('bad_link', 'this link is used, expired or wrong', 404)
    const t = this.db.query<{ id: number; user_id: number }, [string, number]>("SELECT id, user_id FROM email_tokens WHERE kind = 'verify' AND secret_hash = ? AND used_at IS NULL AND expires_at > ?").get(sha256(token), now())
    if (!t || this.db.query('UPDATE email_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL').run(now(), t.id).changes !== 1) throw new CloudError('bad_link', 'this link is used, expired or wrong', 404)
    this.db.query('UPDATE users SET verified_at = coalesce(verified_at, ?) WHERE id = ?').run(now(), t.user_id)
    audit(this.db, { actor: `user:${t.user_id}`, action: 'user.verified' })
    return t.user_id
  }

  async login(emailIn: unknown, password: unknown): Promise<{ cookie: string; csrf: string; userId: number }> {
    const email = typeof emailIn === 'string' ? emailIn.trim().toLowerCase() : ''
    const u = this.db.query<{ id: number; password_hash: string }, [string]>('SELECT id, password_hash FROM users WHERE email = ?').get(email)
    const ok = await verifyPassword(typeof password === 'string' ? password : '', u?.password_hash)
    if (!ok || !u) throw new CloudError('bad_login', 'wrong email or password', 401)
    if (this.mfa.enabled(u.id)) throw new CloudError('totp_required', 'this account uses two-step verification: sign in on the console page', 401)
    return { ...this.startSession(u.id, ['pwd']), userId: u.id }
  }

  /** The account for an email + password, or 401 (same time and answer for an unknown email). */
  async checkPassword(emailIn: unknown, password: unknown): Promise<number> {
    const email = typeof emailIn === 'string' ? emailIn.trim().toLowerCase() : ''
    const u = this.db.query<{ id: number; password_hash: string }, [string]>('SELECT id, password_hash FROM users WHERE email = ?').get(email)
    const ok = await verifyPassword(typeof password === 'string' ? password : '', u?.password_hash)
    if (!ok || !u) throw new CloudError('bad_login', 'wrong email or password', 401)
    return u.id
  }

  /** A new console session (the cookie value is returned once; only its hash is kept). */
  startSession(userId: number, amr: SessionAmr, ip: string | null = null): { cookie: string; csrf: string } {
    const cookie = random(32), csrf = random(24), t = now()
    this.db.query('INSERT INTO sessions (id_hash, user_id, csrf, created_at, expires_at, amr, auth_time, totp_at, last_seen_at, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(sha256(cookie), userId, csrf, t, t + SESSION_TTL, JSON.stringify(amr), t, amr.includes('totp') ? t : null, t, ip)
    return { cookie, csrf }
  }

  /** A one-time sign-in link by mail (15 minutes): how owners of free teams (who never chose a password) reach the
   * dashboard; anyone may use it instead of the password. Unknown or unconfirmed addresses get nothing (same answer). */
  async requestLoginLink(emailIn: unknown, next = '') {
    const email = typeof emailIn === 'string' ? emailIn.trim().toLowerCase() : ''
    if (!EMAIL_RE.test(email) || email.length > 254) throw new CloudError('bad_email', 'a valid email address is required')
    const u = this.db.query<{ id: number; verified_at: number | null }, [string]>('SELECT id, verified_at FROM users WHERE email = ?').get(email)
    if (!u?.verified_at) return
    const secret = random(32)
    this.db.query("UPDATE email_tokens SET used_at = ? WHERE user_id = ? AND kind = 'login' AND used_at IS NULL").run(now(), u.id)
    this.db.query("INSERT INTO email_tokens (user_id, kind, secret_hash, created_at, expires_at) VALUES (?, 'login', ?, ?, ?)").run(u.id, sha256(secret), now(), now() + LOGIN_LINK_TTL)
    audit(this.db, { actor: `user:${u.id}`, action: 'user.login_link_sent' })
    await this.mailer.send({ to: email, subject: 'Your Trina Cloud sign-in link', text: `Sign in to Trina Cloud (your teams, upgrades, waking a paused workspace):

${this.cfg.controlUrl}/login/link?token=${secret}${next ? `&next=${encodeURIComponent(next)}` : ''}

The link works once, for 15 minutes. If you didn't ask for it, ignore this mail.` })
  }

  async loginWithLink(token: unknown): Promise<{ cookie: string; csrf: string; userId: number }> {
    if (typeof token !== 'string' || token.length > 100) throw new CloudError('bad_link', 'this link is used, expired or wrong', 404)
    const t = this.db.query<{ id: number; user_id: number }, [string, number]>("SELECT id, user_id FROM email_tokens WHERE kind = 'login' AND secret_hash = ? AND used_at IS NULL AND expires_at > ?").get(sha256(token), now())
    if (!t || this.db.query('UPDATE email_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL').run(now(), t.id).changes !== 1) throw new CloudError('bad_link', 'this link is used, expired or wrong', 404)
    audit(this.db, { actor: `user:${t.user_id}`, action: 'user.login_link_used' })
    if (this.mfa.enabled(t.user_id)) throw new CloudError('totp_required', 'this account uses two-step verification: sign in on the console page', 401)
    return { ...this.startSession(t.user_id, ['link']), userId: t.user_id }
  }

  /** The email link's account (used up), for the console's two-step sign-in. */
  useLoginLink(token: unknown): number {
    if (typeof token !== 'string' || token.length > 100) throw new CloudError('bad_link', 'this link is used, expired or wrong', 404)
    const t = this.db.query<{ id: number; user_id: number }, [string, number]>("SELECT id, user_id FROM email_tokens WHERE kind = 'login' AND secret_hash = ? AND used_at IS NULL AND expires_at > ?").get(sha256(token), now())
    if (!t || this.db.query('UPDATE email_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL').run(now(), t.id).changes !== 1) throw new CloudError('bad_link', 'this link is used, expired or wrong', 404)
    audit(this.db, { actor: `user:${t.user_id}`, action: 'user.login_link_used' })
    return t.user_id
  }

  /** The owner signed in: their paused free teams wake up (README "Free plan"). */
  wakeOwned(userId: number) {
    for (const t of this.teamsOf(userId)) if (this.free.isPaused(t)) this.free.requestWake(t, `user:${userId}`)
  }

  /** The session of a console cookie value (routes/console-http.ts readSessionCookie). A value tagged `plain:` came in
   * the unprefixed cookie: accepted only when the console is not on https (dev); on https only the __Host- cookie
   * counts, so a same-name cookie another subdomain of the site planted is ignored (review #10). */
  session(cookieIn: string | undefined): ConsoleSession | null {
    let cookie = cookieIn
    if (cookie?.startsWith('plain:')) {
      if (this.cfg.controlUrl.startsWith('https://')) return null
      cookie = cookie.slice(6)
    }
    if (!cookie || cookie.length > 100) return null
    const s = this.db.query<{ id_hash: string; user_id: number; csrf: string; email: string; verified_at: number | null; public_id: string | null; name: string | null; amr: string | null; auth_time: number | null; created_at: number; totp_at: number | null }, [string, number]>(
      'SELECT s.id_hash, s.user_id, s.csrf, u.email, u.verified_at, u.public_id, u.name, s.amr, s.auth_time, s.created_at, s.totp_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?').get(sha256(cookie), now())
    if (!s) return null
    let amr: SessionAmr = ['pwd']
    try { if (s.amr) amr = JSON.parse(s.amr) } catch { /* the default */ }
    return { userId: s.user_id, csrf: s.csrf, idHash: s.id_hash, email: s.email, verified: s.verified_at != null, publicId: s.public_id, name: s.name, amr, authTime: s.auth_time ?? s.created_at, totpAt: s.totp_at }
  }
  logout(idHash: string) { this.db.query('UPDATE sessions SET revoked_at = ? WHERE id_hash = ?').run(now(), idHash) }

  // ---------------------------------------------------------------- teams
  async createTeam(userId: number, nameIn: unknown, slugIn: unknown, planIn: unknown = 'team'): Promise<TeamRow> {
    const u = this.db.query<{ email: string; verified_at: number | null }, [number]>('SELECT email, verified_at FROM users WHERE id = ?').get(userId)
    if (!u) throw new CloudError('no_user', 'sign in first', 401)
    if (!u.verified_at) throw new CloudError('unverified', 'confirm your email address first (check your inbox)', 403)
    const name = typeof nameIn === 'string' ? nameIn.trim().replace(/\s+/g, ' ') : ''
    if (!name || name.length > 80 || /[\p{Cc}]/u.test(name)) throw new CloudError('bad_name', 'a team name of 1–80 characters')
    const slug = typeof slugIn === 'string' ? slugIn.trim().toLowerCase() : ''
    const problem = slugProblem(slug)
    if (problem) throw new CloudError('bad_slug', `address: ${problem}`)
    const plan: PlanId = planIn === 'business' ? 'business' : 'team'
    const count = this.db.query<{ n: number }, [number]>("SELECT count(*) AS n FROM teams WHERE owner_user_id = ? AND status != 'deleted'").get(userId)!.n
    if (count >= MAX_TEAMS_PER_USER) throw new CloudError('too_many', `at most ${MAX_TEAMS_PER_USER} teams per account; write to ${this.cfg.opsEmail}`)
    try {
      const t = this.db.transaction(() => {
        const number = (this.db.query<{ n: number | null }, []>('SELECT max(number) AS n FROM teams').get()?.n ?? 0) + 1
        const id = Number(this.db.query('INSERT INTO teams (public_id, slug, name, owner_user_id, plan, status, number, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(publicId('team'), slug, name, userId, plan, 'pending_payment', number, now(), now()).lastInsertRowid)
        this.members.addOwner(id, userId)
        return teamById(this.db, id)!
      })()
      audit(this.db, { actor: `user:${userId}`, action: 'team.create', teamId: t.id, detail: { slug, plan } })
      return t
    } catch (e) {
      if ((e as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') throw new CloudError('slug_taken', 'that address is taken', 409)
      throw e
    }
  }

  /** Operator-made team without a Paddle subscription (our own dogfood team, a pilot customer): the owner's account is
   * created confirmed if it does not exist (no password: they sign in to the control plane only after a password
   * reset; they never need to for the team itself), the team goes straight to provisioning. Reserved names are allowed
   * with `allowReserved` (the operator's call, e.g. `trina`). Nothing ever bills or suspends it: billing events need a
   * subscription id. */
  async adminCreateTeam(o: { email: string; slug: string; name?: string; plan?: PlanId; allowReserved?: boolean; actor: string }): Promise<TeamRow> {
    const email = o.email.trim().toLowerCase()
    if (!EMAIL_RE.test(email) || email.length > 254) throw new CloudError('bad_email', 'a valid owner email address is required')
    const slug = o.slug.trim().toLowerCase()
    const problem = slugProblem(slug)
    if (problem && !(o.allowReserved && problem === 'that name is reserved')) throw new CloudError('bad_slug', `address: ${problem}${problem === 'that name is reserved' ? ' (add --allow-reserved)' : ''}`)
    let user = this.db.query<{ id: number }, [string]>('SELECT id FROM users WHERE email = ?').get(email)
    if (!user) {
      // an unusable password (random, never shown); the account exists so the team has an owner for its mail
      const id = Number(this.db.query('INSERT INTO users (email, password_hash, verified_at, created_at, public_id, password_set) VALUES (?, ?, ?, ?, ?, 0)').run(email, await hashPassword(random(32)), now(), now(), publicId('usr')).lastInsertRowid)
      audit(this.db, { actor: o.actor, action: 'user.created_by_admin', detail: { user: id } })
      user = { id }
    }
    this.db.query('UPDATE users SET verified_at = coalesce(verified_at, ?) WHERE id = ?').run(now(), user.id)
    const plan: PlanId = o.plan === 'business' ? 'business' : o.plan === 'free' ? 'free' : 'team'
    const name = (o.name ?? slug).trim().replace(/\s+/g, ' ')
    if (!name || name.length > 80 || /[\p{Cc}]/u.test(name)) throw new CloudError('bad_name', 'a team name of 1–80 characters')
    let t: TeamRow
    try {
      t = this.db.transaction(() => {
        const number = (this.db.query<{ n: number | null }, []>('SELECT max(number) AS n FROM teams').get()?.n ?? 0) + 1
        const id = Number(this.db.query('INSERT INTO teams (public_id, slug, name, owner_user_id, plan, status, number, sub_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(publicId('team'), slug, name, user!.id, plan, 'provisioning', number, plan === 'free' ? 'free' : 'complimentary', now(), now()).lastInsertRowid)
        this.members.addOwner(id, user!.id)
        return teamById(this.db, id)!
      })()
    } catch (e) {
      if ((e as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') throw new CloudError('slug_taken', 'that address is taken', 409)
      throw e
    }
    audit(this.db, { actor: o.actor, action: 'team.create', teamId: t.id, detail: { slug, plan, complimentary: true } })
    this.enqueue('provision', t.id)
    return t
  }

  /** Teams this account is an active member of (any role; the console's team list). */
  teamsOf(userId: number): TeamRow[] { return this.members.teamsOf(userId) }
  ownerEmail(t: TeamRow) { return this.db.query<{ email: string }, [number]>('SELECT email FROM users WHERE id = ?').get(t.owner_user_id)!.email }
  url(t: Pick<TeamRow, 'slug'>) { return teamUrl(this.cfg, t.slug) }

  spec(t: TeamRow): TeamSpec {
    const plan = planOf(t.plan), net = teamNet(this.cfg.teamSubnets, t.number)
    return {
      slug: t.slug, number: t.number, uid: this.cfg.uidBase + t.number, url: this.url(t), plan, net, image: this.cfg.image,
      env: teamEnv(this.cfg, t.public_id, plan, net, this.cfg.sso ? { keys: this.sso.published() } : undefined),
    }
  }

  /** The spec for a driver call that writes the team's env (create, recreate, setLimits): the SSO signing key exists,
   * and a new team callback token goes into the env while the console keeps its sha256 (the previous one stays valid
   * until the next write, so a failed write does not lock the drive out; contract "Invite from the drive"). Driver
   * calls that only start, stop or read use spec(). */
  async writeSpec(t: TeamRow): Promise<TeamSpec> {
    if (!this.cfg.sso) return this.spec(t)
    await this.sso.ensure()
    const token = `tdcb_${random(32)}`
    this.db.query('UPDATE teams SET callback_prev_hash = callback_hash, callback_hash = ? WHERE id = ?').run(sha256(token), t.id)
    const s = this.spec(t)
    return { ...s, env: { ...s.env, TDRIVE_CLOUD_CALLBACK_TOKEN: token } }
  }

  /** The team a callback token belongs to (current or previous hash), or null. */
  teamByCallbackToken(token: string): TeamRow | null {
    if (!/^tdcb_[A-Za-z0-9_-]{20,100}$/.test(token)) return null
    const h = sha256(token)
    return this.db.query<TeamRow, [string, string]>("SELECT * FROM teams WHERE (callback_hash = ? OR callback_prev_hash = ?) AND status != 'deleted'").get(h, h)
  }

  /** May Caddy get a certificate for this host name / route to it? (on-demand TLS `ask`) */
  hostAllowed(host: string): boolean {
    const h = host.toLowerCase().replace(/\.$/, '')
    if (h === this.cfg.domain) return true
    const suffix = `.${this.cfg.domain}`
    if (!h.endsWith(suffix)) return false
    const slug = h.slice(0, -suffix.length)
    if (slug.includes('.')) return false
    const t = teamBySlug(this.db, slug)
    return !!t && ['provisioning', 'active', 'past_due', 'suspended'].includes(t.status)
  }

  // ---------------------------------------------------------------- billing
  /** Applies one verified, de-duplicated Paddle event. Returns what happened (stored with the event). */
  applyPaddle(e: EventSummary): string {
    if (!e.type.startsWith('subscription.')) return 'logged'
    let t = (e.teamPublicId ? teamByPublicId(this.db, e.teamPublicId) : null) ?? (e.subscriptionId ? teamBySubscription(this.db, e.subscriptionId) : null)
    if (!t) {
      void this.alertOps(`Paddle ${e.type} for subscription ${e.subscriptionId ?? '?'} matches no team`, `custom_data.tdcloud_team = ${e.teamPublicId ?? '(none)'}; customer ${e.customerId ?? '?'}. Link it with: teams link <slug> ${e.subscriptionId ?? ''}`)
      return 'unlinked'
    }
    const live = ['active', 'trialing'].includes(e.status ?? '')
    if (t.subscription_id && e.subscriptionId && t.subscription_id !== e.subscriptionId) {
      // another subscription for the same team: adopted only when it is paying and the current one is not (a
      // resubscription after a cancel); late events of a replaced subscription are ignored
      if (!live || ['active', 'trialing'].includes(t.sub_status ?? '')) return 'other_subscription'
    } else if (t.sub_occurred_at && Date.parse(e.occurredAt) < Date.parse(t.sub_occurred_at)) {
      return 'stale'
    }
    const plan = e.priceIds.map((p) => this.cfg.paddle.prices[p]).find(Boolean)
    const fromFree = t.plan === 'free' && !!plan && plan !== 'free' && ['active', 'trialing'].includes(e.status ?? '')
    if (t.plan === 'free' && !fromFree) {
      // a free team only ever changes through a paying subscription (no downgrade to Free; README "Free plan")
      void this.alertOps(`Paddle ${e.type} (${e.status}) for free team ${t.slug} not applied`, `A free team becomes paid only with an active subscription for a Team or Business price. Price ids: ${e.priceIds.join(', ') || '(none)'}.`)
      return 'free_not_paying'
    }
    updateTeam(this.db, t.id, {
      subscription_id: e.subscriptionId ?? t.subscription_id, customer_id: e.customerId ?? t.customer_id,
      sub_status: e.status, sub_occurred_at: e.occurredAt, ...(plan ? { plan } : {}),
    })
    t = teamById(this.db, t.id)!
    const actor = `paddle:${e.eventId}`
    audit(this.db, { actor, action: `billing.${e.type}`, teamId: t.id, detail: { status: e.status, subscription: e.subscriptionId, plan: t.plan } })
    if (fromFree) this.upgradedFromFree(t, plan!, actor)
    // a suspended team's container is made again with the new limits and stays stopped (the limits job), so it does not
    // matter whether a resume below runs before or after it
    if (plan && ['active', 'past_due', 'suspended'].includes(t.status)) this.enqueue('limits', t.id)

    switch (e.status) {
      case 'active': case 'trialing':
        if (t.status === 'pending_payment' || t.status === 'failed') {
          updateTeam(this.db, t.id, { status: 'provisioning', error: null })
          this.enqueue('provision', t.id)
          return 'provision'
        }
        if (t.status === 'past_due') { updateTeam(this.db, t.id, { status: 'active', grace_until: null }); return 'paid' }
        if (t.status === 'suspended') { updateTeam(this.db, t.id, { grace_until: null, delete_after: null }); this.enqueue('resume', t.id); return 'resume' }
        if (t.grace_until) updateTeam(this.db, t.id, { grace_until: null })
        return 'ok'
      case 'past_due':
        if (t.status === 'active') {
          const graceUntil = now() + this.cfg.pastDueGraceDays * DAY
          updateTeam(this.db, t.id, { status: 'past_due', grace_until: graceUntil })
          this.enqueue('grace_check', t.id, graceUntil)
          void this.mailOwner(t, 'Payment failed for your Trina Drive', `We could not collect the payment for ${this.url(t)}. Paddle will retry and send you a link to update your card.\n\nIf it is still unpaid on ${iso(graceUntil)}, the workspace is paused (nothing is deleted).`)
          return 'grace'
        }
        return 'ok'
      case 'paused':
        if (['active', 'past_due', 'provisioning'].includes(t.status)) { this.enqueue('suspend', t.id); return 'suspend' }
        return 'ok'
      case 'canceled': {
        if (t.status === 'pending_payment') return 'ok'
        const graceUntil = now() + this.cfg.canceledGraceDays * DAY
        updateTeam(this.db, t.id, { grace_until: graceUntil })
        this.enqueue('grace_check', t.id, graceUntil)
        void this.mailOwner(t, 'Your Trina Drive subscription has ended', `The subscription for ${this.url(t)} has ended. The workspace stays reachable until ${iso(graceUntil)}, then it is paused; ${this.cfg.deleteAfterDays} days later its data is exported and deleted.\n\nTo keep it, subscribe again from ${this.cfg.controlUrl}/dashboard. For a copy of your data, reply to this mail.`)
        return 'cancel_grace'
      }
      default: return 'ok'
    }
  }

  /** Free → Team/Business on the same team: same data, address and host. Its inactivity state is cleared (paid plans
   * never pause); a paused one is resumed (applyPaddle), then made again with the new limits. Teams are not moved
   * between hosts: if the bigger plan no longer fits its host, the host runs over its slots and ops are told. */
  private upgradedFromFree(t: TeamRow, plan: PlanId, actor: string) {
    updateTeam(this.db, t.id, { woke_at: null, paused_at: null, idle_warned_at: null, delete_warnings: 0, error: null,
      ...(this.free.isPaused(t) ? { suspend_reason: 'upgrade' } : {}) })
    audit(this.db, { actor, action: 'free.upgraded', teamId: t.id, detail: { plan, host: t.host } })
    if (t.host && this.scaler) {
      const u = this.scaler.usedSlots().get(t.host)
      if (u && u.used > this.scaler.capacity + 1e-9) {
        void this.alertOps(`host ${t.host} is over its slots after ${t.slug} upgraded`, `${t.slug} went from Free (0.25 slot) to ${plan} on ${t.host}, which now holds ${u.used} of ${this.scaler.capacity} slots (${u.teams.join(', ')}). Teams are never moved automatically; the host runs over its share until a team leaves (a \`teams move\` is not built yet).`)
      }
    }
  }

  // ---------------------------------------------------------------- jobs
  enqueue(kind: JobKind, teamId: number, runAt = now()) {
    // one pending job of a kind per team (a newer schedule replaces an older one)
    const pending = this.db.query<{ id: number }, [string, number]>('SELECT id FROM jobs WHERE kind = ? AND team_id = ? AND done_at IS NULL').get(kind, teamId)
    if (pending) this.db.query('UPDATE jobs SET run_at = ?, attempts = 0, last_error = NULL WHERE id = ?').run(runAt, pending.id)
    else this.db.query('INSERT INTO jobs (kind, team_id, run_at, created_at) VALUES (?, ?, ?, ?)').run(kind, teamId, runAt, now())
  }

  /** Runs every due job once (in order). Returns how many ran. */
  async runDueJobs(limit = 20): Promise<number> {
    const due = this.db.query<{ id: number; kind: JobKind; team_id: number; attempts: number }, [number, number]>('SELECT id, kind, team_id, attempts FROM jobs WHERE done_at IS NULL AND run_at <= ? ORDER BY run_at, id LIMIT ?').all(now(), limit)
    for (const j of due) {
      try {
        await this.runJob(j.kind, j.team_id)
        this.db.query('UPDATE jobs SET done_at = ?, attempts = attempts + 1 WHERE id = ?').run(now(), j.id)
      } catch (e) {
        if (e instanceof WaitingForHost) {
          this.db.query('UPDATE jobs SET last_error = ?, run_at = ? WHERE id = ?').run(e.message, now() + e.retryInMs, j.id)
          continue
        }
        const msg = (e as Error).message + ((e as { detail?: string }).detail ? `\n${(e as { detail?: string }).detail}` : '')
        const attempts = j.attempts + 1
        this.log(`job ${j.kind} team ${j.team_id} failed (attempt ${attempts}): ${msg}`)
        if (j.kind === 'sync_members') {
          // review #5: a membership change (a removal above all) is retried until the drive takes it, with backoff;
          // Members shows it in red meanwhile and ops hear about it once, at the fifth failure
          this.sync.failed(j.team_id, msg)
          this.db.query('UPDATE jobs SET attempts = ?, last_error = ?, run_at = ? WHERE id = ?').run(attempts, msg.slice(0, 4000), now() + Math.min(30 * 60_000, 5_000 * 2 ** Math.min(attempts, 12)), j.id)
          if (attempts === JOB_MAX_ATTEMPTS) await this.alertOps(`member sync for team ${teamById(this.db, j.team_id)?.slug ?? j.team_id} keeps failing`, `${msg}\n\nIt is retried until it succeeds (removals are not applied on the drive until then). See Members in the console, or: members sync <slug>`)
          continue
        }
        if (j.kind === 'usage') { this.db.query('UPDATE jobs SET done_at = ?, attempts = ?, last_error = ? WHERE id = ?').run(now(), attempts, msg.slice(0, 4000), j.id); continue }
        if (attempts >= JOB_MAX_ATTEMPTS) {
          this.db.query('UPDATE jobs SET done_at = ?, attempts = ?, last_error = ? WHERE id = ?').run(now(), attempts, msg.slice(0, 4000), j.id)
          const t = teamById(this.db, j.team_id)
          if (t && j.kind === 'provision') updateTeam(this.db, t.id, { status: 'failed', error: msg.slice(0, 1000) })
          audit(this.db, { actor: 'system', action: `job.${j.kind}.failed`, teamId: j.team_id, detail: { error: msg.slice(0, 500) } })
          await this.alertOps(`job ${j.kind} failed for team ${t?.slug ?? j.team_id}`, msg)
        } else {
          this.db.query('UPDATE jobs SET attempts = ?, last_error = ?, run_at = ? WHERE id = ?').run(attempts, msg.slice(0, 4000), now() + Math.min(30 * 60_000, 15_000 * 2 ** attempts), j.id)
        }
      }
    }
    return due.length
  }

  async runJob(kind: JobKind, teamId: number) {
    const t = teamById(this.db, teamId)
    if (!t || t.status === 'deleted') return
    switch (kind) {
      case 'provision': return this.provision(t)
      case 'suspend': return this.suspend(t, 'billing', 'system')
      case 'resume': return this.resume(t, 'system')
      case 'limits':
        if (t.host && ['active', 'past_due'].includes(t.status)) { await this.driver.setLimits(t.host, await this.writeSpec(t)); await this.sync.gate(t).catch((e) => this.log(`${t.slug}: member sync after the plan change: ${(e as Error).message} (retried by its job)`)) }
        else if (t.host && t.status === 'suspended' && (await this.driver.state(t.host, t.slug)) !== 'missing') {
          // the new plan's container on the same data, left stopped like the team
          await this.driver.recreate(t.host, await this.writeSpec(t))
          if (teamById(this.db, t.id)?.status === 'suspended') await this.driver.stop(t.host, t.slug)
        }
        return
      case 'grace_check': return this.graceCheck(t)
      case 'delete': return this.deleteIfDue(t)
      case 'backup': if (t.host && ['active', 'past_due'].includes(t.status)) await this.backup(t, 'scheduled', 'system'); return
      case 'wake': return this.free.wake(t)
      case 'sync_members': await this.sync.run(t); return
      case 'usage': return this.sync.usage(t)
    }
  }

  private async provision(t: TeamRow) {
    if (t.status !== 'provisioning') return
    // a retry after a half-finished attempt: clear what is left, then start over
    let host = t.host
    if (!host && this.scaler) {
      host = this.scaler.claim(t)
      if (!host) throw await this.waitForHost(t)
      audit(this.db, { actor: 'system', action: 'team.host_assigned', teamId: t.id, detail: { host, waited_s: t.waiting_since ? Math.round((now() - t.waiting_since) / 1000) : 0 } })
    } else if (!host) {
      host = await this.driver.pickHost()
      updateTeam(this.db, t.id, { host })
    }
    if ((await this.driver.state(host, t.slug)) !== 'missing') await this.driver.destroy(host, t.slug)
    const spec = await this.writeSpec(t)
    const r = await this.driver.create(host, spec)
    const filesKey = generateTeamKey()
    const wrapped = await this.keys.wrap(new TextEncoder().encode(JSON.stringify({ product: r.productBackupSecret, files: filesKey.secretKey })), { team: t.public_id, purpose: 'backup-keys' })
    if (r.publicIp && this.dnsHook) await this.dnsHook('UPSERT', t.slug, r.publicIp)
    updateTeam(this.db, t.id, { status: 'active', host, public_ip: r.publicIp, backup_pub: filesKey.publicKey, backup_key_enc: wrapped, error: null,
      // a free team's idle clock starts when it runs
      ...(t.plan === 'free' ? { last_activity_at: this.clock(), activity_checked_at: null } : {}) })
    audit(this.db, { actor: 'system', action: 'team.provisioned', teamId: t.id, detail: { host, driver: this.driver.name, plan: t.plan, keys: this.keys.kind } })
    this.log(`provisioned ${t.slug} on ${host}`)
    this.enqueue('backup', t.id, now() + HOUR)
    // the drive gets its members (the owner first); SSO works before that too (the assertion carries the role)
    if (this.cfg.sso) this.sync.changed(t.id)
    // the team is up either way: a mail failure (SES sandbox, an unverified identity) must not fail the job, whose
    // retry would find the team active and do nothing. The token is gone with the failed mail: `teams resend-setup`.
    try {
      // SSO (review #6): the setup token is never mailed — people come in through the console ("Open drive"); the
      // token made by `tdrive init` dies unused (the drive refuses /api/setup under TDRIVE_SSO_ONLY)
      if (this.cfg.sso) await this.sendReadyMail(t)
      else await this.sendSetupLink(t, r.setupToken)
    } catch (e) {
      audit(this.db, { actor: 'system', action: 'team.setup_link_failed', teamId: t.id, detail: { error: (e as Error).message.slice(0, 300) } })
      await this.alertOps(`setup link for ${t.slug} not sent`, `${(e as Error).message}\n\nWhen mail works: teams resend-setup ${t.slug}`)
    }
  }

  /** No host has room: the team stays in `provisioning` (the owner's "ready" mail comes when it runs), the scaler
   * launches a host, and the job comes back in 5–30 s. Ops hear about a team that has waited hostWaitAlertMs. */
  private async waitForHost(t: TeamRow): Promise<WaitingForHost> {
    const since = t.waiting_since ?? now()
    if (!t.waiting_since) {
      updateTeam(this.db, t.id, { waiting_since: since })
      audit(this.db, { actor: 'system', action: 'team.waiting_for_host', teamId: t.id })
      this.log(`${t.slug}: waiting for a host`)
    } else if (now() - since >= this.cfg.hostWaitAlertMs && !t.wait_alerted_at) {
      updateTeam(this.db, t.id, { wait_alerted_at: now() })
      const hosts = this.scaler!.view().map((h) => `  ${h.id} ${h.state} ${h.used}/${h.capacity}${h.note ? ` (${h.note})` : ''}`).join('\n') || '  (none)'
      await this.alertOps(`team ${t.slug} has waited ${Math.round((now() - since) / 60_000)} min for a host`, `It paid and is still in provisioning: no host has room. It starts as soon as one does.\n\nHosts:\n${hosts}\n\nSee \`hosts list\`.`)
    }
    return new WaitingForHost(Math.min(30_000, Math.max(5_000, Math.round((now() - since) / 4))))
  }

  /** Hook for DNS (AWS driver: one A record per team → the host's Elastic IP). Set by main.ts when Route 53 is configured. */
  dnsHook: ((action: 'UPSERT' | 'DELETE', slug: string, ip: string) => Promise<void>) | null = null

  /** The setup token goes into this mail and nowhere else (the product keeps only its hash). */
  private async sendSetupLink(t: TeamRow, token: string) {
    const url = this.url(t)
    await this.mailer.send({
      to: this.ownerEmail(t),
      subject: `Your Trina Drive is ready: ${url.replace(/^https:\/\//, '')}`,
      text: [
        `${t.name}'s Trina Drive is running at ${url}`,
        '',
        'Create the first admin account (this link works once, for 7 days; the setup token is filled in for you):',
        `${url}/#token=${token}`,
        '',
        `Then connect Claude or ChatGPT: in Claude, Settings → Connectors → Add custom connector → ${url}/mcp`,
        '',
        ...(t.plan === 'free' ? [`Free plan: ${planOf('free').storageGb} GB of files and up to ${planOf('free').maxPeople} people. It pauses after ${Math.round(this.cfg.free.idlePauseMs / DAY)} days without activity (nothing is deleted; one click wakes it). For more, upgrade at ${this.cfg.controlUrl}/dashboard (sign in with an email link).`, ''] : []),
        'We never see this token again: keep the link to yourself. Lost it? Reply to this mail before setup is done.',
      ].join('\n'),
    })
    audit(this.db, { actor: 'system', action: 'team.setup_link_sent', teamId: t.id })
  }

  /** SSO mode's "ready" mail: a link to open the drive through the console, no token. */
  private async sendReadyMail(t: TeamRow) {
    const url = this.url(t)
    await this.mailer.send({
      to: this.ownerEmail(t),
      subject: `Your Trina Drive is ready: ${url.replace(/^https:\/\//, '')}`,
      text: [
        `${t.name}'s Trina Drive is running at ${url}`, '',
        `Open it from Trina Cloud (you sign in there; no separate password for the drive):`,
        `${this.cfg.controlUrl}/open/${t.slug}`, '',
        `Invite your team: ${this.cfg.controlUrl}/t/${t.slug}/members`,
        `Connect Claude or ChatGPT: Settings → Connectors → Add custom connector → ${url}/mcp`, '',
        ...(t.plan === 'free' ? [`Free plan: ${planOf('free').storageGb} GB of files and up to ${planOf('free').maxPeople} people. It pauses after ${Math.round(this.cfg.free.idlePauseMs / DAY)} days without activity (nothing is deleted; one click wakes it).`, ''] : []),
        'As the owner you set up two-step verification (an authenticator app) the first time you open it.',
      ].join('\n'),
    })
    audit(this.db, { actor: 'system', action: 'team.ready_mail_sent', teamId: t.id })
  }

  async resendSetup(t: TeamRow, actor: string) {
    if (!t.host || !['active', 'past_due'].includes(t.status)) throw new CloudError('not_running', 'the team is not running')
    const token = await this.driver.reissueSetupToken(t.host, this.spec(t))
    if (!token) throw new CloudError('setup_done', 'setup is already done (an admin can sign in; use password reset there)')
    audit(this.db, { actor, action: 'team.setup_reissued', teamId: t.id })
    await this.sendSetupLink(t, token)
  }

  async suspend(t: TeamRow, reason: string, actor: string) {
    if (t.status === 'suspended' || t.status === 'deleted') return
    if (t.host) await this.driver.stop(t.host, t.slug)
    updateTeam(this.db, t.id, { status: 'suspended', suspended_at: now(), suspend_reason: reason })
    audit(this.db, { actor, action: 'team.suspend', teamId: t.id, detail: { reason } })
    // free.ts writes its own mail for an inactivity pause
    if (reason !== 'admin' && reason !== 'inactive' && reason !== OWNER_DELETION) void this.mailOwner(t, 'Your Trina Drive is paused', `${this.url(t)} is paused (${reason}). Nothing has been deleted. Update your subscription at ${this.cfg.controlUrl}/dashboard to turn it back on.`)
  }

  async resume(t: TeamRow, actor: string) {
    if (t.status !== 'suspended') return
    if (!t.host) {
      // paused before it ever got a host (it was still waiting for one): provision it now
      updateTeam(this.db, t.id, { status: 'provisioning', suspended_at: null, suspend_reason: null, grace_until: null, delete_after: null, error: null, waiting_since: null, wait_alerted_at: null })
      this.enqueue('provision', t.id)
      audit(this.db, { actor, action: 'team.resume', teamId: t.id, detail: { provision: true } })
      return
    }
    await this.driver.start(t.host, this.spec(t))
    // review #5: the drive applies the current membership (removals made while it was stopped) before the team counts
    // as running; if it cannot, the container stops again and the job retries (the team stays paused)
    try { await this.sync.gate(t) } catch (e) { await this.driver.stop(t.host, t.slug).catch(() => {}); throw e }
    updateTeam(this.db, t.id, { status: 'active', suspended_at: null, suspend_reason: null, grace_until: null, delete_after: null })
    this.db.query("UPDATE jobs SET done_at = ? WHERE team_id = ? AND kind = 'delete' AND done_at IS NULL").run(now(), t.id)
    audit(this.db, { actor, action: 'team.resume', teamId: t.id })
  }

  private async graceCheck(t: TeamRow) {
    if (!t.grace_until || t.grace_until > now()) return
    if (t.sub_status === 'past_due' || t.sub_status === 'canceled') {
      await this.suspend(t, t.sub_status === 'canceled' ? 'subscription ended' : 'unpaid', 'system')
      if (t.sub_status === 'canceled') {
        const at = now() + this.cfg.deleteAfterDays * DAY
        updateTeam(this.db, t.id, { delete_after: at })
        this.enqueue('delete', t.id, at)
        audit(this.db, { actor: 'system', action: 'team.delete_scheduled', teamId: t.id, detail: { at: iso(at) } })
      }
    }
  }

  private async deleteIfDue(t: TeamRow) {
    const fresh = teamById(this.db, t.id)!
    if (fresh.status !== 'suspended' || !(fresh.sub_status === 'canceled' || fresh.suspend_reason === OWNER_DELETION) || !fresh.delete_after || fresh.delete_after > now()) return
    await this.deleteTeam(fresh, 'system')
  }

  /** The owner deletes the team in the console: paused now, a final backup and deletion after deleteAfterDays (the
   * same path as a canceled subscription; operations can `teams resume` it until then). */
  async requestDeletion(t: TeamRow, actor: string) {
    if (['deleting', 'deleted'].includes(t.status)) return
    const at = now() + this.cfg.deleteAfterDays * DAY
    if (t.status === 'suspended' || !t.host) updateTeam(this.db, t.id, { status: 'suspended', suspended_at: t.suspended_at ?? now(), suspend_reason: OWNER_DELETION })
    else await this.suspend(t, OWNER_DELETION, actor)
    updateTeam(this.db, t.id, { delete_after: at, suspend_reason: OWNER_DELETION })
    this.enqueue('delete', t.id, at)
    audit(this.db, { actor, action: 'team.delete_requested', teamId: t.id, detail: { at: iso(at) } })
    void this.mailOwner(t, `${t.name} will be deleted on ${iso(at).slice(0, 10)}`, `${this.url(t)} is paused now and will be deleted on ${iso(at).slice(0, 10)}, after a final backup. To keep it, write to ${this.cfg.opsEmail} before then.`)
  }

  /** Final export (kept in the backup target), then the instance and its data are removed. The slug stays taken. */
  async deleteTeam(t: TeamRow, actor: string) {
    if (t.status === 'deleted') return
    updateTeam(this.db, t.id, { status: 'deleting' })
    if (t.host && (await this.driver.state(t.host, t.slug)) !== 'missing') {
      if (t.backup_pub) {
        if ((await this.driver.state(t.host, t.slug)) !== 'running') await this.driver.start(t.host, this.spec(t))
        await this.backup(teamById(this.db, t.id)!, 'final', actor)
      }
      await this.driver.destroy(t.host, t.slug)
    }
    if (t.public_ip && this.dnsHook) await this.dnsHook('DELETE', t.slug, t.public_ip)
    updateTeam(this.db, t.id, { status: 'deleted', deleted_at: now() })
    audit(this.db, { actor, action: 'team.deleted', teamId: t.id })
  }

  /** Moves a running team to the configured image (cfg.image): a backup first, then a new container on the same data.
   * The product migrates its database on start; there are no down-migrations, so a failed upgrade is rolled back by
   * restoring that backup (README, "Upgrades"). */
  async upgrade(t: TeamRow, actor: string) {
    if (!t.host || !['active', 'past_due', 'suspended'].includes(t.status)) throw new CloudError('not_running', `${t.slug} has no instance`)
    const running = (await this.driver.state(t.host, t.slug)) === 'running'
    if (running) await this.backup(t, 'manual', actor)
    await this.driver.recreate(t.host, await this.writeSpec(t))
    if (!running || t.status === 'suspended') await this.driver.stop(t.host, t.slug)
    else await this.sync.gate(t).catch((e) => this.log(`${t.slug}: member sync after upgrade: ${(e as Error).message} (retried by its job)`))
    audit(this.db, { actor, action: 'team.upgrade', teamId: t.id, detail: { image: this.cfg.image } })
  }

  // ---------------------------------------------------------------- backups
  async backup(t: TeamRow, kind: 'scheduled' | 'export' | 'final' | 'manual', actor: string) {
    if (!t.host || !t.backup_pub) throw new CloudError('no_instance', `${t.slug} has no instance`)
    const stamp = new Date().toISOString().replace(/[-:]|\.\d+/g, '')
    const keyPrefix = `teams/${t.slug}/${stamp}-${kind}/`
    const parts = await this.driver.backup(t.host, this.spec(t), { filesRecipient: t.backup_pub, stamp, keyPrefix: (this.target.prefix ? `${this.target.prefix}/` : '') + keyPrefix })
    for (const p of parts) {
      const key = keyPrefix + p.name
      if (p.localPath) { await this.target.put(key, p.localPath); fs.rmSync(p.localPath, { force: true }) }
      this.db.query('INSERT INTO backups (team_id, at, kind, object_key, bytes, sha256) VALUES (?, ?, ?, ?, ?, ?)').run(t.id, now(), kind, key, p.bytes, p.sha256)
    }
    updateTeam(this.db, t.id, { last_backup_at: now() })
    audit(this.db, { actor, action: `team.backup.${kind}`, teamId: t.id, detail: { objects: parts.map((p) => keyPrefix + p.name), bytes: parts.reduce((a, p) => a + p.bytes, 0) } })
    if (kind === 'scheduled') await this.prune(t)
    if (kind === 'scheduled' || kind === 'manual') this.enqueue('backup', t.id, now() + this.cfg.backupEveryHours * HOUR)
    return parts.map((p) => ({ ...p, key: keyPrefix + p.name }))
  }

  /** Keeps the newest `backupKeep` scheduled backups (exports and final backups are kept). S3 versioning + the
   * bucket's lifecycle rule are the second line (noncurrent versions expire after 30 days). */
  private async prune(t: TeamRow) {
    const rows = this.db.query<{ id: number; object_key: string }, [number]>("SELECT id, object_key FROM backups WHERE team_id = ? AND kind = 'scheduled' ORDER BY at DESC, id DESC").all(t.id)
    const sets = new Map<string, { id: number; object_key: string }[]>()
    for (const r of rows) {
      const prefix = r.object_key.slice(0, r.object_key.lastIndexOf('/') + 1)
      sets.set(prefix, [...(sets.get(prefix) ?? []), r])
    }
    for (const objs of [...sets.values()].slice(t.plan === 'free' ? this.cfg.free.backupKeep : this.cfg.backupKeep)) {
      for (const b of objs) {
        await this.target.delete(b.object_key)
        this.db.query('DELETE FROM backups WHERE id = ?').run(b.id)
      }
    }
  }

  /** The team's two backup secrets (operator use: export, restore). */
  async backupSecrets(t: TeamRow): Promise<{ product: string; files: string }> {
    if (!t.backup_key_enc) throw new CloudError('no_keys', 'no backup keys for this team')
    return JSON.parse(new TextDecoder().decode(await this.keys.unwrap(t.backup_key_enc, { team: t.public_id, purpose: 'backup-keys' })))
  }

  // ---------------------------------------------------------------- metrics and quotas
  async measure(): Promise<{ slug: string; bytes: number | null; quota: number; over: boolean }[]> {
    const out: { slug: string; bytes: number | null; quota: number; over: boolean }[] = []
    for (const t of this.db.query<TeamRow, []>("SELECT * FROM teams WHERE status IN ('active', 'past_due') AND host IS NOT NULL").all()) {
      const bytes = await this.driver.diskUsage(t.host!, t.slug).catch(() => null)
      // the product enforces the plan's storage itself (TDRIVE_STORAGE_QUOTA); /data beyond it plus the database's
      // headroom means something the quota does not count is growing (or the quota is off): tell the owner and ops
      const plan = planOf(t.plan)
      const quota = (plan.storageGb + plan.headroomGb) * 1024 ** 3
      const over = bytes != null && bytes > quota
      updateTeam(this.db, t.id, { disk_bytes: bytes ?? t.disk_bytes, disk_checked_at: now(), over_quota_since: over ? (t.over_quota_since ?? now()) : null })
      if (over && !t.over_quota_since) {
        audit(this.db, { actor: 'system', action: 'team.over_quota', teamId: t.id, detail: { bytes, quota } })
        void this.mailOwner(t, 'Your Trina Drive is over its storage', `${this.url(t)} uses ${(bytes! / 1024 ** 3).toFixed(1)} GB; the plan includes ${plan.storageGb} GB of files. Remove files (and empty the trash) or move to a bigger plan.`)
        void this.alertOps(`team ${t.slug} over quota`, `${bytes} bytes of ${quota}`)
      }
      out.push({ slug: t.slug, bytes, quota, over })
    }
    return out
  }

  /** Schedules the periodic jobs that are due (backups) — called by the loop. */
  scheduleBackups() {
    const due = now() - this.cfg.backupEveryHours * HOUR
    for (const t of this.db.query<{ id: number }, [number]>("SELECT id FROM teams WHERE status IN ('active', 'past_due') AND backup_pub IS NOT NULL AND coalesce(last_backup_at, 0) < ?").all(due)) {
      if (!this.db.query("SELECT 1 FROM jobs WHERE kind = 'backup' AND team_id = ? AND done_at IS NULL").get(t.id)) this.enqueue('backup', t.id)
    }
    // the console's periodic work rides on this tick: daily member-sync reconciliation, hourly usage
    this.sync.schedule()
  }

  // ---------------------------------------------------------------- mail helpers
  async mailOwner(t: TeamRow, subject: string, text: string) {
    try { await this.mailer.send({ to: this.ownerEmail(t), subject, text }) } catch (e) { this.log(`mail to owner of ${t.slug} failed: ${(e as Error).message}`) }
  }
  async alertOps(subject: string, text: string) {
    this.log(`ALERT ${subject}`)
    try { await this.mailer.send({ to: this.cfg.opsEmail, subject: `[Trina Cloud] ${subject}`, text }) } catch (e) { this.log(`ops mail failed: ${(e as Error).message}`) }
  }
}

/** The team container's environment (its 0600 env file / SSM SecureString). Rewritten before every (re)start of the
 * container, so a plan change or a new setting reaches existing teams on their next recreate (upgrade, plan change). */
export const OWNER_DELETION = 'deletion requested by the owner'

export function teamEnv(cfg: Config, publicId: string, plan: PlanLimits, net: TeamNet, sso?: { keys: { kid: string; x: string }[] }): Record<string, string> {
  const env: Record<string, string> = {
    TZ: 'UTC',
    TDRIVE_CLOUD_TEAM: publicId,
    // on the internet: every admin enrols a passkey or an authenticator app before anything else (src/web/hosted.ts)
    TDRIVE_HOSTED: '1',
    // Caddy's fixed address on this team's network is the only peer whose X-Forwarded-For is believed; Caddy sets that
    // header to the client's address itself (caddy/team_routes.caddy), so per-address limits and audit addresses are
    // the client's, not Caddy's
    TDRIVE_TRUSTED_PROXY: `${net.caddyIp}/32`,
    // managed storage with the plan's quota (files, trash, earlier versions, unfinished uploads)
    TDRIVE_STORAGE: 'managed',
    TDRIVE_STORAGE_QUOTA: `${plan.storageGb}GB`,
  }
  // Trina Cloud SSO and member sync (docs/SSO-CONTRACT.md); TDRIVE_CLOUD_CALLBACK_TOKEN is added by Cloud.writeSpec
  if (sso) {
    Object.assign(env, {
      TDRIVE_CLOUD_ISSUER: cfg.controlUrl, TDRIVE_CLOUD_CONSOLE_URL: cfg.controlUrl, TDRIVE_SSO_ONLY: '1',
      TDRIVE_CLOUD_SSO_KEYS: JSON.stringify(sso.keys),
    })
  }
  // Free: at most this many active people (the product refuses one more on the web and the CLI)
  if (plan.maxPeople != null) env.TDRIVE_MAX_PEOPLE = String(plan.maxPeople)
  if (cfg.teamMailer === 'off') env.TDRIVE_MAILER = 'off'
  else if (cfg.teamMailer === 'outbox') Object.assign(env, { TDRIVE_MAILER: 'outbox', TDRIVE_MAIL_FROM: cfg.teamMailFrom })
  else {
    // Amazon SES v2 as the product speaks it, sent to the relay on this team network's gateway (the host). The
    // container cannot reach the instance role (IMDS hop limit 1 and the host firewall keep it away, on purpose: the
    // role reads every team's env parameter); the relay checks the sender (this team's address) and the From, then
    // signs with the role. These AWS_* values are placeholders the product needs to sign at all: not credentials.
    Object.assign(env, {
      TDRIVE_MAILER: 'ses', TDRIVE_MAIL_FROM: cfg.teamMailFrom, TDRIVE_SES_REGION: cfg.aws.region,
      TDRIVE_SES_ENDPOINT: `http://${net.gateway}:${cfg.mailRelayPort}`,
      AWS_ACCESS_KEY_ID: 'tdcloud-mail-relay', AWS_SECRET_ACCESS_KEY: 'not-a-secret-the-host-relay-signs',
    })
  }
  return env
}

export function checkPassword(pw: unknown): string {
  if (typeof pw !== 'string' || [...pw].length < 10) throw new CloudError('weak_password', 'a password of at least 10 characters')
  if (pw.length > 256) throw new CloudError('weak_password', 'that password is too long')
  return pw
}
