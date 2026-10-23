#!/usr/bin/env bun
// End-to-end check of local Trina Cloud (started by cloud/dev/up.sh). Everything goes through the public HTTPS front
// (Caddy, self-signed CA) except operator steps, which use the admin CLI / docker exec like an operator would.
//
//  1. two buyers sign up, confirm their email (outbox), create teams acme and globex
//  2. a Paddle subscription.created (signed with the dev webhook secret) for each → provisioned
//  3. the emailed one-time setup link creates each team's admin; the link works once; the token is not in the control DB
//  4. each admin makes a personal access token on the web; MCP initialize / tools/list / bash work over HTTPS
//  5. kim/boss in each team: kim cannot see 경영, boss can
//  6. isolation: no token, session or network path from one team reaches the other; the containers' settings
//  7. Caddy: no certificate for unknown names; suspend → paused page → resume; backup + export decrypt; audit chain
import fs from 'node:fs'
import path from 'node:path'
import { paddleHeader } from '../control/src/paddle'

const DEV = import.meta.dir
const STATE = path.join(DEV, '.state')
const env = Object.fromEntries(fs.readFileSync(path.join(STATE, 'dev.env'), 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
const DOMAIN = env.TDCLOUD_DOMAIN!, PORT = env.TDCLOUD_PUBLIC_PORT!
const CONTROL = `https://${DOMAIN}:${PORT}`
const teamUrl = (slug: string) => `https://${slug}.${DOMAIN}:${PORT}`
const CA = fs.readFileSync(path.join(STATE, 'caddy-root.crt'), 'utf8')
const OUTBOX = path.join(STATE, 'outbox.log')

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
const outbox = () => (fs.existsSync(OUTBOX) ? fs.readFileSync(OUTBOX, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { to: string; subject: string; text: string }) : [])

function sh(argv: string[], input?: string): { code: number; out: string; err: string } {
  const p = Bun.spawnSync(argv, { stdin: input !== undefined ? new TextEncoder().encode(input) : 'ignore', stdout: 'pipe', stderr: 'pipe' })
  return { code: p.exitCode ?? -1, out: p.stdout.toString(), err: p.stderr.toString() }
}
const admin = (...args: string[]) => sh(['docker', 'exec', 'tdc-control', 'bun', '/app/src/main.ts', ...args])
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
  check('sign in', login.status === 200 && cookieOf(login).startsWith('tdcloud_session='))
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
  const until = Date.now() + 240_000
  while (Date.now() < until) {
    const r = await req('GET', `${CONTROL}/api/teams`, { cookie })
    status = (r.json().teams as { slug: string; status: string }[]).find((x) => x.slug === slug)?.status ?? ''
    if (status === 'active' || status === 'failed') break
    await Bun.sleep(2000)
  }
  check(`provisioned (status ${status})`, status === 'active', admin('jobs', 'list').out)

  step(`${slug}: one-time setup link from the mail`)
  const ready = outbox().filter((m) => m.to === buyer && m.subject.startsWith('Your Trina Drive is ready')).at(-1)
  check('setup mail sent to the buyer', !!ready)
  const link = ready!.text.match(/(https:\/\/\S+\/#\/setup\/(\S+))/)!
  const setupToken = link[2]!
  check(`link points at ${teamUrl(slug)}`, link[1]!.startsWith(`${teamUrl(slug)}/#/setup/`))
  const db = Buffer.concat(['control.db', 'control.db-wal'].map((f) => path.join(STATE, f)).filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f)))
  check('setup token is not in the control plane database', !db.includes(Buffer.from(setupToken)))
  check('team serves its web app over HTTPS', (await req('GET', `${teamUrl(slug)}/`)).status === 200)
  const st = await req('GET', `${teamUrl(slug)}/api/state`)
  check('setup pending', st.json().setup_pending === true, st.text)
  const adminPw = `admin-${slug}-password`
  const setup = await req('POST', `${teamUrl(slug)}/api/setup`, { body: { setup_token: setupToken, name: 'alex', email: buyer, password: adminPw } })
  check('setup with the mailed token creates the admin', setup.status === 200, setup.text)
  const adminCookie = cookieOf(setup), adminCsrf = setup.json().csrf
  check('admin session cookie is Secure (seen as https behind Caddy)', /Secure/.test(setup.headers.get('set-cookie') ?? ''))
  const reuse = await req('POST', `${teamUrl(slug)}/api/setup`, { body: { setup_token: setupToken, name: 'mallory', email: 'm@x.test', password: 'another-password' } })
  check('the setup link works only once', reuse.status === 403, reuse.text)
  const pat = await req('POST', `${teamUrl(slug)}/api/tokens`, { cookie: adminCookie, headers: { 'x-csrf-token': adminCsrf }, body: { name: 'e2e', ttl: '1d' } })
  check('admin creates a personal access token on the web', pat.status === 200, pat.text)
  const adminPat = pat.json().token as string

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

async function tlsOk(slug: string): Promise<boolean> {
  try { await fetch(`${teamUrl(slug)}/`, { tls: { ca: CA }, signal: AbortSignal.timeout(10_000) } as RequestInit); return true } catch { return false }
}

async function main() {
  const a = await buyAndSetUp('acme', 'Acme Inc.', 'buyer@acme.test')
  const b = await buyAndSetUp('globex', 'Globex Corp.', 'owner@globex.test')

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
  const audit = admin('audit', 'verify')
  check('control-plane audit chain verifies', audit.code === 0 && audit.out.includes('audit chain ok'), audit.out)
  const log = admin('audit', 'list', '--limit', '200').out
  for (const action of ['user.signup', 'team.create', 'billing.subscription.created', 'team.provisioned', 'team.setup_link_sent', 'team.suspend', 'team.resume', 'team.backup.manual', 'team.exported']) check(`audit has ${action}`, log.includes(action))

  console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} checks passed, ${failed} failed (${Math.round((Date.now() - t0) / 1000)}s)`)
  console.log(`\n  acme    ${teamUrl('acme')}    admin alex / admin-acme-password`)
  console.log(`  globex  ${teamUrl('globex')}  admin alex / admin-globex-password`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
