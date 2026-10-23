// People and groups changed from the web (add, invite, admin/active/mail, password reset, own password, groups and
// members), and typing the password again (fresh login). Moved here unchanged from src/web/ops.ts (W0 seams) so the
// Trina Cloud SSO and member-sync work (workstream B1) changes one module; src/web/api.ts routes to it.
// Trina Cloud (src/tdcloud): the console owns membership. Under TDRIVE_SSO_ONLY the drive cannot add people, change a
// console-managed person (admin, active, mail, password) or invite by mail (409 managed_by_console; invites go through
// POST /api/cloud/invite); in cloud mode Everyone is a system group the sync keeps. Typing the password again (fresh
// login) also takes a passkey or an authenticator code, and people without a drive password use the console
// (GET /api/sso/start?reauth=1).
import { Rights } from '../rights'
import { addPerson, checkPeopleRoom } from '../store'
import { revokeAppPasswordsOf } from '../dav/apppw'
import { accountOf, checkPasswordRules, createLink, FRESH_LOGIN_MS, markReauth, revokeSessionsOf, revokeTokensOf, setPassword, verifyPassword } from './auth'
import { ApiError, bad, rateLimited } from './http'
import { ensureWebSchema, metaGet, metaSet } from './schema'
import { everyoneGroup } from '../share/rules'
import { cloudConfig } from '../tdcloud/config'
import { announceNewAdmins, cloudUserOf, isManaged } from '../tdcloud/people'
import { MfaError, passkeyAssertionOptions, passkeyVerify, totpEnabled, totpVerify } from './mfa'
import { pkConfig } from './approve'
import { withRejudge } from '../share/rejudge'
import { activeAdmins, checkEmail, checkName, groupRow, isUnique, now, personRow, record, requireAdmin, tell, type Op } from './op-common'

const managedByConsole = () => new ApiError(409, 'managed_by_console', 'people are managed in the Trina Cloud console')
/** TDRIVE_SSO_ONLY: adding people and changing console-managed people happen in the console. */
function consoleOnly(op: Op, personId?: number) {
  if (cloudConfig(op.w.db)?.ssoOnly && (personId === undefined || isManaged(op.w.db, personId))) throw managedByConsole()
}
/** Cloud mode: Everyone is a system group (= the active members, kept by the sync); nobody edits it here (review finding 13). */
function systemGroup(op: Op, groupId: number) {
  if (cloudConfig(op.w.db) && metaGet(op.w.db, 'everyone_group') === String(groupId)) throw managedByConsole()
}

async function sendInvite(op: Op, personId: number, email: string) {
  const secret = createLink(op.w.db, 'invite', personId, op.actor.personId)
  const url = `${op.base}/#/invite/${secret}`
  await op.w.mailer.send({ to: email, subject: 'You are invited', text: `You were invited to the team file server. Choose a password here (valid 7 days, once):\n${url}\n` })
  return url
}


/** A1 (src/share/rejudge.ts): people and membership changes re-check AI-draft copies in their own transaction. */
const MEMBERSHIP = { mode: 'membership' as const }
export async function createPerson(op: Op, body: { name?: unknown; email?: unknown; admin?: unknown; groups?: unknown; everyone?: unknown }) {
  requireAdmin(op)
  consoleOnly(op)
  ensureWebSchema(op.w.db)
  const name = checkName(body.name), email = checkEmail(body.email)
  const groups = Array.isArray(body.groups) ? body.groups.map((g) => groupRow(op, g).id) : []
  if (body.everyone !== false) groups.push(everyoneGroup(op.w))
  const db = op.w.db
  let id = 0
  try {
    withRejudge(db, () => { // A1: membership changes re-check AI-draft copies (R6) in the same transaction
      id = addPerson(db, name, body.admin === true).id
      db.query('INSERT INTO accounts (person_id, email, created_at) VALUES (?, ?, ?)').run(id, email, now())
      for (const g of new Set(groups)) db.query('INSERT OR IGNORE INTO memberships (group_id, person_id) VALUES (?, ?)').run(g, id)
      record(op, `person add ${name}${body.admin === true ? ' --admin' : ''}`)
    }, MEMBERSHIP)
  } catch (e) { if (isUnique(e)) throw new ApiError(409, 'exists', 'that name or mail address is taken'); throw e }
  const invite_url = await sendInvite(op, id, email)
  return { id, invite_url }
}

/** A new invite for someone who has not chosen a password yet (people made by the CLI get their address here). */
export async function invitePerson(op: Op, id: unknown, body: { email?: unknown }) {
  requireAdmin(op)
  consoleOnly(op)
  const p = personRow(op, id)
  const acc = accountOf(op.w.db, p.id)
  if (acc?.password_hash) throw new ApiError(409, 'has_password', 'this person already has a password; use a reset link')
  const email = acc?.email ?? checkEmail(body.email)
  try {
    if (!acc) op.w.db.query('INSERT INTO accounts (person_id, email, created_at) VALUES (?, ?, ?)').run(p.id, email, now())
  } catch (e) { if (isUnique(e)) throw new ApiError(409, 'exists', 'that mail address is taken'); throw e }
  record(op, `person invite ${p.name}`)
  return { invite_url: await sendInvite(op, p.id, email) }
}

