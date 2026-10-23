// The control plane's service layer: accounts, teams, the billing state machine, and the jobs that act on instances
// (provision, suspend, resume, limits, backup, delete). HTTP (web.ts) and the admin CLI (cli.ts) both call this.
//
// Team lifecycle
//   pending_payment ──(subscription active/trialing)──▶ provisioning ──▶ active
//   active ──(past_due)──▶ past_due ──(grace over, still unpaid)──▶ suspended
//   active/past_due ──(canceled)──▶ (grace) ──▶ suspended ──(deleteAfterDays)──▶ final export ──▶ deleted
//   suspended ──(active again)──▶ active          paused ──▶ suspended ──(resumed)──▶ active
//   provisioning ──(driver failed 5×)──▶ failed (ops alerted; `teams retry <slug>`)
import { audit } from './audit'
import type { BackupTarget } from './backup'
import { teamUrl, type Config, type PlanId } from './config'
import { teamById, teamByPublicId, teamBySlug, teamBySubscription, updateTeam, type DB, type TeamRow } from './db'
import type { Driver, TeamSpec } from './drivers/types'
import { hashPassword, verifyPassword, type KeyWrapper } from './keys'
import type { Mailer } from './mailer'
import type { EventSummary } from './paddle'
import { planOf } from './plans'
import { generateTeamKey } from './seal'
import { slugProblem } from './slug'
import { DAY, EMAIL_RE, HOUR, iso, now, publicId, random, sha256 } from './util'
import fs from 'node:fs'

export class CloudError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message) }
}

export interface Deps { cfg: Config; db: DB; driver: Driver; mailer: Mailer; keys: KeyWrapper; target: BackupTarget; log?: (s: string) => void }

export const VERIFY_TTL = 2 * DAY
export const SESSION_TTL = 7 * DAY
export const MAX_TEAMS_PER_USER = 5
export const JOB_MAX_ATTEMPTS = 5

type JobKind = 'provision' | 'suspend' | 'resume' | 'limits' | 'grace_check' | 'delete' | 'backup'

