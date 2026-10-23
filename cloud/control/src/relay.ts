// The mail relay on each team host (`mail-relay`; cloud/host/bootstrap.sh runs it on the host network, cloud/dev on the
// Docker VM). Team instances send their mail (invites, password resets, notifications) with the product's own SES
// mailer (TDRIVE_MAILER=ses) to http://<their network's gateway>:8025 — the host. A team container cannot use the
// instance role itself: the metadata service is out of its reach on purpose (IMDSv2 hop limit 1 and the host firewall),
// because the role can read every team's env parameter. The relay holds the role instead and lets through only:
//
//   - a sender that is a team's own container address (teamnet.ts: x.x.x.3 of a team /28) — Caddy, the host, anything
//     else is refused; a team container has no capability to take another address;
//   - SES v2 SendEmail, Content.Simple, one To recipient, no Cc/Bcc, From = the configured team address (so the role's
//     IAM condition ses:FromAddress, cloud/infra/terraform/iam.tf, is met and nothing else could be), with the
//     configured display name or "<team> via <that name>" (e.g. "Acme via Trina Drive <drive@drive.trina.app>": letters,
//     digits, spaces and . , & ' ( ) _ - only, at most 64 characters);
//   - at most perHour / perDay messages per team.
//
// Then it hands the message to its upstream (TDCLOUD_MAIL_UPSTREAM):
//
//   resend          Resend's HTTPS API (resend.ts) with the key from the SSM SecureString TDCLOUD_RESEND_API_KEY_PARAM,
//                   read with the instance role (the default on AWS: SES gave the account no production access);
//   ses             SES v2 SendEmail signed with the instance role (kept for later);
//   smtp            SMTP submission (smtp.ts; by default Resend's SMTP with the same key);
//   outbox:<file>   development: one JSON line per message (the dev mail sink cloud/dev/e2e.ts reads).
//
// The checks above come first whatever the upstream: the team does not choose where its mail goes or as whom. The
// incoming request's signature is ignored: the team's AWS_* values are placeholders (control/src/cloud.ts, teamEnv).
import fs from 'node:fs'
import path from 'node:path'
import { AwsClient, CredentialProvider } from './aws'
import { DEFAULT_TEAM_SUBNETS, mailAddress } from './config'
import { ResendClient, resendSecret, resendSettings } from './resend'
import { SmtpSender, smtpSettings } from './smtp'
import { teamOfAddress } from './teamnet'
import { EMAIL_RE } from './util'

export interface RelayMail { team: number; from: string; to: string; subject: string; text: string; html?: string }
export interface RelayUpstream { readonly name: string; send(m: RelayMail): Promise<string> }

export interface RelayOptions {
  pool: string
  /** the From every team uses ("Trina Drive <drive@drive.trina.app>"); the message goes out with this address and
   * this display name, or "<team> via <this display name>" when the team asked for that */
  from: string
  upstream: RelayUpstream
  perHour?: number
  perDay?: number
  log?: (s: string) => void
  now?: () => number
}

export const MAX_BODY_BYTES = 512 * 1024

const sesError = (status: number, type: string, message: string) => Response.json({ __type: type, message }, { status })

