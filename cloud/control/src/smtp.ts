// SMTP submission for the `smtp` mail upstream (relay.ts) and mailer (mailer.ts): e.g. Resend's SMTP endpoint
// (smtp.resend.com:465, user `resend`, the API key as password) when its HTTPS API cannot be used. The client is the
// product's (src/notify/smtp.ts), copied because this image carries only cloud/control: EHLO, STARTTLS (required unless
// the port is 465 = implicit TLS, or TLS is explicitly off for a local test server), AUTH PLAIN, MAIL/RCPT/DATA.
import crypto from 'node:crypto'
import net from 'node:net'
import tls from 'node:tls'
import { LOCAL_KEY_FILE, Secret } from './resend'
import type { AwsClient } from './aws'

export interface SmtpSettings {
  host: string
  port: number
  /** implicit (port 465), starttls (required), or none (a local test server only) */
  tls: 'implicit' | 'starttls' | 'none'
  user: string
  /** password: SSM SecureString, else a 0600 file (default: the Resend key's, which is the password of Resend's SMTP) */
  passParam: string | null
  passFile: string
}

/** TDCLOUD_SMTP_HOST / _PORT / _TLS / _USER / _PASS_PARAM / _PASS_FILE; defaults: Resend's SMTP with the Resend key. */
export function smtpSettings(env: Record<string, string | undefined>): SmtpSettings {
  const port = Number(env.TDCLOUD_SMTP_PORT || 465)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('TDCLOUD_SMTP_PORT must be a port number')
  const t = env.TDCLOUD_SMTP_TLS || (port === 465 ? 'implicit' : 'starttls')
  if (!['implicit', 'starttls', 'none'].includes(t)) throw new Error('TDCLOUD_SMTP_TLS must be implicit, starttls or none')
  return {
    host: env.TDCLOUD_SMTP_HOST || 'smtp.resend.com', port, tls: t as SmtpSettings['tls'], user: env.TDCLOUD_SMTP_USER ?? 'resend',
    passParam: env.TDCLOUD_SMTP_PASS_PARAM || env.TDCLOUD_RESEND_API_KEY_PARAM || null,
    passFile: env.TDCLOUD_SMTP_PASS_FILE || env.TDCLOUD_RESEND_API_KEY_FILE || LOCAL_KEY_FILE,
  }
}

export interface OutMail { from: string; to: string; subject: string; text: string; html?: string }

/** Sends with these settings, the password from SSM or the file (never logged; a refused AUTH forgets it). */
export class SmtpSender {
  private readonly pass: Secret | null
  constructor(readonly s: SmtpSettings, aws: AwsClient, private readonly opts: { timeoutMs?: number; tls?: tls.ConnectionOptions } = {}) {
    this.pass = !s.user ? null : new Secret(s.passParam ? { param: s.passParam, aws } : { file: s.passFile })
  }
  async send(m: OutMail): Promise<string> {
    const id = `${crypto.randomUUID()}@${/@([^<>@\s]+)>?\s*$/.exec(m.from)?.[1] ?? 'localhost'}`
    const pass = this.pass ? await this.pass.get() : undefined
    try {
      await smtpSend({ host: this.s.host, port: this.s.port, secure: this.s.tls === 'implicit', starttls: this.s.tls === 'starttls', user: this.s.user || undefined, pass, timeoutMs: this.opts.timeoutMs, tls: this.opts.tls }, m.from, m.to, formatMail(m, id))
    } catch (e) {
      if (/AUTH/.test((e as Error).message)) this.pass?.forget()
      throw new Error((e as Error).message.split(pass || '\0').join('[redacted]'))
    }
    return `<${id}>`
  }
}

