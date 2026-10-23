// The Free plan: sign-up without Paddle, abuse limits, a cap with a waitlist, and the inactivity lifecycle.
//
//   sign-up   email + team name (+ address) → a one-time confirmation link (24 h; only its hash is stored) → a team
//             with plan `free` goes to `provisioning` → the usual setup mail (#token=). One free team per mailbox
//             (`emailKey`: no +tags, Gmail dots), per-address rate limits (web.ts), disposable domains refused, optional
//             Cloudflare Turnstile. Past TDCLOUD_MAX_FREE_TEAMS a confirmed sign-up joins the waitlist (ops told;
//             `free admit`).
//   activity  a running free team is asked when people last used it — `tdrive activity --json` over docker exec on
//             its host (web sessions, MCP/OAuth tokens, WebDAV app passwords; nothing on the network)
//   idle      6 days: the owner is warned; 7 days: paused (container stopped, data kept, status `suspended`, reason
//             `inactive`). The paused page has a Wake up button (control plane /wake/<slug>): the container starts in
//             seconds. A wake nobody follows with real use is paused again after TDCLOUD_FREE_WAKE_GRACE, quietly,
//             and the deletion clock keeps running from the first pause.
//   paused    60 and 83 days: warnings; 90 days: a final encrypted backup, then the team is deleted. The final backup
//             (and the team's other backups) are removed TDCLOUD_FREE_FINAL_BACKUP_KEEP (30 days) later.
//   upgrade   Paddle checkout from the dashboard (custom_data = this team): the same team, data and address become Team
//             or Business (cloud.ts applyPaddle). Paid plans never pause for inactivity. No downgrade to Free.
import { audit } from './audit'
import { CloudError, type Cloud } from './cloud'
import { teamById, teamBySlug, updateTeam, type TeamRow } from './db'
import { hashPassword } from './keys'
import { PLANS } from './plans'
import { slugProblem, suggestSlug } from './slug'
import { DAY, EMAIL_RE, iso, publicId, random, sha256 } from './util'

/** Throwaway-mail services (a small built-in list; TDCLOUD_FREE_BLOCKED_DOMAINS adds more). Subdomains match too. */
export const DISPOSABLE_DOMAINS = new Set([
  '10minutemail.com', '10minutemail.net', '1secmail.com', '1secmail.net', '1secmail.org', '20minutemail.com', 'burnermail.io',
  'discard.email', 'dispostable.com', 'dropmail.me', 'emailfake.com', 'emailondeck.com', 'fakeinbox.com', 'getairmail.com',
  'getnada.com', 'grr.la', 'guerrillamail.biz', 'guerrillamail.com', 'guerrillamail.de', 'guerrillamail.info', 'guerrillamail.net',
  'guerrillamail.org', 'guerrillamailblock.com', 'harakirimail.com', 'inboxkitten.com', 'mail.tm', 'mailcatch.com', 'maildrop.cc',
  'mailinator.com', 'mailinator.net', 'mailnesia.com', 'mailpoof.com', 'mintemail.com', 'minuteinbox.com', 'moakt.com', 'mohmal.com',
  'mytemp.email', 'pokemail.net', 'sharklasers.com', 'spam4.me', 'spamgourmet.com', 'temp-mail.io', 'temp-mail.org', 'tempail.com',
  'tempmail.com', 'tempmail.dev', 'tempmailo.com', 'tempr.email', 'throwawaymail.com', 'tmpmail.net', 'tmpmail.org', 'trashmail.com',
  'trashmail.de', 'wegwerfmail.de', 'yopmail.com', 'yopmail.fr', 'yopmail.net',
])

/** One mailbox, one key: lower case, no +tag, googlemail = gmail, no dots in a Gmail local part. */
export function emailKey(email: string): string {
  const e = email.trim().toLowerCase()
  const at = e.lastIndexOf('@')
  let local = e.slice(0, at).split('+')[0]!, domain = e.slice(at + 1)
  if (domain === 'googlemail.com') domain = 'gmail.com'
  if (domain === 'gmail.com') local = local.replace(/\./g, '')
  return `${local}@${domain}`
}

