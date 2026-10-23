// Mail through Resend: the client (retries, idempotency, redaction), the key from SSM or a 0600 file, the host relay
// with the Resend and SMTP upstreams, the control plane's mailer, and the resend-domain script. Everything talks to
// fakes (a local HTTP server standing in for api.resend.com, a local SMTP server, fake SSM): no real mail, no real key.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { AwsClient, CredentialProvider } from '../src/aws'
import { ConfigError, DEFAULT_TEAM_SUBNETS, loadConfig } from '../src/config'
import { mailerFor } from '../src/mailer'
import { makeRelay, relayFromEnv, ResendUpstream, SmtpUpstream, upstreamFromEnv } from '../src/relay'
import { ResendClient, ResendError, Secret, readSecretFile, redact } from '../src/resend'
import { SmtpSender, smtpSettings } from '../src/smtp'
import { checkDns, fqdn, parseArgs, planChanges, relative, run, type Deps, type Resolver } from '../../scripts/resend-domain'

const KEY = 're_FAKE_test_key_0123456789abcdef'
const FROM = 'Trina Drive <drive@drive.trina.app>'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tdc-resend-'))
const keyFile = (mode = 0o600, value = KEY) => { const f = path.join(tmp, `key-${Math.random().toString(36).slice(2)}`); fs.writeFileSync(f, `${value}\n`, { mode }); fs.chmodSync(f, mode); return f }
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

// ---- a fake api.resend.com
interface Seen { method: string; path: string; headers: Record<string, string>; body: Record<string, unknown> }
let seen: Seen[] = []
let answers: (() => Response)[] = []
let server: ReturnType<typeof Bun.serve>
let endpoint = ''
beforeAll(() => {
  server = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    async fetch(req) {
      const u = new URL(req.url)
      const text = await req.text()
      seen.push({ method: req.method, path: u.pathname, headers: Object.fromEntries(req.headers), body: text ? JSON.parse(text) : {} })
      const next = answers.shift()
      return next ? next() : Response.json({ id: `email-${seen.length}` })
    },
  })
  endpoint = `http://127.0.0.1:${server.port}`
})
afterAll(() => server.stop(true))
afterEach(() => { seen = []; answers = [] })

const staticKey = (k = KEY) => { const s = { forgot: 0, get: async () => k, forget: () => { s.forgot++ } }; return s }
const noSleep = () => { const waits: number[] = []; return { waits, sleep: async (ms: number) => { waits.push(ms) } } }

/** console output during fn (the relay and the clients must never print the key) */
async function capture(fn: () => Promise<unknown>): Promise<string> {
  const out: string[] = []
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info }
  for (const k of Object.keys(orig) as (keyof typeof orig)[]) console[k] = (...a: unknown[]) => { out.push(a.map(String).join(' ')) }
  try { await fn() } finally { Object.assign(console, orig) }
  return out.join('\n')
}

