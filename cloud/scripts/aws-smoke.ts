#!/usr/bin/env bun
// Trina Cloud smoke check after a deploy (plan §6.3, deploy-log outline, review findings 24 and R6/R10/R13): the 13
// checks plus four cheap extras, against AWS (default) or the local stack (cloud/dev/up.sh, --local).
//
//   bun cloud/scripts/aws-smoke.ts --base https://cloud.trina.app --team trina [--profile tdcloud]
//        [--website https://drive.trina.app] [--canary smoke-canary] [--skip 9,mail] [--only 2,4] [--json]
//   bun cloud/scripts/aws-smoke.ts --local [--team acme]
//
// Every check prints `ok|FAIL|skip <id> <name>  <detail>`; the exit code is 1 when one FAILs.
//
// Secrets never come from argv or the environment, and nothing secret is printed (every value read is redacted from
// the output): the smoke account's password from ~/.config/trina-drive/smoke/password (0600) or the SSM SecureString
// /tdcloud/smoke/password (read with --with-decryption into this process); its address from …/smoke/email or
// /tdcloud/smoke/email (or --email). The Caddy ask key is only ever used on the control instance itself. Steps that
// need an instance run there: over SSM Run Command (AWS: `aws ssm send-command`, instances by tag tdcloud:role) or the
// local Docker engine (--local). The PAT and the WebDAV app password are made for this run through the product API
// and revoked at the end, the 30 MB file deleted; the smoke member and the canary folder stay.
//
// The smoke account: a `member` of the team in the console (no TOTP needed), plus a canary folder in the team that it
// must not see, made once by the operator (cloud/README.md "Smoke check"):
//   teams exec trina -- folder create smoke-canary        (no rule for the smoke member)
import crypto from 'node:crypto'
import dns from 'node:dns/promises'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'

// ---------------------------------------------------------------- options
export interface Options {
  base: string
  team: string
  local: boolean
  profile: string
  region: string
  website: string | null
  canary: string | null
  email: string | null
  secretsDir: string
  ssmPrefix: string
  caFile: string | null
  skip: Set<string>
  only: Set<string> | null
  json: boolean
  mailWaitS: number
}

const REPO = path.resolve(import.meta.dir, '../..')

export function parseArgs(argv: string[]): Options {
  const a = [...argv]
  const take = (n: string) => { const i = a.indexOf(n); if (i < 0) return undefined; const v = a[i + 1]; if (v === undefined || v.startsWith('--')) throw new Error(`${n} needs a value`); a.splice(i, 2); return v }
  const flag = (n: string) => { const i = a.indexOf(n); if (i < 0) return false; a.splice(i, 1); return true }
  const local = flag('--local')
  const devState = path.join(REPO, 'cloud/dev/.state')
  const o: Options = {
    local,
    base: (take('--base') ?? (local ? 'https://cloud.localhost:8443' : 'https://cloud.trina.app')).replace(/\/$/, ''),
    team: take('--team') ?? (local ? 'acme' : 'trina'),
    profile: take('--profile') ?? 'tdcloud',
    region: take('--region') ?? 'ap-northeast-2',
    website: take('--website') ?? (local ? null : 'https://drive.trina.app'),
    canary: take('--canary') ?? 'smoke-canary',
    email: take('--email') ?? null,
    secretsDir: take('--secrets-dir') ?? path.join(os.homedir(), '.config/trina-drive/smoke'),
    ssmPrefix: take('--ssm-prefix') ?? '/tdcloud/smoke',
    caFile: take('--ca') ?? (local ? path.join(devState, 'caddy-root.crt') : null),
    skip: new Set((take('--skip') ?? '').split(',').filter(Boolean)),
    only: null,
    json: flag('--json'),
    mailWaitS: Number(take('--mail-wait') ?? 120),
  }
  const only = take('--only')
  if (only) o.only = new Set(only.split(',').filter(Boolean))
  if (a.length) throw new Error(`unknown arguments: ${a.join(' ')}`)
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/.test(o.base)) throw new Error(`--base must be https://<domain>[:port], not ${o.base}`)
  if (!/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(o.team)) throw new Error(`bad --team ${o.team}`)
  return o
}

// ---------------------------------------------------------------- output (everything passes the redactor)
const secrets = new Set<string>()
export function redact(s: string): string {
  let out = s
  for (const v of secrets) if (v.length >= 6) out = out.split(v).join('***')
  return out
}
export type Status = 'ok' | 'FAIL' | 'skip'
export interface Result { id: string; name: string; status: Status; detail: string; ms: number }

// ---------------------------------------------------------------- shells: the control instance and the team's host
export interface ExecResult { code: number; stdout: string; stderr: string }
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

