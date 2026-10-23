// Workstream G1 operator commands and driver hooks: `teams retry --reset-host` (review finding 24: the dogfood team
// whose row still names a terminated host), `teams set-plan --complimentary`, `teams exec`, `hosts check`, and the
// driver's before-serve hook (finding 5: wake/restart sync the members before anyone can reach the team).
import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { listAudit } from '../src/audit'
import { teamBySlug, updateTeam, type TeamRow } from '../src/db'
import { DockerDriver, type HostLayout, type Runner } from '../src/drivers/docker'
import type { ExecResult, TeamSpec } from '../src/drivers/types'
import { CONTROL_COMMANDS, findCommand } from '../src/cli'
import { PROBE_EVERY_MS } from '../src/scaler'
import { teamNet } from '../src/teamnet'
import { planOf } from '../src/plans'
import { setup, type Env } from './helpers'

let env: Env
afterEach(() => env?.cleanup())

let clockAt = Date.now()
const clock = () => clockAt
const team = (slug: string) => teamBySlug(env.cloud.db, slug)!

/** runs a registered command as main.ts would (rest = the words after the command's name) */
async function cli(line: string): Promise<{ code: number; out: string; err: string }> {
  const args = line.split(' ')
  const cmd = findCommand(args[0]!, args[1])
  if (!cmd) throw new Error(`no command ${line}`)
  const rest = args.slice(cmd.name.split(' ').length)
  const out: string[] = [], err: string[] = []
  const log = console.log, error = console.error
  console.log = (...a: unknown[]) => { out.push(a.join(' ')) }
  console.error = (...a: unknown[]) => { err.push(a.join(' ')) }
  try {
    const code = await cmd.run({
      cloud: env.cloud, cfg: env.cfg, actor: 'admin:test', rest,
      team: () => { const t = rest[0] ? teamBySlug(env.cloud.db, rest[0]) : null; if (!t) throw new Error(`no team ${rest[0]}`); return t },
      take: (name) => { const i = rest.indexOf(name); if (i < 0) return undefined; const v = rest[i + 1]; rest.splice(i, 2); return v },
    })
    return { code, out: out.join('\n'), err: err.join('\n') }
  } finally { console.log = log; console.error = error }
}

async function jobs() { env.cloud.db.query('UPDATE jobs SET run_at = 0 WHERE done_at IS NULL').run(); await env.cloud.runDueJobs() }
async function untilActive(slug: string) {
  for (let i = 0; i < 6 && team(slug).status !== 'active'; i++) {
    await jobs(); await env.cloud.scaler!.tick(); env.pool.boot(); clockAt += PROBE_EVERY_MS; await env.cloud.scaler!.tick(); await jobs()
  }
}

/** the dogfood team as the hold left it: suspended, complimentary, its row naming a host the pool no longer has */
async function heldTeam() {
  clockAt = Date.now()
  env = setup({ TDCLOUD_MAX_HOSTS: '3' }, { pool: true, clock })
  await env.cloud.adminCreateTeam({ email: 'contact@trina.app', slug: 'trina', allowReserved: true, actor: 'admin:test', plan: 'business' })
  await untilActive('trina')
  expect(team('trina').status).toBe('active')
  await env.cloud.backup(team('trina'), 'manual', 'admin:test')
  await env.cloud.suspend(team('trina'), 'admin', 'admin:test')
  // the hold: the host was terminated by hand (no scaler then), the container with it
  const old = team('trina')
  env.pool.hosts.clear(); env.pool.desired = 0
  env.driver.instances.delete('trina')
  updateTeam(env.cloud.db, old.id, { host: 'i-054ebcf7be3ae5f94' })
  env.cloud.enqueue('backup', old.id)
  return team('trina')
}

