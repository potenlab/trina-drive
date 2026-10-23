// Pluggable mail. OutboxMailer appends JSON lines to a 0600 file (dev and the end-to-end test read the "mailbox"
// there); SesMailer sends through Amazon SES v2. The production config refuses the outbox (config.ts): a setup link
// must reach only the buyer.
import fs from 'node:fs'
import path from 'node:path'
import type { AwsClient } from './aws'

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

/** Collects mail in memory (tests). */
export class MemoryMailer implements Mailer {
  readonly sent: Mail[] = []
  async send(mail: Mail) { this.sent.push(mail) }
}
