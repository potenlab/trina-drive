// What the control plane passes to each team instance (hosted mode, trusted proxy, managed storage, mail) and the
// pieces behind it: fixed team network addresses, the host mail relay, the driver steps that keep them current.
import { afterEach, describe, expect, test } from 'bun:test'
import { AwsClient, CredentialProvider } from '../src/aws'
import { teamEnv } from '../src/cloud'
import { ConfigError, DEFAULT_TEAM_SUBNETS, loadConfig } from '../src/config'
import { teamBySlug } from '../src/db'
import { DockerDriver, type HostLayout, type Runner } from '../src/drivers/docker'
import { PLANS } from '../src/plans'
import { makeRelay, SesUpstream, type RelayMail, type RelayUpstream } from '../src/relay'
import { teamNet, teamOfAddress } from '../src/teamnet'
import { SesMailer, AwsCredentialProvider } from '../../../src/notify/ses'
import { mailEnv } from '../../../src/notify/config'
import { event, setup, signedUpTeam, webhook, type Env } from './helpers'

const FROM = 'Trina Drive <drive@trina.app>'

describe('team network addresses', () => {
  test('one /28 per team number: gateway .1, Caddy .2, team .3, dynamic range .8–.15', () => {
    expect(teamNet(DEFAULT_TEAM_SUBNETS, 1)).toEqual({ subnet: '10.128.0.16/28', gateway: '10.128.0.17', caddyIp: '10.128.0.18', teamIp: '10.128.0.19', ipRange: '10.128.0.24/29' })
    expect(teamNet(DEFAULT_TEAM_SUBNETS, 4096).subnet).toBe('10.129.0.0/28')
    expect(teamNet('10.200.0.0/24', 15).teamIp).toBe('10.200.0.243')
    expect(() => teamNet('10.200.0.0/24', 16)).toThrow(/does not fit/)
    expect(() => teamNet(DEFAULT_TEAM_SUBNETS, 0)).toThrow()
    for (const bad of ['10.128.0.1/11', '10.128.0.0', 'fd00::/8', '10.0.0.0/30']) expect(() => teamNet(bad, 1)).toThrow()
  })
  test('only a team container address maps back to its team', () => {
    expect(teamOfAddress(DEFAULT_TEAM_SUBNETS, '10.128.0.19')).toBe(1)
    expect(teamOfAddress(DEFAULT_TEAM_SUBNETS, '::ffff:10.128.0.51')).toBe(3)
    for (const ip of ['10.128.0.18', '10.128.0.17', '10.128.0.3', '10.160.0.3', '127.0.0.1', '::1', '', undefined]) expect(teamOfAddress(DEFAULT_TEAM_SUBNETS, ip)).toBeNull()
  })
})

describe('team environment', () => {
  const cfg = loadConfig({ TDCLOUD_STATE_DIR: '/tmp/x', AWS_REGION: 'ap-northeast-2', TDCLOUD_TEAM_MAIL_FROM: FROM })
  test('hosted, trusted proxy = Caddy, managed storage with the plan quota, SES through the relay on the gateway', () => {
    const net = teamNet(cfg.teamSubnets, 7)
    const e = teamEnv(cfg, 'team_x', PLANS.team, net)
    expect(e).toMatchObject({
      TDRIVE_HOSTED: '1', TDRIVE_TRUSTED_PROXY: `${net.caddyIp}/32`, TDRIVE_STORAGE: 'managed', TDRIVE_STORAGE_QUOTA: '100GB',
      TDRIVE_MAILER: 'ses', TDRIVE_MAIL_FROM: FROM, TDRIVE_SES_REGION: 'ap-northeast-2', TDRIVE_SES_ENDPOINT: `http://${net.gateway}:8025`,
    })
    expect(teamEnv(cfg, 'team_x', PLANS.business, net).TDRIVE_STORAGE_QUOTA).toBe('1000GB')
    // the product accepts exactly this mail configuration
    expect(mailEnv(e)).toMatchObject({ mode: 'ses', from: FROM, ses: { region: 'ap-northeast-2', endpoint: `http://${net.gateway}:8025` } })
  })
  test('plans: 100 GB / 1 TB of files; the disk cap leaves room for the database and one backup', () => {
    expect([PLANS.team.storageGb, PLANS.business.storageGb]).toEqual([100, 1000])
    expect([PLANS.team.diskGb, PLANS.business.diskGb]).toEqual([220, 2020])
  })
  test('outbox / off modes; production refuses the outbox for teams', () => {
    const o = loadConfig({ TDCLOUD_STATE_DIR: '/tmp/x', TDCLOUD_TEAM_MAILER: 'outbox' })
    expect(teamEnv(o, 't', PLANS.team, teamNet(o.teamSubnets, 1))).toMatchObject({ TDRIVE_MAILER: 'outbox' })
    expect(teamEnv(o, 't', PLANS.team, teamNet(o.teamSubnets, 1)).TDRIVE_SES_ENDPOINT).toBeUndefined()
    const prod = { TDCLOUD_ENV: 'production', TDCLOUD_DOMAIN: 'cloud.trina.app', TDCLOUD_MAILER: 'ses', TDCLOUD_KMS_KEY_ID: 'alias/x', PADDLE_WEBHOOK_SECRET: 's', TDCLOUD_CADDY_ASK_KEY: 'k', TDCLOUD_DRIVER: 'aws' }
    expect(() => loadConfig({ ...prod, TDCLOUD_TEAM_MAILER: 'outbox' })).toThrow(/TEAM_MAILER/)
    expect(() => loadConfig({ TDCLOUD_TEAM_MAIL_FROM: 'nobody' })).toThrow(ConfigError)
    expect(() => loadConfig({ TDCLOUD_TEAM_SUBNETS: '10.0.0.0/29' })).toThrow(ConfigError)
  })
})

