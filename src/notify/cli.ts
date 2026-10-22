// CLI subcommands of the notify stream; src/cli.ts falls through to notifyCommand for anything it does not know.
import fs from 'node:fs'
import type { DB } from '../db'
import { makeCtx } from '../session'
import { person, StoreError } from '../store'
import { listAnchors, parseAnchor, verifyAgainst } from './anchor'
import { maskedConfig, setNotifyConfig } from './config'
import { attachNotify } from './index'
import type { Lang } from './messages'

export const NOTIFY_HELP = `  audit verify --against <anchor-file>   check the log against an anchor sent out earlier (.json or the email)
  audit anchor [--force]                 sign the audit chain head now and send it out
  audit anchors                          anchors made so far
  connections list [--all]               token, person, client, IP, last used (--all: revoked tokens too)
  connections revoke <token-id>          revoke now: the next request with that token fails
  notify contact <person> [--email E] [--slack WEBHOOK_URL] [--lang en|ko]
  notify inbox <person> [--all] [--read] in-app notifications (--read marks them read)
  notify show | notify set <key> <json>  settings in <data>/notify.json (e.g. notify set bulkRead.files 500)
  notify flush                           send pending notifications now`

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  if (i < 0) return undefined
  const v = args[i + 1]
  if (v === undefined || v.startsWith('--')) throw new StoreError(`${name} needs a value`)
  args.splice(i, 2)
  return v
}
function bool(args: string[], name: string): boolean {
  const i = args.indexOf(name)
  if (i >= 0) args.splice(i, 1)
  return i >= 0
}
const iso = (t: number | null | undefined) => t ? new Date(t).toISOString().replace(/\.\d+Z$/, 'Z') : '-'

/** Runs `cmd` ("connections list" …) if it is ours. Returns false when it is not. */
export async function notifyCommand(db: DB, dataDir: string, cmd: string, argv: string[]): Promise<boolean> {
  const rest = [...argv]
  const need = (v: string | undefined, what: string) => { if (!v) throw new StoreError(`missing ${what}`); return v }
  const rt = () => attachNotify(makeCtx(db, dataDir))
  switch (cmd) {
    case 'connections list': {
      const rows = rt().connections.list({ includeRevoked: bool(rest, '--all') })
      if (!rows.length) { console.log('no connections recorded'); return true }
      console.log(['token', 'person', 'client', 'ip', 'last used', 'requests', ''].join('\t'))
      for (const r of rows) {
        const client = `${r.client_name || '?'}${r.client_version ? ' ' + r.client_version : ''} (${r.ua_product || 'no user-agent'})`
        console.log([`${r.token_id} ${r.token_name}`, r.person, client, r.ip || '-', iso(r.last_seen), r.requests, r.revoked_at ? 'REVOKED' : ''].join('\t'))
      }
      return true
    }
    case 'connections revoke': {
      const id = Number(need(rest[0], 'token id'))
      const n = rt()
      const done = n.connections.revoke(id)
      await n.flush()
      console.log(done ? `revoked token ${id}; its next request fails` : `token ${id} does not exist or is already revoked`)
      return true
    }
    case 'audit anchor': {
      const r = await rt().anchorNow({ force: bool(rest, '--force') })
      if (!r) console.log('audit chain unchanged since the last anchor (use --force to anchor anyway)')
      else console.log(`anchored ${r.anchor.anchor.count} rows, head ${r.anchor.anchor.head}${r.file ? `\nwritten to ${r.file}` : ''}`)
      return true
    }
    case 'audit anchors': {
      for (const a of listAnchors(db)) console.log([iso(a.at), `${a.count} rows`, a.head, a.file ?? ''].join('\t'))
      return true
    }
    case 'audit verify': {
      const file = need(flag(rest, '--against'), '--against <anchor-file>')
      const r = verifyAgainst(db, dataDir, parseAnchor(fs.readFileSync(file, 'utf8')))
      if (r.ok) console.log(`audit log matches the anchor of ${iso(r.anchor.at)} (${r.anchor.count} rows, head ${r.anchor.head})`)
      else { console.log(`AUDIT LOG DOES NOT MATCH the anchor of ${iso(r.anchor.at)}:`); for (const p of r.problems) console.log(`  - ${p}`) }
      process.exitCode = r.ok ? 0 : 1
      return true
    }
    case 'notify contact': {
      const p = person(db, need(rest[0], 'person'))
      const email = flag(rest, '--email'), slack = flag(rest, '--slack'), lang = flag(rest, '--lang')
      if (lang && lang !== 'en' && lang !== 'ko') throw new StoreError('lang must be en or ko')
      if (slack && !/^https:\/\//.test(slack)) throw new StoreError('the Slack webhook must be an https URL')
      const n = rt().notifier
      n.setContact(p.id, { email, slack_webhook: slack, lang: lang as Lang | undefined })
      const c = n.contact(p.id)
      console.log(`${p.name}: email ${c?.email ?? '-'}, slack ${c?.slack_webhook ? 'set' : '-'}, lang ${c?.lang ?? 'default'}`)
      return true
    }
    case 'notify inbox': {
      const p = person(db, need(rest[0], 'person'))
      const all = bool(rest, '--all'), read = bool(rest, '--read')
      const n = rt().notifier
      const rows = n.inbox(p.id, { unreadOnly: !all })
      for (const r of rows) console.log([iso(r.updated_at), r.kind, r.count, r.link, r.read_at ? 'read' : 'unread'].join('\t'))
      if (!rows.length) console.log('no notifications')
      if (read) n.markRead(p.id)
      return true
    }
    case 'notify show': console.log(JSON.stringify(maskedConfig(rt().cfg), null, 2)); return true
    case 'notify set': {
      const c = setNotifyConfig(dataDir, need(rest[0], 'key'), need(rest[1], 'value'))
      console.log(JSON.stringify(maskedConfig(c), null, 2))
      return true
    }
    case 'notify flush': {
      const r = await rt().flush()
      console.log(`sent ${r.sent}, held by rate limit ${r.held}, failed ${r.failed}`)
      return true
    }
  }
  return false
}
