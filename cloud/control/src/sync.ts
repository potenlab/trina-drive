// Member sync, console → drive (docs/SSO-CONTRACT.md "Member sync", review finding 5). After every membership change
// the console sends the team's WHOLE desired state (version 2) with a per-team, strictly increasing `seq`:
//
//   changed()   a membership change: member_version and sync_seq go up, contract events (member.removed,
//               invite.revoked, member.sessions_revoked) are recorded, a `sync_members` job is queued (runs within
//               seconds). sync_seq goes up here too, so an assertion signed after a re-add is "newer" than the
//               drive's last applied payload (the drive's reactivation rule).
//   run()       builds the payload at send time (a fresh seq; the current members, open invites and undelivered
//               events) and runs `tdrive cloud sync-members --json <base64url>` in the team's container. Applied →
//               events delivered, accepted invites linked, synced_version caught up. Stale with a newer drive seq
//               (a restored control database) → our seq jumps past it and the job runs again at once. A failure is
//               retried with backoff until it succeeds (cloud.ts runDueJobs never gives a sync job up); Members shows
//               a pending removal in red meanwhile and ops hear about it after 5 tries.
//   gate()      the last step of wake / resume (cloud.ts): when the drive is behind (pending changes or events), it
//               must apply the sync before the team counts as running — otherwise the container is stopped again and
//               the wake retried. serveHooks let operations (G1) hold traffic (Caddy 503) until then.
//   usage()     hourly `tdrive cloud usage --json` → team_usage (Plan & usage).
//   A team that is not running gets nothing (its gate syncs it when it starts); once a day every running team is
//   sent its state again (reconciliation).
import { audit } from './audit'
import { CloudError, type Cloud } from './cloud'
import { teamById, type TeamRow } from './db'
import { invitePublicId } from './invites'
import { userPublicId } from './team-members'

export interface SyncEvent { type: 'member.removed' | 'member.sessions_revoked' | 'invite.revoked'; cloud_user?: string; invite?: string; reason?: string }

export interface SyncMember { cloud_user: string | null; invite: string | null; email: string; name: string; role: 'owner' | 'admin' | 'member'; status: 'active' | 'invited' }
export interface SyncPayload {
  version: 2; team: string; seq: number; at: number; members: SyncMember[]
  events: ({ id: string; type: string; at: number } & Record<string, unknown>)[]
}

export type SyncOutcome =
  | { ok: true; applied: true; seq: number; created?: number; updated?: number; deactivated?: number; reactivated?: number; people?: number; unmanaged?: { name: string; admin: boolean; active: boolean }[] }
  | { ok: true; applied: false; seq: number; current_seq: number; reason: 'stale' }

/** Hooks around a team (re)start so traffic can be held until the drive has the current membership (G1: Caddy). */
export interface ServeHook { hold?: (cloud: Cloud, t: TeamRow) => Promise<void>; release?: (cloud: Cloud, t: TeamRow) => Promise<void> }
export const serveHooks: ServeHook[] = []

export const SYNC_DAILY_MS = 24 * 3600_000
export const USAGE_EVERY_MS = 3600_000

const eventId = (id: number) => `evt_${String(id).padStart(20, '0')}`

export class MemberSync {
  constructor(private readonly c: Cloud) {}
  private get db() { return this.c.db }
  get enabled() { return this.c.cfg.sso }

  /** A membership change of this team (call after the change is committed). */
  changed(teamId: number, events: SyncEvent[] = []) {
    const at = Date.now()
    this.db.transaction(() => {
      this.db.query('UPDATE teams SET member_version = member_version + 1, sync_seq = sync_seq + 1 WHERE id = ?').run(teamId)
      for (const e of events) this.db.query('INSERT INTO sync_events (team_id, type, cloud_user, invite, reason, at) VALUES (?, ?, ?, ?, ?, ?)').run(teamId, e.type, e.cloud_user ?? null, e.invite ?? null, e.reason ?? null, at)
    })()
    if (this.enabled) this.c.enqueue('sync_members', teamId)
  }

  /** Changes or events the drive does not have yet. */
  behind(t: Pick<TeamRow, 'id'>): boolean {
    const r = this.db.query<{ v: number; s: number }, [number]>('SELECT member_version AS v, synced_version AS s FROM teams WHERE id = ?').get(t.id)
    if (!r) return false
    return r.v > r.s || !!this.db.query('SELECT 1 FROM sync_events WHERE team_id = ? AND delivered_seq IS NULL LIMIT 1').get(t.id)
  }