export class Cloud {
  readonly cfg: Config; readonly db: DB; readonly driver: Driver; readonly mailer: Mailer; readonly keys: KeyWrapper; readonly target: BackupTarget
  readonly log: (s: string) => void
  constructor(d: Deps) {
    this.cfg = d.cfg; this.db = d.db; this.driver = d.driver; this.mailer = d.mailer; this.keys = d.keys; this.target = d.target
    this.log = d.log ?? ((s) => console.log(`${new Date().toISOString()} ${s}`))
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
    const userId = Number(this.db.query('INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)').run(email, await hashPassword(pw), now()).lastInsertRowid)
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
    const cookie = random(32), csrf = random(24)
    this.db.query('INSERT INTO sessions (id_hash, user_id, csrf, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(sha256(cookie), u.id, csrf, now(), now() + SESSION_TTL)
    return { cookie, csrf, userId: u.id }
  }

  session(cookie: string | undefined): { userId: number; csrf: string; idHash: string; email: string; verified: boolean } | null {
    if (!cookie || cookie.length > 100) return null
    const s = this.db.query<{ id_hash: string; user_id: number; csrf: string; email: string; verified_at: number | null }, [string, number]>(
      'SELECT s.id_hash, s.user_id, s.csrf, u.email, u.verified_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?').get(sha256(cookie), now())
    return s ? { userId: s.user_id, csrf: s.csrf, idHash: s.id_hash, email: s.email, verified: s.verified_at != null } : null
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
        return teamById(this.db, id)!
      })()
      audit(this.db, { actor: `user:${userId}`, action: 'team.create', teamId: t.id, detail: { slug, plan } })
      return t
    } catch (e) {
      if ((e as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') throw new CloudError('slug_taken', 'that address is taken', 409)
      throw e
    }
  }

  teamsOf(userId: number) { return this.db.query<TeamRow, [number]>("SELECT * FROM teams WHERE owner_user_id = ? AND status != 'deleted' ORDER BY id").all(userId) }
  ownerEmail(t: TeamRow) { return this.db.query<{ email: string }, [number]>('SELECT email FROM users WHERE id = ?').get(t.owner_user_id)!.email }
  url(t: Pick<TeamRow, 'slug'>) { return teamUrl(this.cfg, t.slug) }

  spec(t: TeamRow): TeamSpec {
    return {
      slug: t.slug, number: t.number, uid: this.cfg.uidBase + t.number, url: this.url(t), plan: planOf(t.plan), image: this.cfg.image,
      env: { TZ: 'UTC', TDRIVE_CLOUD_TEAM: t.public_id },
    }
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
    updateTeam(this.db, t.id, {
      subscription_id: e.subscriptionId ?? t.subscription_id, customer_id: e.customerId ?? t.customer_id,
      sub_status: e.status, sub_occurred_at: e.occurredAt, ...(plan ? { plan } : {}),
    })
    t = teamById(this.db, t.id)!
    const actor = `paddle:${e.eventId}`
    audit(this.db, { actor, action: `billing.${e.type}`, teamId: t.id, detail: { status: e.status, subscription: e.subscriptionId, plan: t.plan } })
    if (plan && ['active', 'past_due'].includes(t.status)) this.enqueue('limits', t.id)

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
        const msg = (e as Error).message + ((e as { detail?: string }).detail ? `\n${(e as { detail?: string }).detail}` : '')
        const attempts = j.attempts + 1
        this.log(`job ${j.kind} team ${j.team_id} failed (attempt ${attempts}): ${msg}`)
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
      case 'limits': if (t.host && ['active', 'past_due'].includes(t.status)) await this.driver.setLimits(t.host, this.spec(t)); return
      case 'grace_check': return this.graceCheck(t)
      case 'delete': return this.deleteIfDue(t)
      case 'backup': if (t.host && ['active', 'past_due'].includes(t.status)) await this.backup(t, 'scheduled', 'system'); return
    }
  }

  private async provision(t: TeamRow) {
    if (t.status !== 'provisioning') return
    // a retry after a half-finished attempt: clear what is left, then start over
    const host = t.host ?? await this.driver.pickHost()
    if (!t.host) updateTeam(this.db, t.id, { host })
    if ((await this.driver.state(host, t.slug)) !== 'missing') await this.driver.destroy(host, t.slug)
    const spec = this.spec(t)
    const r = await this.driver.create(host, spec)
    const filesKey = generateTeamKey()
    const wrapped = await this.keys.wrap(new TextEncoder().encode(JSON.stringify({ product: r.productBackupSecret, files: filesKey.secretKey })), { team: t.public_id, purpose: 'backup-keys' })
    if (r.publicIp && this.dnsHook) await this.dnsHook('UPSERT', t.slug, r.publicIp)
    updateTeam(this.db, t.id, { status: 'active', host, public_ip: r.publicIp, backup_pub: filesKey.publicKey, backup_key_enc: wrapped, error: null })
    audit(this.db, { actor: 'system', action: 'team.provisioned', teamId: t.id, detail: { host, driver: this.driver.name, plan: t.plan, keys: this.keys.kind } })
    this.log(`provisioned ${t.slug} on ${host}`)
    await this.sendSetupLink(t, r.setupToken)
    this.enqueue('backup', t.id, now() + HOUR)
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
        'Create the first admin account (this link works once, for 7 days):',
        `${url}/#/setup/${token}`,
        '',
        `If the page asks for a setup token, paste this: ${token}`,
        '',
        `Then connect Claude or ChatGPT: in Claude, Settings → Connectors → Add custom connector → ${url}/mcp`,
        '',
        'We never see this token again: keep the link to yourself. Lost it? Reply to this mail before setup is done.',
      ].join('\n'),
    })
    audit(this.db, { actor: 'system', action: 'team.setup_link_sent', teamId: t.id })
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
    if (reason !== 'admin') void this.mailOwner(t, 'Your Trina Drive is paused', `${this.url(t)} is paused (${reason}). Nothing has been deleted. Update your subscription at ${this.cfg.controlUrl}/dashboard to turn it back on.`)
  }

  async resume(t: TeamRow, actor: string) {
    if (t.status !== 'suspended' || !t.host) return
    await this.driver.start(t.host, this.spec(t))
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
    if (fresh.status !== 'suspended' || fresh.sub_status !== 'canceled' || !fresh.delete_after || fresh.delete_after > now()) return
    await this.deleteTeam(fresh, 'system')
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
    for (const objs of [...sets.values()].slice(this.cfg.backupKeep)) {
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
      const quota = planOf(t.plan).diskGb * 1024 ** 3
      const over = bytes != null && bytes > quota
      updateTeam(this.db, t.id, { disk_bytes: bytes ?? t.disk_bytes, disk_checked_at: now(), over_quota_since: over ? (t.over_quota_since ?? now()) : null })
      if (over && !t.over_quota_since) {
        audit(this.db, { actor: 'system', action: 'team.over_quota', teamId: t.id, detail: { bytes, quota } })
        void this.mailOwner(t, 'Your Trina Drive is over its storage', `${this.url(t)} uses ${(bytes! / 1024 ** 3).toFixed(1)} GB of ${planOf(t.plan).diskGb} GB. Remove files or move to the Business plan.`)
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

export function checkPassword(pw: unknown): string {
  if (typeof pw !== 'string' || [...pw].length < 10) throw new CloudError('weak_password', 'a password of at least 10 characters')
  if (pw.length > 256) throw new CloudError('weak_password', 'that password is too long')
  return pw
}
