// People in Trina Cloud mode: the console owns membership, the drive keeps a projection (accounts.cloud_user /
// cloud_invite). What member sync (sync.ts) and SSO sign-in (sso.ts) share: finding a person, making one, cutting every
// credential of someone removed, keeping Everyone = the active members, and telling the admins about a new admin.
import { appendAudit } from '../audit'
import type { DB } from '../db'
import { nfc } from '../names'
import { revokeAppPasswordsOf } from '../dav/apppw'
import { revokeGrantsOf } from '../oauth/tokens'
import { addPerson } from '../store'
import { revokeSessionsOf, revokeTokensOf } from '../web/auth'
import type { WebCtx } from '../web/http'
import { notify, type NoticeCtx } from '../web/notices'
import { PERSON_NAME } from '../web/op-common'
import { ensureWebSchema, metaGet, metaSet } from '../web/schema'
import { everyoneGroup } from '../share/rules'

export interface CloudPerson { id: number; name: string; admin: number; active: number; cloud_user: string | null; cloud_invite: string | null; email: string | null }

const SELECT = `SELECT p.id, p.name, p.admin, p.active, a.cloud_user, a.cloud_invite, a.email FROM people p LEFT JOIN accounts a ON a.person_id = p.id`
export const byCloudUser = (db: DB, sub: string) => db.query<CloudPerson, [string]>(`${SELECT} WHERE a.cloud_user = ?`).get(sub)
export const byInvite = (db: DB, invite: string) => db.query<CloudPerson, [string]>(`${SELECT} WHERE a.cloud_invite = ? AND a.cloud_user IS NULL`).get(invite)
/** A person not yet tied to a console account with this address (case-insensitive). */
export const unboundByEmail = (db: DB, email: string) => db.query<CloudPerson, [string]>(`${SELECT} WHERE a.email = ? COLLATE NOCASE AND a.cloud_user IS NULL`).get(email)
/** An invite row nobody accepted yet: not counted on the plan, not in Everyone. */
export const inviteOnly = (p: Pick<CloudPerson, 'cloud_user' | 'cloud_invite'>) => p.cloud_user == null && p.cloud_invite != null
export const cloudPerson = (db: DB, id: number) => db.query<CloudPerson, [number]>(`${SELECT} WHERE p.id = ?`).get(id)

/** The person has a console identity (a member or an open invite): the console decides about them, not the drive. */
export function isManaged(db: DB, personId: number): boolean {
  ensureWebSchema(db)
  return !!db.query('SELECT 1 FROM accounts WHERE person_id = ? AND (cloud_user IS NOT NULL OR cloud_invite IS NOT NULL)').get(personId)
}
export const cloudUserOf = (db: DB, personId: number) =>
  db.query<{ cloud_user: string | null }, [number]>('SELECT cloud_user FROM accounts WHERE person_id = ?').get(personId)?.cloud_user ?? null

