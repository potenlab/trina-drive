#!/usr/bin/env bun
// Trina Cloud control plane: `serve` (HTTP + job loop) and the admin CLI. Also the helper commands the hosts run in a
// throwaway container of this image (seal, seal-dir). Configuration: environment (src/config.ts, cloud/README.md).
import fs from 'node:fs'
import path from 'node:path'
import { audit as writeAudit, listAudit, verifyAudit } from './audit'
import { AwsClient, CredentialProvider } from './aws'
import { parseTarget } from './backup'
import { Cloud, CloudError } from './cloud'
import { loadConfig, type Config } from './config'
import { openDb, teamBySlug, updateTeam, type TeamRow } from './db'
import { AwsPool, awsDriver, SsmRunner } from './drivers/aws'
import { FakeDriver } from './drivers/fake'
import { LocalPool, LocalRunner, localDockerDriver } from './drivers/local'
import type { Driver, HostPool } from './drivers/types'
import { KmsKeyWrapper, LocalKeyWrapper, type KeyWrapper } from './keys'
import { mailerFor, type Mailer } from './mailer'
import { fmtSlots, planOf, SLOTS_SQL } from './plans'
import { MAX_BODY_BYTES, relayFromEnv } from './relay'
import { seal, unseal } from './seal'
import { iso } from './util'
import { makeHandler } from './web'
import { findCommand, registeredHelp } from './cli'

const HELP = `Trina Cloud control plane

  serve                                   HTTP (signup, dashboard, Paddle webhook, Caddy ask) + the job loop
  teams list [--free]                     plan, state (free teams: paused, last activity), host, disk, backup
  teams show <slug> | usage
  teams create <slug> --owner EMAIL [--name N] [--plan team|business|free] [--allow-reserved]
                                          a team without a Paddle subscription (dogfood, pilots): provisioned now
  teams suspend <slug> | resume <slug>    stop / start the instance (audited)
  teams backup <slug>                     a backup now (product archive + sealed files) to the backup target
  teams export <slug> --out DIR           backup, then download and decrypt it into DIR for the customer
  teams delete <slug> --yes               final backup, then remove the instance and its data (slug stays taken)
  teams resend-setup <slug>               a new one-time setup link to the owner (only before setup is done)
  teams upgrade <slug> | --all            backup, then a new container from TDCLOUD_IMAGE on the same data
  teams retry <slug>                      provision again after a failure
  teams link <slug> <subscription_id>     attach a Paddle subscription that arrived without custom_data
  teams set-plan <slug> team|business     (a free team upgrades through Paddle; there is no downgrade to free)
  free stats                              free teams by state, the cap, the waitlist, slots on hosts, next deletions, cost
  free waitlist                           confirmed sign-ups waiting for room (TDCLOUD_MAX_FREE_TEAMS)
  free admit <email|id> [--force]         give a waitlisted sign-up its team (--force: past the cap)
  free sweep                              one pass of the inactivity lifecycle now (the control plane runs it every minute)
  free wake <slug>                        start a paused free team (as the Wake up button does)
  hosts list [--all]                      team hosts: state, slots used/free, teams, empty since; the pool's size and limits
  hosts scale                             one scaler pass now (the running control plane makes one every minute,
                                          every few seconds while a team waits or a host boots)
  hosts keep <id> | unkeep <id>           never scale this host in / let the scaler handle it again
  hosts resume                            launch hosts again after repeated boot failures stopped scale-out
  jobs list | jobs run                    pending jobs | run the due ones once
  db snapshot <file>                      a consistent copy of the control database (the control host ships it to S3 nightly)
  audit verify | audit list [--team slug] [--limit N]
  mail-relay                              (on each team host) team instances' mail → Resend / SES (src/relay.ts)
  seal --recipient KEY [--out FILE]       (helper) encrypt stdin to a team backup key
  seal-dir --dir D --recipient KEY --out FILE [--exclude a,b]   (helper) tar a directory and seal it
  unseal --key-file FILE [--in FILE] [--out FILE]

Every admin command is recorded in the audit log as actor admin:$USER.`

