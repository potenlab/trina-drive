// The share dialog (Trina Cloud v1, workstream A1; plan 3.1–3.7 as changed by §10: O1, findings 1, 8, 11, 12, 13).
//
// Google-Drive-like folder sharing on the existing rules model — no new permission model, no change to policy.ts:
//   Viewer = rule level 1 (read), Editor = level 2 (write), Manager = level 2 + manage (R7) — "Manager = level 2 +
//   manage" is how the dialog shows it; the data stays as it is (a manager without level 2 shows as such, never raised).
//   General access "Anyone in Trina" = a rule for the Everyone group; Restricted = none here and none from above.
//   "Restrict access here" = inherit_break, writing the kept entries' CURRENT levels here first (finding 12).
// Who may change what (O1, the owner's decision; review finding 8):
//   admin    everything here (Manager grants, No AI off, restrict-here, the Editors toggle, inviting non-members)
//   manager  Viewers / Editors, General access, restrict-here, No AI on, the Editors toggle; not Manager, not No AI off
//   editor   (where "Editors can change permissions and share" is on here and above) Viewers / Editors and General
//            access; removing direct entries; No AI on. Not Manager, not restrict-here, not the toggle, not No AI off,
//            not inviting, never confirming a widening. Opening the folder to the whole team needs a passkey step-up.
//   agents   never: /api reads no Bearer token, MCP has no sharing tool, WebDAV has no ACL (test/share-agents.test.ts).
// Every change: one transaction with its audit row, folder_history for flags, and the R6 re-check of AI-draft copies
// (./rejudge.ts). A change that would widen copies: managers / admins send `confirm_widening` (copies close until a
// source manager confirms, or are confirmed at once when the actor manages every source); an Editor's request waits
// for a source manager's approval in the approval inbox (./approvals.ts). Hidden == nonexistent: a path you cannot see
// answers exactly like one that does not exist.
import crypto from 'node:crypto'
import fs from 'node:fs'
import type { DB } from '../db'
import { inManaged, managedMountIds } from '../managed/core'
import { nfc, splitVirtual } from '../names'
import { Access, type Node } from '../policy'
import { Rights, type Actor } from '../rights'
import { ensureFolder, sha256, type FolderRow } from '../store'
import { pkConfig } from '../web/approve'
import { ApiError, bad, json, notFound, type WebCtx } from '../web/http'
import {
  consumeStepUp, issueStepUp, MfaError, passkeyAssertionOptions, passkeysOf, passkeyVerify, stepUpChallengeBinding, totpEnabled, totpVerify, type StepUpBinding,
} from '../web/mfa'
import { notify } from '../web/notices'
import { folderLink, now, record, tell, type Op } from '../web/op-common'
import { metaGet } from '../web/schema'
import type { Role, ShareEntry, ShareView, SubjectRef } from './api-types'
import { createShareApproval } from './approvals'
import { inviteHandler } from './invite'
import { copiesUnder, notifyWidened, withRejudge, type Judgement } from './rejudge'
import { everyoneGroup } from './rules'
import { isSkillLibrary } from '../skills/core'

export type Kind = 'admin' | 'manager' | 'editor' | 'none'
const ROLE_LEVEL: Record<Role, number> = { viewer: 1, editor: 2, manager: 2 }
const roleOf = (level: number): 'viewer' | 'editor' | null => level >= 2 ? 'editor' : level >= 1 ? 'viewer' : null
type FolderX = FolderRow & { editors_can_share?: number | null }

const err = (status: number, code: string, message: string) => new ApiError(status, code, message)

/** The Everyone group's id without creating it (reads never write). */
export function everyoneId(db: DB): number | null {
  const v = metaGet(db, 'everyone_group')
  if (v && db.query('SELECT 1 FROM groups WHERE id = ?').get(Number(v))) return Number(v)
  return db.query<{ id: number }, []>(`SELECT id FROM groups WHERE name IN ('everyone', '전체', '전원') ORDER BY id LIMIT 1`).get()?.id ?? null
}

export function kindOf(r: Rights, a: Actor, f: FolderRow): Kind {
  if (!r.top(f) || r.personal(f)) return 'none'
  if (a.admin) return 'admin'
  if (r.manages(a.personId, f)) return 'manager'
  return r.canShare(a, f) ? 'editor' : 'none'
}

// ---------- finding the folder (hidden == nonexistent) ----------
export interface Item { f: FolderRow; node: Node; access: Access; r: Rights; vpath: string; managed: boolean; readable: boolean }

/**
 * The folder at a virtual path as this person may see it: a folder they can read or see as a path to something below,
 * one they manage, or — for the admin — any folder. Anything else, and anything that does not exist, is the same 404.
 * A visible file answers 400 (folders only in this version).
 */
export function resolveFolder(w: WebCtx, a: Actor, vpath: unknown): Item {
  if (typeof vpath !== 'string' || vpath.length > 4096 || vpath.includes('\0')) throw notFound()
  const parts = splitVirtual(vpath)
  if (!parts.length) throw notFound()
  const db = w.db
  const access = Access.forPerson(db, a.personId)
  const mount = access.mounts().get(nfc(parts[0]!))
  let node = mount ? access.mountNode(mount) : null
  if (!node) throw notFound()
  for (let i = 1; i < parts.length; i++) {
    let names: string[]
    try { names = fs.readdirSync(node.real) } catch { throw notFound() }
    const m = names.filter((n) => nfc(n) === nfc(parts[i]!))
    if (m.length !== 1) throw notFound()
    const e = access.child(node, m[0]!)
    if (!e) throw notFound()
    if (e.kind === 'file') {
      if (i === parts.length - 1 && access.canRead(node)) throw bad('folders_only', 'only folders can be shared in this version')
      throw notFound()
    }
    node = e.node
  }
  const rights0 = new Rights(db)
  const deepest = node.rows.length ? rights0.folders.get(node.rows[node.rows.length - 1]!.id) : undefined
  const visible = a.admin || access.visible(node) || (!!deepest && rights0.manages(a.personId, deepest))
  if (!visible || node.rows.some((x) => x.personal_owner != null && x.personal_owner !== a.personId && !a.admin)) throw notFound()
  const id = ensureFolder(db, node.real, node.dev, node.ino, node.birth)
  const r = new Rights(db)
  return { f: r.folders.get(id)!, node, access, r, vpath: node.vpath, managed: inManaged(managedMountIds(db), node), readable: access.canRead(node) }
}

