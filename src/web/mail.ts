// Mail is pluggable: the server is given a Mailer. The built-in one appends to <data>/outbox.log (JSON lines) and logs
// a line, for development and for installs without SMTP; a real sender implements the same one method. `serve` hands
// the web the notify mailer (SMTP or SES, from notify.json or the environment) through RelayMailer when one is set.
import fs from 'node:fs'
import path from 'node:path'
import { NAME } from '../config'
import { ApiError } from './http'

export interface Mail { to: string; subject: string; text: string }
export interface Mailer { send(mail: Mail): Promise<void> }

export class OutboxMailer implements Mailer {
  readonly file: string
  constructor(dataDir: string, private readonly quiet = false) { this.file = path.join(dataDir, 'outbox.log') }
  async send(mail: Mail) {
    fs.appendFileSync(this.file, JSON.stringify({ at: new Date().toISOString(), ...mail }) + '\n', { mode: 0o600 })
    if (!this.quiet) console.error(`[mail] to ${mail.to}: ${mail.subject} (written to ${this.file})`)
  }
  /** Everything written so far (tests, dev). */
  read(): (Mail & { at: string })[] {
    try { return fs.readFileSync(this.file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] }
  }
}

/** A sender that needs a From address (src/notify/channels.ts Mailer: SMTP, SES). */
export interface FromMailer { send(mail: Mail & { from: string }): Promise<void> }

/** The web's mail through a real sender. A failure becomes a 502 the admin sees (invite / reset not delivered). */
export class RelayMailer implements Mailer {
  constructor(readonly inner: FromMailer, readonly from: string) {}
  async send(mail: Mail) {
    try { await this.inner.send({ ...mail, from: this.from }) } catch (e) {
      console.error(`[${NAME}] mail to ${mail.to} failed:`, (e as Error).message ?? e)
      throw new ApiError(502, 'mail_failed', 'the mail could not be sent (the mail server refused it or could not be reached); try again later')
    }
  }
}
