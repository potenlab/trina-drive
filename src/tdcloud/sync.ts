// Member sync v2 (docs/SSO-CONTRACT.md "Member sync", test/fixtures/sso-v1.json member_sync): the console sends the
// whole desired membership of the team with a per-team, strictly increasing `seq`. Applied in one transaction, only
// when `seq` > meta.cloud_sync_seq (a retried old job can never undo a newer one). Removal cuts every credential:
// sessions, personal access tokens, OAuth grants, app passwords — so a person let back in later starts clean.
import { tellWidened, withRejudge, type Judgement } from '../share/rejudge'
import { appendAudit } from '../audit'
import type { DB } from '../db'
import { checkPeopleRoom, PeopleLimitError } from '../store'
import { revokeSessionsOf } from '../web/auth'
import type { Mailer } from '../web/mail'
import { ensureWebSchema, metaGet, metaSet } from '../web/schema'
import type { CloudConfig } from './config'
import { afterReconcile, reconcileMyFiles } from './my-files'
import {
  announceNewAdmins, byCloudUser, byInvite, closeSetupIfCloudAdmin, createCloudPerson, deactivate, inviteOnly, syncEveryone, unboundByEmail, unmanaged,
  type CloudPerson,
} from './people'

export const SYNC_VERSION = 2
export const EVENT_KEEP_MS = 30 * 86400_000

export interface SyncMember { cloud_user: string | null; invite: string | null; email: string; name: string; role: 'owner' | 'admin' | 'member'; status: 'active' | 'invited' }
export type SyncEvent =
  | { id: string; type: 'member.removed'; cloud_user: string; at: number }
  | { id: string; type: 'member.sessions_revoked'; cloud_user: string; at: number; reason?: string }
  | { id: string; type: 'invite.revoked'; invite: string; at: number }
export interface SyncPayload { version: number; team: string; seq: number; at: number; members: SyncMember[]; events: SyncEvent[] }

export type SyncResult =
  | { ok: true; applied: true; seq: number; created: number; updated: number; deactivated: number; reactivated: number; people: number; unmanaged: { name: string; admin: boolean; active: boolean }[] }
  | { ok: true; applied: false; seq: number; current_seq: number; reason: 'stale' }
  | { ok: false; error: 'bad_version' | 'wrong_team' | 'bad_json' | 'people_limit'; message: string }

class SyncError extends Error { constructor(readonly code: 'bad_version' | 'wrong_team' | 'bad_json' | 'people_limit', message: string) { super(message) } }

const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/
const CLOUD_USER = /^usr_[0-9a-f]{20}$/
const INVITE = /^inv_[A-Za-z0-9_-]{1,64}$/

/** Shape checks: anything off is bad_json (nothing is applied). */
export function parsePayload(raw: unknown, cfg: Pick<CloudConfig, 'team'>): SyncPayload {
  const p = raw as SyncPayload
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new SyncError('bad_json', 'the payload is not a JSON object')
  if (p.version !== SYNC_VERSION) throw new SyncError('bad_version', `version ${String(p.version)} (this drive takes ${SYNC_VERSION})`)
  if (p.team !== cfg.team) throw new SyncError('wrong_team', 'the payload is for another team')
  if (!Number.isSafeInteger(p.seq) || p.seq < 1 || !Array.isArray(p.members) || !Array.isArray(p.events ?? [])) throw new SyncError('bad_json', 'seq, members and events are required')
  const seenUsers = new Set<string>(), seenEmails = new Set<string>()
  for (const m of p.members) {
    const ok = m && typeof m === 'object' && typeof m.email === 'string' && m.email.length <= 254 && EMAIL.test(m.email) && typeof (m.name ?? '') === 'string'
      && ['owner', 'admin', 'member'].includes(m.role) && ['active', 'invited'].includes(m.status)
      && (m.cloud_user === null || (typeof m.cloud_user === 'string' && CLOUD_USER.test(m.cloud_user)))
      && (m.invite === null || m.invite === undefined || (typeof m.invite === 'string' && INVITE.test(m.invite)))
      && (m.status === 'active' ? m.cloud_user !== null : m.cloud_user === null && typeof m.invite === 'string')
    if (!ok) throw new SyncError('bad_json', `bad member entry ${JSON.stringify(m)?.slice(0, 120)}`)
    const e = m.email.toLowerCase()
    if ((m.cloud_user && seenUsers.has(m.cloud_user)) || seenEmails.has(e)) throw new SyncError('bad_json', `member listed twice: ${m.email}`)
    if (m.cloud_user) seenUsers.add(m.cloud_user)
    seenEmails.add(e)
  }
  for (const e of p.events ?? []) {
    const ok = e && typeof e === 'object' && typeof e.id === 'string' && e.id.length <= 64 && (
      ((e.type === 'member.removed' || e.type === 'member.sessions_revoked') && typeof e.cloud_user === 'string' && CLOUD_USER.test(e.cloud_user))
      || (e.type === 'invite.revoked' && typeof e.invite === 'string' && INVITE.test(e.invite)))
    if (!ok) throw new SyncError('bad_json', `bad event ${JSON.stringify(e)?.slice(0, 120)}`)
  }
  return { ...p, events: p.events ?? [] }
}

