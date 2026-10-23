// Amazon SES (API v2, SendEmail) without an SDK: Signature Version 4 over fetch, credentials from the environment
// (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN) or else the EC2 instance role through IMDSv2.
// The same signing as cloud/control/src/aws.ts (kept separate: the product does not depend on the control plane).
import crypto from 'node:crypto'
import type { Mail, Mailer } from './channels'

export interface AwsCredentials { accessKeyId: string; secretAccessKey: string; sessionToken?: string; expiresAt?: number }
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

const hmac = (key: crypto.BinaryLike, data: string) => crypto.createHmac('sha256', key).update(data).digest()
const hex = (data: string) => crypto.createHash('sha256').update(data).digest('hex')
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

/** SigV4, header form: the input headers plus host, x-amz-date, x-amz-security-token and authorization. */
export function signV4(i: { method: string; url: string; headers?: Record<string, string>; body?: string; service: string; region: string; creds: AwsCredentials; date?: Date }): Record<string, string> {
  const u = new URL(i.url)
  const amzDate = (i.date ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, '')
  const day = amzDate.slice(0, 8)
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(i.headers ?? {})) headers[k.toLowerCase()] = v
  headers.host = u.host
  headers['x-amz-date'] = amzDate
  if (i.creds.sessionToken) headers['x-amz-security-token'] = i.creds.sessionToken
  const names = Object.keys(headers).sort()
  const canonicalHeaders = names.map((k) => `${k}:${headers[k]!.trim().replace(/\s+/g, ' ')}\n`).join('')
  const signedHeaders = names.join(';')
  const query = [...u.searchParams.entries()].map(([k, v]) => [enc(k), enc(v)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&')
  const pathname = u.pathname.split('/').map((s) => enc(decodeURIComponent(s))).join('/') || '/'
  const canonical = [i.method.toUpperCase(), pathname, query, canonicalHeaders, signedHeaders, hex(i.body ?? '')].join('\n')
  const scope = `${day}/${i.region}/${i.service}/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, hex(canonical)].join('\n')
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${i.creds.secretAccessKey}`, day), i.region), i.service), 'aws4_request')
  const signature = crypto.createHmac('sha256', kSigning).update(toSign).digest('hex')
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${i.creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  return headers
}

/** Environment credentials, else the instance role (IMDSv2), cached until 5 minutes before they expire. */
export class AwsCredentialProvider {
  private cached: AwsCredentials | null = null
  constructor(private readonly env: Record<string, string | undefined> = process.env, private readonly fetchImpl: Fetch = fetch,
    private readonly imds = 'http://169.254.169.254/latest') {}
  async get(): Promise<AwsCredentials> {
    const e = this.env
    if (e.AWS_ACCESS_KEY_ID && e.AWS_SECRET_ACCESS_KEY) return { accessKeyId: e.AWS_ACCESS_KEY_ID, secretAccessKey: e.AWS_SECRET_ACCESS_KEY, sessionToken: e.AWS_SESSION_TOKEN || undefined }
    if (this.cached && (this.cached.expiresAt ?? 0) - 300_000 > Date.now()) return this.cached
    const token = await (await this.fetchImpl(`${this.imds}/api/token`, { method: 'PUT', headers: { 'x-aws-ec2-metadata-token-ttl-seconds': '21600' }, signal: AbortSignal.timeout(2000) })).text()
    const h = { 'x-aws-ec2-metadata-token': token }
    const role = (await (await this.fetchImpl(`${this.imds}/meta-data/iam/security-credentials/`, { headers: h, signal: AbortSignal.timeout(2000) })).text()).split('\n')[0]?.trim()
    if (!role) throw new Error('no AWS credentials in the environment and no instance role')
    const c = await (await this.fetchImpl(`${this.imds}/meta-data/iam/security-credentials/${role}`, { headers: h, signal: AbortSignal.timeout(2000) })).json() as { AccessKeyId: string; SecretAccessKey: string; Token: string; Expiration: string }
    this.cached = { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.Token, expiresAt: Date.parse(c.Expiration) }
    return this.cached
  }
}

export interface SesOptions {
  region: string
  /** default https://email.<region>.amazonaws.com (tests, VPC endpoints) */
  endpoint?: string
  configurationSet?: string
}

export class SesMailer implements Mailer {
  constructor(readonly opts: SesOptions, private readonly creds: AwsCredentialProvider = new AwsCredentialProvider(), private readonly fetchImpl: Fetch = fetch) {}
  async send(m: Mail) {
    const base = (this.opts.endpoint ?? `https://email.${this.opts.region}.amazonaws.com`).replace(/\/$/, '')
    const url = `${base}/v2/email/outbound-emails`
    const body = JSON.stringify({
      FromEmailAddress: m.from, Destination: { ToAddresses: [m.to] },
      Content: { Simple: { Subject: { Data: m.subject, Charset: 'UTF-8' }, Body: { Text: { Data: m.text, Charset: 'UTF-8' } } } },
      ...(this.opts.configurationSet ? { ConfigurationSetName: this.opts.configurationSet } : {}),
    })
    const headers = signV4({ method: 'POST', url, headers: { 'content-type': 'application/json' }, body, service: 'ses', region: this.opts.region, creds: await this.creds.get() })
    delete headers.host // fetch sets it
    const res = await this.fetchImpl(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new Error(`ses SendEmail: ${res.status} ${(await res.text()).slice(0, 300)}`)
  }
}