  /** The payload with a fresh seq (and the bookkeeping to mark what it carried once applied). */
  build(t0: TeamRow): { payload: SyncPayload; version: number; eventIds: number[]; links: number[] } {
    return this.db.transaction(() => {
      this.db.query('UPDATE teams SET sync_seq = sync_seq + 1 WHERE id = ?').run(t0.id)
      const t = teamById(this.db, t0.id)!
      const seq = t.sync_seq
      const version = t.member_version
      const members: SyncMember[] = []
      const links: number[] = []
      const linkOf = new Map<number, number>()
      for (const inv of this.c.invites.forSync(t.id)) if (inv.accepted_at && inv.accepted_user_id) linkOf.set(inv.accepted_user_id, inv.id)
      for (const m of this.c.members.list(t.id)) {
        const inv = linkOf.get(m.user_id)
        if (inv) links.push(inv)
        members.push({ cloud_user: m.public_id ?? userPublicId(this.c, m.user_id), invite: inv ? invitePublicId(inv) : null, email: m.email, name: m.name ?? '', role: m.role, status: 'active' })
      }
      for (const inv of this.c.invites.open(t.id)) members.push({ cloud_user: null, invite: invitePublicId(inv.id), email: inv.email, name: '', role: inv.role, status: 'invited' })
      const evRows = this.db.query<{ id: number; type: string; cloud_user: string | null; invite: string | null; reason: string | null; at: number }, [number]>('SELECT id, type, cloud_user, invite, reason, at FROM sync_events WHERE team_id = ? AND delivered_seq IS NULL ORDER BY id').all(t.id)
      const events = evRows.map((e) => ({ id: eventId(e.id), type: e.type, ...(e.cloud_user ? { cloud_user: e.cloud_user } : {}), ...(e.invite ? { invite: e.invite } : {}), at: e.at, ...(e.reason ? { reason: e.reason } : {}) }))
      if (evRows.length) this.db.query(`UPDATE sync_events SET sent_seq = ? WHERE id IN (${evRows.map(() => '?').join(',')})`).run(seq, ...evRows.map((e) => e.id))
      return { payload: { version: 2 as const, team: t.public_id, seq, at: Date.now(), members, events }, version, eventIds: evRows.map((e) => e.id), links }
    })()
  }

  private running(t: TeamRow) { return !!t.host && ['active', 'past_due'].includes(t.status) }