// ---------- levels ----------
/** The level a subject gets on f from folders ABOVE f (up to the nearest break): what removing f's own rule leaves. */
function aboveLevel(r: Rights, f: FolderRow, type: 'person' | 'group', id: number): { level: number; from: number | null } {
  if (f.registered || f.inherit_break) return { level: 0, from: null }
  const chain = r.chain(f).filter((x) => x.id !== f.id)
  let best = 0, from: number | null = null
  for (let i = chain.length - 1; i >= 0; i--) {
    const row = chain[i]!
    for (const rule of r.rules.get(row.id) ?? []) if (rule.subject_type === type && rule.subject_id === id && rule.level > best) { best = rule.level; from = row.id }
    if (row.registered || row.inherit_break) break
  }
  return { level: best, from }
}
const ownLevel = (r: Rights, f: FolderRow, type: 'person' | 'group', id: number) =>
  r.rules.get(f.id)?.find((x) => x.subject_type === type && x.subject_id === id)?.level ?? 0
/** Where a manager's grant comes from (the nearest folder at or above f holding it). */
function managerFrom(r: Rights, f: FolderRow, pid: number): number | null {
  const chain = r.chain(f)
  for (let i = chain.length - 1; i >= 0; i--) if (r.directManagers(chain[i]!).includes(pid)) return chain[i]!.id
  return null
}

// ---------- the view ----------
const personName = (db: DB, id: number) => db.query<{ name: string }, [number]>('SELECT name FROM people WHERE id = ?').get(id)?.name ?? '?'
const groupInfo = (db: DB, id: number) => db.query<{ name: string; n: number }, [number]>(
  'SELECT g.name, (SELECT count(*) FROM memberships m JOIN people p ON p.id = m.person_id WHERE m.group_id = g.id AND p.active = 1) AS n FROM groups g WHERE g.id = ?').get(id)
const emailOf = (db: DB, id: number) => {
  try { return db.query<{ email: string | null }, [number]>('SELECT email FROM accounts WHERE person_id = ?').get(id)?.email ?? undefined } catch { return undefined }
}

function entriesOf(db: DB, r: Rights, f: FolderRow, a: Actor, kind: Kind, E: number | null): ShareEntry[] {
  const subjects = new Map<string, { type: 'person' | 'group'; id: number }>()
  const chain = r.chain(f)
  for (let i = chain.length - 1; i >= 0; i--) {
    const row = chain[i]!
    for (const rule of r.rules.get(row.id) ?? []) if (rule.level > 0) subjects.set(`${rule.subject_type}:${rule.subject_id}`, { type: rule.subject_type, id: rule.subject_id })
    if (row.registered || row.inherit_break) break
  }
  const active = new Set(db.query<{ id: number }, []>('SELECT id FROM people WHERE active = 1').all().map((p) => p.id))
  const vp = (id: number | null) => { const x = id == null ? undefined : r.folders.get(id); return x ? r.vpath(x) ?? undefined : undefined }
  const out = new Map<string, ShareEntry>()
  const sharer = kind !== 'none'
  for (const s of subjects.values()) {
    if (s.type === 'group' && s.id === E) continue
    if (s.type === 'person' && !active.has(s.id)) continue
    const lv = r.subjectLevel(s.type, s.id, f)
    const role = roleOf(lv.level)
    if (!role) continue
    const direct = lv.from === f.id
    const g = s.type === 'group' ? groupInfo(db, s.id) : null
    if (s.type === 'group' && !g) continue
    out.set(`${s.type}:${s.id}`, {
      subject: { type: s.type, id: s.id, name: g ? g.name : personName(db, s.id), ...(g ? { members: g.n } : {}), ...(s.type === 'person' && a.admin ? { email: emailOf(db, s.id) } : {}) },
      role, source: direct ? 'direct' : 'inherited', ...(direct ? {} : { from_path: vp(lv.from) }), editable: sharer && direct,
    })
  }
  const directMgr = new Set(r.directManagers(f))
  for (const pid of r.managersOf(f)) {
    if (!active.has(pid)) continue
    const level = r.aiLevel(pid, f)
    const direct = directMgr.has(pid)
    out.set(`person:${pid}`, {
      subject: { type: 'person', id: pid, name: personName(db, pid), ...(a.admin ? { email: emailOf(db, pid) } : {}) },
      role: 'manager', source: direct ? 'direct' : 'inherited', ...(direct ? {} : { from_path: vp(managerFrom(r, f, pid)) }),
      ...(level < 1 ? { note: 'cannot_open' as const } : level < 2 ? { note: 'viewer' as const } : {}),
      editable: kind === 'admin' && direct,
    })
  }
  const order = { manager: 0, editor: 1, viewer: 2 }
  return [...out.values()].sort((x, y) => order[x.role] - order[y.role] || x.subject.type.localeCompare(y.subject.type) || x.subject.name.localeCompare(y.subject.name))
}

export function shareView(w: WebCtx, a: Actor, vpath: unknown): ShareView | { mode: 'inplace'; item: ShareView['item'] } {
  const it = resolveFolder(w, a, vpath)
  const { f, r } = it
  const name = it.vpath.slice(it.vpath.lastIndexOf('/') + 1)
  const item = { path: it.vpath, kind: 'folder' as const, name, id: f.id }
  if (!it.managed) return { mode: 'inplace', item }
  return buildView(w.db, a, it, item)
}

