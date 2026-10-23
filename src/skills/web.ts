// The web side of team skills: the Skills page (what this person may see, status, approver, AI use, zip download),
// library designation (Admins only), and approving a pending version — diff shown, the approver is not one of its
// editors, and every approve click needs a fresh passkey (or, on a LAN-only server, an authenticator code) bound to
// that version and digest, through the same step-up machinery as promote approvals (src/web/mfa.ts). The step-up's
// approval id is the version id negated, so it can never be spent on a promote approval (whose ids are positive).
// Bearer tokens never reach /api: agents cannot approve.
import { appendAudit } from '../audit'
import type { DB } from '../db'
import { Access } from '../policy'
import { Rights, type Actor } from '../rights'
import { pkConfig } from '../web/approve'
import { ApiError, forbidden, notFound, type WebCtx } from '../web/http'
import {
  consumeStepUp, issueStepUp, MfaError, passkeyAssertionOptions, passkeysOf, passkeyVerify, stepUpChallengeBinding, totpEnabled, totpVerify, type StepUpBinding,
} from '../web/mfa'
import type { Op } from '../web/op-common'
import {
  approvedOf, approverStatus, approveVersion, designate, editorsOf, eligibleApprovers, hasScripts, libraries, libraryOf, manifestOf, pendingOf, rejectVersion,
  folderByVpath, scan, skillBlobs, skillNode, skillPresent, SkillError, snapshotFile, undesignate, usageCount, versionById, type VersionRow,
} from './core'
import { unifiedDiff } from './diff'
import { zip } from './zip'

const record = (db: DB, personId: number, command: string, files: string[] = []) =>
  appendAudit(db, { personId, tokenId: null, tool: 'web', command, files, outcome: 'ok' })

function asApi(e: unknown): never {
  if (e instanceof SkillError) throw new ApiError(e.status, e.code, e.message)
  if (e instanceof MfaError) throw new ApiError(e.status, e.code, e.message)
  throw e
}

const nameOf = (db: DB, id: number | null) => id == null ? null : db.query<{ name: string }, [number]>('SELECT name FROM people WHERE id = ?').get(id)?.name ?? '?'

/** How this person proves themselves for an approval here (the same rule as the promote inbox). */
export function stepUpMethod(w: WebCtx, personId: number) {
  const cfg = pkConfig(w)
  if (cfg) return passkeysOf(w.db, personId).some((p) => p.rp_id === cfg.rpId) ? { method: 'passkey' as const, missing: null, lan_only: false, public_url: cfg.origin } : { method: null, missing: 'passkey' as const, lan_only: false, public_url: cfg.origin }
  return totpEnabled(w.db, personId) ? { method: 'totp' as const, missing: null, lan_only: true, public_url: null } : { method: null, missing: 'totp' as const, lan_only: true, public_url: null }
}

/**
 * May this person see this skill on the web at all? Whoever can read its folder, a Manager of the library, an Admin.
 * Anyone else gets the same as for a skill that does not exist.
 */
function canSeeSkill(db: DB, actor: Actor, rights: Rights, libraryId: number, name: string): boolean {
  const f = rights.folders.get(libraryId)
  if (!f || !rights.canSee(actor, f)) return false
  if (actor.admin || rights.manages(actor.personId, f)) return true
  return !!skillNode(Access.forPerson(db, actor.personId), libraryId, name)
}

const visibleLibrary = (rights: Rights, actor: Actor, id: number) => { const f = rights.folders.get(id); return !!f && rights.canSee(actor, f) }

function versionSummary(db: DB, v: VersionRow) {
  return { id: v.id, digest: v.digest, status: v.status, proposed_at: v.proposed_at, decided_at: v.decided_at, decided_by: nameOf(db, v.decided_by), reason: v.reason,
    editors: editorsOf(v).map((e) => e == null ? null : nameOf(db, e)), files: manifestOf(v).length, has_scripts: hasScripts(manifestOf(v)) }
}