async function spawn(argv: string[], o: { timeoutS?: number; stdin?: string } = {}): Promise<ExecResult> {
  const p = Bun.spawn(argv, { stdin: o.stdin !== undefined ? new TextEncoder().encode(o.stdin) : 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => p.kill(), (o.timeoutS ?? 300) * 1000)
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  clearTimeout(timer)
  return { code, stdout, stderr }
}

interface Shell {
  readonly kind: 'aws' | 'local'
  control(cmd: string, timeoutS?: number): Promise<ExecResult>
  host(id: string, cmd: string, timeoutS?: number): Promise<ExecResult>
}

class LocalShell implements Shell {
  readonly kind = 'local' as const
  control(cmd: string, timeoutS = 300) { return spawn(['bash', '-c', cmd], { timeoutS }) }
  host(_id: string, cmd: string, timeoutS = 300) { return spawn(['bash', '-c', cmd], { timeoutS }) }
}

class SsmShell implements Shell {
  readonly kind = 'aws' as const
  private controlId: string | null = null
  constructor(private readonly o: Options) {}
  aws(args: string[], timeoutS = 120) { return spawn(['aws', ...args, '--profile', this.o.profile, '--region', this.o.region, '--output', 'json'], { timeoutS }) }
  async instance(role: string): Promise<string> {
    const r = await this.aws(['ec2', 'describe-instances', '--filters', `Name=tag:tdcloud:role,Values=${role}`, 'Name=instance-state-name,Values=running', '--query', 'Reservations[].Instances[].InstanceId'])
    if (r.code !== 0) throw new Error(`describe-instances: ${r.stderr.trim()}`)
    const ids = JSON.parse(r.stdout) as string[]
    if (!ids[0]) throw new Error(`no running instance with tag tdcloud:role=${role}`)
    return ids[0]
  }
  async run(id: string, cmd: string, timeoutS: number): Promise<ExecResult> {
    // the command text lands in SSM's command history: never a secret in it (callers read secrets on the instance)
    const send = await this.aws(['ssm', 'send-command', '--instance-ids', id, '--document-name', 'AWS-RunShellScript', '--comment', 'tdcloud smoke',
      '--timeout-seconds', String(Math.max(30, timeoutS)), '--parameters', JSON.stringify({ commands: [cmd], executionTimeout: [String(timeoutS)] }), '--query', 'Command.CommandId'])
    if (send.code !== 0) throw new Error(`ssm send-command: ${send.stderr.trim()}`)
    const cid = JSON.parse(send.stdout) as string
    const deadline = Date.now() + (timeoutS + 60) * 1000
    for (;;) {
      await Bun.sleep(2000)
      const g = await this.aws(['ssm', 'get-command-invocation', '--command-id', cid, '--instance-id', id])
      if (g.code === 0) {
        const j = JSON.parse(g.stdout) as { Status: string; ResponseCode: number; StandardOutputContent: string; StandardErrorContent: string }
        if (!['Pending', 'InProgress', 'Delayed'].includes(j.Status)) return { code: j.ResponseCode, stdout: j.StandardOutputContent, stderr: j.StandardErrorContent }
      } else if (!/InvocationDoesNotExist/.test(g.stderr)) throw new Error(`ssm get-command-invocation: ${g.stderr.trim()}`)
      if (Date.now() > deadline) throw new Error(`ssm command ${cid} did not finish`)
    }
  }
  async control(cmd: string, timeoutS = 300) { this.controlId ??= await this.instance('control'); return this.run(this.controlId, cmd, timeoutS) }
  host(id: string, cmd: string, timeoutS = 300) { return this.run(id, cmd, timeoutS) }
}

const CONTROL_CLI = 'docker exec tdc-control bun /app/src/main.ts'

// ---------------------------------------------------------------- secrets: 0600 files or SSM, never argv/env
async function secret(o: Options, name: string, ssm: SsmShell | null, required = true): Promise<string | null> {
  const file = path.join(o.secretsDir, name)
  let v: string | null = null
  if (fs.existsSync(file)) {
    const mode = fs.statSync(file).mode & 0o777
    if (mode & 0o077) throw new Error(`${file} must be 0600 (it is ${mode.toString(8)})`)
    v = fs.readFileSync(file, 'utf8').replace(/\r?\n$/, '')
  } else if (ssm) {
    const r = await ssm.aws(['ssm', 'get-parameter', '--with-decryption', '--name', `${o.ssmPrefix}/${name}`, '--query', 'Parameter.Value'])
    if (r.code === 0) v = JSON.parse(r.stdout) as string
  }
  if (v) { secrets.add(v); return v }
  if (required) throw new Error(`no ${name}: put it in ${file} (0600)${ssm ? ` or the SSM SecureString ${o.ssmPrefix}/${name}` : ''}`)
  return null
}

// ---------------------------------------------------------------- HTTP with one cookie jar per exact host (R13)
interface Res { status: number; headers: Headers; text: string; url: string; setCookies: string[] }
class Browser {
  readonly jars = new Map<string, Map<string, string>>()
  constructor(private readonly ca: string | null) {}
  jar(host: string) { let j = this.jars.get(host); if (!j) this.jars.set(host, (j = new Map())); return j }
  async req(method: string, url: string, o: { body?: BodyInit; headers?: Record<string, string>; noCookies?: boolean; timeoutMs?: number } = {}): Promise<Res> {
    const u = new URL(url)
    const jar = this.jar(u.host)
    const headers: Record<string, string> = { 'user-agent': 'trina-cloud-smoke/1', ...o.headers }
    if (!o.noCookies && jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
    const r = await fetch(url, { method, headers, body: o.body, redirect: 'manual', signal: AbortSignal.timeout(o.timeoutMs ?? 60_000), ...(this.ca ? { tls: { ca: this.ca } } : {}) } as RequestInit)
    const setCookies = r.headers.getSetCookie?.() ?? []
    for (const c of setCookies) {
      const [kv] = c.split(';'), i = kv!.indexOf('=')
      const k = kv!.slice(0, i).trim(), v = kv!.slice(i + 1).trim()
      if (/max-age=0\b/i.test(c) || v === '') jar.delete(k)
      else { jar.set(k, v); if (v.length >= 16) secrets.add(v) }
    }
    const text = await r.text()
    return { status: r.status, headers: r.headers, text, url, setCookies }
  }
}

// ---------------------------------------------------------------- TLS / TCP probes
interface Cert { ok: boolean; issuerO: string; san: string; daysLeft: number; error?: string }
export function peerCert(host: string, port: number, servername: string, ca: string | null): Promise<Cert> {
  return new Promise((resolve) => {
    const s = tls.connect({ host, port, servername, rejectUnauthorized: true, ...(ca ? { ca } : {}), timeout: 10_000 }, () => {
      const c = s.getPeerCertificate()
      s.end()
      resolve({ ok: true, issuerO: String(c.issuer?.O ?? c.issuer?.CN ?? ''), san: c.subjectaltname ?? '', daysLeft: Math.floor((Date.parse(c.valid_to) - Date.now()) / 86400_000) })
    })
    s.on('error', (e) => resolve({ ok: false, issuerO: '', san: '', daysLeft: 0, error: e.message }))
    s.on('timeout', () => { s.destroy(); resolve({ ok: false, issuerO: '', san: '', daysLeft: 0, error: 'timeout' }) })
  })
}
/** any certificate at all for this name (verification off): a handshake that completes means Caddy issued one */
function handshakes(host: string, port: number, servername: string): Promise<string | null> {
  return new Promise((resolve) => {
    const s = tls.connect({ host, port, servername, rejectUnauthorized: false, timeout: 15_000 }, () => {
      // Bun calls back even when the server answered the ClientHello with an alert: then there is no peer certificate
      const c = s.getPeerCertificate()
      s.end()
      resolve(c && Object.keys(c).length ? String(c.subject?.CN ?? c.subjectaltname ?? 'a certificate') : null)
    })
    s.on('error', () => resolve(null))
    s.on('timeout', () => { s.destroy(); resolve(null) })
  })
}
function tcpOpen(host: string, port: number, ms = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port })
    const t = setTimeout(() => { s.destroy(); resolve(false) }, ms)
    s.on('connect', () => { clearTimeout(t); s.end(); resolve(true) })
    s.on('error', () => { clearTimeout(t); resolve(false) })
  })
}

