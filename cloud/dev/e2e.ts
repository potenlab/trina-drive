#!/usr/bin/env bun
// End-to-end check of local Trina Cloud (started by cloud/dev/up.sh). Everything goes through the public HTTPS front
// (Caddy, self-signed CA) except operator steps, which use the admin CLI / docker exec like an operator would.
//
//  1. two buyers sign up, confirm their email (outbox), create teams acme and globex
//  2. a Paddle subscription.created (signed with the dev webhook secret) for each → provisioned
//  3. Trina Cloud SSO (docs/SSO-CONTRACT.md): the "ready" mail carries no setup token, only the console's Open drive
//     link; /api/setup is gone; the owner sets up the console authenticator (owners must), opens the drive (form_post
//     assertion → a drive admin session)
//  4. hosted mode: the admin enrols the drive's authenticator app (codes computed here, RFC 6238) before anything else,
//     the next Open drive asks for it, then makes a personal access token on the web; MCP initialize / tools/list /
//     bash work over HTTPS; the drive's "someone became an admin" mail goes through the host's mail relay into the dev
//     mail sink; dana is invited in the console, accepts with her own account and opens the drive as a member
//  5. kim/boss in each team: kim cannot see 경영, boss can
//  6. isolation: no token, session or network path from one team reaches the other; the containers' settings
//  7. client addresses: fixed team network addresses; Caddy overwrites X-Forwarded-For, so the team records (and
//     rate-limits by) the real client address — not Caddy's, not a spoofed header; the relay refuses non-team senders
//  8. Caddy: no certificate for unknown names; suspend → paused page → resume; backup + export decrypt; audit chain
//  9. hosts (simulated, one team each: compose.yml): every team above scaled out from 0; a third team takes the last
//     host, a fourth waits at the limit (ops alerted), takes the host the third leaves, and once it is gone too the
//     emptied host is scaled in after the grace period — never the hosts of acme or the suspended globex
// 10. Free plan (compose.yml: cap 1, short idle timers): a disposable address is refused; email + team name → the
//     confirmation link → a free team on a host launched for it (a quarter slot, small limits, 1 GB, 3 people) → setup
//     link → a fourth person refused; a second mailbox waits on the waitlist (ops told); the owner signs in with an
//     email link; nobody uses it → warned → paused (paused page with Wake up) → woken from the control plane in
//     seconds → used again → upgraded to Team by a signed subscription.created: same team, data, address, new limits
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { paddleHeader } from '../control/src/paddle'
import { Console } from './e2e/lib/console'
import { Http } from './e2e/lib/http'
import { localTarget } from './e2e/lib/target'
import { freshTotp } from './e2e/lib/totp'

