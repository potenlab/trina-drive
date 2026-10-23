// A minimal SMTP submission client: EHLO, optional STARTTLS, optional AUTH PLAIN, MAIL/RCPT/DATA. Plain TCP (local
// relay), STARTTLS (port 587: required when asked for — a server that does not offer it is refused, never a silent
// fall back to plain text) or implicit TLS (port 465). No pipelining: mail here is small and rare.
import net from 'node:net'
import tls from 'node:tls'

export interface SmtpOptions {
  host: string
  port: number
  /** implicit TLS from the first byte (port 465) */
  secure?: boolean
  /** upgrade with STARTTLS after EHLO; required (refused when the server does not offer it) */
  starttls?: boolean
  user?: string
  pass?: string
  helo?: string
  timeoutMs?: number
  /** extra TLS options (a private CA: `ca`) */
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
      // multi-line replies: "250-..." continues, "250 ..." ends
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
      // anything already buffered was sent before the handshake (STARTTLS command injection): never act on it
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
    // dot-stuffing; the message already uses CRLF
    await cmd(message.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..') + '\r\n.', '250', 'DATA body')
    sock.write('QUIT\r\n')
  } finally {
    unwatch(sock)
    sock.on('error', () => {})
    sock.end()
  }
}