// ---------------------------------------------------------------- small helpers
const sha256 = (b: Uint8Array | string) => crypto.createHash('sha256').update(b).digest('hex')
const rand = () => crypto.randomBytes(5).toString('hex')
const json = <T>(r: Res): T => JSON.parse(r.text) as T
const first = (s: string) => s.trim().split('\n')[0] ?? ''
/** `<a href="X">… text …</a>` pairs of an HTML page */
export function anchors(html: string): { href: string; text: string }[] {
  return [...html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].map((m) => ({ href: m[1]!, text: m[2]!.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() }))
}
/** the first <form method=post> of a page: its action and fields (a form_post hand-over) */
export function postForm(html: string, base: string): { action: string; fields: Record<string, string> } | null {
  const m = /<form\b[^>]*\bmethod\s*=\s*["']?post["']?[^>]*>([\s\S]*?)<\/form>/i.exec(html)
  if (!m) return null
  const action = /\baction\s*=\s*["']([^"']+)["']/i.exec(m[0])?.[1] ?? base
  const fields: Record<string, string> = {}
  for (const i of m[1]!.matchAll(/<input\b[^>]*>/gi)) {
    const name = /\bname\s*=\s*["']([^"']+)["']/i.exec(i[0])?.[1], value = /\bvalue\s*=\s*["']([^"']*)["']/i.exec(i[0])?.[1] ?? ''
    if (name) fields[name] = value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  }
  return { action: new URL(action.replace(/&amp;/g, '&'), base).toString(), fields }
}
/** a Prometheus sample's value, or null */
export function metric(text: string, name: string, labels = ''): number | null {
  const line = text.split('\n').find((l) => l.startsWith(`${name}${labels} `) || (labels === '' && l.startsWith(`${name} `)))
  return line ? Number(line.trim().split(/\s+/).at(-1)) : null
}

// ---------------------------------------------------------------- the checks
interface Ctx {
  o: Options
  sh: Shell
  ssm: SsmShell | null
  web: Browser
  ca: string | null
  domain: string
  port: number
  teamUrl: string
  t0: number
  /** filled as the run goes */
  st: {
    consoleCsrf?: string
    teamCsrf?: string
    teamSession?: boolean
    teamRow?: { host: string | null; public_ip: string | null; status: string }
    hostCheck?: ExecResult
    pat?: { id: number; token: string }
    appPw?: { id: number; password: string; user: string; url: string }
    davFile?: string
  }
}
type Check = { id: string; name: string; aliases?: string[]; run: (c: Ctx) => Promise<[Status, string]> }

const SIGNIN_TEXT = /^(sign in|log in)$/i, START_TEXT = /^start free$/i

const CHECKS: Check[] = [
  {
    id: '1', name: 'website', aliases: ['website'],
    async run(c) {
      if (!c.o.website) return ['skip', '(no --website)']
      const r = await c.web.req('GET', c.o.website, { noCookies: true })
      if (r.status !== 200) return ['FAIL', `${c.o.website} → ${r.status}`]
      const links = anchors(r.text)
      const sign = links.filter((l) => SIGNIN_TEXT.test(l.text)), start = links.filter((l) => START_TEXT.test(l.text))
      if (!sign.length || !start.length) return ['FAIL', `no "Sign in" / "Start free" link on ${c.o.website} (found ${sign.length}/${start.length})`]
      const wrong = [...sign, ...start].filter((l) => !l.href.startsWith(c.o.base))
      return wrong.length ? ['FAIL', `links not to ${c.o.base}: ${wrong.map((l) => `${l.text} → ${l.href}`).join(', ')}`] : ['ok', `${sign.length + start.length} links to ${c.o.base}`]
    },
  },
  {
    id: '2', name: 'control plane', aliases: ['control'],
    async run(c) {
      const out: string[] = []
      const r = await c.web.req('GET', `${c.o.base}/healthz`, { noCookies: true })
      if (r.status !== 200 || !/"ok"\s*:\s*true/.test(r.text)) return ['FAIL', `/healthz → ${r.status} ${r.text.slice(0, 80)}`]
      if (!r.headers.get('strict-transport-security') && c.sh.kind === 'aws') return ['FAIL', 'no Strict-Transport-Security header']
      const cert = await peerCert(c.domain, c.port, c.domain, c.ca)
      if (!cert.ok) return ['FAIL', `TLS: ${cert.error}`]
      if (c.sh.kind === 'aws') {
        if (!/let's encrypt/i.test(cert.issuerO)) return ['FAIL', `certificate issuer ${cert.issuerO} (want Let's Encrypt)`]
        if (!cert.san.includes(`DNS:${c.domain}`)) return ['FAIL', `certificate names ${cert.san}`]
        if (cert.daysLeft < 30) return ['FAIL', `certificate expires in ${cert.daysLeft} days`]
        const h = await fetch(`http://${c.domain}/healthz`, { redirect: 'manual', signal: AbortSignal.timeout(10_000) }).then((x) => x.status, () => 0)
        if (h !== 308 && h !== 301) return ['FAIL', `http:// → ${h} (want 308 to https)`]
        out.push('http→https 308')
      }
      out.push(`cert ${cert.issuerO}, ${cert.daysLeft} days`)
      const log = await c.sh.control("docker logs tdc-control 2>&1 | grep 'control plane on' | tail -1")
      const line = log.stdout.trim()
      if (!line) return ['FAIL', `no start line in docker logs tdc-control (${first(log.stderr)})`]
      if (c.sh.kind === 'aws') {
        for (const want of ['driver aws', 'mail resend', 'keys kms', 'backups s3']) if (!line.includes(want)) return ['FAIL', `start line lacks "${want}": ${line.slice(0, 240)}`]
      }
      out.push(/driver \w+; mail \w+; keys \w+/.exec(line)?.[0] ?? 'started')
      return ['ok', out.join('; ')]
    },
  },
  {
    id: '3', name: 'console sign-in', aliases: ['login'],
    async run(c) {
      const email = c.o.email ?? (await secret(c.o, 'email', c.ssm))!
      const password = (await secret(c.o, 'password', c.ssm))!
      const r = await c.web.req('POST', `${c.o.base}/api/login`, { body: JSON.stringify({ email, password }), headers: { 'content-type': 'application/json', origin: c.o.base } })
      if (r.status !== 200) return ['FAIL', `/api/login → ${r.status} ${r.text.slice(0, 160)}`]
      c.st.consoleCsrf = (json<{ csrf?: string }>(r).csrf) ?? ''
      if (c.st.consoleCsrf) secrets.add(c.st.consoleCsrf)
      const host = r.setCookies.find((x) => /^__Host-/.test(x))
      const t = await c.web.req('GET', `${c.o.base}/api/teams`)
      if (t.status !== 200) return ['FAIL', `/api/teams → ${t.status}`]
      const teams = json<{ teams: { slug: string; status: string }[] }>(t).teams ?? []
      const mine = teams.find((x) => x.slug === c.o.team)
      if (!mine) return ['FAIL', `${c.o.team} not in /api/teams (${teams.map((x) => x.slug).join(', ') || 'none'}): is the smoke account a member?`]
      if (mine.status !== 'active') return ['FAIL', `${c.o.team} is ${mine.status}`]
      return ['ok', `${c.o.team} active; session cookie ${host ? '__Host- (host-only)' : 'without the __Host- prefix'}`]
    },
  },
  {
    id: '4', name: 'team front + OAuth metadata', aliases: ['team'],
    async run(c) {
      const r = await c.web.req('GET', `${c.teamUrl}/`, { noCookies: true })
      if (r.status !== 200) return ['FAIL', `${c.teamUrl}/ → ${r.status}`]
      const cert = await peerCert(c.domain === 'cloud.localhost' ? '127.0.0.1' : `${c.o.team}.${c.domain}`, c.port, `${c.o.team}.${c.domain}`, c.ca)
      if (!cert.ok) return ['FAIL', `TLS: ${cert.error}`]
      if (c.sh.kind === 'aws' && !/let's encrypt/i.test(cert.issuerO)) return ['FAIL', `team certificate issuer ${cert.issuerO}`]
      const as = await c.web.req('GET', `${c.teamUrl}/.well-known/oauth-authorization-server`, { noCookies: true })
      if (as.status !== 200 || json<{ issuer?: string }>(as).issuer !== c.teamUrl) return ['FAIL', `oauth-authorization-server issuer ${as.status} ${as.text.slice(0, 120)}`]
      let pr = await c.web.req('GET', `${c.teamUrl}/.well-known/oauth-protected-resource/mcp`, { noCookies: true })
      if (pr.status !== 200) pr = await c.web.req('GET', `${c.teamUrl}/.well-known/oauth-protected-resource`, { noCookies: true })
      if (pr.status !== 200 || json<{ resource?: string }>(pr).resource !== `${c.teamUrl}/mcp`) return ['FAIL', `oauth-protected-resource ${pr.status} ${pr.text.slice(0, 120)}`]
      return ['ok', `issuer ${c.teamUrl}, resource /mcp, cert ${cert.issuerO}`]
    },
  },
  {
    id: '5', name: 'MCP without auth', aliases: ['mcp-unauth'],
    async run(c) {
      const r = await c.web.req('POST', `${c.teamUrl}/mcp`, { noCookies: true, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }), headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' } })
      const w = r.headers.get('www-authenticate') ?? ''
      return r.status === 401 && /^Bearer\b/i.test(w) && /resource_metadata="/.test(w) ? ['ok', `401 ${w.slice(0, 100)}`] : ['FAIL', `${r.status} WWW-Authenticate: ${w || '(none)'}`]
    },
  },
  {
    id: '6', name: 'SSO round trip', aliases: ['sso'],
    async run(c) {
      if (c.st.consoleCsrf === undefined) return ['FAIL', 'needs check 3 (console sign-in)']
      let url = `${c.teamUrl}/api/sso/start`, method = 'GET', body: string | undefined, from = c.teamUrl
      const hops: string[] = []
      const teamHost = new URL(c.teamUrl).host, consoleHost = new URL(c.o.base).host
      for (let i = 0; i < 12; i++) {
        const r = await c.web.req(method, url, body ? { body, headers: { 'content-type': 'application/x-www-form-urlencoded', origin: from } } : {})
        const u = new URL(url)
        hops.push(`${method} ${u.host}${u.pathname} ${r.status}`)
        for (const sc of r.setCookies) if (/;\s*domain=/i.test(sc)) return ['FAIL', `${u.host} set a cookie with Domain= (must be host-only, R13): ${sc.split(';')[0]!.split('=')[0]}`]
        if (r.status >= 300 && r.status < 400) { url = new URL(r.headers.get('location')!, url).toString(); method = 'GET'; body = undefined; from = u.origin; continue }
        if (r.status !== 200) return ['FAIL', `${hops.join(' → ')}: ${r.text.slice(0, 160)}`]
        const f = postForm(r.text, url)
        if (f && new URL(f.action).host !== u.host) { from = u.origin; url = f.action; method = 'POST'; body = new URLSearchParams(f.fields).toString(); continue }
        if (u.host === teamHost) break
        return ['FAIL', `stopped at ${u.host}${u.pathname} (${hops.join(' → ')})`]
      }
      if (!c.web.jar(teamHost).size) return ['FAIL', `no session on ${teamHost} (${hops.join(' → ')})`]
      // the two hosts never share a cookie: what the console set is not in the team's jar and the other way round
      const shared = [...c.web.jar(teamHost).keys()].filter((k) => c.web.jar(consoleHost).has(k) && c.web.jar(consoleHost).get(k) === c.web.jar(teamHost).get(k))
      if (shared.length) return ['FAIL', `same cookie on both hosts: ${shared.join(', ')}`]
      const s = await c.web.req('GET', `${c.teamUrl}/api/session`)
      if (s.status !== 200) return ['FAIL', `/api/session → ${s.status}`]
      c.st.teamCsrf = json<{ csrf: string }>(s).csrf; secrets.add(c.st.teamCsrf)
      c.st.teamSession = true
      const f = await c.web.req('GET', `${c.teamUrl}/api/files?path=/`)
      return f.status === 200 ? ['ok', `${hops.length} hops; /api/files 200`] : ['FAIL', `/api/files?path=/ → ${f.status}`]
    },
  },
  {
    id: '7', name: 'MCP with a PAT', aliases: ['mcp'],
    async run(c) {
      if (!c.st.teamSession) return ['FAIL', 'needs check 6 (a team session)']
      const t = await c.web.req('POST', `${c.teamUrl}/api/tokens`, { body: JSON.stringify({ name: `smoke-${rand()}`, ttl: '8h' }), headers: { 'content-type': 'application/json', origin: c.teamUrl, 'x-csrf-token': c.st.teamCsrf! } })
      if (t.status !== 200 && t.status !== 201) return ['FAIL', `POST /api/tokens → ${t.status} ${t.text.slice(0, 120)}`]
      c.st.pat = json<{ id: number; token: string }>(t); secrets.add(c.st.pat.token)
      let sid = ''
      const rpc = async (id: number, m: string, params: unknown) => {
        const r = await c.web.req('POST', `${c.teamUrl}/mcp`, { noCookies: true, timeoutMs: 120_000, body: JSON.stringify({ jsonrpc: '2.0', id, method: m, params }), headers: { authorization: `Bearer ${c.st.pat!.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) } })
        sid = r.headers.get('mcp-session-id') ?? sid
        const body = r.text.trim().startsWith('{') ? r.text : (r.text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).at(-1) ?? '{}')
        return { status: r.status, j: JSON.parse(body) as { result?: Record<string, unknown>; error?: { message: string } } }
      }
      const init = await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'trina-cloud-smoke', version: '1' } })
      if (init.status !== 200 || !init.j.result) return ['FAIL', `initialize ${init.status} ${JSON.stringify(init.j.error ?? {}).slice(0, 120)}`]
      await c.web.req('POST', `${c.teamUrl}/mcp`, { noCookies: true, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), headers: { authorization: `Bearer ${c.st.pat.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) } })
      const list = await rpc(2, 'tools/list', {})
      const tools = ((list.j.result?.tools ?? []) as { name: string }[]).map((x) => x.name)
      if (!tools.length) return ['FAIL', 'tools/list is empty']
      const sharing = tools.filter((n) => /share|permission|grant|rule|access/i.test(n))
      if (sharing.length) return ['FAIL', `agents must not share (S43): ${sharing.join(', ')}`]
      const ls = await rpc(3, 'tools/call', { name: 'bash', arguments: { command: 'ls /' } })
      const text = JSON.stringify(ls.j.result ?? ls.j.error ?? '')
      if (!ls.j.result) return ['FAIL', `bash "ls /": ${text.slice(0, 160)}`]
      let canary = 'no --canary'
      if (c.o.canary) {
        if (text.includes(c.o.canary)) return ['FAIL', `the canary folder ${c.o.canary} is visible to the smoke member`]
        const f = await c.web.req('GET', `${c.teamUrl}/api/files?path=${encodeURIComponent(`/${c.o.canary}`)}`)
        if (f.status === 200) return ['FAIL', `/api/files?path=/${c.o.canary} → 200 for the smoke member`]
        canary = `canary hidden (${f.status})`
      }
      return ['ok', `${tools.length} tools, none for sharing; ls / ok; ${canary}`]
    },
  },
  {
    id: '8', name: 'WebDAV 30 MB', aliases: ['webdav', 'dav'],
    async run(c) {
      if (!c.st.teamSession) return ['FAIL', 'needs check 6 (a team session)']
      const view = await c.web.req('GET', `${c.teamUrl}/api/me/app-passwords`)
      if (view.status !== 200) return ['FAIL', `GET /api/me/app-passwords → ${view.status}`]
      const v = json<{ enabled?: boolean; url?: string; username?: string }>(view)
      if (!v.enabled || !v.url) return ['FAIL', 'WebDAV is off for the team']
      const cr = await c.web.req('POST', `${c.teamUrl}/api/me/app-passwords`, { body: JSON.stringify({ name: `smoke-${rand()}` }), headers: { 'content-type': 'application/json', origin: c.teamUrl, 'x-csrf-token': c.st.teamCsrf! } })
      if (cr.status !== 200 && cr.status !== 201) return ['FAIL', `POST /api/me/app-passwords → ${cr.status} ${cr.text.slice(0, 120)} (an SSO sign-in must count as a fresh login)`]
      const a = json<{ id: number; password: string }>(cr); secrets.add(a.password)
      c.st.appPw = { id: a.id, password: a.password, user: v.username ?? '', url: v.url.endsWith('/') ? v.url : `${v.url}/` }
      const auth = `Basic ${Buffer.from(`${c.st.appPw.user}:${a.password}`).toString('base64')}`
      const pf = await c.web.req('PROPFIND', c.st.appPw.url, { noCookies: true, headers: { authorization: auth, depth: '1' } })
      if (pf.status !== 207) return ['FAIL', `PROPFIND ${new URL(c.st.appPw.url).pathname} → ${pf.status}`]
      const hrefs = [...pf.text.matchAll(/<(?:\w+:)?href>([^<]+)<\/(?:\w+:)?href>/g)].map((m) => decodeURIComponent(m[1]!)).filter((h) => h.endsWith('/') && h !== new URL(c.st.appPw!.url).pathname)
      const data = crypto.randomBytes(30 * 1024 * 1024), want = sha256(data)
      for (const dir of hrefs.slice(0, 5)) {
        const url = new URL(`${dir}smoke-${rand()}.bin`, c.st.appPw.url).toString()
        const put = await c.web.req('PUT', url, { noCookies: true, body: data, headers: { authorization: auth, 'content-type': 'application/octet-stream' }, timeoutMs: 300_000 })
        if (put.status === 403 || put.status === 405) continue
        if (put.status !== 201 && put.status !== 204) return ['FAIL', `PUT 30 MB → ${put.status} ${put.text.slice(0, 120)}`]
        c.st.davFile = url
        const back = await fetch(url, { headers: { authorization: auth }, signal: AbortSignal.timeout(300_000), ...(c.ca ? { tls: { ca: c.ca } } : {}) } as RequestInit)
        const got = sha256(new Uint8Array(await back.arrayBuffer()))
        if (got !== want) return ['FAIL', `GET back: ${back.status}, sha256 differs`]
        return ['ok', `PROPFIND 207, PUT ${put.status}, GET back sha256 equal (${dir})`]
      }
      return ['FAIL', `no folder the smoke member may write to among ${hrefs.length} (give it Editor on one)`]
    },
  },
  {
    id: '9', name: 'mail (DKIM)', aliases: ['mail'],
    async run(c) {
      // one Resend mail per run (100/day free): a console sign-in link to the smoke account, read with gws gmail
      const email = c.o.email ?? (await secret(c.o, 'email', c.ssm))!
      const gws = Bun.which('gws')
      if (!gws) return ['FAIL', 'gws is not installed (the Gmail reader); rerun with --skip mail']
      const since = Math.floor(Date.now() / 1000) - 5
      const r = await c.web.req('POST', `${c.o.base}/api/login/link`, { noCookies: true, body: JSON.stringify({ email }), headers: { 'content-type': 'application/json', origin: c.o.base } })
      if (r.status !== 200) return ['FAIL', `/api/login/link → ${r.status}`]
      const q = `from:cloud@ subject:"sign-in link" after:${since}`
      const deadline = Date.now() + c.o.mailWaitS * 1000
      while (Date.now() < deadline) {
        await Bun.sleep(5000)
        const l = await spawn([gws, 'gmail', 'users', 'messages', 'list', '--params', JSON.stringify({ userId: 'me', q, maxResults: 1 })], { timeoutS: 60 })
        if (l.code !== 0) return ['FAIL', `gws gmail list: ${first(l.stderr)}`]
        const id = (JSON.parse(l.stdout || '{}') as { messages?: { id: string }[] }).messages?.[0]?.id
        if (!id) continue
        const g = await spawn([gws, 'gmail', 'users', 'messages', 'get', '--params', JSON.stringify({ userId: 'me', id, format: 'metadata', metadataHeaders: ['Authentication-Results', 'From'] })], { timeoutS: 60 })
        const hs = ((JSON.parse(g.stdout || '{}') as { payload?: { headers?: { name: string; value: string }[] } }).payload?.headers ?? [])
        const ar = hs.filter((h) => h.name === 'Authentication-Results').map((h) => h.value).join(' ')
        const from = hs.find((h) => h.name === 'From')?.value ?? ''
        const dkim = /dkim=pass[^;]*header\.(?:d|i)=@?(?:[\w.-]*\.)?drive\.trina\.app/i.test(ar), spf = /spf=pass/i.test(ar)
        return dkim && spf ? ['ok', `arrived in ${Math.round((Date.now() - since * 1000) / 1000)} s from ${from}; dkim=pass d=drive.trina.app, spf=pass`] : ['FAIL', `arrived, but: ${ar.slice(0, 200) || 'no Authentication-Results'}`]
      }
      return ['FAIL', `no sign-in mail within ${c.o.mailWaitS} s (Gmail query: ${q}); is ${'the smoke address'} read by gws?`]
    },
  },
  {
    id: '10', name: 'backup + metrics', aliases: ['backup'],
    async run(c) {
      const b = await c.sh.control(`${CONTROL_CLI} teams backup ${shq(c.o.team)}`, 1800)
      if (b.code !== 0) return ['FAIL', `teams backup: ${first(b.stderr) || first(b.stdout)}`]
      const keys = b.stdout.trim().split('\n').map((l) => l.split('\t')).filter((p) => p.length === 3).map((p) => ({ part: p[0]!, bytes: Number(p[1]), key: p[2]! }))
      if (keys.length !== 2) return ['FAIL', `teams backup printed ${keys.length} objects`]
      const detail = [`${keys.map((k) => `${k.part} ${Math.round(k.bytes / 1024)} KiB`).join(', ')}`]
      if (c.ssm) {
        const target = (await c.sh.control('docker exec tdc-control printenv TDCLOUD_BACKUP_TARGET')).stdout.trim()
        const m = /^s3:\/\/([^/]+)\/?(.*)$/.exec(target)
        if (!m) return ['FAIL', `TDCLOUD_BACKUP_TARGET is ${target || '(unset)'}`]
        for (const k of keys) {
          const key = `${m[2] ? `${m[2].replace(/\/$/, '')}/` : ''}${k.key}`
          const h = await c.ssm.aws(['s3api', 'head-object', '--bucket', m[1]!, '--key', key])
          if (h.code !== 0) return ['FAIL', `s3://${m[1]}/${key}: ${first(h.stderr)}`]
          const j = JSON.parse(h.stdout) as { ServerSideEncryption?: string; LastModified?: string }
          if (j.ServerSideEncryption !== 'aws:kms') return ['FAIL', `${key}: encryption ${j.ServerSideEncryption}`]
          if (Date.parse(j.LastModified ?? '') < c.t0 - 60_000) return ['FAIL', `${key}: older than this run`]
        }
        detail.push('in S3, SSE-KMS')
      }
      const js = "const k=process.env.TDCLOUD_CADDY_ASK_KEY||'';fetch('http://127.0.0.1:8790/internal/metrics'+(k?'?key='+encodeURIComponent(k):'')).then(r=>r.text()).then(t=>console.log(t))"
      const mt = await c.sh.control(`docker exec tdc-control bun -e ${shq(js)}`)
      const age = metric(mt.stdout, 'tdcloud_last_backup_age_seconds', `{team="${c.o.team}"}`)
      if (age == null || age < 0 || age > 93_600) return ['FAIL', `tdcloud_last_backup_age_seconds{team="${c.o.team}"} = ${age}`]
      const waiting = metric(mt.stdout, 'tdcloud_teams_waiting_for_host')
      if (waiting != null && waiting > 0) return ['FAIL', `tdcloud_teams_waiting_for_host = ${waiting}`]
      detail.push(`backup age ${age} s, failed jobs ${metric(mt.stdout, 'tdcloud_jobs_failed_total') ?? '?'}, waiting ${waiting ?? '-'}`)
      return ['ok', detail.join('; ')]
    },
  },
  {
    id: '11', name: 'isolation from inside the team', aliases: ['isolation'],
    async run(c) {
      const row = await teamRow(c)
      if (!row.host) return ['FAIL', `${c.o.team} has no host`]
      const cmd = c.sh.kind === 'aws'
        ? `/usr/local/sbin/tdcloud-host check ${shq(c.o.team)}`
        // the local stack: no host firewall, no hairpin name (cloud.localhost is the container itself); colima's own sshd
        // listens on the gateway, so port 22 is not probed
        : `CHECK_CONTROL_ADDR=10.250.250.11 CHECK_HAIRPIN_URL= CHECK_HOST_PORTS='80 443 2019' bash ${shq(path.join(REPO, 'cloud/host/tdcloud-host'))} check ${shq(c.o.team)}`
      const r = await c.sh.host(row.host, cmd, 240)
      c.st.hostCheck = r
      const lines = r.stdout.trim().split('\n').filter(Boolean)
      const fails = lines.filter((l) => l.startsWith('FAIL'))
      if (r.code !== 0 || fails.length) return ['FAIL', fails.join(' | ') || first(r.stderr) || `exit ${r.code}`]
      return ['ok', `${lines.filter((l) => l.startsWith('ok')).length} probes ok${lines.some((l) => l.startsWith('skip')) ? `, ${lines.filter((l) => l.startsWith('skip')).map((l) => l.split(' ')[1]).join(', ')} skipped` : ''}`]
    },
  },
  {
    id: '12', name: 'unknown name gets no certificate', aliases: ['unknown'],
    async run(c) {
      const row = await teamRow(c)
      const ip = c.sh.kind === 'local' ? '127.0.0.1' : row.public_ip
      if (!ip) return ['FAIL', `${c.o.team} has no public address`]
      const name = `nope-${rand()}.${c.domain}`
      const cn = await handshakes(ip, c.port, name)
      return cn ? ['FAIL', `${ip} served a certificate for ${name} (${cn}): Caddy's ask let it through`] : ['ok', `${name} at ${ip}: handshake refused`]
    },
  },
  {
    id: '13', name: 'hairpin to the control plane', aliases: ['hairpin'],
    async run(c) {
      if (c.sh.kind === 'local') return ['skip', 'local stack (cloud.localhost is the container itself)']
      if (!c.st.hostCheck) return ['FAIL', 'needs check 11']
      const l = c.st.hostCheck.stdout.split('\n').find((x) => x.includes(' hairpin-control '))
      if (!l) return ['FAIL', 'no hairpin line in tdcloud-host check (an older host agent?)']
      return l.startsWith('ok') ? ['ok', l.slice(3)] : ['FAIL', `${l} — the invite dialog falls back to the console link (R10)`]
    },
  },
  {
    id: '14', name: '/internal/* not public', aliases: ['internal'],
    async run(c) {
      const r = await c.web.req('GET', `${c.o.base}/internal/metrics`, { noCookies: true })
      const a = await c.web.req('GET', `${c.o.base}/internal/caddy/ask?domain=${c.o.team}.${c.domain}`, { noCookies: true })
      return r.status === 404 && a.status === 404 ? ['ok', 'metrics 404, ask 404'] : ['FAIL', `metrics ${r.status}, ask ${a.status}`]
    },
  },
  {
    id: '15', name: 'port 8790 closed from the internet', aliases: ['ports'],
    async run(c) {
      if (c.sh.kind === 'local') return ['skip', 'local stack']
      const row = await teamRow(c)
      const control = (await dns.lookup(c.domain)).address
      const open = []
      for (const ip of [control, row.public_ip].filter(Boolean) as string[]) if (await tcpOpen(ip, 8790)) open.push(ip)
      return open.length ? ['FAIL', `8790 reachable on ${open.join(', ')}`] : ['ok', `closed on ${[control, row.public_ip].filter(Boolean).join(', ')}`]
    },
  },
  {
    id: '16', name: 'office rate-limit zones', aliases: ['office'],
    async run(c) {
      const row = await teamRow(c)
      const r = await c.sh.host(row.host ?? 'local', "docker exec tdc-caddy wget -qO- http://127.0.0.1:2019/config/ | grep -o '\"all_office\"' | head -1; docker exec tdc-caddy printenv TDCLOUD_TRUSTED_OFFICE_CIDRS || true")
      const [zone, cidrs = ''] = r.stdout.trim().split('\n')
      if (zone !== '"all_office"') return ['FAIL', 'the running Caddy has no office zones (caddy image 2.10.2-2 or later)']
      if (c.sh.kind === 'aws' && (!cidrs.trim() || cidrs.trim() === '192.0.2.0/32')) return ['FAIL', 'no office range set (Terraform office_cidrs → host.conf OFFICE_CIDRS, bootstrap rerun): the office shares one sign-in/MCP limit (review 24)']
      return ['ok', `zones present; office ranges: ${cidrs.trim() || '(default: none)'}`]
    },
  },
  {
    id: '17', name: 'host disk', aliases: ['disk'],
    async run(c) {
      const r = await c.sh.control(`${CONTROL_CLI} hosts check`, 300)
      const out = (r.stdout + r.stderr).trim()
      if (r.code !== 0) return ['FAIL', out.split('\n').filter((l) => /PROBLEM|error/i.test(l)).join(' | ').slice(0, 300) || out.slice(0, 300)]
      if (c.sh.kind === 'aws') {
        const cron = await c.sh.control('test -f /etc/cron.d/tdcloud-host-disk && echo yes')
        if (cron.stdout.trim() !== 'yes') return ['FAIL', 'no hourly disk check on the control host (/etc/cron.d/tdcloud-host-disk: rerun its bootstrap)']
      }
      return ['ok', out.split('\n').map((l) => l.replace(/\s+/g, ' ')).join(' | ').slice(0, 200)]
    },
  },
]

async function teamRow(c: Ctx) {
  if (c.st.teamRow) return c.st.teamRow
  const r = await c.sh.control(`${CONTROL_CLI} teams show ${shq(c.o.team)}`)
  if (r.code !== 0) throw new Error(`teams show ${c.o.team}: ${first(r.stderr)}`)
  const j = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))) as { host: string | null; public_ip: string | null; status: string }
  c.st.teamRow = { host: j.host, public_ip: j.public_ip, status: j.status }
  return c.st.teamRow
}

