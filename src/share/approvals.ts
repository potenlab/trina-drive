// An Editor's sharing change that would widen AI-draft copies waits for a person who manages every source folder of
// those copies (or the admin): finding 1 / O1 ("Editors never confirm a widening"). It goes through the existing
// approval inbox (src/promote.ts `approvals`, kind 'share'): the same list, badge, notices (approval_pending: kind +
// count + link, R11), passkey step-up per click (src/web/approve.ts), reject and cancel. On approval the change is
// planned again as the requester now (they must still be allowed to make it), applied with the R6 re-check in one
// transaction, and the copies it widens are confirmed by the approver.
import type { DB } from '../db'
import { sourcesFor } from '../drafts'
import { Access } from '../policy'
import { APPROVAL_TTL_MS, ensurePromoteSchema, MAX_PENDING_PER_PERSON, PromoteError, type ApprovalRow, type Eligibility } from '../promote'
import { Rights } from '../rights'
import { sha256 } from '../store'
import { appendAudit } from '../audit'
import { ensureWebSchema } from '../web/schema'
import type { Judgement } from './rejudge'
import { withRejudge } from './rejudge'
import { applySteps, kindOf, newReaders, planChange, randomTag } from './service'

export interface ShareRequest { requester: number; folderId: number; vpath: string; change: Record<string, unknown>; j: Judgement }

const people = (db: DB) => db.query<{ id: number }, []>('SELECT p.id FROM people p JOIN accounts a ON a.person_id = p.id WHERE p.active = 1').all().map((x) => x.id)

/** Inside the caller's transaction: a pending share request (or the same one again), closed when nobody could approve it. */
export function createShareApproval(db: DB, q: ShareRequest, now = Date.now()): { id: number; status: 'pending' | 'closed'; again: boolean } {
  ensurePromoteSchema(db)
  const payload = JSON.stringify(q.change)
  const same = db.query<{ id: number }, [number, number, string]>(
    "SELECT id FROM approvals WHERE kind = 'share' AND requester_person_id = ? AND target_folder_id = ? AND payload = ? AND status = 'pending'").get(q.requester, q.folderId, payload)
  if (same) return { id: same.id, status: 'pending', again: true }
  const waiting = db.query<{ n: number }, [number]>("SELECT count(*) AS n FROM approvals WHERE requester_person_id = ? AND status = 'pending'").get(q.requester)!.n
  if (waiting >= MAX_PENDING_PER_PERSON) throw new PromoteError('too_many_pending', `you already have ${waiting} requests waiting`, 429)
  const tag = 'share-' + sha256(`${payload}:${now}:${randomTag()}`)
  const id = Number(db.query(`INSERT INTO approvals (created_at, expires_at, status, draft_id, draft_version, sha256, size, draft_path, requester_person_id, requester_token_id,
      target_folder_id, target_vpath, name, reason, src, gain, overwrite, kind, payload) VALUES (?, ?, 'pending', 0, 0, ?, 0, '', ?, NULL, ?, ?, ?, NULL, ?, ?, 0, 'share', ?)`)
    .run(now, now + APPROVAL_TTL_MS, tag, q.requester, q.folderId, q.vpath, q.vpath.slice(q.vpath.lastIndexOf('/') + 1),
      JSON.stringify([...q.j.sources].map((s) => [s, 1])), q.j.people.size, payload).lastInsertRowid)
  const a = db.query<ApprovalRow, [number]>('SELECT * FROM approvals WHERE id = ?').get(id)!
  if (!people(db).some((p) => shareApproverStatus(db, a, p).eligible)) {
    db.query("UPDATE approvals SET status = 'closed', decided_at = ?, decision_reason = 'no one can approve' WHERE id = ?").run(now, id)
    return { id, status: 'closed', again: false }
  }
  return { id, status: 'pending', again: false }
}

const sourcesOfRow = (a: ApprovalRow) => (JSON.parse(a.src) as [number, number][]).map(([id]) => id)

/**
 * Who decides a share request: an active person with a sign-in, not the requester, who is the admin or manages every
 * source folder of the widening copies (R6's confirmers) and can open each of them.
 */
