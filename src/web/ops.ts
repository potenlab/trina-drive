// Changes made from the web. Each one: find what it is about (404 when the caller may not see it), ask rights.ts
// whether the caller may do it (403), change it in one transaction together with its audit row, then send the
// notices R5/R7/R9 ask for. No permission logic lives in the HTTP handlers.
// This module: registering folders (and their owner, subfolders, NAS readers) and the caller's own tokens. People and
// groups are in people-ops.ts, rules / flags / managers / the Everyone group in src/share/rules.ts (W0 seams).
import fs from 'node:fs'
import path from 'node:path'
import { isSystemName, nfc } from '../names'
import { Rights } from '../rights'
import { createToken, ensureFolder, LEVELS, registerFolder as storeRegister, StoreError, type FolderRow } from '../store'
import { freshLogin } from './auth'
import { ApiError, bad, forbidden, notFound } from './http'
import { ManagedError } from '../managed/core'
import { isManagedFolder, makeMountDir, registerManaged, removeManagedMount } from '../managed/folders'
import { storageSettings } from '../managed/settings'
import { appendAudit } from '../audit'
import { everyoneGroup, upsertRule } from '../share/rules'
import { reauth } from './people-ops'
import { checkName, folderLink, groupRow, isUnique, label, now, personRow, record, requireAdmin, tell, visibleFolder, type Op } from './op-common'

export { visibleFolder, type Op } from './op-common'

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