const DEV = import.meta.dir
const STATE = path.join(DEV, '.state')
const env = Object.fromEntries(fs.readFileSync(path.join(STATE, 'dev.env'), 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
const DOMAIN = env.TDCLOUD_DOMAIN!, PORT = env.TDCLOUD_PUBLIC_PORT!
const CONTROL = `https://${DOMAIN}:${PORT}`
const teamUrl = (slug: string) => `https://${slug}.${DOMAIN}:${PORT}`
const CA = fs.readFileSync(path.join(STATE, 'caddy-root.crt'), 'utf8')
const OUTBOX = path.join(STATE, 'outbox.log')
/** the dev mail sink (relay upstream outbox:<file>): what the host's mail relay would have handed to Resend (cloud/control/src/relay.ts) */
const TEAM_MAIL = path.join(STATE, 'team-mail.log')
const RELAY_PORT = 8025
const HTTP = new Http(localTarget('acme'))

let failed = 0, passed = 0
const t0 = Date.now()
function check(what: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ok   ${what}`) } else { failed++; console.log(`  FAIL ${what}${detail !== undefined ? `\n       ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`.slice(0, 600) : ''}`) }
}
const step = (s: string) => console.log(`\n== ${s} (${Math.round((Date.now() - t0) / 1000)}s)`)

interface Res { status: number; headers: Headers; text: string; json: () => any }
async function req(method: string, url: string, o: { body?: unknown; raw?: string; headers?: Record<string, string>; cookie?: string; origin?: boolean } = {}): Promise<Res> {
  const u = new URL(url)
  const headers: Record<string, string> = { ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}), ...o.headers }
  if (o.cookie) headers.cookie = o.cookie
  if (o.origin !== false && method !== 'GET') headers.origin = u.origin
  const r = await fetch(url, { method, headers, body: o.raw ?? (o.body !== undefined ? JSON.stringify(o.body) : undefined), redirect: 'manual', tls: { ca: CA }, signal: AbortSignal.timeout(60_000) } as RequestInit)
  const text = await r.text()
  return { status: r.status, headers: r.headers, text, json: () => JSON.parse(text) }
}
const cookieOf = (r: Res) => r.headers.get('set-cookie')?.split(';')[0] ?? ''
const teamMail = () => (fs.existsSync(TEAM_MAIL) ? fs.readFileSync(TEAM_MAIL, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { team: number; from: string; to: string; subject: string; text: string }) : [])
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex')

/** RFC 6238 TOTP (HMAC-SHA1, 30 s steps, 6 digits), written here rather than taken from the product. */
function totp(secretB32: string, ms = Date.now()): string {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''
  for (const ch of secretB32.replace(/=+$/, '').toUpperCase()) {
    const v = A.indexOf(ch)
    if (v < 0) throw new Error(`not base32: ${ch}`)
    bits += v.toString(2).padStart(5, '0')
  }
  const key = Buffer.from(Array.from({ length: Math.floor(bits.length / 8) }, (_, i) => parseInt(bits.slice(i * 8, i * 8 + 8), 2)))
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(ms / 30_000)))
  const h = crypto.createHmac('sha1', key).update(counter).digest()
  const o = h[19]! & 0xf
  const bin = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!
  return String(bin % 1_000_000).padStart(6, '0')
}
const outbox = () => (fs.existsSync(OUTBOX) ? fs.readFileSync(OUTBOX, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { to: string; subject: string; text: string }) : [])

function sh(argv: string[], input?: string): { code: number; out: string; err: string } {
  const p = Bun.spawnSync(argv, { stdin: input !== undefined ? new TextEncoder().encode(input) : 'ignore', stdout: 'pipe', stderr: 'pipe' })
  return { code: p.exitCode ?? -1, out: p.stdout.toString(), err: p.stderr.toString() }
}
/** the admin CLI; a second process on the control database can meet "database is locked" while the server writes:
 * that attempt changed nothing, so it is tried again (a few times, briefly) */
function admin(...args: string[]) {
  let r = sh(['docker', 'exec', 'tdc-control', 'bun', '/app/src/main.ts', ...args])
  for (let i = 0; i < 5 && r.code !== 0 && /database is locked/.test(r.err + r.out); i++) {
    Bun.sleepSync(400 * (i + 1))
    r = sh(['docker', 'exec', 'tdc-control', 'bun', '/app/src/main.ts', ...args])
  }
  return r
}
const tdrive = (slug: string, ...args: string[]) => sh(['docker', 'exec', `tdc-${slug}`, '/usr/local/bin/tdrive', ...args])

let rpcId = 1
async function mcp(slug: string, token: string, method: string, params?: unknown) {
  return req('POST', `${teamUrl(slug)}/mcp`, { origin: false, headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' }, body: { jsonrpc: '2.0', id: rpcId++, method, ...(params ? { params } : {}) } })
}
async function bash(slug: string, token: string, command: string): Promise<{ status: number; stdout: string; stderr: string; raw: string }> {
  const r = await mcp(slug, token, 'tools/call', { name: 'bash', arguments: { command } })
  let sc: { stdout?: string; stderr?: string } = {}
  try { sc = r.json().result?.structuredContent ?? {} } catch { /* not JSON */ }
  return { status: r.status, stdout: sc.stdout ?? '', stderr: sc.stderr ?? '', raw: r.text }
}

interface Team { slug: string; buyer: string; id: string; adminPat: string; adminCookie: string; kim: string; boss: string }

async function buyAndSetUp(slug: string, name: string, buyer: string): Promise<Team> {
  step(`${slug}: sign up, confirm email, create team`)
  const pw = `pw-${slug}-correct-horse`
  check('sign up', (await req('POST', `${CONTROL}/api/signup`, { body: { email: buyer, password: pw } })).status === 200)
  const verify = outbox().filter((m) => m.to === buyer && /verify\?token=/.test(m.text)).at(-1)
  check('confirmation mail in the outbox', !!verify)
  const token = verify!.text.match(/verify\?token=(\S+)/)![1]
  check('confirm email', (await req('POST', `${CONTROL}/api/verify`, { body: { token } })).status === 200)
  const login = await req('POST', `${CONTROL}/api/login`, { body: { email: buyer, password: pw } })
  check('sign in', login.status === 200 && /^(__Host-)?tdcloud_session=/.test(cookieOf(login)))
  const cookie = cookieOf(login), csrf = login.json().csrf
  check('cookie is HttpOnly + Secure', /HttpOnly/.test(login.headers.get('set-cookie') ?? '') && /Secure/.test(login.headers.get('set-cookie') ?? ''))
  const mk = await req('POST', `${CONTROL}/api/teams`, { cookie, headers: { 'x-csrf-token': csrf }, body: { name, slug } })
  check('create team', mk.status === 201, mk.text)
  const team = mk.json().team as { id: string; status: string }
  check('team waits for payment', team.status === 'pending_payment')
  check('no certificate before payment', !(await tlsOk(slug)))

  step(`${slug}: Paddle subscription.created (signed) → provisioning`)
  const ev = { event_id: `evt_dev_${slug}_${Date.now()}`, event_type: 'subscription.created', occurred_at: new Date().toISOString(), notification_id: `ntf_${slug}`,
    data: { id: `sub_dev_${slug}`, status: 'active', customer_id: `ctm_dev_${slug}`, currency_code: 'USD', items: [{ price: { id: 'pri_dev_team_monthly' }, quantity: 1 }], custom_data: { tdcloud_team: team.id } } }
  const raw = JSON.stringify(ev)
  check('unsigned webhook refused', (await req('POST', `${CONTROL}/paddle/webhook`, { raw, origin: false, headers: { 'content-type': 'application/json', 'paddle-signature': `ts=${Math.floor(Date.now() / 1000)};h1=deadbeef` } })).status === 401)
  const wh = await req('POST', `${CONTROL}/paddle/webhook`, { raw, origin: false, headers: { 'content-type': 'application/json', 'paddle-signature': paddleHeader(env.PADDLE_WEBHOOK_SECRET!, raw) } })
  check('signed webhook accepted', wh.status === 200 && wh.text === 'ok', wh.text)
  const again = await req('POST', `${CONTROL}/paddle/webhook`, { raw, origin: false, headers: { 'content-type': 'application/json', 'paddle-signature': paddleHeader(env.PADDLE_WEBHOOK_SECRET!, raw) } })
  check('replayed event is a no-op', again.text === 'duplicate')
  let status = ''
  const deadline = Date.now() + 240_000
  while (Date.now() < deadline) {
    const r = await req('GET', `${CONTROL}/api/teams`, { cookie })
    status = (r.json().teams as { slug: string; status: string }[]).find((x) => x.slug === slug)?.status ?? ''
    if (status === 'active' || status === 'failed') break
    await Bun.sleep(2000)
  }
  check(`provisioned (status ${status})`, status === 'active', admin('jobs', 'list').out)
  const row = showTeam(slug)
  check(`${slug} runs on a host the scaler launched for it (${row.host})`, /^local-\d+$/.test(row.host ?? '') && hostLine(row.host).includes(' ready '), admin('hosts', 'list').out)

  step(`${slug}: the ready mail opens the drive through the console (SSO; no setup token)`)
  const ready = outbox().filter((m) => m.to === buyer && m.subject.startsWith('Your Trina Drive is ready')).at(-1)
  check('ready mail sent to the buyer', !!ready)
  check('no setup token in it (review finding 6)', !!ready && !/#token=/.test(ready.text), ready?.text)
  check(`it links ${CONTROL}/open/${slug}`, !!ready && ready.text.includes(`${CONTROL}/open/${slug}`), ready?.text)
  check('team serves its web app over HTTPS', (await req('GET', `${teamUrl(slug)}/`)).status === 200)
  const gone = await req('POST', `${teamUrl(slug)}/api/setup`, { body: { setup_token: 'tdrive_setup_wrongwrongwrongwrongwrong1', name: 'mallory', email: 'm@x.test', password: 'another-password' } })
  check('/api/setup is gone (404) under TDRIVE_SSO_ONLY', gone.status === 404, gone.text)
  const c = new Console(HTTP)
  const cl = await c.login({ email: buyer, password: pw })
  check('the owner signs in to the console', cl.status === 200, cl.text)
  const before2fa = await c.openDrive(slug)
  check('Open drive before the owner has a console authenticator: no assertion (set it up first, finding 3)', !before2fa.drive && !before2fa.assertion, before2fa.hops)
  const ce = await c.enrollTotp()
  check('console authenticator enrolled (owners must)', !!ce.secret, ce.res.text)
  const first = await c.openDrive(slug)
  check('Open drive: form_post → the owner is signed in to the drive', !!first.drive, { error: first.error, hops: first.hops })
  const adminCsrf = first.drive?.csrf ?? ''
  const sessCookie = c.jar.seen.filter((x) => /tdrive_session=/.test(x)).at(-1) ?? ''
  const adminCookie = sessCookie.split(';')[0] ?? ''
  check('admin session cookie is Secure (seen as https behind Caddy)', /Secure/.test(sessCookie), sessCookie.replace(/=[^;]+/, '=…'))
  const me = first.drive ? (await first.drive.session()).me : {}
  check('…as a drive admin (role owner → admin)', me.admin === true, me)
  const asAdmin = { cookie: adminCookie, headers: { 'x-csrf-token': adminCsrf } }

  step(`${slug}: hosted mode — the admin enrols an authenticator app before anything else`)
  const early = await req('POST', `${teamUrl(slug)}/api/tokens`, { ...asAdmin, body: { name: 'too-early', ttl: '1d' } })
  check('no token before a second factor (403 second_factor_required)', early.status === 403 && early.text.includes('second_factor_required'), early.text)
  const ts = await req('POST', `${teamUrl(slug)}/api/me/totp/setup`, { ...asAdmin, body: {} })
  const secret = ts.status === 200 ? String(ts.json().secret ?? '') : ''
  check('authenticator app: secret issued', /^[A-Z2-7]{16,}=*$/.test(secret), ts.text)
  // for signing in by hand afterwards: add this to an authenticator app (dev only; .state is removed by down.sh)
  if (secret) fs.writeFileSync(path.join(STATE, `admin-${slug}.otpauth`), `${ts.json().uri}\n`, { mode: 0o600 })
  const conf = await req('POST', `${teamUrl(slug)}/api/me/totp/confirm`, { ...asAdmin, body: { code: totp(secret) } })
  check('enrolled with a code computed by this test (RFC 6238); recovery codes issued', conf.status === 200 && (conf.json().recovery_codes?.length ?? 0) > 0, conf.text)
  const reopen = await c.openDrive(slug)
  check('opening the drive again asks for the drive\'s second factor (#/sso-second/<ticket>)', !!reopen.secondFactor && !reopen.drive, reopen.landing)
  const l2 = await req('POST', `${teamUrl(slug)}/api/login/second`, { body: { ticket: reopen.secondFactor, method: 'totp', code: totp(secret, Date.now() + 30_000) } })
  check('the next code completes the sign-in', l2.status === 200 && /tdrive_session=/.test(cookieOf(l2)), l2.text)
  const pat = await req('POST', `${teamUrl(slug)}/api/tokens`, { ...asAdmin, body: { name: 'e2e', ttl: '1d' } })
  check('admin creates a personal access token on the web', pat.status === 200, pat.text)
  const adminPat = pat.json().token as string

  step(`${slug}: the drive's mail through the host's mail relay; dana joins through the console`)
  // the notice mail goes out after the sign-in answered: give the relay a moment
  await until(() => teamMail().some((m) => m.to === buyer && /became an admin/.test(m.subject)), 20_000)
  const mail = teamMail().find((m) => m.to === buyer && /became an admin/.test(m.subject))
  check('"someone became an admin" arrived in the dev mail sink (team SES mailer → relay on the team gateway)', !!mail, teamMail().slice(-5))
  check('sent with the configured team From', mail?.from === env.TDCLOUD_TEAM_MAIL_FROM, mail?.from)
  check('it names no one and no file (R11): a link to sign in', !!mail && mail.text.includes(teamUrl(slug)), mail?.text)
  const teamId = await c.teamId(slug)
  const dana = `dana@${slug}.test`, danaPw = `dana-${slug}-password`
  const inv = await c.invite(teamId, [dana])
  check('the owner invites dana in the console', inv.status === 201, inv.text)
  const invToken = c.inviteToken(dana)
  check('the invite mail is in the outbox with its link', !!invToken)
  const d = new Console(HTTP)
  await d.signupConfirmed(dana, danaPw)
  await d.login({ email: dana, password: danaPw })
  const acc = await d.accept(invToken)
  check('dana accepts with her own confirmed account', acc.status === 200, acc.text)
  check('the invite works only once', (await d.accept(invToken)).status >= 400)
  const dr = await d.openDrive(slug)
  const dme = dr.drive ? (await dr.drive.session()).me : {}
  check('dana opens the drive: a member, not an admin', !!dr.drive && dme.admin === false, { error: dr.error, me: dme })
  const pw2 = await req('POST', `${teamUrl(slug)}/api/login`, { body: { login: dana, password: danaPw } })
  check('a console person has no drive password (409 use_sso)', pw2.status === 409 && pw2.text.includes('use_sso'), pw2.text)

  step(`${slug}: MCP over HTTPS`)
  const init = await mcp(slug, adminPat, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'tdcloud-e2e', version: '1' } })
  check('initialize', init.status === 200 && init.text.includes('"serverInfo"'), init.text)
  check('tools/list has bash', (await mcp(slug, adminPat, 'tools/list')).text.includes('"name":"bash"'))
  const prm = await req('GET', `${teamUrl(slug)}/.well-known/oauth-protected-resource/mcp`)
  check('OAuth protected-resource metadata names this team (claude.ai / ChatGPT connectors)', prm.status === 200 && prm.json().resource === `${teamUrl(slug)}/mcp`, prm.text)
  const asm = await req('GET', `${teamUrl(slug)}/.well-known/oauth-authorization-server`)
  check('OAuth authorization server metadata, issuer = team URL', asm.status === 200 && asm.json().issuer === teamUrl(slug), asm.text)
  const noAuth = await req('POST', `${teamUrl(slug)}/mcp`, { origin: false, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })
  check('MCP without a token: 401 pointing at the OAuth metadata', noAuth.status === 401 && (noAuth.headers.get('www-authenticate') ?? '').includes('resource_metadata'), noAuth.headers.get('www-authenticate'))

  step(`${slug}: kim and boss (operator seeds two folders through the admin CLI)`)
  const seed = sh(['docker', 'exec', `tdc-${slug}`, 'sh', '-c',
    `mkdir -p /data/shares/${slug}/경영 /data/shares/${slug}/프로젝트 && echo "${slug} 매출 1,234" > /data/shares/${slug}/경영/board.md && echo "${slug} plan" > /data/shares/${slug}/프로젝트/plan.md`])
  check('files placed', seed.code === 0, seed.err)
  for (const a of [['person', 'add', 'kim'], ['person', 'add', 'boss'], ['group', 'add', '전체'], ['group', 'add', '경영'], ['group', 'member', '전체', 'kim'], ['group', 'member', '전체', 'boss'],
    ['group', 'member', '경영', 'boss'], ['folder', 'register', `/data/shares/${slug}/경영`, '--nas-readers', 'boss'], ['folder', 'register', `/data/shares/${slug}/프로젝트`, '--nas-readers', 'all'],
    ['rule', 'set', `/data/shares/${slug}/경영`, '@경영', 'read'], ['rule', 'set', `/data/shares/${slug}/프로젝트`, '@전체', 'read']]) {
    const r = tdrive(slug, ...a)
    if (r.code !== 0) check(`tdrive ${a.join(' ')}`, false, r.err)
  }
  const kim = tdrive(slug, 'token', 'create', 'kim', '--name', 'kim-laptop').out.trim()
  const boss = tdrive(slug, 'token', 'create', 'boss', '--name', 'boss-laptop').out.trim()
  check('tokens for kim and boss', kim.startsWith('tdrive_pat_') && boss.startsWith('tdrive_pat_'), { kim, boss })
  const kimLs = await bash(slug, kim, 'ls /')
  check('kim: ls / shows 프로젝트, not 경영', kimLs.stdout.includes('프로젝트') && !kimLs.stdout.includes('경영'), kimLs.raw)
  const kimCat = await bash(slug, kim, `cat /경영/board.md; grep -r 매출 / ; echo end`)
  check('kim: 경영 does not exist for her AI, grep finds nothing', !kimCat.stdout.includes('1,234') && /No such file/.test(kimCat.stderr), kimCat.raw)
  const bossCat = await bash(slug, boss, 'cat /경영/board.md')
  check('boss: reads 경영/board.md', bossCat.stdout.includes(`${slug} 매출 1,234`), bossCat.raw)
  return { slug, buyer, id: team.id, adminPat, adminCookie, kim, boss }
}

/** What the team records as the client's address, and the relay's sender check (acme). */
async function clientAddresses(a: Team) {
  step('acme: fixed addresses, client addresses behind Caddy, the mail relay')
  const netName = 'tdc-net-acme'
  const inst = JSON.parse(sh(['docker', 'inspect', 'tdc-acme']).out)[0]
  const net = JSON.parse(sh(['docker', 'network', 'inspect', netName]).out)[0]
  const { Subnet: subnet, Gateway: gateway } = net.IPAM.Config[0] as { Subnet: string; Gateway: string }
  const caddyIp = net.Labels['tdcloud.caddy-ip'] as string
  const caddyNow = JSON.parse(sh(['docker', 'inspect', 'tdc-caddy']).out)[0].NetworkSettings.Networks[netName]?.IPAddress
  const teamIp = inst.NetworkSettings.Networks[netName]?.IPAddress
  const base = subnet.split('/')[0]!.split('.').map(Number)
  const at = (k: number) => [...base.slice(0, 3), base[3]! + k].join('.')
  check('the team network is a fixed /28: gateway .1, Caddy .2, the team .3', subnet.endsWith('/28') && gateway === at(1) && caddyIp === at(2) && caddyNow === caddyIp && teamIp === at(3), { subnet, gateway, caddyIp, caddyNow, teamIp })
  const envs = inst.Config.Env as string[]
  for (const e of ['TDRIVE_HOSTED=1', `TDRIVE_TRUSTED_PROXY=${caddyIp}/32`, 'TDRIVE_STORAGE=managed', 'TDRIVE_STORAGE_QUOTA=100GB', 'TDRIVE_MAILER=ses', `TDRIVE_SES_ENDPOINT=http://${gateway}:${RELAY_PORT}`, `TDRIVE_MAIL_FROM=${env.TDCLOUD_TEAM_MAIL_FROM}`]) {
    check(`team env: ${e}`, envs.includes(e))
  }
  const storage = tdrive('acme', 'storage', 'show')
  check('the product runs managed storage with the Team plan\'s 100 GB quota', /managed/.test(storage.out) && /quota: (100(\.0)? ?GB|102400(\.0)? MB|107374182400)\b/.test(storage.out), storage.out + storage.err)

  // the same token from outside (two different forged X-Forwarded-For) and from a second real address
  const xtok = tdrive('acme', 'token', 'create', 'kim', '--name', 'xff-test').out.trim()
  const spoofs = ['203.0.113.7', '198.51.100.23', '192.0.2.99']
  const init = (n: string) => ({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: n, version: '1' } } })
  // a wrong invite link: answered 404 after the per-address link limiter counted it (SSO mode has no /api/setup)
  const badLink = { kind: 'invite', token: 'wrongwrongwrongwrongwrongwrongwrong1', password: 'some-password-1' }
  for (const [i, spoof] of spoofs.slice(0, 2).entries()) {
    const r = await req('POST', `${teamUrl('acme')}/mcp`, { origin: false, headers: { authorization: `Bearer ${xtok}`, accept: 'application/json, text/event-stream', 'x-forwarded-for': spoof }, body: init(`xff-outside-${i}`) })
    const s = await req('POST', `${teamUrl('acme')}/api/links/accept`, { headers: { 'x-forwarded-for': spoof }, body: badLink })
    if (r.status !== 200 || s.status !== 404) check(`outside request ${i}`, false, `${r.status} ${s.status} ${s.text}`)
  }
  // a second client: a container on the Docker network in front of Caddy, at 10.250.250.50, also forging the header
  const script = `const https = require('node:https');
const post = (path, body, headers) => new Promise((res, rej) => { const q = https.request({ host: '10.250.250.10', port: 443, servername: process.env.H, ca: process.env.CA, method: 'POST', path,
  headers: { host: process.env.H + ':' + process.env.P, origin: 'https://' + process.env.H + ':' + process.env.P, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-forwarded-for': '${spoofs[2]}', ...headers } },
  (s) => { let d = ''; s.on('data', (c) => d += c); s.on('end', () => res(s.statusCode)) }); q.on('error', rej); q.end(JSON.stringify(body)) });
(async () => { console.log(await post('/mcp', ${JSON.stringify(init('xff-inside'))}, { authorization: 'Bearer ' + process.env.T }), await post('/api/links/accept', ${JSON.stringify(badLink)}, {})) })().catch((e) => { console.log('error', e.message); process.exit(1) })`
  const inside = sh(['docker', 'run', '--rm', '--network', 'tdc-control', '--ip', '10.250.250.50', '-e', `CA=${CA}`, '-e', `T=${xtok}`, '-e', `H=acme.${DOMAIN}`, '-e', `P=${PORT}`,
    '--entrypoint', 'bun', 'tdcloud-control:dev', '-e', script])
  check('a client at 10.250.250.50 reaches acme through Caddy', inside.out.trim() === '200 404', inside.out + inside.err)

  const conns = tdrive('acme', 'connections', 'list').out.split('\n').map((l) => l.split('\t')).filter((c) => / xff-test$/.test(c[0] ?? ''))
  const ips = [...new Set(conns.map((c) => c[3]!))]
  const outsideIp = ips.find((ip) => ip !== '10.250.250.50') ?? ''
  check('the team records two client addresses for the token: this machine and 10.250.250.50', ips.length === 2 && ips.includes('10.250.250.50') && !!outsideIp, conns)
  check(`forged X-Forwarded-For is not believed: Caddy replaced it (recorded ${outsideIp})`, !spoofs.includes(outsideIp) && !ips.some((ip) => spoofs.includes(ip)))
  check(`the recorded address is the client's, not Caddy's (${caddyIp})`, !ips.includes(caddyIp) && !ips.includes(gateway))
  const rows = JSON.parse(sh(['docker', 'exec', 'tdc-acme', '/usr/local/bin/bun', '-e',
    `const { Database } = require('bun:sqlite'); console.log(JSON.stringify(new Database('/data/db/store.db').query("SELECT key_hash, n FROM rate_limits WHERE scope = 'link_addr'").all()))`]).out || '[]') as { key_hash: string; n: number }[]
  const hits = (ip: string) => rows.find((r) => r.key_hash === sha256(`link:${ip}`))?.n ?? 0
  check('link rate-limit keys are client addresses: this machine (all its tries in one bucket) and 10.250.250.50 (one)', hits(outsideIp) >= 2 && hits('10.250.250.50') === 1, { outside: hits(outsideIp), inside: hits('10.250.250.50') })
  check("…and never a forged address or Caddy's", [...spoofs, caddyIp].every((ip) => hits(ip) === 0), [...spoofs, caddyIp].map(hits))

  // the relay takes mail only from a team container, only with the team From
  const ses = (from: string) => JSON.stringify({ FromEmailAddress: from, Destination: { ToAddresses: ['x@example.test'] }, Content: { Simple: { Subject: { Data: 'hi' }, Body: { Text: { Data: 'x' } } } } })
  const relayUrl = `http://${gateway}:${RELAY_PORT}/v2/email/outbound-emails`
  const fromTeam = (from: string) => sh(['docker', 'exec', 'tdc-acme', '/usr/local/bin/bun', '-e', `fetch(${JSON.stringify(relayUrl)}, { method: 'POST', body: ${JSON.stringify(ses(from))} }).then((r) => console.log(r.status), (e) => console.log(e.message))`]).out.trim()
  check('relay: another From is refused (400)', fromTeam('Someone <ceo@bank.example>') === '400')
  const viaCaddy = sh(['docker', 'exec', 'tdc-caddy', 'wget', '-q', '-O-', '--post-data', ses(env.TDCLOUD_TEAM_MAIL_FROM!), relayUrl])
  check('relay: Caddy (not a team container) is refused (403)', viaCaddy.code !== 0 && /403/.test(viaCaddy.err), viaCaddy.err)
  void a
}