export function shareApproverStatus(db: DB, a: ApprovalRow, personId: number, rights = new Rights(db)): Eligibility {
  ensureWebSchema(db)
  const p = db.query<{ active: number; admin: number }, [number]>('SELECT p.active, p.admin FROM people p JOIN accounts a ON a.person_id = p.id WHERE p.id = ?').get(personId)
  if (!p || !p.active) return { eligible: false, via: null, why: 'not an active person with a sign-in' }
  if (personId === a.requester_person_id) return { eligible: false, via: null, why: 'your own request: a manager of the sources decides it' }
  if (p.admin) return { eligible: true, via: 'sources', why: null }
  const src = sourcesOfRow(a)
  const access = Access.forPerson(db, personId)
  const ok = src.length > 0 && src.every((s) => { const f = rights.folders.get(s); return !!f && rights.manages(personId, f) && access.canReadFolder(s) })
  return ok ? { eligible: true, via: 'sources', why: null } : { eligible: false, via: null, why: 'does not manage every source folder' }
}

/** What an approver (or the requester) sees: the change, how many gain access, the sources (named only when readable). */
export function shareApprovalDetail(db: DB, a: ApprovalRow, personId: number, eligible: boolean) {
  const change = JSON.parse(a.payload ?? '{}') as Record<string, unknown>
  const s = sourcesFor(Access.forPerson(db, personId), new Map(sourcesOfRow(a).map((x) => [x, true])))
  return { kind: 'share' as const, change, sources: s.shown.map((x) => x.folder), hidden_sources: s.hidden, gainers: eligible ? { count: a.gain } : null, preview: null, diff: null }
}

/**
 * Approve (the caller checked the session and consumed a step-up for this request): plan the change again as the
 * requester, apply it with the R6 re-check, the approver confirming the copies it widens. One transaction.
 */
export function applyShareApproval(db: DB, a: ApprovalRow, approverId: number, now = Date.now()): { vpath: string } {
  const req = db.query<{ id: number; admin: number; active: number }, [number]>('SELECT id, admin, active FROM people WHERE id = ?').get(a.requester_person_id)
  if (!req?.active) throw new PromoteError('requester_gone', 'the person who asked is no longer active', 409)
  const server = new Access(db, { personId: -1 })
  const node = server.nodeForFolder(a.target_folder_id)
  if (!node) throw new PromoteError('target_changed', 'the folder is gone or moved', 409)
  const r = new Rights(db)
  const f = r.folders.get(a.target_folder_id)!
  const actor = { personId: req.id, admin: !!req.admin }
  const kind = kindOf(r, actor, f)
  let plan
  try { plan = planChange(db, r, f, actor, kind, JSON.parse(a.payload ?? '{}'), { approval: true }) } catch (e) {
    throw new PromoteError('change_invalid', `the change cannot be made any more (${(e as Error).message})`, 409)
  }
  let readers: number[] = []
  withRejudge(db, () => {
    const u = db.query("UPDATE approvals SET status = 'approved', decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'").run(now, approverId, a.id)
    if (u.changes !== 1) throw new PromoteError('not_pending', 'this request was decided meanwhile', 409)
    return applySteps(db, f, plan.steps, req.id)
  }, {
    mode: 'rules', confirmBy: approverId,
    after: (j, words) => {
      readers = newReaders(db, r, f, req.id)
      appendAudit(db, { personId: approverId, tokenId: null, tool: 'web', outcome: 'ok', files: [a.target_vpath],
        command: `approve share #${a.id}: share ${a.target_vpath}: ${words.join(', ')} by editor${j.people.size ? ` widens: ${j.people.size}` : ''}` })
      // "shared with you" for the people who can open it now (kind + count + link only; the web shows it, no mail here)
      for (const id of readers) db.query('INSERT INTO notices (person_id, kind, count, link, created_at) VALUES (?, ?, 1, ?, ?)').run(id, 'shared', '/#/shared', now)
    },
  })
  return { vpath: a.target_vpath }
}
