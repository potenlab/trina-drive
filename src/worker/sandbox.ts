// OS isolation for worker processes (plan 6: "추출·셸 작업자는 모두 격리한다").
//   macOS: sandbox-exec with a deny-by-default profile: no network, no exec except the runtime (and listed tools), reads
//          only the runtime, the worker code, system libraries and explicitly granted paths, writes only the job dir.
//   Linux: bwrap (all namespaces unshared, so no network; read-only binds of the same set; the job dir read-write).
//   none:  plain subprocess. Callers that require isolation refuse to run (see ExecutorConfig.requireIsolation).
import fs from 'node:fs'
import path from 'node:path'

export type Isolation = 'none' | 'sandbox-exec' | 'bwrap'

export interface SandboxSpec {
  /** The job's private directory: the only writable place, and the worker's cwd/HOME/TMPDIR. */
  workDir: string
  /** Files or directories the worker may read (runtime, worker code, node_modules, granted inputs). Absolute, real paths. */
  readPaths: string[]
  /** Directories whose entry names (not contents) the worker may list: the folder holding node_modules, for module
   *  resolution. Never a folder of team files: names alone can be secret. */
  listPaths?: string[]
  /** Executables the worker may start besides the runtime (e.g. pdftotext for PDF extraction). */
  execPaths: string[]
  /** The runtime binary (bun). */
  runtime: string
}

const SANDBOX_EXEC = '/usr/bin/sandbox-exec'

/** System locations a runtime needs to start (dynamic libraries, ICU, time zones). They hold no team data. */
const MAC_SYSTEM_READ = ['/usr/lib', '/usr/share', '/System/Library', '/System/Volumes/Preboot/Cryptexes', '/private/var/db/dyld', '/private/var/db/timezone', '/Library/Preferences/Logging']
const MAC_SYSTEM_READ_LITERAL = ['/', '/dev/null', '/dev/zero', '/dev/random', '/dev/urandom', '/private/etc/localtime',
  // the /etc, /var, /tmp symlinks and their targets' parents, so /etc/localtime resolves (local time in ls -l, date)
  '/etc', '/var', '/tmp', '/private', '/private/etc', '/private/var', '/private/var/db']

/** sysctl names a worker may read (a trailing dot = prefix). */
const SYSCTL_READ = ['hw.', 'machdep.cpu.', 'machdep.ptrauth_enabled', 'vm.', 'sysctl.proc_cputype', 'sysctl.proc_native', 'sysctl.proc_translated',
  'kern.osrelease', 'kern.ostype', 'kern.osversion', 'kern.osproductversion', 'kern.osvariant_status', 'kern.version', 'kern.boottime',
  'kern.hostname', 'kern.maxfiles', 'kern.maxfilesperproc', 'kern.argmax', 'kern.ngroups', 'kern.secure_kernel', 'kern.bootargs', 'kern.usrstack64', 'kern.monotonicclock']

const q = (s: string) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'

function ancestors(p: string): string[] {
  const out: string[] = []
  let d = path.dirname(p)
  while (d !== '/' && d !== '.') { out.push(d); d = path.dirname(d) }
  return out
}