const showTeam = (slug: string) => { const r = admin('teams', 'show', slug); return (r.code === 0 ? JSON.parse(r.out) : {}) as { host?: string; status?: string; waiting_since?: number | null } }
/** the `hosts list --all` line of one host ('' when not listed) */
const hostLine = (id: string | undefined) => (id ? admin('hosts', 'list', '--all').out.split('\n').find((l) => l.startsWith(`${id} `)) ?? '' : '')
async function until(what: () => boolean, ms: number) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (what()) return true; await Bun.sleep(1500) }
  return what()
}

/** Scale-out to the limit, a team waiting at it, scale-in of an emptied host (compose.yml: one slot per host, at most
 * three hosts, simulated boot 3 s, empty hosts go after 20 s). */
async function autoscale() {
  step('hosts: the last host, the limit, scale-in')
  const acmeHost = showTeam('acme').host, globexHost = showTeam('globex').host
  check('acme and globex are on two different hosts (one slot each)', !!acmeHost && !!globexHost && acmeHost !== globexHost, { acmeHost, globexHost })
  check('hosts list shows both ready, 1/1 slots, none free', [acmeHost, globexHost].every((h) => / ready +1\/1 +0 /.test(hostLine(h))), admin('hosts', 'list').out)
  check('suspend globex (its host still holds its data)', admin('teams', 'suspend', 'globex').code === 0)
  const zeta = admin('teams', 'create', 'zeta', '--owner', 'ops-zeta@trina.test', '--name', 'Zeta')
  const zetaHost = showTeam('zeta').host
  check(`a third team: a third host is launched for it (${zetaHost})`, zeta.code === 0 && !!zetaHost && ![acmeHost, globexHost].includes(zetaHost), zeta.out + zeta.err)
  const desired = () => JSON.parse(fs.readFileSync(path.join(STATE, 'local-pool.json'), 'utf8')).desired as number
  check('the pool runs 3 hosts (the limit)', desired() === 3)

  // a fourth team: no room and no more hosts — it waits, and ops hear about it
  sh(['docker', 'exec', '-d', 'tdc-control', 'bun', '/app/src/main.ts', 'teams', 'create', 'omega', '--owner', 'ops-omega@trina.test', '--name', 'Omega'])
  await until(() => !!showTeam('omega').waiting_since, 30_000)
  const omega = showTeam('omega')
  check('omega waits in provisioning without a host', omega.status === 'provisioning' && !omega.host && !!omega.waiting_since, omega)
  check('ops are alerted: host limit reached', await until(() => outbox().some((m) => m.to === 'ops@trina.test' && m.subject.includes('host limit reached') && m.text.includes('omega')), 30_000))
  check("no setup mail to omega's owner while it waits", !outbox().some((m) => m.to === 'ops-omega@trina.test'))
  check('still 3 hosts', desired() === 3)

  // zeta goes: its host is not scaled in while omega waits — omega takes it
  check('delete zeta', admin('teams', 'delete', 'zeta', '--yes').code === 0)
  check('omega starts on the host zeta left', await until(() => showTeam('omega').status === 'active', 90_000) && showTeam('omega').host === zetaHost, showTeam('omega'))
  check("omega's owner gets the ready mail once it runs", outbox().some((m) => m.to === 'ops-omega@trina.test' && m.subject.startsWith('Your Trina Drive is ready')))
  check('omega serves over HTTPS', (await req('GET', `${teamUrl('omega')}/api/state`)).status === 200)

  // omega goes too: the host is empty, and after the 20 s grace it is scaled in
  check('delete omega', admin('teams', 'delete', 'omega', '--yes').code === 0)
  check(`${zetaHost} is empty`, await until(() => / ready +0\/1 +1 +\d{4}-/.test(hostLine(zetaHost)), 15_000), hostLine(zetaHost))
  check(`${zetaHost} is scaled in after the grace period`, await until(() => / gone /.test(hostLine(zetaHost)), 90_000), admin('hosts', 'list', '--all').out)
  check('the pool is down to 2 hosts', desired() === 2)
  check("acme's host and suspended globex's host are untouched", [acmeHost, globexHost].every((h) => / ready +1\/1 /.test(hostLine(h))), admin('hosts', 'list').out)
  check('resume globex', admin('teams', 'resume', 'globex').code === 0)
  check('globex serves again', (await bash('globex', globexBoss, 'cat /경영/board.md')).stdout.includes('globex 매출'))
  const log = admin('audit', 'list', '--limit', '400').out
  for (const action of ['team.waiting_for_host', 'hosts.scale_out', 'host.ready', 'team.host_assigned', 'hosts.scale_in', 'host.gone']) check(`audit has ${action}`, log.includes(action))
  check('control-plane audit chain verifies', admin('audit', 'verify').code === 0)
}
let globexBoss = ''

