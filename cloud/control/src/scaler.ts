// The scaler: how many team hosts run. Trina Cloud sits at 0 hosts until a paid team needs one (hold mode); then
//
//   scale-out  a team that finds no host with room waits in `provisioning` (its job retries without using up its
//              attempts); the scaler raises the pool's desired count by what the waiting teams need (bounded by
//              TDCLOUD_MAX_HOSTS and the pool's own max), counts hosts that are still booting as capacity so concurrent
//              sign-ups launch no more hosts than needed, and marks a host `ready` only when its bootstrap has finished
//              (the host says so). A host that does not finish booting in time is terminated and launched again; after
//              three such failures in a row scale-out stops and ops are alerted (`hosts resume`). The host limit
//              reached: the team keeps waiting and ops are alerted. TDCLOUD_SPARE_SLOTS keeps free slots ahead.
//   scale-in   a ready host that no team row names (suspended, failed and half-made teams count: their data is there)
//              for TDCLOUD_EMPTY_HOST_GRACE is marked `draining` (no team can be placed on it any more), asked whether
//              it holds any team directory or container (none, and reachable, or it is kept), then terminated through
//              the pool with the desired count lowered, and its data volume deleted. Never while a team waits, one host
//              per pass, never below the spare slots, never a host marked keep.
//
// One pass at a time: passes in this process are chained, and a lease in the database keeps a second process (the
// admin CLI's `hosts scale`, a second control container during a restart) out while one runs. Placing a team on a host
// (`claim`) and marking a host draining are each one SQLite transaction, so a team is never put on a host that is
// being scaled in.
import { audit } from './audit'
import type { Config } from './config'
import { teamById, updateTeam, type DB, type HostRow, type HostState, type TeamRow } from './db'
import type { HostPool } from './drivers/types'
import { planOf, SLOTS_SQL } from './plans'
import { iso, random } from './util'

/** boot failures in a row after which scale-out stops until `hosts resume` */
export const MAX_BOOT_FAILURES = 3
/** a booting host is asked at most this often whether its bootstrap is done */
export const PROBE_EVERY_MS = 15_000
const LEASE_MS = 5 * 60_000
/** after this long without its volume deleted, a terminated host is reported */
const CLEANUP_ALERT_MS = 3600_000

export interface ScalerDeps {
  cfg: Config
  db: DB
  pool: HostPool
  alert: (subject: string, text: string) => Promise<void>
  log: (s: string) => void
  clock?: () => number
}

export interface HostView extends HostRow { used: number; free: number; capacity: number; teams: string[] }

export interface PassResult {
  skipped?: 'busy'
  desired: number
  launched: number
  ready: string[]
  replaced: string[]
  terminated: string[]
}

const fmtMs = (ms: number) => (ms % 3600_000 === 0 ? `${ms / 3600_000}h` : ms % 60_000 === 0 ? `${ms / 60_000}m` : `${Math.round(ms / 1000)}s`)

export class Scaler {
  private chain: Promise<unknown> = Promise.resolve()
  private readonly holder = `${process.pid}:${random(6)}`
  constructor(readonly d: ScalerDeps) {}

  get pool() { return this.d.pool }
  get capacity() { return this.d.cfg.maxTeamsPerHost }
  private now() { return (this.d.clock ?? Date.now)() }

