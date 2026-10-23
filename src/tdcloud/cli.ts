// CLI commands of Trina Cloud mode (workstream B1), registered through src/cli-registry.ts:
//   cloud sync-members --json B64 | --stdin   the console's member sync (docs/SSO-CONTRACT.md), one JSON line out
//   cloud usage --json                        people, AI use and storage for the console (hourly)
//   people reset-link NAME [--break-glass]    emergency way in when the console is down: a one-time reset link
//   cloud my-files [--dry-run] [--url URL]    backfill My files (B2): one for every active member, leavers' to Former members
import { appendAudit } from '../audit'
import { ENV_PREFIX } from '../config'
import type { CliCommand, CliContext } from '../cli-registry'
import type { DB } from '../db'
import { usage } from '../managed/ops'
import { storageSettings } from '../managed/settings'
import { mailerFor } from '../notify/channels'
import { loadNotifyConfig } from '../notify/config'
import { readPublicSettings } from '../oauth/settings'
import { createLink, RESET_TTL_MS } from '../web/auth'
import { OutboxMailer, RelayMailer, type Mailer } from '../web/mail'
import { notify } from '../web/notices'
import { ensureWebSchema } from '../web/schema'
import { cloudConfigFromEnv, cloudConfig } from './config'
import { afterReconcile, reconcileMyFiles } from './my-files'
import { applySync, decodePayload } from './sync'

export const BREAK_GLASS_MS = 24 * 3600_000

/** The mail sender the server would use (SMTP / SES from notify.json or the environment), else the outbox file. */
export function cliMailer(dataDir: string): Mailer {
  try {
    const cfg = loadNotifyConfig(dataDir)
    const m = ['smtp', 'ses'].includes(cfg.email.mode) ? mailerFor(cfg.email, dataDir) : null
    if (m) return new RelayMailer(m, cfg.email.from)
  } catch (e) { console.error(`[tdcloud] mail config: ${(e as Error).message}`) }
  return new OutboxMailer(dataDir, true)
}

/** The team's own address for links in mail: --url, <PREFIX>_PUBLIC_URL, or the public address of `public enable`. */
function teamUrl(db: DB, args: string[]): string {
  const i = args.indexOf('--url')
  const v = (i >= 0 ? args[i + 1] : undefined) ?? process.env[`${ENV_PREFIX}_PUBLIC_URL`] ?? readPublicSettings(db).url ?? ''
  return v.replace(/\/$/, '')
}

async function readStdin(): Promise<string> { return await new Response(Bun.stdin.stream()).text() }

const syncMembers: CliCommand = {
  name: 'cloud sync-members',
  help: '  cloud sync-members --json B64 | --stdin   apply the Trina Cloud console\'s member list (one JSON line out)',
  run: async ({ db, dataDir, args, out }: CliContext) => {
    const line = (o: unknown) => out(JSON.stringify(o))
    const cfg = cloudConfig(db) ?? cloudConfigFromEnv()
    if (!cfg) { line({ ok: false, error: 'not_cloud', message: `${ENV_PREFIX}_CLOUD_ISSUER, _TEAM and _SSO_KEYS are not set` }); return 1 }
    const j = args.indexOf('--json')
    let raw: unknown
    if (j >= 0 && args[j + 1]) raw = decodePayload(args[j + 1]!, true)
    else if (args.includes('--stdin')) raw = decodePayload(await readStdin(), false)
    else { line({ ok: false, error: 'bad_json', message: 'give --json <base64url JSON> or --stdin' }); return 1 }
    const r = await applySync({ db, cfg, mailer: cliMailer(dataDir), baseUrl: teamUrl(db, args), dataDir }, raw)
    line(r)
    return r.ok ? 0 : 1
  },
}

/** `cloud usage --json`: what the console shows and bills by. ai_people_30d = people whose agent (a token) did something in 30 days. */
export function cloudUsage(db: DB, dataDir: string, now = Date.now()) {
  const u = usage(db)
  const one = (sql: string, ...p: number[]) => Number(db.query<{ n: number | null }, number[]>(sql).get(...p)?.n ?? 0)
  return {
    people: one('SELECT count(*) AS n FROM people WHERE active = 1'),
    ai_people_30d: one('SELECT count(DISTINCT person_id) AS n FROM audit WHERE token_id IS NOT NULL AND at > ?', now - 30 * 86400_000),
    files_bytes: u.files, trash_bytes: u.trash, versions_bytes: u.versions,
    quota_bytes: storageSettings(db, dataDir).quotaBytes,
    last_activity_at: db.query<{ n: number | null }, []>("SELECT max(at) AS n FROM audit WHERE tool != 'cloud'").get()?.n ?? null,
  }
}

const usageCmd: CliCommand = {
  name: 'cloud usage',
  help: '  cloud usage --json                        people, AI use and storage, one JSON line (for the Trina Cloud console)',
  run: ({ db, dataDir, out }) => { out(JSON.stringify(cloudUsage(db, dataDir))) },
}

