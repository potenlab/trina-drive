// A small AWS client with no SDK: Signature Version 4, credentials from the environment or the instance role (IMDSv2),
// and the handful of calls the control plane makes — SSM (run host-agent commands, Parameter Store), KMS (wrap keys),
// SES v2 (mail), Route 53 (one A record per team). S3 goes through Bun's built-in S3 client (backup.ts).
// Nothing here is called by the local driver or the tests except through an injected fetch.
import crypto from 'node:crypto'

export interface Credentials { accessKeyId: string; secretAccessKey: string; sessionToken?: string; expiresAt?: number }
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

const hmac = (key: crypto.BinaryLike, data: string) => crypto.createHmac('sha256', key).update(data).digest()
const hex = (data: string | Uint8Array) => crypto.createHash('sha256').update(data).digest('hex')
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

export interface SignInput {
  method: string
  url: string
  headers?: Record<string, string>
  body?: string
  service: string
  region: string
  creds: Credentials
  /** for tests: the signing time */
  date?: Date
}

/** Signs a request (SigV4, header form). Returns the headers to send (the input headers + host, x-amz-date, authorization). */
export function signV4(i: SignInput): Record<string, string> {
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
  const kDate = hmac(`AWS4${i.creds.secretAccessKey}`, day)
  const kSigning = hmac(hmac(hmac(kDate, i.region), i.service), 'aws4_request')
  const signature = crypto.createHmac('sha256', kSigning).update(toSign).digest('hex')
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${i.creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  return headers
}

export class AwsError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

/** Environment credentials, else the instance role through IMDSv2 (cached until 5 minutes before expiry). */
export class CredentialProvider {
  private cached: Credentials | null = null
  constructor(private readonly env: Record<string, string | undefined> = process.env, private readonly fetchImpl: Fetch = fetch) {}
  async get(): Promise<Credentials> {
    if (this.env.AWS_ACCESS_KEY_ID && this.env.AWS_SECRET_ACCESS_KEY) {
      return { accessKeyId: this.env.AWS_ACCESS_KEY_ID, secretAccessKey: this.env.AWS_SECRET_ACCESS_KEY, sessionToken: this.env.AWS_SESSION_TOKEN || undefined }
    }
    if (this.cached && (this.cached.expiresAt ?? 0) - 300_000 > Date.now()) return this.cached
    const base = 'http://169.254.169.254/latest'
    const token = await (await this.fetchImpl(`${base}/api/token`, { method: 'PUT', headers: { 'x-aws-ec2-metadata-token-ttl-seconds': '21600' }, signal: AbortSignal.timeout(2000) })).text()
    const h = { 'x-aws-ec2-metadata-token': token }
    const role = (await (await this.fetchImpl(`${base}/meta-data/iam/security-credentials/`, { headers: h, signal: AbortSignal.timeout(2000) })).text()).split('\n')[0]?.trim()
    if (!role) throw new AwsError(0, 'NoCredentials', 'no AWS credentials in the environment and no instance role')
    const c = await (await this.fetchImpl(`${base}/meta-data/iam/security-credentials/${role}`, { headers: h, signal: AbortSignal.timeout(2000) })).json() as { AccessKeyId: string; SecretAccessKey: string; Token: string; Expiration: string }
    this.cached = { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.Token, expiresAt: Date.parse(c.Expiration) }
    return this.cached
  }
}

export class AwsClient {
  constructor(readonly region: string, readonly creds: CredentialProvider = new CredentialProvider(), readonly fetchImpl: Fetch = fetch) {}

  async request(o: { service: string; method: string; url: string; headers?: Record<string, string>; body?: string; region?: string }): Promise<Response> {
    const headers = signV4({ ...o, region: o.region ?? this.region, creds: await this.creds.get() })
    delete headers.host // fetch sets it
    return this.fetchImpl(o.url, { method: o.method, headers, body: o.body, signal: AbortSignal.timeout(15_000) })
  }

  /** AWS JSON 1.1 protocol (SSM: AmazonSSM, KMS: TrentService). */
  async json<T = Record<string, unknown>>(service: 'ssm' | 'kms', op: string, body: Record<string, unknown>): Promise<T> {
    const target = service === 'ssm' ? 'AmazonSSM' : 'TrentService'
    const res = await this.request({
      service, method: 'POST', url: `https://${service}.${this.region}.amazonaws.com/`, body: JSON.stringify(body),
      headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `${target}.${op}` },
    })
    const text = await res.text()
    if (!res.ok) {
      let code = 'Error', msg = text
      try { const j = JSON.parse(text) as { __type?: string; message?: string; Message?: string }; code = (j.__type ?? code).split('#').pop()!; msg = j.message ?? j.Message ?? text } catch { /* not JSON */ }
      throw new AwsError(res.status, code, `${service} ${op}: ${code}: ${msg}`)
    }
    return (text ? JSON.parse(text) : {}) as T
  }

  // ---- SSM ----
  /** Runs a shell script on one managed instance and waits for it (AWS-RunShellScript). */
  async runShell(instanceId: string, script: string, opts: { timeoutS?: number; comment?: string; pollMs?: number } = {}): Promise<{ status: string; stdout: string; stderr: string; exitCode: number }> {
    const timeoutS = opts.timeoutS ?? 300
    const sent = await this.json<{ Command: { CommandId: string } }>('ssm', 'SendCommand', {
      InstanceIds: [instanceId], DocumentName: 'AWS-RunShellScript', TimeoutSeconds: Math.max(30, timeoutS),
      Comment: (opts.comment ?? 'tdcloud').slice(0, 100),
      Parameters: { commands: [script], executionTimeout: [String(timeoutS)] },
    })
    const id = sent.Command.CommandId
    const deadline = Date.now() + (timeoutS + 30) * 1000
    for (;;) {
      await Bun.sleep(opts.pollMs ?? 1500)
      try {
        const r = await this.json<{ Status: string; ResponseCode: number; StandardOutputContent: string; StandardErrorContent: string }>('ssm', 'GetCommandInvocation', { CommandId: id, InstanceId: instanceId })
        if (!['Pending', 'InProgress', 'Delayed'].includes(r.Status)) return { status: r.Status, stdout: r.StandardOutputContent, stderr: r.StandardErrorContent, exitCode: r.ResponseCode }
      } catch (e) {
        if (!(e instanceof AwsError && e.code === 'InvocationDoesNotExist')) throw e
      }
      if (Date.now() > deadline) throw new AwsError(0, 'Timeout', `SSM command ${id} on ${instanceId} did not finish`)
    }
  }

  async putParameter(name: string, value: string, kmsKeyId?: string | null) {
    await this.json('ssm', 'PutParameter', { Name: name, Value: value, Type: 'SecureString', Overwrite: true, ...(kmsKeyId ? { KeyId: kmsKeyId } : {}) })
  }
  async deleteParameter(name: string) {
    try { await this.json('ssm', 'DeleteParameter', { Name: name }) } catch (e) { if (!(e instanceof AwsError && e.code === 'ParameterNotFound')) throw e }
  }

  /** Managed hosts with tag tdcloud:role=<value>, online. */
  async listHosts(roleTag: string): Promise<{ instanceId: string; privateIp: string; ping: string }[]> {
    const out: { instanceId: string; privateIp: string; ping: string }[] = []
    let next: string | undefined
    do {
      const r = await this.json<{ InstanceInformationList: { InstanceId: string; IPAddress: string; PingStatus: string }[]; NextToken?: string }>('ssm', 'DescribeInstanceInformation', {
        Filters: [{ Key: 'tag:tdcloud:role', Values: [roleTag] }], MaxResults: 50, ...(next ? { NextToken: next } : {}),
      })
      for (const i of r.InstanceInformationList) out.push({ instanceId: i.InstanceId, privateIp: i.IPAddress, ping: i.PingStatus })
      next = r.NextToken
    } while (next)
    return out
  }

  // ---- KMS ----
  async kmsEncrypt(keyId: string, plaintext: Uint8Array, context: Record<string, string>): Promise<string> {
    const r = await this.json<{ CiphertextBlob: string }>('kms', 'Encrypt', { KeyId: keyId, Plaintext: Buffer.from(plaintext).toString('base64'), EncryptionContext: context })
    return r.CiphertextBlob
  }
  async kmsDecrypt(blob: string, context: Record<string, string>): Promise<Uint8Array> {
    const r = await this.json<{ Plaintext: string }>('kms', 'Decrypt', { CiphertextBlob: blob, EncryptionContext: context })
    return new Uint8Array(Buffer.from(r.Plaintext, 'base64'))
  }

  // ---- SES v2 ----
  async sendEmail(from: string, to: string, subject: string, text: string) {
    const res = await this.request({
      service: 'ses', method: 'POST', url: `https://email.${this.region}.amazonaws.com/v2/email/outbound-emails`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ FromEmailAddress: from, Destination: { ToAddresses: [to] }, Content: { Simple: { Subject: { Data: subject, Charset: 'UTF-8' }, Body: { Text: { Data: text, Charset: 'UTF-8' } } } } }),
    })
    if (!res.ok) throw new AwsError(res.status, 'SesError', `ses SendEmail: ${res.status} ${(await res.text()).slice(0, 300)}`)
  }

  // ---- Route 53 ----
  /** DELETE needs the record's current value and TTL (Route 53 matches the whole record). */
  async changeA(zoneId: string, action: 'UPSERT' | 'DELETE', name: string, ip: string, ttl = 300) {
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<ChangeResourceRecordSetsRequest xmlns="https://route53.amazonaws.com/doc/2013-04-01/"><ChangeBatch><Changes><Change><Action>${action}</Action><ResourceRecordSet><Name>${xml(name)}</Name><Type>A</Type><TTL>${ttl}</TTL><ResourceRecords><ResourceRecord><Value>${xml(ip)}</Value></ResourceRecord></ResourceRecords></ResourceRecordSet></Change></Changes></ChangeBatch></ChangeResourceRecordSetsRequest>`
    const res = await this.request({ service: 'route53', region: 'us-east-1', method: 'POST', url: `https://route53.amazonaws.com/2013-04-01/hostedzone/${encodeURIComponent(zoneId)}/rrset/`, headers: { 'content-type': 'application/xml' }, body })
    if (!res.ok) throw new AwsError(res.status, 'Route53Error', `route53 ${action} ${name}: ${res.status} ${(await res.text()).slice(0, 300)}`)
  }
}

const xml = (s: string) => s.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`)