export function makeRelay(o: RelayOptions) {
  const perHour = o.perHour ?? 60, perDay = o.perDay ?? 500
  const now = o.now ?? Date.now
  const log = o.log ?? ((s: string) => console.log(`${new Date().toISOString()} ${s}`))
  const fromAddr = mailAddress(o.from)
  if (!fromAddr) throw new Error(`relay From is not a mail address: ${o.from}`)
  const fromName = /^\s*"?([^"<>]*?)"?\s*<[^<>]+>\s*$/.exec(o.from)?.[1]?.trim() ?? ''
  /** the From that goes out for the team's From, or null when it is not allowed */
  const outFrom = (asked: string): string | null => {
    if (mailAddress(asked) !== fromAddr) return null
    const name = /^\s*"?([^"<>\\]*?)"?\s*<[^<>]+>\s*$/.exec(asked)?.[1]?.trim() ?? (/^[^<>]*$/.test(asked) ? '' : null)
    if (name === null) return null
    if (name === '' || name === fromName) return o.from
    const suffix = ` via ${fromName}`
    if (!fromName || !name.endsWith(suffix)) return null
    const team = name.slice(0, -suffix.length).replace(/\s+/g, ' ').trim()
    if (!/^[\p{L}\p{N} .,&'()_-]{1,64}$/u.test(team)) return null
    return `"${team}${suffix}" <${fromAddr}>`
  }
  const sent = new Map<number, number[]>()

  const allowed = (team: number) => {
    const t = now(), list = (sent.get(team) ?? []).filter((x) => x > t - 86400_000)
    sent.set(team, list)
    return list.filter((x) => x > t - 3600_000).length < perHour && list.length < perDay
  }

  return async function handle(req: Request, peer: string | undefined): Promise<Response> {
    const url = new URL(req.url)
    if (req.method === 'GET' && url.pathname === '/healthz') return Response.json({ ok: true, upstream: o.upstream.name })
    const team = teamOfAddress(o.pool, peer)
    if (team === null) { log(`mail refused: ${peer ?? '?'} is not a team container`); return sesError(403, 'AccessDeniedException', 'not a team instance') }
    if (req.method !== 'POST' || url.pathname !== '/v2/email/outbound-emails') return sesError(404, 'NotFoundException', 'only SendEmail is relayed')
    const raw = await req.arrayBuffer()
    if (raw.byteLength > MAX_BODY_BYTES) return sesError(413, 'BadRequestException', 'message too large')
    let b: Record<string, unknown>
    try { b = JSON.parse(new TextDecoder().decode(raw)) } catch { return sesError(400, 'BadRequestException', 'not JSON') }
    const bad = (why: string) => { log(`mail refused: team ${team}: ${why}`); return sesError(400, 'BadRequestException', why) }

    const extra = Object.keys(b ?? {}).filter((k) => !['FromEmailAddress', 'Destination', 'Content', 'ConfigurationSetName'].includes(k))
    if (extra.length) return bad(`not relayed: ${extra.join(', ')}`)
    const from = typeof b.FromEmailAddress === 'string' ? outFrom(b.FromEmailAddress) : null
    if (!from) return bad(`From must be ${fromAddr} (as "${fromName}" or "<team> via ${fromName}")`)
    const d = b.Destination as { ToAddresses?: unknown; CcAddresses?: unknown; BccAddresses?: unknown } | undefined
    const to = Array.isArray(d?.ToAddresses) && d.ToAddresses.length === 1 ? d.ToAddresses[0] : null
    if (!d || Object.keys(d).some((k) => k !== 'ToAddresses') || typeof to !== 'string' || !EMAIL_RE.test(to) || to.length > 254) return bad('exactly one To recipient, no Cc or Bcc')
    const simple = (b.Content as { Simple?: { Subject?: { Data?: unknown }; Body?: { Text?: { Data?: unknown }; Html?: { Data?: unknown } } } } | undefined)?.Simple
    const subject = simple?.Subject?.Data, text = simple?.Body?.Text?.Data, html = simple?.Body?.Html?.Data
    if (!simple || Object.keys(b.Content as object).length !== 1) return bad('only Content.Simple')
    if (typeof subject !== 'string' || !subject || subject.length > 998 || /[\r\n]/.test(subject)) return bad('bad subject')
    if (typeof text !== 'string' || (html !== undefined && typeof html !== 'string')) return bad('a text body is required')

    if (!allowed(team)) { log(`mail refused: team ${team}: over ${perHour}/hour or ${perDay}/day`); return sesError(429, 'TooManyRequestsException', 'this team sent too much mail; try again later') }
    try {
      const id = await o.upstream.send({ team, from, to, subject, text, ...(html !== undefined ? { html } : {}) })
      sent.get(team)!.push(now())
      log(`mail team ${team} → …@${to.split('@')[1]} (${o.upstream.name} ${id})`)
      return Response.json({ MessageId: id })
    } catch (e) {
      log(`mail failed: team ${team}: ${(e as Error).message}`)
      return sesError(502, 'UpstreamError', 'the mail service did not take the message')
    }
  }
}

/** SES v2 with the credentials this process has (the host's instance role). */
export class SesUpstream implements RelayUpstream {
  readonly name = 'ses'
  constructor(private readonly aws: AwsClient, private readonly configurationSet?: string) {}
  async send(m: RelayMail) {
    const res = await this.aws.request({
      service: 'ses', method: 'POST', url: `https://email.${this.aws.region}.amazonaws.com/v2/email/outbound-emails`, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        FromEmailAddress: m.from, Destination: { ToAddresses: [m.to] },
        Content: { Simple: { Subject: { Data: m.subject, Charset: 'UTF-8' }, Body: { Text: { Data: m.text, Charset: 'UTF-8' }, ...(m.html !== undefined ? { Html: { Data: m.html, Charset: 'UTF-8' } } : {}) } } },
        ...(this.configurationSet ? { ConfigurationSetName: this.configurationSet } : {}),
      }),
    })
    const t = await res.text()
    if (!res.ok) throw new Error(`ses SendEmail: ${res.status} ${t.slice(0, 300)}`)
    return (JSON.parse(t) as { MessageId?: string }).MessageId ?? '?'
  }
}

