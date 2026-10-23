// The web side of second factors, draft promote and the approval inbox. api.ts only routes here; decisions live in
// mfa.ts (factors, step-ups), promote.ts (R2/R6/R8) and policy.ts / rights.ts.
//
// Browser-agent defence (plan 7.1 "에이전트가 사람 세션으로 승인 버튼 누름"): an approval needs, on every click, a step-up
// minted for that approval id and draft version hash by a fresh passkey assertion with user verification (TOTP only
// where this install has no public HTTPS address). There are no magic links: notifications carry a plain link to the
// inbox, which needs sign-in (and the second factor, when enrolled). Bearer tokens are never read under /api.
import fs from 'node:fs'
import { appendAudit } from '../audit'
import type { DB } from '../db'
import { canSeeDraft, liveDrafts, type Draft } from '../drafts'
import { Access } from '../policy'
import {
  afterPromote, approvalById, approvalDetail, approvalsFor, approve, approverStatus, createApproval, executeWrite, MAX_PENDING_PER_PERSON, planPromote,
  PromoteError, promoteFolderIds, promoteTargets, recordPromotion, reject, setPromote, unplace, type Promoter,
} from '../promote'
import { Rights, type Actor } from '../rights'
import type { TokenRow } from '../store'
import { freshLogin } from './auth'
import { ApiError, bad, forbidden, notFound, type WebCtx } from './http'
import {
  consumeStepUp, has2FA, issueStepUp, makeRecoveryCodes, MfaError, passkeyAssertionOptions, passkeyConfig, passkeyRegister,
  passkeyRegistrationOptions, passkeyRemove, passkeysOf, passkeyVerify, recoveryRemaining, stepUpChallengeBinding, ticketBinding,
  totpBegin, totpConfirm, totpEnabled, totpRemove, totpVerify, useRecoveryCode, type StepUpBinding,
} from './mfa'
import { notify } from './notices'
import { visibleFolder, type Op } from './ops'

export const pkConfig = (w: WebCtx) => passkeyConfig(w.opts.publicUrl)

const record = (db: DB, personId: number, command: string, files: string[] = []) =>
  appendAudit(db, { personId, tokenId: null, tool: 'web', command, files, outcome: 'ok' })

function emit(w: WebCtx, e: Parameters<NonNullable<WebCtx['emit']>>[0]) {
  try { (w.opts.emit ?? w.emit)?.(e) } catch (err) { console.error('[notify] emit failed:', err) }
}

/** Errors of the deciding modules as HTTP errors. */
export function asApi(e: unknown): never {
  if (e instanceof PromoteError) throw new ApiError(e.status, e.code, e.message)
  if (e instanceof MfaError) throw new ApiError(e.status, e.code, e.message)
  throw e
}

const personName = (db: DB, id: number) => db.query<{ name: string }, [number]>('SELECT name FROM people WHERE id = ?').get(id)?.name ?? ''

/** Changing one's factors needs the password typed within the last 5 minutes (a stolen session cannot lock you out). */
function requireFresh(op: Op, sessionHash: string) {
  if (!freshLogin(op.w.db, sessionHash)) throw new ApiError(403, 'reauth_required', 'type your password again first')
}

async function factorChanged(op: Op, what: string) {
  record(op.w.db, op.actor.personId, what)
  await notify({ db: op.w.db, mailer: op.w.mailer, baseUrl: op.base }, [op.actor.personId], 'second_factor_changed', '/#/settings')
}

// ---------- second factors: status and enrolment ----------
export function factorsView(w: WebCtx, personId: number) {
  const cfg = pkConfig(w)
  return {
    passkeys_available: !!cfg, rp_id: cfg?.rpId ?? null, public_url: cfg?.origin ?? null,
    passkeys: passkeysOf(w.db, personId).map((p) => ({ id: p.id, name: p.name, rp_id: p.rp_id, created_at: p.created_at, last_used_at: p.last_used_at, usable: !!cfg && p.rp_id === cfg.rpId })),
    totp: totpEnabled(w.db, personId), recovery_remaining: recoveryRemaining(w.db, personId), enrolled: has2FA(w.db, personId),
  }
}