function buildView(db: DB, a: Actor, it: Item, item: ShareView['item']): ShareView {
  const { f, r } = it
  const kind = kindOf(r, a, f)
  const E = everyoneId(db)
  const full = kind === 'admin' || kind === 'manager' || it.readable
  let entries = entriesOf(db, r, f, a, kind, E)
  if (!full) {
    const mine = r.groupsOf(a.personId)
    entries = entries.filter((e) => (e.subject.type === 'person' && e.subject.id === a.personId) || (e.subject.type === 'group' && mine.has(e.subject.id)))
  }
  const level = r.aiLevel(a.personId, f)
  const myRole: ShareView['my_role'] = r.manages(a.personId, f) ? 'manager' : roleOf(level) ?? (a.admin ? 'admin' : null)
  const eff = E == null ? { level: 0, from: null } : r.subjectLevel('group', E, f)
  const own = E == null ? 0 : ownLevel(r, f, 'group', E)
  const chain = r.chain(f)
  const offAbove = chain.some((x) => x.id !== f.id && (x as FolderX).editors_can_share === 0)
  const ownToggle = (f as FolderX).editors_can_share
  const noAiRow = chain.find((x) => x.no_ai)
  const warnings: ShareView['warnings'] = []
  if (kind !== 'none') {
    const c = copiesUnder(db, f.path)
    if (c.count) warnings.push({ code: 'draft_copies', count: c.count })
    const cannot = entries.filter((e) => e.note === 'cannot_open').length
    if (cannot) warnings.push({ code: 'manager_cannot_open', count: cannot })
  }
  if (offAbove) warnings.push({ code: 'editors_off_above' })
  const fromVp = (id: number | null) => { const x = id == null ? undefined : r.folders.get(id); return (x && r.vpath(x)) || item.path }
  return {
    mode: 'managed', item, my_role: myRole,
    can_share: kind !== 'none', can_manage: kind === 'admin' || kind === 'manager', can_grant_manager: kind === 'admin',
    can_ai_off: kind !== 'none' && r.canSetNoAi(a, f, false), can_restrict_here: (kind === 'admin' || kind === 'manager') && !f.registered,
    can_toggle_editors: kind === 'admin' || kind === 'manager', can_invite: kind === 'admin' && !!inviteHandler(db), full_list: full,
    general: {
      effective: roleOf(eff.level) ? { role: roleOf(eff.level)!, from_path: fromVp(eff.from) } : null,
      own: roleOf(own), restricted_here: !!f.inherit_break && !f.registered, editor_step_up: kind === 'editor',
    },
    editors_can_share: { effective: r.editorsCanShare(f), own: ownToggle == null ? null : ownToggle === 1, off_above: offAbove },
    entries,
    ai: { no_ai: !!noAiRow, ...(noAiRow && noAiRow.id !== f.id ? { inherited_no_ai_from: r.vpath(noAiRow) ?? undefined } : {}) },
    path_names_visible: true, warnings,
  }
}

// ---------- changing ----------
export type Step =
  | { k: 'rule'; type: 'person' | 'group'; id: number; name: string; level: number; prev: number }
  | { k: 'manager'; pid: number; name: string; on: boolean; level: number }
  | { k: 'general'; E: number | null; level: number; prev: number }
  | { k: 'restrict'; on: boolean; keep: { type: 'person' | 'group'; id: number; name: string; level: number }[]; managers: { pid: number; level: number }[]; drop: number }
  | { k: 'no_ai'; on: boolean }
  | { k: 'editors'; on: boolean }

export interface Planned { steps: Step[]; invites: { email: string; role: 'viewer' | 'editor' }[]; stepUp: { general: { mode: string; role?: string } } | null }

const isRef = (x: unknown): x is SubjectRef => !!x && typeof x === 'object' && ((x as SubjectRef).type === 'person' || (x as SubjectRef).type === 'group') && Number.isSafeInteger((x as SubjectRef).id)

function subjectOf(db: DB, ref: SubjectRef): { type: 'person' | 'group'; id: number; name: string } {
  if (ref.type === 'person') {
    const p = db.query<{ id: number; name: string; active: number }, [number]>('SELECT id, name, active FROM people WHERE id = ?').get(ref.id)
    if (!p) throw bad('unknown_subject', 'no such person')
    if (!p.active) throw bad('inactive', `${p.name} is not active in this team`)
    return { type: 'person', id: p.id, name: p.name }
  }
  const g = db.query<{ id: number; name: string }, [number]>('SELECT id, name FROM groups WHERE id = ?').get(ref.id)
  if (!g) throw bad('unknown_subject', 'no such group')
  return { type: 'group', id: g.id, name: g.name }
}

const normGeneral = (g: unknown): { mode: 'restricted' } | { mode: 'team'; role: 'viewer' | 'editor' } | null => {
  if (!g || typeof g !== 'object') return null
  const x = g as { mode?: unknown; role?: unknown }
  if (x.mode === 'restricted') return { mode: 'restricted' }
  if (x.mode === 'team' && (x.role === 'viewer' || x.role === 'editor')) return { mode: 'team', role: x.role }
  throw bad('bad_general', "general: { mode: 'restricted' } or { mode: 'team', role: 'viewer' | 'editor' }")
}

/**
 * Turn a request into steps, checking who may do each (403 with a code naming what is missing; 400 for requests that
 * cannot be done here). Nothing is written. `approval`: replaying an approved Editor request (no step-up again).
 */