/** dataDir: where managed storage lives — given, My files follow the membership after the sync (src/tdcloud/my-files.ts) */
export interface SyncDeps { db: DB; cfg: Pick<CloudConfig, 'team'>; mailer: Mailer; baseUrl: string; now?: () => number; dataDir?: string }

/** My files after a sync (applied or not: it only follows what the database says now). Never fails the sync. */
async function followMyFiles(d: SyncDeps) {
  if (!d.dataDir) return
  try { await afterReconcile({ db: d.db, mailer: d.mailer, baseUrl: d.baseUrl }, reconcileMyFiles(d.db, d.dataDir)) }
  catch (e) { console.error(`[tdcloud] my files after sync: ${(e as Error).message}`) }
}

/** Apply one payload (already JSON-parsed). Never throws for the contract's errors: they come back as { ok: false }. */
export async function applySync(d: SyncDeps, raw: unknown): Promise<SyncResult> {
  const db = d.db
  ensureWebSchema(db)
  const now = d.now ?? Date.now
  let p: SyncPayload
  try { p = parsePayload(raw, d.cfg) } catch (e) { if (e instanceof SyncError) return { ok: false, error: e.code, message: e.message }; throw e }
  const counts = { created: 0, updated: 0, deactivated: 0, reactivated: 0 }
  const newAdmins: number[] = []
  let stale: number | null = null
  let widened: Judgement | null = null
  try {
    // the whole sync is one transaction with the R6 re-check of AI-draft copies (src/share/rejudge.ts): a console-side
    // membership change never opens a copy to people who cannot read its sources — such copies close until confirmed
    widened = withRejudge(db, () => {
      const current = Number(metaGet(db, 'cloud_sync_seq') ?? 0)
      if (p.seq <= current) { stale = current; return }
      const keep = new Set<number>()
      const touch = (before: CloudPerson | null, id: number, m: SyncMember) => {
        const admin = m.status === 'active' && (m.role === 'owner' || m.role === 'admin')
        const wasActive = !!before?.active
        // one more person on the plan: back from inactive, or an invite that became a member (invites do not count)
        if (before && m.status === 'active' && (!wasActive || inviteOnly(before))) checkPeopleRoom(db)
        if (before && !wasActive) counts.reactivated++
        if (before && (before.admin !== (admin ? 1 : 0) || before.email?.toLowerCase() !== m.email.toLowerCase() || before.cloud_user !== m.cloud_user || !wasActive)) counts.updated++
        if (admin && !(before?.admin && wasActive)) newAdmins.push(id)
        db.query('UPDATE people SET active = 1, admin = ?, display_name = ? WHERE id = ?').run(admin ? 1 : 0, m.name || null, id)
        if (m.cloud_user) db.query('UPDATE accounts SET cloud_user = ?, cloud_invite = NULL WHERE person_id = ?').run(m.cloud_user, id)
        else db.query('UPDATE accounts SET cloud_invite = ? WHERE person_id = ?').run(m.invite, id)
        // the console's confirmed address wins, unless another person here already has it
        if (before?.email?.toLowerCase() !== m.email.toLowerCase() && !db.query('SELECT 1 FROM accounts WHERE email = ? COLLATE NOCASE AND person_id != ?').get(m.email, id))
          db.query('UPDATE accounts SET email = ? WHERE person_id = ?').run(m.email, id)
        keep.add(id)
      }
      for (const m of p.members) {
        const found = (m.cloud_user ? byCloudUser(db, m.cloud_user) : null) ?? (m.invite ? byInvite(db, m.invite) : null) ?? unboundByEmail(db, m.email)
        if (found) { touch(found, found.id, m); continue }
        if (db.query('SELECT 1 FROM accounts WHERE email = ? COLLATE NOCASE').get(m.email)) continue // the address belongs to another console account here; the next sync settles it
        const admin = m.status === 'active' && (m.role === 'owner' || m.role === 'admin')
        const id = createCloudPerson(db, { email: m.email, displayName: m.name, admin, cloudUser: m.cloud_user, invite: m.cloud_user ? null : m.invite })
        counts.created++
        if (admin) newAdmins.push(id)
        keep.add(id)
      }
      // removal: every console-managed person not in the list (a member, or an invite that was withdrawn)
      const managed = db.query<{ id: number; active: number }, []>('SELECT p.id, p.active FROM people p JOIN accounts a ON a.person_id = p.id WHERE a.cloud_user IS NOT NULL OR a.cloud_invite IS NOT NULL').all()
      for (const x of managed) if (!keep.has(x.id) && x.active) { deactivate(db, x.id, `not a member in sync ${p.seq}`); counts.deactivated++ }
      // events: after the members, idempotent by id
      db.query('DELETE FROM cloud_sync_events WHERE applied_at < ?').run(now() - EVENT_KEEP_MS)
      for (const e of p.events) {
        if (db.query('INSERT OR IGNORE INTO cloud_sync_events (id, applied_at) VALUES (?, ?)').run(e.id, now()).changes !== 1) continue
        if (e.type === 'member.removed') {
          const x = byCloudUser(db, e.cloud_user)
          if (x && keep.has(x.id)) continue // listed again in this very payload: the list is the newer word
          if (x?.active) { deactivate(db, x.id, `removed in the console (${e.id})`); counts.deactivated++ }
          appendAudit(db, { personId: null, tokenId: null, tool: 'cloud', command: `member.removed ${x?.name ?? e.cloud_user} (${e.id})`, files: [], outcome: 'ok' })
        } else if (e.type === 'member.sessions_revoked') {
          const x = byCloudUser(db, e.cloud_user)
          if (x) {
            revokeSessionsOf(db, x.id)
            appendAudit(db, { personId: null, tokenId: null, tool: 'cloud', command: `sessions of ${x.name} revoked from the console (${e.reason ?? 'no reason given'}, ${e.id})`, files: [], outcome: 'ok' })
          }
        } else if (e.type === 'invite.revoked') {
          const x = byInvite(db, e.invite)
          if (x?.active && !keep.has(x.id)) { deactivate(db, x.id, `invite withdrawn (${e.id})`); counts.deactivated++ }
        }
      }
      syncEveryone(db)
      closeSetupIfCloudAdmin(db)
      metaSet(db, 'cloud_sync_seq', String(p.seq))
      metaSet(db, 'cloud_sync_applied_at', String(now()))
    }, { mode: 'membership', after: (j) => {
      if (stale !== null) return
      appendAudit(db, { personId: null, tokenId: null, tool: 'cloud', command: `member sync ${p.seq}: ${counts.created} created, ${counts.updated} updated, ${counts.deactivated} deactivated, ${counts.reactivated} reactivated${j.pending.length ? `, ${j.pending.length} AI-draft cop${j.pending.length === 1 ? 'y' : 'ies'} closed (widening)` : ''}`, files: [], outcome: 'ok' })
    } }).judgement
  } catch (e) {
    if (e instanceof PeopleLimitError) return { ok: false, error: 'people_limit', message: e.message }
    throw e
  }
  if (stale !== null) { await followMyFiles(d); return { ok: true, applied: false, seq: p.seq, current_seq: stale, reason: 'stale' } }
  await followMyFiles(d)
  await announceNewAdmins({ db, mailer: d.mailer, baseUrl: d.baseUrl }, newAdmins, `member sync ${p.seq}`)
  if (widened) await tellWidened({ db, mailer: d.mailer, baseUrl: d.baseUrl }, widened)
  const people = db.query<{ n: number }, []>('SELECT count(*) AS n FROM people p JOIN accounts a ON a.person_id = p.id WHERE p.active = 1 AND (a.cloud_user IS NOT NULL OR a.cloud_invite IS NOT NULL)').get()!.n
  return { ok: true, applied: true, seq: p.seq, ...counts, people, unmanaged: unmanaged(db) }
}

/** The CLI's input: base64url JSON (--json) or raw JSON (--stdin). Anything unreadable is bad_json. */
export function decodePayload(text: string, base64: boolean): unknown {
  try { return JSON.parse(base64 ? Buffer.from(text.trim(), 'base64url').toString('utf8') : text) } catch { return undefined }
}