/** GET /api/skills */
export function skillsView(w: WebCtx, actor: Actor) {
  const db = w.db
  scan(db, w.dataDir) // cheap: unchanged files are not read again (core.ts hash cache)
  const rights = new Rights(db)
  const agentView = new Access(db, { personId: actor.personId }) // what this person's AI (a full-scope token) is served
  const libs = libraries(db).filter((l) => visibleLibrary(rights, actor, l.folder_id))
  const items: Record<string, unknown>[] = []
  for (const lib of libs) {
    const f = rights.folders.get(lib.folder_id)!
    const names = new Set([
      ...db.query<{ name: string }, [number]>('SELECT DISTINCT name FROM skill_versions WHERE library_id = ?').all(lib.folder_id).map((r) => r.name),
      ...db.query<{ name: string }, [number]>('SELECT name FROM skill_problems WHERE library_id = ?').all(lib.folder_id).map((r) => r.name),
    ])
    for (const name of [...names].sort()) {
      if (!canSeeSkill(db, actor, rights, lib.folder_id, name)) continue
      const approved = approvedOf(db, lib.folder_id, name)
      const pending = pendingOf(db, lib.folder_id, name)
      const problem = db.query<{ error: string; at: number }, [number, string]>('SELECT error, at FROM skill_problems WHERE library_id = ? AND name = ?').get(lib.folder_id, name)
      const present = skillPresent(db, lib.folder_id, name)
      const qname = `${lib.slug}/${name}`
      const latest = pending ?? approved ?? db.query<VersionRow, [number, string]>('SELECT * FROM skill_versions WHERE library_id = ? AND name = ? ORDER BY id DESC LIMIT 1').get(lib.folder_id, name)
      if (!present && !approved && !pending) continue
      items.push({
        qname, name, library: { id: lib.folder_id, slug: lib.slug, vpath: rights.vpath(f) },
        description: latest?.description ?? null,
        status: !present ? 'missing' : problem ? 'error' : pending ? (approved ? 'changed' : 'new') : approved ? 'active' : 'rejected',
        problem: problem?.error ?? null,
        approved: approved ? versionSummary(db, approved) : null,
        pending: pending ? { ...versionSummary(db, pending), can_decide: approverStatus(db, pending, actor.personId, rights).eligible } : null,
        served_to_ai: !!approved && present && !!skillNode(agentView, lib.folder_id, name),
        uses_7d: approved ? usageCount(db, qname) : 0,
      })
    }
  }
  return {
    skills: items,
    libraries: libs.map((l) => ({ id: l.folder_id, slug: l.slug, vpath: rights.vpath(rights.folders.get(l.folder_id)!), by: nameOf(db, l.by_person), at: l.at,
      no_ai: rights.flagged(rights.folders.get(l.folder_id)!) })),
    can_designate: actor.admin,
    step_up: stepUpMethod(w, actor.personId),
  }
}

/** A version this person may look at (else 404). */
function visibleVersion(w: WebCtx, actor: Actor, id: number): VersionRow {
  const v = versionById(w.db, id)
  if (!v || !libraryOf(w.db, v.library_id) || !canSeeSkill(w.db, actor, new Rights(w.db), v.library_id, v.name)) throw notFound()
  return v
}

const DIFF_BYTES = 256 * 1024
const textOf = (b: Uint8Array) => b.subarray(0, 8000).includes(0) ? null : new TextDecoder().decode(b.subarray(0, DIFF_BYTES))