export async function updatePerson(op: Op, id: unknown, body: { admin?: unknown; active?: unknown; email?: unknown }) {
  requireAdmin(op)
  const p = personRow(op, id)
  const db = op.w.db
  // SSO-only: console people are the console's; someone the console does not know (CLI, break-glass) may only be turned off
  consoleOnly(op, p.id)
  if (cloudConfig(db)?.ssoOnly && (body.admin !== undefined || body.email !== undefined || body.active === true)) throw managedByConsole()
  const admins = activeAdmins(op)
  const losesAdmin = (body.admin === false && p.admin) || (body.active === false && p.admin)
  if (losesAdmin && admins.length === 1 && admins[0] === p.id) throw bad('last_admin', 'there must be at least one admin')
  if (body.active === false && p.id === op.actor.personId) throw bad('self', 'you cannot deactivate yourself')
  // turning someone back on counts against the plan's people limit like a new person
  if (body.active === true && !p.active) checkPeopleRoom(db)
  let oldEmail: string | undefined
  try {
    withRejudge(db, () => {
      if (typeof body.admin === 'boolean') { db.query('UPDATE people SET admin = ? WHERE id = ?').run(body.admin ? 1 : 0, p.id); record(op, `person ${p.name} admin=${body.admin}`) }
      if (typeof body.active === 'boolean') {
        db.query('UPDATE people SET active = ? WHERE id = ?').run(body.active ? 1 : 0, p.id)
        if (!body.active) revokeSessionsOf(db, p.id)
        record(op, `person ${p.name} active=${body.active}`)
      }
      if (body.email !== undefined) {
        const email = checkEmail(body.email)
        const acc = accountOf(db, p.id)
        oldEmail = acc?.email
        if (acc) db.query('UPDATE accounts SET email = ? WHERE person_id = ?').run(email, p.id)
        else db.query('INSERT INTO accounts (person_id, email, created_at) VALUES (?, ?, ?)').run(p.id, email, now())
        record(op, `person ${p.name} email changed`)
      }
    }, MEMBERSHIP)
  } catch (e) { if (isUnique(e)) throw new ApiError(409, 'exists', 'that mail address is taken'); throw e }
  // R9: an address change is told at the old address
  if (oldEmail) await tell(op, [p.id], 'email_changed', '/#/settings', { to: oldEmail })
  // review finding 3: a new admin is told to every admin and to them
  if (body.admin === true && !p.admin) await announceNewAdmins({ db, mailer: op.w.mailer, baseUrl: op.base }, [p.id], `made admin on the People page by person ${op.actor.personId}`)
  return { ok: true }
}

/**
 * R9: the admin never sets someone else's password. A one-time link goes to the person's own address only; at that
 * moment all their tokens and sessions are cut and they are told.
 */
export async function resetPassword(op: Op, id: unknown) {
  requireAdmin(op)
  const p = personRow(op, id)
  consoleOnly(op, p.id)
  const acc = accountOf(op.w.db, p.id)
  if (!acc) throw bad('no_account', 'this person has no sign-in address yet; send an invite')
  const db = op.w.db
  let secret = '', tokens = 0
  db.transaction(() => {
    tokens = revokeTokensOf(db, p.id)
    revokeSessionsOf(db, p.id)
    revokeAppPasswordsOf(db, p.id)
    secret = createLink(db, 'reset', p.id, op.actor.personId)
    record(op, `person ${p.name} password reset (tokens revoked: ${tokens})`)
  })()
  await op.w.mailer.send({ to: acc.email, subject: 'Set a new password', text:
    `An admin started a password reset for your account. Your access tokens and sessions were cut.\n` +
    `Set a new password here (valid 1 hour, once):\n${op.base}/#/reset/${secret}\n\nIf you did not expect this, tell your team now.\n` })
  await tell(op, [p.id], 'password_reset', '/#/tokens', { mail: false })
  return { ok: true, tokens_revoked: tokens }
}

export async function changeOwnPassword(op: Op, sessionIdHash: string, body: { current?: unknown; password?: unknown }) {
  consoleOnly(op, op.actor.personId)
  const acc = accountOf(op.w.db, op.actor.personId)
  if (!acc || typeof body.current !== 'string' || !(await verifyPassword(body.current, acc.password_hash))) throw bad('wrong_password', 'the current password is not right')
  await setPassword(op.w.db, op.actor.personId, checkPasswordRules(body.password))
  revokeSessionsOf(op.w.db, op.actor.personId, sessionIdHash)
  record(op, 'password changed')
  return { ok: true }
}

