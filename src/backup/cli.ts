#!/usr/bin/env bun
// `<name> backup …` subcommands. Wire into src/cli.ts as:
//   case 'backup': process.exitCode = await backupCommand(rest, { dataDir }); return
// (rest = the arguments after "backup", with --data already taken). Also runs on its own:
//   bun src/backup/cli.ts [--data DIR] [backup] <keygen|target|run|list|verify|restore> …
import fs from 'node:fs'
import path from 'node:path'
import { CLI, defaultDataDir, ENV_PREFIX } from '../config'
import { detectLayout } from '../layout'
import { BackupError, generateKey, fingerprint, parsePublic, parseSecret, type SecretKey } from './crypto'
import { DEFAULT_KEEP, NOT_BACKED_UP, readConfig, readRecipient, restoreArchive, runConfigured, verifyArchive, writeConfig, type CheckReport } from './index'
import { parseTarget, isArchiveName } from './target'

export const BACKUP_HELP = `usage: ${CLI} [--data DIR] backup <command>

  keygen [--set] [--recipient-out FILE]
        make a new backup key pair. The SECRET key is printed once on stdout and never stored; keep it offline
        (password manager, printed copy in a safe). --set stores the PUBLIC key in the data folder so backups use it.
  target set <DIR | s3://bucket/prefix> [--keep N] [--allow-same-disk]
  target show
        where scheduled backups go (a folder on an external disk; S3-compatible storage is not available in v0.1)
  run [--to DIR] [--recipient KEY|FILE] [--keep N] [--allow-same-disk] [--if-configured]
        make one encrypted backup now (the scheduled job runs this with --if-configured)
  list [--to DIR]
  verify <ARCHIVE> [--key-file FILE|-]
        decrypt and check everything (needs the secret key)
  restore <ARCHIVE> --into NEW_DIR [--key-file FILE|-] [--layout installed|flat]
        restore into a new, empty data folder (needs the secret key)

The secret key is read from --key-file (a file, or - for stdin) or $${ENV_PREFIX}_BACKUP_KEY.
Not backed up: ${NOT_BACKED_UP.join('; ')}.`

interface Io { out: (s: string) => void; err: (s: string) => void; stdin?: () => Promise<string> }

function take(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  if (i < 0) return undefined
  const v = args[i + 1]
  if (v === undefined || (v.startsWith('--') && v !== '-')) throw new BackupError('config', `${name} needs a value`)
  args.splice(i, 2)
  return v
}
function flag(args: string[], name: string): boolean {
  const i = args.indexOf(name)
  if (i >= 0) args.splice(i, 1)
  return i >= 0
}
function noExtra(args: string[], max: number) {
  const unknown = args.find((a) => a.startsWith('--'))
  if (unknown) throw new BackupError('config', `unknown option ${unknown}`)
  if (args.length > max) throw new BackupError('config', `unexpected argument ${args[max]}`)
}
const positiveInt = (v: string | undefined, name: string) => {
  if (v === undefined) return undefined
  if (!/^\d+$/.test(v) || Number(v) < 1) throw new BackupError('config', `${name} must be a positive number`)
  return Number(v)
}

async function readSecret(args: string[], io: Io): Promise<SecretKey> {
  const file = take(args, '--key-file')
  let text: string | undefined
  if (file === '-') text = await (io.stdin ?? (() => Bun.stdin.text()))()
  else if (file) text = fs.readFileSync(file, 'utf8')
  else text = process.env[`${ENV_PREFIX}_BACKUP_KEY`]
  if (!text) throw new BackupError('config', `the secret backup key is needed: --key-file FILE, --key-file - (stdin) or $${ENV_PREFIX}_BACKUP_KEY`)
  return parseSecret(text.trim().split(/\s+/)[0] ?? '')
}

function recipientArg(v: string): Uint8Array {
  if (v.includes('_bkpub1_')) return parsePublic(v)
  return parsePublic(fs.readFileSync(v, 'utf8'))
}

function printReport(r: CheckReport, io: Io) {
  io.out(`made:      ${r.info.createdAt} on ${r.info.host} (${r.info.product} ${r.info.productVersion}, ${r.info.layout} layout)`)
  io.out(`content:   ${r.files} files, ${r.bytes} bytes (database + ${r.draftFiles} draft contents)`)
  if (r.db) io.out(`database:  integrity ${r.db.integrity}; ${r.db.drafts} drafts, ${r.db.versions} versions, ${r.db.auditRows} audit rows, audit head ${r.db.auditHead ?? '-'}`)
  io.out(`not in the backup: ${r.info.excludes.join('; ')}`)
}

