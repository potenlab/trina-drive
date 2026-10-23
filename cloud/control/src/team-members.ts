// Team membership in the console (plan 2.2 / 2.3): the console's team_members table is the source of who belongs to a
// team; each team's drive gets a projection by member sync (sync.ts). Roles: owner (exactly one, teams.owner_user_id),
// admin, member. "Not yours = not found": callers answer 404 for a team the person is not an active member of.
//
// Rules (who may do what) live here; the second-factor rules (enrolled, fresh code) are checked by the routes before
// these run (routes/console-guard.ts):
//   change a role      admin+; nobody changes the owner's role (transfer only); only the owner changes an admin's role
//   remove             admin+ removes members; only the owner removes an admin; the owner cannot be removed
//   leave              members and admins (the owner transfers first)
//   transfer           owner → an active admin (the old owner becomes admin)
import { audit } from './audit'
import { CloudError, type Cloud } from './cloud'
import type { TeamRow } from './db'
import { planOf } from './plans'
import type { Role } from './sso'
import { publicId } from './util'

export interface MemberRow {
  user_id: number; public_id: string; email: string; name: string | null; role: Role; status: 'active' | 'removed'
  created_at: number; updated_at: number; synced_at: number | null; totp: number
}

/** users.public_id, made when missing (accounts created before the console had them, or by other paths). */
export function userPublicId(c: Pick<Cloud, 'db'>, userId: number): string {
  const r = c.db.query<{ public_id: string | null }, [number]>('SELECT public_id FROM users WHERE id = ?').get(userId)
  if (!r) throw new CloudError('no_user', 'no such account', 404)
  if (r.public_id) return r.public_id
  const pid = publicId('usr')
  c.db.query('UPDATE users SET public_id = coalesce(public_id, ?) WHERE id = ?').run(pid, userId)
  return c.db.query<{ public_id: string }, [number]>('SELECT public_id FROM users WHERE id = ?').get(userId)!.public_id
}

export const ROLE_RANK: Record<Role, number> = { member: 1, admin: 2, owner: 3 }
export const atLeast = (role: Role | null, need: Role) => !!role && ROLE_RANK[role] >= ROLE_RANK[need]

export class TeamMembers {
  constructor(private readonly c: Cloud) {}
  private get db() { return this.c.db }

  role(teamId: number, userId: number): Role | null {
    return this.db.query<{ role: Role }, [number, number]>("SELECT role FROM team_members WHERE team_id = ? AND user_id = ? AND status = 'active'").get(teamId, userId)?.role ?? null
  }

  /** The owner's row (team creation, and teams made before the console). */
  addOwner(teamId: number, userId: number) {
    const t = Date.now()
    this.db.query(`INSERT INTO team_members (team_id, user_id, role, status, added_by, created_at, updated_at) VALUES (?, ?, 'owner', 'active', ?, ?, ?)
      ON CONFLICT (team_id, user_id) DO UPDATE SET role = 'owner', status = 'active', updated_at = excluded.updated_at`).run(teamId, userId, userId, t, t)
    userPublicId(this.c, userId)
  }

  /** Teams this account is an active member of, with its role (owner first, then by creation). */
  teamsOf(userId: number): (TeamRow & { role: Role })[] {
    return this.db.query<TeamRow & { role: Role }, [number]>(`SELECT t.*, m.role AS role FROM team_members m JOIN teams t ON t.id = m.team_id
      WHERE m.user_id = ? AND m.status = 'active' AND t.status != 'deleted' ORDER BY t.id`).all(userId)
  }

  list(teamId: number): MemberRow[] {
    return this.db.query<MemberRow, [number]>(`SELECT m.user_id, u.public_id, u.email, u.name, m.role, m.status, m.created_at, m.updated_at, m.synced_at,
      (u.totp_secret_enc IS NOT NULL) AS totp FROM team_members m JOIN users u ON u.id = m.user_id
      WHERE m.team_id = ? AND m.status = 'active' ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.created_at, u.email`).all(teamId)
  }

  /** active members + open invites, against the plan's people limit (Free: 3) */
  seats(t: TeamRow): { used: number; max: number | null } {
    const members = this.db.query<{ n: number }, [number]>("SELECT count(*) AS n FROM team_members WHERE team_id = ? AND status = 'active'").get(t.id)!.n
    const invites = this.db.query<{ n: number }, [number, number]>('SELECT count(*) AS n FROM invites WHERE team_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?').get(t.id, Date.now())!.n
    return { used: members + invites, max: planOf(t.plan).maxPeople ?? null }
  }

