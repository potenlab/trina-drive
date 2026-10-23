// One team = one container of the Trina Drive image, on its own bridge network, with its own data volume, its own
// uid, the bwrap security settings of docker-compose.yml, resource limits and no published ports (only the host's
// Caddy, joined to the team's network, reaches it). The same docker commands run on this machine (LocalRunner) or on
// an EC2 host through SSM (SsmRunner); HostLayout is what differs (named volume vs. XFS-quota directory, env file).
import type { PlanLimits } from '../plans'
import { DriverError, type BackupArtifact, type CreateResult, type Driver, type ExecResult, type InstanceState, type TeamSpec } from './types'

export interface RunOpts {
  stdin?: string
  /** stdout carries a secret (setup token, backup key): the SSM runner seals it to a one-time key in transit */
  secret?: boolean
  timeoutS?: number
}
export interface Runner {
  run(host: string, argv: string[], o?: RunOpts): Promise<ExecResult>
}

export interface HostLayout {
  /** --mount value for /data */
  dataMount(slug: string, readOnly?: boolean): string
  /** --mount value for /backup (the backup staging directory) */
  stagingMount(slug: string): string
  /** host path of the team's 0600 env file (read by the docker CLI, never shown on a command line) */
  envFile(slug: string): string
  seccomp: string
  apparmor: string
  /** directories / volume, disk quota, env file — before anything else */
  prepare(host: string, spec: TeamSpec): Promise<void>
  /** remove what prepare made (after the container and network are gone) */
  cleanup(host: string, slug: string): Promise<void>
  /** take the backup files out of staging (upload or hand to the control plane) */
  ship(host: string, slug: string, files: { part: BackupArtifact['part']; name: string }[], keyPrefix: string): Promise<BackupArtifact[]>
  publicIp(host: string): Promise<string | null>
}

export const names = (slug: string, number: number) => ({
  container: `tdc-${slug}`,
  network: `tdc-net-${slug}`,
  volume: `tdc-data-${slug}`,
  /** the bridge's interface on the host (the AWS hosts' iptables rules match tdcb+) */
  bridge: `tdcb${number}`,
})

export const SETUP_RE = /\b(\S+_setup_[A-Za-z0-9_-]{20,})\b/

/** docker run/create options shared by the server and every one-shot (docker-compose.yml + docs/DOCKER.md §6). */
export function securityArgs(l: Pick<HostLayout, 'seccomp' | 'apparmor'>, plan: PlanLimits): string[] {
  return [
    '--read-only',
    '--tmpfs', `/tmp:size=${plan.tmpMb}m,mode=1777,nosuid,nodev,noexec`,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true',
    '--security-opt', `seccomp=${l.seccomp}`,
    ...(l.apparmor ? ['--security-opt', `apparmor=${l.apparmor}`] : []),
    '--security-opt', 'systempaths=unconfined',
  ]
}

export function limitArgs(plan: PlanLimits): string[] {
  return ['--cpus', String(plan.cpus), '--memory', `${plan.memoryMb}m`, '--memory-swap', `${plan.memoryMb}m`, '--pids-limit', String(plan.pids)]
}

const labels = (spec: TeamSpec) => ['--label', `tdcloud.team=${spec.slug}`, '--label', `tdcloud.number=${spec.number}`]

export interface DockerDriverOptions {
  name: string
  runner: Runner
  layout: HostLayout
  /** the Caddy container on each host, joined to every team network */
  caddyContainer: string
  /** the control-plane image (it seals the files backup on the host: tar | seal) */
  helperImage: string
  pickHost: () => Promise<string>
  healthTimeoutS?: number
}

export class DockerDriver implements Driver {
  readonly name: string
  constructor(private readonly o: DockerDriverOptions) { this.name = o.name }

  pickHost() { return this.o.pickHost() }

  private async docker(host: string, argv: string[], o: RunOpts & { ok?: boolean; what?: string } = {}): Promise<ExecResult> {
    const r = await this.o.runner.run(host, ['docker', ...argv], o)
    if (o.ok !== false && r.code !== 0) throw new DriverError(`${o.what ?? `docker ${argv[0]}`} failed (exit ${r.code})`, r.stderr.slice(-2000))
    return r
  }

