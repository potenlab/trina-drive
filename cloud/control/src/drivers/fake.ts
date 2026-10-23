// In-memory driver for unit tests: records calls, hands out fake setup tokens and backup files.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { BackupArtifact, CreateResult, Driver, ExecResult, InstanceState, TeamSpec } from './types'
import { DriverError } from './types'

export class FakeDriver implements Driver {
  readonly name = 'fake'
  readonly calls: string[] = []
  readonly instances = new Map<string, { state: InstanceState; spec: TeamSpec; setupDone: boolean; disk: number }>()
  failCreate = false
  constructor(private readonly dir?: string) {}
  async pickHost() { return 'fake-host' }
  async create(_host: string, spec: TeamSpec): Promise<CreateResult> {
    this.calls.push(`create ${spec.slug}`)
    if (this.failCreate) throw new DriverError('boom')
    if (this.instances.has(spec.slug)) throw new DriverError('exists')
    this.instances.set(spec.slug, { state: 'running', spec, setupDone: false, disk: 1000 })
    return { setupToken: `tdrive_setup_${crypto.randomBytes(18).toString('base64url')}`, productBackupSecret: `tdrive_bksec1_${spec.slug}`, publicIp: null }
  }
  private get(slug: string) { const i = this.instances.get(slug); if (!i) throw new DriverError(`no ${slug}`); return i }
  async start(_h: string, spec: TeamSpec) { this.calls.push(`start ${spec.slug}`); this.get(spec.slug).state = 'running' }
  async stop(_h: string, slug: string) { this.calls.push(`stop ${slug}`); this.get(slug).state = 'stopped' }
  async destroy(_h: string, slug: string) { this.calls.push(`destroy ${slug}`); this.instances.delete(slug) }
  async recreate(_h: string, spec: TeamSpec) { this.calls.push(`recreate ${spec.slug} ${spec.image}`); this.get(spec.slug).spec = spec; this.get(spec.slug).state = 'running' }
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
  async exec(_h: string, slug: string, args: string[]): Promise<ExecResult> { this.calls.push(`exec ${slug} ${args.join(' ')}`); return { code: 0, stdout: '', stderr: '' } }
}
