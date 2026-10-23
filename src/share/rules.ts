// Who may read and change a folder from the folder page: AI-reader / access rules, flags (No AI, Start fresh here,
// quarantine, name), folder managers, and the Everyone group every person joins. Moved here from src/web/ops.ts (W0
// seams); src/web/api.ts routes to it. Rule and flag changes run the R6 re-check of AI-draft copies in their own
// transaction (finding 1); rules and manage grants record who gave them and when ("Shared with me"). The share dialog's
// API is ./service.ts.
import { Rights } from '../rights'
import { LEVELS, type FolderRow, type LevelName } from '../store'
import { ApiError, bad, forbidden, type WebCtx } from '../web/http'
import { metaGet, metaSet } from '../web/schema'
import { checkName, folderLink, groupRow, label, now, personRow, record, requireAdmin, tell, visibleFolder, type Op } from '../web/op-common'
import { notifyWidened, withRejudge, type Judgement } from './rejudge'

/**
 * Run a rule or flag change with the R6 re-check of AI-draft copies in the same transaction (./rejudge.ts). These are
 * the folder page's changes (admin and managers); a change that would widen copies needs `confirm_widening: true`
 * (else 409 `widening`), then the copies close until a source manager confirms (or are confirmed at once when the
 * actor manages every source). The audit row is written inside, with "widens: N" when it widened.
 */
function rejudged<T>(op: Op, confirm: unknown, change: () => T, audit: (j: Judgement, v: T) => void): Judgement {
  return withRejudge(op.w.db, change, {
    mode: 'rules', confirmBy: op.actor.personId,
    decide: (j) => { if (j.copies.length && confirm !== true) throw new ApiError(409, 'widening', `this change lets ${j.people.size} more ${j.people.size === 1 ? 'person' : 'people'} read AI-draft copies without reading their sources; send confirm_widening: true to go ahead`) },
    after: audit,
  }).judgement
}

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

export function upsertRule(op: Op, f: FolderRow, type: 'person' | 'group', id: number, level: number) {
  if (level === 0) op.w.db.query('DELETE FROM rules WHERE folder_id = ? AND subject_type = ? AND subject_id = ?').run(f.id, type, id)
  else op.w.db.query(`INSERT INTO rules (folder_id, subject_type, subject_id, level, granted_by, granted_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT DO UPDATE SET level = excluded.level, granted_by = excluded.granted_by, granted_at = excluded.granted_at`).run(f.id, type, id, level, op.actor.personId, now())
}

export async function setRule(op: Op, id: unknown, body: { subject_type?: unknown; subject_id?: unknown; level?: unknown; confirm_widening?: unknown }) {
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
  const j = rejudged(op, body.confirm_widening, () => upsertRule(op, f, type, subj.id, level),
    (j) => record(op, `rule ${type === 'group' ? '@' : ''}${subj.name} ${['none', 'read', 'write'][level]}${j.people.size ? ` widens: ${j.people.size}` : ''}`, [vp]))
  notifyWidened(op.w.opts.emit, j)
  // R7: other manage holders hear of it; R9: an admin putting themselves in a rule tells managers and themselves
  const others = r.managersOf(f).filter((m) => m !== op.actor.personId)
  if (others.length) await tell(op, others, 'rules_changed', folderLink(f))
  const self = op.actor.admin && level >= 1 && (type === 'person' ? subj.id === op.actor.personId : r.groupsOf(op.actor.personId).has(subj.id))
  if (self) await tell(op, [...r.managersOf(f), op.actor.personId], 'self_grant', folderLink(f))
  return { ok: true }
}

export async function setFlags(op: Op, id: unknown, body: { no_ai?: unknown; inherit_break?: unknown; quarantine?: unknown; name?: unknown; confirm_widening?: unknown }) {
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
  const j = rejudged(op, body.confirm_widening, () => {
    for (const [k, v] of changes) {
      if ((f as unknown as Record<string, number>)[k] === v) continue
      db.query(`UPDATE folders SET ${k} = ? WHERE id = ?`).run(v, f.id)
      db.query('INSERT INTO folder_history (folder_id, at, by_person, field, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?)').run(f.id, now(), op.actor.personId, k, String((f as unknown as Record<string, number>)[k]), String(v))
    }
    if (rename) db.query('UPDATE folders SET mount_name = ? WHERE id = ?').run(rename, f.id)
  }, (j) => {
    const widens = j.people.size ? ` widens: ${j.people.size}` : ''
    for (const [k, v] of changes) if ((f as unknown as Record<string, number>)[k] !== v) record(op, `folder ${vp} ${k}=${v}${widens}`, [vp])
    if (rename) record(op, `folder ${vp} renamed to ${rename}`, [vp])
  })
  notifyWidened(op.w.opts.emit, j)
  const managers = r.managersOf(f).filter((m) => m !== op.actor.personId)
  if (changes.some(([k, v]) => k === 'no_ai' && v === 0 && f.no_ai)) {
    const owner = r.personal(f)?.personal_owner
    await tell(op, [...r.managersOf(f), op.actor.personId, ...(owner != null ? [owner] : [])], 'no_ai_off', folderLink(f))
  } else if (changes.some(([k, v]) => (f as unknown as Record<string, number>)[k] !== v) && managers.length) await tell(op, managers, 'rules_changed', folderLink(f))
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
    if (on) db.query('INSERT OR IGNORE INTO manage_grants (folder_id, person_id, granted_by, granted_at) VALUES (?, ?, ?, ?)').run(f.id, p.id, op.actor.personId, now())
    else db.query('DELETE FROM manage_grants WHERE folder_id = ? AND person_id = ?').run(f.id, p.id)
    record(op, `manage ${on ? 'grant' : 'revoke'} ${p.name}`, [vp])
  })()
  const managers = r.managersOf(f)
  if (on && p.id === op.actor.personId) await tell(op, [...managers, p.id], 'self_grant', folderLink(f))
  else await tell(op, [...managers.filter((m) => m !== op.actor.personId), p.id], 'manage_changed', folderLink(f))
  return { ok: true }
}