describe('mail relay', () => {
  class Rec implements RelayUpstream {
    readonly name = 'rec'
    sent: RelayMail[] = []
    async send(m: RelayMail) { this.sent.push(m); return `m${this.sent.length}` }
  }
  const body = (o: Record<string, unknown> = {}) => JSON.stringify({ FromEmailAddress: FROM, Destination: { ToAddresses: ['dana@acme.test'] }, Content: { Simple: { Subject: { Data: 'You are invited' }, Body: { Text: { Data: 'hi' } } } }, ...o })
  const post = (h: ReturnType<typeof makeRelay>, peer: string, b = body()) => h(new Request('http://10.128.0.17:8025/v2/email/outbound-emails', { method: 'POST', body: b }), peer)
  const relay = (up: RelayUpstream, o: { perHour?: number } = {}) => makeRelay({ pool: DEFAULT_TEAM_SUBNETS, from: FROM, upstream: up, log: () => {}, ...o })

  test('takes SendEmail from a team container with the team From, one recipient', async () => {
    const up = new Rec(), h = relay(up)
    const r = await post(h, '10.128.0.19')
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ MessageId: 'm1' })
    expect(up.sent).toEqual([{ team: 1, from: FROM, to: 'dana@acme.test', subject: 'You are invited', text: 'hi' }])
  })
  test('refuses other senders, another From, Cc/Bcc, several recipients, raw content, other calls', async () => {
    const up = new Rec(), h = relay(up)
    for (const peer of ['10.128.0.18', '10.128.0.17', '172.17.0.2', '127.0.0.1']) expect((await post(h, peer)).status).toBe(403)
    expect((await post(h, '10.128.0.19', body({ FromEmailAddress: 'CEO <ceo@bank.example>' }))).status).toBe(400)
    expect((await post(h, '10.128.0.19', body({ FromEmailAddress: 'Trina Drive <drive@trina.app.evil.example>' }))).status).toBe(400)
    expect((await post(h, '10.128.0.19', body({ Destination: { ToAddresses: ['a@x.test'], BccAddresses: ['b@x.test'] } }))).status).toBe(400)
    expect((await post(h, '10.128.0.19', body({ Destination: { ToAddresses: ['a@x.test', 'b@x.test'] } }))).status).toBe(400)
    expect((await post(h, '10.128.0.19', body({ Content: { Raw: { Data: 'RnJvbTog' } } }))).status).toBe(400)
    expect((await post(h, '10.128.0.19', body({ ReplyToAddresses: ['x@y.test'] }))).status).toBe(400)
    expect((await post(h, '10.128.0.19', body({ Content: { Simple: { Subject: { Data: 'a\r\nBcc: x@y.test' }, Body: { Text: { Data: 'x' } } } } }))).status).toBe(400)
    expect((await post(h, '10.128.0.19', 'x'.repeat(600 * 1024))).status).toBe(413)
    expect((await h(new Request('http://10.128.0.17:8025/v2/email/identities'), '10.128.0.19')).status).toBe(404)
    expect(up.sent).toEqual([])
  })
  test('per-team hourly limit', async () => {
    const up = new Rec(), h = relay(up, { perHour: 2 })
    expect((await post(h, '10.128.0.19')).status).toBe(200)
    expect((await post(h, '10.128.0.19')).status).toBe(200)
    expect((await post(h, '10.128.0.19')).status).toBe(429)
    expect((await post(h, '10.128.0.35')).status).toBe(200)
  })
  test('the product\'s own SES mailer goes through the relay; the relay signs for SES with the host role', async () => {
    const seen: { url: string; auth: string; body: Record<string, unknown> }[] = []
    const ses = async (url: string, init?: RequestInit) => {
      seen.push({ url, auth: String((init?.headers as Record<string, string>).authorization), body: JSON.parse(String(init?.body)) })
      return Response.json({ MessageId: 'ses-1' })
    }
    const role = new CredentialProvider({ AWS_ACCESS_KEY_ID: 'ASIAHOSTROLE', AWS_SECRET_ACCESS_KEY: 'k', AWS_SESSION_TOKEN: 't' })
    const h = relay(new SesUpstream(new AwsClient('ap-northeast-2', role, ses as never)))
    // the team container: TDRIVE_MAILER=ses with the env the control plane writes (placeholder AWS_* values)
    const cfg = loadConfig({ TDCLOUD_STATE_DIR: '/tmp/x', TDCLOUD_TEAM_MAIL_FROM: FROM })
    const e = teamEnv(cfg, 'team_x', PLANS.team, teamNet(cfg.teamSubnets, 1))
    const product = new SesMailer({ region: e.TDRIVE_SES_REGION!, endpoint: e.TDRIVE_SES_ENDPOINT }, new AwsCredentialProvider(e), (url, init) => h(new Request(url, init), '10.128.0.19'))
    await product.send({ from: FROM, to: 'dana@acme.test', subject: 'You are invited', text: 'link' })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.url).toBe('https://email.ap-northeast-2.amazonaws.com/v2/email/outbound-emails')
    expect(seen[0]!.auth).toStartWith('AWS4-HMAC-SHA256 Credential=ASIAHOSTROLE/')
    expect(seen[0]!.body).toMatchObject({ FromEmailAddress: FROM, Destination: { ToAddresses: ['dana@acme.test'] } })
    // and a product mail with another From is refused before it reaches SES
    await expect(product.send({ from: 'x@evil.example', to: 'dana@acme.test', subject: 's', text: 't' })).rejects.toThrow(/400/)
    expect(seen).toHaveLength(1)
  })
})