const encodeHeader = (s: string) => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`
const b64 = (s: string) => Buffer.from(s).toString('base64').replace(/.{76}/g, '$&\r\n')

/** RFC 5322: text/plain, or multipart/alternative with an HTML part; bodies in base64 (UTF-8). */
export function formatMail(m: OutMail, messageId: string): string {
  const head = [`From: ${m.from}`, `To: ${m.to}`, `Subject: ${encodeHeader(m.subject)}`, `Date: ${new Date().toUTCString()}`, `Message-ID: <${messageId}>`, 'MIME-Version: 1.0']
  if (m.html === undefined) return [...head, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64(m.text), ''].join('\r\n')
  const b = `tdc-${crypto.randomBytes(12).toString('hex')}`
  const part = (type: string, s: string) => [`--${b}`, `Content-Type: ${type}; charset=utf-8`, 'Content-Transfer-Encoding: base64', '', b64(s)]
  return [...head, `Content-Type: multipart/alternative; boundary="${b}"`, '', ...part('text/plain', m.text), ...part('text/html', m.html), `--${b}--`, ''].join('\r\n')
}

export interface SmtpOptions {
  host: string
  port: number
  secure?: boolean
  starttls?: boolean
  user?: string
  pass?: string
  helo?: string
  timeoutMs?: number
  tls?: tls.ConnectionOptions
}

export async function smtpSend(o: SmtpOptions, from: string, to: string, message: string): Promise<void> {
  const timeout = o.timeoutMs ?? 15_000
  const tlsOpts = (): tls.ConnectionOptions => ({ host: o.host, ...(net.isIP(o.host) ? {} : { servername: o.host }), ...o.tls })
  let buf = ''
  let cur: string[] = []
  const replies: string[][] = []
  const waiters: ((r: string[] | null) => void)[] = []
  let failed: Error | null = null
  const fail = (e: Error) => { failed ??= e; while (waiters.length) waiters.shift()!(null) }
  const onData = (d: Buffer) => {
    buf += d.toString('utf8')
    let i: number
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2)
      cur.push(line)
      if (/^\d{3}-/.test(line)) continue
      const r = cur; cur = []
      const w = waiters.shift()
      w ? w(r) : replies.push(r)
    }
  }
  const onError = (e: Error) => fail(e)
  const onClose = () => fail(new Error('smtp connection closed'))
  let sock: net.Socket
  const onTimeout = () => { fail(new Error('smtp timeout')); sock.destroy() }
  const watch = (s: net.Socket) => { s.on('data', onData); s.on('error', onError); s.on('close', onClose); s.setTimeout(timeout); s.on('timeout', onTimeout) }
  const unwatch = (s: net.Socket) => { s.off('data', onData); s.off('error', onError); s.off('close', onClose); s.setTimeout(0); s.off('timeout', onTimeout) }

  sock = o.secure ? tls.connect({ port: o.port, ...tlsOpts() }) : net.connect({ host: o.host, port: o.port })
  watch(sock)
  const reply = () => new Promise<string[] | null>((res) => { const r = replies.shift(); r !== undefined ? res(r) : failed ? res(null) : waiters.push(res) })
  const expect = async (code: string, what: string) => {
    const r = await reply()
    if (!r) throw failed ?? new Error(`smtp ${what}: no reply`)
    const last = r.at(-1)!
    if (!last.startsWith(code)) throw new Error(`smtp ${what}: ${last}`)
    return r
  }
  const cmd = async (line: string, code: string, what = line.split(' ')[0]!) => { sock.write(line + '\r\n'); return expect(code, what) }
  const addr = (a: string) => `<${a.replace(/^.*<|>.*$/g, '')}>`
  try {
    await expect('220', 'greeting')
    let ehlo = await cmd(`EHLO ${o.helo ?? 'localhost'}`, '250')
    if (o.starttls && !o.secure) {
      if (!ehlo.some((l) => /^250[ -]STARTTLS\b/i.test(l))) throw new Error('smtp: the server does not offer STARTTLS (refusing to send in plain text)')
      await cmd('STARTTLS', '220')
      if (buf || cur.length || replies.length) throw new Error('smtp: unexpected data after STARTTLS')
      const plain = sock
      unwatch(plain)
      sock = await new Promise<tls.TLSSocket>((res, rej) => {
        const t = tls.connect({ socket: plain, ...tlsOpts() }, () => { t.off('error', rej); res(t) })
        t.once('error', rej)
      })
      watch(sock)
      ehlo = await cmd(`EHLO ${o.helo ?? 'localhost'}`, '250')
    }
    if (o.user) await cmd(`AUTH PLAIN ${Buffer.from(`\0${o.user}\0${o.pass ?? ''}`).toString('base64')}`, '235', 'AUTH')
    await cmd(`MAIL FROM:${addr(from)}`, '250')
    await cmd(`RCPT TO:${addr(to)}`, '250')
    await cmd('DATA', '354')
    await cmd(message.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..') + '\r\n.', '250', 'DATA body')
    sock.write('QUIT\r\n')
  } finally {
    unwatch(sock)
    sock.on('error', () => {})
    sock.end()
  }
}