  /** One send (the sync_members job; the gate). Throws when the drive did not take it (the job retries). */
  async run(t0: TeamRow, o: { force?: boolean } = {}): Promise<SyncOutcome | null> {
    if (!this.enabled) return null
    const t = teamById(this.db, t0.id)
    if (!t || !t.host) return null
    if (!o.force && !this.running(t)) return null
    const b = this.build(t)
    const arg = Buffer.from(JSON.stringify(b.payload), 'utf8').toString('base64url')
    const r = await this.c.driver.exec(t.host!, t.slug, ['cloud', 'sync-members', '--json', arg])
    let out: { ok?: boolean; applied?: boolean; current_seq?: number; error?: string; unmanaged?: unknown } | null = null
    try { out = JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '') } catch { out = null }
    if (r.code !== 0 || !out || out.ok !== true) {
      const why = out?.error ?? (r.stderr.trim().split('\n').at(-1) || `exit ${r.code}`)
      throw new CloudError('sync_failed', `member sync for ${t.slug} failed: ${why}`.slice(0, 500), 502)
    }
    if (out.applied === false) {
      const cur = Number(out.current_seq)
      if (Number.isFinite(cur) && cur >= b.payload.seq) {
        // the drive has seen a higher seq than we ever made (our database was restored): jump past it and send again
        this.db.query('UPDATE teams SET sync_seq = max(sync_seq, ?) WHERE id = ?').run(cur, t.id)
        audit(this.db, { actor: 'system', action: 'sync.seq_jumped', teamId: t.id, detail: { ours: b.payload.seq, drive: cur } })
        return this.run(t, o)
      }
      throw new CloudError('sync_failed', `member sync for ${t.slug}: stale without a newer seq`, 502)
    }
    const now = Date.now()
    this.db.transaction(() => {
      this.db.query('UPDATE teams SET sync_applied_seq = max(coalesce(sync_applied_seq, 0), ?), synced_version = max(synced_version, ?), sync_at = ?, sync_error = NULL, sync_failing_since = NULL, sync_unmanaged = ? WHERE id = ?')
        .run(b.payload.seq, b.version, now, Array.isArray(out!.unmanaged) && out!.unmanaged.length ? JSON.stringify(out!.unmanaged) : null, t.id)
      if (b.eventIds.length) this.db.query(`UPDATE sync_events SET delivered_seq = ? WHERE id IN (${b.eventIds.map(() => '?').join(',')})`).run(b.payload.seq, ...b.eventIds)
      if (b.links.length) this.db.query(`UPDATE invites SET linked_at = ? WHERE id IN (${b.links.map(() => '?').join(',')})`).run(now, ...b.links)
      this.db.query("UPDATE team_members SET synced_at = ? WHERE team_id = ? AND status = 'active'").run(now, t.id)
    })()
    // people the console does not manage (CLI, break-glass): told once per change of the list
    const before = t.sync_unmanaged
    const after = Array.isArray(out.unmanaged) && out.unmanaged.length ? JSON.stringify(out.unmanaged) : null
    if (after && after !== before) void this.c.alertOps(`${t.slug}: people the console does not manage`, `The drive reports accounts made outside the console (CLI, break-glass):\n${after}\n\nThey are not changed by member sync. Remove them on the drive if they are not expected.`)
    return out as SyncOutcome
  }

  /** A failed sync job: shown in Members (a pending removal in red). */
  failed(teamId: number, msg: string) {
    this.db.query('UPDATE teams SET sync_error = ?, sync_failing_since = coalesce(sync_failing_since, ?) WHERE id = ?').run(msg.slice(0, 500), Date.now(), teamId)
  }

  /** The last step of wake / resume: the drive applies the current state before the team counts as running.
   * Throws when it is behind and the sync fails (the caller stops the container again). */
  async gate(t: TeamRow) {
    if (!this.enabled) return
    for (const h of serveHooks) await h.hold?.(this.c, t)
    try {
      await this.run(t, { force: true })
    } catch (e) {
      this.failed(t.id, (e as Error).message)
      if (this.behind(t)) throw e
      this.c.log(`${t.slug}: member sync after start failed (nothing pending): ${(e as Error).message}`)
    }
    for (const h of serveHooks) await h.release?.(this.c, t)
  }

  /** Pending removals the drive has not applied yet (Members shows them in red). */
  pendingRemovals(teamId: number): string[] {
    return this.db.query<{ cloud_user: string }, [number]>("SELECT cloud_user FROM sync_events WHERE team_id = ? AND type = 'member.removed' AND delivered_seq IS NULL AND cloud_user IS NOT NULL").all(teamId).map((r) => r.cloud_user)
  }

  /** Daily reconciliation and the hourly usage poll (cloud.scheduleBackups calls this every 10 minutes). */
  schedule() {
    if (!this.enabled) return
    const now = Date.now()
    for (const t of this.db.query<{ id: number }, [number]>("SELECT id FROM teams WHERE status IN ('active', 'past_due') AND host IS NOT NULL AND coalesce(sync_at, 0) < ?").all(now - SYNC_DAILY_MS)) {
      if (!this.db.query("SELECT 1 FROM jobs WHERE kind = 'sync_members' AND team_id = ? AND done_at IS NULL").get(t.id)) this.c.enqueue('sync_members', t.id)
    }
    for (const t of this.db.query<{ id: number }, [number]>("SELECT id FROM teams WHERE status IN ('active', 'past_due') AND host IS NOT NULL AND coalesce(usage_checked_at, 0) < ?").all(now - USAGE_EVERY_MS)) {
      if (!this.db.query("SELECT 1 FROM jobs WHERE kind = 'usage' AND team_id = ? AND done_at IS NULL").get(t.id)) this.c.enqueue('usage', t.id)
    }
  }

  /** `tdrive cloud usage --json` → team_usage. Never fails a job: an older drive without the command is just skipped. */
  async usage(t: TeamRow) {
    if (!this.enabled || !this.running(t)) return
    this.db.query('UPDATE teams SET usage_checked_at = ? WHERE id = ?').run(Date.now(), t.id)
    const r = await this.c.driver.exec(t.host!, t.slug, ['cloud', 'usage', '--json']).catch(() => null)
    if (!r || r.code !== 0) return
    let u: Record<string, unknown>
    try { u = JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '') } catch { return }
    const n = (k: string) => (typeof u[k] === 'number' && Number.isFinite(u[k]) ? (u[k] as number) : null)
    this.db.query(`INSERT INTO team_usage (team_id, at, people, ai_people_30d, files_bytes, trash_bytes, versions_bytes, quota_bytes, last_activity_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (team_id) DO UPDATE SET at = excluded.at, people = excluded.people, ai_people_30d = excluded.ai_people_30d, files_bytes = excluded.files_bytes,
      trash_bytes = excluded.trash_bytes, versions_bytes = excluded.versions_bytes, quota_bytes = excluded.quota_bytes, last_activity_at = excluded.last_activity_at`)
      .run(t.id, Date.now(), n('people'), n('ai_people_30d'), n('files_bytes'), n('trash_bytes'), n('versions_bytes'), n('quota_bytes'), n('last_activity_at'))
  }
}
