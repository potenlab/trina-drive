// Changes made from the web. Each one: find what it is about (404 when the caller may not see it), ask rights.ts
// whether the caller may do it (403), change it in one transaction together with its audit row, then send the
// notices R5/R7/R9 ask for. No permission logic lives in the HTTP handlers.
import fs from 'node:fs'
import path from 'node:path'
import { appendAudit } from '../audit'
import { isSystemName, nfc } from '../names'
import { Rights, type Actor } from '../rights'
import { addPerson, createToken, ensureFolder, LEVELS, registerFolder as storeRegister, StoreError, type FolderRow, type LevelName } from '../store'
import { accountOf, checkPasswordRules, createLink, revokeSessionsOf, revokeTokensOf, setPassword, verifyPassword } from './auth'
import { ApiError, bad, forbidden, notFound, type WebCtx } from './http'
import { notify, type NoticeKind } from './notices'
import { ensureWebSchema, metaGet, metaSet } from './schema'

export interface Op { w: WebCtx; actor: Actor; base: string }

const PERSON_NAME = /^[^\s/\\@#][^/\\\p{Cc}]{0,63}$/u
const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/

const now = () => Date.now()
const isUnique = (e: unknown) => /UNIQUE/.test(String((e as Error)?.message)) || (e as { code?: string })?.code === 'SQLITE_CONSTRAINT_UNIQUE'

function record(op: Op, command: string, files: string[] = []) {
  appendAudit(op.w.db, { personId: op.actor.personId, tokenId: null, tool: 'web', command, files, outcome: 'ok' })
}
const tell = (op: Op, ids: Iterable<number>, kind: NoticeKind, link: string, opts?: Parameters<typeof notify>[4]) =>
  notify({ db: op.w.db, mailer: op.w.mailer, baseUrl: op.base }, ids, kind, link, opts)

function requireAdmin(op: Op) { if (!op.actor.admin) throw forbidden('only an admin can do this') }
function personRow(op: Op, id: unknown) {
  const p = op.w.db.query<{ id: number; name: string; admin: number; active: number }, [number]>('SELECT id, name, admin, active FROM people WHERE id = ?').get(Number(id))
  if (!p) throw notFound()
  return p
}
function groupRow(op: Op, id: unknown) {
  const g = op.w.db.query<{ id: number; name: string }, [number]>('SELECT id, name FROM groups WHERE id = ?').get(Number(id))
  if (!g) throw notFound()
  return g
}
function checkName(name: unknown): string {
  if (typeof name !== 'string' || !PERSON_NAME.test(nfc(name.trim()))) throw bad('bad_name', 'names are 1–64 characters, without / \\ and not starting with @ or #')
  return nfc(name.trim())
}
function checkEmail(email: unknown): string {
  if (typeof email !== 'string' || email.length > 254 || !EMAIL.test(email.trim())) throw bad('bad_email', 'a valid mail address is required')
  return email.trim()
}
/** A folder the caller can see (else 404). */
export function visibleFolder(op: Op, r: Rights, id: unknown): FolderRow {
  const f = r.folders.get(Number(id))
  if (!f || !r.canSee(op.actor, f)) throw notFound()
  return f
}
const folderLink = (f: FolderRow) => `/#/folders/${f.id}`
const label = (r: Rights, f: FolderRow) => r.vpath(f) ?? f.path

function activeAdmins(op: Op) { return op.w.db.query<{ id: number }, []>('SELECT id FROM people WHERE admin = 1 AND active = 1').all().map((p) => p.id) }

/** The group every new person joins (the "everyone" of the public template). */
export function everyoneGroup(w: WebCtx): number {
  const db = w.db
  const known = metaGet(db, 'everyone_group')
  if (known && db.query('SELECT 1 FROM groups WHERE id = ?').get(Number(known))) return Number(known)
  const g = db.query<{ id: number }, []>(`SELECT id FROM groups WHERE name IN ('everyone', '전체', '전원') ORDER BY id LIMIT 1`).get()
  let id = g?.id
  if (id == null) {
    id = Number(db.query('INSERT INTO groups (name) VALUES (?)').run('everyone').lastInsertRowid)
    db.query('INSERT OR IGNORE INTO memberships (group_id, person_id) SELECT ?, id FROM people WHERE active = 1').run(id)
  }
  metaSet(db, 'everyone_group', String(id))
  return id
}

// ---------- people ----------
async function sendInvite(op: Op, personId: number, email: string) {
  const secret = createLink(op.w.db, 'invite', personId, op.actor.personId)
  const url = `${op.base}/#/invite/${secret}`
  await op.w.mailer.send({ to: email, subject: 'You are invited', text: `You were invited to the team file server. Choose a password here (valid 7 days, once):\n${url}\n` })
  return url
}

export async function createPerson(op: Op, body: { name?: unknown; email?: unknown; admin?: unknown; groups?: unknown; everyone?: unknown }) {
  requireAdmin(op)
  ensureWebSchema(op.w.db)
  const name = checkName(body.name), email = checkEmail(body.email)
  const groups = Array.isArray(body.groups) ? body.groups.map((g) => groupRow(op, g).id) : []
  if (body.everyone !== false) groups.push(everyoneGroup(op.w))
  const db = op.w.db
  let id = 0
  try {
    db.transaction(() => {
      id = addPerson(db, name, body.admin === true).id
      db.query('INSERT INTO accounts (person_id, email, created_at) VALUES (?, ?, ?)').run(id, email, now())
      for (const g of new Set(groups)) db.query('INSERT OR IGNORE INTO memberships (group_id, person_id) VALUES (?, ?)').run(g, id)
      record(op, `person add ${name}${body.admin === true ? ' --admin' : ''}`)
    })()
  } catch (e) { if (isUnique(e)) throw new ApiError(409, 'exists', 'that name or mail address is taken'); throw e }
  const invite_url = await sendInvite(op, id, email)
  return { id, invite_url }
}

/** A new invite for someone who has not chosen a password yet (people made by the CLI get their address here). */
export async function invitePerson(op: Op, id: unknown, body: { email?: unknown }) {
  requireAdmin(op)
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
  const admins = activeAdmins(op)
  const losesAdmin = (body.admin === false && p.admin) || (body.active === false && p.admin)
  if (losesAdmin && admins.length === 1 && admins[0] === p.id) throw bad('last_admin', 'there must be at least one admin')
  if (body.active === false && p.id === op.actor.personId) throw bad('self', 'you cannot deactivate yourself')
  let oldEmail: string | undefined
  try {
    db.transaction(() => {
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
    })()
  } catch (e) { if (isUnique(e)) throw new ApiError(409, 'exists', 'that mail address is taken'); throw e }
  // R9: an address change is told at the old address
  if (oldEmail) await tell(op, [p.id], 'email_changed', '/#/settings', { to: oldEmail })
  return { ok: true }
}

/**
 * R9: the admin never sets someone else's password. A one-time link goes to the person's own address only; at that
 * moment all their tokens and sessions are cut and they are told.
 */
export async function resetPassword(op: Op, id: unknown) {
  requireAdmin(op)
  const p = personRow(op, id)
  const acc = accountOf(op.w.db, p.id)
  if (!acc) throw bad('no_account', 'this person has no sign-in address yet; send an invite')
  const db = op.w.db
  let secret = '', tokens = 0
  db.transaction(() => {
    tokens = revokeTokensOf(db, p.id)
    revokeSessionsOf(db, p.id)
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
  const db = op.w.db
  db.transaction(() => {
    db.query(`DELETE FROM rules WHERE subject_type = 'group' AND subject_id = ?`).run(g.id)
    db.query('DELETE FROM memberships WHERE group_id = ?').run(g.id)
    db.query('DELETE FROM groups WHERE id = ?').run(g.id)
    if (metaGet(db, 'everyone_group') === String(g.id)) metaSet(db, 'everyone_group', null)
    record(op, `group delete ${g.name}`)
  })()
  return { ok: true }
}

export async function setMember(op: Op, groupId: unknown, personId: unknown, member: boolean) {
  requireAdmin(op)
  const g = groupRow(op, groupId), p = personRow(op, personId)
  const db = op.w.db
  db.transaction(() => {
    if (member) db.query('INSERT OR IGNORE INTO memberships (group_id, person_id) VALUES (?, ?)').run(g.id, p.id)
    else db.query('DELETE FROM memberships WHERE group_id = ? AND person_id = ?').run(g.id, p.id)
    record(op, `group member ${g.name} ${member ? '+' : '-'}${p.name}`)
  })()
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

// ---------- folders ----------
export type Template = 'public' | 'team' | 'management' | 'personal' | 'custom'
export type NasMode = 'all' | 'unknown' | 'same-as-ai' | 'chosen'

function nasValue(r: Rights, f: FolderRow, mode: unknown, people: unknown): string {
  switch (mode) {
    case 'all': case 'unknown': return mode
    case 'same-as-ai': {
      const ids = r.db.query<{ id: number }, []>('SELECT id FROM people WHERE active = 1').all().map((p) => p.id)
      const fresh = new Rights(r.db) // after the template's rules were written
      return JSON.stringify(ids.filter((id) => fresh.aiLevel(id, fresh.folders.get(f.id)!) >= 1))
    }
    case 'chosen': {
      if (!Array.isArray(people)) throw bad('bad_nas', 'choose who opens this folder on the NAS')
      const ids = [...new Set(people.map(Number))]
      for (const id of ids) if (!r.db.query('SELECT 1 FROM people WHERE id = ?').get(id)) throw bad('bad_nas', 'unknown person in NAS readers')
      return JSON.stringify(ids)
    }
    default: throw bad('bad_nas', 'NAS readers: all, same-as-ai, chosen or unknown')
  }
}
const nasIncludes = (v: string | null, id: number) => v === 'all' || (!!v && v.startsWith('[') && (JSON.parse(v) as number[]).includes(id))

function upsertRule(op: Op, f: FolderRow, type: 'person' | 'group', id: number, level: number) {
  if (level === 0) op.w.db.query('DELETE FROM rules WHERE folder_id = ? AND subject_type = ? AND subject_id = ?').run(f.id, type, id)
  else op.w.db.query('INSERT INTO rules (folder_id, subject_type, subject_id, level) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET level = excluded.level').run(f.id, type, id, level)
}

export async function registerFolder(op: Op, body: { path?: unknown; name?: unknown; template?: unknown; group?: unknown; owner?: unknown; nas?: { mode?: unknown; people?: unknown }; no_ai?: unknown }) {
  requireAdmin(op)
  const db = op.w.db
  const template = (body.template ?? 'custom') as Template
  if (!['public', 'team', 'management', 'personal', 'custom'].includes(template)) throw bad('bad_template')
  if (typeof body.path !== 'string' || !path.isAbsolute(body.path)) throw bad('bad_path', 'give the folder\'s full path on the server')
  let real: string
  try { real = fs.realpathSync(body.path); if (!fs.statSync(real).isDirectory()) throw new Error() } catch { throw bad('bad_path', 'no folder at that path on the server') }
  const data = fs.realpathSync(op.w.dataDir)
  if (data === real || data.startsWith(real + '/')) throw bad('bad_path', 'that folder holds the server\'s own data directory')
  const name = body.name === undefined || body.name === '' ? undefined : checkName(body.name)
  const r0 = new Rights(db)
  const mountName = nfc(name ?? path.basename(real))
  const existing = [...r0.folders.values()].find((f) => f.path === real && f.registered)
  if (existing) throw new ApiError(409, 'exists', 'this folder is already registered')
  const insideOther = [...r0.folders.values()].some((f) => f.registered && real.startsWith(f.path + '/'))
  if (!insideOther && [...r0.folders.values()].some((f) => f.registered && r0.top(f)?.id === f.id && nfc(f.mount_name ?? '') === mountName))
    throw new ApiError(409, 'name_taken', 'another top folder already has this name; choose a different name')
  const groupId = template === 'team' || template === 'management' ? groupRow(op, body.group).id : template === 'public' ? everyoneGroup(op.w) : null
  const owner = template === 'personal' ? personRow(op, body.owner) : null
  const noAi = template === 'management' ? body.no_ai !== false : body.no_ai === true
  const nasMode = body.nas?.mode ?? (template === 'public' ? 'all' : template === 'team' ? 'same-as-ai' : template === 'personal' ? undefined : 'unknown')

  let f!: FolderRow
  db.transaction(() => {
    try {
      f = storeRegister(db, real, { name, personalOwner: owner?.name, nasReaders: 'unknown' })
    } catch (e) { if (e instanceof StoreError) throw bad('bad_path', e.message); throw e }
    if (owner) db.query('UPDATE folders SET nas_readers = ? WHERE id = ?').run(JSON.stringify([owner.id]), f.id)
    if (groupId != null) upsertRule(op, f, 'group', groupId, LEVELS.read)
    if (noAi) db.query('UPDATE folders SET no_ai = 1 WHERE id = ?').run(f.id)
    if (!owner && nasMode !== undefined) {
      const v = nasValue(new Rights(db), f, nasMode, body.nas?.people)
      db.query('UPDATE folders SET nas_readers = ? WHERE id = ?').run(v, f.id)
    }
    f = db.query<FolderRow, [number]>('SELECT * FROM folders WHERE id = ?').get(f.id)!
    db.query('INSERT INTO folder_history (folder_id, at, by_person, field, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?)')
      .run(f.id, now(), op.actor.personId, 'registered', null, JSON.stringify({ template, nas: f.nas_readers, owner: f.personal_owner }))
    record(op, `folder register ${real} as /${f.mount_name} (${template})`, [new Rights(db).vpath(f) ?? real])
  })()

  const warnings: string[] = []
  const r = new Rights(db)
  // R9: a folder that was someone's personal folder, now registered as a regular one, tells that person
  if (!owner) {
    const former = db.query<{ old_value: string }, [number]>(`SELECT old_value FROM folder_history WHERE folder_id = ? AND field = 'personal_owner' AND old_value IS NOT NULL`).all(f.id)
      .map((h) => Number(h.old_value)).filter((id) => Number.isFinite(id))
    if (former.length) { warnings.push('former_personal'); await tell(op, former, 'former_personal_registered', folderLink(f)) }
    // 5.1: a regular folder that looks like someone's NAS home (Synology "homes", or named after a person)
    const segs = real.split('/').map((s) => s.toLowerCase())
    const named = db.query<{ id: number; name: string }, []>('SELECT id, name FROM people WHERE active = 1').all().filter((p) => p.name.toLowerCase() === path.basename(real).toLowerCase())
    if (segs.includes('homes') || named.length) { warnings.push('looks_like_home'); if (named.length) await tell(op, named.map((p) => p.id), 'home_registered', folderLink(f)) }
  }
  if (r.vpath(f) === null) warnings.push('not_mounted')
  return { id: f.id, warnings }
}

export async function unregisterFolder(op: Op, id: unknown) {
  requireAdmin(op)
  const r = new Rights(op.w.db)
  const f = visibleFolder(op, r, id)
  if (!f.registered) throw bad('not_registered', 'only registered folders can be unregistered')
  const db = op.w.db
  const vp = label(r, f)
  db.transaction(() => {
    if (f.personal_owner != null) db.query('INSERT INTO folder_history (folder_id, at, by_person, field, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?)').run(f.id, now(), op.actor.personId, 'personal_owner', String(f.personal_owner), null)
    db.query('INSERT INTO folder_history (folder_id, at, by_person, field, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?)').run(f.id, now(), op.actor.personId, 'nas_readers', f.nas_readers, null)
    db.query('UPDATE folders SET registered = 0, mount_name = NULL, personal_owner = NULL, nas_readers = NULL WHERE id = ?').run(f.id)
    record(op, `folder unregister ${vp}`, [vp])
  })()
  if (f.personal_owner != null) await tell(op, [f.personal_owner], 'personal_folder_changed', '/#/folders')
  return { ok: true }
}

export async function setOwner(op: Op, id: unknown, body: { owner?: unknown }) {
  requireAdmin(op)
  const r = new Rights(op.w.db)
  const f = visibleFolder(op, r, id)
  if (!f.registered || f.personal_owner == null) throw bad('not_personal', 'only a personal folder has an owner')
  const p = personRow(op, body.owner)
  const db = op.w.db
  db.transaction(() => {
    db.query('INSERT INTO folder_history (folder_id, at, by_person, field, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?)').run(f.id, now(), op.actor.personId, 'personal_owner', String(f.personal_owner), String(p.id))
    db.query('UPDATE folders SET personal_owner = ?, nas_readers = ? WHERE id = ?').run(p.id, JSON.stringify([p.id]), f.id)
    record(op, `folder ${label(r, f)} owner -> ${p.name}`, [label(r, f)])
  })()
  await tell(op, [f.personal_owner, p.id], 'personal_folder_changed', folderLink(f))
  return { ok: true }
}

/** A subfolder of a visible folder (rules and flags attach to it). Walked step by step; links and system names refused. */
export function ensureSubfolder(op: Op, id: unknown, body: { rel?: unknown }) {
  const r = new Rights(op.w.db)
  const f = visibleFolder(op, r, id)
  if (!r.canEditRules(op.actor, f)) throw forbidden()
  if (typeof body.rel !== 'string') throw bad('bad_path')
  const parts = body.rel.split('/').filter(Boolean)
  if (!parts.length || parts.some((p) => p === '.' || p === '..' || isSystemName(p))) throw bad('bad_path', 'give a folder path below this one, like 2026/견적')
  let cur = f.path
  for (const want of parts) {
    let names: string[]
    try { names = fs.readdirSync(cur) } catch { throw bad('bad_path', 'no such folder') }
    const match = names.filter((n) => nfc(n) === nfc(want))
    if (match.length !== 1) throw bad('bad_path', 'no such folder')
    const next = path.join(cur, match[0]!)
    const st = fs.lstatSync(next)
    if (st.isSymbolicLink() || !st.isDirectory()) throw bad('bad_path', 'no such folder (links are not followed)')
    cur = next
  }
  const st = fs.lstatSync(cur, { bigint: true })
  const sub = ensureFolder(op.w.db, cur, st.dev, st.ino)
  return { id: sub }
}

export async function setRule(op: Op, id: unknown, body: { subject_type?: unknown; subject_id?: unknown; level?: unknown }) {
  const db = op.w.db
  const r = new Rights(db)
  const f = visibleFolder(op, r, id)
  if (!r.canEditRules(op.actor, f)) throw forbidden(r.personal(f) ? 'only the owner reads a personal folder' : 'you do not manage this folder')
  const type = body.subject_type === 'group' ? 'group' : body.subject_type === 'person' ? 'person' : null
  if (!type) throw bad('bad_subject')
  const subj = type === 'group' ? groupRow(op, body.subject_id) : personRow(op, body.subject_id)
  const level = typeof body.level === 'string' && body.level in LEVELS ? LEVELS[body.level as LevelName] : typeof body.level === 'boolean' ? (body.level ? 1 : 0) : null
  if (level === null) throw bad('bad_level', 'level: none, read or write')
  const vp = label(r, f)
  db.transaction(() => {
    upsertRule(op, f, type, subj.id, level)
    record(op, `rule ${type === 'group' ? '@' : ''}${subj.name} ${['none', 'read', 'write'][level]}`, [vp])
  })()
  // R7: other manage holders hear of it; R9: an admin putting themselves in a rule tells managers and themselves
  const others = r.managersOf(f).filter((m) => m !== op.actor.personId)
  if (others.length) await tell(op, others, 'rules_changed', folderLink(f))
  const self = op.actor.admin && level >= 1 && (type === 'person' ? subj.id === op.actor.personId : r.groupsOf(op.actor.personId).has(subj.id))
  if (self) await tell(op, [...r.managersOf(f), op.actor.personId], 'self_grant', folderLink(f))
  return { ok: true }
}

export async function setFlags(op: Op, id: unknown, body: { no_ai?: unknown; inherit_break?: unknown; quarantine?: unknown; name?: unknown }) {
  const db = op.w.db
  const r = new Rights(db)
  const f = visibleFolder(op, r, id)
  const vp = label(r, f)
  const changes: [string, number][] = []
  if (typeof body.no_ai === 'boolean') { if (!r.canSetNoAi(op.actor, f, body.no_ai)) throw forbidden(body.no_ai ? 'not allowed' : 'only an admin can turn "no AI" off'); changes.push(['no_ai', body.no_ai ? 1 : 0]) }
  if (typeof body.inherit_break === 'boolean') { if (!r.canEditRules(op.actor, f)) throw forbidden(); if (!f.registered) changes.push(['inherit_break', body.inherit_break ? 1 : 0]) }
  if (typeof body.quarantine === 'boolean') { if (!op.actor.admin) throw forbidden('only an admin can change quarantine'); changes.push(['quarantine', body.quarantine ? 1 : 0]) }
  let rename: string | undefined
  if (body.name !== undefined) { requireAdmin(op); if (!f.registered) throw bad('not_registered'); rename = checkName(body.name) }
  db.transaction(() => {
    for (const [k, v] of changes) {
      if ((f as unknown as Record<string, number>)[k] === v) continue
      db.query(`UPDATE folders SET ${k} = ? WHERE id = ?`).run(v, f.id)
      db.query('INSERT INTO folder_history (folder_id, at, by_person, field, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?)').run(f.id, now(), op.actor.personId, k, String((f as unknown as Record<string, number>)[k]), String(v))
      record(op, `folder ${vp} ${k}=${v}`, [vp])
    }
    if (rename) { db.query('UPDATE folders SET mount_name = ? WHERE id = ?').run(rename, f.id); record(op, `folder ${vp} renamed to ${rename}`, [vp]) }
  })()
  const managers = r.managersOf(f).filter((m) => m !== op.actor.personId)
  if (changes.some(([k, v]) => k === 'no_ai' && v === 0 && f.no_ai)) {
    const owner = r.personal(f)?.personal_owner
    await tell(op, [...r.managersOf(f), op.actor.personId, ...(owner != null ? [owner] : [])], 'no_ai_off', folderLink(f))
  } else if (changes.some(([k, v]) => (f as unknown as Record<string, number>)[k] !== v) && managers.length) await tell(op, managers, 'rules_changed', folderLink(f))
  return { ok: true }
}

export async function setNas(op: Op, id: unknown, body: { mode?: unknown; people?: unknown }) {
  const db = op.w.db
  const r = new Rights(db)
  const f = visibleFolder(op, r, id)
  if (!r.canEditNas(op.actor, f)) throw forbidden(f.personal_owner != null ? 'only the owner sets who opens a personal folder' : 'only an admin changes NAS readers')
  const v = nasValue(r, f, body.mode, body.people)
  const vp = label(r, f)
  db.transaction(() => {
    db.query('INSERT INTO folder_history (folder_id, at, by_person, field, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?)').run(f.id, now(), op.actor.personId, 'nas_readers', f.nas_readers, v)
    db.query('UPDATE folders SET nas_readers = ? WHERE id = ?').run(v, f.id)
    record(op, `folder ${vp} nas_readers ${body.mode}`, [vp])
  })()
  const managers = r.managersOf(f)
  await tell(op, managers.filter((m) => m !== op.actor.personId), 'nas_readers_changed', folderLink(f))
  if (op.actor.admin && nasIncludes(v, op.actor.personId) && !nasIncludes(f.nas_readers, op.actor.personId) && f.personal_owner !== op.actor.personId)
    await tell(op, [...managers, op.actor.personId], 'self_grant', folderLink(f))
  return { ok: true }
}

export async function setManage(op: Op, id: unknown, personId: unknown, on: boolean) {
  requireAdmin(op)
  const db = op.w.db
  const r = new Rights(db)
  const f = visibleFolder(op, r, id)
  if (r.personal(f)) throw bad('personal', 'a personal folder has no managers')
  const p = personRow(op, personId)
  const vp = label(r, f)
  db.transaction(() => {
    if (on) db.query('INSERT OR IGNORE INTO manage_grants (folder_id, person_id) VALUES (?, ?)').run(f.id, p.id)
    else db.query('DELETE FROM manage_grants WHERE folder_id = ? AND person_id = ?').run(f.id, p.id)
    record(op, `manage ${on ? 'grant' : 'revoke'} ${p.name}`, [vp])
  })()
  const managers = r.managersOf(f)
  if (on && p.id === op.actor.personId) await tell(op, [...managers, p.id], 'self_grant', folderLink(f))
  else await tell(op, [...managers.filter((m) => m !== op.actor.personId), p.id], 'manage_changed', folderLink(f))
  return { ok: true }
}

// ---------- tokens (always the caller's own; R9: nobody makes a token for someone else) ----------
const TTL = { '8h': 8 * 3600_000, '1d': 86400_000, '7d': 7 * 86400_000, '30d': 30 * 86400_000, '90d': 90 * 86400_000 } as const

export function createOwnToken(op: Op, body: { name?: unknown; scope?: unknown; read_only?: unknown; ttl?: unknown }) {
  const db = op.w.db
  if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 64 || body.name.includes('/')) throw bad('bad_name', 'give the token a name (where it is used), without /')
  const ttl = typeof body.ttl === 'string' && body.ttl in TTL ? TTL[body.ttl as keyof typeof TTL] : null
  if (ttl === null) throw bad('bad_ttl', 'expiry: 8h, 1d, 7d, 30d or 90d')
  const r = new Rights(db)
  const scope = Array.isArray(body.scope) ? body.scope.map((id) => visibleFolder(op, r, id).path) : []
  const name = nfc(body.name.trim())
  const me = db.query<{ name: string }, [number]>('SELECT name FROM people WHERE id = ?').get(op.actor.personId)!.name
  let t: { id: number; token: string }
  try {
    t = createToken(db, me, { name, scope, readOnly: body.read_only === true, ttlMs: ttl })
  } catch (e) { if (isUnique(e)) throw new ApiError(409, 'exists', 'you already have a token with that name'); if (e instanceof StoreError) throw bad('bad_scope', e.message); throw e }
  record(op, `token create ${name}${scope.length ? ` scope=${scope.length} folders` : ''}${body.read_only === true ? ' read-only' : ''} ttl=${body.ttl}`)
  return t
}

export function revokeOwnToken(op: Op, id: unknown) {
  const db = op.w.db
  const t = db.query<{ id: number; name: string; person_id: number; revoked_at: number | null }, [number]>('SELECT id, name, person_id, revoked_at FROM tokens WHERE id = ?').get(Number(id))
  if (!t || t.person_id !== op.actor.personId) throw notFound()
  db.transaction(() => {
    db.query('UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now(), t.id)
    record(op, `token revoke ${t.name}`)
  })()
  return { ok: true }
}