export async function registerFolder(op: Op, body: { path?: unknown; name?: unknown; template?: unknown; group?: unknown; owner?: unknown; nas?: { mode?: unknown; people?: unknown }; no_ai?: unknown; managed?: unknown; read_only?: unknown }) {
  requireAdmin(op)
  const db = op.w.db
  const template = (body.template ?? 'custom') as Template
  if (!['public', 'team', 'management', 'personal', 'custom'].includes(template)) throw bad('bad_template')
  // managed storage (src/managed): the server makes the folder in its own data area; there is no path and no NAS
  const managed = body.managed === true || (storageSettings(db, op.w.dataDir).mode === 'managed' && (body.path === undefined || body.path === null || body.path === ''))
  if (managed && (typeof body.name !== 'string' || !body.name.trim())) throw bad('bad_name', 'give the team folder a name')
  let real: string
  if (managed) real = ''
  else {
    if (typeof body.path !== 'string' || !path.isAbsolute(body.path)) throw bad('bad_path', 'give the folder\'s full path on the server')
    try { real = fs.realpathSync(body.path); if (!fs.statSync(real).isDirectory()) throw new Error() } catch { throw bad('bad_path', 'no folder at that path on the server') }
    const data = fs.realpathSync(op.w.dataDir)
    if (data === real || data.startsWith(real + '/')) throw bad('bad_path', 'that folder holds the server\'s own data directory')
  }
  const name = body.name === undefined || body.name === '' ? undefined : checkName(body.name)
  const r0 = new Rights(db)
  const mountName = nfc(name ?? path.basename(real))
  const existing = managed ? undefined : [...r0.folders.values()].find((f) => f.path === real && f.registered)
  if (existing) throw new ApiError(409, 'exists', 'this folder is already registered')
  const insideOther = !managed && [...r0.folders.values()].some((f) => f.registered && real.startsWith(f.path + '/'))
  if (!insideOther && [...r0.folders.values()].some((f) => f.registered && r0.top(f)?.id === f.id && nfc(f.mount_name ?? '') === mountName))
    throw new ApiError(409, 'name_taken', 'another top folder already has this name; choose a different name')
  const groupId = template === 'team' || template === 'management' ? groupRow(op, body.group).id : template === 'public' ? everyoneGroup(op.w) : null
  const owner = template === 'personal' ? personRow(op, body.owner) : null
  const noAi = template === 'management' ? body.no_ai !== false : body.no_ai === true
  const nasMode = body.nas?.mode ?? (template === 'public' ? 'all' : template === 'team' ? 'same-as-ai' : template === 'personal' ? undefined : 'unknown')

  let f!: FolderRow
  if (managed) real = makeMountDir(db, op.w.dataDir)
  try { db.transaction(() => {
    try {
      f = managed ? registerManaged(db, real, { name: mountName, personalOwner: owner?.name, by: op.actor.personId })
        : storeRegister(db, real, { name, personalOwner: owner?.name, nasReaders: 'unknown' })
    } catch (e) { if (e instanceof StoreError) throw bad('bad_path', e.message); throw e }
    if (owner && !managed) db.query('UPDATE folders SET nas_readers = ? WHERE id = ?').run(JSON.stringify([owner.id]), f.id)
    // managed team folders: the template's group gets write (people put files in here); read elsewhere (agents' rule)
    if (groupId != null) upsertRule(op, f, 'group', groupId, managed && body.read_only !== true ? LEVELS.write : LEVELS.read)
    if (noAi) db.query('UPDATE folders SET no_ai = 1 WHERE id = ?').run(f.id)
    if (!owner && !managed && nasMode !== undefined) {
      const v = nasValue(new Rights(db), f, nasMode, body.nas?.people)
      db.query('UPDATE folders SET nas_readers = ? WHERE id = ?').run(v, f.id)
    }
    f = db.query<FolderRow, [number]>('SELECT * FROM folders WHERE id = ?').get(f.id)!
    db.query('INSERT INTO folder_history (folder_id, at, by_person, field, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?)')
      .run(f.id, now(), op.actor.personId, 'registered', null, JSON.stringify({ template, nas: f.nas_readers, owner: f.personal_owner }))
    record(op, `folder ${managed ? 'create (managed)' : 'register ' + real} as /${f.mount_name} (${template})`, [new Rights(db).vpath(f) ?? real])
  })() } catch (e) { if (managed) try { fs.rmdirSync(real) } catch {} throw e }

  const warnings: string[] = []
  const r = new Rights(db)
  // R9: a folder that was someone's personal folder, now registered as a regular one, tells that person
  if (!owner && !managed) {
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
  const managed = isManagedFolder(db, f.id)
  db.transaction(() => {
    if (managed) try { removeManagedMount(db, f) } catch (e) { if (e instanceof ManagedError) throw new ApiError(e.status, e.code, e.message); throw e }
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
  const sub = ensureFolder(op.w.db, cur, st.dev, st.ino, st.birthtimeNs)
  return { id: sub }
}

export async function setNas(op: Op, id: unknown, body: { mode?: unknown; people?: unknown }) {
  const db = op.w.db
  const r = new Rights(db)
  const f = visibleFolder(op, r, id)
  if (isManagedFolder(db, f.id)) throw bad('managed', 'managed storage has no NAS: who reads it is set by the rules')
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


// ---------- provenance reset ("출처 초기화", plan 5.1) ----------
/**
 * Clear one of the caller's own tokens' 8-hour provenance window (R3). Needs a fresh login (the password typed within
 * the last 5 minutes; `password` in the body counts). Drafts already written keep their sources (they never shrink).
 * Audited, and the admins (and the person) are told through the notify bus with kind + count + link only (R11).
 */
export async function resetProvenance(op: Op, sessionIdHash: string, id: unknown, body: { password?: unknown }) {
  const db = op.w.db
  const t = db.query<{ id: number; name: string; person_id: number }, [number]>('SELECT id, name, person_id FROM tokens WHERE id = ?').get(Number(id))
  if (!t || t.person_id !== op.actor.personId) throw notFound()
  if (body.password !== undefined) await reauth(op, sessionIdHash, body)
  if (!freshLogin(db, sessionIdHash)) throw new ApiError(403, 'reauth_required', 'type your password again to reset provenance')
  let cleared = 0
  db.transaction(() => {
    cleared = db.query('DELETE FROM touches WHERE token_id = ?').run(t.id).changes
    appendAudit(db, { personId: op.actor.personId, tokenId: t.id, tool: 'web', outcome: 'ok', files: [],
      command: `provenance reset: token ${t.name} (${cleared} folder${cleared === 1 ? '' : 's'} cleared from its 8-hour window; existing drafts keep their sources)` })
  })()
  try { op.w.opts.emit?.({ kind: 'provenance_reset', subjectPersonId: op.actor.personId, tokenId: t.id, detail: { folders: cleared } }) }
  catch (e) { console.error('[notify] provenance_reset emit failed:', e) }
  return { ok: true, cleared }
}
