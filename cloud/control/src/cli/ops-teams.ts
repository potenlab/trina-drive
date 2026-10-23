// Operator commands on one team (workstream G1): `teams retry` (takes over main.ts's, adds --reset-host), `teams
// set-plan` (takes over main.ts's, adds --complimentary), `teams exec`.
import fs from 'node:fs'
import path from 'node:path'
import { audit } from '../audit'
import { CloudError, type Cloud } from '../cloud'
import { teamBySlug, updateTeam, type TeamRow } from '../db'
import { planOf } from '../plans'
import { hostPresence } from './ops-hostref'
import type { ControlCliCtx, ControlCommand } from './types'

const PLAN_WORDS = ['team', 'business'] as const

/** Waits for the running control plane's job loop to finish provisioning (running the job here too would race it). */
async function waitProvisioned(c: ControlCliCtx, slug: string, minutes = 15): Promise<TeamRow> {
  const deadline = Date.now() + minutes * 60_000
  let row = teamBySlug(c.cloud.db, slug)!
  let said = ''
  while (row.status === 'provisioning' && Date.now() < deadline) {
    const now = row.host ? `placed on ${row.host}, starting` : 'waiting for a host (the scaler launches one: ~4 minutes from none)'
    if (now !== said) { console.error(`${slug}: ${now}…`); said = now }
    await Bun.sleep(3000)
    row = teamBySlug(c.cloud.db, slug)!
  }
  return row
}

/** A consistent copy of the control database before a hand-made change, next to it and (best effort) in the backup
 * target under control/. Returns where it is. */
export async function snapshotControlDb(cloud: Cloud, why: string): Promise<{ file: string; key: string | null }> {
  const stamp = new Date().toISOString().replace(/[-:]|\.\d+/g, '')
  const file = path.join(cloud.cfg.stateDir, `control-${stamp}-${why}.db`)
  cloud.db.query('VACUUM INTO ?').run(file)
  fs.chmodSync(file, 0o600)
  let key: string | null = `control/control-${stamp}-${why}.db`
  try { await cloud.target.put(key, file) } catch (e) { console.error(`warning: copy to the backup target failed (${(e as Error).message}); the local copy is ${file}`); key = null }
  return { file, key }
}

export const teamsRetry: ControlCommand = {
  name: 'teams retry',
  replaces: true,
  help: `  teams retry <slug> [--reset-host [--force]] [--no-wait]
                                          provision again after a failure (the control plane's job loop does it). --reset-host:
                                          the host the row names is gone (terminated, a hold): copy the control DB, keep the old
                                          backup keys (retired_backup_keys), forget the host and its address, provision anew on
                                          a host the scaler gives it (new, empty data; old backups stay in the target)`,
  async run(c) {
    const t = c.team()
    const reset = c.rest.includes('--reset-host'), force = c.rest.includes('--force'), wait = !c.rest.includes('--no-wait')
    const { cloud } = c
    if (t.status === 'deleted' || t.status === 'deleting') throw new CloudError('usage', `${t.slug} is ${t.status}`)
    if (!reset) {
      if (!['failed', 'provisioning'].includes(t.status)) throw new CloudError('usage', `${t.slug} is ${t.status}: retry is for a failed provisioning (a team whose host is gone: --reset-host)`)
      updateTeam(cloud.db, t.id, { status: 'provisioning', error: null })
      cloud.enqueue('provision', t.id)
      audit(cloud.db, { actor: c.actor, action: 'team.retry', teamId: t.id })
    } else {
      const where = t.host ? await hostPresence(cloud, t) : 'gone'
      if (where !== 'gone' && !force) {
        throw new CloudError('usage', `${t.slug}'s host ${t.host} is ${where === 'present' ? 'still there (its data is on it)' : 'not answering (unknown)'}: --reset-host would start it over empty elsewhere. Use teams resume / teams retry, or --force if you know the host and its data are gone`)
      }
      if (['active', 'past_due'].includes(t.status) && !force) throw new CloudError('usage', `${t.slug} is ${t.status}: add --force to start a running team over`)
      const snap = await snapshotControlDb(cloud, `before-reset-${t.slug}`)
      cloud.db.transaction(() => {
        if (t.backup_pub && t.backup_key_enc) {
          cloud.db.query('INSERT INTO retired_backup_keys (team_id, backup_pub, backup_key_enc, host, retired_at, reason) VALUES (?, ?, ?, ?, ?, ?)')
            .run(t.id, t.backup_pub, t.backup_key_enc, t.host, Date.now(), 'reset-host')
        }
        // pending work for the old instance means nothing now (a resume, limits or backup would go to the gone host)
        cloud.db.query('UPDATE jobs SET done_at = ?, last_error = ? WHERE team_id = ? AND done_at IS NULL').run(Date.now(), 'cancelled: teams retry --reset-host', t.id)
        updateTeam(cloud.db, t.id, {
          status: 'provisioning', host: null, public_ip: null, error: null,
          suspended_at: null, suspend_reason: null, grace_until: null, delete_after: null,
          waiting_since: null, wait_alerted_at: null,
          backup_pub: null, backup_key_enc: null, last_backup_at: null,
          disk_bytes: null, disk_checked_at: null, over_quota_since: null,
        })
        audit(cloud.db, { actor: c.actor, action: 'team.host_reset', teamId: t.id, detail: { old_host: t.host, old_public_ip: t.public_ip, old_status: t.status, host_was: where, forced: force, control_db_copy: snap.key ?? snap.file, backup_keys_kept: !!t.backup_key_enc } })
      })()
      cloud.enqueue('provision', t.id)
      console.error(`${t.slug}: host reference cleared (was ${t.host ?? '-'}, ${where}); control DB copied to ${snap.key ? `the backup target: ${snap.key}` : snap.file}`)
    }
    if (!wait) { console.log(`${t.slug}: queued for provisioning (the running control plane does it)`); return 0 }
    const row = await waitProvisioned(c, t.slug)
    console.log(`${row.slug}: ${row.status}${row.host ? ` on ${row.host}` : ''}${row.public_ip ? ` (${row.public_ip})` : ''}${row.error ? ` — ${row.error.split('\n')[0]}` : ''}`)
    if (row.status === 'provisioning') console.error('still provisioning after 15 minutes: is the control plane running? (`hosts list`, `jobs list`)')
    return row.status === 'active' ? 0 : 1
  },
}