/**
 * The emergency way in (the console is down, or nobody can sign in): a one-time reset link for one person, printed
 * here only (it is not mailed: the operator hands it over). Audited, and every admin is told. Under TDRIVE_SSO_ONLY a
 * console-managed person may then use that password for 24 hours with --break-glass (otherwise sign-in still says
 * "use Trina Cloud").
 */
const resetLink: CliCommand = {
  name: 'people reset-link',
  help: '  people reset-link NAME|EMAIL [--break-glass] [--url URL]   one-time password link (emergency; audited, all admins told)',
  run: async ({ db, dataDir, args, out, err }) => {
    ensureWebSchema(db)
    const who = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--url')
    if (!who) { err('people reset-link: give a name or mail address'); return 2 }
    const p = db.query<{ id: number; name: string; active: number; email: string | null }, [string, string]>(
      'SELECT p.id, p.name, p.active, a.email FROM people p LEFT JOIN accounts a ON a.person_id = p.id WHERE p.name = ? OR a.email = ? COLLATE NOCASE LIMIT 1').get(who, who)
    if (!p) { err(`no person ${who}`); return 1 }
    if (!p.active) { err(`${p.name} is deactivated`); return 1 }
    if (!p.email) { err(`${p.name} has no sign-in address`); return 1 }
    const breakGlass = args.includes('--break-glass')
    let secret = ''
    db.transaction(() => {
      secret = createLink(db, 'reset', p.id, null)
      if (breakGlass) db.query('UPDATE accounts SET password_ok_until = ? WHERE person_id = ?').run(Date.now() + BREAK_GLASS_MS, p.id)
      appendAudit(db, { personId: null, tokenId: null, tool: 'cli', command: `people reset-link ${p.name}${breakGlass ? ' --break-glass (password sign-in allowed for 24 h)' : ''}`, files: [], outcome: 'ok' })
    })()
    const base = teamUrl(db, args)
    const admins = db.query<{ id: number }, []>('SELECT id FROM people WHERE admin = 1 AND active = 1').all().map((x) => x.id)
    await notify({ db, mailer: cliMailer(dataDir), baseUrl: base }, new Set([...admins, p.id]), 'break_glass', '/#/people')
    out(`reset link for ${p.name} (valid ${RESET_TTL_MS / 60_000} minutes, once${breakGlass ? '; password sign-in allowed for 24 hours' : ''}):\n${base}/#/reset/${secret}`)
  },
}

/**
 * `cloud my-files`: what the sync and every sign-in do anyway, for everyone at once — for teams that existed before My
 * files (run once after the upgrade), and to repair. --dry-run only counts. One JSON line out.
 */
const myFilesCmd: CliCommand = {
  name: 'cloud my-files',
  help: '  cloud my-files [--dry-run] [--url URL]     give every active member a My files folder, move leavers\' to Former members (one JSON line)',
  run: async ({ db, dataDir, args, out }) => {
    const line = (o: unknown) => out(JSON.stringify(o))
    if (!cloudConfig(db)) { line({ ok: false, error: 'not_cloud', message: `${ENV_PREFIX}_CLOUD_ISSUER, _TEAM and _SSO_KEYS are not set` }); return 1 }
    if (storageSettings(db, dataDir).mode !== 'managed') { line({ ok: false, error: 'not_managed', message: 'My files live in managed storage; this drive is in-place' }); return 1 }
    ensureWebSchema(db)
    if (args.includes('--dry-run')) {
      const missing = db.query<{ name: string }, []>(`SELECT p.name FROM people p JOIN accounts a ON a.person_id = p.id WHERE p.active = 1 AND a.cloud_user IS NOT NULL
        AND p.id NOT IN (SELECT person_id FROM cloud_my_files WHERE state = 'mine') ORDER BY p.name`).all().map((p) => p.name)
      const leaving = db.query<{ name: string }, []>(`SELECT DISTINCT p.name FROM people p JOIN cloud_my_files c ON c.person_id = p.id WHERE p.active = 0 AND c.state = 'mine' ORDER BY p.name`).all().map((p) => p.name)
      line({ ok: true, dry_run: true, without_my_files: missing, to_former_members: leaving })
      return 0
    }
    const r = reconcileMyFiles(db, dataDir)
    await afterReconcile({ db, mailer: cliMailer(dataDir), baseUrl: teamUrl(db, args) }, r)
    if (r.created || r.adopted || r.restored || r.transferred)
      appendAudit(db, { personId: null, tokenId: null, tool: 'cli', command: `cloud my-files: ${r.created} created, ${r.adopted} adopted, ${r.restored} restored, ${r.transferred} moved to former members`, files: [], outcome: 'ok' })
    line({ ok: !r.failed.length, created: r.created, adopted: r.adopted, restored: r.restored, transferred: r.transferred, failed: r.failed })
    return r.failed.length ? 1 : 0
  },
}

export const cloudCommands: CliCommand[] = [syncMembers, usageCmd, resetLink, myFilesCmd]