  // ---------------------------------------------------------------- small state
  private kv(key: string): string | null {
    return this.d.db.query<{ value: string }, [string]>('SELECT value FROM kv WHERE key = ?').get(key)?.value ?? null
  }
  private setKv(key: string, value: string | null) {
    if (value === null) this.d.db.query('DELETE FROM kv WHERE key = ?').run(key)
    else this.d.db.query('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(key, value, this.now())
  }
  /** an alert sent once until `clear(key)` */
  private async alertOnce(key: string, subject: string, text: string) {
    if (this.kv(`alert.${key}`)) return
    this.setKv(`alert.${key}`, String(this.now()))
    await this.d.alert(subject, text)
  }
  private clear(key: string) { this.setKv(`alert.${key}`, null) }

  get bootFailures() { return Number(this.kv('boot_failures') ?? 0) }
  /** clears the stop after repeated boot failures (`hosts resume`) */
  resume() { this.setKv('boot_failures', null); this.clear('breaker') }

  private host(id: string) { return this.d.db.query<HostRow, [string]>('SELECT * FROM hosts WHERE id = ?').get(id) }
  private setHost(id: string, f: Partial<Omit<HostRow, 'id'>>) {
    const keys = Object.keys(f)
    for (const k of keys) if (!/^[a-z_]+$/.test(k)) throw new Error(`bad column ${k}`)
    this.d.db.query(`UPDATE hosts SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...keys.map((k) => (f as Record<string, string | number | null>)[k] ?? null), this.now(), id)
  }

  /** Slots in use per host: every team row that names it and is not deleted. Suspended teams, failed and half-made
   * ones count: their data is on the host. */
  usedSlots(): Map<string, { used: number; teams: string[] }> {
    const m = new Map<string, { used: number; teams: string[] }>()
    for (const r of this.d.db.query<{ host: string; slug: string; slots: number }, []>(`SELECT host, slug, ${SLOTS_SQL} AS slots FROM teams WHERE host IS NOT NULL AND status != 'deleted' ORDER BY id`).all()) {
      const e = m.get(r.host) ?? { used: 0, teams: [] }
      e.used += r.slots; e.teams.push(r.slug)
      m.set(r.host, e)
    }
    return m
  }

  /** paid teams with no host yet */
  waiting(): TeamRow[] {
    return this.d.db.query<TeamRow, []>("SELECT * FROM teams WHERE status = 'provisioning' AND host IS NULL ORDER BY id").all()
  }

  /** Something is in motion (a team waits, a host boots or is going away): the loop runs passes more often. */
  urgent(): boolean {
    return !!this.d.db.query("SELECT 1 FROM teams WHERE status = 'provisioning' AND host IS NULL LIMIT 1").get()
      || !!this.d.db.query("SELECT 1 FROM hosts WHERE state IN ('booting', 'draining', 'terminating') LIMIT 1").get()
  }

  /** A host for this team, chosen and written in one transaction: the fullest ready host that still has room (hosts
   * fill up one after another, so the others empty out and can be scaled in). null: none has room (yet). */
  claim(t: TeamRow): string | null {
    const need = planOf(t.plan).slots
    return this.d.db.transaction(() => {
      const cur = teamById(this.d.db, t.id)
      if (!cur) return null
      if (cur.host) return cur.host
      const used = this.usedSlots()
      const fits = this.d.db.query<HostRow, []>("SELECT * FROM hosts WHERE state = 'ready' AND online = 1").all()
        .map((h) => ({ id: h.id, used: used.get(h.id)?.used ?? 0 }))
        .filter((h) => h.used + need <= this.capacity)
        .sort((a, b) => b.used - a.used || (a.id < b.id ? -1 : 1))
      const pick = fits[0]
      if (!pick) return null
      updateTeam(this.d.db, t.id, { host: pick.id, waiting_since: null, wait_alerted_at: null })
      this.setHost(pick.id, { empty_since: null })
      return pick.id
    }).immediate()
  }

  /** hosts with their use, for `hosts list` and metrics (gone ones only with `all`) */
  view(all = false): HostView[] {
    const used = this.usedSlots()
    return this.d.db.query<HostRow, []>(`SELECT * FROM hosts ${all ? '' : "WHERE state != 'gone'"} ORDER BY first_seen, id`).all().map((h) => {
      const u = used.get(h.id) ?? { used: 0, teams: [] }
      const live = h.state === 'ready' || h.state === 'booting'
      return { ...h, used: u.used, teams: u.teams, capacity: this.capacity, free: live ? Math.max(0, this.capacity - u.used) : 0 }
    })
  }

  // ---------------------------------------------------------------- the pass
  /** One look at the pool: new hosts, booted hosts, scale-out, scale-in. Passes never overlap. */
  tick(): Promise<PassResult> {
    const run = this.chain.then(() => this.leased())
    this.chain = run.catch(() => {})
    return run
  }

  private lease(): boolean {
    return this.d.db.transaction(() => {
      const cur = this.kv('scaler.lease')
      const l = cur ? JSON.parse(cur) as { holder: string; until: number } : null
      if (l && l.holder !== this.holder && l.until > this.now()) return false
      this.setKv('scaler.lease', JSON.stringify({ holder: this.holder, until: this.now() + LEASE_MS }))
      return true
    }).immediate()
  }

  private async leased(): Promise<PassResult> {
    if (!this.lease()) return { skipped: 'busy', desired: -1, launched: 0, ready: [], replaced: [], terminated: [] }
    try {
      const r = await this.pass()
      this.clear('error')
      return r
    } catch (e) {
      const msg = (e as Error).message
      this.d.log(`scaler: ${msg}`)
      // the same error every few seconds is one alert
      if (this.kv('alert.error') && this.kv('scaler.last_error') === msg) throw e
      this.setKv('scaler.last_error', msg)
      this.clear('error')
      await this.alertOnce('error', 'host scaler failed', `${msg}\n\nThe scaler keeps trying; teams waiting for a host keep waiting. See \`hosts list\`.`)
      throw e
    } finally {
      const cur = this.kv('scaler.lease')
      if (cur && (JSON.parse(cur) as { holder: string }).holder === this.holder) this.setKv('scaler.lease', null)
    }
  }

