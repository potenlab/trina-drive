// The real mailer (hosted instances: invites, password resets, notifications): SMTP with STARTTLS or implicit TLS
// against a local sink, Amazon SES v2 (SigV4) against a mocked endpoint, configuration from the environment, and the
// web's invite mail going through it.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mailerFor, SmtpMailer } from '../src/notify/channels'
import { loadNotifyConfig, mailEnv } from '../src/notify/config'
import { AwsCredentialProvider, SesMailer, signV4 } from '../src/notify/ses'
import { RelayMailer } from '../src/web/mail'
import { decodeMail, smtpSink } from './notify-helpers'
import { webSetup } from './web-helpers'

const node = Bun.which('node'), openssl = Bun.which('openssl')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tdrive-mail-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('configuration from the environment', () => {
  const E = (o: Record<string, string>) => o
  test('not set: nothing changes', () => {
    expect(mailEnv({})).toBeNull()
    expect(loadNotifyConfig(tmp, {}, {}).email.mode).toBe('outbox')
  })
  test('smtp: STARTTLS by default, implicit TLS on 465, password from the environment', () => {
    expect(mailEnv(E({ TDRIVE_MAILER: 'smtp', TDRIVE_MAIL_FROM: 'team@ex.test', TDRIVE_SMTP_HOST: 'smtp.ex.test', TDRIVE_SMTP_USER: 'u', TDRIVE_SMTP_PASS: 'p' })))
      .toEqual({ mode: 'smtp', from: 'team@ex.test', smtp: { host: 'smtp.ex.test', port: 587, secure: false, starttls: true, user: 'u', pass: 'p' } })
    expect(mailEnv(E({ TDRIVE_MAILER: 'smtp', TDRIVE_MAIL_FROM: 'a@b.test', TDRIVE_SMTP_HOST: 'h', TDRIVE_SMTP_PORT: '465' }))!.smtp).toMatchObject({ secure: true, starttls: false })
    expect(mailEnv(E({ TDRIVE_MAILER: 'smtp', TDRIVE_MAIL_FROM: 'a@b.test', TDRIVE_SMTP_HOST: 'h', TDRIVE_SMTP_PORT: '25', TDRIVE_SMTP_TLS: 'none' }))!.smtp).toMatchObject({ secure: false, starttls: false })
    const c = loadNotifyConfig(tmp, {}, E({ TDRIVE_MAILER: 'smtp', TDRIVE_MAIL_FROM: 'team@ex.test', TDRIVE_SMTP_HOST: 'h', TDRIVE_SMTP_PASS: 'secret' }))
    expect(c.email).toMatchObject({ mode: 'smtp', from: 'team@ex.test', smtp: { host: 'h', pass: 'secret' } })
    expect(mailerFor(c.email, tmp)).toBeInstanceOf(SmtpMailer)
  })
  test('ses: region from TDRIVE_SES_REGION or AWS_REGION', () => {
    expect(mailEnv(E({ TDRIVE_MAILER: 'ses', TDRIVE_MAIL_FROM: 'a@b.test', AWS_REGION: 'ap-northeast-2' }))).toEqual({ mode: 'ses', from: 'a@b.test', ses: { region: 'ap-northeast-2' } })
    const c = loadNotifyConfig(tmp, {}, E({ TDRIVE_MAILER: 'ses', TDRIVE_MAIL_FROM: 'a@b.test', TDRIVE_SES_REGION: 'us-east-1', TDRIVE_SES_ENDPOINT: 'http://127.0.0.1:1' }))
    expect(c.email.ses).toEqual({ region: 'us-east-1', endpoint: 'http://127.0.0.1:1' })
    expect(mailerFor(c.email, tmp)).toBeInstanceOf(SesMailer)
  })
  test.each([
    [{ TDRIVE_MAILER: 'smtp', TDRIVE_SMTP_HOST: 'h' }, 'MAIL_FROM'],
    [{ TDRIVE_MAILER: 'smtp', TDRIVE_MAIL_FROM: 'a@b.test' }, 'SMTP_HOST'],
    [{ TDRIVE_MAILER: 'smtp', TDRIVE_MAIL_FROM: 'a@b.test', TDRIVE_SMTP_HOST: 'h', TDRIVE_SMTP_PORT: 'x' }, 'PORT'],
    [{ TDRIVE_MAILER: 'smtp', TDRIVE_MAIL_FROM: 'a@b.test', TDRIVE_SMTP_HOST: 'h', TDRIVE_SMTP_TLS: 'maybe' }, 'SMTP_TLS'],
    [{ TDRIVE_MAILER: 'ses', TDRIVE_MAIL_FROM: 'a@b.test' }, 'SES_REGION'],
    [{ TDRIVE_MAILER: 'carrier-pigeon', TDRIVE_MAIL_FROM: 'a@b.test' }, 'must be'],
  ])('half-configured refuses to start: %p', (env, msg) => {
    expect(() => mailEnv(env)).toThrow(msg)
  })
})

