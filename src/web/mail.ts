// Mail is pluggable: the server is given a Mailer. The built-in one appends to <data>/outbox.log (JSON lines) and logs
// a line, for development and for installs without SMTP; a real sender implements the same one method.
import fs from 'node:fs'
import path from 'node:path'

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
