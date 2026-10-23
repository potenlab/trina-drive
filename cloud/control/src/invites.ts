// Invites to a team (plan 2.3, review finding 7). An invite is bound to the address it was sent to: only an account
// whose confirmed email is that address can accept it (a forwarded admin invite is useless to anyone else). The secret
// is in the mail only (its sha256 here); 7 days; one open invite per (team, email) — inviting again re-sends it.
// The answer to "invite these addresses" is the same whether or not they have accounts (no enumeration).
// From the drive (its share dialog, through the team callback): members only, and only on behalf of someone who is an
// admin of the team in the console right now (contract "Invite from the drive").
import { audit } from './audit'
import { CloudError, type Cloud } from './cloud'
import { hashPassword } from './keys'
import type { TeamRow } from './db'
import { atLeast, userPublicId } from './team-members'
import { checkPassword } from './cloud'
import { EMAIL_RE, publicId, random, sha256 } from './util'

export const INVITE_TTL_MS = 7 * 86400_000
export const INVITES_PER_TEAM_DAY = 50
export const MAX_EMAILS_PER_REQUEST = 20

export interface InviteRow {
  id: number; team_id: number; email: string; role: 'admin' | 'member'; secret_hash: string; invited_by: number; via: string
  created_at: number; expires_at: number; last_sent_at: number | null; accepted_at: number | null; accepted_user_id: number | null
  revoked_at: number | null; linked_at: number | null
}

/** inv_ + 12 digits: the id the drive sees (accounts.cloud_invite) and the console's URLs use */
export const invitePublicId = (id: number) => `inv_${String(id).padStart(12, '0')}`
export const inviteIdOf = (pid: string) => { const m = /^inv_(\d{12})$/.exec(pid); return m ? Number(m[1]) : null }

const normEmail = (e: unknown) => (typeof e === 'string' ? e.trim().toLowerCase() : '')

export function parseEmails(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,;]+/) : []
  const out = [...new Set(raw.map(normEmail).filter(Boolean))]
  if (!out.length) throw new CloudError('bad_email', 'one or more email addresses')
  if (out.length > MAX_EMAILS_PER_REQUEST) throw new CloudError('too_many', `at most ${MAX_EMAILS_PER_REQUEST} addresses at once`)
  for (const e of out) if (!EMAIL_RE.test(e) || e.length > 254) throw new CloudError('bad_email', `not an email address: ${e}`)
  return out
}

export class Invites {
  constructor(private readonly c: Cloud) {}
  private get db() { return this.c.db }

  open(teamId: number): InviteRow[] {
    return this.db.query<InviteRow, [number, number]>('SELECT * FROM invites WHERE team_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at').all(teamId, Date.now())
  }
  /** open invites, plus accepted ones the drive has not linked yet (sync.ts) */
  forSync(teamId: number): InviteRow[] {
    return this.db.query<InviteRow, [number, number]>('SELECT * FROM invites WHERE team_id = ? AND revoked_at IS NULL AND ((accepted_at IS NULL AND expires_at > ?) OR (accepted_at IS NOT NULL AND linked_at IS NULL)) ORDER BY id')
      .all(teamId, Date.now())
  }
  byPublicId(t: TeamRow, pid: string): InviteRow | null {
    const id = inviteIdOf(pid)
    return id == null ? null : this.db.query<InviteRow, [number, number]>('SELECT * FROM invites WHERE id = ? AND team_id = ?').get(id, t.id)
  }