export function planChange(db: DB, r: Rights, f: FolderRow, a: Actor, kind: Kind, body: Record<string, unknown>, opts: { approval?: boolean } = {}): Planned {
  if (kind === 'none') throw err(403, r.aiLevel(a.personId, f) >= 2 && !r.editorsCanShare(f) ? 'editors_cannot_share' : 'not_manager',
    r.aiLevel(a.personId, f) >= 2 && !r.editorsCanShare(f) ? 'Editors cannot change sharing on this folder (a manager turned it off)' : 'you cannot change sharing on this folder')
  const mgr = kind === 'admin' || kind === 'manager'
  const steps: Step[] = []
  const invites: Planned['invites'] = []
  const E = everyoneId(db)
  const managers = new Set(r.managersOf(f))
  const directManagers = new Set(r.directManagers(f))
  const seen = new Set<string>()
  let general = normGeneral(body.general)

  const wantRole = (role: unknown, allowRemove: boolean): Role | 'remove' => {
    if (role === 'viewer' || role === 'editor' || role === 'manager' || (allowRemove && role === 'remove')) return role
    throw bad('bad_role', `role: viewer, editor, manager${allowRemove ? ' or remove' : ''}`)
  }
  const roleStep = (s: { type: 'person' | 'group'; id: number; name: string }, role: Role | 'remove') => {
    const key = `${s.type}:${s.id}`
    if (seen.has(key)) throw bad('duplicate', `${s.name} appears twice in this change`)
    seen.add(key)
    if (s.type === 'group' && s.id === E) { // the Everyone group is General access
      if (role === 'manager') throw bad('group_manager', 'only people can be managers')
      if (general) throw bad('duplicate', 'General access appears twice in this change')
      general = role === 'remove' ? { mode: 'restricted' } : { mode: 'team', role }
      return
    }
    const isMgr = s.type === 'person' && managers.has(s.id)
    if (role === 'manager') {
      if (s.type === 'group') throw bad('group_manager', 'only people can be managers (a group cannot hold manage)')
      if (kind !== 'admin') throw err(403, 'admin_only', 'only an admin makes someone a manager')
      if (r.personal(f)) throw bad('personal', 'a personal folder has no managers')
      if (!directManagers.has(s.id)) steps.push({ k: 'manager', pid: s.id, name: s.name, on: true, level: Math.max(2, ownLevel(r, f, 'person', s.id)) })
      return
    }
    if (isMgr) {
      if (!directManagers.has(s.id)) throw err(400, 'inherited', `${s.name} manages a folder above; change it there`)
      if (kind !== 'admin') throw err(403, 'admin_only', 'only an admin changes a manager')
      steps.push({ k: 'manager', pid: s.id, name: s.name, on: false, level: role === 'remove' ? 0 : ROLE_LEVEL[role] })
      return
    }
    const above = aboveLevel(r, f, s.type, s.id)
    const own = ownLevel(r, f, s.type, s.id)
    const level = role === 'remove' ? 0 : ROLE_LEVEL[role]
    if (role === 'remove' && own === 0) throw err(400, 'inherited', `${s.name} has access from a folder above; change it there, or restrict access here`)
    if (role !== 'remove' && level < above.level) throw err(400, 'inherited', `${s.name} is ${roleOf(above.level)} from a folder above; change it there, or restrict access here`)
    if (level !== own) steps.push({ k: 'rule', type: s.type, id: s.id, name: s.name, level, prev: own })
  }

  if (body.add !== undefined) {
    if (!Array.isArray(body.add) || body.add.length > 100) throw bad('bad_add', 'add: a list of { subject, role } (at most 100)')
    for (const x of body.add as { subject?: unknown; role?: unknown }[]) {
      const role = wantRole(x?.role, false) as Role
      const sub = x?.subject as { email?: unknown } | undefined
      if (sub && typeof sub === 'object' && 'email' in sub) {
        if (kind !== 'admin') throw err(403, 'invite_admin_only', 'only an admin shares with someone outside the team (an invitation)')
        const email = typeof sub.email === 'string' ? sub.email.trim() : ''
        if (!/^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) throw bad('bad_email', 'a valid mail address is required')
        const known = db.query<{ person_id: number; active: number }, [string]>('SELECT a.person_id, p.active FROM accounts a JOIN people p ON p.id = a.person_id WHERE lower(a.email) = lower(?)').get(email)
        if (known?.active) { roleStep(subjectOf(db, { type: 'person', id: known.person_id }), role); continue }
        if (role === 'manager') throw bad('invite_role', 'someone new joins as a viewer or an editor; make them a manager after they join')
        if (!inviteHandler(db)) throw err(409, 'invites_unavailable', 'this server cannot invite people by mail; add them as people first')
        invites.push({ email, role: role as 'viewer' | 'editor' })
        continue
      }
      if (!isRef(sub)) throw bad('bad_subject', 'subject: { type: person | group, id } or { email }')
      roleStep(subjectOf(db, sub), role)
    }
  }
  if (body.set !== undefined) {
    if (!Array.isArray(body.set) || body.set.length > 100) throw bad('bad_set', 'set: a list of { subject, role } (at most 100)')
    for (const x of body.set as { subject?: unknown; role?: unknown }[]) {
      if (!isRef(x?.subject)) throw bad('bad_subject', 'subject: { type: person | group, id }')
      roleStep(subjectOf(db, x.subject), wantRole(x.role, true))
    }
  }
  let stepUp: Planned['stepUp'] = null
  if (general) {
    const above = E == null ? { level: 0, from: null } : aboveLevel(r, f, 'group', E)
    const own = E == null ? 0 : ownLevel(r, f, 'group', E)
    const level = general.mode === 'team' ? ROLE_LEVEL[general.role] : 0
    if (level < above.level) throw err(400, 'inherited_general', `Anyone in Trina has access from a folder above${general.mode === 'restricted' ? '; restrict access here to stop that' : ''}`)
    if (level !== own) steps.push({ k: 'general', E, level, prev: own })
    // an Editor opening the folder wider to the whole team proves it is a person (passkey), not a script with their session
    if (kind === 'editor' && Math.max(level, above.level) > Math.max(own, above.level) && !opts.approval) stepUp = { general }
  }
  if (body.restrict_here !== undefined) {
    const rh = body.restrict_here as { on?: unknown; keep?: unknown }
    if (!rh || typeof rh.on !== 'boolean') throw bad('bad_restrict', 'restrict_here: { on: boolean, keep: [{ type, id }] }')
    if (!mgr) throw err(403, 'manager_only', 'only a manager or an admin restricts access here')
    if (f.registered) throw bad('top_folder', 'a team folder takes nothing from above; there is nothing to restrict')
    if (rh.on && !f.inherit_break) {
      const keepRefs = rh.keep === undefined ? [] : Array.isArray(rh.keep) && rh.keep.every(isRef) ? rh.keep as SubjectRef[] : null
      if (!keepRefs) throw bad('bad_keep', 'keep: [{ type, id }]')
      // what comes from above now (not managers: they always stay); kept entries keep their current level (finding 12)
      const inherited = entriesOf(db, r, f, { personId: -1, admin: true }, 'admin', E)
        .filter((e) => e.role !== 'manager' && e.source === 'inherited')
      const everyoneAbove = E == null ? 0 : aboveLevel(r, f, 'group', E).level
      const candidates = [...inherited.map((e) => ({ type: e.subject.type, id: e.subject.id, name: e.subject.name })),
        ...(everyoneAbove > 0 && E != null && ownLevel(r, f, 'group', E) === 0 ? [{ type: 'group' as const, id: E, name: 'Anyone in Trina' }] : [])]
      const keep: Extract<Step, { k: 'restrict' }>['keep'] = []
      for (const k of keepRefs) {
        const c = candidates.find((x) => x.type === k.type && x.id === k.id)
        if (!c) throw bad('bad_keep', 'keep only lists entries that come from above')
        keep.push({ ...c, level: r.subjectLevel(c.type, c.id, f).level })
      }
      // managers from above always keep opening this folder: at their CURRENT level (0 = shown, never raised)
      const mgrs = r.managersOf(f).map((pid) => ({ pid, level: r.aiLevel(pid, f) })).filter((m) => m.level > ownLevel(r, f, 'person', m.pid))
      steps.push({ k: 'restrict', on: true, keep, managers: mgrs, drop: candidates.length - keep.length })
    } else if (!rh.on && f.inherit_break) steps.push({ k: 'restrict', on: false, keep: [], managers: [], drop: 0 })
  }
  if (body.ai_access !== undefined) {
    if (typeof body.ai_access !== 'boolean') throw bad('bad_ai', 'ai_access: true or false')
    const on = !body.ai_access
    if (!on) {
      if (!f.no_ai && r.chain(f).some((x) => x.no_ai)) throw err(400, 'inherited_no_ai', '"No AI" is on for a folder above; it is turned off there')
      if (!r.canSetNoAi(a, f, false)) throw err(403, 'admin_only', 'only an admin turns "No AI" off')
    }
    if (!!f.no_ai !== on) steps.push({ k: 'no_ai', on })
  }
  if (body.editors_can_share !== undefined) {
    if (typeof body.editors_can_share !== 'boolean') throw bad('bad_toggle', 'editors_can_share: true or false')
    if (!mgr) throw err(403, 'manager_only', 'only a manager or an admin changes whether Editors can share')
    // a skill library (src/skills) keeps it off: whoever widens a library's readers decides whose AI gets its instructions
    if (body.editors_can_share && isSkillLibrary(db, f.id)) throw err(409, 'skill_library', 'this folder is a skill library: Editors never change its sharing')
    const cur = (f as FolderX).editors_can_share
    if (cur !== (body.editors_can_share ? 1 : 0)) steps.push({ k: 'editors', on: body.editors_can_share })
  }
  return { steps, invites, stepUp }
}

