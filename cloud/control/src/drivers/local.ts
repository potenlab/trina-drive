// LocalDockerDriver: every team on the Docker engine this process talks to (dev, the end-to-end test, a single box).
// Data in a named volume (mounted with volume-nocopy so the image's /data ownership is not copied over the team's
// uid); env files and backup staging under the state directory. The state directory must be at the same absolute path
// for the Docker engine as for this process (cloud/dev/up.sh mounts it that way), because staging is a bind mount.
// No hard disk quota here (named volumes have none): the metrics loop measures and flags (README, "Quotas").
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { BackupArtifact, ExecResult, TeamSpec } from './types'
import { DockerDriver, type HostLayout, type RunOpts, type Runner } from './docker'

export class LocalRunner implements Runner {
  constructor(private readonly log?: (s: string) => void) {}
  async run(_host: string, argv: string[], o: RunOpts = {}): Promise<ExecResult> {
    this.log?.(`$ ${argv.slice(0, 6).join(' ')}${argv.length > 6 ? ' …' : ''}`)
    const p = Bun.spawn(argv, { stdin: o.stdin !== undefined ? new TextEncoder().encode(o.stdin) : 'ignore', stdout: 'pipe', stderr: 'pipe' })
    const timer = setTimeout(() => p.kill(), (o.timeoutS ?? 600) * 1000)
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
    clearTimeout(timer)
    return { code, stdout, stderr }
  }
}

export class LocalLayout implements HostLayout {
  constructor(readonly stateDir: string, readonly seccomp: string, readonly apparmor: string, private readonly runner: Runner, private readonly helperImage: string) {}
  private teamDir(slug: string) { return path.join(this.stateDir, 'teams', slug) }
  staging(slug: string) { return path.join(this.teamDir(slug), 'staging') }
  dataMount(slug: string, readOnly = false) { return `type=volume,src=tdc-data-${slug},dst=/data,volume-nocopy${readOnly ? ',readonly' : ''}` }
  stagingMount(slug: string) { return `type=bind,src=${this.staging(slug)},dst=/backup` }
  envFile(slug: string) { return path.join(this.teamDir(slug), 'env') }

  async prepare(_host: string, spec: TeamSpec) {
    fs.mkdirSync(this.staging(spec.slug), { recursive: true, mode: 0o700 })
    writeEnvFile(this.envFile(spec.slug), spec.env)
    const r = await this.runner.run('local', ['docker', 'volume', 'create', '--label', `tdcloud.team=${spec.slug}`, `tdc-data-${spec.slug}`])
    if (r.code !== 0) throw new Error(`volume create failed: ${r.stderr}`)
  }

  async cleanup(_host: string, slug: string) {
    await this.runner.run('local', ['docker', 'volume', 'rm', '-f', `tdc-data-${slug}`])
    // staging is owned by the team uid inside the engine's VM: a root one-shot empties it before we remove it
    await this.runner.run('local', ['docker', 'run', '--rm', '--network', 'none', '--user', '0:0', '--cap-drop', 'ALL', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'FOWNER',
      '--mount', `type=bind,src=${this.teamDir(slug)},dst=/t`, '--entrypoint', '/bin/rm', this.helperImage, '-rf', '/t/staging'])
    fs.rmSync(this.teamDir(slug), { recursive: true, force: true })
  }

  async ship(_host: string, slug: string, files: { part: BackupArtifact['part']; name: string }[]): Promise<BackupArtifact[]> {
    return files.map((f) => {
      const p = path.join(this.staging(slug), f.name)
      const bytes = fs.statSync(p).size
      const sha256 = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
      return { part: f.part, name: f.name, bytes, sha256, localPath: p }
    })
  }

  async publicIp() { return null }
}

/** KEY=value lines, 0600. Values with newlines are refused (docker --env-file has no quoting). */
export function writeEnvFile(file: string, env: Record<string, string>) {
  const lines = Object.entries(env).map(([k, v]) => {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(k) || /[\r\n]/.test(v)) throw new Error(`bad env entry ${k}`)
    return `${k}=${v}`
  })
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 })
  fs.chmodSync(file, 0o600)
}

export function localDockerDriver(o: { stateDir: string; seccomp: string; apparmor: string; caddyContainer: string; helperImage: string; log?: (s: string) => void }) {
  const runner = new LocalRunner(o.log)
  return new DockerDriver({
    name: 'local', runner, layout: new LocalLayout(o.stateDir, o.seccomp, o.apparmor, runner, o.helperImage),
    caddyContainer: o.caddyContainer, helperImage: o.helperImage, pickHost: async () => 'local',
  })
}