  /** An accepted invite (or re-invite of someone removed before). */
  join(t: TeamRow, userId: number, role: Exclude<Role, 'owner'>, by: number | null) {
    const now = Date.now()
    this.db.query(`INSERT INTO team_members (team_id, user_id, role, status, added_by, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?)
      ON CONFLICT (team_id, user_id) DO UPDATE SET role = CASE WHEN team_members.status = 'active' THEN team_members.role ELSE excluded.role END,
        status = 'active', added_by = excluded.added_by, updated_at = excluded.updated_at`).run(t.id, userId, role, by, now, now)
    userPublicId(this.c, userId)
  }

  setRole(t: TeamRow, actorId: number, targetId: number, role: unknown) {
    if (role !== 'admin' && role !== 'member') throw new CloudError('bad_role', 'role: admin or member (the owner changes with a transfer)')
    const mine = this.role(t.id, actorId), theirs = this.role(t.id, targetId)
    if (!atLeast(mine, 'admin') || !theirs) throw new CloudError('not_found', 'not found', 404)
    if (theirs === 'owner') throw new CloudError('owner_role', 'the owner\'s role changes only by transferring ownership', 409)
    if (theirs === 'admin' && mine !== 'owner' && targetId !== actorId) throw new CloudError('owner_only', 'only the owner changes an admin\'s role', 403)
    if (theirs === role) return false
    this.db.query('UPDATE team_members SET role = ?, updated_at = ? WHERE team_id = ? AND user_id = ?').run(role, Date.now(), t.id, targetId)
    audit(this.db, { actor: `user:${actorId}`, action: 'member.role_changed', teamId: t.id, detail: { user: userPublicId(this.c, targetId), from: theirs, to: role } })
    this.c.sync.changed(t.id)
    return true
  }

  remove(t: TeamRow, actorId: number, targetId: number) {
    const mine = this.role(t.id, actorId), theirs = this.role(t.id, targetId)
    const self = actorId === targetId
    if (!theirs || (!self && !atLeast(mine, 'admin'))) throw new CloudError('not_found', 'not found', 404)
    if (theirs === 'owner') throw new CloudError('owner_role', self ? 'transfer the ownership first' : 'the owner cannot be removed', 409)
    if (theirs === 'admin' && !self && mine !== 'owner') throw new CloudError('owner_only', 'only the owner removes an admin', 403)
    this.db.query("UPDATE team_members SET status = 'removed', updated_at = ? WHERE team_id = ? AND user_id = ?").run(Date.now(), t.id, targetId)
    const sub = userPublicId(this.c, targetId)
    audit(this.db, { actor: `user:${actorId}`, action: self ? 'member.left' : 'member.removed', teamId: t.id, detail: { user: sub, role: theirs } })
    // the drive deactivates them and cuts every credential (sessions, tokens, OAuth grants, app passwords)
    this.c.sync.changed(t.id, [{ type: 'member.removed', cloud_user: sub }])
    const email = this.db.query<{ email: string }, [number]>('SELECT email FROM users WHERE id = ?').get(targetId)!.email
    if (!self) void this.c.mailer.send({ to: email, subject: `You were removed from ${t.name} on Trina Cloud`, text: `An admin removed you from ${t.name} (${this.c.url(t)}). You no longer have access to its drive.\n\nQuestions? Ask the team's admins.` }).catch(() => {})
  }

  transfer(t: TeamRow, ownerId: number, toUserId: number) {
    if (this.role(t.id, ownerId) !== 'owner') throw new CloudError('not_found', 'not found', 404)
    if (this.role(t.id, toUserId) !== 'admin') throw new CloudError('not_admin', 'ownership goes to an admin of the team: make them an admin first', 409)
    const now = Date.now()
    this.db.transaction(() => {
      this.db.query("UPDATE team_members SET role = 'admin', updated_at = ? WHERE team_id = ? AND user_id = ?").run(now, t.id, ownerId)
      this.db.query("UPDATE team_members SET role = 'owner', updated_at = ? WHERE team_id = ? AND user_id = ?").run(now, t.id, toUserId)
      this.db.query('UPDATE teams SET owner_user_id = ?, updated_at = ? WHERE id = ?').run(toUserId, now, t.id)
    })()
    audit(this.db, { actor: `user:${ownerId}`, action: 'team.transfer', teamId: t.id, detail: { from: userPublicId(this.c, ownerId), to: userPublicId(this.c, toUserId) } })
    this.c.sync.changed(t.id)
    for (const id of [ownerId, toUserId]) {
      const email = this.db.query<{ email: string }, [number]>('SELECT email FROM users WHERE id = ?').get(id)!.email
      void this.c.mailer.send({ to: email, subject: `Ownership of ${t.name} on Trina Cloud changed`, text: id === toUserId
        ? `You are now the owner of ${t.name} (${this.c.url(t)}) on Trina Cloud. The previous owner is an admin now.`
        : `You transferred the ownership of ${t.name} (${this.c.url(t)}). You are an admin of it now.` }).catch(() => {})
    }
  }
}