export function isDisposable(email: string, extra: string[] = []): boolean {
  const d = email.slice(email.lastIndexOf('@') + 1).toLowerCase().replace(/\.$/, '')
  const parts = d.split('.')
  for (let i = 0; i < parts.length - 1; i++) {
    const suffix = parts.slice(i).join('.')
    if (DISPOSABLE_DOMAINS.has(suffix) || extra.includes(suffix)) return true
  }
  return false
}

/** Cloudflare Turnstile's server-side check (https://developers.cloudflare.com/turnstile/get-started/server-side-validation/) */
export async function verifyTurnstile(secret: string, token: unknown, ip: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
  if (typeof token !== 'string' || !token || token.length > 2048) return false
  try {
    const r = await fetchFn('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', body: new URLSearchParams({ secret, response: token, remoteip: ip }), signal: AbortSignal.timeout(10_000),
    })
    return ((await r.json()) as { success?: boolean }).success === true
  } catch { return false }
}

export interface SignupRow {
  id: number; email: string; email_key: string; name: string; slug: string | null; ip: string | null; secret_hash: string
  created_at: number; expires_at: number; verified_at: number | null; status: string; team_id: number | null; note: string | null
}

export type WakeState = 'paused' | 'starting' | 'running' | 'unavailable'

export interface SweepResult { checked: number; warned: string[]; paused: string[]; repaused: string[]; active_again: string[]; delete_warned: string[]; deleted: string[]; pruned: number }

const days = (ms: number) => Math.round(ms / DAY)
const spell = (ms: number) => (ms >= DAY && ms % DAY === 0 ? `${ms / DAY} day${ms === DAY ? '' : 's'}` : ms >= 3600_000 ? `${Math.round(ms / 3600_000)} hours` : `${Math.round(ms / 1000)} seconds`)

export class FreeTier {
  /** how the Turnstile check reaches Cloudflare (tests: a fake) */
  fetchFn: typeof fetch = fetch
  constructor(private readonly c: Cloud) {}
  private get cfg() { return this.c.cfg.free }
  private now() { return this.c.clock() }

  /** free teams that exist (any state but deleted): what TDCLOUD_MAX_FREE_TEAMS counts */
  count(): number {
    return this.c.db.query<{ n: number }, []>("SELECT count(*) AS n FROM teams WHERE plan = 'free' AND status != 'deleted'").get()!.n
  }
  full() { return this.count() >= this.cfg.maxTeams }

  isPaused(t: TeamRow) { return t.plan === 'free' && t.status === 'suspended' && t.suspend_reason === 'inactive' }

  /** the live free team of this mailbox, if any */
  private existingFor(email: string): TeamRow | null {
    return this.c.db.query<TeamRow, [string, string]>(`SELECT * FROM teams WHERE plan = 'free' AND status != 'deleted' AND (
      id IN (SELECT team_id FROM free_signups WHERE email_key = ? AND team_id IS NOT NULL) OR owner_user_id IN (SELECT id FROM users WHERE email = ?)) ORDER BY id LIMIT 1`).get(emailKey(email), email.toLowerCase())
  }

