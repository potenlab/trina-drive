// Pluggable mail for the control plane's own messages (email confirmation, setup links, billing notices, ops alerts),
// TDCLOUD_MAILER: OutboxMailer appends JSON lines to a 0600 file (dev and the end-to-end test read the "mailbox"
// there); ResendMailer sends through Resend's HTTPS API (the production default; key from SSM, resend.ts); SesMailer
// through Amazon SES v2; SmtpMailer by SMTP submission. The production config refuses the outbox (config.ts): a setup
// link must reach only the buyer.
import fs from 'node:fs'
import path from 'node:path'
import type { AwsClient } from './aws'
import type { Config } from './config'
import { ResendClient, resendSecret } from './resend'
import { SmtpSender } from './smtp'

export interface Mail { to: string; subject: string; text: string }
export interface Mailer { send(mail: Mail): Promise<void> }

export class OutboxMailer implements Mailer {
  constructor(readonly file: string, private readonly log: (s: string) => void = (s) => console.error(s)) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  }
  async send(mail: Mail) {
    fs.appendFileSync(this.file, JSON.stringify({ at: new Date().toISOString(), ...mail }) + '\n', { mode: 0o600 })
    this.log(`[mail] to ${mail.to}: ${mail.subject} (outbox ${this.file})`)
  }
  read(): (Mail & { at: string })[] {
    try { return fs.readFileSync(this.file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] }
  }
}

export class SesMailer implements Mailer {
  constructor(private readonly aws: AwsClient, private readonly from: string) {}
  async send(mail: Mail) { await this.aws.sendEmail(this.from, mail.to, mail.subject, mail.text) }
}

export class ResendMailer implements Mailer {
  constructor(private readonly client: Pick<ResendClient, 'send'>, private readonly from: string) {}
  async send(mail: Mail) { await this.client.send({ from: this.from, to: mail.to, subject: mail.subject, text: mail.text, tags: { source: 'control' } }) }
}

export class SmtpMailer implements Mailer {
  constructor(private readonly sender: Pick<SmtpSender, 'send'>, private readonly from: string) {}
  async send(mail: Mail) { await this.sender.send({ from: this.from, to: mail.to, subject: mail.subject, text: mail.text }) }
}

/** The mailer TDCLOUD_MAILER names. */
export function mailerFor(cfg: Pick<Config, 'mailer' | 'mailFrom' | 'stateDir' | 'resend' | 'smtp'>, aws: AwsClient): Mailer {
  switch (cfg.mailer) {
    case 'resend': return new ResendMailer(new ResendClient({ key: resendSecret(cfg.resend, aws), endpoint: cfg.resend.endpoint }), cfg.mailFrom)
    case 'ses': return new SesMailer(aws, cfg.mailFrom)
    case 'smtp': return new SmtpMailer(new SmtpSender(cfg.smtp, aws), cfg.mailFrom)
    default: return new OutboxMailer(path.join(cfg.stateDir, 'outbox.log'))
  }
}

/** Collects mail in memory (tests). */
export class MemoryMailer implements Mailer {
  readonly sent: Mail[] = []
  async send(mail: Mail) { this.sent.push(mail) }
}