async function freePlan() {
  step('Free plan: sign-up without Paddle')
  check('the /free page', (await req('GET', `${CONTROL}/free`)).text.includes('action="/free"'))
  const disp = await req('POST', `${CONTROL}/api/free/signup`, { body: { email: 'x@mailinator.com', name: 'Spam' } })
  check('a disposable address is refused', disp.status === 400 && disp.text.includes('disposable_email'), disp.text)
  const owner = 'founder@freeco.test'
  const su = await req('POST', `${CONTROL}/api/free/signup`, { body: { email: owner, name: 'Free Co', slug: 'freeco' } })
  check('free sign-up: email + team name', su.status === 200, su.text)
  const link = outbox().filter((m) => m.to === owner && /\/free\/verify\?token=/.test(m.text)).at(-1)?.text.match(/\/free\/verify\?token=(\S+)/)?.[1]
  check('confirmation link in the outbox', !!link)
  const v = await req('POST', `${CONTROL}/api/free/verify`, { body: { token: link } })
  check('confirmed: the free team is starting', v.status === 200 && v.json().status === 'provisioning' && v.json().url === teamUrl('freeco'), v.text)
  check('the link works once', (await req('POST', `${CONTROL}/api/free/verify`, { body: { token: link } })).status === 404)
  const again = await req('POST', `${CONTROL}/api/free/signup`, { body: { email: 'Founder+2@freeco.test', name: 'Again' } })
  check('the same mailbox again: a reminder of its team, no second link', again.status === 200 && outbox().filter((m) => m.to === 'founder+2@freeco.test').at(-1)?.subject === 'You already have a free Trina Drive')
  check('freeco runs (a host launched for it)', await until(() => showTeam('freeco').status === 'active', 240_000), admin('hosts', 'list').out)
  const row = showTeam('freeco') as { host?: string; plan?: string; public_id?: string }
  check(`freeco is a free team on ${row.host}, a quarter of its slot`, row.plan === 'free' && / ready +0\.25\/1 /.test(hostLine(row.host)), hostLine(row.host))
  const i = JSON.parse(sh(['docker', 'inspect', 'tdc-freeco']).out)[0]
  const envs = i.Config.Env as string[]
  check('free limits: 0.5 vCPU, 768 MiB, 256 processes', i.HostConfig.NanoCpus === 5e8 && i.HostConfig.Memory === 768 * 1024 * 1024 && i.HostConfig.PidsLimit === 256, { cpu: i.HostConfig.NanoCpus, mem: i.HostConfig.Memory, pids: i.HostConfig.PidsLimit })
  check('free env: 1 GB storage quota, at most 3 people', envs.includes('TDRIVE_STORAGE_QUOTA=1GB') && envs.includes('TDRIVE_MAX_PEOPLE=3'))
  const ready = outbox().filter((m) => m.to === owner && m.subject.startsWith('Your Trina Drive is ready')).at(-1)
  check('ready mail without a setup token, the free plan explained', !!ready && !/#token=/.test(ready.text) && ready.text.includes('Free plan: 1 GB'), ready?.text)
  // the free owner has no password: an email link, the console authenticator (owners must), then Open drive
  const fc = new Console(HTTP)
  await fc.api('POST', '/api/login/link', { email: owner })
  const flt = outbox().filter((m) => m.to === owner && /login\/link\?token=/.test(m.text)).at(-1)?.text.match(/login\/link\?token=(\S+)/)?.[1]
  const flc = await fc.api('POST', '/api/login/link/confirm', { token: flt })
  fc.csrf = flc.status === 200 ? flc.json().csrf ?? '' : ''
  const fce = await fc.enrollTotp()
  check('the free owner signs in with a link and sets up the console authenticator', flc.status === 200 && !!fce.secret, flc.text + fce.res.text)
  const fo = await fc.openDrive('freeco')
  check('Open drive: the free owner is the drive admin', !!fo.drive && (await fo.drive.session()).me.admin === true, { error: fo.error, hops: fo.hops })
  const adminCookie = (fc.jar.seen.filter((x) => /tdrive_session=/.test(x)).at(-1) ?? '').split(';')[0] ?? ''
  const ownerName = fo.drive ? (await fo.drive.session()).me.name as string : 'founder'
  sh(['docker', 'exec', 'tdc-freeco', 'sh', '-c', 'mkdir -p /data/keep && echo "freeco keeps this" > /data/keep/note.md'])
  check('two more people fit', tdrive('freeco', 'person', 'add', 'pat').code === 0 && tdrive('freeco', 'person', 'add', 'sam').code === 0)
  const fourth = tdrive('freeco', 'person', 'add', 'kai')
  check('a fourth person is refused (TDRIVE_MAX_PEOPLE=3)', fourth.code !== 0 && /at most 3 people/.test(fourth.err + fourth.out), fourth.err + fourth.out)
  // a personal token for MCP later (made by the operator CLI: not activity)
  const freePat = tdrive('freeco', 'token', 'create', ownerName, '--name', 'free-e2e').out.trim()
  const act = tdrive('freeco', 'activity', '--json')
  check('the team reports its last activity (the owner\'s session)', act.code === 0 && typeof JSON.parse(act.out).web === 'number', act.out + act.err)

  step('Free plan: the cap and the waitlist')
  await req('POST', `${CONTROL}/api/free/signup`, { body: { email: 'second@otherco.test', name: 'Other Co' } })
  const l2 = outbox().filter((m) => m.to === 'second@otherco.test').at(-1)?.text.match(/\/free\/verify\?token=(\S+)/)?.[1]
  const w = await req('POST', `${CONTROL}/api/free/verify`, { body: { token: l2 } })
  check('a second free team past TDCLOUD_MAX_FREE_TEAMS=1 waits', w.json().status === 'waitlisted', w.text)
  check('ops are told about the waitlist', outbox().some((m) => m.to === 'ops@trina.test' && m.subject.includes('free waitlist: second@otherco.test')))
  check('free waitlist lists it', admin('free', 'waitlist').out.includes('second@otherco.test'))

  step('Free plan: the owner signs in with an email link')
  await req('POST', `${CONTROL}/api/login/link`, { body: { email: owner } })
  const lt = outbox().filter((m) => m.to === owner && /login\/link\?token=/.test(m.text)).at(-1)?.text.match(/login\/link\?token=(\S+)/)?.[1]
  let lc = await req('POST', `${CONTROL}/api/login/link/confirm`, { body: { token: lt } })
  // the owner has a console authenticator now: the link is the first step, the code the second
  if (lc.status === 200 && lc.json().totp_required) lc = await req('POST', `${CONTROL}/api/login/totp`, { body: { ticket: lc.json().ticket, code: await freshTotp(fc.creds?.totp ?? '') } })
  check('signed in with the link (and the authenticator code)', lc.status === 200 && /^(__Host-)?tdcloud_session=/.test(cookieOf(lc)), lc.text)
  const ownerCookie = cookieOf(lc)
  const mine = (await req('GET', `${CONTROL}/api/teams`, { cookie: ownerCookie })).json().teams as { id: string; slug: string; plan: string; paused?: boolean }[]
  const ft = mine.find((x) => x.slug === 'freeco')
  check('the dashboard API shows the free team', ft?.plan === 'free' && ft.paused === false, mine)

  step('Free plan: nobody uses it → warned → paused')
  check('the owner is warned (25 s idle here; 6 days in production)', await until(() => outbox().some((m) => m.to === owner && m.subject.startsWith('Your free Trina Drive pauses')), 90_000))
  check('paused (45 s idle here; 7 days in production)', await until(() => /^freeco +paused +free /m.test(admin('teams', 'list').out), 90_000), admin('teams', 'list').out)
  check('the owner is told it is paused', outbox().some((m) => m.to === owner && m.subject === 'Your free Trina Drive is paused'))
  check('its container is stopped, not removed', sh(['docker', 'inspect', '-f', '{{.State.Running}}', 'tdc-freeco']).out.trim() === 'false')
  const pp = await req('GET', `${teamUrl('freeco')}/`)
  check('the team address shows the paused page with Wake up', pp.text.includes('unavailable') && pp.text.includes('wake-link') && pp.text.includes("'/wake/'"), pp.status)
  check(`its host still counts it (${row.host})`, / ready +0\.25\/1 /.test(hostLine(row.host)), hostLine(row.host))

  step('Free plan: Wake up')
  check('the wake page offers the button', (await req('GET', `${CONTROL}/wake/freeco`)).text.includes('Wake up'))
  const t0 = Date.now()
  const wk = await req('POST', `${CONTROL}/wake/freeco`, { raw: '' , headers: { 'content-type': 'application/x-www-form-urlencoded' } })
  check('Wake up: the page polls until it runs', wk.status === 200 && wk.text.includes('/static/wake.js'), wk.text.slice(0, 300))
  const woke = await until(() => { const r = sh(['curl', '-s', '--cacert', path.join(STATE, 'caddy-root.crt'), '--resolve', `${DOMAIN}:${PORT}:127.0.0.1`, `${CONTROL}/api/wake/freeco`]); return r.out.includes('"running"') }, 60_000)
  check(`running again in ${Math.round((Date.now() - t0) / 1000)} s`, woke)
  check('the admin session from before the pause still works', (await req('GET', `${teamUrl('freeco')}/api/session`, { cookie: adminCookie })).status === 200)
  // the web session's last_seen_at moves at most once a minute; an MCP call always marks its token used
  const used = await mcp('freeco', freePat, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'free-e2e', version: '1' } })
  check('an MCP call on the woken team', used.status === 200, used.text)
  check('used again (MCP): the team is a normal running free team (no re-pause pending)', await until(() => { const r = showTeam('freeco') as { woke_at?: number | null; paused_at?: number | null; status?: string }; return r.status === 'active' && r.woke_at == null && r.paused_at == null }, 30_000), showTeam('freeco'))

  step('Free plan: upgrade to Team with Paddle (same team, data, address)')
  const ev = { event_id: `evt_dev_freeco_${Date.now()}`, event_type: 'subscription.created', occurred_at: new Date().toISOString(), notification_id: 'ntf_freeco',
    data: { id: 'sub_dev_freeco', status: 'active', customer_id: 'ctm_dev_freeco', currency_code: 'USD', items: [{ price: { id: 'pri_dev_team_monthly' }, quantity: 1 }], custom_data: { tdcloud_team: ft?.id } } }
  const raw = JSON.stringify(ev)
  const wh = await req('POST', `${CONTROL}/paddle/webhook`, { raw, origin: false, headers: { 'content-type': 'application/json', 'paddle-signature': paddleHeader(env.PADDLE_WEBHOOK_SECRET!, raw) } })
  check('signed subscription.created for the free team accepted', wh.status === 200, wh.text)
  const upgraded = await until(() => { const x = JSON.parse(sh(['docker', 'inspect', 'tdc-freeco']).out || '[{}]')[0]; return x?.HostConfig?.Memory === 2048 * 1024 * 1024 && x.State?.Running }, 90_000)
  check('the container is made again with the Team limits (2 GiB)', upgraded)
  const after = showTeam('freeco') as { plan?: string; host?: string; public_id?: string; status?: string }
  check('the same team: plan team, same host and id', after.plan === 'team' && after.host === row.host && after.public_id === row.public_id && after.status === 'active', after)
  const envAfter = JSON.parse(sh(['docker', 'inspect', 'tdc-freeco']).out)[0].Config.Env as string[]
  check('Team env: 100 GB, no people limit', envAfter.includes('TDRIVE_STORAGE_QUOTA=100GB') && !envAfter.some((e) => e.startsWith('TDRIVE_MAX_PEOPLE=')))
  check('the data survived (a file, the people)', sh(['docker', 'exec', 'tdc-freeco', 'cat', '/data/keep/note.md']).out.includes('freeco keeps this') && tdrive('freeco', 'person', 'add', 'kai').code === 0)
  check('the same address serves it, the admin session still works', (await req('GET', `${teamUrl('freeco')}/api/session`, { cookie: adminCookie })).status === 200)
  check(`its host now shows a full slot (${row.host})`, / ready +1\/1 /.test(hostLine(row.host)), hostLine(row.host))
  const stats = admin('free', 'stats')
  check('free stats', stats.code === 0 && /free teams +0 of 1/.test(stats.out) && /1 upgraded/.test(stats.out) && /1 on the waitlist/.test(stats.out), stats.out + stats.err)
  const log = admin('audit', 'list', '--limit', '400').out
  for (const action of ['free.signup', 'free.waitlisted', 'free.idle_warned', 'free.paused', 'free.wake_requested', 'free.woke', 'free.active_again', 'free.upgraded']) check(`audit has ${action}`, log.includes(action))
  check('control-plane audit chain verifies', admin('audit', 'verify').code === 0)
}

