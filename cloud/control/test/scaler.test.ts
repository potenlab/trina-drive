// The host scaler with a fake pool (an in-memory Auto Scaling group): scale-out from 0 with the team waiting and the
// owner's mail only at the end, concurrent sign-ups, the host limit, failed bootstraps, scale-in that never touches a
// host with team data; and AwsPool's requests against fake Auto Scaling / EC2 endpoints.
import { afterEach, describe, expect, test } from 'bun:test'
import { AwsClient, CredentialProvider, parseXml } from '../src/aws'
import { teamBySlug, updateTeam, type HostRow } from '../src/db'
import { AwsPool } from '../src/drivers/aws'
import type { Runner } from '../src/drivers/docker'
import { MAX_BOOT_FAILURES, PROBE_EVERY_MS, Scaler } from '../src/scaler'
import { event, setup, signedUpTeam, webhook, type Env } from './helpers'

let env: Env
afterEach(() => env?.cleanup())

const HOUR = 3600_000, MIN = 60_000
let clockAt = Date.now()
const clock = () => clockAt
const later = (ms: number) => { clockAt += ms }

function start(e: Record<string, string> = {}) {
  clockAt = Date.now()
  env = setup({ TDCLOUD_MAX_HOSTS: '10', ...e }, { pool: true, clock })
  return env
}
const scaler = () => env.cloud.scaler!
const host = (id: string) => env.cloud.db.query<HostRow, [string]>('SELECT * FROM hosts WHERE id = ?').get(id)
const team = (slug: string) => teamBySlug(env.cloud.db, slug)!
const opsMail = (re: RegExp) => env.mailer.sent.filter((m) => m.to === env.cfg.opsEmail && re.test(m.subject))
const readyMail = (to: string) => env.mailer.sent.filter((m) => m.to === to && m.subject.startsWith('Your Trina Drive is ready'))
/** the provision jobs come back after a few seconds: run them now */
async function jobs() { env.cloud.db.query('UPDATE jobs SET run_at = 0 WHERE done_at IS NULL').run(); await env.cloud.runDueJobs() }
/** hosts launched so far finish booting, and the scaler sees it */
async function bootAll() { env.pool.boot(); later(PROBE_EVERY_MS); await scaler().tick() }
async function teams(...slugs: string[]) {
  for (const slug of slugs) await env.cloud.adminCreateTeam({ email: `owner@${slug}.test`, slug, actor: 'admin:test', plan: slug.startsWith('biz') ? 'business' : 'team' })
}
/** creates the teams and runs everything until each has a host */
async function running(...slugs: string[]) {
  await teams(...slugs)
  for (let i = 0; i < 5 && slugs.some((s) => team(s).status !== 'active'); i++) { await jobs(); await scaler().tick(); await bootAll(); await jobs() }
  for (const s of slugs) expect(team(s).status).toBe('active')
}