export function buildCloud(cfg: Config, opts: { driver?: Driver; pool?: HostPool | null; mailer?: Mailer; keys?: KeyWrapper; log?: (s: string) => void } = {}): Cloud {
  const db = openDb(cfg.dbFile)
  const creds = new CredentialProvider()
  const aws = new AwsClient(cfg.aws.region, creds)
  const target = parseTarget(cfg.backupTarget, cfg.aws.region, creds)
  const keys = opts.keys ?? (cfg.kmsKeyId ? new KmsKeyWrapper(aws, cfg.kmsKeyId) : LocalKeyWrapper.fromFile(cfg.masterKeyFile ?? path.join(cfg.stateDir, 'master.key')))
  const mailer = opts.mailer ?? mailerFor(cfg, aws)
  let cloud: Cloud | null = null
  const driver = opts.driver ?? (cfg.driver === 'aws'
    ? awsDriver({
      aws, hostTag: cfg.aws.hostTag, ssmPrefix: cfg.aws.ssmPrefix, kmsKeyId: cfg.kmsKeyId,
      backupBucket: target.bucket ? `${target.bucket}${target.prefix ? `/${target.prefix}` : ''}` : null,
      caddyContainer: cfg.caddyContainer, helperImage: cfg.helperImage, maxTeamsPerHost: cfg.maxTeamsPerHost,
      // slots in use (without the scaler: TDCLOUD_AUTOSCALE=0): Business takes two (twice the cpu and memory limits)
      teamsOnHost: (h) => cloud!.db.query<{ n: number | null }, [string]>(`SELECT sum(${SLOTS_SQL}) AS n FROM teams WHERE host = ? AND status NOT IN ('deleted', 'pending_payment')`).get(h)!.n ?? 0,
    })
    : cfg.driver === 'fake' ? new FakeDriver(path.join(cfg.stateDir, 'fake'))
      : localDockerDriver({ stateDir: cfg.stateDir, seccomp: cfg.seccompProfile, apparmor: cfg.apparmorProfile, caddyContainer: cfg.caddyContainer, helperImage: cfg.helperImage }))
  const pool = opts.pool !== undefined ? opts.pool : !cfg.autoscale ? null
    : cfg.driver === 'aws' ? new AwsPool(aws, new SsmRunner(aws, cfg.helperImage), { asgName: cfg.aws.asgName, hostTag: cfg.aws.hostTag })
      : cfg.driver === 'local' ? new LocalPool(cfg.stateDir, new LocalRunner(), { bootMs: cfg.localHostBootMs, max: cfg.maxHosts })
        : null
  cloud = new Cloud({ cfg, db, driver, mailer, keys, target, log: opts.log, pool })
  if (cfg.driver === 'aws' && cfg.aws.route53ZoneId) {
    const zone = cfg.aws.route53ZoneId
    cloud.dnsHook = (action, slug, ip) => aws.changeA(zone, action, `${slug}.${cfg.domain}`, ip)
  }
  return cloud
}

function take(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  if (i < 0) return undefined
  const v = args[i + 1]
  if (v === undefined) throw new CloudError('usage', `${name} needs a value`)
  args.splice(i, 2)
  return v
}

async function* fileChunks(file: string | undefined): AsyncIterable<Uint8Array> {
  const stream = file ? Bun.file(file).stream() : Bun.stdin.stream()
  for await (const c of stream) yield c
}

function sink(file: string | undefined) {
  if (!file) return { write: async (b: Uint8Array) => { await new Promise<void>((res, rej) => process.stdout.write(b, (e) => (e ? rej(e) : res()))) }, end: async () => {} }
  const fd = fs.openSync(file, 'wx', 0o600)
  return { write: async (b: Uint8Array) => { fs.writeSync(fd, b) }, end: async () => { fs.closeSync(fd) } }
}

async function helper(cmd: string, args: string[]): Promise<number> {
  if (cmd === 'seal') {
    const rcpt = take(args, '--recipient'), out = take(args, '--out')
    if (!rcpt) throw new CloudError('usage', '--recipient is required')
    const s = sink(out)
    await seal(fileChunks(undefined), s.write, rcpt)
    await s.end()
    return 0
  }
  if (cmd === 'seal-dir') {
    const dir = take(args, '--dir'), rcpt = take(args, '--recipient'), out = take(args, '--out'), ex = take(args, '--exclude')
    if (!dir || !rcpt || !out) throw new CloudError('usage', 'seal-dir --dir D --recipient KEY --out FILE')
    const excludes = (ex ?? '').split(',').filter(Boolean).flatMap((e) => [`--exclude=./${e}`])
    const tar = Bun.spawn(['tar', '-C', dir, ...excludes, '-cf', '-', '.'], { stdout: 'pipe', stderr: 'pipe' })
    const s = sink(out)
    await seal((async function* () { for await (const c of tar.stdout) yield c })(), s.write, rcpt)
    await s.end()
    const code = await tar.exited
    if (code !== 0) { fs.rmSync(out, { force: true }); console.error(await new Response(tar.stderr).text()); return code }
    return 0
  }
  if (cmd === 'unseal') {
    const keyFile = take(args, '--key-file'), inp = take(args, '--in'), out = take(args, '--out')
    if (!keyFile) throw new CloudError('usage', '--key-file is required')
    const s = sink(out)
    await unseal(fileChunks(inp), s.write, fs.readFileSync(keyFile, 'utf8').trim())
    await s.end()
    return 0
  }
  return -1
}

