// Console-side admin commands (workstream D1). Registered through ./index.ts; every one is audited as admin:$USER.
//   members list <slug>              who is in the team (console view), open invites, sync state
//   members sync <slug>              send the team's members to its drive now (member sync v2)
//   sso keys | sso rotate | sso activate <kid> | sso retire <kid>     SSO signing keys (sso.ts: rotation steps)
//   users reset-totp <email>         a lost phone and lost recovery codes (after checking who asks); signs them out
//   access list [--all]              early-access requests from /signup
import { audit } from '../audit'
import { CloudError } from '../cloud'
import { invitePublicId } from '../invites'
import type { ControlCommand } from './types'

const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z') : '-')

export const consoleCommands: ControlCommand[] = [
  {
    name: 'members list', help: '  members list <slug>                     console members, open invites, member-sync state',
    run({ cloud, team }) {
      const t = team()
      for (const m of cloud.members.list(t.id)) console.log(`${m.role.padEnd(7)} ${m.email.padEnd(36)} ${m.public_id}  ${m.totp ? '2fa' : '   '}  synced ${iso(m.synced_at)}`)
      for (const i of cloud.invites.open(t.id)) console.log(`${'invited'.padEnd(7)} ${i.email.padEnd(36)} ${invitePublicId(i.id)}  ${i.role}  expires ${iso(i.expires_at)}`)
      const r = cloud.db.query<{ sync_seq: number; sync_applied_seq: number | null; sync_at: number | null; sync_error: string | null; sync_unmanaged: string | null }, [number]>('SELECT sync_seq, sync_applied_seq, sync_at, sync_error, sync_unmanaged FROM teams WHERE id = ?').get(t.id)!
      console.log(`\nsync: seq ${r.sync_seq}, drive applied ${r.sync_applied_seq ?? '-'} at ${iso(r.sync_at)}${cloud.sync.behind(t) ? ', BEHIND' : ''}${r.sync_error ? `\n  last error: ${r.sync_error}` : ''}${r.sync_unmanaged ? `\n  unmanaged on the drive: ${r.sync_unmanaged}` : ''}`)
      return 0
    },
  },
  {
    name: 'members sync', help: '  members sync <slug>                     send the members to the team\'s drive now',
    async run({ cloud, team, actor }) {
      const t = team()
      if (!cloud.cfg.sso) throw new CloudError('usage', 'SSO is off (TDCLOUD_SSO=0): nothing to sync')
      audit(cloud.db, { actor, action: 'sync.manual', teamId: t.id })
      const r = await cloud.sync.run(t, { force: true })
      console.log(JSON.stringify(r))
      return 0
    },
  },
  {
    name: 'sso keys', help: '  sso keys                                SSO signing keys and their state (active, next, retired)',
    run({ cloud }) {
      for (const k of cloud.sso.list()) console.log(`${k.kid.padEnd(5)} ${k.state.padEnd(8)} ${k.public_key}  created ${iso(k.created_at)}${k.activated_at ? `  active since ${iso(k.activated_at)}` : ''}${k.retired_at ? `  retired ${iso(k.retired_at)}` : ''}`)
      if (!cloud.sso.list().length) console.log('(none yet: made on the first provision or sign-in)')
      return 0
    },
  },
  { name: 'sso rotate', help: '  sso rotate                              publish a new key (then teams upgrade --all, then sso activate)', async run({ cloud, actor }) { const kid = await cloud.sso.rotate(actor); console.log(`${kid} published (not signing). Next: teams upgrade --all, then sso activate ${kid}`); return 0 } },
  { name: 'sso activate', help: '  sso activate <kid>                      sign with a published key', run({ cloud, actor, rest }) { if (!rest[0]) throw new CloudError('usage', 'sso activate <kid>'); cloud.sso.activate(rest[0], actor); console.log(`${rest[0]} signs now`); return 0 } },
  { name: 'sso retire', help: '  sso retire <kid>                        stop publishing an old key (after every team restarted)', run({ cloud, actor, rest }) { if (!rest[0]) throw new CloudError('usage', 'sso retire <kid>'); cloud.sso.retire(rest[0], actor); console.log(`${rest[0]} retired; it leaves the teams' env on their next recreate`); return 0 } },
  {
    name: 'users reset-totp', help: '  users reset-totp <email>                remove two-step verification (lost phone + codes); signs them out',
    run({ cloud, actor, rest }) {
      const u = rest[0] ? cloud.db.query<{ id: number }, [string]>('SELECT id FROM users WHERE email = ?').get(rest[0].toLowerCase()) : null
      if (!u) throw new CloudError('usage', `no account ${rest[0] ?? '(give an email)'}`)
      cloud.mfa.reset(u.id, actor)
      console.log(`${rest[0]}: two-step verification removed, sessions signed out; they set it up again at the next sign-in`)
      return 0
    },
  },
  {
    name: 'access list', help: '  access list [--all]                     early-access requests from /signup (--all: handled ones too)',
    run({ cloud, rest }) {
      const all = rest.includes('--all')
      const rows = cloud.db.query<{ id: number; email: string; team_name: string; team_size: string | null; plan: string | null; note: string | null; created_at: number; handled_at: number | null }, []>(`SELECT * FROM access_requests ${all ? '' : 'WHERE handled_at IS NULL'} ORDER BY id`).all()
      for (const r of rows) console.log(`${String(r.id).padEnd(5)} ${iso(r.created_at)}  ${r.email.padEnd(32)} ${r.team_name}  (${r.team_size ?? '?'}${r.plan ? `, ${r.plan}` : ''})${r.note ? `\n      ${r.note.replace(/\n/g, ' ').slice(0, 200)}` : ''}`)
      if (!rows.length) console.log('(none)')
      return 0
    },
  },
]