describe('scale-out', () => {
  test('from 0 hosts: the paid team waits in provisioning, a host is launched and used once booted; the ready mail comes last', async () => {
    start()
    const s = await signedUpTeam(env, 'buyer@acme.test', 'acme')
    await webhook(env, event('subscription.created', { id: 'sub_a', status: 'active', customer_id: 'c', items: [{ price: { id: 'pri_team_m' }, quantity: 1 }], custom_data: { tdcloud_team: s.team.id } }))
    await env.cloud.runDueJobs()
    expect(team('acme').status).toBe('provisioning')
    expect(team('acme').waiting_since).toBeNumber()
    expect(env.pool.desired).toBe(0)
    // waiting does not use up the job's attempts (it would fail after 5)
    for (let i = 0; i < 8; i++) await jobs()
    const job = env.cloud.db.query<{ attempts: number; last_error: string }, []>("SELECT attempts, last_error FROM jobs WHERE kind = 'provision'").get()!
    expect(job.attempts).toBe(0)
    expect(job.last_error).toContain('waiting for a host')
    expect(team('acme').status).toBe('provisioning')
    expect(readyMail('buyer@acme.test')).toHaveLength(0)

    const r = await scaler().tick()
    expect(r.launched).toBe(1)
    expect(env.pool.calls).toEqual(['desired 1'])
    // the launch the pool has not started yet, then the booting host, are capacity already: no second launch
    await scaler().tick()
    expect(host('i-1')!.state).toBe('booting')
    await scaler().tick()
    expect(env.pool.calls).toEqual(['desired 1'])
    await jobs()
    expect(team('acme').status).toBe('provisioning') // not on a host that is still booting

    env.pool.boot()
    await scaler().tick() // asked too soon after the last probe: still booting
    expect(host('i-1')!.state).toBe('booting')
    later(PROBE_EVERY_MS)
    expect((await scaler().tick()).ready).toEqual(['i-1'])
    await jobs()
    const t = team('acme')
    expect([t.status, t.host, t.waiting_since]).toEqual(['active', 'i-1', null])
    expect(readyMail('buyer@acme.test')).toHaveLength(1)
    expect(env.cloud.db.query("SELECT detail FROM audit WHERE action = 'team.host_assigned'").get()).toBeTruthy()
    expect(opsMail(/./)).toHaveLength(0)
  })

  test('concurrent sign-ups launch only the hosts they need; a second scaler (another process) waits its turn', async () => {
    start({ TDCLOUD_MAX_TEAMS_PER_HOST: '2' })
    await teams('aa1', 'aa2', 'aa3', 'aa4', 'aa5')
    await jobs()
    let open!: () => void
    env.pool.gate = new Promise((r) => { open = r })
    const other = new Scaler({ ...scaler().d, alert: async () => {}, log: () => {} })
    const passes = [scaler().tick(), scaler().tick(), scaler().tick()]
    await Bun.sleep(20)
    expect((await other.tick()).skipped).toBe('busy') // the lease is held by the first pass
    open()
    await Promise.all(passes)
    expect(env.pool.calls).toEqual(['desired 3']) // 5 teams, 2 slots each host
    await scaler().tick()
    expect(env.pool.calls).toEqual(['desired 3'])
    await bootAll()
    await jobs()
    const hosts = ['aa1', 'aa2', 'aa3', 'aa4', 'aa5'].map((s) => team(s).host)
    expect(hosts.every(Boolean)).toBe(true)
    // the fullest host that still fits: 2 + 2 + 1
    const per = new Map<string, number>()
    for (const h of hosts) per.set(h!, (per.get(h!) ?? 0) + 1)
    expect([...per.values()].sort()).toEqual([1, 2, 2])
    // one more team fits on the host with a free slot: nothing launched
    await teams('aa6'); await jobs(); await scaler().tick()
    expect(team('aa6').status).toBe('active')
    expect(env.pool.calls).toEqual(['desired 3'])
  })

  test('a Business team takes two slots: it needs a new host when the free slots are on different hosts', async () => {
    start({ TDCLOUD_MAX_TEAMS_PER_HOST: '3' })
    await running('tt1', 'tt2', 'tt3', 'tt4', 'tt5')
    expect(env.pool.desired).toBe(2) // 3/3 and 2/3
    await running('biz1') // one free slot: not enough
    expect(env.pool.desired).toBe(3)
    expect(team('biz1').host).toBe('i-3')
    await running('tt6') // the fullest host that fits: the second one, now full
    expect(team('tt6').host).toBe(team('tt4').host)
    await teams('biz2')
    await jobs()
    await scaler().tick()
    expect(env.pool.desired).toBe(4) // one free slot on the third host: not enough for two
  })

  test('the host limit: the team waits, ops are alerted once; it starts when a slot frees up', async () => {
    start({ TDCLOUD_MAX_HOSTS: '1', TDCLOUD_MAX_TEAMS_PER_HOST: '1' })
    await running('first')
    await teams('second')
    await jobs()
    await scaler().tick(); await scaler().tick()
    expect(env.pool.desired).toBe(1)
    expect(opsMail(/host limit reached/)).toHaveLength(1)
    expect(opsMail(/host limit reached/)[0]!.text).toContain('second')
    await jobs()
    expect(team('second').status).toBe('provisioning')
    // waiting long: one more alert about the team itself, never a failed team
    updateTeam(env.cloud.db, team('second').id, { waiting_since: Date.now() - 16 * MIN })
    await jobs(); await jobs()
    expect(opsMail(/second has waited/)).toHaveLength(1)
    expect(team('second').status).toBe('provisioning')
    // the first team goes: its host is not scaled in while a team waits, the waiting team takes it
    await env.cloud.deleteTeam(team('first'), 'test')
    later(7 * HOUR)
    expect((await scaler().tick()).terminated).toEqual([])
    await jobs()
    expect([team('second').status, team('second').host]).toEqual(['active', 'i-1'])
    await scaler().tick()
    expect(env.cloud.db.query("SELECT 1 FROM kv WHERE key = 'alert.limit'").get()).toBeNull()
  })

  test('a host that does not finish its bootstrap is replaced; three in a row stop scale-out until hosts resume', async () => {
    start()
    env.pool.failBoots = true
    await teams('acme')
    await jobs()
    await scaler().tick()
    expect(env.pool.calls).toEqual(['desired 1'])
    await scaler().tick() // the new instance is seen from the next pass on: booting
    for (let n = 1; n <= MAX_BOOT_FAILURES; n++) {
      later(16 * MIN)
      const r = await scaler().tick()
      expect(r.replaced).toEqual([`i-${n}`])
      expect(env.pool.calls).toContain(`terminate i-${n} decrement`)
      expect(opsMail(/did not finish booting/)).toHaveLength(n)
      // the replacement in the same pass, until the breaker
      expect(env.pool.desired).toBe(n < MAX_BOOT_FAILURES ? 1 : 0)
      await scaler().tick()
    }
    expect(opsMail(/scale-out stopped/)).toHaveLength(1)
    later(MIN); await scaler().tick(); await scaler().tick()
    expect(env.pool.desired).toBe(0)
    expect(opsMail(/scale-out stopped/)).toHaveLength(1)
    // the terminated hosts' data volumes are deleted once they are gone
    expect(env.pool.calls.filter((c) => c.startsWith('delete-volume'))).toEqual(['delete-volume vol-i-1', 'delete-volume vol-i-2', 'delete-volume vol-i-3'])
    expect(host('i-1')!.state).toBe('gone')
    await jobs()
    expect(team('acme').status).toBe('provisioning') // waiting, not failed

    env.pool.failBoots = false
    scaler().resume()
    await scaler().tick()
    expect(env.pool.desired).toBe(1)
    await bootAll(); await jobs()
    expect([team('acme').status, team('acme').host]).toEqual(['active', 'i-4'])
  })

  test('spare slots: a host is started before anyone pays, and kept', async () => {
    start({ TDCLOUD_SPARE_SLOTS: '1', TDCLOUD_MAX_TEAMS_PER_HOST: '2' })
    await scaler().tick()
    expect(env.pool.desired).toBe(1)
    await bootAll()
    later(30 * HOUR)
    expect((await scaler().tick()).terminated).toEqual([])
    await running('acme') // takes one slot, one left: still enough
    expect(env.pool.desired).toBe(1)
    await running('beta') // no free slot left: another host for the spare
    await scaler().tick()
    expect(env.pool.desired).toBe(2)
  })
})