/** scaler passes while a team waits or a host boots or goes */
const URGENT_SCALE_MS = 5_000

async function serve(cfg: Config) {
  const cloud = buildCloud(cfg)
  const handle = makeHandler(cloud)
  const server = Bun.serve({ hostname: cfg.listenHost, port: cfg.listenPort, development: false, maxRequestBodySize: 2 * 1024 * 1024, fetch: (req, srv) => handle(req, srv.requestIP(req)?.address) })
  cloud.log(`Trina Cloud control plane on http://${cfg.listenHost}:${server.port}  (public ${cfg.controlUrl}; teams at *.${cfg.domain}; driver ${cloud.driver.name}; mail ${cfg.mailer}; keys ${cloud.keys.kind}; backups ${cloud.target.description})`)
  if (cloud.scaler) cloud.log(`host scaler: ${cloud.scaler.pool.name}, up to ${cfg.maxHosts} hosts of ${cfg.maxTeamsPerHost} slots, ${cfg.spareSlots} spare, empty hosts go after ${dur(cfg.emptyHostGraceMs)}`)
  let busy = false
  let lastBackupScan = 0, lastMetrics = 0, lastScale = 0, lastFree = 0
  setInterval(async () => {
    if (busy) return
    busy = true
    try {
      // the scaler before the jobs: a host that just finished booting takes the waiting teams in the same round
      if (cloud.scaler && Date.now() - lastScale > (cloud.scaler.urgent() ? URGENT_SCALE_MS : cfg.scalerEveryMs)) {
        lastScale = Date.now()
        await cloud.scaler.tick().catch(() => { /* logged and alerted by the scaler */ })
      }
      await cloud.runDueJobs()
      // the Free plan's inactivity lifecycle (free.ts): every minute, or more often with a short activity interval
      if (Date.now() - lastFree > Math.min(60_000, cfg.free.activityEveryMs)) { lastFree = Date.now(); await cloud.free.sweep().catch((e) => cloud.log(`free sweep: ${(e as Error).message}`)) }
      if (Date.now() - lastBackupScan > 600_000) { lastBackupScan = Date.now(); cloud.scheduleBackups() }
      if (Date.now() - lastMetrics > cfg.metricsEveryMinutes * 60_000) { lastMetrics = Date.now(); await cloud.measure() }
    } catch (e) { cloud.log(`loop: ${(e as Error).stack}`) } finally { busy = false }
  }, 2000)
  return new Promise(() => {})
}

const TEAM_HEAD = `${'TEAM'.padEnd(20)} ${'STATE'.padEnd(16)} ${'PLAN'.padEnd(9)} ${'HOST'.padEnd(20)} ${'DISK'.padEnd(14)} ${'LAST ACTIVITY'.padEnd(20)} ${'LAST BACKUP'.padEnd(20)} URL`
function teamLine(c: Cloud, t: TeamRow) {
  const gb = t.disk_bytes != null ? `${(t.disk_bytes / 1024 ** 3).toFixed(2)}/${planOf(t.plan).storageGb} GB` : '-'
  const host = t.host ?? (t.waiting_since ? `(waiting ${Math.round((Date.now() - t.waiting_since) / 60_000)} min)` : '-')
  // free teams: paused (inactive), a wake still waiting for use, and when people last used it (paid: not tracked)
  const state = c.free.isPaused(t) ? 'paused' : t.plan === 'free' && t.woke_at && t.status === 'active' ? 'woken' : t.status
  const activity = t.plan === 'free' ? iso(t.last_activity_at) : '-'
  return `${t.slug.padEnd(20)} ${state.padEnd(16)} ${t.plan.padEnd(9)} ${host.padEnd(20)} ${gb.padEnd(14)} ${activity.padEnd(20)} ${iso(t.last_backup_at).padEnd(20)} ${c.url(t)}`
}