// ---------- groups ----------
export function createGroup(op: Op, body: { name?: unknown }) {
  requireAdmin(op)
  const name = checkName(body.name)
  try {
    let id = 0
    op.w.db.transaction(() => { id = Number(op.w.db.query('INSERT INTO groups (name) VALUES (?)').run(name).lastInsertRowid); record(op, `group add ${name}`) })()
    return { id }
  } catch (e) { if (isUnique(e)) throw new ApiError(409, 'exists', 'a group with that name exists'); throw e }
}

export function deleteGroup(op: Op, id: unknown) {
  requireAdmin(op)
  const g = groupRow(op, id)
  systemGroup(op, g.id)
  const db = op.w.db
  withRejudge(db, () => {
    db.query(`DELETE FROM rules WHERE subject_type = 'group' AND subject_id = ?`).run(g.id)
    db.query('DELETE FROM memberships WHERE group_id = ?').run(g.id)
    db.query('DELETE FROM groups WHERE id = ?').run(g.id)
    if (metaGet(db, 'everyone_group') === String(g.id)) metaSet(db, 'everyone_group', null)
    record(op, `group delete ${g.name}`)
  }, MEMBERSHIP)
  return { ok: true }
}

export async function setMember(op: Op, groupId: unknown, personId: unknown, member: boolean) {
  requireAdmin(op)
  const g = groupRow(op, groupId), p = personRow(op, personId)
  systemGroup(op, g.id)
  const db = op.w.db
  withRejudge(db, () => {
    if (member) db.query('INSERT OR IGNORE INTO memberships (group_id, person_id) VALUES (?, ?)').run(g.id, p.id)
    else db.query('DELETE FROM memberships WHERE group_id = ? AND person_id = ?').run(g.id, p.id)
    record(op, `group member ${g.name} ${member ? '+' : '-'}${p.name}`)
  }, MEMBERSHIP)
  // R9: an admin putting themselves in a group tells the managers of every folder that group reads, and themselves
  if (member && p.id === op.actor.personId && op.actor.admin) {
    const r = new Rights(db)
    const managers = new Set<number>([op.actor.personId])
    for (const [fid, rules] of r.rules) if (rules.some((x) => x.subject_type === 'group' && x.subject_id === g.id && x.level >= 1)) {
      const f = r.folders.get(fid)
      if (f) r.managersOf(f).forEach((m) => managers.add(m))
    }
    await tell(op, managers, 'self_grant', '/#/people')
  }
  return { ok: true }
}

// ---------- fresh login ----------
/** The binding of a passkey challenge for typing-again: this session only. */
export const reauthBinding = (sessionIdHash: string) => `reauth:${sessionIdHash}`

/**
 * Prove it is you again (rate limited like sign-in, per person): the password, or (review finding 4) a passkey or an
 * authenticator code — people signed in through Trina Cloud have no drive password; they can also re-authenticate at
 * the console (GET /api/sso/start?reauth=1).
 */
export async function reauth(op: Op, sessionIdHash: string, body: { password?: unknown; method?: unknown; code?: unknown; response?: unknown }) {
  const key = `reauth:${op.actor.personId}`
  if (op.w.loginByName.blocked(key)) throw rateLimited(op.w.loginByName.retryAfter(key))
  const db = op.w.db, pid = op.actor.personId
  const fail = (code: string, message: string) => { op.w.loginByName.hit(key); return bad(code, message) }
  if (body.method === 'totp') {
    if (!totpVerify(db, pid, body.code)) throw fail('bad_code', 'that code is not right')
  } else if (body.method === 'passkey') {
    const cfg = pkConfig(op.w)
    if (!cfg) throw new ApiError(409, 'passkeys_unavailable', 'passkeys are not available on this server')
    try { await passkeyVerify(db, cfg, pid, 'stepup', reauthBinding(sessionIdHash), body.response) } catch (e) {
      if (e instanceof MfaError) throw fail(e.code, e.message)
      throw e
    }
  } else {
    const acc = accountOf(db, pid)
    if (typeof body.password !== 'string' || !(await verifyPassword(body.password, acc?.password_hash))) throw fail('wrong_password', 'the password is not right')
  }
  op.w.loginByName.reset(key)
  markReauth(db, sessionIdHash)
  return { ok: true, fresh_for_s: FRESH_LOGIN_MS / 1000 }
}

/** How this person can prove it is them again here, with passkey options bound to this session when they have one. */
export async function reauthOptions(op: Op, sessionIdHash: string) {
  const db = op.w.db, pid = op.actor.personId
  const cfg = pkConfig(op.w)
  const passkey = cfg ? await passkeyAssertionOptions(db, cfg, pid, 'stepup', reauthBinding(sessionIdHash)) : null
  const c = cloudConfig(db)
  const methods = [
    ...(accountOf(db, pid)?.password_hash ? ['password'] : []), ...(passkey ? ['passkey'] : []), ...(totpEnabled(db, pid) ? ['totp'] : []),
    ...(c && cloudUserOf(db, pid) ? ['sso'] : []),
  ]
  return { methods, passkey, sso_url: methods.includes('sso') ? '/api/sso/start?reauth=1' : null }
}