describe('waiting teams', () => {
  test('a team paused while it waits for a host is provisioned when it resumes', async () => {
    start()
    await teams('pausy')
    await jobs()
    await env.cloud.suspend(team('pausy'), 'billing', 'test')
    await scaler().tick()
    expect(env.pool.desired).toBe(0) // a suspended team needs no host
    await env.cloud.resume(team('pausy'), 'test')
    expect(team('pausy').status).toBe('provisioning')
    await jobs(); await scaler().tick(); await scaler().tick(); await bootAll(); await jobs()
    expect(team('pausy').status).toBe('active')
  })

  test('the database gains the new columns and tables on an existing control database', async () => {
    const { Database } = await import('bun:sqlite')
    const { openDb } = await import('../src/db')
    const file = `${(await import('node:os')).tmpdir()}/tdcloud-old-${Date.now()}.db`
    const old = new Database(file, { create: true })
    old.exec('CREATE TABLE teams (id INTEGER PRIMARY KEY, public_id TEXT NOT NULL UNIQUE, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, owner_user_id INTEGER NOT NULL, plan TEXT NOT NULL DEFAULT \'team\', status TEXT NOT NULL, number INTEGER NOT NULL UNIQUE, host TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)')
    old.close()
    const db = openDb(file)
    const cols = db.query<{ name: string }, []>('PRAGMA table_info(teams)').all().map((c) => c.name)
    expect(cols).toContain('waiting_since')
    expect(cols).toContain('wait_alerted_at')
    expect(db.query("SELECT name FROM sqlite_master WHERE name IN ('hosts', 'kv') ORDER BY name").all()).toEqual([{ name: 'hosts' }, { name: 'kv' }])
    db.close()
    openDb(file).close() // a second open changes nothing
    ;(await import('node:fs')).rmSync(file, { force: true })
  })
})