export const teamsSetPlan: ControlCommand = {
  name: 'teams set-plan',
  replaces: true,
  help: `  teams set-plan <slug> team|business [--complimentary [--force]]
                                          change the plan (limits and quota: a new container on the same data; a free team
                                          upgrades through Paddle). --complimentary: no billing for this team (dogfood,
                                          pilots): nothing bills, suspends or deletes it for payment`,
  async run(c) {
    const t = c.team()
    const { cloud } = c
    const word = c.rest[1]
    const plan = PLAN_WORDS.find((p) => p === word)
    if (!plan) throw new CloudError('usage', 'teams set-plan <slug> team|business [--complimentary] (there is no downgrade to free)')
    if (t.plan === 'free') throw new CloudError('usage', `${t.slug} is a free team: it upgrades through a Paddle checkout from the dashboard (or teams link + an event), so billing and plan agree`)
    const comp = c.rest.includes('--complimentary'), force = c.rest.includes('--force')
    if (comp && t.subscription_id && ['active', 'trialing', 'past_due'].includes(t.sub_status ?? '') && !force) {
      throw new CloudError('usage', `${t.slug} has a live Paddle subscription (${t.subscription_id}, ${t.sub_status}): cancel it in Paddle first, or --force`)
    }
    const limits = planOf(plan)
    updateTeam(cloud.db, t.id, { plan, ...(comp ? { sub_status: 'complimentary', grace_until: null, delete_after: null } : {}) })
    if (comp) cloud.db.query("UPDATE jobs SET done_at = ?, last_error = 'cancelled: complimentary' WHERE team_id = ? AND kind IN ('grace_check', 'delete') AND done_at IS NULL").run(Date.now(), t.id)
    audit(cloud.db, { actor: c.actor, action: 'team.plan_set', teamId: t.id, detail: { from: t.plan, plan, complimentary: comp || undefined, storage_gb: limits.storageGb, disk_gb: limits.diskGb } })
    console.log(`${t.slug}: ${plan}${comp ? ' (complimentary)' : ''} — ${limits.storageGb} GB of files (product quota), directory capped at ${limits.diskGb} GB on the host, ${limits.cpus} vCPU / ${limits.memoryMb} MiB`)
    if (plan === 'business') console.error(`note: Business includes ${limits.storageGb} GB of files; a host's data volume is shared by all its teams (Terraform host_data_gb, 100 GB on the current hosts): grow the volume before this team fills it (review finding 24)`)
    // the new limits reach the container through a recreate (the running control plane's job loop)
    if (t.host && ['active', 'past_due', 'suspended'].includes(t.status)) {
      const where = await hostPresence(cloud, t)
      if (where === 'gone') {
        console.log(`${t.slug}: its host ${t.host} is gone: the plan applies when it is provisioned again (teams retry ${t.slug} --reset-host)`)
        return 0
      }
      cloud.enqueue('limits', t.id)
      console.log(`${t.slug}: new limits queued (the control plane makes the container again on the same data within seconds)`)
    } else {
      console.log(`${t.slug}: ${t.status}${t.host ? '' : ', no host yet'}: the plan applies when it is provisioned`)
    }
    return 0
  },
}

export const teamsExec: ControlCommand = {
  name: 'teams exec',
  help: `  teams exec <slug> -- <tdrive args…>    the product CLI inside the team's container (e.g. people reset-link <name>,
                                          the SSO way back in). Audited (the command's first two words, not its arguments)`,
  async run(c) {
    const t = c.team()
    const i = c.rest.indexOf('--')
    const args = i >= 0 ? c.rest.slice(i + 1) : c.rest.slice(1)
    if (!args.length) throw new CloudError('usage', 'teams exec <slug> -- <tdrive args…>')
    if (!t.host || !['active', 'past_due', 'suspended'].includes(t.status)) throw new CloudError('not_running', `${t.slug} has no instance`)
    audit(c.cloud.db, { actor: c.actor, action: 'team.exec', teamId: t.id, detail: { command: args.slice(0, 2).join(' ') } })
    const r = await c.cloud.driver.exec(t.host, t.slug, args)
    if (r.stdout) process.stdout.write(r.stdout)
    if (r.stderr) process.stderr.write(r.stderr)
    return r.code
  },
}