export async function backupCommand(argv: string[], o: { dataDir: string; io?: Io }): Promise<number> {
  const io: Io = o.io ?? { out: (s) => console.log(s), err: (s) => console.error(s) }
  const args = [...argv]
  const cmd = args.shift()
  const layout = () => detectLayout(o.dataDir)
  try {
    switch (cmd) {
      case undefined: case 'help': case '--help': case '-h':
        io.out(BACKUP_HELP)
        return cmd ? 0 : 2

      case 'keygen': {
        const set = flag(args, '--set')
        const out = take(args, '--recipient-out')
        noExtra(args, 0)
        const k = generateKey()
        if (out) fs.writeFileSync(out, k.publicText + '\n', { mode: 0o644 })
        if (set) {
          const l = layout()
          const old = readRecipient(l)
          fs.mkdirSync(path.dirname(l.backupRecipient), { recursive: true, mode: 0o755 })
          fs.writeFileSync(l.backupRecipient, k.publicText + '\n', { mode: 0o644 })
          if (old) io.err(`replaced the backup key ${fingerprint(old)}: older backups still need the OLD secret key`)
        }
        io.err(`backup key ${fingerprint(k.key.publicKey)}. The secret key below is shown ONCE and is not stored anywhere.`)
        io.err('Without it no backup can be restored. Keep it offline (password manager, printed copy in a safe).')
        io.out(k.secretText)
        io.err(`public key (safe to store on the server): ${k.publicText}`)
        return 0
      }

      case 'target': {
        const sub = args.shift()
        const l = layout()
        if (sub === 'show') {
          noExtra(args, 0)
          const c = readConfig(l)
          const r = readRecipient(l)
          io.out(`target:  ${c.target ?? '(none: scheduled backups are skipped)'}`)
          io.out(`keep:    newest ${c.keep}`)
          io.out(`key:     ${r ? fingerprint(r) : `(none: run \`${CLI} backup keygen --set\`)`}`)
          return 0
        }
        if (sub !== 'set') throw new BackupError('config', 'usage: backup target set <DIR|s3://…> | backup target show')
        const keep = positiveInt(take(args, '--keep'), '--keep')
        const same = flag(args, '--allow-same-disk')
        noExtra(args, 1)
        const spec = args[0]
        if (!spec) throw new BackupError('config', 'backup target set needs a folder or s3:// URL')
        const t = parseTarget(spec, { dataDir: l.dataDir, allowSameDisk: same })
        const c = readConfig(l)
        writeConfig(l, { target: spec, keep: keep ?? c.keep ?? DEFAULT_KEEP, ...(same ? { allowSameDisk: true } : {}) })
        io.out(`backups go to ${t.description}, newest ${keep ?? c.keep} kept`)
        return 0
      }

      case 'run': {
        const to = take(args, '--to')
        const rec = take(args, '--recipient')
        const keep = positiveInt(take(args, '--keep'), '--keep')
        const same = flag(args, '--allow-same-disk')
        const ifConfigured = flag(args, '--if-configured')
        noExtra(args, 0)
        const l = layout()
        if (ifConfigured && !to && (!readConfig(l).target || !(rec || readRecipient(l)))) {
          io.out('backup: not configured (no target or no key), skipped')
          return 0
        }
        const r = await runConfigured(o.dataDir, { target: to, recipient: rec ? recipientArg(rec) : undefined, keep, allowSameDisk: same || undefined })
        io.out(`backup written: ${r.location} (${r.bytes} bytes)`)
        io.out(`  database ${r.dbBytes} bytes, ${r.draftFiles} draft files (${r.draftBytes} bytes)`)
        if (r.pruned.length) io.out(`  removed ${r.pruned.length} older backup(s): ${r.pruned.join(', ')}`)
        for (const w of r.warnings) io.err(`  warning: ${w}`)
        io.out(`NOT backed up: ${NOT_BACKED_UP[0]}.`)
        return 0
      }

      case 'list': {
        const to = take(args, '--to')
        noExtra(args, 0)
        const l = layout()
        const spec = to ?? readConfig(l).target
        if (!spec) throw new BackupError('config', 'no backup target configured (use --to DIR)')
        const t = parseTarget(spec, { dataDir: l.dataDir, allowSameDisk: true })
        const names = await t.list()
        for (const n of names) io.out(n)
        if (!names.length) io.err(`no backups in ${t.description}`)
        return 0
      }

      case 'verify': {
        const key = await readSecret(args, io)
        noExtra(args, 1)
        const file = args[0]
        if (!file) throw new BackupError('config', 'backup verify needs an archive file')
        const r = await verifyArchive(file, key)
        printReport(r, io)
        if (!r.ok) {
          for (const p of r.problems) io.err(`PROBLEM: ${p}`)
          return 1
        }
        io.out('verify: ok (every byte authenticated, all checksums match, database integrity ok)')
        return 0
      }

      case 'restore': {
        const key = await readSecret(args, io)
        const into = take(args, '--into')
        const kind = take(args, '--layout')
        if (kind && kind !== 'installed' && kind !== 'flat') throw new BackupError('config', '--layout is installed or flat')
        noExtra(args, 1)
        const file = args[0]
        if (!file || !into) throw new BackupError('config', 'usage: backup restore <ARCHIVE> --into NEW_DIR')
        const r = await restoreArchive(file, key, into, { layout: kind as 'installed' | 'flat' | undefined })
        printReport(r, io)
        io.out(`restored into ${r.dataDir} (${r.layout} layout)`)
        io.out(`The registered folders' original files are not in a backup; check that the NAS shares are reachable at the same paths.`)
        io.out(`The backup key is not restored: put the public key back with \`${CLI} backup keygen --set\` (new key) or copy config/backup-recipient.`)
        return 0
      }

      default:
        if (cmd && isArchiveName(path.basename(cmd))) throw new BackupError('config', `did you mean \`backup verify ${cmd}\`?`)
        io.err(`unknown backup command: ${cmd}\n\n${BACKUP_HELP}`)
        return 2
    }
  } catch (e) {
    if (e instanceof BackupError) {
      io.err(`backup: ${e.message}`)
      return e.code === 'config' ? 2 : 1
    }
    if ((e as { code?: string }).code === 'ENOENT' || (e as { code?: string }).code === 'EACCES') {
      io.err(`backup: ${(e as Error).message}`)
      return 1
    }
    throw e
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const i = args.indexOf('--data')
  let dataDir = defaultDataDir()
  if (i >= 0) { dataDir = args[i + 1] ?? dataDir; args.splice(i, 2) }
  if (args[0] === 'backup') args.shift()
  process.exitCode = await backupCommand(args, { dataDir })
}
