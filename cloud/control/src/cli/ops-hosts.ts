// `hosts check` (workstream G1): each team host's data volume — shared by every team on it, so when it fills every
// team's database stops (review finding 24) — and, with --isolation, `tdcloud-host check` for each team on it (what a
// team container can reach; smoke check 11). The control host runs `hosts check --alert` every hour (cron from
// cloud/host/bootstrap.sh): ops get one mail per host and half day while it is over the line.
import { audit } from '../audit'
import { CloudError, type Cloud } from '../cloud'
import { HOUR } from '../util'
import type { ControlCommand } from './types'

const AGENT = '/usr/local/sbin/tdcloud-host'
export const DISK_ALERT_PCT_DEFAULT = 80
const ALERT_EVERY_MS = 12 * HOUR

export interface HostInfo { instanceId?: string; publicIp?: string | null; freeBytes?: number; sizeBytes?: number; usedPct?: number; teams?: number; containers?: number; ready?: boolean }

export interface HostCheck {
  host: string
  state: string
  info: HostInfo | null
  teams: string[]
  problems: string[]
  isolation?: { slug: string; ok: boolean; output: string }[]
}

/** the hosts worth asking: the scaler's live ones, or (without the scaler) every host a team row names */
function hostsToCheck(cloud: Cloud): { id: string; state: string }[] {
  if (cloud.scaler) return cloud.scaler.view().filter((h) => ['ready', 'booting', 'draining', 'lost'].includes(h.state)).map((h) => ({ id: h.id, state: h.state }))
  return cloud.db.query<{ host: string }, []>("SELECT DISTINCT host FROM teams WHERE host IS NOT NULL AND status NOT IN ('deleted', 'pending_payment') ORDER BY host").all().map((r) => ({ id: r.host, state: 'named' }))
}

export async function checkHosts(cloud: Cloud, o: { pct: number; isolation: boolean }): Promise<HostCheck[]> {
  const run = cloud.driver.runOnHost?.bind(cloud.driver)
  if (!run) throw new CloudError('usage', `the ${cloud.driver.name} driver cannot run commands on hosts`)
  const out: HostCheck[] = []
  for (const h of hostsToCheck(cloud)) {
    const teams = cloud.db.query<{ slug: string; status: string }, [string]>("SELECT slug, status FROM teams WHERE host = ? AND status NOT IN ('deleted') ORDER BY slug").all(h.id)
    const c: HostCheck = { host: h.id, state: h.state, info: null, teams: teams.map((t) => t.slug), problems: [] }
    out.push(c)
    const r = await run(h.id, [AGENT, 'info'], { timeoutS: 60 }).catch((e) => ({ code: 255, stdout: '', stderr: (e as Error).message }))
    if (r.code !== 0) {
      // a host still booting has no agent yet; a lost one is the scaler's alert already
      if (h.state === 'ready' || h.state === 'named') c.problems.push(`unreachable (${r.stderr.trim().split('\n').at(-1) ?? `exit ${r.code}`})`)
      continue
    }
    try { c.info = JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '') as HostInfo } catch { c.problems.push('info: not JSON'); continue }
    const pct = c.info.usedPct ?? (c.info.sizeBytes && c.info.freeBytes != null ? Math.round(100 * (1 - c.info.freeBytes / c.info.sizeBytes)) : null)
    if (pct == null) c.problems.push('data volume use unknown (an older host agent: rerun the bootstrap)')
    else if (pct >= o.pct) c.problems.push(`data volume ${pct}% used (alert at ${o.pct}%)`)
    if (o.isolation) {
      c.isolation = []
      for (const t of teams.filter((x) => ['active', 'past_due'].includes(x.status))) {
        const k = await run(h.id, [AGENT, 'check', t.slug], { timeoutS: 180 }).catch((e) => ({ code: 255, stdout: '', stderr: (e as Error).message }))
        const ok = k.code === 0
        c.isolation.push({ slug: t.slug, ok, output: (k.stdout + (ok ? '' : k.stderr)).trim() })
        if (!ok) c.problems.push(`isolation check failed for ${t.slug}`)
      }
    }
  }
  return out
}

const gb = (n: number | undefined) => (n == null ? '?' : (n / 1024 ** 3).toFixed(1))

/** One mail per host and ALERT_EVERY_MS while it has problems (kv `ops.host_alert.<host>`). */
async function alertOnce(cloud: Cloud, c: HostCheck) {
  const key = `ops.host_alert.${c.host}`
  const last = cloud.db.query<{ value: string }, [string]>('SELECT value FROM kv WHERE key = ?').get(key)
  if (last && Date.now() - Number(last.value) < ALERT_EVERY_MS) return false
  cloud.db.query('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(key, String(Date.now()), Date.now())
  await cloud.alertOps(`host ${c.host}: ${c.problems[0]}`, `${c.problems.join('\n')}\n\nTeams on it: ${c.teams.join(', ') || '-'}\nData volume: ${gb(c.info?.freeBytes)} GB free of ${gb(c.info?.sizeBytes)} GB\n\n` +
    'The data volume is shared by every team on the host: when it is full, every team\'s database stops. Grow it online (EC2 → Volumes → Modify, then `xfs_growfs /srv/tdcloud` on the host; raise host_data_gb in Terraform for new hosts), or move the largest team (cloud/README.md "Host disk").\n\n`hosts check` on the control plane shows the state.')
  audit(cloud.db, { actor: 'system', action: 'host.alert', detail: { host: c.host, problems: c.problems } })
  return true
}

export const hostsCheck: ControlCommand = {
  name: 'hosts check',
  help: `  hosts check [--alert] [--isolation] [--pct N]
                                          each team host: data volume use (problem at N%, default TDCLOUD_HOST_DISK_ALERT_PCT or 80),
                                          reachable; --isolation: tdcloud-host check for each running team; --alert: mail ops
                                          (once per host and 12 h). Exit 1 on a problem`,
  async run(c) {
    const { cloud } = c
    if (cloud.driver.name === 'local') { console.log('hosts check: the local driver has no host agent (cloud/host/tdcloud-host runs on AWS hosts)'); return 0 }
    const pctArg = c.take('--pct')
    const pct = Number(pctArg ?? process.env.TDCLOUD_HOST_DISK_ALERT_PCT ?? DISK_ALERT_PCT_DEFAULT)
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) throw new CloudError('usage', '--pct is a percentage (1–100)')
    const alert = c.rest.includes('--alert')
    const res = await checkHosts(cloud, { pct, isolation: c.rest.includes('--isolation') })
    for (const h of res) {
      const i = h.info
      console.log(`${h.host.padEnd(21)} ${h.state.padEnd(9)} disk ${i?.usedPct != null ? `${i.usedPct}%` : '?'} (${gb(i?.freeBytes)} GB free of ${gb(i?.sizeBytes)} GB)  teams ${h.teams.join(',') || '-'}  ${h.problems.length ? `PROBLEM: ${h.problems.join('; ')}` : 'ok'}`)
      for (const k of h.isolation ?? []) console.log(`  ${k.ok ? 'ok  ' : 'FAIL'} isolation ${k.slug}\n${k.output.split('\n').map((l) => `      ${l}`).join('\n')}`)
      if (alert && h.problems.length) await alertOnce(cloud, h)
    }
    if (!res.length) console.log('(no team hosts)')
    return res.some((h) => h.problems.length) ? 1 : 0
  },
}