export async function passkeyOptions(op: Op, sessionHash: string) {
  requireFresh(op, sessionHash)
  const cfg = pkConfig(op.w)
  if (!cfg) throw new ApiError(409, 'passkeys_unavailable', 'passkeys need the server\'s public https address (serve --public-url); use an authenticator app instead')
  return passkeyRegistrationOptions(op.w.db, cfg, { id: op.actor.personId, name: personName(op.w.db, op.actor.personId) }, sessionHash).catch(asApi)
}

export async function passkeyAdd(op: Op, sessionHash: string, body: { response?: unknown; name?: unknown }) {
  requireFresh(op, sessionHash)
  const cfg = pkConfig(op.w)
  if (!cfg) throw new ApiError(409, 'passkeys_unavailable', 'passkeys are not available on this server')
  const first = !has2FA(op.w.db, op.actor.personId)
  const r = await passkeyRegister(op.w.db, cfg, op.actor.personId, sessionHash, body.response, body.name).catch(asApi)
  await factorChanged(op, `second factor: passkey added (${r.name})`)
  return { ok: true, name: r.name, recovery_codes: first ? makeRecoveryCodes(op.w.db, op.actor.personId) : null }
}

export async function passkeyDelete(op: Op, sessionHash: string, id: number) {
  requireFresh(op, sessionHash)
  if (!passkeyRemove(op.w.db, op.actor.personId, id)) throw notFound()
  await factorChanged(op, 'second factor: passkey removed')
  return { ok: true, ...lastFactorWarning(op) }
}

export function totpSetup(op: Op, sessionHash: string) {
  requireFresh(op, sessionHash)
  try { return totpBegin(op.w.db, op.actor.personId, personName(op.w.db, op.actor.personId)) } catch (e) { return asApi(e) }
}

export async function totpEnable(op: Op, body: { code?: unknown }) {
  const first = !has2FA(op.w.db, op.actor.personId)
  if (!totpConfirm(op.w.db, op.actor.personId, body.code)) throw bad('bad_code', 'that code is not right; check the time on your phone and try the next one')
  await factorChanged(op, 'second factor: authenticator app added')
  return { ok: true, recovery_codes: first ? makeRecoveryCodes(op.w.db, op.actor.personId) : null }
}

export async function totpDisable(op: Op, sessionHash: string) {
  requireFresh(op, sessionHash)
  if (!totpRemove(op.w.db, op.actor.personId)) throw notFound()
  await factorChanged(op, 'second factor: authenticator app removed')
  return { ok: true, ...lastFactorWarning(op) }
}

export async function newRecoveryCodes(op: Op, sessionHash: string) {
  requireFresh(op, sessionHash)
  if (!has2FA(op.w.db, op.actor.personId)) throw bad('no_factor', 'set up a passkey or an authenticator app first')
  const codes = makeRecoveryCodes(op.w.db, op.actor.personId)
  await factorChanged(op, 'second factor: new recovery codes')
  return { recovery_codes: codes }
}

function lastFactorWarning(op: Op) {
  return op.actor.admin && !has2FA(op.w.db, op.actor.personId) ? { warning: 'admin_without_2fa' } : {}
}

// ---------- sign-in: the second step ----------
/** What a person with a second factor gets instead of a session after a correct password. */
export async function secondFactorChallenge(w: WebCtx, ticket: string, personId: number) {
  const cfg = pkConfig(w)
  const passkey = cfg ? await passkeyAssertionOptions(w.db, cfg, personId, 'login', ticketBinding(ticket)) : null
  const methods = [...(passkey ? ['passkey'] : []), ...(totpEnabled(w.db, personId) ? ['totp'] : []), ...(recoveryRemaining(w.db, personId) ? ['recovery'] : [])]
  return { ticket, methods, passkey, public_url: cfg?.origin ?? null, passkeys_elsewhere: !passkey && passkeysOf(w.db, personId).length > 0 ? (cfg?.origin ?? 'public') : null }
}