describe('teams retry', () => {
  test('replaces the built-in (registered with replaces: true) and keeps a plain retry for failed teams', async () => {
    expect(CONTROL_COMMANDS.find((c) => c.name === 'teams retry')?.replaces).toBe(true)
    expect(CONTROL_COMMANDS.find((c) => c.name === 'teams set-plan')?.replaces).toBe(true)
    env = setup()
    await env.cloud.adminCreateTeam({ email: 'o@acme.test', slug: 'acme', actor: 'admin:test' })
    env.driver.failCreate = true
    for (let i = 0; i < 5; i++) await jobs()
    expect(team('acme').status).toBe('failed')
    env.driver.failCreate = false
    const r = await cli('teams retry acme --no-wait')
    expect(r.code).toBe(0)
    await jobs()
    expect(team('acme').status).toBe('active')
    expect(listAudit(env.cloud.db, { teamId: team('acme').id }).map((a) => a.action)).toContain('team.retry')
    // a running team is not "retried"
    await expect(cli('teams retry acme --no-wait')).rejects.toThrow(/retry is for a failed provisioning/)
  })

  test('--reset-host: control DB copied, old backup keys kept, host forgotten, pending jobs cancelled, provisioned on a new host', async () => {
    const old = await heldTeam()
    expect(old.status).toBe('suspended')
    const r = await cli('teams retry trina --reset-host --no-wait')
    expect(r.code).toBe(0)
    expect(r.err).toContain('host reference cleared (was i-054ebcf7be3ae5f94, gone)')
    const t = team('trina')
    expect(t).toMatchObject({ status: 'provisioning', host: null, public_ip: null, backup_pub: null, backup_key_enc: null, suspended_at: null })
    // the copy of the control database, in the backup target (DirTarget here) and next to the database
    const copies = fs.readdirSync(path.join(env.dir, 'backups', 'control'))
    expect(copies.some((f) => /^control-\d{8}T\d{6}Z-before-reset-trina\.db$/.test(f))).toBe(true)
    expect(fs.readdirSync(env.cfg.stateDir).some((f) => f.endsWith('-before-reset-trina.db'))).toBe(true)
    // the old keys still open the old backups
    const kept = env.cloud.db.query<{ backup_pub: string; backup_key_enc: string; host: string; reason: string }, [number]>('SELECT * FROM retired_backup_keys WHERE team_id = ?').all(t.id)
    expect(kept).toHaveLength(1)
    expect(kept[0]).toMatchObject({ backup_pub: old.backup_pub!, backup_key_enc: old.backup_key_enc!, host: 'i-054ebcf7be3ae5f94', reason: 'reset-host' })
    expect(await env.cloud.backupSecrets({ ...t, backup_key_enc: kept[0]!.backup_key_enc } as TeamRow)).toHaveProperty('files')
    // the backup queued for the gone host is cancelled; only the provision job is pending
    const pending = env.cloud.db.query<{ kind: string }, [number]>('SELECT kind FROM jobs WHERE team_id = ? AND done_at IS NULL').all(t.id).map((j) => j.kind)
    expect(pending).toEqual(['provision'])
    const a = listAudit(env.cloud.db, { teamId: t.id }).find((x) => x.action === 'team.host_reset')!
    expect(JSON.parse(a.detail)).toMatchObject({ old_host: 'i-054ebcf7be3ae5f94', old_status: 'suspended', host_was: 'gone', backup_keys_kept: true })
    // the scaler launches a host and the team runs again, with new keys and the plan it had
    await untilActive('trina')
    const now = team('trina')
    expect(now.status).toBe('active')
    expect(now.host).toBe('i-1')
    expect(now.backup_pub).not.toBe(old.backup_pub)
    expect(now.plan).toBe('business')
  })

  test('--reset-host refuses while the host is still there (its data is on it), unless --force', async () => {
    clockAt = Date.now()
    env = setup({ TDCLOUD_MAX_HOSTS: '3' }, { pool: true, clock })
    await env.cloud.adminCreateTeam({ email: 'o@acme.test', slug: 'acme', actor: 'admin:test' })
    await untilActive('acme')
    await env.cloud.suspend(team('acme'), 'admin', 'admin:test')
    await expect(cli('teams retry acme --reset-host --no-wait')).rejects.toThrow(/still there/)
    expect(team('acme').host).toBe('i-1')
    const r = await cli('teams retry acme --reset-host --force --no-wait')
    expect(r.code).toBe(0)
    expect(team('acme').host).toBeNull()
  })
})

describe('teams set-plan', () => {
  test('--complimentary on the held team: Team (100 GB), no billing, applied when it is provisioned again', async () => {
    const old = await heldTeam()
    env.cloud.db.query('UPDATE teams SET sub_status = NULL, grace_until = 1 WHERE id = ?').run(old.id)
    env.cloud.enqueue('grace_check', old.id)
    const r = await cli('teams set-plan trina team --complimentary')
    expect(r.code).toBe(0)
    expect(r.out).toContain('trina: team (complimentary) — 100 GB of files')
    expect(r.out).toContain('its host i-054ebcf7be3ae5f94 is gone')
    const t = team('trina')
    expect(t).toMatchObject({ plan: 'team', sub_status: 'complimentary', grace_until: null })
    expect(env.cloud.db.query("SELECT 1 FROM jobs WHERE team_id = ? AND kind IN ('grace_check', 'limits') AND done_at IS NULL").get(t.id)).toBeNull()
    // then the reset: the new container gets the Team limits and the 100 GB quota
    await cli('teams retry trina --reset-host --no-wait')
    await untilActive('trina')
    const spec = env.driver.instances.get('trina')!.spec
    expect(spec.plan.id).toBe('team')
    expect(spec.env.TDRIVE_STORAGE_QUOTA).toBe('100GB')
    expect(planOf('team').storageGb).toBe(100)
  })

  test('a running team: limits queued; a live subscription is not made complimentary without --force; free teams refused', async () => {
    env = setup()
    await env.cloud.adminCreateTeam({ email: 'o@acme.test', slug: 'acme', actor: 'admin:test' })
    await jobs()
    updateTeam(env.cloud.db, team('acme').id, { subscription_id: 'sub_1', sub_status: 'active' })
    await expect(cli('teams set-plan acme business --complimentary')).rejects.toThrow(/live Paddle subscription/)
    const r = await cli('teams set-plan acme business')
    expect(r.out).toContain('new limits queued')
    expect(r.err).toContain('shared by all its teams')
    await jobs()
    expect(env.driver.calls).toContain('limits acme business')
    await env.cloud.adminCreateTeam({ email: 'o@free.test', slug: 'freebie', actor: 'admin:test', plan: 'free' })
    await expect(cli('teams set-plan freebie team')).rejects.toThrow(/free team/)
    await expect(cli('teams set-plan acme free')).rejects.toThrow(/no downgrade/)
  })
})

