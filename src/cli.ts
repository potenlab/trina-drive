#!/usr/bin/env bun
// Admin CLI. Usage: bun run src/cli.ts [--data DIR] <command> …   (run without arguments for help)
import { verifyAudit } from './audit'
import { defaultDataDir, NAME, VERSION } from './config'
import { backupCommand } from './backup/cli'
import { openDb } from './db'
import { seedDemo } from './demo'
import { TOOLS } from './extract'
import { serve } from './mcp'
import { makeCtx, Session } from './session'
import { runShell } from './shell'
import { addGroup, addMember, addPerson, createToken, grantManage, LEVELS, parseDuration, registerFolder, setFlag, setRule, StoreError, verifyToken, type LevelName, type NasReaders } from './store'
import { notifyCommand, NOTIFY_HELP } from './notify/cli'
import { attachNotify } from './notify'

const HELP = `${NAME} ${VERSION} — permission-aware read shell and draft box for AI agents (phase-0 prototype)

usage: ${NAME} [--data DIR] <command>

  init                                   create the data directory
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
  serve [--port 8787] [--host 127.0.0.1] [--allow-origin URL]
  backup …                 (encrypted backups; see: backup help)

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
  const db = openDb(dataDir)
  const need = (v: string | undefined, what: string) => { if (!v) throw new StoreError(`missing ${what}`); return v }

  switch (single ? cmd : `${cmd} ${sub ?? ''}`.trim()) {
    case 'init': attachNotify(makeCtx(db, dataDir)); return console.log(`data directory ready: ${dataDir}`)
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
      const r = await runShell(s, c)
      s.commit('bash', c, `exit ${r.exitCode}`)
      await notify.flush()
      process.stdout.write(r.stdout)
      process.stderr.write(r.stderr)
      process.exitCode = r.exitCode
      return
    }
    case 'serve': {
      const port = Number(takeFlag(rest, '--port') ?? 8787)
      const host = takeFlag(rest, '--host') ?? '127.0.0.1'
      const origin = takeFlag(rest, '--allow-origin')
      if (!TOOLS.rg) throw new StoreError('ripgrep (rg) is required: brew install ripgrep')
      if (!TOOLS.pdftotext) console.error('warning: pdftotext not found (brew install poppler); PDFs will not be readable')
      const ctx = makeCtx(db, dataDir)
      const notify = attachNotify(ctx)
      notify.start()
      const server = serve(ctx, port, host, { allowedOrigins: origin ? [origin] : [], onRequest: notify.onMcpRequest })
      console.log(`${NAME} ${VERSION} MCP endpoint: http://${host}:${server.port}/mcp   (data: ${dataDir})`)
      console.log(`tools: rg=${TOOLS.rg} pdftotext=${TOOLS.pdftotext ?? 'missing'}`)
      return new Promise(() => {})
    }
    default:
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