async function tlsOk(slug: string): Promise<boolean> {
  try { await fetch(`${teamUrl(slug)}/`, { tls: { ca: CA }, signal: AbortSignal.timeout(10_000) } as RequestInit); return true } catch { return false }
}

async function main() {
  step('hosts: none before the first team (hold mode)')
  check('no hosts, pool at 0', /\(no hosts\)/.test(admin('hosts', 'list').out) && /desired 0/.test(admin('hosts', 'list').out), admin('hosts', 'list').out)
  const a = await buyAndSetUp('acme', 'Acme Inc.', 'buyer@acme.test')
  const b = await buyAndSetUp('globex', 'Globex Corp.', 'owner@globex.test')
  globexBoss = b.boss

  step('isolation between acme and globex')
  for (const [who, tok, from, to] of [['kim@acme', a.kim, a, b], ['boss@acme', a.boss, a, b], ['admin@acme', a.adminPat, a, b], ['boss@globex', b.boss, b, a], ['admin@globex', b.adminPat, b, a]] as const) {
    const r = await bash(to.slug, tok, 'ls /')
    check(`${who}'s token on ${to.slug}'s /mcp → 401`, r.status === 401, r.raw)
    void from
  }
  const crossSession = await req('GET', `${teamUrl('globex')}/api/session`, { cookie: a.adminCookie })
  check("acme's admin session on globex → 401", crossSession.status === 401)
  const bossB = await bash('globex', b.boss, 'cat /경영/board.md; ls /')
  check("globex's boss sees only globex's files", bossB.stdout.includes('globex 매출') && !bossB.stdout.includes('acme'), bossB.raw)
  const net = sh(['docker', 'exec', 'tdc-acme', '/usr/local/bin/bun', '-e',
    "const t=async(u)=>{try{await fetch(u,{signal:AbortSignal.timeout(3000)});return 'reached'}catch(e){return 'blocked'}};console.log(await t('http://tdc-globex:8787/health'), await t('http://tdc-control:8790/healthz'))"])
  check('acme container cannot reach globex or the control plane over the network', net.out.trim() === 'blocked blocked', net.out + net.err)
  for (const slug of ['acme', 'globex']) {
    const i = JSON.parse(sh(['docker', 'inspect', `tdc-${slug}`]).out)[0]
    const hc = i.HostConfig
    const mounts = (i.Mounts as { Source: string; Destination: string }[]).map((m) => `${m.Source}:${m.Destination}`).join(' ')
    check(`${slug}: own uid ${i.Config.User}, read-only root, all capabilities dropped, no-new-privileges`, /^2\d{4}:2\d{4}$/.test(i.Config.User) && hc.ReadonlyRootfs && hc.CapDrop?.includes('ALL') && hc.SecurityOpt.includes('no-new-privileges:true'), { user: i.Config.User, ro: hc.ReadonlyRootfs, drop: hc.CapDrop })
    check(`${slug}: limits (cpu, memory, pids)`, hc.NanoCpus > 0 && hc.Memory > 0 && hc.PidsLimit > 0, { cpus: hc.NanoCpus, mem: hc.Memory, pids: hc.PidsLimit })
    check(`${slug}: no published ports, no Docker socket`, Object.keys(hc.PortBindings ?? {}).length === 0 && !mounts.includes('docker.sock'), { ports: hc.PortBindings, mounts })
    check(`${slug}: only its own network (+ nothing else)`, Object.keys(i.NetworkSettings.Networks).join(',') === `tdc-net-${slug}`, Object.keys(i.NetworkSettings.Networks))
    check(`${slug}: worker isolation bwrap`, sh(['docker', 'logs', `tdc-${slug}`]).out.includes('worker isolation: bwrap'))
  }
  const users = ['acme', 'globex'].map((s) => JSON.parse(sh(['docker', 'inspect', `tdc-${s}`]).out)[0].Config.User)
  check('the two teams run as different uids', users[0] !== users[1], users)

  await clientAddresses(a)

  step('Caddy')
  check('no certificate for a name that is not a team', !(await tlsOk('nope')))
  const hostSwap = await fetch(`${teamUrl('acme')}/api/state`, { headers: { host: `globex.${DOMAIN}:${PORT}` }, tls: { ca: CA } } as RequestInit).then((r) => r.status, () => 0)
  check('Host that does not match the TLS name is refused (strict SNI)', hostSwap !== 200, hostSwap)

  step('operator: suspend, resume, backup, export, audit')
  check('suspend globex', admin('teams', 'suspend', 'globex').code === 0)
  const paused = await req('GET', `${teamUrl('globex')}/`)
  check('suspended team shows the paused page', paused.text.includes('unavailable'), paused.status)
  check('suspended team: MCP is unavailable', (await bash('globex', b.boss, 'ls /')).status >= 500)
  check('resume globex', admin('teams', 'resume', 'globex').code === 0, admin('teams', 'list').out)
  check('resumed: boss reads again', (await bash('globex', b.boss, 'cat /경영/board.md')).stdout.includes('globex 매출'))
  const bk = admin('teams', 'backup', 'acme')
  check('backup acme (product archive + sealed files) to the target', bk.code === 0 && /product-db/.test(bk.out) && /files/.test(bk.out), bk.out + bk.err)
  const objs = bk.out.trim().split('\n').map((l) => l.split('\t')[2]!)
  const filesObj = path.join(STATE, 'backups', objs.find((o) => o.includes('/files-'))!)
  check('files backup is encrypted at rest (no plaintext from the volume)', fs.existsSync(filesObj) && !fs.readFileSync(filesObj).includes(Buffer.from('acme plan')))
  const exportDir = path.join(STATE, 'export-acme')
  const ex = admin('teams', 'export', 'acme', '--out', exportDir)
  check('export acme', ex.code === 0, ex.err)
  const tar = sh(['tar', '-tf', path.join(exportDir, 'files.tar')])
  check('export decrypts: files.tar has the team\'s files', tar.out.includes('shares/acme/경영/board.md'), tar.out.slice(0, 300))
  const up = admin('teams', 'upgrade', 'acme')
  check('upgrade acme (backup, new container on the same data)', up.code === 0, up.out + up.err)
  check('after the upgrade: the same data, the same tokens', (await bash('acme', a.boss, 'cat /경영/board.md')).stdout.includes('acme 매출'))
  const audit = admin('audit', 'verify')
  check('control-plane audit chain verifies', audit.code === 0 && audit.out.includes('audit chain ok'), audit.out)
  const log = admin('audit', 'list', '--limit', '200').out
  for (const action of ['user.signup', 'team.create', 'billing.subscription.created', 'team.provisioned', 'team.ready_mail_sent', 'team.suspend', 'team.resume', 'team.backup.manual', 'team.exported', 'team.upgrade']) check(`audit has ${action}`, log.includes(action))
  const afterUpgrade = JSON.parse(sh(['docker', 'inspect', 'tdc-acme']).out)[0]
  const acmeNet = JSON.parse(sh(['docker', 'network', 'inspect', 'tdc-net-acme']).out)[0].IPAM.Config[0].Subnet as string
  const [o1, o2, o3, o4] = acmeNet.split('/')[0]!.split('.').map(Number) as [number, number, number, number]
  check('after the upgrade: the same fixed address and env', afterUpgrade.NetworkSettings.Networks['tdc-net-acme']?.IPAddress === `${o1}.${o2}.${o3}.${o4 + 3}` && (afterUpgrade.Config.Env as string[]).includes('TDRIVE_HOSTED=1'), afterUpgrade.NetworkSettings.Networks)

  await autoscale()
  await freePlan()

  console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} checks passed, ${failed} failed (${Math.round((Date.now() - t0) / 1000)}s)`)
  console.log(`\n  acme    ${teamUrl('acme')}    admin alex / admin-acme-password`)
  console.log(`  globex  ${teamUrl('globex')}  admin alex / admin-globex-password`)
  console.log(`  second factor: add ${path.join(STATE, 'admin-<slug>.otpauth')} to an authenticator app`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