describe('teams exec', () => {
  test('runs the product CLI in the team container, audits only the command', async () => {
    env = setup()
    await env.cloud.adminCreateTeam({ email: 'o@acme.test', slug: 'acme', actor: 'admin:test' })
    await jobs()
    const r = await cli('teams exec acme -- people reset-link alice@acme.test')
    expect(r.code).toBe(0)
    expect(env.driver.calls).toContain('exec acme people reset-link alice@acme.test')
    const a = listAudit(env.cloud.db, { teamId: team('acme').id }).find((x) => x.action === 'team.exec')!
    expect(a.detail).toContain('people reset-link')
    expect(a.detail).not.toContain('alice')
  })
})

describe('hosts check', () => {
  const info = (pct: number) => ({ code: 0, stdout: JSON.stringify({ instanceId: 'i-1', publicIp: '3.3.3.3', freeBytes: (100 - pct) * 1024 ** 3, sizeBytes: 100 * 1024 ** 3, usedPct: pct, teams: 1, containers: 1, ready: true }) + '\n', stderr: '' })

  test('data volume over the line: problem, one ops mail per host and 12 h; isolation results', async () => {
    clockAt = Date.now()
    env = setup({ TDCLOUD_MAX_HOSTS: '3' }, { pool: true, clock })
    await env.cloud.adminCreateTeam({ email: 'o@acme.test', slug: 'acme', actor: 'admin:test' })
    await untilActive('acme')
    env.driver.hostAnswers.set('i-1 info', info(42))
    env.driver.hostAnswers.set('i-1 check', { code: 0, stdout: 'ok imds-blocked 169.254.169.254:80 timeout\n', stderr: '' })
    let r = await cli('hosts check --alert --isolation')
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/i-1\s+ready\s+disk 42% \(58\.0 GB free of 100\.0 GB\)\s+teams acme\s+ok/)
    expect(r.out).toContain('ok   isolation acme')
    expect(env.driver.calls).toContain('host i-1 check acme')
    env.driver.hostAnswers.set('i-1 info', info(85))
    r = await cli('hosts check --alert')
    expect(r.code).toBe(1)
    expect(r.out).toContain('PROBLEM: data volume 85% used (alert at 80%)')
    await cli('hosts check --alert')
    const mails = env.mailer.sent.filter((m) => m.to === env.cfg.opsEmail && m.subject.includes('host i-1'))
    expect(mails).toHaveLength(1)
    expect(mails[0]!.subject).toContain('data volume 85% used')
    expect((await cli('hosts check --pct 90')).code).toBe(0)
    env.driver.hostAnswers.set('i-1 check', { code: 1, stdout: 'FAIL imds-blocked 169.254.169.254:80 REACHABLE\n', stderr: '' })
    r = await cli('hosts check --isolation --pct 90')
    expect(r.code).toBe(1)
    expect(r.out).toContain('FAIL isolation acme')
    expect(r.out).toContain('REACHABLE')
  })

  test('an unreachable ready host is a problem', async () => {
    clockAt = Date.now()
    env = setup({ TDCLOUD_MAX_HOSTS: '3' }, { pool: true, clock })
    await env.cloud.adminCreateTeam({ email: 'o@acme.test', slug: 'acme', actor: 'admin:test' })
    await untilActive('acme')
    const r = await cli('hosts check')
    expect(r.code).toBe(1)
    expect(r.out).toContain('PROBLEM: unreachable (unreachable)')
  })
})