describe('driver: settings reach existing teams', () => {
  class Rec implements Runner {
    calls: string[] = []
    constructor(private readonly o: { subnet?: string; caddyIp?: string } = {}) {}
    async run(_h: string, argv: string[]) {
      const a = argv.join(' ')
      this.calls.push(a)
      if (a.includes('network inspect')) return this.o.subnet ? { code: 0, stdout: `${this.o.subnet} \n`, stderr: '' } : { code: 1, stdout: '', stderr: 'not found' }
      if (a.startsWith('docker network disconnect')) { this.o.caddyIp = undefined; return { code: 0, stdout: '', stderr: '' } }
      if (a.startsWith('docker network connect')) return this.o.caddyIp ? { code: 1, stdout: '', stderr: 'endpoint with name tdc-caddy already exists in network' } : { code: 0, stdout: '', stderr: '' }
      if (a.includes('.NetworkSettings.Networks')) return { code: 0, stdout: `${this.o.caddyIp ?? ''}\n`, stderr: '' }
      if (a.includes('inspect -f {{.State.Status}}')) return { code: 0, stdout: 'running healthy', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
  }
  const prepared: string[] = []
  const layout: HostLayout = {
    seccomp: 's', apparmor: '', dataMount: () => 'd', stagingMount: () => 'st', envFile: () => '/e',
    prepare: async (_h, spec) => { prepared.push(spec.env.TDRIVE_STORAGE_QUOTA ?? '') }, cleanup: async () => {}, ship: async () => [], publicIp: async () => null,
  }
  const cfg = loadConfig({ TDCLOUD_STATE_DIR: '/tmp/x' })
  const spec = (plan: 'team' | 'business') => ({ slug: 'acme', number: 3, uid: 20003, url: 'https://acme.x', plan: PLANS[plan], net: teamNet(cfg.teamSubnets, 3), image: 'i', env: teamEnv(cfg, 't', PLANS[plan], teamNet(cfg.teamSubnets, 3)) })

  test('a plan change writes the env file and quota again and recreates the container (the storage quota is an env value)', async () => {
    const rec = new Rec({ subnet: '10.128.0.48/28' })
    prepared.length = 0
    await new DockerDriver({ name: 't', runner: rec, layout, caddyContainer: 'tdc-caddy', helperImage: 'h', pickHost: async () => 'x' }).setLimits('x', spec('business'))
    expect(prepared).toEqual(['1000GB'])
    expect(rec.calls.some((c) => c.startsWith('docker create ') && c.includes('--ip 10.128.0.51') && c.includes('--memory 4096m'))).toBe(true)
    expect(rec.calls.some((c) => c.startsWith('docker network rm'))).toBe(false)
  })
  test('a network from before fixed subnets is made again; Caddy attached at another address is moved to .2', async () => {
    const rec = new Rec({ subnet: '172.30.4.0/24', caddyIp: '172.30.4.3' })
    await new DockerDriver({ name: 't', runner: rec, layout, caddyContainer: 'tdc-caddy', helperImage: 'h', pickHost: async () => 'x' }).recreate('x', spec('team'))
    const i = (p: string) => rec.calls.findIndex((c) => c.startsWith(p))
    expect(i('docker network rm tdc-net-acme')).toBeGreaterThan(i('docker rm -f tdc-acme'))
    expect(i('docker network create')).toBeGreaterThan(i('docker network rm'))
    expect(rec.calls).toContain('docker network disconnect -f tdc-net-acme tdc-caddy')
    expect(rec.calls.filter((c) => c === 'docker network connect --ip 10.128.0.50 tdc-net-acme tdc-caddy').length).toBe(1)
  })
  test('Caddy joined at another address (by hand, after a reboot) is moved to its fixed address on start', async () => {
    const rec = new Rec({ subnet: '10.128.0.48/28', caddyIp: '10.128.0.56' })
    await new DockerDriver({ name: 't', runner: rec, layout, caddyContainer: 'tdc-caddy', helperImage: 'h', pickHost: async () => 'x' }).start('x', spec('team'))
    expect(rec.calls.filter((c) => c.startsWith('docker network ')).map((c) => c.split(' ').slice(0, 3).join(' '))).toEqual(['docker network connect', 'docker network disconnect', 'docker network connect'])
    const ok = new Rec({ subnet: '10.128.0.48/28', caddyIp: '10.128.0.50' })
    await new DockerDriver({ name: 't', runner: ok, layout, caddyContainer: 'tdc-caddy', helperImage: 'h', pickHost: async () => 'x' }).start('x', spec('team'))
    expect(ok.calls.filter((c) => c.startsWith('docker network disconnect'))).toEqual([])
  })
})

describe('control plane', () => {
  let env: Env
  afterEach(() => env?.cleanup())
  test('a Business upgrade from Paddle gives the team the 1 TB quota in its env', async () => {
    env = setup()
    const s = await signedUpTeam(env)
    const sub = (price: string) => ({ id: 'sub_01', status: 'active', customer_id: 'ctm_01', items: [{ price: { id: price }, quantity: 1 }], custom_data: { tdcloud_team: s.team.id } })
    await webhook(env, event('subscription.created', sub('pri_team_m')))
    await env.cloud.runDueJobs()
    expect(env.driver.instances.get('acme')!.spec.env).toMatchObject({ TDRIVE_HOSTED: '1', TDRIVE_STORAGE_QUOTA: '100GB' })
    await webhook(env, event('subscription.updated', sub('pri_biz_m')))
    await env.cloud.runDueJobs()
    expect(teamBySlug(env.cloud.db, 'acme')!.plan).toBe('business')
    expect(env.driver.instances.get('acme')!.spec.env.TDRIVE_STORAGE_QUOTA).toBe('1000GB')
  })
  test('control plane: X-Forwarded-For from the trusted proxy is read from the right', async () => {
    env = setup({ TDCLOUD_TRUSTED_PROXIES: '127.0.0.1' })
    // a client-written entry on the left must not pick the rate-limit bucket
    const signup = (i: number, xff: string) => env.call('POST', '/api/signup', { body: { email: `n${i}@x.test`, password: 'long enough pw' }, ip: '127.0.0.1', headers: { 'x-forwarded-for': xff } })
    for (let i = 0; i < 10; i++) expect((await signup(i, `198.51.100.${i}, 203.0.113.5`)).status).toBe(200)
    expect((await signup(10, '198.51.100.99, 203.0.113.5')).status).toBe(429)
    expect((await signup(11, '203.0.113.6')).status).toBe(200)
  })
})
