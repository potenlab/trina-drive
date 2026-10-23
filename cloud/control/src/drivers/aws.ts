// AWSDriver: teams on a pool of EC2 hosts (cloud/infra/terraform: launch template + ASG, Ubuntu 24.04, Docker,
// the AppArmor profile, an XFS data volume with project quotas). No SSH and no Docker API over the network: the control
// plane sends the same docker commands as the local driver through SSM Run Command, plus a few host-agent steps
// (cloud/host/tdcloud-host: prepare a quota'd directory and the env file, ship backups to S3, report the Elastic IP).
//
// Secrets never sit in SSM command history: the env file goes through Parameter Store (SecureString, KMS), and a
// command whose output is a secret (setup token, backup key) pipes it through `seal` to a one-time X25519 key that
// only this process holds, so the stored output is ciphertext.
//
// AwsPool: the team hosts' Auto Scaling group as the scaler (scaler.ts) sees it: its desired/max size and instances,
// raising the desired count, terminating one empty host (protection off, terminate with decrement, then its data
// volume deleted), and the pool of Elastic IPs the hosts take at boot (allocated before a launch, released after).
//
// The driver ran against a real account once (2026-10-23); AwsPool is exercised by unit tests with fake endpoints only.
import { AwsClient, AwsError } from '../aws'
import { generateTeamKey, unseal } from '../seal'
import { shq } from '../util'
import type { BackupArtifact, ExecResult, HostPool, HostProbe, PoolInstance, PoolStatus, TeamSpec } from './types'
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

/** the tag value the hosts' Elastic IPs carry (tdcloud:pool); the bootstrap takes a free one (host/bootstrap.sh) */
export const EIP_POOL = 'hosts'

export class AwsPool implements HostPool {
  readonly name: string
  constructor(private readonly aws: AwsClient, private readonly runner: Runner, private readonly o: { asgName: string; hostTag: string; addressName?: string }) {
    this.name = `aws ${o.asgName}`
  }

  async status(): Promise<PoolStatus> {
    const doc = await this.aws.query('autoscaling', 'DescribeAutoScalingGroups', { 'AutoScalingGroupNames.member.1': this.o.asgName })
    const g = doc.find('AutoScalingGroups')?.all('member')[0]
    if (!g) throw new DriverError(`no Auto Scaling group ${this.o.asgName}`)
    const online = new Map((await this.aws.listHosts(this.o.hostTag)).map((h) => [h.instanceId, h.ping === 'Online']))
    const instances: PoolInstance[] = g.at('Instances', 'member').map((i) => {
      const ls = i.get('LifecycleState')
      return {
        id: i.get('InstanceId'),
        lifecycle: ls.startsWith('Pending') ? 'pending' : ls === 'InService' ? 'in_service' : ls.startsWith('Terminat') ? 'terminating' : 'other',
        online: online.get(i.get('InstanceId')) ?? false,
      }
    })
    return { desired: Number(g.get('DesiredCapacity')), max: Number(g.get('MaxSize')), instances }
  }

  async setDesired(n: number) {
    await this.aws.query('autoscaling', 'SetDesiredCapacity', { AutoScalingGroupName: this.o.asgName, DesiredCapacity: n, HonorCooldown: false })
  }

  async probe(id: string): Promise<HostProbe | null> {
    try {
      const r = await this.runner.run(id, ['/usr/local/sbin/tdcloud-host', 'info'], { timeoutS: 60 })
      if (r.code !== 0) return null
      const j = JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '') as { ready?: boolean; teams?: number; containers?: number; publicIp?: string | null }
      return { ready: j.ready === true, teams: Number(j.teams ?? 0) + Number(j.containers ?? 0), publicIp: j.publicIp ?? null }
    } catch {
      return null
    }
  }

  async terminate(id: string): Promise<{ volumes: string[] }> {
    // the data volume outlives the instance on purpose (delete_on_termination = false): note it before the instance goes
    const inst = (await this.aws.query('ec2', 'DescribeInstances', { 'InstanceId.1': id })).find('reservationSet')?.at('item', 'instancesSet', 'item')[0]
    const root = inst?.get('rootDeviceName')
    const volumes = (inst?.at('blockDeviceMapping', 'item') ?? [])
      .filter((b) => b.get('deviceName') !== root && b.child('ebs')?.get('deleteOnTermination') !== 'true')
      .map((b) => b.child('ebs')?.get('volumeId') ?? '').filter(Boolean)
    await this.aws.query('autoscaling', 'SetInstanceProtection', { AutoScalingGroupName: this.o.asgName, 'InstanceIds.member.1': id, ProtectedFromScaleIn: false })
    try {
      await this.aws.query('autoscaling', 'TerminateInstanceInAutoScalingGroup', { InstanceId: id, ShouldDecrementDesiredCapacity: true })
    } catch (e) {
      // put the protection back: nothing else may pick this host for a scale-in
      await this.aws.query('autoscaling', 'SetInstanceProtection', { AutoScalingGroupName: this.o.asgName, 'InstanceIds.member.1': id, ProtectedFromScaleIn: true }).catch(() => {})
      throw e
    }
    return { volumes }
  }

  async cleanup(_id: string, volumes: string[]): Promise<boolean> {
    let left = 0
    for (const v of volumes) {
      let status: string
      try {
        status = (await this.aws.query('ec2', 'DescribeVolumes', { 'VolumeId.1': v })).find('volumeSet')?.all('item')[0]?.get('status') ?? 'gone'
      } catch (e) {
        if (e instanceof AwsError && e.code === 'InvalidVolume.NotFound') continue
        throw e
      }
      if (status === 'available') await this.aws.query('ec2', 'DeleteVolume', { VolumeId: v })
      else if (status !== 'deleting' && status !== 'deleted' && status !== 'gone') left++ // still attached while the instance terminates
    }
    return left === 0
  }

  /** One free pool address per host still to come (desired − hosts that hold one), so a booting host always finds one;
   * free addresses beyond that are released (each costs $3.65/month idle). */
  async maintain(desired: number, status: PoolStatus) {
    const addrs = ((await this.aws.query('ec2', 'DescribeAddresses', { 'Filter.1.Name': 'tag:tdcloud:pool', 'Filter.1.Value.1': EIP_POOL })).find('addressesSet')?.all('item') ?? [])
      .map((a) => ({ alloc: a.get('allocationId'), instance: a.get('instanceId'), association: a.get('associationId') }))
    const members = new Set(status.instances.filter((i) => i.lifecycle !== 'terminating').map((i) => i.id))
    const held = addrs.filter((a) => a.instance && members.has(a.instance)).length
    const free = addrs.filter((a) => !a.association && !a.instance)
    const want = Math.max(0, desired - held)
    for (let i = free.length; i < want; i++) {
      await this.aws.query('ec2', 'AllocateAddress', {
        Domain: 'vpc', 'TagSpecification.1.ResourceType': 'elastic-ip',
        'TagSpecification.1.Tag.1.Key': 'tdcloud:pool', 'TagSpecification.1.Tag.1.Value': EIP_POOL,
        'TagSpecification.1.Tag.2.Key': 'Name', 'TagSpecification.1.Tag.2.Value': this.o.addressName ?? 'tdcloud-host',
      })
    }
    for (const a of free.slice(want)) {
      // a host may have taken it a moment ago: then it is in use and stays
      try { await this.aws.query('ec2', 'ReleaseAddress', { AllocationId: a.alloc }) } catch (e) { if (!(e instanceof AwsError && /InUse|NotFound/.test(e.code))) throw e }
    }
  }
}