describe.skipIf(!node || !openssl)('SMTP over TLS (local sink)', () => {
  let key = '', cert = ''
  const sinks: ReturnType<typeof Bun.spawn>[] = []
  beforeAll(() => {
    key = path.join(tmp, 'key.pem'); cert = path.join(tmp, 'cert.pem')
    // RSA: Bun's TLS client fails the handshake with LibreSSL's EC test certificates
    const r = Bun.spawnSync([openssl!, 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
      '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'])
    if (r.exitCode !== 0) throw new Error(`openssl: ${r.stderr}`)
  })
  afterAll(() => { for (const s of sinks) s.kill() })

  async function sink(mode: 'starttls' | 'tls' | 'no-starttls') {
    const p = Bun.spawn([node!, path.join(import.meta.dir, 'smtp-tls-sink.mjs'), mode, key, cert], { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' })
    sinks.push(p)
    const reader = p.stdout.getReader()
    let buf = ''
    const lines: any[] = []
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        buf += new TextDecoder().decode(value)
        let i: number
        while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1) }
      }
    })()
    void pump
    while (!lines.length) await Bun.sleep(10)
    const port = lines.shift().port as number
    return { port, messages: lines }
  }
  const ca = () => fs.readFileSync(cert)

  test('STARTTLS: upgraded before AUTH and the message', async () => {
    const s = await sink('starttls')
    await new SmtpMailer({ host: '127.0.0.1', port: s.port, starttls: true, user: 'u', pass: 'p', tls: { ca: ca() } })
      .send({ from: 'Team <team@ex.test>', to: 'kim@ex.test', subject: 'Hello 안녕', text: 'line\n.dot line\n' })
    expect(s.messages).toHaveLength(1)
    const m = s.messages[0]
    expect(m).toMatchObject({ from: '<team@ex.test>', to: '<kim@ex.test>', tls: true, auth: { secure: true, plain: '\0u\0p' } })
    const d = decodeMail(m.data)
    expect(d.subject).toBe('Hello 안녕')
    expect(d.body).toBe('line\n.dot line\n')
  })
  test('implicit TLS (465)', async () => {
    const s = await sink('tls')
    await new SmtpMailer({ host: '127.0.0.1', port: s.port, secure: true, user: 'u', pass: 'p', tls: { ca: ca() } }).send({ from: 'a@ex.test', to: 'b@ex.test', subject: 's', text: 't' })
    expect(s.messages[0]).toMatchObject({ tls: true, auth: { secure: true } })
  })
  test('STARTTLS required: a server that does not offer it gets no password and no message', async () => {
    const s = await sink('no-starttls')
    await expect(new SmtpMailer({ host: '127.0.0.1', port: s.port, starttls: true, user: 'u', pass: 'p', tls: { ca: ca() } }).send({ from: 'a@ex.test', to: 'b@ex.test', subject: 's', text: 't' }))
      .rejects.toThrow('STARTTLS')
    await Bun.sleep(50)
    expect(s.messages).toHaveLength(0)
  })
  test('an untrusted certificate is refused', async () => {
    const s = await sink('starttls')
    await expect(new SmtpMailer({ host: '127.0.0.1', port: s.port, starttls: true, timeoutMs: 3000 }).send({ from: 'a@ex.test', to: 'b@ex.test', subject: 's', text: 't' })).rejects.toThrow()
    expect(s.messages).toHaveLength(0)
  })
})

