// A local SMTP sink with TLS, run under Node (Bun cannot yet wrap an accepted socket in server-side TLS, which
// STARTTLS needs). Usage: node test/smtp-tls-sink.mjs <starttls|tls|no-starttls> <key.pem> <cert.pem>
// Prints {"port":N} once listening, then one JSON line per message: {from, to, auth, data, tls}.
import fs from 'node:fs'
import net from 'node:net'
import tls from 'node:tls'

const [mode, keyFile, certFile] = process.argv.slice(2)
const key = fs.readFileSync(keyFile), cert = fs.readFileSync(certFile)
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')

function session(raw) {
  let s = raw, buf = '', inData = false, data = '', from = '', to = '', auth = null
  const secure = () => s instanceof tls.TLSSocket
  const handle = (d) => {
    buf += d.toString('utf8')
    let i
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2)
      if (inData) {
        if (line === '.') { inData = false; out({ from, to, auth, data, tls: secure() }); data = ''; s.write('250 queued\r\n') }
        else data += (line.startsWith('..') ? line.slice(1) : line) + '\r\n'
        continue
      }
      const verb = line.split(' ')[0].toUpperCase()
      if (verb === 'EHLO') s.write(`250-sink\r\n${!secure() && mode === 'starttls' ? '250-STARTTLS\r\n' : ''}250 AUTH PLAIN\r\n`)
      else if (verb === 'STARTTLS' && mode === 'starttls' && !secure()) {
        s.write('220 go ahead\r\n')
        raw.removeListener('data', handle)
        const t = new tls.TLSSocket(raw, { isServer: true, key, cert })
        t.on('data', handle); t.on('error', () => {})
        s = t
      } else if (verb === 'AUTH') { auth = { secure: secure(), plain: Buffer.from(line.split(' ')[2] ?? '', 'base64').toString() }; s.write('235 ok\r\n') }
      else if (verb === 'MAIL') { from = line.slice(10); s.write('250 ok\r\n') }
      else if (verb === 'RCPT') { to = line.slice(8); s.write('250 ok\r\n') }
      else if (verb === 'DATA') { inData = true; s.write('354 go\r\n') }
      else if (verb === 'QUIT') s.end('221 bye\r\n')
      else s.write('502 ?\r\n')
    }
  }
  raw.on('error', () => {})
  return handle
}

const server = mode === 'tls'
  ? tls.createServer({ key, cert }, (sock) => { const h = session(sock); sock.on('data', h); sock.write('220 sink ESMTP\r\n') })
  : net.createServer((sock) => { const h = session(sock); sock.on('data', h); sock.write('220 sink ESMTP\r\n') })
server.listen(0, '127.0.0.1', () => out({ port: server.address().port }))
process.stdin.on('end', () => process.exit(0))
process.stdin.resume()