/** Check the second factor of a sign-in ticket. Throws on failure (the caller counts it). */
export async function checkSecondFactor(w: WebCtx, ticket: string, personId: number, body: { method?: unknown; code?: unknown; response?: unknown }) {
  const db = w.db
  if (body.method === 'totp') { if (!totpVerify(db, personId, body.code)) throw new ApiError(401, 'bad_code', 'that code is not right'); return 'totp' }
  if (body.method === 'recovery') { if (!useRecoveryCode(db, personId, body.code)) throw new ApiError(401, 'bad_code', 'that recovery code is not right or was used'); return 'recovery' }
  if (body.method === 'passkey') {
    const cfg = pkConfig(w)
    if (!cfg) throw new ApiError(409, 'passkeys_unavailable', 'passkeys are not available here')
    try { await passkeyVerify(db, cfg, personId, 'login', ticketBinding(ticket), body.response) } catch (e) {
      if (e instanceof MfaError) throw new ApiError(401, e.code, e.message)
      throw e
    }
    return 'passkey'
  }
  throw bad('bad_method', 'method: passkey, totp or recovery')
}

// ---------- promote from the web ----------
function sessionToken(personId: number): TokenRow {
  return { id: -1, person_id: personId, name: 'web', hint: '', scope: null, read_only: 1, created_at: 0, expires_at: null, revoked_at: null, last_used_at: null }
}
/** A draft of this person they can see now (R4, the session as a full-scope token), else 404. */
function myDraft(w: WebCtx, personId: number, id: number): Draft {
  const access = Access.forPerson(w.db, personId)
  const d = liveDrafts(w.db, personId).find((x) => x.id === id)
  if (!d || !canSeeDraft(access, sessionToken(personId), d)) throw notFound()
  return d
}

export const promoteTargetsView = (w: WebCtx, a: Actor) => ({ targets: promoteTargets(w.db, a.personId) })