/** sandbox-exec profile (SBPL). Deny by default; everything allowed is listed here. */
export function macProfile(spec: SandboxSpec): string {
  const reads = [...new Set([spec.runtime, ...spec.readPaths])]
  const metaOnly = [...new Set([...reads, spec.workDir].flatMap(ancestors))].filter((a) => !reads.includes(a))
  const lines = [
    '(version 1)',
    '(deny default)',
    // the worker itself, and nothing else unless listed
    `(allow process-exec (literal ${q(spec.runtime)})${spec.execPaths.map((p) => ` (literal ${q(p)})`).join('')})`,
    spec.execPaths.length ? '(allow process-fork)' : '',
    '(allow signal (target self))',
    // only what a runtime asks about the machine; not kern.proc* / kern.procargs* (other processes' argv and environment)
    `(allow sysctl-read ${SYSCTL_READ.map((n) => n.endsWith('.') ? `(sysctl-name-prefix ${q(n)})` : `(sysctl-name ${q(n)})`).join(' ')})`,
    `(allow file-read* ${MAC_SYSTEM_READ.map((p) => `(subpath ${q(p)})`).join(' ')} ${MAC_SYSTEM_READ_LITERAL.map((p) => `(literal ${q(p)})`).join(' ')})`,
    `(allow file-read* ${reads.map((p) => `(subpath ${q(p)})`).join(' ')})`,
    // module resolution stats the folders above the code; it learns that they exist, not what is in them
    metaOnly.length ? `(allow file-read-metadata ${metaOnly.map((p) => `(literal ${q(p)})`).join(' ')})` : '',
    spec.listPaths?.length ? `(allow file-read-data ${spec.listPaths.map((p) => `(literal ${q(p)})`).join(' ')})` : '',
    `(allow file-read* file-write* (subpath ${q(spec.workDir)}))`,
    '(allow file-write-data (literal "/dev/null"))',
    // explicit, though (deny default) already covers them
    '(deny network*)',
    '(deny mach-lookup)',
  ]
  return lines.filter(Boolean).join('\n') + '\n'
}

/** bwrap arguments (Linux). Untested on this Mac; kept small and conservative. */
export function bwrapArgs(spec: SandboxSpec): string[] {
  const args = ['--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp']
  for (const p of ['/usr', '/lib', '/lib64', '/bin', '/etc/ld.so.cache', '/etc/localtime', '/etc/ssl']) args.push('--ro-bind-try', p, p)
  for (const p of new Set([spec.runtime, ...spec.readPaths, ...spec.execPaths])) args.push('--ro-bind', p, p)
  args.push('--bind', spec.workDir, spec.workDir, '--chdir', spec.workDir)
  return args
}

/** The argv that starts `argv` under the given isolation. */
export function wrapArgv(isolation: Isolation, spec: SandboxSpec, argv: string[]): string[] {
  switch (isolation) {
    case 'sandbox-exec': return [SANDBOX_EXEC, '-p', macProfile(spec), ...argv]
    case 'bwrap': return [findOnPath('bwrap')!, ...bwrapArgs(spec), '--', ...argv]
    case 'none': return argv
  }
}

function findOnPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '/usr/bin:/bin').split(':').concat(['/usr/bin', '/bin', '/usr/local/bin'])) {
    const p = path.join(dir, name)
    try { fs.accessSync(p, fs.constants.X_OK); return p } catch {}
  }
  return null
}

let detected: Isolation | null = null
/** The strongest isolation that actually works here (tried once, then cached). */
export function detectIsolation(): Isolation {
  if (detected) return detected
  detected = 'none'
  if (process.platform === 'darwin' && fs.existsSync(SANDBOX_EXEC)) {
    const r = Bun.spawnSync([SANDBOX_EXEC, '-p', '(version 1)(allow default)(deny network*)', '/usr/bin/true'], { stdout: 'ignore', stderr: 'ignore' })
    if (r.exitCode === 0) detected = 'sandbox-exec'
  } else if (process.platform === 'linux') {
    const bw = findOnPath('bwrap')
    if (bw) {
      const r = Bun.spawnSync([bw, '--unshare-all', '--die-with-parent', '--ro-bind', '/', '/', '/bin/true'], { stdout: 'ignore', stderr: 'ignore' })
      if (r.exitCode === 0) detected = 'bwrap'
    }
  }
  return detected
}

/** Resolve a dedicated worker user (e.g. `_shelfwork`) to uid/gid, or null if it does not exist. */
export function lookupUser(name: string): { uid: number; gid: number } | null {
  const id = (flag: string) => {
    const r = Bun.spawnSync(['/usr/bin/id', flag, name], { stdout: 'pipe', stderr: 'ignore' })
    const n = Number(r.stdout.toString().trim())
    return r.exitCode === 0 && Number.isInteger(n) ? n : null
  }
  const uid = id('-u'), gid = id('-g')
  return uid === null || gid === null ? null : { uid, gid }
}