const dur = (ms: number) => (ms < 120_000 ? `${Math.round(ms / 1000)}s` : ms < 7200_000 ? `${Math.round(ms / 60_000)}m` : `${(ms / 3600_000).toFixed(1)}h`)

async function hostsList(c: Cloud, all: boolean) {
  const s = c.scaler
  if (!s) {
    console.log('the host scaler is off (TDCLOUD_AUTOSCALE=0): hosts are whatever the driver offers')
    return
  }
  const cfg = c.cfg
  let pool = ''
  try {
    const st = await s.pool.status()
    pool = `desired ${st.desired}, running ${st.instances.filter((i) => i.lifecycle !== 'terminating').length}, max ${Math.min(cfg.maxHosts, st.max)} (TDCLOUD_MAX_HOSTS ${cfg.maxHosts}, pool max ${st.max})`
  } catch (e) { pool = `pool not readable: ${(e as Error).message}` }
  console.log(`pool       ${s.pool.name}: ${pool}`)
  console.log(`per host   ${cfg.maxTeamsPerHost} slots (Team 1, Business 2, Free ${planOf('free').slots}; free teams at most ${fmtSlots(s.freeCapacity)}, never the last ${cfg.free.reserveHosts} host(s)); spare slots ${cfg.spareSlots}; empty hosts go after ${dur(cfg.emptyHostGraceMs)}; boot timeout ${dur(cfg.hostBootTimeoutMs)}`)
  if (s.bootFailures) console.log(`boot fails ${s.bootFailures} in a row${s.bootFailures >= 3 ? ' — scale-out STOPPED (hosts resume)' : ''}`)
  const waiting = s.waiting()
  console.log(`waiting    ${waiting.length ? waiting.map((t) => `${t.slug} (${t.waiting_since ? dur(Date.now() - t.waiting_since) : 'new'})`).join(', ') : '-'}`)
  const rows = s.view(all)
  console.log('')
  console.log(`${'HOST'.padEnd(21)} ${'STATE'.padEnd(11)} ${'SLOTS'.padEnd(7)} ${'FREE'.padEnd(5)} ${'EMPTY SINCE'.padEnd(28)} ${'IP'.padEnd(16)} TEAMS / NOTE`)
  for (const h of rows) {
    const empty = h.empty_since != null ? `${iso(h.empty_since)} (${dur(Date.now() - h.empty_since)})` : '-'
    const extra = [h.teams.join(','), h.keep ? 'KEEP' : '', h.online ? '' : 'offline', h.note ?? ''].filter(Boolean).join('  ')
    console.log(`${h.id.padEnd(21)} ${h.state.padEnd(11)} ${`${fmtSlots(h.used)}/${h.capacity}`.padEnd(7)} ${fmtSlots(h.free).padEnd(5)} ${empty.padEnd(28)} ${(h.public_ip ?? '-').padEnd(16)} ${extra}`)
  }
  if (!rows.length) console.log('(no hosts)')
}

