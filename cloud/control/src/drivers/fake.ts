// In-memory driver for unit tests: records calls, hands out fake setup tokens and backup files.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { BackupArtifact, BeforeServe, CreateResult, Driver, ExecResult, HostPool, HostProbe, InstanceState, PoolStatus, TeamSpec } from './types'
import { DriverError } from './types'

export class FakeDriver implements Driver {
  readonly name = 'fake'
  readonly calls: string[] = []
  readonly instances = new Map<string, { state: InstanceState; spec: TeamSpec; setupDone: boolean; disk: number }>()
  failCreate = false
  beforeServe: BeforeServe | null = null
  /** what `runOnHost` answers per host and argv[1] (e.g. 'info', 'check'); unset = exit 1 */
  readonly hostAnswers = new Map<string, ExecResult>()
  constructor(private readonly dir?: string) {}
  private async serve(host: string, spec: TeamSpec) {
    if (!this.beforeServe) return
    this.calls.push(`before-serve ${spec.slug}`)
    await this.beforeServe(host, spec)
  }
  async runOnHost(host: string, argv: string[]): Promise<ExecResult> {
    this.calls.push(`host ${host} ${argv.slice(1).join(' ')}`)
    return this.hostAnswers.get(`${host} ${argv[1] ?? ''}`) ?? this.hostAnswers.get(host) ?? { code: 1, stdout: '', stderr: 'unreachable' }
  }
  async pickHost() { return 'fake-host' }
  async create(_host: string, spec: TeamSpec): Promise<CreateResult> {
    this.calls.push(`create ${spec.slug}`)
    if (this.failCreate) throw new DriverError('boom')
    if (this.instances.has(spec.slug)) throw new DriverError('exists')
    this.instances.set(spec.slug, { state: 'running', spec, setupDone: false, disk: 1000 })
    await this.serve(_host, spec)
    return { setupToken: `tdrive_setup_${crypto.randomBytes(18).toString('base64url')}`, productBackupSecret: `tdrive_bksec1_${spec.slug}`, publicIp: null }
  }
  private get(slug: string) { const i = this.instances.get(slug); if (!i) throw new DriverError(`no ${slug}`); return i }
  async start(h: string, spec: TeamSpec) { this.calls.push(`start ${spec.slug}`); this.get(spec.slug).state = 'running'; await this.serve(h, spec) }
  async stop(_h: string, slug: string) { this.calls.push(`stop ${slug}`); this.get(slug).state = 'stopped' }
  async destroy(_h: string, slug: string) { this.calls.push(`destroy ${slug}`); this.instances.delete(slug) }
  async recreate(h: string, spec: TeamSpec) { this.calls.push(`recreate ${spec.slug} ${spec.image}`); this.get(spec.slug).spec = spec; this.get(spec.slug).state = 'running'; await this.serve(h, spec) }
  async setLimits(_h: string, spec: TeamSpec) { this.calls.push(`limits ${spec.slug} ${spec.plan.id}`); this.get(spec.slug).spec = spec }
  async reissueSetupToken(_h: string, spec: TeamSpec) { return this.get(spec.slug).setupDone ? null : `tdrive_setup_${crypto.randomBytes(18).toString('base64url')}` }
  async state(_h: string, slug: string) { return this.instances.get(slug)?.state ?? 'missing' }
  async diskUsage(_h: string, slug: string) { return this.instances.get(slug)?.disk ?? null }
  async backup(_h: string, spec: TeamSpec, o: { stamp: string }): Promise<BackupArtifact[]> {
    this.calls.push(`backup ${spec.slug}`)
    if (!this.dir) throw new DriverError('no dir')
    return (['product-db', 'files'] as const).map((part) => {
      const name = `${part}-${o.stamp}.bin`
      const p = path.join(this.dir!, `${spec.slug}-${name}`)
      fs.mkdirSync(this.dir!, { recursive: true })
      fs.writeFileSync(p, `${part} of ${spec.slug}`)
      return { part, name, bytes: fs.statSync(p).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'), localPath: p }
    })
  }
  /** what `tdrive activity --json` reports per team (ms; unset = never used); `activityFails` = the exec fails */
  readonly activity = new Map<string, number | null>()
  activityFails = false
  async exec(_h: string, slug: string, args: string[]): Promise<ExecResult> {
    this.calls.push(`exec ${slug} ${args.join(' ')}`)
    if (args[0] === 'activity') {
      if (this.activityFails || this.instances.get(slug)?.state !== 'running') return { code: 1, stdout: '', stderr: 'not running' }
      return { code: 0, stdout: JSON.stringify({ last_activity_at: this.activity.get(slug) ?? null, web: null, mcp: null, dav: null }) + '\n', stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
}

/** In-memory host pool for the scaler's tests: an ASG with instances i-1, i-2, … that become ready when the test says. */
export class FakePool implements HostPool {
  readonly name = 'fake pool'
  readonly calls: string[] = []
  desired = 0
  max = 10
  private next = 1
  readonly hosts = new Map<string, { ready: boolean; failBoot: boolean; online: boolean; teams: number; reachable: boolean }>()
  /** new hosts never finish their bootstrap */
  failBoots = false
  /** a setDesired call waits for this (races) */
  gate: Promise<void> | null = null
  private launch() {
    while (this.hosts.size < this.desired) this.hosts.set(`i-${this.next++}`, { ready: false, failBoot: this.failBoots, online: true, teams: 0, reachable: true })
  }
  async status(): Promise<PoolStatus> {
    this.launch()
    return { desired: this.desired, max: this.max, instances: [...this.hosts].map(([id, h]) => ({ id, lifecycle: 'in_service' as const, online: h.online })) }
  }
  async setDesired(n: number) {
    this.calls.push(`desired ${n}`)
    if (this.gate) await this.gate
    this.desired = Math.min(n, this.max)
    this.launch()
  }
  /** bootstrap done on every launched host (or one) */
  boot(id?: string) { for (const [k, h] of this.hosts) if (!id || k === id) if (!h.failBoot) h.ready = true }
  async probe(id: string): Promise<HostProbe | null> {
    const h = this.hosts.get(id)
    if (!h || !h.reachable) return null
    return { ready: h.ready, teams: h.teams, publicIp: null }
  }
  async terminate(id: string) {
    if (!this.hosts.has(id)) throw new DriverError(`no ${id}`)
    this.calls.push(`protection-off ${id}`, `terminate ${id} decrement`)
    this.hosts.delete(id)
    this.desired = Math.max(0, this.desired - 1)
    return { volumes: [`vol-${id}`] }
  }
  async cleanup(_id: string, volumes: string[]) { for (const v of volumes) this.calls.push(`delete-volume ${v}`); return true }
}