/** A free handle for a new person: the mail address's local part (cleaned), then -2, -3 … */
export function freshName(db: DB, email: string): string {
  let base = nfc(email.split('@')[0] ?? '').replace(/[\s/\\\p{Cc}]+/gu, '-').replace(/^[@#-]+/, '').slice(0, 56)
  if (!base || !PERSON_NAME.test(base)) base = 'member'
  const taken = db.query<{ id: number }, [string]>('SELECT id FROM people WHERE name = ?')
  for (let n = 1; ; n++) { const name = n === 1 ? base : `${base}-${n}`; if (!taken.get(name)) return name }
}

/**
 * A new person tied to the console (JIT on sign-in, a member the sync has not seen yet, or an open invite). A member
 * counts against TDRIVE_MAX_PEOPLE; an invite nobody accepted yet does not (store.ts activePeople).
 */
export function createCloudPerson(db: DB, o: { email: string; displayName: string; admin: boolean; cloudUser: string | null; invite: string | null }): number {
  ensureWebSchema(db)
  const name = freshName(db, o.email)
  const id = o.cloudUser ? addPerson(db, name, o.admin).id
    : Number(db.query('INSERT INTO people (name, admin, created_at) VALUES (?, 0, ?)').run(name, Date.now()).lastInsertRowid)
  db.query('UPDATE people SET display_name = ? WHERE id = ?').run(o.displayName || null, id)
  db.query('INSERT INTO accounts (person_id, email, created_at, cloud_user, cloud_invite) VALUES (?, ?, ?, ?, ?)').run(id, o.email, Date.now(), o.cloudUser, o.invite)
  return id
}

export interface Cut { sessions: number; tokens: number; grants: number; app_passwords: number }
/** Every way in for this person: web sessions, personal access tokens, OAuth grants (and their tokens), app passwords. */
export function cutCredentials(db: DB, personId: number): Cut {
  ensureWebSchema(db)
  const sessions = db.query<{ n: number }, [number]>('SELECT count(*) AS n FROM web_sessions WHERE person_id = ? AND revoked_at IS NULL').get(personId)!.n
  revokeSessionsOf(db, personId)
  const grants = revokeGrantsOf(db, personId)
  const tokens = revokeTokensOf(db, personId)
  const app_passwords = revokeAppPasswordsOf(db, personId)
  return { sessions, tokens, grants, app_passwords }
}

/** Deactivate a console-managed person and cut every credential (in the caller's transaction). */
export function deactivate(db: DB, personId: number, why: string): Cut {
  db.query('UPDATE people SET active = 0 WHERE id = ?').run(personId)
  const cut = cutCredentials(db, personId)
  const p = cloudPerson(db, personId)
  appendAudit(db, { personId: null, tokenId: null, tool: 'cloud', command: `member ${p?.name ?? personId} deactivated (${why}); cut: ${cut.sessions} sessions, ${cut.tokens} tokens, ${cut.grants} OAuth grants, ${cut.app_passwords} app passwords`, files: [], outcome: 'ok' })
  return cut
}

/** Everyone, in cloud mode a system group: exactly the active people with a console account (not invites, not unmanaged). */
export function syncEveryone(db: DB): number {
  const g = everyoneGroup({ db } as WebCtx)
  db.query(`DELETE FROM memberships WHERE group_id = ? AND person_id NOT IN (
    SELECT p.id FROM people p JOIN accounts a ON a.person_id = p.id WHERE p.active = 1 AND a.cloud_user IS NOT NULL)`).run(g)
  db.query(`INSERT OR IGNORE INTO memberships (group_id, person_id)
    SELECT ?, p.id FROM people p JOIN accounts a ON a.person_id = p.id WHERE p.active = 1 AND a.cloud_user IS NOT NULL`).run(g)
  return g
}

/** People the console does not know (made by the CLI, setup or break-glass): never changed by the sync, reported to the console. */
export function unmanaged(db: DB) {
  ensureWebSchema(db)
  return db.query<{ name: string; admin: number; active: number }, []>(
    `SELECT p.name, p.admin, p.active FROM people p LEFT JOIN accounts a ON a.person_id = p.id
     WHERE a.person_id IS NULL OR (a.cloud_user IS NULL AND a.cloud_invite IS NULL) ORDER BY p.name`).all()
    .map((p) => ({ name: p.name, admin: !!p.admin, active: !!p.active }))
}

/** The first console admin is in: the one-time setup token has nothing left to set up (review finding 6). */
export function closeSetupIfCloudAdmin(db: DB) {
  if (metaGet(db, 'web_setup_token') && db.query('SELECT 1 FROM people p JOIN accounts a ON a.person_id = p.id WHERE p.admin = 1 AND p.active = 1 AND a.cloud_user IS NOT NULL').get()) {
    metaSet(db, 'web_setup_token', null)
    appendAudit(db, { personId: null, tokenId: null, tool: 'cloud', command: 'setup token withdrawn: a console admin can sign in', files: [], outcome: 'ok' })
  }
}

/**
 * Someone became an admin (was not): an audit row now, and a notice to every other active admin and to the person
 * (review finding 3: a console compromise that mints an admin is seen at once).
 */
export async function announceNewAdmins(n: NoticeCtx, personIds: number[], how: string) {
  if (!personIds.length) return
  for (const id of personIds) {
    const name = n.db.query<{ name: string }, [number]>('SELECT name FROM people WHERE id = ?').get(id)?.name ?? String(id)
    appendAudit(n.db, { personId: null, tokenId: null, tool: 'cloud', command: `admin added: ${name} (${how})`, files: [], outcome: 'ok' })
  }
  const admins = n.db.query<{ id: number }, []>('SELECT id FROM people WHERE admin = 1 AND active = 1').all().map((p) => p.id)
  await notify(n, new Set([...admins, ...personIds]), 'admin_added', '/#/people', { count: personIds.length })
}