describe('scale-in', () => {
  test('only a host no team names, after the grace period: protection off, terminated with decrement, volume deleted', async () => {
    start({ TDCLOUD_MAX_TEAMS_PER_HOST: '1' })
    await running('live', 'paused', 'broken', 'gone')
    expect(env.pool.desired).toBe(4)
    const hostOf: Record<string, string> = Object.fromEntries(['live', 'paused', 'broken', 'gone'].map((s) => [s, team(s).host!]))
    await env.cloud.suspend(team('paused'), 'admin', 'test') // suspended: its data is on the host
    updateTeam(env.cloud.db, team('broken').id, { status: 'failed' }) // a half-made team: data may be there
    await env.cloud.deleteTeam(team('gone'), 'test')
    await scaler().tick()
    expect(host(hostOf.gone!)!.empty_since).toBe(clockAt)
    later(5 * HOUR)
    expect((await scaler().tick()).terminated).toEqual([])
    later(1 * HOUR + MIN)
    expect((await scaler().tick()).terminated).toEqual([hostOf.gone!])
    const i = env.pool.calls.indexOf(`protection-off ${hostOf.gone}`)
    expect(env.pool.calls.slice(i, i + 2)).toEqual([`protection-off ${hostOf.gone}`, `terminate ${hostOf.gone} decrement`])
    expect(env.pool.desired).toBe(3)
    expect(host(hostOf.gone!)!.state).toBe('terminating')
    await scaler().tick()
    expect(env.pool.calls).toContain(`delete-volume vol-${hostOf.gone}`)
    expect(host(hostOf.gone!)!.state).toBe('gone')
    // never the others, however long
    for (let n = 0; n < 4; n++) { later(30 * HOUR); await scaler().tick() }
    for (const s of ['live', 'paused', 'broken']) expect(host(hostOf[s]!)!.state).toBe('ready')
    expect(env.pool.calls.filter((c) => c.startsWith('terminate'))).toEqual([`terminate ${hostOf.gone} decrement`])
    expect(env.pool.desired).toBe(3)
    expect(env.cloud.db.query("SELECT 1 FROM audit WHERE action = 'hosts.scale_in'").get()).toBeTruthy()
  })

  test('a host that still holds team data, or does not answer, is not terminated', async () => {
    start({ TDCLOUD_MAX_TEAMS_PER_HOST: '1' })
    await running('xx1', 'yy1')
    const hx = team('xx1').host!, hy = team('yy1').host!
    await env.cloud.deleteTeam(team('xx1'), 'test')
    await env.cloud.deleteTeam(team('yy1'), 'test')
    env.pool.hosts.get(hx)!.teams = 1 // a team directory the control database does not know
    env.pool.hosts.get(hy)!.reachable = false
    await scaler().tick()
    later(7 * HOUR)
    await scaler().tick(); await scaler().tick(); await scaler().tick()
    expect(env.pool.calls.filter((c) => c.startsWith('terminate'))).toEqual([])
    expect([host(hx)!.state, host(hx)!.keep]).toEqual(['ready', 1])
    expect(opsMail(/holds team data/)).toHaveLength(1)
    expect(host(hy)!.state).toBe('ready')
    // answers again: now it goes; the kept one stays until the operator lets it go
    env.pool.hosts.get(hy)!.reachable = true
    expect((await scaler().tick()).terminated).toEqual([hy])
    later(HOUR); await scaler().tick()
    expect(host(hx)!.state).toBe('ready')
    scaler().setKeep(hx, false)
    env.pool.hosts.get(hx)!.teams = 0
    expect((await scaler().tick()).terminated).toEqual([hx])
  })

  test('a draining host takes no team; a team naming a host the pool lost is reported', async () => {
    start({ TDCLOUD_MAX_TEAMS_PER_HOST: '2' })
    await running('one')
    const h = team('one').host!
    env.cloud.db.query("UPDATE hosts SET state = 'draining' WHERE id = ?").run(h)
    await teams('two')
    expect(scaler().claim(team('two'))).toBeNull()
    env.cloud.db.query("UPDATE hosts SET state = 'ready' WHERE id = ?").run(h)
    expect(scaler().claim(team('two'))).toBe(h)
    env.pool.hosts.delete(h) // terminated outside the control plane
    await scaler().tick(); await scaler().tick()
    expect(host(h)!.state).toBe('lost')
    expect(opsMail(/is gone with 2 team/)).toHaveLength(1)
  })
})