const upsert = (db: DB, f: FolderRow, type: 'person' | 'group', id: number, level: number, by: number) => {
  if (level === 0) db.query('DELETE FROM rules WHERE folder_id = ? AND subject_type = ? AND subject_id = ?').run(f.id, type, id)
  else db.query(`INSERT INTO rules (folder_id, subject_type, subject_id, level, granted_by, granted_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT DO UPDATE SET level = excluded.level, granted_by = excluded.granted_by, granted_at = excluded.granted_at`).run(f.id, type, id, level, by, now())
}
const history = (db: DB, f: FolderRow, by: number, field: string, old: unknown, value: unknown) =>
  db.query('INSERT INTO folder_history (folder_id, at, by_person, field, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?)').run(f.id, now(), by, field, old == null ? null : String(old), value == null ? null : String(value))
const roleName = (level: number) => level >= 2 ? 'editor' : level >= 1 ? 'viewer' : 'none'

/** Write the steps (inside the caller's transaction). Returns the audit words. `by` = the person whose change it is. */
export function applySteps(db: DB, f: FolderRow, steps: Step[], by: number): string[] {
  const words: string[] = []
  for (const s of steps) {
    switch (s.k) {
      case 'rule':
        upsert(db, f, s.type, s.id, s.level, by)
        words.push(`${s.type === 'group' ? '@' : ''}${s.type}:${s.id} ${roleName(s.prev)}→${roleName(s.level)}`)
        break
      case 'manager':
        if (s.on) {
          db.query('INSERT OR IGNORE INTO manage_grants (folder_id, person_id, granted_by, granted_at) VALUES (?, ?, ?, ?)').run(f.id, s.pid, by, now())
          upsert(db, f, 'person', s.pid, s.level, by)
          words.push(`person:${s.pid} →manager`)
        } else {
          db.query('DELETE FROM manage_grants WHERE folder_id = ? AND person_id = ?').run(f.id, s.pid)
          upsert(db, f, 'person', s.pid, s.level, by)
          words.push(`person:${s.pid} manager→${roleName(s.level)}`)
        }
        break
      case 'general': {
        const E = s.E ?? (s.level > 0 ? everyoneGroup({ db } as WebCtx) : null)
        if (E != null) upsert(db, f, 'group', E, s.level, by)
        words.push(`general ${s.level ? `team:${roleName(s.level)}` : 'restricted'}`)
        break
      }
      case 'restrict':
        if (s.on) {
          for (const k of s.keep) if (k.level > 0) upsert(db, f, k.type, k.id, k.level, by)
          for (const m of s.managers) if (m.level > 0) upsert(db, f, 'person', m.pid, m.level, by)
          db.query('UPDATE folders SET inherit_break = 1 WHERE id = ?').run(f.id)
          history(db, f, by, 'inherit_break', f.inherit_break, 1)
          words.push(`restrict-here keep=${s.keep.length} drop=${s.drop}`)
        } else {
          db.query('UPDATE folders SET inherit_break = 0 WHERE id = ?').run(f.id)
          history(db, f, by, 'inherit_break', f.inherit_break, 0)
          words.push('restrict-here off')
        }
        break
      case 'no_ai':
        db.query('UPDATE folders SET no_ai = ? WHERE id = ?').run(s.on ? 1 : 0, f.id)
        history(db, f, by, 'no_ai', f.no_ai, s.on ? 1 : 0)
        words.push(`no_ai ${s.on ? 'on' : 'off'}`)
        break
      case 'editors':
        db.query('UPDATE folders SET editors_can_share = ? WHERE id = ?').run(s.on ? 1 : 0, f.id)
        history(db, f, by, 'editors_can_share', (f as FolderX).editors_can_share, s.on ? 1 : 0)
        words.push(`editors_can_share ${s.on ? 'on' : 'off'}`)
        break
    }
  }
  return words
}