  private async pass(): Promise<PassResult> {
    const { db, pool, cfg } = this.d
    const res: PassResult = { desired: 0, launched: 0, ready: [], replaced: [], terminated: [] }
    const st = await pool.status()
    const now = this.now()
    const live = new Map(st.instances.filter((i) => i.lifecycle !== 'terminating').map((i) => [i.id, i]))
    /** the pool's desired count as this pass leaves it */
    let poolDesired = st.desired
    let used = this.usedSlots()

    // 1. hosts the pool runs that the database does not know: booting (or ready, when teams already name it: a host
    //    from before the scaler, or a database restored from a copy)
    for (const i of live.values()) {
      const row = this.host(i.id)
      if (!row) {
        const inUse = used.has(i.id)
        db.query('INSERT INTO hosts (id, state, first_seen, ready_at, online, note, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(i.id, inUse ? 'ready' : 'booting', now, inUse ? now : null, i.online ? 1 : 0, inUse ? 'in use before the scaler saw it' : null, now)
        this.d.log(`scaler: host ${i.id} ${inUse ? 'in use' : 'booting'}`)
      } else if (row.online !== (i.online ? 1 : 0)) {
        this.setHost(i.id, { online: i.online ? 1 : 0 })
      }
    }

    // 2. hosts that left the pool
    for (const r of db.query<HostRow, []>("SELECT * FROM hosts WHERE state IN ('booting', 'ready', 'draining', 'terminating')").all()) {
      if (r.state === 'terminating') {
        if (st.instances.some((i) => i.id === r.id)) continue // still shutting down
        const volumes = JSON.parse(r.volumes ?? '[]') as string[]
        if (await pool.cleanup(r.id, volumes)) {
          this.setHost(r.id, { state: 'gone', note: `${r.note ?? ''}${volumes.length ? `; deleted ${volumes.join(', ')}` : ''}`.replace(/^; /, '') })
          audit(db, { actor: 'system', action: 'host.gone', detail: { host: r.id, volumes } })
        } else if (now - r.updated_at > CLEANUP_ALERT_MS) {
          await this.alertOnce(`cleanup.${r.id}`, `data volume of terminated host ${r.id} not deleted`, `Volumes ${volumes.join(', ')} are still attached or could not be deleted an hour after the host was terminated.`)
        }
        continue
      }
      if (live.has(r.id)) continue
      const u = used.get(r.id)
      if (u) {
        this.setHost(r.id, { state: 'lost', note: `left the pool with ${u.teams.join(', ')}` })
        audit(db, { actor: 'system', action: 'host.lost', detail: { host: r.id, teams: u.teams } })
        await this.d.alert(`host ${r.id} is gone with ${u.teams.length} team(s)`, `The host left the pool (terminated outside the control plane, or replaced by the Auto Scaling group after a failed health check) while these teams were on it: ${u.teams.join(', ')}.\n\nTheir data volume is kept on termination. Restore them (README, "Restore a team").`)
      } else {
        this.setHost(r.id, { state: 'gone', note: r.note ?? 'left the pool' })
      }
    }

    // 3. booting hosts: finished, or too slow
    for (const r of db.query<HostRow, []>("SELECT * FROM hosts WHERE state = 'booting' AND keep = 0").all()) {
      const inst = live.get(r.id)
      if (!inst) continue
      if (now - r.first_seen > cfg.hostBootTimeoutMs) {
        // terminated with the desired count lowered: the scale-out below launches the replacement if still needed
        if (await this.bootFailed(r)) { res.replaced.push(r.id); live.delete(r.id); poolDesired = Math.max(0, poolDesired - 1) }
        continue
      }
      if (!inst.online || (r.last_probe != null && now - r.last_probe < (pool.probeEveryMs ?? PROBE_EVERY_MS))) continue
      const p = await pool.probe(r.id)
      this.setHost(r.id, { last_probe: now })
      if (p?.ready) {
        this.setHost(r.id, { state: 'ready', ready_at: now, empty_since: now, public_ip: p.publicIp, note: null })
        this.setKv('boot_failures', null)
        this.clear('breaker')
        // first_seen is the first pass that saw the instance (a few seconds after its launch)
        const s = Math.round((now - r.first_seen) / 1000)
        audit(db, { actor: 'system', action: 'host.ready', detail: { host: r.id, booting_s: s, ip: p.publicIp } })
        this.d.log(`scaler: host ${r.id} ready (${s} s after it was first seen booting)`)
        res.ready.push(r.id)
      }
    }

    // 4. who is empty since when
    used = this.usedSlots()
    for (const r of db.query<HostRow, []>("SELECT * FROM hosts WHERE state = 'ready'").all()) {
      const busy = (used.get(r.id)?.used ?? 0) > 0
      if (busy && r.empty_since != null) this.setHost(r.id, { empty_since: null })
      if (!busy && r.empty_since == null) this.setHost(r.id, { empty_since: now })
    }

    // 5. scale-out: place the waiting teams on free slots (ready hosts, hosts booting, launches the pool has not
    //    started yet), the rest on new hosts; then the spare slots
    const cap = this.capacity
    const waiting = this.waiting()
    const hosts = db.query<HostRow, []>("SELECT * FROM hosts WHERE state IN ('ready', 'booting')").all()
    const bins: number[] = [
      ...hosts.filter((h) => h.state === 'ready' && h.online).map((h) => Math.max(0, cap - (used.get(h.id)?.used ?? 0))),
      ...hosts.filter((h) => h.state === 'booting' && live.has(h.id)).map(() => cap),
      ...Array.from({ length: Math.max(0, poolDesired - live.size) }, () => cap),
    ]
    const fresh: number[] = []
    const items = waiting.map((t) => ({ t, slots: planOf(t.plan).slots })).sort((a, b) => b.slots - a.slots)
    for (const { t, slots } of items) {
      if (slots > cap) {
        await this.alertOnce(`oversize.${t.id}`, `team ${t.slug} does not fit on any host`, `It needs ${slots} slots; a host has TDCLOUD_MAX_TEAMS_PER_HOST = ${cap}.`)
        continue
      }
      const pickIn = (b: number[]) => b.map((f, i) => [f, i] as const).filter(([f]) => f >= slots).sort((x, y) => x[0] - y[0])[0]?.[1]
      const i = pickIn(bins)
      if (i !== undefined) { bins[i]! -= slots; continue }
      const j = pickIn(fresh)
      if (j !== undefined) fresh[j]! -= slots
      else fresh.push(cap - slots)
    }
    let need = fresh.length
    const freeAfter = [...bins, ...fresh].reduce((a, b) => a + b, 0)
    if (freeAfter < cfg.spareSlots) need += Math.ceil((cfg.spareSlots - freeAfter) / cap)
    const limit = Math.min(cfg.maxHosts, st.max)
    let desired = poolDesired, maintained = false
    if (need > 0) {
      const target = Math.min(limit, poolDesired + need)
      if (this.bootFailures >= MAX_BOOT_FAILURES) {
        await this.alertOnce('breaker', 'host scale-out stopped', `${this.bootFailures} hosts in a row did not finish their bootstrap within ${fmtMs(cfg.hostBootTimeoutMs)}; no more are launched. Waiting: ${waiting.map((t) => t.slug).join(', ') || '(only spare slots)'}.\n\nCheck /var/log/tdcloud-bootstrap.log on a new host (the launch template, the images, the Elastic IP pool), then: hosts resume`)
      } else if (target > poolDesired) {
        if (pool.maintain) await pool.maintain(target, st)
        maintained = true
        await pool.setDesired(target)
        desired = target
        res.launched = target - poolDesired
        audit(db, { actor: 'system', action: 'hosts.scale_out', detail: { from: poolDesired, to: target, waiting: waiting.map((t) => t.slug), spare: cfg.spareSlots } })
        this.d.log(`scaler: desired ${poolDesired} → ${target} (waiting: ${waiting.map((t) => t.slug).join(', ') || '-'})`)
      }
      if (poolDesired + fresh.length > limit && fresh.length > 0) {
        await this.alertOnce('limit', 'host limit reached: a team is waiting', `Teams waiting for a host: ${waiting.map((t) => t.slug).join(', ')}. The pool runs ${st.desired} host(s); the limit is ${limit} (TDCLOUD_MAX_HOSTS = ${cfg.maxHosts}, the Auto Scaling group's max = ${st.max}).\n\nThey keep waiting and start as soon as there is room: raise TDCLOUD_MAX_HOSTS (and host_max in Terraform; mind the vCPU quota), or free a slot.`)
      }
    }
    if (poolDesired + fresh.length <= limit || fresh.length === 0) this.clear('limit')

    // 6. scale-in: one empty host per pass, only when nobody waits and nothing was launched just now
    if (!waiting.length && !res.launched) {
      const gone = await this.scaleIn(desired, used)
      if (gone) { res.terminated.push(gone); desired = Math.max(0, desired - 1) }
    }
    if (pool.maintain && !maintained) await pool.maintain(desired, st)
    res.desired = desired
    return res
  }

  /** A host that never finished its bootstrap: terminated (desired lowered); the next pass launches another if a team
   * still needs one. Returns true when it was terminated. */
  private async bootFailed(r: HostRow): Promise<boolean> {
    const p = await this.d.pool.probe(r.id)
    if (p && p.teams > 0) {
      this.setHost(r.id, { keep: 1, note: 'team data on a host that never finished booting: kept' })
      await this.d.alert(`host ${r.id}: team data, but no bootstrap`, `The host has ${p.teams} team directories/containers but never reported its bootstrap done. It is kept (hosts unkeep ${r.id} to let the scaler handle it again).`)
      return false
    }
    const failures = this.bootFailures + 1
    this.setKv('boot_failures', String(failures))
    const { volumes } = await this.d.pool.terminate(r.id)
    const note = `bootstrap not done within ${fmtMs(this.d.cfg.hostBootTimeoutMs)}`
    this.setHost(r.id, { state: 'terminating', volumes: JSON.stringify(volumes), note })
    audit(this.d.db, { actor: 'system', action: 'host.boot_failed', detail: { host: r.id, failures, volumes } })
    await this.d.alert(`host ${r.id} did not finish booting: replaced`, `${note}. It was terminated${failures < MAX_BOOT_FAILURES ? ' and another one is launched if a team still needs it' : ''} (failure ${failures} in a row; scale-out stops at ${MAX_BOOT_FAILURES}).\n\nLook at /var/log/tdcloud-bootstrap.log of the next host (aws ssm start-session).`)
    return true
  }

  /** Terminates the longest-empty host past the grace period, if every check agrees. Returns its id. */
  private async scaleIn(desired: number, used: Map<string, { used: number; teams: string[] }>): Promise<string | null> {
    const { db, pool, cfg } = this.d
    const now = this.now(), cap = this.capacity
    const ready = db.query<HostRow, []>("SELECT * FROM hosts WHERE state = 'ready' ORDER BY empty_since, id").all()
    const booting = db.query<{ n: number }, []>("SELECT count(*) AS n FROM hosts WHERE state = 'booting'").get()!.n
    const freeOf = (skip: string) => ready.filter((h) => h.id !== skip && h.online).reduce((a, h) => a + Math.max(0, cap - (used.get(h.id)?.used ?? 0)), 0) + booting * cap
    for (const h of ready) {
      if (h.keep || h.empty_since == null || used.has(h.id) || now - h.empty_since < cfg.emptyHostGraceMs) continue
      if (freeOf(h.id) < cfg.spareSlots) continue
      // no team can be placed on it from here on, and none names it now
      const marked = db.transaction(() => {
        const n = db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM teams WHERE host = ? AND status != 'deleted'").get(h.id)!.n
        if (n > 0) return false
        return db.query("UPDATE hosts SET state = 'draining', updated_at = ? WHERE id = ? AND state = 'ready'").run(now, h.id).changes === 1
      }).immediate()
      if (!marked) continue
      // the host's own view: no team directory, no team container — and it must answer
      const p = await pool.probe(h.id)
      if (!p || p.teams > 0) {
        this.setHost(h.id, { state: 'ready', ...(p ? { keep: 1, note: `${p.teams} team directories/containers that no team row names: kept` } : { note: 'did not answer before scale-in: kept for now' }) })
        if (p) await this.d.alert(`host ${h.id} holds team data the control plane does not know`, `The scaler was about to terminate ${h.id} (no team row names it, empty since ${iso(h.empty_since)}), but the host has ${p.teams} team directories/containers. It is kept and will not be scaled in (hosts unkeep ${h.id} after checking).`)
        continue
      }
      let volumes: string[]
      try {
        ({ volumes } = await pool.terminate(h.id))
      } catch (e) {
        this.setHost(h.id, { state: 'ready', note: `scale-in failed: ${(e as Error).message.slice(0, 200)}` })
        throw e
      }
      const note = `empty since ${iso(h.empty_since)}: scaled in`
      this.setHost(h.id, { state: 'terminating', volumes: JSON.stringify(volumes), note })
      audit(db, { actor: 'system', action: 'hosts.scale_in', detail: { host: h.id, empty_since: iso(h.empty_since), volumes, desired: desired - 1 } })
      this.d.log(`scaler: ${h.id} ${note}`)
      return h.id
    }
    return null
  }

  /** `hosts keep|unkeep <id>` */
  setKeep(id: string, keep: boolean): HostState {
    const h = this.host(id)
    if (!h) throw new Error(`no host ${id}`)
    this.setHost(id, { keep: keep ? 1 : 0, note: keep ? 'kept by the operator' : null })
    return h.state
  }
}