  /** Invites (or re-sends) each address. by = the inviting console user. Returns the invites, same shape for all. */
  async create(t: TeamRow, by: number, emailsIn: unknown, roleIn: unknown, via: 'console' | 'drive' = 'console') {
    const role = roleIn === 'admin' ? 'admin' : roleIn === 'member' || roleIn === undefined || roleIn === '' ? 'member' : null
    if (!role) throw new CloudError('bad_role', 'role: admin or member')
    const emails = parseEmails(emailsIn)
    const today = this.db.query<{ n: number }, [number, number]>('SELECT count(*) AS n FROM invites WHERE team_id = ? AND coalesce(last_sent_at, created_at) > ?').get(t.id, Date.now() - 86400_000)!.n
    if (today + emails.length > INVITES_PER_TEAM_DAY) throw new CloudError('rate_limited', `at most ${INVITES_PER_TEAM_DAY} invites a day per team`, 429)
    const members = new Set(this.db.query<{ email: string }, [number]>("SELECT lower(u.email) AS email FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = ? AND m.status = 'active'").all(t.id).map((r) => r.email))
    const fresh = emails.filter((e) => !members.has(e) && !this.db.query('SELECT 1 FROM invites WHERE team_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?').get(t.id, e, Date.now()))
    const seats = this.c.members.seats(t)
    if (seats.max != null && seats.used + fresh.length > seats.max) throw new CloudError('people_limit', `the ${t.plan === 'free' ? 'Free' : t.plan} plan has room for ${seats.max} people (members and open invites); ${seats.used} are taken`, 409)
    const inviter = this.db.query<{ email: string; name: string | null }, [number]>('SELECT email, name FROM users WHERE id = ?').get(by)
    const out: { id: string; email: string; role: string; expires_at: number }[] = []
    for (const email of emails) {
      const secret = random(32), now = Date.now()
      let row: InviteRow
      if (members.has(email)) {
        // already in the team: nothing to send, the same answer
        out.push({ id: 'inv_member', email, role, expires_at: now + INVITE_TTL_MS }); continue
      }
      const existing = this.db.query<InviteRow, [number, string, number]>('SELECT * FROM invites WHERE team_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?').get(t.id, email, now)
      if (existing) {
        this.db.query('UPDATE invites SET secret_hash = ?, role = ?, expires_at = ?, last_sent_at = ? WHERE id = ?').run(sha256(secret), role, now + INVITE_TTL_MS, now, existing.id)
        row = this.db.query<InviteRow, [number]>('SELECT * FROM invites WHERE id = ?').get(existing.id)!
      } else {
        // an expired open invite would block the unique index: close it first
        this.db.query('UPDATE invites SET revoked_at = ? WHERE team_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL').run(now, t.id, email)
        const id = Number(this.db.query('INSERT INTO invites (team_id, email, role, secret_hash, invited_by, via, created_at, expires_at, last_sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(t.id, email, role, sha256(secret), by, via, now, now + INVITE_TTL_MS, now).lastInsertRowid)
        row = this.db.query<InviteRow, [number]>('SELECT * FROM invites WHERE id = ?').get(id)!
      }
      audit(this.db, { actor: `user:${by}`, action: 'member.invited', teamId: t.id, detail: { invite: invitePublicId(row.id), role, via, domain: email.slice(email.indexOf('@') + 1) } })
      await this.mail(t, row, secret, inviter?.name || inviter?.email || 'An admin')
      out.push({ id: invitePublicId(row.id), email, role, expires_at: row.expires_at })
    }
    if (fresh.length || out.length) this.c.sync.changed(t.id)
    return out
  }

  private async mail(t: TeamRow, inv: InviteRow, secret: string, inviter: string) {
    // the inviter's name is fine here: an invite is not a file or folder notice (R11 names nothing shared)
    await this.c.mailer.send({
      to: inv.email, subject: `You're invited to ${t.name} on Trina Cloud`,
      text: [
        `${inviter} invited you to join ${t.name}'s Trina Drive${inv.role === 'admin' ? ' as an admin' : ''}.`, '',
        `Accept: ${this.c.cfg.controlUrl}/invite/${secret}`, '',
        `The link works for 7 days, only for ${inv.email} (sign in or create your account with this address).`,
        "If you didn't expect this, you can ignore it.",
      ].join('\n'),
    }).catch((e) => this.c.log(`invite mail to team ${t.slug} failed: ${(e as Error).message}`))
  }

  async resend(t: TeamRow, by: number, pid: string) {
    const inv = this.byPublicId(t, pid)
    if (!inv || inv.accepted_at || inv.revoked_at) throw new CloudError('not_found', 'not found', 404)
    const secret = random(32), now = Date.now()
    this.db.query('UPDATE invites SET secret_hash = ?, expires_at = ?, last_sent_at = ? WHERE id = ?').run(sha256(secret), now + INVITE_TTL_MS, now, inv.id)
    const inviter = this.db.query<{ email: string; name: string | null }, [number]>('SELECT email, name FROM users WHERE id = ?').get(by)
    audit(this.db, { actor: `user:${by}`, action: 'member.invite_resent', teamId: t.id, detail: { invite: pid } })
    await this.mail(t, { ...inv, expires_at: now + INVITE_TTL_MS }, secret, inviter?.name || inviter?.email || 'An admin')
    this.c.sync.changed(t.id)
  }

  revoke(t: TeamRow, by: number, pid: string) {
    const inv = this.byPublicId(t, pid)
    if (!inv || inv.accepted_at || inv.revoked_at) throw new CloudError('not_found', 'not found', 404)
    this.db.query('UPDATE invites SET revoked_at = ? WHERE id = ?').run(Date.now(), inv.id)
    audit(this.db, { actor: `user:${by}`, action: 'member.invite_revoked', teamId: t.id, detail: { invite: pid } })
    this.c.sync.changed(t.id, [{ type: 'invite.revoked', invite: pid }])
  }

  /** The invite a link points at (open, not expired), or null. */
  peek(token: unknown): (InviteRow & { team: TeamRow; inviter: string }) | null {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null
    const inv = this.db.query<InviteRow, [string, number]>('SELECT * FROM invites WHERE secret_hash = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?').get(sha256(token), Date.now())
    if (!inv) return null
    const team = this.db.query<TeamRow, [number]>("SELECT * FROM teams WHERE id = ? AND status != 'deleted'").get(inv.team_id)
    if (!team) return null
    const u = this.db.query<{ email: string; name: string | null }, [number]>('SELECT email, name FROM users WHERE id = ?').get(inv.invited_by)
    return { ...inv, team, inviter: u?.name || u?.email || 'An admin' }
  }

  /** The signed-in account accepts: its confirmed email must be the invited address (finding 7). */
  accept(token: unknown, userId: number): TeamRow {
    const inv = this.peek(token)
    if (!inv) throw new CloudError('bad_link', 'this invite is used, expired, revoked or wrong', 404)
    const u = this.db.query<{ email: string; verified_at: number | null }, [number]>('SELECT email, verified_at FROM users WHERE id = ?').get(userId)
    if (!u?.verified_at) throw new CloudError('unverified', 'confirm your email address first', 403)
    if (u.email.toLowerCase() !== inv.email.toLowerCase()) throw new CloudError('wrong_account', `this invite is for ${inv.email}: sign in with that address`, 403)
    const t = inv.team
    // the owner (or someone already in) keeps their role; the invite is used up either way
    const already = this.c.members.role(t.id, userId)
    if (!already) {
      const seats = this.c.members.seats(t)
      // the invite itself is one of the seats counted
      if (seats.max != null && seats.used > seats.max) throw new CloudError('people_limit', `${t.name} is full (${seats.max} people)`, 409)
    }
    if (this.db.query('UPDATE invites SET accepted_at = ?, accepted_user_id = ? WHERE id = ? AND accepted_at IS NULL').run(Date.now(), userId, inv.id).changes !== 1) throw new CloudError('bad_link', 'this invite is used', 404)
    if (!already) this.c.members.join(t, userId, inv.role, inv.invited_by)
    audit(this.db, { actor: `user:${userId}`, action: 'member.joined', teamId: t.id, detail: { user: userPublicId(this.c, userId), invite: invitePublicId(inv.id), role: already ?? inv.role } })
    this.c.sync.changed(t.id)
    return t
  }

  /** Sign-up from an invite link: the mailbox is proven by the link, so the account is confirmed at once. */
  async signupAndAccept(token: unknown, nameIn: unknown, password: unknown): Promise<{ userId: number; team: TeamRow }> {
    const inv = this.peek(token)
    if (!inv) throw new CloudError('bad_link', 'this invite is used, expired, revoked or wrong', 404)
    if (this.db.query('SELECT 1 FROM users WHERE email = ?').get(inv.email)) throw new CloudError('has_account', `${inv.email} already has an account: sign in to accept`, 409)
    const pw = checkPassword(password)
    const name = typeof nameIn === 'string' ? nameIn.trim().replace(/\s+/g, ' ').slice(0, 80) : ''
    const now = Date.now()
    const userId = Number(this.db.query('INSERT INTO users (email, password_hash, verified_at, created_at, public_id, name, password_set) VALUES (?, ?, ?, ?, ?, ?, 1)')
      .run(inv.email, await hashPassword(pw), now, now, publicId('usr'), name || null).lastInsertRowid)
    audit(this.db, { actor: 'web', action: 'user.signup', detail: { user: userId, invite: invitePublicId(inv.id) } })
    return { userId, team: this.accept(token, userId) }
  }

  // ---------------------------------------------------------------- from the drive (team callback)
  /** POST /api/team-callback/invites: Bearer = the team's callback token (sha256 kept). Contract "Invite from the drive". */
  async fromDrive(t: TeamRow, body: Record<string, unknown>) {
    if (body.role !== 'member') throw new CloudError('bad_role', 'only members are invited from the drive; admins are invited in the console', 400)
    const email = normEmail(body.email)
    if (!EMAIL_RE.test(email) || email.length > 254) throw new CloudError('bad_email', 'a valid email address', 400)
    const sub = typeof body.by_cloud_user === 'string' ? body.by_cloud_user : ''
    const by = this.db.query<{ id: number }, [string]>('SELECT id FROM users WHERE public_id = ?').get(sub)
    if (!by || !atLeast(this.c.members.role(t.id, by.id), 'admin')) throw new CloudError('not_admin', 'not an admin of this team in the console', 403)
    const [inv] = await this.create(t, by.id, [email], 'member', 'drive')
    return inv!.id === 'inv_member' ? { status: 'member', invite: null } : { status: 'invited', invite: inv!.id }
  }
}