/** People who could not open f before and can now (they hear "shared with you"; groups: their members). */
export function newReaders(db: DB, before: Rights, f: FolderRow, exclude: number): number[] {
  const after = new Rights(db)
  const g = after.folders.get(f.id)!
  return db.query<{ id: number }, []>('SELECT id FROM people WHERE active = 1').all().map((p) => p.id)
    .filter((id) => id !== exclude && before.aiLevel(id, f) < 1 && !before.manages(id, f) && (after.aiLevel(id, g) >= 1 || after.manages(id, g)))
}

class Widening extends Error { constructor(readonly j: Judgement) { super('widening') } }

function refusal(db: DB, a: Actor, kind: Kind, j: Judgement) {
  const access = Access.forPerson(db, a.personId)
  const shown: string[] = []
  let hidden = 0
  for (const s of j.sources) { const n = access.nodeForFolder(s); if (n && access.canRead(n)) shown.push(n.vpath); else hidden++ }
  const mgr = kind === 'admin' || kind === 'manager'
  return json({
    error: 'widening', code: 'widening',
    message: mgr ? 'AI-draft copies in this folder would reach people who cannot read their sources; send again with confirm_widening to go ahead'
      : 'AI-draft copies in this folder would reach people who cannot read their sources; a manager of those sources has to approve (send again with confirm_widening to ask)',
    count: j.copies.length, people: j.people.size, sources: shown.sort(), sources_hidden: hidden, can_confirm: mgr, needs_approval: !mgr,
  }, 409)
}

// ---------- step-up (an Editor opening a folder to the whole team) ----------
const stepSha = (folderId: number, general: unknown) => 'share-' + sha256(JSON.stringify({ folder: folderId, general }))
const binding = (sessionHash: string, a: Actor, folderId: number, general: unknown): StepUpBinding =>
  ({ sessionHash, personId: a.personId, approvalId: 0, sha256: stepSha(folderId, general) })

function stepUpMethod(w: WebCtx, personId: number): { method: 'passkey' | 'totp' | null; missing: 'passkey' | 'totp' | null } {
  const cfg = pkConfig(w)
  if (cfg) return passkeysOf(w.db, personId).some((p) => p.rp_id === cfg.rpId) ? { method: 'passkey', missing: null } : { method: null, missing: 'passkey' }
  return totpEnabled(w.db, personId) ? { method: 'totp', missing: null } : { method: null, missing: 'totp' }
}

export async function shareStepUpOptions(op: Op, sessionHash: string, body: { path?: unknown; general?: unknown }) {
  const it = resolveFolder(op.w, op.actor, body.path)
  if (kindOf(it.r, op.actor, it.f) === 'none') throw err(403, 'not_manager', 'you cannot change sharing on this folder')
  const general = normGeneral(body.general)
  if (!general || general.mode !== 'team') throw bad('bad_general', "the step-up is for { mode: 'team', role }")
  const m = stepUpMethod(op.w, op.actor.personId)
  if (!m.method) throw err(409, m.missing === 'passkey' ? 'passkey_required' : 'totp_required',
    m.missing === 'passkey' ? 'opening a folder to the whole team needs a passkey on this server: add one in Settings' : 'opening a folder to the whole team needs an authenticator app: set one up in Settings')
  if (m.method === 'totp') return { method: 'totp' }
  return { method: 'passkey', options: await passkeyAssertionOptions(op.w.db, pkConfig(op.w)!, op.actor.personId, 'stepup', stepUpChallengeBinding(binding(sessionHash, op.actor, it.f.id, general))) }
}