  /** `tdrive <args>` in a throwaway container on the team's volume (before the server runs). */
  private once(host: string, spec: TeamSpec, args: string[], o: RunOpts = {}) {
    const l = this.o.layout
    return this.docker(host, ['run', '--rm', '--network', 'none', '--user', `${spec.uid}:${spec.uid}`, '--mount', l.dataMount(spec.slug),
      '--env-file', l.envFile(spec.slug), ...securityArgs(l, spec.plan), ...labels(spec), spec.image, ...args], { ...o, what: `tdrive ${args.slice(0, 2).join(' ')}` })
  }

  async create(host: string, spec: TeamSpec): Promise<CreateResult> {
    const n = names(spec.slug, spec.number), l = this.o.layout
    if ((await this.state(host, spec.slug)) !== 'missing') throw new DriverError(`${n.container} already exists on ${host}`)
    await l.prepare(host, spec)
    await this.docker(host, ['network', 'create', '--driver', 'bridge', '--opt', `com.docker.network.bridge.name=${n.bridge}`, ...labels(spec), n.network], { what: 'network create' })
    // the team's uid owns its data and staging; only this one-shot runs as root, with just the capabilities chown needs
    await this.docker(host, ['run', '--rm', '--network', 'none', '--user', '0:0', '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'FOWNER', '--cap-add', 'DAC_OVERRIDE',
      '--security-opt', 'no-new-privileges:true', '--read-only', '--mount', l.dataMount(spec.slug), '--mount', l.stagingMount(spec.slug),
      '--entrypoint', '/bin/sh', spec.image, '-c', `chown ${spec.uid}:${spec.uid} /data /backup && chmod 0700 /data /backup`], { what: 'chown data' })
    const init = await this.once(host, spec, ['init'], { secret: true })
    const setupToken = SETUP_RE.exec(init.stdout)?.[1]
    if (!setupToken) throw new DriverError('tdrive init printed no setup token')
    // the OAuth issuer / MCP resource for claude.ai and ChatGPT connectors (src/oauth); passkeys' RP ID
    await this.once(host, spec, ['public', 'enable', '--url', spec.url])
    const key = await this.once(host, spec, ['backup', 'keygen', '--set'], { secret: true })
    const productBackupSecret = key.stdout.trim().split(/\s+/)[0] ?? ''
    if (!productBackupSecret) throw new DriverError('backup keygen printed no key')
    await this.docker(host, ['create', '--name', n.container, '--hostname', spec.slug, '--network', n.network, '--restart', 'unless-stopped',
      '--user', `${spec.uid}:${spec.uid}`, '--mount', l.dataMount(spec.slug), '--mount', l.stagingMount(spec.slug), '--env-file', l.envFile(spec.slug),
      ...securityArgs(l, spec.plan), ...limitArgs(spec.plan), ...labels(spec),
      '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3', '--stop-timeout', '30',
      spec.image, 'serve', '--host', '0.0.0.0', '--port', '8787', '--allow-origin', spec.url, '--public-url', spec.url], { what: 'create container' })
    await this.start(host, spec)
    return { setupToken, productBackupSecret, publicIp: await l.publicIp(host) }
  }

  async start(host: string, spec: TeamSpec) {
    const n = names(spec.slug, spec.number)
    await this.docker(host, ['start', n.container], { what: 'start' })
    await this.connectCaddy(host, n.network)
    await this.waitHealthy(host, n.container)
  }

  private async connectCaddy(host: string, network: string) {
    const r = await this.docker(host, ['network', 'connect', network, this.o.caddyContainer], { ok: false })
    if (r.code !== 0 && !/already exists|already attached|endpoint with name .* already/i.test(r.stderr)) throw new DriverError('connecting Caddy to the team network failed', r.stderr)
  }

  private async waitHealthy(host: string, container: string) {
    const deadline = Date.now() + (this.o.healthTimeoutS ?? 90) * 1000
    for (;;) {
      const r = await this.docker(host, ['inspect', '-f', '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}', container], { ok: false })
      const [status, health] = r.stdout.trim().split(' ')
      // the image's HEALTHCHECK starts after 30 s; /health answering through exec is the earlier signal
      if (status === 'running' && (health === 'healthy' || (await this.probe(host, container)))) return
      if (status === 'exited' || status === 'dead') throw new DriverError(`${container} stopped while starting`, (await this.docker(host, ['logs', '--tail', '40', container], { ok: false })).stderr)
      if (Date.now() > deadline) throw new DriverError(`${container} not healthy in time`)
      await Bun.sleep(1000)
    }
  }