/** removes what the run made: the 30 MB file, the app password, the PAT (in that order: the file needs the password) */
async function cleanup(c: Ctx): Promise<string[]> {
  const left: string[] = []
  const h = { origin: c.teamUrl, 'x-csrf-token': c.st.teamCsrf ?? '' }
  if (c.st.davFile && c.st.appPw) {
    const auth = `Basic ${Buffer.from(`${c.st.appPw.user}:${c.st.appPw.password}`).toString('base64')}`
    const d = await c.web.req('DELETE', c.st.davFile, { noCookies: true, headers: { authorization: auth } }).catch(() => null)
    if (!d || ![200, 204, 404].includes(d.status)) left.push(`the WebDAV file ${new URL(c.st.davFile).pathname}`)
  }
  if (c.st.appPw) {
    const d = await c.web.req('DELETE', `${c.teamUrl}/api/me/app-passwords/${c.st.appPw.id}`, { headers: h }).catch(() => null)
    if (!d || d.status >= 300) left.push(`app password ${c.st.appPw.id}`)
  }
  if (c.st.pat) {
    const d = await c.web.req('DELETE', `${c.teamUrl}/api/tokens/${c.st.pat.id}`, { headers: h }).catch(() => null)
    if (!d || d.status >= 300) left.push(`token ${c.st.pat.id}`)
  }
  return left
}