describe('AwsPool (fake Auto Scaling and EC2 endpoints)', () => {
  test('status, raising the desired count, Elastic IPs before a launch, scale-in, volume clean-up', async () => {
    const calls: string[] = []
    const addresses = [
      { alloc: 'eipalloc-1', instance: 'i-aaa', assoc: 'eipassoc-1' },
      { alloc: 'eipalloc-2', instance: '', assoc: '' },
      { alloc: 'eipalloc-3', instance: '', assoc: '' },
    ]
    const volume: Record<string, string> = { 'vol-data': 'in-use' }
    const fake = async (url: string, init?: RequestInit) => {
      const h = init?.headers as Record<string, string>
      if (!h.authorization?.startsWith('AWS4-HMAC-SHA256 ')) return new Response('unsigned', { status: 403 })
      if (url.startsWith('https://ssm.')) {
        return Response.json({ InstanceInformationList: [{ InstanceId: 'i-aaa', IPAddress: '10.42.0.5', PingStatus: 'Online' }, { InstanceId: 'i-bbb', IPAddress: '10.42.0.6', PingStatus: 'ConnectionLost' }] })
      }
      const p = new URLSearchParams(String(init?.body))
      const action = p.get('Action')!
      calls.push(`${url.includes('autoscaling') ? 'as' : 'ec2'} ${action} ${[...p].filter(([k]) => !['Action', 'Version'].includes(k)).map(([k, v]) => `${k}=${v}`).join('&')}`)
      const xml = (body: string) => new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<${action}Response xmlns="x">${body}</${action}Response>`, { headers: { 'content-type': 'text/xml' } })
      switch (action) {
        case 'DescribeAutoScalingGroups': return xml(`<DescribeAutoScalingGroupsResult><AutoScalingGroups><member><AutoScalingGroupName>tdcloud-hosts</AutoScalingGroupName><MinSize>0</MinSize><MaxSize>3</MaxSize><DesiredCapacity>2</DesiredCapacity>
          <Instances><member><InstanceId>i-aaa</InstanceId><LifecycleState>InService</LifecycleState><HealthStatus>Healthy</HealthStatus><ProtectedFromScaleIn>true</ProtectedFromScaleIn></member>
          <member><InstanceId>i-bbb</InstanceId><LifecycleState>Pending</LifecycleState><HealthStatus>Healthy</HealthStatus><ProtectedFromScaleIn>true</ProtectedFromScaleIn></member></Instances></member></AutoScalingGroups></DescribeAutoScalingGroupsResult>`)
        case 'DescribeAddresses': return xml(`<addressesSet>${addresses.map((a) => `<item><publicIp>198.51.100.${a.alloc.at(-1)}</publicIp><allocationId>${a.alloc}</allocationId>${a.assoc ? `<associationId>${a.assoc}</associationId><instanceId>${a.instance}</instanceId>` : ''}<domain>vpc</domain></item>`).join('')}</addressesSet>`)
        case 'DescribeInstances': return xml(`<reservationSet><item><instancesSet><item><instanceId>i-aaa</instanceId><rootDeviceName>/dev/sda1</rootDeviceName><blockDeviceMapping>
          <item><deviceName>/dev/sda1</deviceName><ebs><volumeId>vol-root</volumeId><deleteOnTermination>true</deleteOnTermination></ebs></item>
          <item><deviceName>/dev/sdf</deviceName><ebs><volumeId>vol-data</volumeId><deleteOnTermination>false</deleteOnTermination></ebs></item></blockDeviceMapping></item></instancesSet></item></reservationSet>`)
        case 'DescribeVolumes': return volume['vol-data'] ? xml(`<volumeSet><item><volumeId>vol-data</volumeId><status>${volume['vol-data']}</status></item></volumeSet>`)
          : new Response('<Response><Errors><Error><Code>InvalidVolume.NotFound</Code><Message>gone</Message></Error></Errors></Response>', { status: 400 })
        case 'TerminateInstanceInAutoScalingGroup': return p.get('InstanceId') === 'i-bad' ? new Response('<ErrorResponse><Error><Type>Sender</Type><Code>ValidationError</Code><Message>no</Message></Error></ErrorResponse>', { status: 400 }) : xml('<TerminateInstanceInAutoScalingGroupResult/>')
        default: return xml(`<${action}Result/>`)
      }
    }
    const aws = new AwsClient('ap-northeast-2', new CredentialProvider({ AWS_ACCESS_KEY_ID: 'AKID', AWS_SECRET_ACCESS_KEY: 'x' }), fake as never)
    const info: Runner = { run: async (h) => ({ code: 0, stdout: `{"instanceId":"${h}","publicIp":"198.51.100.1","freeBytes":1,"teams":0,"containers":0,"ready":true}\n`, stderr: '' }) }
    const pool = new AwsPool(aws, info, { asgName: 'tdcloud-hosts', hostTag: 'host' })

    const st = await pool.status()
    expect(st).toEqual({ desired: 2, max: 3, instances: [{ id: 'i-aaa', lifecycle: 'in_service', online: true }, { id: 'i-bbb', lifecycle: 'pending', online: false }] })
    expect(await pool.probe('i-aaa')).toEqual({ ready: true, teams: 0, publicIp: '198.51.100.1' })

    // desired 3: one address held (i-aaa), two hosts to come → two free ones needed; there are two: nothing to do
    calls.length = 0
    await pool.maintain(3, st)
    expect(calls).toEqual(['ec2 DescribeAddresses Filter.1.Name=tag:tdcloud:pool&Filter.1.Value.1=hosts'])
    // desired 4 → one more is allocated, tagged for the pool
    calls.length = 0
    await pool.maintain(4, st)
    expect(calls[1]).toBe('ec2 AllocateAddress Domain=vpc&TagSpecification.1.ResourceType=elastic-ip&TagSpecification.1.Tag.1.Key=tdcloud:pool&TagSpecification.1.Tag.1.Value=hosts&TagSpecification.1.Tag.2.Key=Name&TagSpecification.1.Tag.2.Value=tdcloud-host')
    // desired 1 → both free ones are released (i-aaa keeps its own)
    calls.length = 0
    await pool.maintain(1, st)
    expect(calls.slice(1)).toEqual(['ec2 ReleaseAddress AllocationId=eipalloc-2', 'ec2 ReleaseAddress AllocationId=eipalloc-3'])

    calls.length = 0
    await pool.setDesired(3)
    expect(calls).toEqual(['as SetDesiredCapacity AutoScalingGroupName=tdcloud-hosts&DesiredCapacity=3&HonorCooldown=false'])

    calls.length = 0
    expect(await pool.terminate('i-aaa')).toEqual({ volumes: ['vol-data'] })
    expect(calls).toEqual([
      'ec2 DescribeInstances InstanceId.1=i-aaa',
      'as SetInstanceProtection AutoScalingGroupName=tdcloud-hosts&InstanceIds.member.1=i-aaa&ProtectedFromScaleIn=false',
      'as TerminateInstanceInAutoScalingGroup InstanceId=i-aaa&ShouldDecrementDesiredCapacity=true',
    ])
    // a refused termination puts the protection back
    calls.length = 0
    await expect(pool.terminate('i-bad')).rejects.toThrow(/ValidationError/)
    expect(calls.at(-1)).toBe('as SetInstanceProtection AutoScalingGroupName=tdcloud-hosts&InstanceIds.member.1=i-bad&ProtectedFromScaleIn=true')

    // the volume is deleted only once it is detached; a volume already gone is fine
    calls.length = 0
    expect(await pool.cleanup('i-aaa', ['vol-data'])).toBe(false)
    expect(calls.some((c) => c.includes('DeleteVolume'))).toBe(false)
    volume['vol-data'] = 'available'
    expect(await pool.cleanup('i-aaa', ['vol-data'])).toBe(true)
    expect(calls.at(-1)).toBe('ec2 DeleteVolume VolumeId=vol-data')
    delete volume['vol-data']
    expect(await pool.cleanup('i-aaa', ['vol-data'])).toBe(true)
  })

  test('the XML reader', () => {
    const d = parseXml('<?xml version="1.0"?><a><!-- c --><b x="1/2">t &amp; &lt;u&gt; &#65;</b><c/><d><e>1</e><e>2</e></d></a>')
    expect(d.find('b')!.text).toBe('t & <u> A')
    expect(d.find('c')!.text).toBe('')
    expect(d.child('a')!.at('d', 'e').map((e) => e.text)).toEqual(['1', '2'])
    expect(() => parseXml('<a><b></a>')).toThrow()
  })
})