export async function shareStepUp(op: Op, sessionHash: string, body: { path?: unknown; general?: unknown; response?: unknown; code?: unknown }) {
  const { w, actor } = op
  const key = `stepup:${actor.personId}`
  if (w.loginByName.blocked(key)) throw new ApiError(429, 'rate_limited', 'too many tries; wait a few minutes', { 'retry-after': String(w.loginByName.retryAfter(key)) })
  const it = resolveFolder(w, actor, body.path)
  if (kindOf(it.r, actor, it.f) === 'none') throw err(403, 'not_manager', 'you cannot change sharing on this folder')
  const general = normGeneral(body.general)
  if (!general || general.mode !== 'team') throw bad('bad_general', "the step-up is for { mode: 'team', role }")
  const b = binding(sessionHash, actor, it.f.id, general)
  const m = stepUpMethod(w, actor.personId)
  try {
    if (m.method === 'passkey' && body.response !== undefined) await passkeyVerify(w.db, pkConfig(w)!, actor.personId, 'stepup', stepUpChallengeBinding(b), body.response)
    else if (m.method === 'totp' && body.code !== undefined) { if (!totpVerify(w.db, actor.personId, body.code)) throw new MfaError('bad_code', 'that code is not right', 401) }
    else throw new MfaError(m.method ? 'bad_input' : 'step_up_unavailable', m.method === 'passkey' ? 'send the passkey response' : m.method === 'totp' ? 'send the code from your authenticator app' : 'no second factor is set up', 400)
  } catch (e) {
    w.loginByName.hit(key)
    if (e instanceof MfaError) throw new ApiError(e.status, e.code, e.message)
    throw e
  }
  w.loginByName.reset(key)
  return issueStepUp(w.db, b, m.method!)
}