  private async probe(host: string, container: string) {
    const r = await this.docker(host, ['exec', container, '/usr/local/bin/bun', '-e',
      "fetch('http://127.0.0.1:8787/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"], { ok: false })
    return r.code === 0
  }

  async stop(host: string, slug: string) {
    const r = await this.docker(host, ['stop', '-t', '30', `tdc-${slug}`], { ok: false })
    if (r.code !== 0 && !/No such container/i.test(r.stderr)) throw new DriverError('stop failed', r.stderr)
  }

  async destroy(host: string, slug: string) {
    const c = `tdc-${slug}`, net = `tdc-net-${slug}`
    await this.docker(host, ['rm', '-f', c], { ok: false })
    await this.docker(host, ['network', 'disconnect', '-f', net, this.o.caddyContainer], { ok: false })
    const r = await this.docker(host, ['network', 'rm', net], { ok: false })
    if (r.code !== 0 && !/not found|No such network/i.test(r.stderr)) throw new DriverError('network rm failed', r.stderr)
    await this.o.layout.cleanup(host, slug)
  }

  async setLimits(host: string, spec: TeamSpec) {
    await this.docker(host, ['update', ...limitArgs(spec.plan), `tdc-${spec.slug}`], { what: 'update limits' })
  }

  async reissueSetupToken(host: string, spec: TeamSpec) {
    const r = await this.exec(host, spec.slug, ['init'], { secret: true })
    if (r.code !== 0) throw new DriverError('tdrive init failed', r.stderr)
    return SETUP_RE.exec(r.stdout)?.[1] ?? null
  }

  async state(host: string, slug: string): Promise<InstanceState> {
    const r = await this.docker(host, ['inspect', '-f', '{{.State.Running}}', `tdc-${slug}`], { ok: false })
    if (r.code !== 0) return 'missing'
    return r.stdout.trim() === 'true' ? 'running' : 'stopped'
  }

  async diskUsage(host: string, slug: string): Promise<number | null> {
    const r = await this.docker(host, ['exec', `tdc-${slug}`, 'du', '-sb', '/data'], { ok: false })
    if (r.code !== 0) return null
    const n = Number(r.stdout.trim().split(/\s+/)[0])
    return Number.isFinite(n) ? n : null
  }

  async backup(host: string, spec: TeamSpec, o: { filesRecipient: string; stamp: string; keyPrefix: string }): Promise<BackupArtifact[]> {
    const c = `tdc-${spec.slug}`, l = this.o.layout
    if ((await this.state(host, spec.slug)) !== 'running') throw new DriverError(`${c} is not running`)
    // 1) the product's own archive: a consistent copy of the database + drafts, encrypted to the product backup key
    const r = await this.docker(host, ['exec', c, '/usr/local/bin/tdrive', 'backup', 'run', '--to', '/backup', '--allow-same-disk', '--keep', '1'], { what: 'product backup', timeoutS: 1800 })
    const m = /backup written: \/backup\/(\S+)/.exec(r.stdout)
    if (!m) throw new DriverError('product backup wrote no archive', r.stdout + r.stderr)
    // 2) everything else on the volume (uploaded files, registered folders' copies), sealed to the team's backup key.
    //    db/ is in (1); mirror/ is a cache; logs/ and backup-staging/ are not data.
    const filesName = `files-${o.stamp}.tdcb`
    if (!/^[A-Za-z0-9._-]+$/.test(filesName) || !/^tdcpub1\.[A-Za-z0-9_-]+$/.test(o.filesRecipient)) throw new DriverError('bad backup name or key')
    await this.docker(host, ['run', '--rm', '--network', 'none', '--user', `${spec.uid}:${spec.uid}`, '--read-only', '--tmpfs', '/tmp:size=64m,nosuid,nodev,noexec',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--mount', l.dataMount(spec.slug, true), '--mount', l.stagingMount(spec.slug),
      this.o.helperImage, 'seal-dir', '--dir', '/data', '--exclude', 'db,mirror,logs,backup-staging', '--recipient', o.filesRecipient, '--out', `/backup/${filesName}`],
    { what: 'files backup', timeoutS: 3600 })
    return l.ship(host, spec.slug, [{ part: 'product-db', name: m[1]! }, { part: 'files', name: filesName }], o.keyPrefix)
  }

  async exec(host: string, slug: string, args: string[], o: RunOpts = {}): Promise<ExecResult> {
    return this.o.runner.run(host, ['docker', 'exec', `tdc-${slug}`, '/usr/local/bin/tdrive', ...args], o)
  }
}
