#!/usr/bin/env bun
// Admin CLI. Usage: bun run src/cli.ts [--data DIR] <command> …   (run without arguments for help)
import { verifyAudit } from './audit'
import { defaultDataDir, NAME, VERSION } from './config'
import { backupCommand } from './backup/cli'
import { openDb } from './db'
import { seedDemo } from './demo'
import { TOOLS } from './extract'
import { serve } from './mcp'
import { listEvents, listQuarantine, releaseQuarantine } from './inplace/events'
import { addShareRoot, reconcile, shareRoots, startReconciler, summary } from './inplace/reconcile'
import { listWidened, rejudgeWidened } from './inplace/widened'
import { issueSetupToken } from './web/auth'
import { serveWeb } from './web/server'
import { makeCtx, Session } from './session'
import { runShell } from './shell'
import { closeDefaultExecutor } from './worker'
import { addGroup, addMember, addPerson, createToken, grantManage, LEVELS, parseDuration, person, registerFolder, revokeToken, setFlag, setRule, StoreError, verifyToken, type LevelName, type NasReaders } from './store'
import { notifyCommand, NOTIFY_HELP } from './notify/cli'
import { MCP_HELP, mcpCommand, ttyPassword } from './client/mcp'
import { attachNotify } from './notify'
import { readPublicSettings } from './oauth/settings'
import { PUBLIC_HELP, publicCommand } from './web/public-cli'
import { publicBanner, startPublicListener } from './web/public'

const HELP = `${NAME} ${VERSION} — permission-aware read shell and draft box for AI agents (phase-0 prototype)

usage: ${NAME} [--data DIR] <command>

  init                                   create the data directory; prints the one-time web setup token
  person add <name> [--admin]
  group add <name>
  group member <group> <person>
  folder register <path> [--name N] [--personal-owner P] [--nas-readers all|unknown|p1,p2]
  folder flag <path> no-ai|quarantine|widened-pending|inherit-break [--off]
  rule set <path> <person|@group> none|read|write [--break]
  manage grant <path> <person>
  token create <person> [--name N] [--scope path1,path2] [--read-only] [--ttl 8h]
  token revoke <id>                      (same as connections revoke)
  audit verify
${NOTIFY_HELP}
  demo seed                              sample company tree, people, rules and tokens
  sh --token <pat> -c <command>          run one shell command as that token (audited)
  serve [--port 8787] [--host 127.0.0.1] [--allow-origin URL] [--public-url URL]   web admin at /, MCP at /mcp
  backup …                 (encrypted backups; see: backup help)
${PUBLIC_HELP}

on your own computer (talks to the server; writes only user-scope client settings):
${MCP_HELP}

in-place reconciler (outside changes, R1 ⑤–⑦, R6, R10):
  share add <path> | share list          also index this whole share (identity + hash only), not just registered folders
  reconcile once [--json]                one pass: walk, diff, quarantine, hash, mirror, widened drafts
  reconcile watch [--every 5m] [--no-watch-hint]
  events list [--kind K] [--limit N]
  quarantine list [--all] | quarantine release <id> --by <person>   (moved/lost: admin; widened: admin or source manager)
  widened list | widened rejudge         NAS copies of drafts; re-judge after rule / group / NAS-reader changes

data directory: --data, $${NAME.toUpperCase()}_HOME, or ~/.${NAME}`

function takeFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  if (i < 0) return undefined
  const v = args[i + 1]
  if (v === undefined || v.startsWith('--')) throw new StoreError(`${name} needs a value`)
  args.splice(i, 2)
  return v
}
function takeBool(args: string[], name: string): boolean {
  const i = args.indexOf(name)
  if (i >= 0) args.splice(i, 1)
  return i >= 0
}