// ---------------------------------------------------------------- the traffic hold around the member sync's gate
class Recorder implements Runner {
  readonly argv: string[] = []
  async run(_host: string, argv: string[]): Promise<ExecResult> {
    const line = argv.slice(1).join(' ')
    this.argv.push(line)
    if (line.startsWith('inspect -f {{.State.Status}}')) return { code: 0, stdout: 'running healthy\n', stderr: '' }
    if (line.startsWith('network disconnect') && line.includes('tdc-net-gone')) return { code: 1, stdout: '', stderr: 'container tdc-caddy is not connected to network tdc-net-gone' }
    return { code: 0, stdout: '', stderr: '' }
  }
}
const layout: HostLayout = {
  seccomp: '/s.json', apparmor: '', dataMount: () => 'type=volume,src=v,dst=/data', stagingMount: () => 'type=bind,src=/s,dst=/backup', envFile: () => '/env',
  prepare: async () => {}, cleanup: async () => {}, ship: async () => [], publicIp: async () => null,
}
const spec = (slug = 'acme'): TeamSpec => ({ slug, number: 1, uid: 20001, url: `https://${slug}.example.com`, plan: planOf('team'), net: teamNet('10.128.0.0/11', 1), image: 'trina-drive:x', env: {} })

describe('traffic hold (sync.ts serveHooks)', () => {
  test('the docker driver: hold = Caddy leaves the team network (already gone is fine), serve = Caddy joins at its fixed address', async () => {
    const r = new Recorder()
    const d = new DockerDriver({ name: 't', runner: r, layout, caddyContainer: 'tdc-caddy', helperImage: 'h', pickHost: async () => 'h1' })
    await d.holdTraffic('h1', spec())
    await d.holdTraffic('h1', spec('gone'))
    await d.serveTraffic('h1', spec())
    expect(r.argv).toEqual(['network disconnect -f tdc-net-acme tdc-caddy', 'network disconnect -f tdc-net-gone tdc-caddy', `network connect --ip ${teamNet('10.128.0.0/11', 1).caddyIp} tdc-net-acme tdc-caddy`])
  })

  test('registered once in serveHooks; the gate holds the team while it syncs and releases it after', async () => {
    const { serveHooks } = await import('../src/sync')
    const { caddyHold, registerCaddyHold } = await import('../src/cli/ops-serve')
    expect(serveHooks.filter((h) => h === caddyHold)).toHaveLength(1)
    registerCaddyHold()
    expect(serveHooks.filter((h) => h === caddyHold)).toHaveLength(1)
    env = setup()
    // off on the fake driver unless turned on: other tests' call lists stay as they were
    await caddyHold.hold!(env.cloud, { ...(await env.cloud.adminCreateTeam({ email: 'o@acme.test', slug: 'acme', actor: 'admin:test' })), host: 'fake-host' })
    expect(env.driver.calls.filter((c) => c.startsWith('hold'))).toEqual([])
    env.driver.enableTrafficHold()
    await jobs()
    const t = team('acme')
    await caddyHold.hold!(env.cloud, t)
    expect(env.driver.held.has('acme')).toBe(true)
    await caddyHold.release!(env.cloud, t)
    expect(env.driver.held.has('acme')).toBe(false)
    expect(env.driver.calls.filter((c) => /^(hold|serve) /.test(c))).toEqual(['hold acme', 'serve acme'])
  })

  test('with SSO on: a resume runs start → hold → member sync → serve; a failed sync leaves the team held and stopped', async () => {
    await import('../src/cli/ops-serve')
    const { setupConsole, opsTeam, runJobs } = await import('./console-helpers')
    const cenv = setupConsole()
    cenv.driver.enableTrafficHold()
    try {
      await opsTeam(cenv, 'owner@acme.test', 'acme')
      await runJobs(cenv)
      await cenv.cloud.suspend(teamBySlug(cenv.cloud.db, 'acme')!, 'admin', 'admin:test')
      cenv.cloud.sync.changed(teamBySlug(cenv.cloud.db, 'acme')!.id)
      await cenv.cloud.resume(teamBySlug(cenv.cloud.db, 'acme')!, 'admin:test')
      const calls = cenv.driver.calls.slice(cenv.driver.calls.lastIndexOf('start acme'))
      expect(calls.slice(0, 4)).toEqual(['start acme', 'hold acme', 'exec acme cloud sync-members', 'serve acme'])
      expect(cenv.driver.held.has('acme')).toBe(false)
      await cenv.cloud.suspend(teamBySlug(cenv.cloud.db, 'acme')!, 'admin', 'admin:test')
      cenv.cloud.sync.changed(teamBySlug(cenv.cloud.db, 'acme')!.id)
      cenv.drive('acme').fail = 'bad_json'
      await expect(cenv.cloud.resume(teamBySlug(cenv.cloud.db, 'acme')!, 'admin:test')).rejects.toThrow()
      expect(cenv.driver.held.has('acme')).toBe(true)
      expect(cenv.driver.instances.get('acme')!.state).toBe('stopped')
    } finally { cenv.cleanup() }
  })
})