// ---------- POST /api/share ----------
export async function changeShare(op: Op, sessionHash: string, body: Record<string, unknown>): Promise<unknown> {
  const { w, actor: a } = op
  const db = w.db
  const it = resolveFolder(w, a, body.path)
  if (!it.managed) throw bad('inplace', 'this folder is on the NAS (in place): who reads it is set on its folder page')
  const { f, r } = it
  const kind = kindOf(r, a, f)
  const plan = planChange(db, r, f, a, kind, body)
  const mgr = kind === 'admin' || kind === 'manager'
  const consumeProof = () => {
    if (plan.stepUp && !consumeStepUp(db, body.step_up, binding(sessionHash, a, f.id, plan.stepUp.general)))
      throw err(403, 'step_up_required', 'opening this folder to the whole team needs your passkey: confirm it first (POST /api/share/step-up)')
  }
  if (plan.stepUp && typeof body.step_up !== 'string') consumeProof() // fail fast, before any work
  const notifyOn = body.notify !== false
  let j: Judgement | null = null
  let readers: number[] = []
  if (plan.steps.length) {
    try {
      const res = withRejudge(db, () => {
        consumeProof()
        return applySteps(db, f, plan.steps, a.personId)
      }, {
        mode: 'rules', confirmBy: a.personId,
        decide: (jj) => { if (jj.copies.length && !(mgr && body.confirm_widening === true)) throw new Widening(jj) },
        after: (jj, words) => {
          readers = newReaders(db, r, f, a.personId)
          record(op, `share ${it.vpath}: ${words.join(', ')}${kind === 'editor' ? ' by editor' : ''}${jj.people.size ? ` widens: ${jj.people.size}` : ''}`, [it.vpath])
        },
      })
      j = res.judgement
    } catch (e) {
      if (!(e instanceof Widening)) throw e
      if (mgr || body.confirm_widening !== true) return refusal(db, a, kind, e.j)
      // an Editor's widening change: it waits for a manager of the sources (or the admin), passkey step-up (R8 inbox)
      let c!: ReturnType<typeof createShareApproval>
      db.transaction(() => {
        consumeProof()
        const { step_up: _s, confirm_widening: _c, ...change } = body
        c = createShareApproval(db, { requester: a.personId, folderId: f.id, vpath: it.vpath, change: { ...change, path: it.vpath }, j: e.j })
        record(op, `share ${it.vpath} by editor: ${c.status === 'closed' ? 'widens AI-draft copies, no one can approve' : `approval #${c.id} pending`} widens: ${e.j.people.size}`, [it.vpath])
      })()
      if (c.status === 'pending' && !c.again) {
        try { (w.opts.emit ?? (w as { emit?: WebCtx['opts']['emit'] }).emit)?.({ kind: 'approval_pending', approvalId: c.id, targetFolderId: f.id, sourceFolderIds: [...e.j.sources] }) } catch (x) { console.error('[notify] emit failed:', x) }
      }
      return json({ status: c.status === 'closed' ? 'closed' : 'approval_pending', approval_id: c.id, widens: e.j.people.size }, 202)
    }
    await afterChange(op, r, f, plan.steps, readers, notifyOn, j!)
  }
  const invited = await runInvites(op, f, it.vpath, plan.invites, mgr && body.confirm_widening === true, notifyOn)
  const view = buildView(db, a, resolveFolder(w, a, it.vpath), { path: it.vpath, kind: 'folder', name: it.vpath.slice(it.vpath.lastIndexOf('/') + 1), id: f.id })
  return { ...view, widens: j?.people.size ?? 0, invited }
}

/** Notices after a committed change (R7, R9, R11; O7: kind + count + link, never names). */
async function afterChange(op: Op, r: Rights, f: FolderRow, steps: Step[], readers: number[], notifyOn: boolean, j: Judgement) {
  const a = op.actor
  if (notifyOn && readers.length) await tell(op, readers, 'shared', '/#/shared')
  const managers = r.managersOf(f).filter((m) => m !== a.personId)
  const noAiOff = steps.some((s) => s.k === 'no_ai' && !s.on)
  if (noAiOff) await tell(op, [...r.managersOf(f), a.personId], 'no_ai_off', folderLink(f))
  else if (managers.length) await tell(op, managers, 'rules_changed', folderLink(f))
  // R9: an admin giving themselves access tells the managers and themselves
  const self = a.admin && steps.some((s) => (s.k === 'rule' && s.level >= 1 && (s.type === 'person' ? s.id === a.personId : r.groupsOf(a.personId).has(s.id))) || (s.k === 'manager' && s.on && s.pid === a.personId))
  if (self) await tell(op, [...r.managersOf(f), a.personId], 'self_grant', folderLink(f))
  notifyWidened(op.w.opts.emit ?? (op.w as { emit?: WebCtx['opts']['emit'] }).emit, j)
}

async function runInvites(op: Op, f: FolderRow, vpath: string, invites: Planned['invites'], confirm: boolean, notifyOn: boolean) {
  const out: { email: string; status: 'invited' | 'member'; granted: boolean }[] = []
  const h = inviteHandler(op.w.db)
  if (!h || !invites.length) return out
  const db = op.w.db
  for (const inv of invites) {
    const res = await h(op.w, { email: inv.email, role: 'member', by: op.actor.personId })
    let granted = false
    if (res.personId != null && db.query('SELECT 1 FROM people WHERE id = ?').get(res.personId)) {
      const r = new Rights(db)
      const g = r.folders.get(f.id)!
      const level = ROLE_LEVEL[inv.role]
      if (ownLevel(r, g, 'person', res.personId) < level) {
        try {
          withRejudge(db, () => applySteps(db, g, [{ k: 'rule', type: 'person', id: res.personId!, name: inv.email, level, prev: ownLevel(r, g, 'person', res.personId!) }], op.actor.personId), {
            mode: 'rules', confirmBy: op.actor.personId,
            decide: (jj) => { if (jj.copies.length && !confirm) throw new Widening(jj) },
            after: (jj, words) => record(op, `share ${vpath}: ${words.join(', ')} (invited)${jj.people.size ? ` widens: ${jj.people.size}` : ''}`, [vpath]),
          })
          granted = true
        } catch (e) { if (!(e instanceof Widening)) throw e }
      } else granted = true
      if (granted && notifyOn) await tell(op, [res.personId], 'shared', '/#/shared')
    }
    out.push({ email: inv.email, status: res.status, granted })
  }
  return out
}

// ---------- Shared with me, directory ----------
/**
 * Folders shared with this person directly or through one of their groups (not Everyone), that they can open right now
 * (judged again on every request: a revoked share is gone at once; hidden == nonexistent), newest first.
 */
export function sharedWithMe(w: WebCtx, a: Actor) {
  const db = w.db
  const E = everyoneId(db)
  const groups = [...new Rights(db).groupsOf(a.personId)].filter((g) => g !== E)
  const rows = db.query<{ folder_id: number; granted_by: number | null; granted_at: number | null }, []>(
    `SELECT folder_id, granted_by, granted_at FROM rules WHERE level >= 1 AND ((subject_type = 'person' AND subject_id = ${a.personId})
       ${groups.length ? `OR (subject_type = 'group' AND subject_id IN (${groups.join(',')}))` : ''})
     UNION ALL SELECT folder_id, granted_by, granted_at FROM manage_grants WHERE person_id = ${a.personId}`).all()
  const access = Access.forPerson(db, a.personId)
  const r = new Rights(db)
  const best = new Map<number, { by: number | null; at: number | null }>()
  for (const x of rows) {
    if (x.granted_by === a.personId) continue
    const cur = best.get(x.folder_id)
    if (!cur || (x.granted_at ?? 0) > (cur.at ?? 0)) best.set(x.folder_id, { by: x.granted_by, at: x.granted_at })
  }
  const items: { path: string; kind: 'folder'; name: string; role: Role; shared_by: { id: number; name: string } | null; shared_at: number | null }[] = []
  for (const [id, g] of best) {
    const f = r.folders.get(id)
    if (!f || r.personal(f)) continue
    const n = access.nodeForFolder(id)
    if (!n || !access.canRead(n)) continue
    const role: Role | null = r.manages(a.personId, f) ? 'manager' : roleOf(access.level(n))
    if (!role) continue
    items.push({ path: n.vpath, kind: 'folder', name: n.vpath.slice(n.vpath.lastIndexOf('/') + 1), role,
      shared_by: g.by == null ? null : { id: g.by, name: personName(db, g.by) }, shared_at: g.at })
  }
  items.sort((x, y) => (y.shared_at ?? 0) - (x.shared_at ?? 0) || x.path.localeCompare(y.path))
  return { items }
}

/** People and groups for the share dialog's picker: names for every member, addresses for the admin only (finding 11). */
export function directory(w: WebCtx, a: Actor) {
  const db = w.db
  const cols = new Set(db.query<{ name: string }, []>('PRAGMA table_info(people)').all().map((c) => c.name))
  const people = db.query<{ id: number; name: string; display_name?: string | null }, []>(
    `SELECT id, name${cols.has('display_name') ? ', display_name' : ''} FROM people WHERE active = 1 ORDER BY name`).all()
  const E = everyoneId(db)
  const groups = db.query<{ id: number; name: string; size: number }, []>(
    'SELECT g.id, g.name, (SELECT count(*) FROM memberships m JOIN people p ON p.id = m.person_id WHERE m.group_id = g.id AND p.active = 1) AS size FROM groups g ORDER BY g.name').all()
  return {
    people: people.map((p) => ({ id: p.id, name: p.name, ...(p.display_name ? { display_name: p.display_name } : {}), ...(a.admin ? { email: emailOf(db, p.id) } : {}) })),
    groups: groups.map((g) => ({ id: g.id, name: g.id === E ? 'Anyone in Trina' : g.name, size: g.size, ...(g.id === E ? { everyone: true } : {}) })),
  }
}

/** For tests and the approval inbox: a stable random id for share requests. */
export const randomTag = () => crypto.randomBytes(8).toString('hex')
// (notify is re-exported for approvals.ts, which writes notices without a mailer)
export { notify }