export async function main(argv: string[]): Promise<number> {
  const args = [...argv]
  const [cmd, sub] = args
  if (!cmd || cmd === 'help' || cmd === '--help') { console.log(HELP + registeredHelp()); return 0 }
  const h = await helper(cmd, args.slice(1))
  if (h >= 0) return h
  if (cmd === 'mail-relay') {
    const r = relayFromEnv()
    const server = Bun.serve({ hostname: r.host, port: r.port, development: false, maxRequestBodySize: MAX_BODY_BYTES + 1024, fetch: (req, srv) => r.handle(req, srv.requestIP(req)?.address) })
    console.log(`Trina Cloud mail relay on http://${r.host}:${server.port} → ${r.upstream.name}`)
    await new Promise(() => {})
  }
  const cfg = loadConfig()
  if (cmd === 'serve') { await serve(cfg); return 0 }
  const cloud = buildCloud(cfg, { log: (s) => console.error(s) })
  const actor = `admin:${process.env.SUDO_USER || process.env.USER || 'unknown'}`
  const rest = args.slice(2)
  const team = () => { const t = rest[0] ? teamBySlug(cloud.db, rest[0]) : null; if (!t) throw new CloudError('usage', `no team ${rest[0] ?? '(give a slug)'}`); return t }
  // commands the feature modules register (cli/index.ts: operations, the console): asked first, so one may take over a
  // built-in below
  const reg = findCommand(cmd, sub)
  if (reg) {
    const regRest = args.slice(reg.name.split(' ').length)
    const regTeam = () => { const t = regRest[0] ? teamBySlug(cloud.db, regRest[0]) : null; if (!t) throw new CloudError('usage', `no team ${regRest[0] ?? '(give a slug)'}`); return t }
    return reg.run({ cloud, cfg, actor, rest: regRest, team: regTeam, take: (name) => take(regRest, name) })
  }
  switch (`${cmd} ${sub ?? ''}`.trim()) {
    case 'teams list':
      console.log(TEAM_HEAD)
      for (const t of cloud.db.query<TeamRow, []>(`SELECT * FROM teams ${rest.includes('--free') ? "WHERE plan = 'free'" : ''} ORDER BY id`).all()) console.log(teamLine(cloud, t))
      return 0
    case 'teams show': {
      const t = team()
      const { backup_key_enc: _k, ...visible } = t
      console.log(JSON.stringify({ ...visible, url: cloud.url(t), owner: cloud.ownerEmail(t), backups: cloud.db.query('SELECT at, kind, object_key, bytes FROM backups WHERE team_id = ? ORDER BY at DESC LIMIT 10').all(t.id) }, null, 2))
      return 0
    }
    case 'teams usage': for (const u of await cloud.measure()) console.log(`${u.slug.padEnd(20)} ${u.bytes ?? '?'} / ${u.quota}${u.over ? '  OVER QUOTA' : ''}`); return 0
    case 'teams create': {
      const owner = take(rest, '--owner'), name = take(rest, '--name'), plan = take(rest, '--plan')
      const allowReserved = rest.includes('--allow-reserved')
      const slug = rest.find((a) => !a.startsWith('--'))
      if (!slug || !owner) throw new CloudError('usage', 'teams create <slug> --owner EMAIL [--name NAME] [--plan team|business|free] [--allow-reserved]')
      if (plan && plan !== 'team' && plan !== 'business' && plan !== 'free') throw new CloudError('usage', '--plan team, business or free')
      const t = await cloud.adminCreateTeam({ email: owner, slug, name, plan: plan as 'team' | 'business' | 'free' | undefined, allowReserved, actor })
      // the running control plane's job loop provisions it (running the job here too would race with it)
      console.error(`${t.slug}: queued; waiting for the control plane to provision it…`)
      const deadline = Date.now() + 15 * 60_000
      let row = teamBySlug(cloud.db, t.slug)!
      while (row.status === 'provisioning' && Date.now() < deadline) { await Bun.sleep(3000); row = teamBySlug(cloud.db, t.slug)! }
      console.log(teamLine(cloud, row))
      return row.status === 'active' ? 0 : 1
    }
    case 'teams suspend': await cloud.suspend(team(), 'admin', actor); console.log('suspended'); return 0
    case 'teams resume': await cloud.resume(team(), actor); console.log('resumed'); return 0
    case 'teams backup': for (const p of await cloud.backup(team(), 'manual', actor)) console.log(`${p.part}\t${p.bytes}\t${p.key}`); return 0
    case 'teams resend-setup': await cloud.resendSetup(team(), actor); console.log('setup link sent'); return 0
    case 'teams upgrade': {
      const all = rest[0] === '--all'
      const list = all ? cloud.db.query<TeamRow, []>("SELECT * FROM teams WHERE status IN ('active', 'past_due', 'suspended') ORDER BY id").all() : [team()]
      for (const t of list) {
        try { await cloud.upgrade(t, actor); console.log(`${t.slug}: now on ${cfg.image}`) } catch (e) { console.error(`${t.slug}: upgrade failed: ${(e as Error).message}`); if (!all) throw e }
      }
      return 0
    }
    case 'teams retry': { const t = team(); updateTeam(cloud.db, t.id, { status: 'provisioning', error: null }); cloud.enqueue('provision', t.id); await cloud.runDueJobs(); console.log(teamLine(cloud, team())); return 0 }
    case 'teams link': { const t = team(); updateTeam(cloud.db, t.id, { subscription_id: rest[1] ?? null }); console.log(`linked ${t.slug} to ${rest[1]}; the next event for it applies`); return 0 }
    case 'teams set-plan': {
      const t = team(); const plan = rest[1] === 'business' ? 'business' : rest[1] === 'team' ? 'team' : null
      if (!plan) throw new CloudError('usage', 'team or business (there is no downgrade to free)')
      if (t.plan === 'free') throw new CloudError('usage', `${t.slug} is a free team: it upgrades through a Paddle checkout from the dashboard (or teams link + an event), so billing and plan agree`)
      updateTeam(cloud.db, t.id, { plan }); cloud.enqueue('limits', t.id); await cloud.runDueJobs(); console.log(`${t.slug}: ${plan}`); return 0
    }
    case 'teams delete': {
      if (!rest.includes('--yes')) throw new CloudError('usage', 'this deletes the team\'s data after a final backup: add --yes')
      await cloud.deleteTeam(team(), actor); console.log('deleted (final backup kept in the backup target)'); return 0
    }
    case 'teams export': {
      const out = take(rest, '--out')
      if (!out) throw new CloudError('usage', '--out DIR')
      const t = team()
      const wasRunning = t.host ? (await cloud.driver.state(t.host, t.slug)) === 'running' : false
      if (!wasRunning && t.host) await cloud.driver.start(t.host, cloud.spec(t))
      try {
        const parts = await cloud.backup(t, 'export', actor)
        const secrets = await cloud.backupSecrets(t)
        fs.mkdirSync(out, { recursive: true, mode: 0o700 })
        for (const p of parts) {
          const local = path.join(out, p.name)
          await cloud.target.get(p.key, local)
          if (p.part === 'files') {
            const s = sink(path.join(out, 'files.tar'))
            await unseal(fileChunks(local), s.write, secrets.files)
            await s.end()
            fs.rmSync(local)
          }
        }
        fs.writeFileSync(path.join(out, 'product-backup-secret-key.txt'), secrets.product + '\n', { mode: 0o600 })
        fs.writeFileSync(path.join(out, 'README.txt'), `Trina Drive export of ${t.name} (${cloud.url(t)}), ${new Date().toISOString()}\n\n` +
          `files.tar                      everything on the workspace volume except the database (uploaded files, folders)\n` +
          `${parts.find((p) => p.part === 'product-db')?.name}   the database and drafts, encrypted; restore with:\n` +
          `    tdrive backup restore <that file> --into NEW_DIR --key-file product-backup-secret-key.txt\n` +
          `product-backup-secret-key.txt  keep it private: it opens the archive above\n`)
        writeAudit(cloud.db, { actor, action: 'team.exported', teamId: t.id })
        console.log(`exported to ${out}`)
      } finally { if (!wasRunning && t.host) await cloud.driver.stop(t.host, t.slug) }
      return 0
    }
    case 'db snapshot': {
      const out = rest[0]
      if (!out) throw new CloudError('usage', 'db snapshot <file>')
      cloud.db.query('VACUUM INTO ?').run(out)
      fs.chmodSync(out, 0o600)
      console.log(`snapshot: ${out}`)
      return 0
    }
    case 'free stats': {
      const st = cloud.free.stats()
      if (rest.includes('--json')) { console.log(JSON.stringify(st, null, 2)); return 0 }
      console.log(`free teams     ${st.total} of ${st.cap} (TDCLOUD_MAX_FREE_TEAMS): ${st.active} active, ${st.paused} paused, ${st.provisioning} starting${st.other ? `, ${st.other} other` : ''}`)
      console.log(`also           ${st.deleted} deleted, ${st.upgraded} upgraded to a paid plan`)
      console.log(`sign-ups       ${st.waitlist} on the waitlist, ${st.unconfirmed} waiting for email confirmation`)
      console.log(`idle rules     warn after ${dur(cfg.free.idleWarnMs)}, pause after ${dur(cfg.free.idlePauseMs)}, delete after ${dur(cfg.free.deleteAfterMs)} paused; activity read every ${dur(cfg.free.activityEveryMs)}`)
      console.log(`hosts          ${st.hosts.length ? st.hosts.map((h) => `${h.host} ${fmtSlots(h.free_slots)} free of ${fmtSlots(h.used)}/${h.capacity} slots`).join('; ') : '-'}`)
      console.log(`next deletions ${st.next_deletions.length ? st.next_deletions.map((d) => `${d.slug} ${d.on}`).join(', ') : '-'}`)
      console.log(`cost (rough)   ~$${st.est_monthly_usd}/month (active: a quarter slot + disk and backups; paused: disk and backups)`)
      return 0
    }
    case 'free waitlist': {
      const w = cloud.free.waitlist()
      for (const s of w) console.log(`${String(s.id).padEnd(6)} ${s.email.padEnd(32)} ${iso(s.verified_at)}  ${s.name}${s.slug ? ` (${s.slug})` : ''}`)
      if (!w.length) console.log('(nobody waiting)')
      return 0
    }
    case 'free admit': {
      if (!rest[0]) throw new CloudError('usage', 'free admit <email|id> [--force]')
      const t = await cloud.free.admit(rest[0], actor, rest.includes('--force'))
      console.log(`${t.slug}: queued (the control plane provisions it; the setup link goes to the owner)`)
      return 0
    }
    case 'free sweep': { const r = await cloud.free.sweep(); writeAudit(cloud.db, { actor, action: 'free.sweep' }); console.log(JSON.stringify(r)); return 0 }
    case 'free wake': {
      const t = team()
      if (!cloud.free.isPaused(t)) throw new CloudError('usage', `${t.slug} is not a paused free team`)
      await cloud.free.wake(t)
      console.log(`${t.slug}: running (pauses again after ${dur(cfg.free.wakeGraceMs)} unless someone uses it)`)
      return 0
    }
    case 'hosts list': await hostsList(cloud, rest.includes('--all')); return 0
    case 'hosts scale': {
      if (!cloud.scaler) throw new CloudError('usage', 'the host scaler is off (TDCLOUD_AUTOSCALE=0)')
      const r = await cloud.scaler.tick()
      writeAudit(cloud.db, { actor, action: 'hosts.scale_pass' })
      console.log(r.skipped ? 'another scaler pass is running (the control plane): try again in a moment' : JSON.stringify(r))
      return 0
    }
    case 'hosts keep': case 'hosts unkeep': {
      if (!cloud.scaler || !rest[0]) throw new CloudError('usage', `hosts ${sub} <host id>`)
      cloud.scaler.setKeep(rest[0], sub === 'keep')
      writeAudit(cloud.db, { actor, action: `hosts.${sub}`, detail: { host: rest[0] } })
      console.log(`${rest[0]}: ${sub === 'keep' ? 'never scaled in' : 'the scaler may scale it in when empty'}`)
      return 0
    }
    case 'hosts resume': {
      if (!cloud.scaler) throw new CloudError('usage', 'the host scaler is off')
      cloud.scaler.resume()
      writeAudit(cloud.db, { actor, action: 'hosts.resume' })
      console.log('scale-out resumed')
      return 0
    }
    case 'jobs list':
      for (const j of cloud.db.query<{ id: number; kind: string; slug: string; run_at: number; attempts: number; last_error: string | null }, []>('SELECT j.id, j.kind, t.slug, j.run_at, j.attempts, j.last_error FROM jobs j JOIN teams t ON t.id = j.team_id WHERE j.done_at IS NULL ORDER BY j.run_at').all()) {
        console.log(`${j.id}\t${j.kind}\t${j.slug}\t${iso(j.run_at)}\tattempts ${j.attempts}${j.last_error ? `\t${j.last_error.split('\n')[0]}` : ''}`)
      }
      return 0
    case 'jobs run': console.log(`ran ${await cloud.runDueJobs(100)} job(s)`); return 0
    case 'audit verify': { const r = verifyAudit(cloud.db); console.log(r.ok ? `audit chain ok: ${r.rows} rows` : `AUDIT CHAIN BROKEN at row ${r.brokenAt}`); return r.ok ? 0 : 1 }
    case 'audit list': {
      const slug = take(rest, '--team'), limit = take(rest, '--limit')
      const t = slug ? teamBySlug(cloud.db, slug) : null
      for (const a of listAudit(cloud.db, { teamId: t?.id, limit: limit ? Number(limit) : 50 }).reverse()) console.log(`${iso(a.at)}\t${a.actor}\t${a.action}\t${a.team_id ?? ''}\t${a.detail}`)
      return 0
    }
    default:
      console.error(`unknown command: ${args.join(' ')}\n\n${HELP}${registeredHelp()}`)
      return 2
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => { if (code !== 0) process.exitCode = code }, (e) => {
    if (e instanceof CloudError) { console.error(`error: ${e.message}`); process.exit(1) }
    console.error(e instanceof Error ? `${e.message}${(e as { detail?: string }).detail ? `\n${(e as { detail?: string }).detail}` : ''}` : e)
    process.exit(1)
  })
}