describe('Amazon SES v2 (mocked endpoint)', () => {
  const hits: { path: string; headers: Record<string, string>; body: string }[] = []
  let status = 200
  const ses = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    async fetch(req) {
      hits.push({ path: new URL(req.url).pathname, headers: Object.fromEntries(req.headers), body: await req.text() })
      return status === 200 ? Response.json({ MessageId: 'm-1' }) : new Response('{"message":"Email address is not verified."}', { status })
    },
  })
  afterAll(() => ses.stop(true))
  const endpoint = `http://127.0.0.1:${ses.port}`

  test('SendEmail, signed with environment credentials', async () => {
    const env = { AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE', AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', AWS_SESSION_TOKEN: 'sess' }
    const m = new SesMailer({ region: 'ap-northeast-2', endpoint, configurationSet: 'tdrive' }, new AwsCredentialProvider(env))
    await m.send({ from: 'team@ex.test', to: 'kim@ex.test', subject: 'Invite', text: 'hello' })
    const h = hits.at(-1)!
    expect(h.path).toBe('/v2/email/outbound-emails')
    expect(JSON.parse(h.body)).toEqual({
      FromEmailAddress: 'team@ex.test', Destination: { ToAddresses: ['kim@ex.test'] }, ConfigurationSetName: 'tdrive',
      Content: { Simple: { Subject: { Data: 'Invite', Charset: 'UTF-8' }, Body: { Text: { Data: 'hello', Charset: 'UTF-8' } } } },
    })
    expect(h.headers['x-amz-security-token']).toBe('sess')
    const auth = h.headers.authorization!
    expect(auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/ap-northeast-2\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/)
    // the server side of SigV4: recompute from what arrived
    const amz = h.headers['x-amz-date']!
    const date = new Date(`${amz.slice(0, 4)}-${amz.slice(4, 6)}-${amz.slice(6, 8)}T${amz.slice(9, 11)}:${amz.slice(11, 13)}:${amz.slice(13, 15)}Z`)
    const again = signV4({ method: 'POST', url: `${endpoint}/v2/email/outbound-emails`, headers: { 'content-type': h.headers['content-type']! }, body: h.body, service: 'ses', region: 'ap-northeast-2', creds: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: 'sess' }, date })
    expect(again.authorization).toBe(auth)
  })
  test('SigV4 matches the AWS reference vector (get-vanilla)', () => {
    const h = signV4({ method: 'GET', url: 'https://example.amazonaws.com/', service: 'service', region: 'us-east-1', date: new Date('2015-08-30T12:36:00Z'),
      creds: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' } })
    expect(h.authorization).toBe('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31')
  })
  test('instance role credentials through IMDSv2', async () => {
    const calls: string[] = []
    const imds = async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`)
      if (url.endsWith('/api/token')) return new Response('imds-token')
      expect((init?.headers as Record<string, string>)['x-aws-ec2-metadata-token']).toBe('imds-token')
      if (url.endsWith('/security-credentials/')) return new Response('team-role\n')
      return Response.json({ AccessKeyId: 'ASIAROLE', SecretAccessKey: 'secret', Token: 'role-session', Expiration: new Date(Date.now() + 3600_000).toISOString() })
    }
    const creds = new AwsCredentialProvider({}, imds)
    await new SesMailer({ region: 'us-east-1', endpoint }, creds).send({ from: 'a@ex.test', to: 'b@ex.test', subject: 's', text: 't' })
    expect(hits.at(-1)!.headers.authorization).toContain('Credential=ASIAROLE/')
    expect(hits.at(-1)!.headers['x-amz-security-token']).toBe('role-session')
    await creds.get() // cached: IMDS is not asked again
    expect(calls).toEqual(['PUT /latest/api/token', 'GET /latest/meta-data/iam/security-credentials/', 'GET /latest/meta-data/iam/security-credentials/team-role'])
  })
  test('an SES error is thrown (the notifier retries; the web answers 502)', async () => {
    status = 400
    const m = new SesMailer({ region: 'us-east-1', endpoint }, new AwsCredentialProvider({ AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 'b' }))
    await expect(m.send({ from: 'a@ex.test', to: 'b@ex.test', subject: 's', text: 't' })).rejects.toThrow('ses SendEmail: 400')
    status = 200
  })
})

describe('the web\'s invites and resets through the real mailer', () => {
  test('an invite reaches the SMTP server with the link; a refused mail is a 502 the admin sees', async () => {
    const sink = await smtpSink()
    const e = await webSetup()
    try {
      e.w.mailer = new RelayMailer(new SmtpMailer({ host: '127.0.0.1', port: sink.port }), 'Team <team@ex.test>')
      const admin = await e.as('dion')
      const r = await admin.call('POST', '/api/people', { name: 'newbie', email: 'newbie@ex.test' })
      expect(r.status).toBe(200)
      expect(sink.messages).toHaveLength(1)
      expect(sink.messages[0]).toMatchObject({ from: '<team@ex.test>', to: '<newbie@ex.test>' })
      expect(decodeMail(sink.messages[0]!.data).body).toMatch(/\/#\/invite\/\S+/)
      e.w.mailer = new RelayMailer(new SmtpMailer({ host: '127.0.0.1', port: 1, timeoutMs: 2000 }), 'team@ex.test')
      const kim = e.pid('kim')
      const bad = await admin.call('POST', `/api/people/${kim}/reset`)
      expect(bad.status).toBe(502)
      expect(bad.data.error).toBe('mail_failed')
    } finally { sink.stop(); e.cleanup() }
  })
})