describe('Resend client', () => {
  test('POST /emails with the Bearer key, an idempotency key and the message; returns the id', async () => {
    const c = new ResendClient({ key: staticKey(), endpoint })
    expect(await c.send({ from: FROM, to: 'dana@acme.test', subject: 'You are invited', text: 'link', html: '<p>link</p>', tags: { source: 'team', team: '7', 'bad tag!': 'x' } })).toBe('email-1')
    expect(seen).toHaveLength(1)
    const s = seen[0]!
    expect(s.method).toBe('POST')
    expect(s.path).toBe('/emails')
    expect(s.headers.authorization).toBe(`Bearer ${KEY}`)
    expect(s.headers['idempotency-key']).toMatch(/^tdcloud-[0-9a-f-]{36}$/)
    expect(s.body).toEqual({ from: FROM, to: ['dana@acme.test'], subject: 'You are invited', text: 'link', html: '<p>link</p>', tags: [{ name: 'source', value: 'team' }, { name: 'team', value: '7' }] })
  })

  test('429: waits Retry-After and tries again with the same idempotency key', async () => {
    answers = [() => Response.json({ name: 'rate_limit_exceeded' }, { status: 429, headers: { 'retry-after': '2' } })]
    const t = noSleep()
    const c = new ResendClient({ key: staticKey(), endpoint, sleep: t.sleep })
    expect(await c.send({ from: FROM, to: 'a@x.test', subject: 's', text: 't' })).toBe('email-2')
    expect(t.waits).toEqual([2000])
    expect(seen).toHaveLength(2)
    expect(seen[0]!.headers['idempotency-key']).toBe(seen[1]!.headers['idempotency-key']!)
  })

  test('5xx and network errors: backoff and retry; gives up after the attempts', async () => {
    answers = [() => new Response('oops', { status: 500 }), () => new Response('down', { status: 503 })]
    const t = noSleep()
    expect(await new ResendClient({ key: staticKey(), endpoint, sleep: t.sleep }).send({ from: FROM, to: 'a@x.test', subject: 's', text: 't' })).toBe('email-3')
    expect(t.waits).toEqual([500, 1000])

    seen = []
    answers = Array.from({ length: 10 }, () => () => new Response('bad gateway', { status: 502 }))
    const t2 = noSleep()
    const e = await new ResendClient({ key: staticKey(), endpoint, sleep: t2.sleep, attempts: 3 }).send({ from: FROM, to: 'a@x.test', subject: 's', text: 't' }).catch((x) => x)
    expect(e).toBeInstanceOf(ResendError)
    expect((e as ResendError).status).toBe(502)
    expect(seen).toHaveLength(3)

    answers = []
    let calls = 0
    const flaky = async (u: string, i?: RequestInit) => { if (++calls === 1) throw new Error('ECONNRESET'); return fetch(u, i) }
    expect(await new ResendClient({ key: staticKey(), endpoint, fetch: flaky, sleep: noSleep().sleep }).send({ from: FROM, to: 'a@x.test', subject: 's', text: 't' })).toMatch(/^email-/)
    expect(calls).toBe(2)
  })

  test('the deadline wins over Retry-After; 4xx is not retried; 401 forgets the key', async () => {
    let now = 0
    answers = [() => new Response('slow down', { status: 429, headers: { 'retry-after': '10' } })]
    const t = noSleep()
    await expect(new ResendClient({ key: staticKey(), endpoint, sleep: t.sleep, deadlineMs: 5000, now: () => now }).send({ from: FROM, to: 'a@x.test', subject: 's', text: 't' })).rejects.toThrow(/429/)
    expect(t.waits).toEqual([])

    seen = []
    answers = [() => Response.json({ name: 'validation_error', message: 'bad from' }, { status: 422 })]
    await expect(new ResendClient({ key: staticKey(), endpoint, sleep: noSleep().sleep }).send({ from: FROM, to: 'a@x.test', subject: 's', text: 't' })).rejects.toThrow(/422/)
    expect(seen).toHaveLength(1)

    seen = []
    const k = staticKey()
    answers = [() => Response.json({ name: 'restricted_api_key' }, { status: 401 })]
    await expect(new ResendClient({ key: k, endpoint, sleep: noSleep().sleep }).send({ from: FROM, to: 'a@x.test', subject: 's', text: 't' })).rejects.toThrow(/401/)
    expect(seen).toHaveLength(1)
    expect(k.forgot).toBe(1)
    void now
  })

  test('an error that echoes the key comes out redacted', async () => {
    answers = [() => new Response(`invalid key ${KEY} (Bearer ${KEY})`, { status: 400 })]
    const e = await new ResendClient({ key: staticKey(), endpoint }).send({ from: FROM, to: 'a@x.test', subject: 's', text: 't' }).then(() => new Error('did not fail'), (x: unknown) => x as Error)
    expect(e.message).toContain('[redacted]')
    expect(e.message).not.toContain(KEY)
    expect(redact('token re_abcdefghijklmnop here')).toBe('token re_[redacted] here')
  })
})