/** Resend's HTTPS API; the key from SSM (instance role) or a 0600 file. Retries 429/5xx within the team's wait. */
export class ResendUpstream implements RelayUpstream {
  readonly name = 'resend'
  constructor(private readonly client: Pick<ResendClient, 'send'>) {}
  send(m: RelayMail) {
    return this.client.send({ from: m.from, to: m.to, subject: m.subject, text: m.text, ...(m.html !== undefined ? { html: m.html } : {}), tags: { source: 'team', team: String(m.team) } })
  }
}

/** SMTP submission (default: Resend's SMTP endpoint with the Resend key as password). */
export class SmtpUpstream implements RelayUpstream {
  readonly name = 'smtp'
  constructor(private readonly sender: Pick<SmtpSender, 'send'>) {}
  send(m: RelayMail) { return this.sender.send({ from: m.from, to: m.to, subject: m.subject, text: m.text, ...(m.html !== undefined ? { html: m.html } : {}) }) }
}

/** Development: one JSON line per message (the dev mail sink). */
export class FileUpstream implements RelayUpstream {
  readonly name = 'outbox'
  private n = 0
  constructor(readonly file: string) { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }) }
  async send(m: RelayMail) {
    const id = `dev-${Date.now()}-${++this.n}`
    fs.appendFileSync(this.file, JSON.stringify({ at: new Date().toISOString(), id, ...m }) + '\n', { mode: 0o600 })
    return id
  }
}

/** TDCLOUD_MAIL_UPSTREAM (the older name TDCLOUD_MAIL_RELAY_UPSTREAM still works); `ses` when neither is set. */
export function upstreamFromEnv(env: Record<string, string | undefined>, aws?: AwsClient): RelayUpstream {
  const up = env.TDCLOUD_MAIL_UPSTREAM || env.TDCLOUD_MAIL_RELAY_UPSTREAM || 'ses'
  const region = env.AWS_REGION || env.AWS_DEFAULT_REGION || 'ap-northeast-2'
  const client = () => aws ?? new AwsClient(region, new CredentialProvider(env))
  if (up === 'ses') return new SesUpstream(client(), env.TDCLOUD_SES_CONFIGURATION_SET || undefined)
  if (up === 'resend') {
    const s = resendSettings(env)
    // the team waits for the answer (the product's SES mailer gives up after 15 s): retries fit in 12
    return new ResendUpstream(new ResendClient({ key: resendSecret(s, client()), endpoint: s.endpoint, deadlineMs: 12_000, timeoutMs: 8_000 }))
  }
  if (up === 'smtp') return new SmtpUpstream(new SmtpSender(smtpSettings(env), client(), { timeoutMs: 10_000 }))
  if (up.startsWith('outbox:')) return new FileUpstream(up.slice(7))
  throw new Error('TDCLOUD_MAIL_UPSTREAM must be resend, ses, smtp or outbox:<file>')
}

/** `mail-relay` from the environment (cloud/host/bootstrap.sh, cloud/dev/compose.yml). */
export function relayFromEnv(env: Record<string, string | undefined> = process.env, opts: { aws?: AwsClient; log?: (s: string) => void } = {}) {
  const from = env.TDCLOUD_TEAM_MAIL_FROM
  if (!from) throw new Error('TDCLOUD_TEAM_MAIL_FROM is required')
  const upstream = upstreamFromEnv(env, opts.aws)
  const [host, port] = (env.TDCLOUD_MAIL_RELAY_LISTEN || '0.0.0.0:8025').split(':')
  const num = (v: string | undefined, d: number) => (v && Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : d)
  return {
    host: host || '0.0.0.0', port: num(port, 8025), upstream,
    handle: makeRelay({ pool: env.TDCLOUD_TEAM_SUBNETS || DEFAULT_TEAM_SUBNETS, from, upstream, perHour: num(env.TDCLOUD_MAIL_RELAY_PER_HOUR, 60), perDay: num(env.TDCLOUD_MAIL_RELAY_PER_DAY, 500), ...(opts.log ? { log: opts.log } : {}) }),
  }
}