/** GET /api/skills/versions/:id — the version, what changed against the approved one, and whether this person decides it. */
export function versionView(w: WebCtx, actor: Actor, id: number) {
  const v = visibleVersion(w, actor, id)
  const lib = libraryOf(w.db, v.library_id)!
  const approved = approvedOf(w.db, v.library_id, v.name)
  const base = approved && approved.id !== v.id ? approved : null
  const before = new Map((base ? manifestOf(base) : []).map((f) => [f.path, f]))
  const after = new Map(manifestOf(v).map((f) => [f.path, f]))
  const files: { path: string; change: 'added' | 'removed' | 'changed' | 'same'; size: number; diff: string | null; binary: boolean }[] = []
  let budget = DIFF_BYTES * 4
  for (const p of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const a = before.get(p), b = after.get(p)
    const change = !a ? 'added' : !b ? 'removed' : a.sha256 === b.sha256 ? 'same' : 'changed'
    let diff: string | null = null, binary = false
    if (change !== 'same' && budget > 0) {
      const ta = a ? textOf(snapshotFile(w.dataDir, base!, p)!.bytes) : ''
      const tb = b ? textOf(snapshotFile(w.dataDir, v, p)!.bytes) : ''
      if (ta === null || tb === null || /\.(pdf|docx|xlsx|pptx|hwpx?|zip)$/i.test(p)) binary = true
      else { diff = unifiedDiff(ta, tb, a ? `approved/${p}` : '/dev/null', b ? `pending/${p}` : '/dev/null'); budget -= diff.length }
    }
    files.push({ path: p, change, size: (b ?? a)!.size, diff, binary })
  }
  const el = approverStatus(w.db, v, actor.personId)
  return {
    qname: `${lib.slug}/${v.name}`, name: v.name, ...versionSummary(w.db, v), description: v.description, frontmatter: JSON.parse(v.frontmatter),
    warnings: v.warnings ? JSON.parse(v.warnings) : [], approved: base ? versionSummary(w.db, base) : null, files,
    can_decide: el.eligible, why_not: el.eligible ? null : el.why, approvers_exist: v.status === 'pending' ? eligibleApprovers(w.db, v).length > 0 : null,
    step_up: stepUpMethod(w, actor.personId),
  }
}

/** The pending version this person may decide now, at this digest (else 404 / 409 / 403). */
function decidable(w: WebCtx, actor: Actor, id: number, digest: unknown): VersionRow {
  const v = visibleVersion(w, actor, id)
  if (v.status !== 'pending') throw new ApiError(409, 'not_pending', `this version is ${v.status}`)
  if (digest !== v.digest) throw new ApiError(409, 'digest_mismatch', 'this approval is for another version of the skill; reload the page')
  const el = approverStatus(w.db, v, actor.personId)
  if (!el.eligible) throw new ApiError(403, 'not_eligible', `you cannot approve this version (${el.why})`)
  return v
}

const binding = (sessionHash: string, personId: number, v: VersionRow): StepUpBinding => ({ sessionHash, personId, approvalId: -v.id, sha256: v.digest })

export async function stepUpOptions(op: Op, sessionHash: string, id: number, body: { digest?: unknown }) {
  const v = decidable(op.w, op.actor, id, body.digest)
  const m = stepUpMethod(op.w, op.actor.personId)
  if (!m.method) throw new ApiError(409, m.missing === 'passkey' ? 'passkey_required' : 'totp_required',
    m.missing === 'passkey' ? 'approving needs a passkey on this server: add one in Settings' : 'approving needs an authenticator app (this server has no public https address for passkeys): set one up in Settings')
  if (m.method === 'totp') return { method: 'totp' }
  return { method: 'passkey', options: await passkeyAssertionOptions(op.w.db, pkConfig(op.w)!, op.actor.personId, 'stepup', stepUpChallengeBinding(binding(sessionHash, op.actor.personId, v))) }
}

