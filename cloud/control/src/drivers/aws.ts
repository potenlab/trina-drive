// AWSDriver: teams on a pool of EC2 hosts (cloud/infra/terraform: launch template + ASG, Ubuntu 24.04, Docker,
// the AppArmor profile, an XFS data volume with project quotas). No SSH and no Docker API over the network: the control
// plane sends the same docker commands as the local driver through SSM Run Command, plus a few host-agent steps
// (cloud/host/tdcloud-host: prepare a quota'd directory and the env file, ship backups to S3, report the Elastic IP).
//
// Secrets never sit in SSM command history: the env file goes through Parameter Store (SecureString, KMS), and a
// command whose output is a secret (setup token, backup key) pipes it through `seal` to a one-time X25519 key that
// only this process holds, so the stored output is ciphertext.
//
// This file is exercised by unit tests with a fake AWS endpoint only; it has not been run against a real account.
import { AwsClient } from '../aws'
import { generateTeamKey, unseal } from '../seal'
import { shq } from '../util'
import type { BackupArtifact, ExecResult, TeamSpec } from './types'
import { DockerDriver, type HostLayout, type RunOpts, type Runner } from './docker'
import { DriverError } from './types'

export const HOST_ROOT = '/srv/tdcloud/teams'

export class SsmRunner implements Runner {
  constructor(private readonly aws: AwsClient, private readonly helperImage: string) {}
  async run(host: string, argv: string[], o: RunOpts = {}): Promise<ExecResult> {
    const cmd = argv.map(shq).join(' ')
    if (o.stdin !== undefined) throw new DriverError('stdin is not supported over SSM')
    if (!o.secret) {
      const r = await this.aws.runShell(host, `bash -o pipefail -c ${shq(cmd)}`, { timeoutS: o.timeoutS, comment: `tdcloud ${argv[1] ?? ''}` })
      return { code: r.exitCode, stdout: r.stdout, stderr: r.stderr }
    }
    const k = generateTeamKey()
    const sealCmd = `${cmd} | docker run --rm -i --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true ${shq(this.helperImage)} seal --recipient ${shq(k.publicKey)} | base64 -w0`
    const r = await this.aws.runShell(host, `bash -o pipefail -c ${shq(sealCmd)}`, { timeoutS: o.timeoutS, comment: `tdcloud ${argv[1] ?? ''} (sealed)` })
    if (r.exitCode !== 0) return { code: r.exitCode, stdout: '', stderr: r.stderr }
    const parts: Buffer[] = []
    await unseal((async function* () { yield Buffer.from(r.stdout.trim(), 'base64') })(), (b) => { parts.push(Buffer.from(b)) }, k.secretKey)
    return { code: 0, stdout: Buffer.concat(parts).toString('utf8'), stderr: r.stderr }
  }
}

export class AwsLayout implements HostLayout {
  readonly seccomp = '/etc/tdcloud/seccomp-bwrap.json'
  readonly apparmor = 'trina-drive-bwrap'
  private readonly ips = new Map<string, string | null>()
  constructor(private readonly aws: AwsClient, private readonly runner: Runner, private readonly o: { ssmPrefix: string; kmsKeyId: string | null; backupBucket: string | null }) {}

  private dir(slug: string) { return `${HOST_ROOT}/${slug}` }
  dataMount(slug: string, readOnly = false) { return `type=bind,src=${this.dir(slug)}/data,dst=/data${readOnly ? ',readonly' : ''}` }
  stagingMount(slug: string) { return `type=bind,src=${this.dir(slug)}/staging,dst=/backup` }
  envFile(slug: string) { return `${this.dir(slug)}/env` }
  param(slug: string) { return `${this.o.ssmPrefix}/teams/${slug}/env` }

  private async agent(host: string, args: string[], timeoutS = 300) {
    const r = await this.runner.run(host, ['/usr/local/sbin/tdcloud-host', ...args], { timeoutS })
    if (r.code !== 0) throw new DriverError(`tdcloud-host ${args[0]} failed on ${host}`, r.stderr)
    return r.stdout
  }

  async prepare(host: string, spec: TeamSpec) {
    const text = Object.entries(spec.env).map(([k, v]) => {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(k) || /[\r\n]/.test(v)) throw new DriverError(`bad env entry ${k}`)
      return `${k}=${v}`
    }).join('\n') + '\n'
    await this.aws.putParameter(this.param(spec.slug), text, this.o.kmsKeyId)
    await this.agent(host, ['prepare', spec.slug, String(spec.uid), String(spec.plan.diskGb), this.param(spec.slug)])
  }

  async cleanup(host: string, slug: string) {
    await this.agent(host, ['cleanup', slug])
    await this.aws.deleteParameter(this.param(slug))
  }

  async ship(host: string, slug: string, files: { part: BackupArtifact['part']; name: string }[], keyPrefix: string): Promise<BackupArtifact[]> {
    if (!this.o.backupBucket) throw new DriverError('the AWS driver needs TDCLOUD_BACKUP_TARGET=s3://bucket/prefix')
    const out = await this.agent(host, ['ship', slug, `s3://${this.o.backupBucket}/${keyPrefix}`, ...files.map((f) => f.name)], 3600)
    const byName = new Map(out.trim().split('\n').filter(Boolean).map((l) => { const j = JSON.parse(l) as { name: string; bytes: number; sha256: string; key: string }; return [j.name, j] as const }))
    return files.map((f) => {
      const j = byName.get(f.name)
      if (!j) throw new DriverError(`host did not ship ${f.name}`)
      return { part: f.part, name: f.name, bytes: j.bytes, sha256: j.sha256, objectKey: j.key }
    })
  }

  async publicIp(host: string) {
    if (!this.ips.has(host)) {
      const info = JSON.parse(await this.agent(host, ['info'])) as { publicIp?: string | null }
      this.ips.set(host, info.publicIp ?? null)
    }
    return this.ips.get(host) ?? null
  }
}

export function awsDriver(o: {
  aws: AwsClient; hostTag: string; ssmPrefix: string; kmsKeyId: string | null; backupBucket: string | null
  caddyContainer: string; helperImage: string; maxTeamsPerHost: number; teamsOnHost: (host: string) => number
}) {
  const runner = new SsmRunner(o.aws, o.helperImage)
  return new DockerDriver({
    name: 'aws', runner, caddyContainer: o.caddyContainer, helperImage: o.helperImage,
    layout: new AwsLayout(o.aws, runner, o),
    pickHost: async () => {
      const hosts = (await o.aws.listHosts(o.hostTag)).filter((h) => h.ping === 'Online')
        .map((h) => ({ ...h, load: o.teamsOnHost(h.instanceId) })).filter((h) => h.load < o.maxTeamsPerHost)
        .sort((a, b) => a.load - b.load || (a.instanceId < b.instanceId ? -1 : 1))
      if (!hosts[0]) throw new DriverError(`no online host with room (tag tdcloud:role=${o.hostTag}, max ${o.maxTeamsPerHost} teams each): raise the ASG's desired capacity`)
      return hosts[0].instanceId
    },
  })
}