export async function main(argv: string[]): Promise<number> {
  const o = parseArgs(argv)
  const u = new URL(o.base)
  const ca = o.caFile ? fs.readFileSync(o.caFile, 'utf8') : null
  const ssm = o.local ? null : new SsmShell(o)
  const c: Ctx = {
    o, ssm, sh: ssm ?? new LocalShell(), web: new Browser(ca), ca, domain: u.hostname, port: Number(u.port || 443),
    teamUrl: `https://${o.team}.${u.host}`, t0: Date.now(), st: {},
  }
  const results: Result[] = []
  const say = (r: Result) => { if (!o.json) console.log(redact(`${r.status.padEnd(4)} ${r.id.padStart(2)} ${r.name.padEnd(34)} ${r.detail}`)) }
  if (!o.json) console.log(`Trina Cloud smoke: ${o.base}, team ${o.team} (${o.local ? 'local stack' : `AWS, profile ${o.profile}`})`)
  try {
    for (const k of CHECKS) {
      const names = [k.id, ...(k.aliases ?? [])]
      const start = Date.now()
      let status: Status, detail: string
      if ((o.only && !names.some((n) => o.only!.has(n))) || names.some((n) => o.skip.has(n))) { status = 'skip'; detail = '(not asked for)' } else {
        try { [status, detail] = await k.run(c) } catch (e) { status = 'FAIL'; detail = `error: ${(e as Error).message}` }
      }
      const r = { id: k.id, name: k.name, status, detail: redact(detail), ms: Date.now() - start }
      results.push(r); say(r)
    }
  } finally {
    const left = await cleanup(c)
    if (left.length) { console.error(redact(`NOT cleaned up (remove by hand): ${left.join(', ')}`)) }
  }
  const failed = results.filter((r) => r.status === 'FAIL').length
  if (o.json) console.log(redact(JSON.stringify({ base: o.base, team: o.team, failed, results }, null, 2)))
  else console.log(`${failed ? `${failed} FAILED` : 'all ok'} (${results.filter((r) => r.status === 'ok').length} ok, ${results.filter((r) => r.status === 'skip').length} skipped) in ${Math.round((Date.now() - c.t0) / 1000)} s`)
  return failed ? 1 : 0
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(redact(`aws-smoke: ${(e as Error).message}`)); process.exit(2) })
}