export function promoteFromWeb(op: Op, draftId: number, body: { folder?: unknown; name?: unknown; expected_sha256?: unknown; note?: unknown; overwrite?: unknown }) {
  const { w, actor } = op
  const db = w.db
  const d = myDraft(w, actor.personId, draftId)
  const p: Promoter = { personId: actor.personId, tokenId: null, access: Access.forPerson(db, actor.personId) }
  let plan
  try { plan = planPromote(db, w.blobs, p, d, body.folder, body.name, body.expected_sha256, body.overwrite) } catch (e) { return asApi(e) }
  const vpath = `${plan.target.vpath}/${plan.name}`
  if (plan.kind === 'write') {
    let placed
    try { placed = executeWrite(db, plan, p.access) } catch (e) { return asApi(e) }
    const replaced = !!placed.managed?.placed.replaced
    try {
      db.transaction(() => {
        recordPromotion(db, { draft: { id: d.id, version: d.version, sha256: d.sha256, size: d.size, token_id: d.token_id, person_id: d.person_id },
          byPerson: actor.personId, tokenId: null, targetId: plan.target.folderId, vpath, placed, widening: false, approvalId: null, now: Date.now() })
        record(db, actor.personId, `promote /drafts/${d.path} v${d.version} -> ${vpath} (${replaced ? 'new version' : 'new file'})`, ['/drafts/' + d.path, vpath])
      })()
    } catch (e) { unplace(placed); throw e }
    afterPromote(w, placed)
    return { status: 'written', path: vpath, ...(replaced ? { replaced: true } : {}) }
  }
  const waiting = db.query<{ n: number }, [number]>("SELECT count(*) AS n FROM approvals WHERE requester_person_id = ? AND status = 'pending'").get(actor.personId)!.n
  if (waiting >= MAX_PENDING_PER_PERSON) throw new ApiError(429, 'too_many_pending', 'you have too many promote requests waiting')
  let c!: ReturnType<typeof createApproval>
  db.transaction(() => {
    c = createApproval(db, plan, p, body.note, Date.now())
    record(db, actor.personId, `promote /drafts/${d.path} v${d.version} -> ${vpath}: ${c.status === 'closed' ? 'no one can approve' : `approval #${c.id} pending`}`, ['/drafts/' + d.path])
  })()
  if (c.status === 'pending' && !c.again) emit(w, { kind: 'approval_pending', approvalId: c.id, targetFolderId: plan.target.folderId, sourceFolderIds: [...d.src.keys()] })
  return { status: c.status === 'closed' ? 'closed' : 'pending', approval_id: c.id, gain: plan.gain.length }
}

/** Admin: turn promote on or off for a folder (and everything below it). Not inside personal folders. */
export async function setFolderPromote(op: Op, id: number, body: { enabled?: unknown }) {
  if (!op.actor.admin) throw forbidden('only an admin turns promote on or off')
  if (typeof body.enabled !== 'boolean') throw bad('bad_input', 'enabled: true or false')
  const r = new Rights(op.w.db)
  const f = visibleFolder(op, r, id)
  if (r.personal(f)) throw bad('personal', 'drafts are not promoted into personal folders')
  const was = promoteFolderIds(op.w.db).has(f.id)
  if (was === body.enabled) return { ok: true }
  const vp = r.vpath(f) ?? f.path
  op.w.db.transaction(() => {
    setPromote(op.w.db, f.id, body.enabled as boolean, op.actor.personId)
    op.w.db.query('INSERT INTO folder_history (folder_id, at, by_person, field, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?)').run(f.id, Date.now(), op.actor.personId, 'promote', String(was ? 1 : 0), String(body.enabled ? 1 : 0))
    record(op.w.db, op.actor.personId, `folder ${vp} promote=${body.enabled ? 1 : 0}`, [vp])
  })()
  const warnings: string[] = []
  if (body.enabled) {
    // plan 5.2: the server's NAS account writes only where promote is on; say so when it cannot write here
    try { fs.accessSync(f.path, fs.constants.W_OK) } catch { warnings.push('server_cannot_write') }
  }
  const others = r.managersOf(f).filter((m) => m !== op.actor.personId)
  if (others.length) await notify({ db: op.w.db, mailer: op.w.mailer, baseUrl: op.base }, others, 'rules_changed', `/#/folders/${f.id}`)
  return { ok: true, warnings }
}

// ---------- the approval inbox ----------
export function approvalsView(w: WebCtx, a: Actor) {
  return { ...approvalsFor(w.db, a.personId), step_up: stepUpMethod(w, a.personId) }
}

/** How this person proves themselves for an approval here: passkey when the install has a public https address, else TOTP. */
function stepUpMethod(w: WebCtx, personId: number): { method: 'passkey' | 'totp' | null; missing: 'passkey' | 'totp' | null; lan_only: boolean; public_url: string | null } {
  const cfg = pkConfig(w)
  if (cfg) return passkeysOf(w.db, personId).some((p) => p.rp_id === cfg.rpId) ? { method: 'passkey', missing: null, lan_only: false, public_url: cfg.origin } : { method: null, missing: 'passkey', lan_only: false, public_url: cfg.origin }
  return totpEnabled(w.db, personId) ? { method: 'totp', missing: null, lan_only: true, public_url: null } : { method: null, missing: 'totp', lan_only: true, public_url: null }
}

export function approvalView(w: WebCtx, a: Actor, id: number) {
  try { return { ...approvalDetail(w.db, w.blobs, id, a.personId), step_up: stepUpMethod(w, a.personId) } } catch (e) { return asApi(e) }
}

/** The approval this person may decide right now, at this hash (else 404 / 409). */
function decidable(w: WebCtx, a: Actor, id: number, sha: unknown) {
  const ap = approvalById(w.db, id)
  if (!ap) throw notFound()
  const el = ap.status === 'pending' ? approverStatus(w.db, ap, a.personId) : null
  if (!el?.eligible) {
    if (ap.requester_person_id === a.personId || ap.decided_by === a.personId) throw new ApiError(409, 'not_pending', ap.status === 'pending' ? 'you cannot approve this request' : `this request is ${ap.status}`)
    throw notFound()
  }
  if (sha !== ap.sha256) throw new ApiError(409, 'hash_mismatch', 'this request is for another version of the draft; reload the page')
  return ap
}

export async function stepUpOptions(op: Op, sessionHash: string, id: number, body: { sha256?: unknown }) {
  const ap = decidable(op.w, op.actor, id, body.sha256)
  const m = stepUpMethod(op.w, op.actor.personId)
  if (!m.method) throw new ApiError(409, m.missing === 'passkey' ? 'passkey_required' : 'totp_required',
    m.missing === 'passkey' ? 'approving needs a passkey on this server: add one in Settings' : 'approving needs an authenticator app (this server has no public https address for passkeys): set one up in Settings')
  if (m.method === 'totp') return { method: 'totp' }
  const b: StepUpBinding = { sessionHash, personId: op.actor.personId, approvalId: ap.id, sha256: ap.sha256 }
  return { method: 'passkey', options: await passkeyAssertionOptions(op.w.db, pkConfig(op.w)!, op.actor.personId, 'stepup', stepUpChallengeBinding(b)) }
}

/** Prove the second factor for one approval click: returns a 2-minute, single-use assertion bound to it. */
export async function stepUp(op: Op, sessionHash: string, id: number, body: { sha256?: unknown; response?: unknown; code?: unknown }) {
  const { w, actor } = op
  const key = `stepup:${actor.personId}`
  if (w.loginByName.blocked(key)) throw new ApiError(429, 'rate_limited', 'too many tries; wait a few minutes', { 'retry-after': String(w.loginByName.retryAfter(key)) })
  const ap = decidable(w, actor, id, body.sha256)
  const m = stepUpMethod(w, actor.personId)
  const b: StepUpBinding = { sessionHash, personId: actor.personId, approvalId: ap.id, sha256: ap.sha256 }
  try {
    if (m.method === 'passkey' && body.response !== undefined) await passkeyVerify(w.db, pkConfig(w)!, actor.personId, 'stepup', stepUpChallengeBinding(b), body.response)
    else if (m.method === 'totp' && body.code !== undefined) { if (!totpVerify(w.db, actor.personId, body.code)) throw new MfaError('bad_code', 'that code is not right', 401) }
    else throw new MfaError(m.method ? 'bad_input' : 'step_up_unavailable', m.method === 'passkey' ? 'send the passkey response' : m.method === 'totp' ? 'send the code from your authenticator app' : 'no second factor for approvals is set up', 400)
  } catch (e) {
    w.loginByName.hit(key)
    return asApi(e)
  }
  w.loginByName.reset(key)
  return issueStepUp(w.db, b, m.method!)
}

export async function approveRequest(op: Op, sessionHash: string, id: number, body: { assertion?: unknown; sha256?: unknown }) {
  const { w, actor } = op
  const ap = decidable(w, actor, id, body.sha256)
  if (!consumeStepUp(w.db, body.assertion, { sessionHash, personId: actor.personId, approvalId: ap.id, sha256: ap.sha256 }))
    throw new ApiError(403, 'step_up_required', 'confirm with your passkey (or code) for this approval; each approval needs its own')
  let r
  try { r = approve(w.db, w.blobs, ap.id, actor.personId, body.sha256) } catch (e) { return asApi(e) }
  afterPromote(w, r.placed)
  emit(w, { kind: 'approval_decided', subjectPersonId: ap.requester_person_id, approvalId: ap.id })
  return { ok: true, status: r.approval.status, path: r.vpath }
}

export function rejectRequest(op: Op, id: number, body: { reason?: unknown }) {
  const { w, actor } = op
  let r
  try { r = reject(w.db, id, actor.personId, body.reason) } catch (e) { return asApi(e) }
  if (r.requester_person_id !== actor.personId) emit(w, { kind: 'approval_decided', subjectPersonId: r.requester_person_id, approvalId: r.id })
  return { ok: true, status: r.status }
}