describe('the key: SSM SecureString or a 0600 file', () => {
  test('SSM GetParameter with decryption, cached, read again after forget()', async () => {
    const calls: { target: string; body: Record<string, unknown> }[] = []
    const ssm = async (_u: string, init?: RequestInit) => {
      calls.push({ target: String((init?.headers as Record<string, string>)['x-amz-target']), body: JSON.parse(String(init?.body)) })
      return Response.json({ Parameter: { Name: '/tdcloud/hosts/resend-api-key', Type: 'SecureString', Value: `${KEY}\n` } })
    }
    const aws = new AwsClient('ap-northeast-2', new CredentialProvider({ AWS_ACCESS_KEY_ID: 'ASIAHOST', AWS_SECRET_ACCESS_KEY: 'k' }), ssm as never)
    const s = new Secret({ param: '/tdcloud/hosts/resend-api-key', aws })
    expect(await s.get()).toBe(KEY)
    expect(await s.get()).toBe(KEY)
    expect(calls).toEqual([{ target: 'AmazonSSM.GetParameter', body: { Name: '/tdcloud/hosts/resend-api-key', WithDecryption: true } }])
    s.forget()
    await s.get()
    expect(calls).toHaveLength(2)
  })

  test('a file readable by others is refused; the error never carries the contents', () => {
    expect(readSecretFile(keyFile(0o600))).toBe(KEY)
    const loose = keyFile(0o644)
    expect(() => readSecretFile(loose)).toThrow(/chmod 600/)
    try { readSecretFile(loose) } catch (e) { expect((e as Error).message).not.toContain(KEY) }
    expect(() => readSecretFile(path.join(tmp, 'missing'))).toThrow(/no key file/)
  })
})

