// Outgoing channels. Slack incoming webhook (JSON {text}); email through a small Mailer interface with a file outbox
// for development and a minimal SMTP client for real use.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { NotifyConfig } from './config'
import { SesMailer } from './ses'
import { smtpSend, type SmtpOptions } from './smtp'

export interface Mail { to: string; from: string; subject: string; text: string }
export interface Mailer { send(m: Mail): Promise<void> }

/** Development mailer: one RFC 5322 file per message in a directory. */
export class FileOutbox implements Mailer {
  constructor(readonly dir: string) {}
  async send(m: Mail) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}.eml`
    fs.writeFileSync(path.join(this.dir, name), formatMail(m), { mode: 0o600 })
  }
}

export class SmtpMailer implements Mailer {
  constructor(readonly opts: SmtpOptions) {}
  send(m: Mail) { return smtpSend(this.opts, m.from, m.to, formatMail(m)) }
}

/** The mailer a configuration asks for (null: mail off, or smtp/ses without their settings). */
export function mailerFor(email: NotifyConfig['email'], dataDir: string): Mailer | null {
  if (email.mode === 'outbox') return new FileOutbox(email.outboxDir ?? path.join(dataDir, 'outbox'))
  if (email.mode === 'smtp' && email.smtp) return new SmtpMailer(email.smtp)
  if (email.mode === 'ses' && email.ses) return new SesMailer(email.ses)
  return null
}

const encodeHeader = (s: string) => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`

export function formatMail(m: Mail): string {
  const body = Buffer.from(m.text).toString('base64').replace(/.{76}/g, '$&\r\n')
  return [
    `From: ${m.from}`, `To: ${m.to}`, `Subject: ${encodeHeader(m.subject)}`, `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${m.from.split('@')[1] ?? 'localhost'}>`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', body, '',
  ].join('\r\n')
}

/** Slack incoming webhook. Throws on a non-2xx answer so the delivery is retried. */
export async function postSlack(url: string, text: string, fetchImpl: typeof fetch = fetch) {
  const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(10_000) })
  if (!r.ok) throw new Error(`slack webhook answered ${r.status}`)
}