  // ---------------------------------------------------------------- sign-up
  /** Step 1: checks, then the confirmation mail. The answer is the same whether or not the address already has a free
   * team (that owner gets a reminder instead of a link): nothing to enumerate. */
  async requestSignup(o: { email: unknown; name: unknown; slug?: unknown; ip: string; turnstile?: unknown }): Promise<void> {
    const email = typeof o.email === 'string' ? o.email.trim().toLowerCase() : ''
    if (!EMAIL_RE.test(email) || email.length > 254) throw new CloudError('bad_email', 'a valid email address is required')
    if (isDisposable(email, this.cfg.blockedDomains)) throw new CloudError('disposable_email', 'use a permanent email address: disposable mail services cannot start a free team')
    const name = typeof o.name === 'string' ? o.name.trim().replace(/\s+/g, ' ') : ''
    if (!name || name.length > 80 || /[\p{Cc}]/u.test(name)) throw new CloudError('bad_name', 'a team name of 1–80 characters')
    const asked = typeof o.slug === 'string' && o.slug.trim() ? o.slug.trim().toLowerCase() : null
    if (asked) {
      const problem = slugProblem(asked)
      if (problem) throw new CloudError('bad_slug', `address: ${problem}`)
      if (teamBySlug(this.c.db, asked) || this.c.db.query("SELECT 1 FROM free_signups WHERE slug = ? AND status = 'pending' AND expires_at > ?").get(asked, this.now())) throw new CloudError('slug_taken', 'that address is taken', 409)
    }
    if (this.cfg.turnstileSecret && !(await verifyTurnstile(this.cfg.turnstileSecret, o.turnstile, o.ip, this.fetchFn))) {
      throw new CloudError('captcha', 'the human check did not pass; reload the page and try again', 400)
    }
    const key = emailKey(email)
    const existing = this.existingFor(email)
    if (existing) {
      audit(this.c.db, { actor: 'web', action: 'free.signup_duplicate', teamId: existing.id, detail: { ip: o.ip } })
      await this.c.mailer.send({ to: email, subject: 'You already have a free Trina Drive', text: `Someone (maybe you) asked for a free Trina Drive with this address. There is one free workspace per person, and yours is at ${this.c.url(existing)}\n\nFor more people or storage, upgrade it from ${this.c.cfg.controlUrl}/dashboard (sign in with an email link).\n\nIf this wasn't you, you can ignore this mail.` })
      return
    }
    const waiting = this.c.db.query<{ id: number }, [string]>("SELECT id FROM free_signups WHERE email_key = ? AND status = 'waitlisted'").get(key)
    if (waiting) {
      await this.c.mailer.send({ to: email, subject: 'You are on the Trina Drive Free waitlist', text: `You are already on the waitlist for a free Trina Drive. We will write as soon as there is room.\n\nCan't wait? The Team plan starts right away: ${this.c.cfg.controlUrl}/signup` })
      return
    }
    const secret = random(32), t = this.now()
    // an older unconfirmed link for the same mailbox stops working
    this.c.db.query("UPDATE free_signups SET status = 'replaced' WHERE email_key = ? AND status = 'pending'").run(key)
    const id = Number(this.c.db.query('INSERT INTO free_signups (email, email_key, name, slug, ip, secret_hash, created_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(email, key, name, asked, o.ip, sha256(secret), t, t + this.cfg.verifyTtlMs, 'pending').lastInsertRowid)
    audit(this.c.db, { actor: 'web', action: 'free.signup', detail: { signup: id, domain: email.slice(email.indexOf('@') + 1) } })
    await this.c.mailer.send({
      to: email, subject: `Confirm your free Trina Drive for ${name}`,
      text: [
        `Confirm your email address to start ${name}'s free Trina Drive:`, '',
        `${this.c.cfg.controlUrl}/free/verify?token=${secret}`, '',
        `The link works once, for ${spell(this.cfg.verifyTtlMs)}. Free: 1 GB, up to 3 people; it pauses after 7 days without activity (one click wakes it).`,
        this.full() ? '\nFree is full right now: once you confirm, you are on the waitlist and we write when there is room.' : '',
        '', "If you didn't ask for this, ignore this mail.",
      ].join('\n'),
    })
  }

  /** Step 2: the link. A team (provisioning), the waitlist, or "you already have one". Each link works once. */
  async verify(token: unknown): Promise<{ status: 'provisioning' | 'waitlisted' | 'exists'; team?: TeamRow; url?: string }> {
    if (typeof token !== 'string' || token.length > 100) throw new CloudError('bad_link', 'this link is used, expired or wrong', 404)
    const t = this.now()
    const s = this.c.db.query<SignupRow, [string, number]>("SELECT * FROM free_signups WHERE secret_hash = ? AND status = 'pending' AND expires_at > ?").get(sha256(token), t)
    if (!s || this.c.db.query('UPDATE free_signups SET verified_at = ? WHERE id = ? AND verified_at IS NULL').run(t, s.id).changes !== 1) throw new CloudError('bad_link', 'this link is used, expired or wrong', 404)
    const existing = this.existingFor(s.email)
    if (existing) {
      this.c.db.query("UPDATE free_signups SET status = 'refused', note = 'one free team per email' WHERE id = ?").run(s.id)
      audit(this.c.db, { actor: 'web', action: 'free.refused', teamId: existing.id, detail: { signup: s.id, reason: 'one per email' } })
      return { status: 'exists', team: existing, url: this.c.url(existing) }
    }
    if (this.full()) {
      this.c.db.query("UPDATE free_signups SET status = 'waitlisted' WHERE id = ?").run(s.id)
      const n = this.waitlist().length
      audit(this.c.db, { actor: 'web', action: 'free.waitlisted', detail: { signup: s.id, waiting: n } })
      await this.c.mailer.send({ to: s.email, subject: 'You are on the Trina Drive Free waitlist', text: `Thanks for confirming. Trina Drive Free is full right now (${this.cfg.maxTeams} free workspaces), so ${s.name} is on the waitlist; we will write as soon as there is room.\n\nCan't wait? The Team plan starts right away: ${this.c.cfg.controlUrl}/signup` })
      await this.c.alertOps(`free waitlist: ${s.email} (${n} waiting)`, `TDCLOUD_MAX_FREE_TEAMS = ${this.cfg.maxTeams} free teams exist, so this confirmed sign-up waits:\n\n  ${s.email}  "${s.name}"${s.slug ? `  (${s.slug})` : ''}\n\nLet someone in: free admit ${s.email}   (or raise TDCLOUD_MAX_FREE_TEAMS)\nThe waitlist: free waitlist`)
      return { status: 'waitlisted' }
    }
    const team = await this.createTeam(s, `free:${s.id}`)
    this.c.db.query("UPDATE free_signups SET status = 'provisioned', team_id = ? WHERE id = ?").run(team.id, s.id)
    return { status: 'provisioning', team, url: this.c.url(team) }
  }

  waitlist(): SignupRow[] {
    return this.c.db.query<SignupRow, []>("SELECT * FROM free_signups WHERE status = 'waitlisted' ORDER BY verified_at, id").all()
  }

  /** `free admit <email|id>`: a waitlisted sign-up gets its team (past the cap only with force). */
  async admit(who: string, actor: string, force = false): Promise<TeamRow> {
    const s = /^\d+$/.test(who)
      ? this.c.db.query<SignupRow, [number]>("SELECT * FROM free_signups WHERE id = ? AND status = 'waitlisted'").get(Number(who))
      : this.c.db.query<SignupRow, [string]>("SELECT * FROM free_signups WHERE email_key = ? AND status = 'waitlisted' ORDER BY id LIMIT 1").get(emailKey(who))
    if (!s) throw new CloudError('not_found', `no waitlisted sign-up ${who} (free waitlist)`, 404)
    if (this.existingFor(s.email)) throw new CloudError('exists', `${s.email} already has a free team`, 409)
    if (this.full() && !force) throw new CloudError('free_full', `${this.count()} free teams exist (TDCLOUD_MAX_FREE_TEAMS = ${this.cfg.maxTeams}); add --force to go past it`, 409)
    const team = await this.createTeam(s, actor)
    this.c.db.query("UPDATE free_signups SET status = 'admitted', team_id = ? WHERE id = ?").run(team.id, s.id)
    audit(this.c.db, { actor, action: 'free.admitted', teamId: team.id, detail: { signup: s.id, force } })
    return team
  }

  /** The owner's account (made confirmed, with an unusable password: they sign in to the control plane with an email
   * link), then the team in `provisioning`. The address asked for, or one made from the name; a taken one gets a
   * short suffix. */
  private async createTeam(s: SignupRow, actor: string): Promise<TeamRow> {
    const db = this.c.db, t = this.now()
    let user = db.query<{ id: number }, [string]>('SELECT id FROM users WHERE email = ?').get(s.email)
    if (!user) {
      user = { id: Number(db.query('INSERT INTO users (email, password_hash, verified_at, created_at) VALUES (?, ?, ?, ?)').run(s.email, await hashPassword(random(32)), t, t).lastInsertRowid) }
      audit(db, { actor, action: 'user.created_free', detail: { user: user.id } })
    }
    db.query('UPDATE users SET verified_at = coalesce(verified_at, ?) WHERE id = ?').run(t, user.id)
    let base = s.slug ?? suggestSlug(s.name)
    if (slugProblem(base)) base = `team-${random(4).toLowerCase().replace(/[^a-z0-9]/g, '')}`.slice(0, 12).replace(/-$/, '')
    for (let i = 0; i < 20; i++) {
      const slug = i === 0 ? base : `${base.slice(0, 27)}-${random(3).toLowerCase().replace(/[^a-z0-9]/g, 'x').slice(0, 4)}`
      if (slugProblem(slug) || teamBySlug(db, slug)) continue
      try {
        const team = db.transaction(() => {
          const number = (db.query<{ n: number | null }, []>('SELECT max(number) AS n FROM teams').get()?.n ?? 0) + 1
          const id = Number(db.query("INSERT INTO teams (public_id, slug, name, owner_user_id, plan, status, number, sub_status, created_at, updated_at) VALUES (?, ?, ?, ?, 'free', 'provisioning', ?, 'free', ?, ?)")
            .run(publicId('team'), slug, s.name, user!.id, number, t, t).lastInsertRowid)
          return teamById(db, id)!
        })()
        audit(db, { actor, action: 'team.create', teamId: team.id, detail: { slug, plan: 'free', signup: s.id } })
        this.c.enqueue('provision', team.id)
        return team
      } catch (e) {
        if ((e as { code?: string }).code !== 'SQLITE_CONSTRAINT_UNIQUE') throw e
      }
    }
    throw new CloudError('slug_taken', 'could not find a free address; try another name', 409)
  }

  // ---------------------------------------------------------------- wake
  wakeState(t: TeamRow | null): WakeState {
    if (!t || t.status === 'deleted') return 'unavailable'
    if (this.isPaused(t)) return this.c.db.query("SELECT 1 FROM jobs WHERE kind = 'wake' AND team_id = ? AND done_at IS NULL").get(t.id) ? 'starting' : 'paused'
    if (t.status === 'active' || t.status === 'past_due') return 'running'
    if (t.status === 'provisioning') return 'starting'
    return 'unavailable'
  }

  /** The Wake up button (paused page, dashboard) or the owner signing in: the container starts in the job loop. */
  requestWake(t: TeamRow, actor: string): WakeState {
    const st = this.wakeState(t)
    if (st !== 'paused') return st
    this.c.enqueue('wake', t.id)
    audit(this.c.db, { actor, action: 'free.wake_requested', teamId: t.id })
    return 'starting'
  }

  /** The wake job: the container again, on the same data. Use must follow within the wake grace, or it pauses again. */
  async wake(t: TeamRow) {
    if (!this.isPaused(t)) return
    const at = this.now()
    await this.c.resume(t, 'system:wake')
    updateTeam(this.c.db, t.id, { woke_at: at, idle_warned_at: null, activity_checked_at: null })
    audit(this.c.db, { actor: 'system', action: 'free.woke', teamId: t.id, detail: { paused_days: t.paused_at ? days(at - t.paused_at) : null } })
    this.c.log(`${t.slug}: woken`)
  }

  // ---------------------------------------------------------------- the sweep
  /** `tdrive activity --json` in the team's container; undefined when it could not be read */
  async readActivity(t: TeamRow): Promise<number | null | undefined> {
    if (!t.host) return undefined
    try {
      const r = await this.c.driver.exec(t.host, t.slug, ['activity', '--json'])
      if (r.code !== 0) { this.c.log(`${t.slug}: tdrive activity failed (exit ${r.code}): ${r.stderr.slice(0, 200)}`); return undefined }
      const v = (JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '') as { last_activity_at?: unknown }).last_activity_at
      return typeof v === 'number' && Number.isFinite(v) ? v : null
    } catch (e) { this.c.log(`${t.slug}: activity not readable: ${(e as Error).message}`); return undefined }
  }

  /** One pass over the free teams (the loop runs it every minute, or every TDCLOUD_FREE_ACTIVITY_EVERY if shorter). */
  async sweep(): Promise<SweepResult> {
    const res: SweepResult = { checked: 0, warned: [], paused: [], repaused: [], active_again: [], delete_warned: [], deleted: [], pruned: 0 }
    const db = this.c.db
    for (const t0 of db.query<TeamRow, []>("SELECT * FROM teams WHERE plan = 'free' AND status = 'active' AND host IS NOT NULL ORDER BY id").all()) {
      try { await this.checkRunning(t0, res) } catch (e) { await this.failed(t0, 'activity check', e) }
    }
    for (const t0 of db.query<TeamRow, []>("SELECT * FROM teams WHERE plan = 'free' AND status = 'suspended' AND suspend_reason = 'inactive' ORDER BY id").all()) {
      try { await this.checkPaused(t0, res) } catch (e) { await this.failed(t0, 'paused-team step', e) }
    }
    res.pruned = await this.pruneBackups()
    return res
  }

  private async failed(t: TeamRow, what: string, e: unknown) {
    const msg = `${what}: ${(e as Error).message}`.slice(0, 500)
    this.c.log(`free ${t.slug}: ${msg}`)
    const cur = teamById(this.c.db, t.id)
    if (cur && cur.error !== msg) {
      updateTeam(this.c.db, t.id, { error: msg })
      await this.c.alertOps(`free team ${t.slug}: ${what} failed`, `${msg}\n\nThe sweep tries again every minute; this mail comes once per new error.`)
    }
  }

  private async checkRunning(t: TeamRow, res: SweepResult) {
    const now = this.now(), f = this.cfg
    const last0 = t.last_activity_at ?? t.created_at
    const near = now - last0 >= f.idleWarnMs || t.woke_at != null
    const since = t.activity_checked_at == null ? Infinity : now - t.activity_checked_at
    // asked every TDCLOUD_FREE_ACTIVITY_EVERY; close to a step (or after a wake), at least every minute
    if (since < f.activityEveryMs && !(near && since >= Math.min(f.activityEveryMs, 60_000))) return
    const a = await this.readActivity(t)
    res.checked++
    updateTeam(this.c.db, t.id, { activity_checked_at: now })
    if (a === undefined) return // no decision on what could not be read
    const last = Math.max(last0, a ?? 0)
    if (last > (t.last_activity_at ?? 0)) updateTeam(this.c.db, t.id, { last_activity_at: last })

    if (t.woke_at != null) {
      if (a != null && a >= t.woke_at) {
        // someone used it after the wake: a normal running team again (the deletion clock stops)
        updateTeam(this.c.db, t.id, { woke_at: null, paused_at: null, delete_warnings: 0, idle_warned_at: null, error: null })
        audit(this.c.db, { actor: 'system', action: 'free.active_again', teamId: t.id })
        res.active_again.push(t.slug)
      } else if (now - t.woke_at >= f.wakeGraceMs) {
        await this.pause(teamById(this.c.db, t.id)!, true)
        res.repaused.push(t.slug)
      }
      return
    }
    const idle = now - last
    if (idle >= f.idlePauseMs) {
      await this.pause(teamById(this.c.db, t.id)!, false)
      res.paused.push(t.slug)
    } else if (idle >= f.idleWarnMs && !(t.idle_warned_at != null && t.idle_warned_at >= last)) {
      updateTeam(this.c.db, t.id, { idle_warned_at: now })
      audit(this.c.db, { actor: 'system', action: 'free.idle_warned', teamId: t.id, detail: { idle_days: days(idle) } })
      const at = last + f.idlePauseMs
      await this.c.mailOwner(t, `Your free Trina Drive pauses ${iso(at).slice(0, 10)}`, [
        `Nobody has used ${this.c.url(t)} for ${spell(f.idleWarnMs)}. Free workspaces pause after ${spell(f.idlePauseMs)} without activity, so this one pauses around ${iso(at)} unless someone signs in, uses it from an AI app, or opens it as a drive.`,
        '', 'Pausing deletes nothing: the files stay, and one click on the paused page wakes it again in seconds.',
        '', `Paid plans never pause: ${this.c.cfg.controlUrl}/dashboard`,
      ].join('\n'))
      res.warned.push(t.slug)
    }
  }

  /** The container stops, the data stays. After a wake nobody used (quiet): no mail, and the first pause's date keeps
   * counting towards deletion. */
  private async pause(t: TeamRow, quiet: boolean) {
    const now = this.now(), f = this.cfg
    const pausedAt = quiet && t.paused_at ? t.paused_at : now
    await this.c.suspend(t, 'inactive', 'system')
    updateTeam(this.c.db, t.id, { paused_at: pausedAt, woke_at: null, idle_warned_at: null, ...(quiet ? {} : { delete_warnings: 0 }) })
    audit(this.c.db, { actor: 'system', action: quiet ? 'free.repaused' : 'free.paused', teamId: t.id, detail: { last_activity: iso(t.last_activity_at), paused_since: iso(pausedAt) } })
    this.c.log(`${t.slug}: paused (${quiet ? 'woken but not used' : 'inactive'})`)
    if (quiet) return
    await this.c.mailOwner(t, 'Your free Trina Drive is paused', [
      `${this.c.url(t)} was paused after ${spell(f.idlePauseMs)} without activity. Nothing has been deleted.`,
      '', `To use it again, open ${this.c.url(t)} and press "Wake up" (it is back in a few seconds), or sign in at ${this.c.cfg.controlUrl}/dashboard.`,
      '', `A free workspace that stays paused for ${spell(f.deleteAfterMs)} is deleted (on ${iso(pausedAt + f.deleteAfterMs).slice(0, 10)}); we write before that. Paid plans never pause.`,
    ].join('\n'))
  }

  private async checkPaused(t: TeamRow, res: SweepResult) {
    const now = this.now(), f = this.cfg
    const since = t.paused_at ?? t.suspended_at ?? now
    if (!t.paused_at) updateTeam(this.c.db, t.id, { paused_at: since })
    const age = now - since
    const deleteOn = since + f.deleteAfterMs
    if (age >= f.deleteAfterMs) {
      await this.c.deleteTeam(t, 'system')
      // the final backup's keep period counts from here (this clock)
      updateTeam(this.c.db, t.id, { deleted_at: now })
      audit(this.c.db, { actor: 'system', action: 'free.deleted_inactive', teamId: t.id, detail: { paused_since: iso(since) } })
      await this.c.mailOwner(t, 'Your free Trina Drive was deleted', [
        `${this.c.url(t)} was paused for ${spell(f.deleteAfterMs)} and has now been deleted.`,
        '', `We keep an encrypted final backup for ${spell(f.finalBackupKeepMs)} (until ${iso(now + f.finalBackupKeepMs).slice(0, 10)}): reply to this mail if you need your files back.`,
        '', `Start again any time at ${this.c.cfg.controlUrl}/free`,
      ].join('\n'))
      res.deleted.push(t.slug)
      return
    }
    // the latest warning whose time has come and that was not sent yet (one mail even if several are due)
    let due = -1
    f.deleteWarnMs.forEach((w, i) => { if (age >= w && t.delete_warnings <= i) due = i })
    if (due < 0) return
    updateTeam(this.c.db, t.id, { delete_warnings: due + 1 })
    audit(this.c.db, { actor: 'system', action: 'free.delete_warned', teamId: t.id, detail: { warning: due + 1, delete_on: iso(deleteOn) } })
    await this.c.mailOwner(t, `Your paused Trina Drive is deleted on ${iso(deleteOn).slice(0, 10)}`, [
      `${this.c.url(t)} has been paused for ${days(age)} days. On ${iso(deleteOn).slice(0, 10)} (${days(deleteOn - now)} days from now) it is deleted, after a final backup we keep for ${spell(f.finalBackupKeepMs)}.`,
      '', `To keep it, open ${this.c.url(t)} and press "Wake up", then use it — or upgrade it at ${this.c.cfg.controlUrl}/dashboard (paid plans never pause).`,
    ].join('\n'))
    res.delete_warned.push(t.slug)
  }

  /** Backups of free teams deleted more than TDCLOUD_FREE_FINAL_BACKUP_KEEP ago (the final one included) are removed. */
  private async pruneBackups(): Promise<number> {
    const before = this.now() - this.cfg.finalBackupKeepMs
    const rows = this.c.db.query<{ id: number; team_id: number; object_key: string }, [number]>(
      "SELECT b.id, b.team_id, b.object_key FROM backups b JOIN teams t ON t.id = b.team_id WHERE t.plan = 'free' AND t.status = 'deleted' AND t.deleted_at < ?").all(before)
    const teams = new Set<number>()
    for (const b of rows) {
      await this.c.target.delete(b.object_key)
      this.c.db.query('DELETE FROM backups WHERE id = ?').run(b.id)
      teams.add(b.team_id)
    }
    for (const id of teams) audit(this.c.db, { actor: 'system', action: 'free.backups_removed', teamId: id, detail: { objects: rows.filter((r) => r.team_id === id).length } })
    return rows.length
  }

  // ---------------------------------------------------------------- numbers
  stats() {
    const db = this.c.db
    const by = (w: string) => db.query<{ n: number }, []>(`SELECT count(*) AS n FROM teams WHERE plan = 'free' AND ${w}`).get()!.n
    const pausedRows = db.query<TeamRow, []>("SELECT * FROM teams WHERE plan = 'free' AND status = 'suspended' AND suspend_reason = 'inactive' ORDER BY paused_at").all()
    const active = by("status = 'active'"), paused = pausedRows.length
    const hosts = this.c.scaler?.view().filter((h) => h.freeUsed > 0).map((h) => ({ host: h.id, free_slots: h.freeUsed, used: h.used, capacity: h.capacity })) ?? []
    const signups = (st: string) => db.query<{ n: number }, [string]>('SELECT count(*) AS n FROM free_signups WHERE status = ?').get(st)!.n
    // rough monthly cost (cloud/README.md "Cost"): a slot ≈ $9 (an m7g.xlarge host with its volume and address, ~$180,
    // for 20 slots); a free team takes a quarter, plus ~$0.45 of disk and backups; a paused one only that
    const slotCost = 180 / Math.max(1, this.c.cfg.maxTeamsPerHost)
    return {
      cap: this.cfg.maxTeams, total: this.count(), active, paused,
      provisioning: by("status = 'provisioning'"), other: by("status IN ('failed', 'deleting', 'past_due')"),
      deleted: by("status = 'deleted'"), upgraded: db.query<{ n: number }, []>("SELECT count(*) AS n FROM audit WHERE action = 'free.upgraded'").get()!.n,
      waitlist: signups('waitlisted'), unconfirmed: db.query<{ n: number }, [number]>("SELECT count(*) AS n FROM free_signups WHERE status = 'pending' AND expires_at > ?").get(this.now())!.n,
      next_deletions: pausedRows.slice(0, 5).map((t) => ({ slug: t.slug, on: iso((t.paused_at ?? t.suspended_at ?? 0) + this.cfg.deleteAfterMs) })),
      hosts,
      est_monthly_usd: Math.round((active * (PLANS.free.slots * slotCost + 0.45) + paused * 0.5) * 100) / 100,
    }
  }
}
