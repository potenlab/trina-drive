// OS isolation for worker processes (plan 6: "추출·셸 작업자는 모두 격리한다").
//   macOS: sandbox-exec with a deny-by-default profile: no network, no exec except the runtime (and listed tools), reads
//          only the runtime, the worker code, system libraries and explicitly granted paths, writes only the job dir.
//   Linux: bwrap (all namespaces unshared, so no network and no other processes; fresh /proc; read-only binds of the
//          system libraries, the runtime and the grants; the job dir read-write; nothing else exists).
//   none:  plain subprocess. Callers that require isolation refuse to run (see ExecutorConfig.requireIsolation).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ENV_PREFIX, NAME } from '../config'

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

/**
 * What a Linux worker sees of the system besides its grants: shared libraries and read-only data, never a folder of
 * binaries (no /bin, /usr/bin, /sbin: the worker can start only the runtime and its execPaths, as on macOS), never
 * /home, /root, /var, /data or the rest of /etc. Merged-/usr links (/lib -> usr/lib) are recreated as links.
 */
export const LINUX_SYSTEM_READ = ['/usr/lib', '/usr/lib64', '/usr/lib32', '/usr/share', '/lib', '/lib64', '/lib32', '/etc/ld.so.cache', '/etc/localtime', '/etc/fonts']

const under = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith('/') ? dir : dir + '/')

/**
 * bwrap arguments (Linux): every namespace unshared (user, mount, pid, net, ipc, uts, cgroup), so no network (a fresh
 * loopback only) and no view of other processes; a fresh /proc for the worker's own pid namespace (no /proc/<server pid>);
 * all capabilities dropped; NO_NEW_PRIVS (bwrap sets it); killed with the server (--die-with-parent); its own session
 * (no TIOCSTI on the server's terminal). The root is an empty tmpfs made read-only at the end: only the system set above,
 * the runtime, the grants and execPaths are bound read-only, the job dir read-write.
 */
export function bwrapArgs(spec: SandboxSpec, system: string[] = LINUX_SYSTEM_READ): string[] {
  const args = ['--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--proc', '/proc', '--dev', '/dev']
  const covered: string[] = []
  for (const p of system) {
    let st: fs.Stats
    try { st = fs.lstatSync(p) } catch { continue }
    if (st.isSymbolicLink()) { args.push('--symlink', fs.readlinkSync(p), p); covered.push(p) }
    else { args.push('--ro-bind', p, p); covered.push(p) }
  }
  for (const p of new Set([spec.runtime, ...spec.readPaths, ...spec.execPaths])) {
    if (covered.some((c) => under(p, c))) continue
    args.push('--ro-bind', p, p)
  }
  // the job dir last (it may sit below a granted folder), then the empty root becomes read-only (binds keep their mode)
  args.push('--bind', spec.workDir, spec.workDir, '--chdir', spec.workDir, '--remount-ro', '/')
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
let detectProblem: string | null = null
/** The strongest isolation that actually works here (tried once, then cached). */
export function detectIsolation(): Isolation {
  if (detected) return detected
  detected = 'none'
  if (process.platform === 'darwin' && fs.existsSync(SANDBOX_EXEC)) {
    const r = Bun.spawnSync([SANDBOX_EXEC, '-p', '(version 1)(allow default)(deny network*)', '/usr/bin/true'], { stdout: 'ignore', stderr: 'ignore' })
    if (r.exitCode === 0) detected = 'sandbox-exec'
    else detectProblem = 'sandbox-exec failed'
  } else if (process.platform === 'linux') {
    const r = probeBwrap()
    if (r === null) detected = 'bwrap'
    else detectProblem = r
  } else detectProblem = `no sandbox for ${process.platform}`
  return detected
}

/**
 * Starts the runtime once under the same bwrap arguments a worker gets (user + net namespaces, fresh /proc, read-only
 * root), so a host that allows a plain `bwrap` but not this sandbox (e.g. Docker's masked /proc) is not reported as
 * isolated. Null when it works, else why not.
 */
export function probeBwrap(runtime = process.execPath): string | null {
  const bw = findOnPath('bwrap')
  if (!bw) return 'bwrap (bubblewrap) is not installed'
  let dir: string | null = null
  try {
    dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'bwrap-probe-'))
    const real = fs.realpathSync(runtime)
    const r = Bun.spawnSync([bw, ...bwrapArgs({ workDir: dir, readPaths: [], execPaths: [], runtime: real }), '--', real, '--version'], { stdout: 'pipe', stderr: 'pipe', env: { PATH: '/usr/bin:/bin' } })
    if (r.exitCode === 0) return null
    return `bwrap cannot build the worker sandbox here: ${r.stderr.toString().trim().split('\n')[0]?.slice(0, 300) || `exit ${r.exitCode}`}`
  } catch (e) {
    return `bwrap probe failed: ${(e as Error).message}`
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Why there is no isolation (null when there is): the probe's error and, inside the container image (<PREFIX>_CONTAINER
 * set by the Dockerfile), where the settings that allow bwrap are documented.
 */
export function isolationProblem(): string | null {
  if (detectIsolation() !== 'none') return null
  const hint = process.env[`${ENV_PREFIX}_CONTAINER`] === 'docker'
    ? ` In Docker the container needs the security settings of docker-compose.yml: security_opt seccomp=docker/seccomp-bwrap.json, apparmor=${NAME}-bwrap (load docker/apparmor-${NAME}-bwrap on the host first) and systempaths=unconfined. See docs/DOCKER.md, "Security settings".`
    : process.platform === 'linux' ? ' Install bubblewrap and allow unprivileged user namespaces (docs/DOCKER.md, "Security settings").' : ''
  return `${(detectProblem ?? 'no sandbox available').replace(/[.\s]+$/, '')}.${hint}`
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
