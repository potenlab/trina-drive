// A minimal SMTP submission client: EHLO, optional AUTH PLAIN, MAIL/RCPT/DATA. Plain TCP (local relay) or implicit TLS
// (port 465). No STARTTLS, no pipelining: alerts are small and rare.
import net from 'node:net'
import tls from 'node:tls'

export interface SmtpOptions { host: string; port: number; secure?: boolean; user?: string; pass?: string; helo?: string; timeoutMs?: number }

export async function smtpSend(o: SmtpOptions, from: string, to: string, message: string): Promise<void> {
  const sock: net.Socket = o.secure ? tls.connect({ host: o.host, port: o.port, servername: o.host }) : net.connect({ host: o.host, port: o.port })
  sock.setTimeout(o.timeoutMs ?? 15_000)
  let buf = ''
  const waiters: ((line: string) => void)[] = []
  const lines: string[] = []
  let failed: Error | null = null
  const fail = (e: Error) => { failed = e; while (waiters.length) waiters.shift()!('') }
  sock.on('data', (d) => {
    buf += d.toString('utf8')
    let i: number
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2)
      // multi-line replies: "250-..." continues, "250 ..." ends
      if (/^\d{3}-/.test(line)) continue
      const w = waiters.shift()
      w ? w(line) : lines.push(line)
    }
  })
  sock.on('error', fail)
  sock.on('timeout', () => { fail(new Error('smtp timeout')); sock.destroy() })
  const reply = () => new Promise<string>((res) => { const l = lines.shift(); l !== undefined ? res(l) : waiters.push(res) })
  const expect = async (code: string, what: string) => {
    const l = await reply()
    if (failed) throw failed
    if (!l.startsWith(code)) throw new Error(`smtp ${what}: ${l}`)
  }
  const cmd = async (line: string, code: string, what = line.split(' ')[0]!) => { sock.write(line + '\r\n'); await expect(code, what) }
  const addr = (a: string) => `<${a.replace(/^.*<|>.*$/g, '')}>`
  try {
    await expect('220', 'greeting')
    await cmd(`EHLO ${o.helo ?? 'localhost'}`, '250')
    if (o.user) await cmd(`AUTH PLAIN ${Buffer.from(`\0${o.user}\0${o.pass ?? ''}`).toString('base64')}`, '235', 'AUTH')
    await cmd(`MAIL FROM:${addr(from)}`, '250')
    await cmd(`RCPT TO:${addr(to)}`, '250')
    await cmd('DATA', '354')
    // dot-stuffing; the message already uses CRLF
    await cmd(message.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..') + '\r\n.', '250', 'DATA body')
    sock.write('QUIT\r\n')
  } finally {
    sock.end()
  }
}
