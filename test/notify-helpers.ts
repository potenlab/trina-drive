// Local sinks for notification tests: nothing here talks to a real service.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { attachNotify, type AttachOptions } from '../src/notify'
import type { NotifyConfig } from '../src/notify/config'
import type { Env } from './helpers'

export interface SlackHit { path: string; contentType: string | null; body: unknown; raw: string }

/** A local HTTP server standing in for Slack incoming webhooks. */
export function slackSink() {
  const hits: SlackHit[] = []
  const state = { status: 200 }
  const server = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    async fetch(req) {
      const raw = await req.text()
      let body: unknown = null
      try { body = JSON.parse(raw) } catch {}
      hits.push({ path: new URL(req.url).pathname, contentType: req.headers.get('content-type'), body, raw })
      return new Response(state.status < 300 ? 'ok' : 'no', { status: state.status })
    },
  })
  return { hits, state, url: (p = '/hook') => `http://127.0.0.1:${server.port}${p}`, stop: () => server.stop(true) }
}

/** A tiny SMTP server that accepts everything and keeps the DATA of each message. */
export async function smtpSink() {
  const messages: { from: string; to: string; data: string; auth?: string }[] = []
  const server = net.createServer((sock) => {
    let buf = '', inData = false, data = '', from = '', to = '', auth: string | undefined
    sock.write('220 sink ESMTP\r\n')
    sock.on('data', (d) => {
      buf += d.toString('utf8')
      let i: number
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2)
        if (inData) {
          if (line === '.') { inData = false; messages.push({ from, to, data, auth }); data = ''; sock.write('250 queued\r\n') }
          else data += (line.startsWith('..') ? line.slice(1) : line) + '\r\n'
          continue
        }
        const [verb] = line.split(' ')
        switch (verb!.toUpperCase()) {
          case 'EHLO': sock.write('250-sink\r\n250 AUTH PLAIN\r\n'); break
          case 'AUTH': auth = Buffer.from(line.split(' ')[2] ?? '', 'base64').toString(); sock.write('235 ok\r\n'); break
          case 'MAIL': from = line.slice(10); sock.write('250 ok\r\n'); break
          case 'RCPT': to = line.slice(8); sock.write('250 ok\r\n'); break
          case 'DATA': inData = true; sock.write('354 go\r\n'); break
          case 'QUIT': sock.end('221 bye\r\n'); break
          default: sock.write('502 ?\r\n')
        }
      }
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { messages, port: (server.address() as net.AddressInfo).port, stop: () => server.close() }
}

/** Decoded subject + body of every .eml in a directory. */
export function readOutbox(dir: string): { file: string; raw: string; subject: string; body: string; to: string }[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).sort().map((f) => {
    const raw = fs.readFileSync(path.join(dir, f), 'utf8')
    return { file: f, raw, ...decodeMail(raw) }
  })
}

export function decodeMail(raw: string) {
  const [head, ...rest] = raw.split(/\r?\n\r?\n/)
  const h = (k: string) => new RegExp(`^${k}: (.*)$`, 'mi').exec(head!)?.[1] ?? ''
  const subj = h('Subject')
  const subject = subj.replace(/=\?UTF-8\?B\?([^?]*)\?=/g, (_, b) => Buffer.from(b, 'base64').toString('utf8'))
  const body = Buffer.from(rest.join('\n').replace(/\s+/g, ''), 'base64').toString('utf8')
  return { subject, body, to: h('To') }
}

/** Demo env + notify runtime with a file outbox inside the data dir and a fake clock. */
export function withNotify(e: Env, cfg: Partial<NotifyConfig> = {}, opts: AttachOptions = {}) {
  const clock = { t: new Date(2026, 9, 22, 14, 0, 0).getTime() }
  e.ctx.now = () => clock.t
  const outbox = path.join(e.dir, 'outbox')
  const rt = attachNotify(e.ctx, { cfg: { baseUrl: 'https://drive.example.test', email: { mode: 'outbox', from: 'drive@example.test', outboxDir: outbox }, perMinute: 100, anchor: { intervalMs: 0, email: true }, ...cfg }, ...opts })
  const pid = (name: string) => e.db.query<{ id: number }, [string]>('SELECT id FROM people WHERE name = ?').get(name)!.id
  return { rt, clock, outbox, pid }
}