async function main(argv: string[]) {
  const args = [...argv]
  const dataDir = takeFlag(args, '--data') ?? defaultDataDir()
  const [cmd, sub] = args
  const single = ['init', 'sh', 'serve'].includes(cmd ?? '')
  const rest = args.slice(single ? 1 : 2)
  if (!cmd || cmd === 'help' || cmd === '--help') return console.log(HELP)
  // backup works on a data directory (and may run as root via launchd/sudo): never open or create a database for it
  if (cmd === 'backup') { process.exitCode = await backupCommand(args.slice(1), { dataDir }); return }
  // mcp add runs on a person's computer: no data directory there
  if (cmd === 'mcp') { process.exitCode = await mcpCommand(args.slice(1), { env: process.env, out: console.log, err: console.error, promptPassword: ttyPassword, stdinIsTTY: !!process.stdin.isTTY }); return }
  const db = openDb(dataDir)
  const need = (v: string | undefined, what: string) => { if (!v) throw new StoreError(`missing ${what}`); return v }

  switch (single ? cmd : `${cmd} ${sub ?? ''}`.trim()) {
    case 'init': {
      attachNotify(makeCtx(db, dataDir))
      console.log(`data directory ready: ${dataDir}`)
      const setup = issueSetupToken(db)
      if (setup) console.log(`web setup token (one use, 7 days; paste it on the first web page to create the admin):\n${setup}`)
      else console.log('web setup is already done (an admin can sign in)')
      return
    }
    case 'person add': { const admin = takeBool(rest, '--admin'); addPerson(db, need(rest[0], 'name'), admin); return console.log(`added ${rest[0]}${admin ? ' (admin)' : ''}`) }
    case 'group add': addGroup(db, need(rest[0], 'group name')); return console.log(`added group ${rest[0]}`)
    case 'group member': addMember(db, need(rest[0], 'group'), need(rest[1], 'person')); return console.log(`${rest[1]} is in ${rest[0]}`)
    case 'folder register': {
      const name = takeFlag(rest, '--name'), owner = takeFlag(rest, '--personal-owner'), nas = takeFlag(rest, '--nas-readers')
      const nasReaders: NasReaders | undefined = nas === undefined ? undefined : nas === 'all' || nas === 'unknown' ? nas : nas.split(',')
      const f = registerFolder(db, need(rest[0], 'path'), { name, personalOwner: owner, nasReaders })
      return console.log(`registered /${f.mount_name} -> ${f.path} (id ${f.id}, NAS readers: ${f.nas_readers})`)
    }
    case 'folder flag': {
      const off = takeBool(rest, '--off')
      const flag = need(rest[1], 'flag').replace(/-/g, '_') as 'no_ai' | 'quarantine' | 'widened_pending' | 'inherit_break'
      if (!['no_ai', 'quarantine', 'widened_pending', 'inherit_break'].includes(flag)) throw new StoreError(`unknown flag ${rest[1]}`)
      setFlag(db, need(rest[0], 'path'), flag, !off)
      return console.log(`${rest[1]} ${off ? 'off' : 'on'} for ${rest[0]}`)
    }
    case 'rule set': {
      const brk = takeBool(rest, '--break')
      const level = need(rest[2], 'level') as LevelName
      if (!(level in LEVELS)) throw new StoreError('level must be none, read or write')
      setRule(db, need(rest[0], 'path'), need(rest[1], 'person or @group'), level, { breakInherit: brk })
      return console.log(`rule: ${rest[1]} ${level} on ${rest[0]}${brk ? ' (inheritance broken here)' : ''}`)
    }
    case 'manage grant': grantManage(db, need(rest[0], 'path'), need(rest[1], 'person')); return console.log(`${rest[1]} manages ${rest[0]}`)
    case 'token create': {
      const name = takeFlag(rest, '--name'), scope = takeFlag(rest, '--scope'), ttl = takeFlag(rest, '--ttl')
      const readOnly = takeBool(rest, '--read-only')
      const t = createToken(db, need(rest[0], 'person'), { name, scope: scope?.split(','), readOnly, ttlMs: ttl ? parseDuration(ttl) : undefined })
      console.error(`token ${t.id} for ${rest[0]}${scope ? ` (scope: ${scope})` : ''}${readOnly ? ' read-only' : ''}${ttl ? ` expires in ${ttl}` : ''}; shown once:`)
      return console.log(t.token)
    }
    case 'token revoke': return notifyCommand(db, dataDir, 'connections revoke', rest)
    case 'audit verify': {
      if (rest.includes('--against')) return notifyCommand(db, dataDir, 'audit verify', rest)
      const r = verifyAudit(db)
      console.log(r.ok ? `audit chain ok: ${r.rows} rows, head ${r.head}` : `AUDIT CHAIN BROKEN at row ${r.brokenAt} (after ${r.rows} good rows)`)
      process.exitCode = r.ok ? 0 : 1
      return
    }
    case 'demo seed': {
      const { root, tokens } = seedDemo(db, dataDir)
      console.log(`sample company tree: ${root}`)
      console.log('people: dion (admin), kim, boss (경영), lee (인사), park (영업)')
      console.log(`kim token:                    ${tokens.kim.token}`)
      console.log(`boss token:                   ${tokens.boss.token}`)
      console.log(`boss token (프로젝트 only):    ${tokens.bossNarrow.token}`)
      const setup = issueSetupToken(db)
      if (setup) console.log(`web setup token (sign up as dion): ${setup}`)
      return
    }
    case 'sh': {
      const pat = need(takeFlag(rest, '--token'), '--token')
      const c = need(takeFlag(rest, '-c'), '-c <command>')
      const token = verifyToken(db, pat, 'cli')
      if (!token) throw new StoreError('invalid, expired or revoked token')
      const ctx = makeCtx(db, dataDir)
      const notify = attachNotify(ctx)
      notify.connections.seen(token, { clientName: `${NAME} cli`, clientVersion: VERSION, userAgent: `${NAME}-cli/${VERSION}`, ip: 'local' })
      const s = new Session(ctx, token)
      // one command, then exit: the isolated executor's warm workers must not keep this process alive
      const r = await runShell(s, c).finally(closeDefaultExecutor)
      s.commit('bash', c, `exit ${r.exitCode}`)
      await notify.flush()
      process.stdout.write(r.stdout)
      process.stderr.write(r.stderr)
      process.exitCode = r.exitCode
      return
    }
    case 'share add': return console.log(`share root: ${addShareRoot(db, need(rest[0], 'path'))}`)
    case 'share list': for (const r of shareRoots(db)) console.log(r.path); return
    case 'reconcile once': {
      const json = takeBool(rest, '--json')
      // extraction workers would keep a one-shot process alive
      const r = await reconcile(db, { dataDir }).finally(closeDefaultExecutor)
      return console.log(json ? JSON.stringify(r, null, 2) : summary(r))
    }
    case 'reconcile watch': {
      const every = takeFlag(rest, '--every')
      const watch = !takeBool(rest, '--no-watch-hint')
      startReconciler(db, { dataDir, intervalMs: every ? parseDuration(every) : undefined, watch, log: (s) => console.log(`${new Date().toISOString()} ${s}`) })
      console.log(`reconciling every ${every ?? '5m'}${watch ? ' (+ fs.watch hints)' : ''}; Ctrl-C to stop`)
      return new Promise(() => {})
    }
    case 'events list': {
      const kind = takeFlag(rest, '--kind'), limit = takeFlag(rest, '--limit')
      for (const e of listEvents(db, { kind, limit: limit ? Number(limit) : undefined }).reverse()) {
        console.log(`#${e.id} ${new Date(e.at).toISOString()} ${e.kind} ${e.old_path ? `${e.old_path} -> ` : ''}${e.path ?? ''} ${e.detail !== '{}' ? e.detail : ''}`.trimEnd())
      }
      return
    }
    case 'quarantine list': {
      for (const q of listQuarantine(db, { all: takeBool(rest, '--all') })) {
        console.log(`${q.id}\t${q.kind}\t${q.item}\t${q.path}\t${q.reason}${q.released_at ? `\treleased ${new Date(q.released_at).toISOString()}` : ''}`)
      }
      return
    }
    case 'quarantine release': {
      const by = need(takeFlag(rest, '--by'), '--by <person>')
      releaseQuarantine(db, Number(need(rest[0], 'quarantine id')), person(db, by).id)
      return console.log(`released ${rest[0]}`)
    }
    case 'widened list': {
      for (const w of listWidened(db)) console.log(`${w.id}\t${w.status}\t${w.widening ? 'widening' : 'not widening'}\tdraft ${w.draft_id} v${w.draft_version}\t${w.match} ${Math.round(w.overlap * 100)}%\t${w.path}`)
      return
    }
    case 'widened rejudge': { const r = rejudgeWidened(db); return console.log(`judged ${r.judged}, now pending: ${r.flipped.length}`) }
    case 'serve': {
      const every = takeFlag(rest, '--reconcile-every'), noReconcile = takeBool(rest, '--no-reconcile')
      const port = Number(takeFlag(rest, '--port') ?? 8787)
      const host = takeFlag(rest, '--host') ?? '127.0.0.1'
      const origin = takeFlag(rest, '--allow-origin')
      const publicUrl = takeFlag(rest, '--public-url')
      if (!TOOLS.rg) throw new StoreError('ripgrep (rg) is required: brew install ripgrep')
      if (!TOOLS.pdftotext) console.error('warning: pdftotext not found (brew install poppler); PDFs will not be readable')
      const ctx = makeCtx(db, dataDir)
      const notify = attachNotify(ctx)
      notify.start()
      const { server, w } = serveWeb(ctx, port, host, { allowedOrigins: origin ? [origin] : [], publicUrl, onRequest: notify.onMcpRequest, emit: notify.emit })
      console.log(`${NAME} ${VERSION} web: http://${host}:${server.port}/   MCP endpoint: http://${host}:${server.port}/mcp   (data: ${dataDir})`)
      // the public listener (plan 5.2): a separate port for the tunnel, only when `public enable` was run and the gate passes
      const pub = startPublicListener(w)
      if (pub.server) console.log(publicBanner(readPublicSettings(db), pub.server.port ?? 0))
      else if (readPublicSettings(db).enabled) console.error(`public listener NOT started (gate):\n${pub.gate.checks.filter((c) => !c.ok && c.required).map((c) => `  - ${c.text}`).join('\n')}\n(see: public status)`)
      console.log(`tools: rg=${TOOLS.rg} pdftotext=${TOOLS.pdftotext ?? 'missing'}`)
      if (!noReconcile) startReconciler(db, { dataDir, intervalMs: every ? parseDuration(every) : undefined })
      return new Promise(() => {})
    }
    default:
      if (cmd === 'public' && publicCommand(db, sub, rest)) return
      if (await notifyCommand(db, dataDir, `${cmd} ${sub ?? ''}`.trim(), rest)) return
      console.error(`unknown command: ${args.join(' ')}\n\n${HELP}`)
      process.exitCode = 2
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((e) => {
    if (e instanceof StoreError || (e as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE' || (e as { code?: string }).code === 'ENOENT') { console.error(`error: ${(e as Error).message}`); process.exit(1) }
    throw e
  })
}
export { main }
