// The MCP `promote` tool's work (src/promote.ts does the deciding and writing). The file is placed before the call's
// commit; its records ride in the commit transaction with the audit row, and if that fails the file is removed again
// (tools.ts: "if the audit row cannot be written the call fails and nothing it wrote is kept").
// A widening promote returns "pending approval" with the web link — information for the person, never a way to approve.
import type { Draft } from './drafts'
import {
  APPROVAL_TTL_MS, createApproval, executeWrite, MAX_PENDING_PER_PERSON, planPromote, PromoteError, recordPromotion, unplace,
  type Plan, type Promoter,
} from './promote'
import type { Ctx, Session } from './session'

export interface PromoteToolResult { text: string; isError: boolean; outcome: string; structured?: Record<string, unknown>; finish?: () => void }

/** Where a person approves: the public address when there is one, else the path on this server's own web address. */
export const approvalLink = (ctx: Ctx, id: number) => `${(ctx.publicUrl ?? '').replace(/\/+$/, '')}/#/approvals/${id}`

export function promoteByAgent(ctx: Ctx, s: Session, draft: Draft, folder: unknown, name: unknown, reason: unknown, expectedSha: unknown): PromoteToolResult {
  const db = ctx.db
  const p: Promoter = { personId: s.token.person_id, tokenId: s.token.id, access: s.access }
  let plan: Plan
  try {
    plan = planPromote(db, ctx.blobs, p, draft, folder, name, expectedSha)
    if (plan.kind === 'approval') {
      const waiting = db.query<{ n: number }, [number]>("SELECT count(*) AS n FROM approvals WHERE requester_person_id = ? AND status = 'pending'").get(p.personId)!.n
      if (waiting >= MAX_PENDING_PER_PERSON) throw new PromoteError('too_many_pending', `You already have ${waiting} promote requests waiting for approval; wait for them, or cancel some on the web.`, 429)
    }
  } catch (e) {
    if (e instanceof PromoteError) return { text: e.message, isError: true, outcome: `refused: ${e.code}` }
    throw e
  }
  s.files.add('/drafts/' + draft.path)
  const vpath = `${plan.target.vpath}/${plan.name}`

  if (plan.kind === 'write') {
    let placed: ReturnType<typeof executeWrite>
    try { placed = executeWrite(db, plan) } catch (e) {
      if (e instanceof PromoteError) return { text: e.message, isError: true, outcome: `refused: ${e.code}` }
      throw e
    }
    s.files.add(vpath)
    s.onAbort.push(() => unplace(placed))
    s.inCommit.push((tx) => {
      recordPromotion(tx, { draft: { id: draft.id, version: draft.version, sha256: draft.sha256, size: draft.size, token_id: draft.token_id, person_id: draft.person_id },
        byPerson: p.personId, tokenId: p.tokenId, targetId: plan.target.folderId, vpath, placed, widening: false, approvalId: null, now: ctx.now() })
    })
    return {
      text: `Promoted /drafts/${draft.path} (v${draft.version}, sha256 ${draft.sha256}) to ${vpath} as a new file. ` +
        `Whoever reads it there also inherits this draft's sources.`,
      isError: false, outcome: `written ${vpath}`, structured: { status: 'written', path: vpath, sha256: draft.sha256 },
    }
  }

  // widening: a request for a person (R8); the commit stores it with the audit row
  const r: PromoteToolResult = { text: '', isError: false, outcome: 'pending approval' }
  let created: ReturnType<typeof createApproval> | null = null
  s.inCommit.push((tx) => { created = createApproval(tx, plan, p, reason, ctx.now()) })
  r.finish = () => {
    const c = created!
    const link = approvalLink(ctx, c.id)
    if (c.status === 'closed') {
      r.isError = true
      r.text = `Not written, and no one can approve it: ${vpath} would be readable by people who cannot read this draft's sources, ` +
        `and no person can both read every source folder and manage the target folder (or every source folder). ` +
        `Ask an admin about the folder rules. Request: ${link}`
      r.structured = { status: 'closed', reason: 'no_approver', approval_id: c.id, url: link }
      try { ctx.emit?.({ kind: 'approval_decided', subjectPersonId: p.personId, approvalId: c.id }) } catch (e) { console.error('[notify] approval emit failed:', e) }
      return
    }
    r.text = `Pending approval${c.again ? ' (already requested)' : ''}: ${vpath} would be readable by ${plan.gain.length} ` +
      `${plan.gain.length === 1 ? 'person' : 'people'} who cannot read this draft's sources, so nothing is written yet. ` +
      `A person who can read every source folder must approve it on the web with a passkey: ${link} . ` +
      `You cannot approve it; tell your user. The request expires in ${APPROVAL_TTL_MS / 86400_000} days and applies to this version only (sha256 ${draft.sha256}).`
    // input_required here is information for the person, never a way to approve (plan 5.2)
    r.structured = { status: 'input_required', reason: 'approval_pending', approval_id: c.id, url: link, sha256: draft.sha256 }
    if (!c.again) {
      try { ctx.emit?.({ kind: 'approval_pending', approvalId: c.id, targetFolderId: plan.target.folderId, sourceFolderIds: [...draft.src.keys()] }) }
      catch (e) { console.error('[notify] approval emit failed:', e) }
    }
  }
  return r
}