describe('mail relay → Resend', () => {
  const body = (o: Record<string, unknown> = {}) => JSON.stringify({ FromEmailAddress: FROM, Destination: { ToAddresses: ['dana@acme.test'] }, Content: { Simple: { Subject: { Data: 'You are invited' }, Body: { Text: { Data: 'hi' } } } }, ...o })
  const post = (h: ReturnType<typeof makeRelay>, peer: string, b = body()) => h(new Request('http://10.128.0.17:8025/v2/email/outbound-emails', { method: 'POST', body: b }), peer)
  const relay = (logs: string[], o: { attempts?: number } = {}) => makeRelay({
    pool: DEFAULT_TEAM_SUBNETS, from: FROM, log: (s) => logs.push(s),
    upstream: new ResendUpstream(new ResendClient({ key: staticKey(), endpoint, sleep: noSleep().sleep, ...o })),
  })

  test('forwards a team\'s mail with the team From, one recipient, tagged with the team', async () => {
    const logs: string[] = []
    const r = await post(relay(logs), '10.128.0.19')
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ MessageId: 'email-1' })
    expect(seen[0]!.body).toEqual({ from: FROM, to: ['dana@acme.test'], subject: 'You are invited', text: 'hi', tags: [{ name: 'source', value: 'team' }, { name: 'team', value: '1' }] })
    expect(logs.join('\n')).toContain('(resend email-1)')
  })

  test('"<team> via Trina Drive" on the team address goes out quoted; any other display name is refused', async () => {
    const h = relay([])
    expect((await post(h, '10.128.0.19', body({ FromEmailAddress: 'Acme, Inc. via Trina Drive <drive@drive.trina.app>' }))).status).toBe(200)
    expect(seen[0]!.body.from).toBe('"Acme, Inc. via Trina Drive" <drive@drive.trina.app>')
    expect((await post(h, '10.128.0.19', body({ FromEmailAddress: 'drive@drive.trina.app' }))).status).toBe(200)
    expect(seen[1]!.body.from).toBe(FROM)
    for (const from of ['PayPal Security <drive@drive.trina.app>', '"x\\" <a@b> via Trina Drive" <drive@drive.trina.app>', `${'a'.repeat(65)} via Trina Drive <drive@drive.trina.app>`, ' via Trina Drive <drive@drive.trina.app>', 'Acme via Trina Drive <ceo@drive.trina.app>']) {
      expect({ from, status: (await post(h, '10.128.0.19', body({ FromEmailAddress: from }))).status }).toEqual({ from, status: 400 })
    }
    expect(seen).toHaveLength(2)
  })

  test('disallowed mail never reaches Resend', async () => {
    const h = relay([])
    for (const peer of ['10.128.0.18', '172.17.0.2', '127.0.0.1']) expect((await post(h, peer)).status).toBe(403)
    expect((await post(h, '10.128.0.19', body({ FromEmailAddress: 'CEO <ceo@bank.example>' }))).status).toBe(400)
    expect((await post(h, '10.128.0.19', body({ Destination: { ToAddresses: ['a@x.test'], CcAddresses: ['b@x.test'] } }))).status).toBe(400)
    expect((await post(h, '10.128.0.19', body({ Destination: { ToAddresses: ['a@x.test', 'b@x.test'] } }))).status).toBe(400)
    expect((await post(h, '10.128.0.19', body({ Content: { Raw: { Data: 'RnJvbTog' } } }))).status).toBe(400)
    const limited = makeRelay({ pool: DEFAULT_TEAM_SUBNETS, from: FROM, log: () => {}, perHour: 1, upstream: new ResendUpstream(new ResendClient({ key: staticKey(), endpoint })) })
    expect((await post(limited, '10.128.0.19')).status).toBe(200)
    expect((await post(limited, '10.128.0.19')).status).toBe(429)
    expect(seen).toHaveLength(1)
  })

  test('Resend busy then fine: the team gets 200; Resend down: 502, and the key is in no log line', async () => {
    answers = [() => new Response('', { status: 429, headers: { 'retry-after': '1' } })]
    expect((await post(relay([]), '10.128.0.19')).status).toBe(200)
    expect(seen).toHaveLength(2)

    seen = []
    answers = Array.from({ length: 10 }, () => () => new Response(`upstream broke; auth was Bearer ${KEY}`, { status: 500 }))
    const logs: string[] = []
    let status = 0
    const printed = await capture(async () => { status = (await post(relay(logs, { attempts: 3 }), '10.128.0.19')).status })
    expect(status).toBe(502)
    expect(seen).toHaveLength(3)
    expect(logs.join('\n')).toContain('mail failed: team 1: resend: 500')
    expect(logs.join('\n') + printed).not.toContain(KEY)
  })

  test('relayFromEnv: resend upstream, the key read from SSM with the host role, nothing printed', async () => {
    const ssm = async () => Response.json({ Parameter: { Value: KEY } })
    const aws = new AwsClient('ap-northeast-2', new CredentialProvider({ AWS_ACCESS_KEY_ID: 'ASIAHOST', AWS_SECRET_ACCESS_KEY: 'k' }), ssm as never)
    const logs: string[] = []
    const printed = await capture(async () => {
      const r = relayFromEnv({ TDCLOUD_TEAM_MAIL_FROM: FROM, TDCLOUD_MAIL_UPSTREAM: 'resend', TDCLOUD_RESEND_API_KEY_PARAM: '/tdcloud/hosts/resend-api-key', TDCLOUD_RESEND_ENDPOINT: endpoint }, { aws, log: (s) => logs.push(s) })
      expect(r.upstream.name).toBe('resend')
      expect((await post(r.handle, '10.128.0.19')).status).toBe(200)
    })
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${KEY}`)
    expect(logs.join('\n') + printed).not.toContain(KEY)
  })

  test('TDCLOUD_MAIL_UPSTREAM picks the upstream (the old TDCLOUD_MAIL_RELAY_UPSTREAM still works)', () => {
    const aws = new AwsClient('ap-northeast-2', new CredentialProvider({ AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 'b' }))
    expect(upstreamFromEnv({ TDCLOUD_MAIL_UPSTREAM: 'resend', TDCLOUD_RESEND_API_KEY_PARAM: '/tdcloud/hosts/resend-api-key' }, aws).name).toBe('resend')
    expect(upstreamFromEnv({}, aws).name).toBe('ses')
    expect(upstreamFromEnv({ TDCLOUD_MAIL_UPSTREAM: 'smtp' }, aws).name).toBe('smtp')
    expect(upstreamFromEnv({ TDCLOUD_MAIL_RELAY_UPSTREAM: `outbox:${tmp}/sink.log` }, aws).name).toBe('outbox')
    expect(() => upstreamFromEnv({ TDCLOUD_MAIL_UPSTREAM: 'mailgun' }, aws)).toThrow(/resend, ses, smtp/)
    expect(() => upstreamFromEnv({ TDCLOUD_MAIL_UPSTREAM: 'resend', TDCLOUD_RESEND_API_KEY_PARAM: 'no-slash' }, aws)).toThrow(/SSM parameter/)
  })
})

describe('control plane mail through Resend', () => {
  const base = { TDCLOUD_STATE_DIR: tmp, TDCLOUD_TEAM_MAIL_FROM: FROM, TDCLOUD_MAIL_FROM: 'Trina Cloud <cloud@drive.trina.app>' }
  test('TDCLOUD_MAILER=resend sends the control plane\'s mail with its From, the key from the 0600 file', async () => {
    const cfg = loadConfig({ ...base, TDCLOUD_MAILER: 'resend', TDCLOUD_RESEND_API_KEY_FILE: keyFile(), TDCLOUD_RESEND_ENDPOINT: endpoint })
    const aws = new AwsClient('ap-northeast-2', new CredentialProvider({ AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 'b' }))
    const printed = await capture(() => mailerFor(cfg, aws).send({ to: 'buyer@acme.test', subject: 'Confirm your email for Trina Cloud', text: 'https://…' }))
    expect(seen[0]!.body).toEqual({ from: 'Trina Cloud <cloud@drive.trina.app>', to: ['buyer@acme.test'], subject: 'Confirm your email for Trina Cloud', text: 'https://…', tags: [{ name: 'source', value: 'control' }] })
    expect(printed).not.toContain(KEY)
  })
  test('production: resend needs the SSM parameter; outbox is refused', () => {
    const prod = { ...base, TDCLOUD_ENV: 'production', TDCLOUD_CONTROL_URL: 'https://cloud.trina.app', TDCLOUD_KMS_KEY_ID: 'alias/tdcloud', PADDLE_WEBHOOK_SECRET: 'x', TDCLOUD_CADDY_ASK_KEY: 'y' }
    expect(() => loadConfig({ ...prod, TDCLOUD_MAILER: 'resend' })).toThrow(/TDCLOUD_RESEND_API_KEY_PARAM/)
    expect(() => loadConfig({ ...prod })).toThrow(ConfigError)
    const cfg = loadConfig({ ...prod, TDCLOUD_MAILER: 'resend', TDCLOUD_RESEND_API_KEY_PARAM: '/tdcloud/control/resend-api-key' })
    expect(cfg.resend).toMatchObject({ keyParam: '/tdcloud/control/resend-api-key', endpoint: 'https://api.resend.com' })
    expect(() => loadConfig({ ...base, TDCLOUD_MAILER: 'postfix' })).toThrow(/outbox, resend, ses or smtp/)
  })
})

describe('SMTP upstream (fake server)', () => {
  test('AUTH PLAIN with the key file as password, one recipient, MIME with the team From', async () => {
    const lines: string[] = []
    let data = ''
    const srv = net.createServer((sock) => {
      let inData = false, buf = ''
      sock.write('220 fake ESMTP\r\n')
      sock.on('data', (d) => {
        buf += d.toString()
        let i: number
        while ((i = buf.indexOf('\r\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 2)
          if (inData) { if (line === '.') { inData = false; sock.write('250 queued as fake-1\r\n') } else data += line + '\n'; continue }
          lines.push(line)
          if (/^EHLO/.test(line)) sock.write('250-fake\r\n250 AUTH PLAIN\r\n')
          else if (/^AUTH/.test(line)) sock.write('235 ok\r\n')
          else if (/^(MAIL|RCPT)/.test(line)) sock.write('250 ok\r\n')
          else if (line === 'DATA') { inData = true; sock.write('354 go\r\n') }
          else if (line === 'QUIT') { sock.write('221 bye\r\n'); sock.end() }
        }
      })
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    const port = (srv.address() as net.AddressInfo).port
    try {
      const s = smtpSettings({ TDCLOUD_SMTP_HOST: '127.0.0.1', TDCLOUD_SMTP_PORT: String(port), TDCLOUD_SMTP_TLS: 'none', TDCLOUD_RESEND_API_KEY_FILE: keyFile() })
      expect(s.user).toBe('resend')
      const aws = new AwsClient('ap-northeast-2', new CredentialProvider({ AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 'b' }))
      const h = makeRelay({ pool: DEFAULT_TEAM_SUBNETS, from: FROM, log: () => {}, upstream: new SmtpUpstream(new SmtpSender(s, aws)) })
      const r = await h(new Request('http://x/v2/email/outbound-emails', { method: 'POST', body: JSON.stringify({ FromEmailAddress: FROM, Destination: { ToAddresses: ['dana@acme.test'] }, Content: { Simple: { Subject: { Data: '초대' }, Body: { Text: { Data: 'hi' } } } } }) }), '10.128.0.19')
      expect(r.status).toBe(200)
      const auth = lines.find((l) => l.startsWith('AUTH PLAIN '))!
      expect(Buffer.from(auth.slice(11), 'base64').toString()).toBe(`\0resend\0${KEY}`)
      expect(lines).toContain('MAIL FROM:<drive@drive.trina.app>')
      expect(lines).toContain('RCPT TO:<dana@acme.test>')
      expect(data).toContain(`From: ${FROM}`)
      expect(data).toContain('Subject: =?UTF-8?B?')
      expect(smtpSettings({}).tls).toBe('implicit')
      expect(() => smtpSettings({ TDCLOUD_SMTP_TLS: 'maybe' })).toThrow()
    } finally { srv.close() }
  })
})

describe('resend-domain script', () => {
  const dnsOk: Resolver = {
    resolveTxt: async (n) => n.startsWith('resend._domainkey.') ? [[`p=${'A'.repeat(200)}`]] : n.startsWith('send.') ? [['v=spf1 include:amazonses.com ~all']] : n.startsWith('_dmarc.') ? [['v=DMARC1; p=quarantine']] : [],
    resolveMx: async (n) => n.startsWith('send.') ? [{ exchange: 'feedback-smtp.ap-northeast-1.amazonses.com', priority: 10 }] : [],
  }
  const deps = (o: Partial<Deps> = {}) => {
    const out: string[] = [], awsCalls: string[][] = []
    const d: Deps = { fetch: (u, i) => fetch(u, i), aws: async (a) => { awsCalls.push(a); return '{"HostedZones":[{"Id":"/hostedzone/ZTEST","Name":"trina.app."}]}' }, dns: dnsOk, log: (s) => out.push(s), key: () => KEY, ...o }
    return { d, out, awsCalls }
  }

  test('names: Resend\'s relative names land inside the domain; Cloudflare names are relative to trina.app', () => {
    expect(fqdn('resend._domainkey.drive', 'drive.trina.app', 'trina.app')).toBe('resend._domainkey.drive.trina.app')
    expect(fqdn('send', 'drive.trina.app', 'trina.app')).toBe('send.drive.trina.app')
    expect(fqdn('send.drive.trina.app.', 'drive.trina.app', 'trina.app')).toBe('send.drive.trina.app')
    expect(relative('send.drive.trina.app', 'trina.app')).toBe('send.drive')
    const c = planChanges([
      { record: 'DKIM', name: 'resend._domainkey.drive', type: 'TXT', value: `p=${'B'.repeat(300)}`, ttl: 'Auto' },
      { record: 'SPF', name: 'send.drive', type: 'MX', value: 'feedback-smtp.ap-northeast-1.amazonses.com', priority: 10 },
      { record: 'SPF', name: 'send.drive', type: 'TXT', value: '"v=spf1 include:amazonses.com ~all"' },
    ], 'drive.trina.app', 'trina.app')
    expect(c.map((x) => [x.ResourceRecordSet.Name, x.ResourceRecordSet.Type, x.ResourceRecordSet.TTL])).toEqual([['resend._domainkey.drive.trina.app', 'TXT', 300], ['send.drive.trina.app', 'MX', 300], ['send.drive.trina.app', 'TXT', 300]])
    expect(c[0]!.ResourceRecordSet.ResourceRecords[0]!.Value).toMatch(/^"p=B{253}" "B+"$/)
    expect(c[1]!.ResourceRecordSet.ResourceRecords[0]!.Value).toBe('10 feedback-smtp.ap-northeast-1.amazonses.com')
    expect(c[2]!.ResourceRecordSet.ResourceRecords[0]!.Value).toBe('"v=spf1 include:amazonses.com ~all"')
  })

  test('default: no API call, no AWS call — prints what to add at Cloudflare and checks public DNS', async () => {
    const o = parseArgs([], {})
    expect(o).toMatchObject({ domain: 'drive.trina.app', root: 'trina.app', region: 'ap-northeast-1', records: false, route53: false })
    const { d, out, awsCalls } = deps({ fetch: async () => { throw new Error('no API call expected') }, key: () => { throw new Error('no key expected') } })
    const r = await run(o, d)
    expect(awsCalls).toEqual([])
    expect(r.checks.every((x) => x.ok)).toBe(true)
    expect(out.join('\n')).toContain('resend._domainkey.drive')
    expect(out.join('\n')).not.toContain(KEY)
    const missing = await checkDns(o, { resolveTxt: async () => { throw new Error('ENOTFOUND') }, resolveMx: async () => [] })
    expect(missing.map((x) => x.ok)).toEqual([false, false, false, false])
  })

  test('--records with a sending-only key: a clear message, no key in it', async () => {
    answers = [() => Response.json({ statusCode: 401, name: 'restricted_api_key', message: 'This API key is restricted to only send emails' }, { status: 401 })]
    const { d } = deps()
    const e = await run(parseArgs(['--records'], { RESEND_API_URL: endpoint }), d).then(() => new Error('did not fail'), (x: unknown) => x as Error)
    expect(e.message).toMatch(/sending-only key/)
    expect(e.message).not.toContain(KEY)
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual(['GET /domains'])
  })

  test('--records --route53 --dry-run: reads the records, plans the upserts, changes nothing', async () => {
    answers = [
      () => Response.json({ data: [{ id: 'd1', name: 'drive.trina.app', status: 'pending', region: 'ap-northeast-1' }] }),
      () => Response.json({ id: 'd1', name: 'drive.trina.app', status: 'pending', region: 'ap-northeast-1', records: [{ record: 'DKIM', name: 'resend._domainkey.drive', type: 'TXT', value: `p=${'C'.repeat(200)}` }] }),
    ]
    const { d, awsCalls } = deps()
    const r = await run(parseArgs(['--records', '--route53', '--dry-run'], { RESEND_API_URL: endpoint }), d)
    expect(r.changes).toHaveLength(1)
    expect(awsCalls.map((a) => a[1])).toEqual(['list-hosted-zones-by-name'])
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual(['GET /domains', 'GET /domains/d1'])
    expect(() => parseArgs(['--route53'], {})).toThrow(/--records/)
  })
})