export async function stepUp(op: Op, sessionHash: string, id: number, body: { digest?: unknown; response?: unknown; code?: unknown }) {
  const { w, actor } = op
  const key = `stepup:${actor.personId}`
  if (w.loginByName.blocked(key)) throw new ApiError(429, 'rate_limited', 'too many tries; wait a few minutes', { 'retry-after': String(w.loginByName.retryAfter(key)) })
  const v = decidable(w, actor, id, body.digest)
  const m = stepUpMethod(w, actor.personId)
  const b = binding(sessionHash, actor.personId, v)
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

export function approve(op: Op, sessionHash: string, id: number, body: { digest?: unknown; assertion?: unknown }) {
  const { w, actor } = op
  const v = decidable(w, actor, id, body.digest)
  if (!consumeStepUp(w.db, body.assertion, binding(sessionHash, actor.personId, v)))
    throw new ApiError(403, 'step_up_required', 'confirm with your passkey (or code) for this approval; each approval needs its own')
  const lib = libraryOf(w.db, v.library_id)!
  let r: VersionRow
  try {
    w.db.transaction(() => {
      r = approveVersion(w.db, w.dataDir, v.id, actor.personId, body.digest)
      record(w.db, actor.personId, `approve skill ${lib.slug}/${v.name} sha256:${v.digest}`)
    })()
  } catch (e) { return asApi(e) }
  return { ok: true, status: r!.status }
}

export function reject(op: Op, id: number, body: { reason?: unknown }) {
  const { w, actor } = op
  const v = visibleVersion(w, actor, id)
  const lib = libraryOf(w.db, v.library_id)!
  let r: VersionRow
  try {
    w.db.transaction(() => {
      r = rejectVersion(w.db, v.id, actor.personId, body.reason)
      record(w.db, actor.personId, `reject skill ${lib.slug}/${v.name} sha256:${v.digest}`)
    })()
  } catch (e) { return asApi(e) }
  return { ok: true, status: r!.status }
}

/** GET /api/skills/download?name=slug/name — the approved skill as <name>/… in a zip (for claude.ai / ChatGPT upload). */
export function download(w: WebCtx, actor: Actor, url: URL) {
  const q = url.searchParams.get('name') ?? ''
  const [slug, name, ...extra] = q.split('/')
  const lib = libraries(w.db).find((l) => l.slug === slug)
  if (!lib || !name || extra.length || !canSeeSkill(w.db, actor, new Rights(w.db), lib.folder_id, name)) throw notFound()
  const v = approvedOf(w.db, lib.folder_id, name)
  if (!v) throw notFound()
  const blobs = skillBlobs(w.dataDir)
  const bytes = zip(manifestOf(v).map((f) => ({ name: `${name}/${f.path}`, bytes: blobs.get(f.sha256) })))
  record(w.db, actor.personId, `skills download ${lib.slug}/${name} sha256:${v.digest}`)
  return new Response(bytes, { headers: { 'content-type': 'application/zip', 'cache-control': 'no-store', 'content-disposition': `attachment; filename="${name}.zip"` } })
}

/** PUT /api/skills/libraries — Admin: make a folder (by id, or by the path the admin sees) a skill library. */
export function designateFromWeb(op: Op, body: { folder_id?: unknown; path?: unknown; slug?: unknown }) {
  if (!op.actor.admin) throw forbidden('only an admin makes a folder a skill library')
  const db = op.w.db
  const rights = new Rights(db)
  let f = typeof body.folder_id === 'number' ? rights.folders.get(body.folder_id) : undefined
  if (!f && typeof body.path === 'string') f = folderByVpath(db, body.path) ?? undefined
  if (!f || !new Rights(db).canSee(op.actor, f)) throw notFound()
  let lib
  try {
    db.transaction(() => {
      lib = designate(db, f!, body.slug, op.actor.personId)
      record(db, op.actor.personId, `skills library ${new Rights(db).vpath(f!) ?? f!.path} as "${lib.slug}"`)
    })()
  } catch (e) { return asApi(e) }
  return { ok: true, library: lib }
}

export function undesignateFromWeb(op: Op, folderId: number) {
  if (!op.actor.admin) throw forbidden('only an admin changes skill libraries')
  const db = op.w.db
  const lib = libraryOf(db, folderId)
  if (!lib) throw notFound()
  db.transaction(() => {
    undesignate(db, folderId)
    record(db, op.actor.personId, `skills library off ${lib.slug}`)
  })()
  return { ok: true }
}

