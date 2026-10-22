// Isolated executor (plan 5.1 "격리 실행기", 6, 7.1): untrusted work runs in a separate, sandboxed, short-lived process.
//   - a process serves one token only. A small pool of pre-started ("warm") processes hides the start-up cost; a warm
//     process has loaded code only, no job data. After a clean shell job the process may be kept a few seconds for the
//     same token's next shell command (that token saw the job's output anyway); it never goes to another token or
//     person, and never after a failure, a limit breach, an extraction or a job with extra read grants.
//   - per job: private temp dir (the only writable place, removed afterwards), wall-clock deadline, memory watchdog,
//     caps on what the worker may send; on any breach the whole process group is SIGKILLed.
//   - admission: limits per token, per person and overall with a fair queue (scheduler.ts).
//   - the permission decision never moves: a shell worker sees files only through FsBackend calls answered here.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Subprocess } from 'bun'
import { ENV_PREFIX } from '../config'
import { checkFromWorker, encodeFrame, FrameDecoder, PROTOCOL_VERSION, ProtocolError, type FromWorker, type JobSpec, type ToWorker, type WireDirent, type WireError, type WireStat } from './protocol'
import { memProbe } from './rss'
import { detectIsolation, isolationProblem, lookupUser, wrapArgv, type Isolation } from './sandbox'
import { Aborted, Busy, FairScheduler, type SchedulerLimits } from './scheduler'

// ---------- what the integrator implements ----------

export interface BackendStat { isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean; mode: number; size: number; mtime: Date }
export interface BackendDirent { name: string; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }

/**
 * The filesystem a shell worker sees: a subset of just-bash's IFileSystem, so the server's permission-filtered VirtualFs
 * (src/vfs.ts) can be passed as is. Errors with a string `code` (ENOENT, EROFS, ...) are passed to the shell; any other
 * error is a backend bug: it is logged and counted (RunStats.backendErrors), and the shell sees a fixed EIO for that
 * call (never the error's text, which may hold real paths). The job goes on, as it would in-process.
 */
export interface FsBackend {
  readFileBuffer(path: string): Promise<Uint8Array>
  writeFile(path: string, content: Uint8Array): Promise<void>
  appendFile(path: string, content: Uint8Array): Promise<void>
  exists(path: string): Promise<boolean>
  stat(path: string): Promise<BackendStat>
  lstat?(path: string): Promise<BackendStat>
  readdir(path: string): Promise<string[]>
  readdirWithFileTypes?(path: string): Promise<BackendDirent[]>
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>
  cp(src: string, dest: string, options?: { recursive?: boolean }): Promise<void>
  mv(src: string, dest: string): Promise<void>
  chmod(path: string, mode: number): Promise<void>
  utimes?(path: string, atime: Date, mtime: Date): Promise<void>
  symlink(target: string, linkPath: string): Promise<void>
  link(existingPath: string, newPath: string): Promise<void>
  readlink(path: string): Promise<string>
  realpath?(path: string): Promise<string>
}

export interface CommandResult { stdout: string; stderr: string; exitCode: number }

export interface ShellHooks {
  /**
   * Runs one backend call in the context of the command that made it. `cmd` is [name, ...args] of the innermost command
   * listed in ShellJob.wrap, or undefined. Use it to set read modes (raw bytes / weak provenance); it is a label from
   * the untrusted worker, so it must never widen what may be read.
   */
  withCommand?<T>(cmd: string[] | undefined, fn: () => Promise<T>): Promise<T>
  /** Runs a command listed in ShellJob.parentCommands (e.g. grep/rg on real ripgrep over the policy-filtered mirror). */
  runCommand?(name: string, args: string[], ctx: { cwd: string; stdin: Uint8Array; cmd?: string[] }): Promise<CommandResult>
}

// ---------- configuration and results ----------

export interface JobLimits {
  /** wall clock for the job (from job start, not counting the queue) */
  timeoutMs: number
  /** resident memory of the worker and everything it started */
  maxRssBytes: number
  /** largest single frame (header or body) the worker may send */
  maxFrameBytes: number
  /** everything the worker may send over the channel during the job */
  maxChannelBytes: number
  /** worker stderr kept for the log; past 16x this the worker is killed */
  maxLogBytes: number
}

export interface ExecutorConfig {
  /** 'auto' picks the strongest available (sandbox-exec on macOS, bwrap on Linux). */
  isolation?: Isolation | 'auto'
  /** Refuse to run jobs when no OS isolation is available (default true; plan 6). */
  requireIsolation?: boolean
  /** Dedicated unprivileged user for workers (e.g. `_tdrivework`). Needs the server to run as root (see docs/worker.md). */
  runAs?: string | null
  /** Refuse to run if runAs is set but cannot be applied (default false: run as the server user and report user: null). */
  requireRunAs?: boolean
  tmpRoot?: string
  /** pre-started workers kept ready (0 = always cold) */
  warm?: number
  /** warm workers kept for tokens with no other job running (default 1) */
  warmReserve?: number
  limits?: Partial<SchedulerLimits>
  defaults?: Partial<JobLimits>
  /** read-only grants for every worker: worker code, node_modules, extractor modules */
  codePaths?: string[]
  /** executables workers may start (e.g. pdftotext) */
  execPaths?: string[]
  runtime?: string
  entry?: string
  /** memory watchdog interval */
  pollMs?: number
  /**
   * Keep a worker after a clean shell job for the same token's next shell job (default on). false = one job per process.
   * idleMs: how long it waits (default 5 s); maxJobs: jobs per process (default 32); maxIdle: kept workers overall (default 4).
   */
  reuse?: false | { idleMs?: number; maxJobs?: number; maxIdle?: number }
  /** worker start-up deadline */
  bootTimeoutMs?: number
  /** load the shell engine at boot (default true); false for an executor that only extracts (faster cold start) */
  preloadShell?: boolean
}

export interface RunOptions extends Partial<JobLimits> {
  /** fairness keys */
  token: string
  person: string
  backend?: FsBackend
  hooks?: ShellHooks
  /** attachment sent with the job (e.g. document bytes for extraction) */
  body?: Uint8Array
  /** extra read-only paths for this job (forces a fresh worker with its own sandbox profile) */
  readPaths?: string[]
  /** extra executables this job may start, e.g. pdftotext for one PDF (forces a fresh worker with its own profile) */
  execPaths?: string[]
  signal?: AbortSignal
}

export type RunStatus =
  | 'ok'          // job finished; value/body hold the result
  | 'error'       // job threw inside the worker (error holds the message)
  | 'timeout' | 'memory' | 'output'   // killed for a limit
  | 'crashed'     // worker died or broke the protocol
  | 'busy'        // refused at admission (token queue full)
  | 'aborted'     // caller's signal
  | 'refused'     // isolation required but not available

export interface RunStats { queuedMs: number; startMs: number; runMs: number; totalMs: number; warm: boolean; peakRssBytes: number; fsCalls: number; pid: number
  /** the worker had already run a job for this token */
  reused: boolean
  /** backend calls (fs or parent-run command) that threw something other than an fs error; answered with EIO */
  backendErrors: number }

export interface RunResult<T = unknown> {
  status: RunStatus
  value?: T
  body?: Uint8Array
  error?: WireError | Error
  isolation: Isolation
  user: string | null
  stats: RunStats
  /** worker stderr (capped) */
  log: string
}

const DEFAULT_LIMITS: JobLimits = {
  timeoutMs: 20_000,
  maxRssBytes: 512 << 20,
  maxFrameBytes: 32 << 20,
  maxChannelBytes: 256 << 20,
  maxLogBytes: 16 << 10,
}

const HERE = import.meta.dir
const REPO = path.resolve(HERE, '../..')

function realOrNull(p: string): string | null { try { return fs.realpathSync(p) } catch { return null } }

/** Default read grants: the worker code and its dependencies, never the whole checkout (it may hold a data dir). */
export function defaultCodePaths(): string[] {
  return ['src', 'node_modules', 'package.json', 'tsconfig.json', 'bunfig.toml'].map((p) => realOrNull(path.join(REPO, p))).filter((p): p is string => !!p)
}

/** Reads an external tool needs (its binary and, for Homebrew installs, the library folders). */
export function toolReadPaths(bin: string): string[] {
  const real = realOrNull(bin)
  if (!real) return []
  // the path as configured (often a symlink, e.g. /opt/homebrew/bin/x) and its target
  const out = [...new Set([bin, real])]
  for (const prefix of ['/opt/homebrew', '/usr/local']) if (real.startsWith(prefix + '/')) out.push(...['Cellar', 'opt', 'lib'].map((d) => realOrNull(path.join(prefix, d))).filter((p): p is string => !!p))
  return out
}

// ---------- one worker process ----------

type KillReason = 'timeout' | 'memory' | 'output' | 'crashed' | 'aborted' | 'done'

class Worker {
  readonly proc: Subprocess<'pipe', 'pipe', 'pipe'>
  readonly ready: Promise<void>
  readonly exited: Promise<number>
  readonly startedAt = performance.now()
  killReason: KillReason | null = null
  backendErrors = 0
  peakRss = 0
  fsCalls = 0
  log = ''
  /** jobs sent to this process, and the token they belong to (set by the first job; a process never changes token) */
  jobs = 0
  owner: string | null = null
  private logBytes = 0
  private channelBytes = 0
  private inFlight = 0
  private markReady!: () => void
  private failReady!: (e: Error) => void
  private onDone: ((m: Extract<FromWorker, { t: 'done' }>, body?: Uint8Array) => void) | null = null
  private backend: FsBackend | null = null
  private hooks: ShellHooks = {}
  /** commands the job allows the worker to ask the parent to run */
  private parentCommands = new Set<string>()
  /** false once the job is over: late requests are not served (they could land after the caller commits) */
  private serving = true
  private readonly inFlightCalls = new Set<Promise<unknown>>()
  limits: JobLimits = DEFAULT_LIMITS
  private disposed = false
  private readonly decoder = new FrameDecoder<FromWorker>(1 << 20, DEFAULT_LIMITS.maxFrameBytes)
  private readonly outDone: Promise<void>

  constructor(argv: string[], readonly dir: string, env: Record<string, string>, ids: { uid: number; gid: number } | null, private readonly onGone: (w: Worker) => void) {
    this.ready = new Promise((res, rej) => { this.markReady = res; this.failReady = rej })
    this.ready.catch(() => {})
    this.proc = Bun.spawn({
      cmd: argv, cwd: dir, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', detached: true,
      ...(ids ? { uid: ids.uid, gid: ids.gid } : {}),
    })
    this.exited = this.proc.exited.then((code) => {
      this.failReady(new Error(`worker exited during start-up (${code}): ${this.log.trim().slice(0, 500)}`))
      return code
    })
    this.outDone = this.readOut()
    void this.readErr()
  }

  get pid() { return this.proc.pid }

  setLimits(l: JobLimits) {
    this.limits = l
    this.decoder.maxHeader = Math.min(l.maxFrameBytes, 1 << 20)
    this.decoder.maxBody = l.maxFrameBytes
  }

  /** Sends the job; resolves with the worker's `done` message, or null if it died first. */
  run(job: JobSpec, body: Uint8Array | undefined, backend: FsBackend | null, hooks: ShellHooks) {
    this.jobs++
    // per-job state (a kept worker starts its next job from zero)
    this.log = ''; this.logBytes = 0; this.channelBytes = 0; this.peakRss = 0; this.fsCalls = 0; this.backendErrors = 0
    this.serving = true
    this.backend = backend
    this.hooks = hooks
    this.parentCommands = new Set(job.kind === 'shell' ? job.parentCommands ?? [] : [])
    const done = new Promise<{ m: Extract<FromWorker, { t: 'done' }>; body?: Uint8Array } | null>((resolve) => {
      this.onDone = (m, b) => resolve({ m, body: b })
      // the last frames may still be in the pipe when the exit is seen
      void Promise.all([this.exited, this.outDone]).then(() => resolve(null))
    })
    this.send({ t: 'job', v: PROTOCOL_VERSION, job }, body)
    return done
  }

  /** Stop serving requests and wait for the ones already running to finish. */
  async stopServing() {
    this.serving = false
    while (this.inFlightCalls.size) await Promise.allSettled([...this.inFlightCalls])
  }

  kill(reason: KillReason) {
    this.serving = false
    if (!this.killReason) this.killReason = reason
    killTree(this.pid)
  }

  /** Kill, wait for exit, remove the job dir. Safe to call twice. */
  async dispose() {
    if (this.disposed) return
    this.disposed = true
    this.kill(this.killReason ?? 'done')
    await this.exited
    killTree(this.pid) // anything that escaped into the group after the first kill
    try { fs.rmSync(this.dir, { recursive: true, force: true }) } catch {}
    this.onGone(this)
  }

  /** Resolves once the frame has left this process (a worker that stops reading its stdin holds it back here). */
  private send(h: ToWorker, body?: Uint8Array): Promise<void> {
    try {
      const w = this.proc.stdin.write(encodeFrame(h, body))
      const f = this.proc.stdin.flush()
      return Promise.all([w, f]).then(() => {}, () => {})
    } catch { return Promise.resolve() /* worker gone; exit handling reports it */ }
  }

  private async readOut() {
    const decoder = this.decoder
    try {
      for await (const chunk of this.proc.stdout) {
        this.channelBytes += chunk.byteLength
        if (this.channelBytes > this.limits.maxChannelBytes) { this.kill('output'); return }
        for (const f of decoder.push(chunk)) this.onFrame(f.h, f.body)
      }
    } catch (e) {
      this.kill(e instanceof ProtocolError && /too large/.test(e.message) ? 'output' : 'crashed')
    }
  }

  private async readErr() {
    const dec = new TextDecoder()
    try {
      for await (const chunk of this.proc.stderr) {
        this.logBytes += chunk.byteLength
        if (this.log.length < this.limits.maxLogBytes) this.log += dec.decode(chunk, { stream: true }).slice(0, this.limits.maxLogBytes - this.log.length)
        if (this.logBytes > this.limits.maxLogBytes * 16) { this.kill('output'); return }
      }
    } catch {}
  }

  private onFrame(h: FromWorker, body?: Uint8Array) {
    const bad = checkFromWorker(h)
    if (bad) { this.log += `\n[protocol] ${bad}\n`; this.kill('crashed'); return }
    switch (h.t) {
      case 'ready':
        if (h.v !== PROTOCOL_VERSION) { this.log += `\n[protocol] worker speaks v${h.v}\n`; this.kill('crashed'); return }
        this.markReady()
        return
      case 'done': {
        // anything after `done` (even in the same chunk) is ignored
        this.serving = false
        const cb = this.onDone
        this.onDone = null
        cb?.(h, body)
        return
      }
      case 'fs':
      case 'cmd': {
        if (!this.serving) return
        if (!this.backend && h.t === 'fs') return this.reply(h.id, { code: 'ENOSYS', message: 'no filesystem for this job' })
        if (h.t === 'cmd' && !this.parentCommands.has(h.name)) { this.log += `\n[protocol] command not offered: ${h.name.slice(0, 40)}\n`; this.kill('crashed'); return }
        if (++this.inFlight > 256) { this.log += '\n[protocol] too many requests in flight\n'; this.kill('crashed'); return }
        const p = this.serve(h, body).finally(() => { this.inFlight--; this.inFlightCalls.delete(p) })
        this.inFlightCalls.add(p)
      }
    }
  }

  private reply(id: number, error: WireError | null, value?: unknown, body?: Uint8Array): Promise<void> {
    if (!this.serving) return Promise.resolve()
    return this.send(error ? { t: 'reply', id, ok: false, error } : { t: 'reply', id, ok: true, value }, body)
  }

  /**
   * File contents for the worker are held in this process from the backend read until the pipe has taken them. At most
   * READS_IN_FLIGHT reads per worker run at once, and each holds its slot until its reply has left: a worker that asks for
   * many large files, or stops reading its stdin, cannot make the server buffer them (its own RSS cap is what bounds it).
   */
  private readSlots = READS_IN_FLIGHT
  private readWaiters: (() => void)[] = []
  private async readSlot(): Promise<() => void> {
    if (this.readSlots > 0) this.readSlots--
    else await new Promise<void>((r) => this.readWaiters.push(r))
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.readWaiters.shift()
      if (next) next()
      else this.readSlots++
    }
  }

  private async serve(h: Extract<FromWorker, { t: 'fs' | 'cmd' }>, body?: Uint8Array) {
    const withCmd = <T>(fn: () => Promise<T>) => this.hooks.withCommand ? this.hooks.withCommand(h.cmd, fn) : fn()
    try {
      if (h.t === 'cmd') {
        if (!this.hooks.runCommand) return this.reply(h.id, { code: 'ENOSYS', message: `${h.name}: not available` })
        const r = await withCmd(() => this.hooks.runCommand!(h.name, h.args, { cwd: h.cwd, stdin: body ?? new Uint8Array(), cmd: h.cmd }))
        return this.reply(h.id, null, { stdout: String(r.stdout), stderr: String(r.stderr), exitCode: Number(r.exitCode) | 0 })
      }
      this.fsCalls++
      if (h.op === 'read') {
        const release = await this.readSlot()
        try {
          if (!this.serving) return
          const r = await withCmd(() => fsCall(this.backend!, h.op, h.args, body)) as Uint8Array
          await this.reply(h.id, null, undefined, r)
        } finally { release() }
        return
      }
      const r = await withCmd(() => fsCall(this.backend!, h.op, h.args, body))
      if (r instanceof Uint8Array) this.reply(h.id, null, undefined, r)
      else this.reply(h.id, null, r)
    } catch (e) {
      // errno-style errors: a `code` property (server FsError), or just-bash's "ENOENT: ..." message convention
      const msg = (e as { message?: unknown })?.message
      const code = (e as { code?: unknown })?.code ?? (typeof msg === 'string' ? /^(E[A-Z]{2,})\b/.exec(msg)?.[1] : undefined)
      if (typeof code === 'string') {
        const err = e as { message?: unknown; path?: unknown }
        return this.reply(h.id, { code, message: String(err.message ?? code), path: typeof err.path === 'string' ? err.path : undefined })
      }
      if (e instanceof ArgError) return this.reply(h.id, { code: 'EINVAL', message: e.message })
      // a backend bug: logged here, a fixed answer there (the same whatever the path is, so it tells the worker nothing)
      this.backendErrors++
      onBackendError(h.t === 'fs' ? h.op : h.name, e)
      const p = h.t === 'fs' && typeof h.args[0] === 'string' ? h.args[0] : undefined
      this.reply(h.id, h.t === 'fs'
        ? { code: 'EIO', message: `EIO: input/output error${p ? `, ${h.op} '${p.slice(0, 4096)}'` : ''}`, path: p }
        : { code: 'EIO', message: 'input/output error' })
    }
  }
}

class ArgError extends Error {}

/** File reads served to one worker at the same time (see Worker.readSlot). */
const READS_IN_FLIGHT = 2

/** Where backend bugs are reported (server log by default). */
let onBackendError = (what: string, e: unknown) => console.error(`[worker] backend error in ${what}:`, e)
export function setBackendErrorHandler(fn: (what: string, e: unknown) => void) { onBackendError = fn }

const str = (x: unknown, what = 'path'): string => { if (typeof x !== 'string' || x.length > 4096 || x.includes('\0')) throw new ArgError(`bad ${what}`); return x }
const bool = (x: unknown) => x === true
const num = (x: unknown): number => { if (typeof x !== 'number' || !Number.isFinite(x)) throw new ArgError('bad number'); return x }
const wstat = (s: BackendStat): WireStat => ({ isFile: !!s.isFile, isDirectory: !!s.isDirectory, isSymbolicLink: !!s.isSymbolicLink, mode: Number(s.mode) | 0, size: Number(s.size) || 0, mtimeMs: s.mtime instanceof Date ? s.mtime.getTime() : 0 })

/** One validated filesystem call against the backend. Returns a JSON value, or bytes for `read`. */
async function fsCall(b: FsBackend, op: string, a: unknown[], body?: Uint8Array): Promise<unknown> {
  switch (op) {
    case 'stat': return wstat(await b.stat(str(a[0])))
    case 'lstat': return wstat(await (b.lstat ?? b.stat).call(b, str(a[0])))
    case 'exists': return await b.exists(str(a[0]))
    case 'readdir': {
      const p = str(a[0])
      if (b.readdirWithFileTypes) return (await b.readdirWithFileTypes(p)).map((d): WireDirent => ({ name: String(d.name), isFile: !!d.isFile, isDirectory: !!d.isDirectory, isSymbolicLink: !!d.isSymbolicLink }))
      const names = await b.readdir(p)
      return Promise.all(names.map(async (name): Promise<WireDirent> => {
        const s = await b.stat(p.replace(/\/$/, '') + '/' + name)
        return { name, isFile: s.isFile, isDirectory: s.isDirectory, isSymbolicLink: s.isSymbolicLink }
      }))
    }
    case 'read': return new Uint8Array(await b.readFileBuffer(str(a[0])))
    case 'write': await b.writeFile(str(a[0]), body ?? new Uint8Array()); return null
    case 'append': await b.appendFile(str(a[0]), body ?? new Uint8Array()); return null
    case 'mkdir': await b.mkdir(str(a[0]), { recursive: bool(a[1]) }); return null
    case 'rm': await b.rm(str(a[0]), { recursive: bool(a[1]), force: bool(a[2]) }); return null
    case 'cp': await b.cp(str(a[0]), str(a[1]), { recursive: bool(a[2]) }); return null
    case 'mv': await b.mv(str(a[0]), str(a[1])); return null
    case 'chmod': await b.chmod(str(a[0]), num(a[1])); return null
    case 'utimes': if (b.utimes) await b.utimes(str(a[0]), new Date(num(a[1])), new Date(num(a[2]))); return null
    case 'symlink': await b.symlink(str(a[0], 'target'), str(a[1])); return null
    case 'link': await b.link(str(a[0]), str(a[1])); return null
    case 'readlink': return String(await b.readlink(str(a[0])))
    case 'realpath': { const p = str(a[0]); if (b.realpath) return String(await b.realpath(p)); await b.stat(p); return p }
    default: throw new ArgError(`unknown op ${op}`)
  }
}

/** SIGKILL the worker's process group and any descendants that left it. */
function killTree(pid: number) {
  const pids = memProbe()?.tree(pid)?.pids ?? []
  try { process.kill(-pid, 'SIGKILL') } catch {}
  for (const p of pids) { try { process.kill(p, 'SIGKILL') } catch {} }
}

// ---------- the executor ----------

export class Executor {
  readonly isolation: Isolation
  readonly user: string | null
  readonly warnings: string[] = []
  private readonly ids: { uid: number; gid: number } | null
  private readonly refusal: string | null
  private readonly scheduler: FairScheduler
  private readonly limits: JobLimits
  private readonly tmpRoot: string
  private readonly codePaths: string[]
  private readonly execPaths: string[]
  private readonly runtime: string
  private readonly entry: string
  private readonly warmTarget: number
  private readonly warmReserve: number
  private readonly pollMs: number
  private readonly bootTimeoutMs: number
  private readonly preloadShell: boolean
  private idle: Worker[] = []
  /** workers kept after a clean shell job, for the same token's next one (oldest first) */
  private kept: { w: Worker; timer: ReturnType<typeof setTimeout> }[] = []
  private readonly reuse: { idleMs: number; maxJobs: number; maxIdle: number } | null
  private booting = 0
  private live = new Set<Worker>()
  private active = new Set<Worker>()
  private watchdog: ReturnType<typeof setInterval> | null = null
  private spawnFailures = 0
  private lastBootLog = ''
  /** the server's time zone, so `ls -l` and `date` in a worker match the server */
  private readonly tz = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  private closed = false

  constructor(cfg: ExecutorConfig = {}) {
    const want = cfg.isolation ?? 'auto'
    this.isolation = want === 'auto' ? detectIsolation() : want
    let refusal: string | null = null
    if ((cfg.requireIsolation ?? true) && this.isolation === 'none') {
      const why = want === 'auto' ? isolationProblem() : null
      refusal = `no OS isolation is available (sandbox-exec on macOS, bwrap on Linux), and isolation is required${why ? `: ${why}` : ''}`
    }

    let ids: { uid: number; gid: number } | null = null
    let user: string | null = null
    if (cfg.runAs) {
      const found = lookupUser(cfg.runAs)
      if (!found) this.warnings.push(`worker user ${cfg.runAs} does not exist`)
      else if (process.getuid?.() !== 0) this.warnings.push(`worker user ${cfg.runAs} needs the server to start as root; running workers as the server user`)
      else { ids = found; user = cfg.runAs }
      if (!user && cfg.requireRunAs) refusal ??= `worker user ${cfg.runAs} could not be applied`
    }
    this.ids = ids
    this.user = user
    this.refusal = refusal

    const cpus = os.availableParallelism?.() ?? os.cpus().length
    this.scheduler = new FairScheduler({ global: Math.max(2, cpus - 2), perToken: 2, perPerson: 3, maxQueuedPerToken: 64, ...cfg.limits })
    this.limits = { ...DEFAULT_LIMITS, ...cfg.defaults }
    const tmpBase = cfg.tmpRoot ?? path.join(os.tmpdir(), `${ENV_PREFIX.toLowerCase()}-work-${process.getuid?.() ?? 'u'}`)
    fs.mkdirSync(tmpBase, { recursive: true, mode: 0o700 })
    this.tmpRoot = fs.realpathSync(tmpBase)
    // a worker user must be able to pass through to its own job dir (it cannot list the others)
    if (this.ids) fs.chmodSync(this.tmpRoot, 0o711)
    this.codePaths = (cfg.codePaths ?? defaultCodePaths()).map((p) => realOrNull(p)).filter((p): p is string => !!p)
    // both the configured path (often a symlink) and its target: exec checks may see either
    this.execPaths = [...new Set((cfg.execPaths ?? []).flatMap((p) => { const r = realOrNull(p); return r ? [path.resolve(p), r] : [] }))]
    this.runtime = realOrNull(cfg.runtime ?? process.execPath) ?? process.execPath
    this.entry = cfg.entry ?? path.join(HERE, 'entry.ts')
    this.warmTarget = this.refusal ? 0 : Math.max(0, cfg.warm ?? 2)
    this.warmReserve = Math.min(this.warmTarget, cfg.warmReserve ?? 1)
    this.pollMs = cfg.pollMs ?? 20
    this.bootTimeoutMs = cfg.bootTimeoutMs ?? 10_000
    this.preloadShell = cfg.preloadShell ?? true
    this.reuse = cfg.reuse === false ? null : { idleMs: 5000, maxJobs: 32, maxIdle: 4, ...cfg.reuse }
    this.refill()
  }

  info() {
    return { isolation: this.isolation, user: this.user, refusal: this.refusal, warnings: this.warnings, memProbe: memProbe()?.kind ?? null, warm: this.idle.length, kept: this.kept.length, limits: { ...this.scheduler.limits }, runningBy: this.scheduler.runningBy, ...this.scheduler.stats }
  }

  /** Runs one job in an isolated worker. Never throws for job failures: see RunResult.status. */
  async run<T = unknown>(job: JobSpec, opts: RunOptions): Promise<RunResult<T>> {
    const t0 = performance.now()
    const stats: RunStats = { queuedMs: 0, startMs: 0, runMs: 0, totalMs: 0, warm: false, reused: false, peakRssBytes: 0, fsCalls: 0, pid: 0, backendErrors: 0 }
    const result = (status: RunStatus, extra: Partial<RunResult<T>> = {}): RunResult<T> => {
      stats.totalMs = performance.now() - t0
      return { status, isolation: this.isolation, user: this.user, stats, log: '', ...extra }
    }
    if (this.refusal) return result('refused', { error: new Error(this.refusal) })
    if (this.closed) return result('refused', { error: new Error('executor closed') })

    let release: () => void
    try { release = await this.scheduler.acquire(opts.token, opts.person, opts.signal) } catch (e) {
      if (e instanceof Busy) return result('busy', { error: e })
      if (e instanceof Aborted) return result('aborted', { error: e })
      throw e
    }
    stats.queuedMs = performance.now() - t0
    const limits: JobLimits = {
      timeoutMs: opts.timeoutMs ?? this.limits.timeoutMs, maxRssBytes: opts.maxRssBytes ?? this.limits.maxRssBytes,
      maxFrameBytes: opts.maxFrameBytes ?? this.limits.maxFrameBytes, maxChannelBytes: opts.maxChannelBytes ?? this.limits.maxChannelBytes,
      maxLogBytes: opts.maxLogBytes ?? this.limits.maxLogBytes,
    }
    let w: Worker | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let keep = false
    const owner = JSON.stringify([opts.token, opts.person])
    // only plain shell jobs share a process (with the same token): extraction parses hostile documents, and grants
    // would carry over
    const reusable = !!this.reuse && job.kind === 'shell' && !opts.readPaths?.length && !opts.execPaths?.length
    const onAbort = () => w?.kill('aborted')
    try {
      const t1 = performance.now()
      // the last `warmReserve` warm workers go to tokens with nothing else running: a token already busy with other
      // jobs starts cold (~100 ms more), so a flood cannot drain the pool and slow down everyone else's first command
      const busy = this.scheduler.runningFor(opts.token) > 1
      const kept = reusable ? this.unpark(owner) : null
      const got = kept ? { w: kept, warm: true } : await this.take(opts.readPaths ?? [], opts.execPaths ?? [], limits, busy)
      if (!got) return result('crashed', { error: new Error(`worker failed to start${this.lastBootLog ? ': ' + this.lastBootLog : ''}`) })
      w = got.w
      if (kept) w.setLimits(limits)
      w.owner ??= owner
      // defence in depth (unpark is keyed by owner): a process never serves a second token
      if (w.owner !== owner) { w.kill('crashed'); return result('crashed', { error: new Error('worker belongs to another token') }) }
      stats.warm = got.warm
      stats.reused = !!kept
      stats.pid = w.pid
      stats.startMs = performance.now() - t1
      if (opts.signal?.aborted) return result('aborted')
      opts.signal?.addEventListener('abort', onAbort, { once: true })

      const t2 = performance.now()
      this.active.add(w)
      this.startWatchdog()
      const worker = w
      timer = setTimeout(() => worker.kill('timeout'), limits.timeoutMs)
      const done = await w.run(job, opts.body, opts.backend ?? null, opts.hooks ?? {})
      // nothing reaches the backend after this point
      await w.stopServing()
      stats.runMs = performance.now() - t2
      stats.peakRssBytes = w.peakRss
      stats.fsCalls = w.fsCalls
      stats.backendErrors = w.backendErrors
      // a limit breach wins over a `done` that raced with the kill
      const reason = w.killReason
      if (reason && reason !== 'done') {
        await w.dispose()
        return result(reason, { log: w.log })
      }
      if (!done) {
        await w.dispose()
        return result('crashed', { error: new Error(`worker exited (${w.proc.exitCode ?? w.proc.signalCode})`), log: w.log })
      }
      keep = reusable && done.m.ok && !opts.signal?.aborted && w.jobs < this.reuse!.maxJobs && w.peakRss < limits.maxRssBytes / 2
      return done.m.ok
        ? result('ok', { value: done.m.result as T, body: done.body, log: w.log })
        : result('error', { error: done.m.error, log: w.log })
    } finally {
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      if (w) {
        this.active.delete(w)
        if (keep && !w.killReason && w.proc.exitCode === null && !this.closed) this.park(owner, w)
        else await w.dispose()
      }
      release()
    }
  }

  async close() {
    this.closed = true
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null }
    for (const k of this.kept) clearTimeout(k.timer)
    this.kept = []
    await Promise.all([...this.live].map((w) => w.dispose()))
  }

  /** Kills the workers kept for this token (e.g. when its call could not be recorded). */
  async discardKept(token: string, person: string) {
    const owner = JSON.stringify([token, person])
    const drop = this.kept.filter((k) => k.w.owner === owner)
    this.kept = this.kept.filter((k) => k.w.owner !== owner)
    for (const k of drop) clearTimeout(k.timer)
    await Promise.all(drop.map((k) => k.w.dispose()))
  }

  /** A kept worker of this token, most recently used first. */
  private unpark(owner: string): Worker | null {
    for (let i = this.kept.length - 1; i >= 0; i--) {
      const k = this.kept[i]!
      if (k.w.owner !== owner) continue
      this.kept.splice(i, 1)
      clearTimeout(k.timer)
      if (k.w.proc.exitCode !== null || k.w.killReason) { void k.w.dispose(); continue }
      return k.w
    }
    return null
  }

  private park(owner: string, w: Worker) {
    const r = this.reuse!
    // at most perToken workers per token, maxIdle overall: the oldest go first
    const mine = this.kept.filter((k) => k.w.owner === owner)
    const drop = [...(mine.length >= this.scheduler.limits.perToken ? [mine[0]!] : [])]
    const others = this.kept.filter((k) => !drop.includes(k))
    if (others.length >= r.maxIdle) drop.push(...others.slice(0, others.length - r.maxIdle + 1))
    for (const k of drop) { clearTimeout(k.timer); void k.w.dispose() }
    this.kept = this.kept.filter((k) => !drop.includes(k))
    if (r.maxIdle < 1) return void w.dispose()
    const timer = setTimeout(() => { this.kept = this.kept.filter((k) => k.w !== w); void w.dispose() }, r.idleMs)
    timer.unref?.()
    this.kept.push({ w, timer })
  }

  /** A ready worker: a warm one if the job needs no extra grants, else a fresh one. */
  private async take(readPaths: string[], execPaths: string[], limits: JobLimits, busyToken: boolean): Promise<{ w: Worker; warm: boolean } | null> {
    const grants = readPaths.map((p) => realOrNull(p)).filter((p): p is string => !!p)
    const execs = execPaths.flatMap((p) => { const r = realOrNull(p); return r ? [path.resolve(p), r] : [] })
    const mayUseWarm = !grants.length && !execs.length && (!busyToken || this.idle.length > this.warmReserve)
    let w: Worker | null | undefined = mayUseWarm ? this.idle.shift() : undefined
    const warm = !!w
    this.refill()
    if (!w) {
      w = this.spawn(grants, false, execs)
      if (!w) return null
      w.setLimits(limits)
      let bootTimer: ReturnType<typeof setTimeout> | undefined
      const ok = await Promise.race([w.ready.then(() => true, () => false), new Promise<boolean>((res) => { bootTimer = setTimeout(() => res(false), this.bootTimeoutMs) })])
      clearTimeout(bootTimer)
      if (!ok) { this.spawnFailures++; await w.dispose(); this.lastBootLog = w.log.trim().slice(0, 1000); return null }
      this.spawnFailures = 0
    } else w.setLimits(limits)
    return { w, warm }
  }

  private spawn(grants: string[], prewarm = false, execs: string[] = []): Worker | null {
    let dir: string
    try { dir = fs.mkdtempSync(path.join(this.tmpRoot, 'job-')) } catch (e) { this.warnings.push(`cannot create job dir: ${(e as Error).message}`); return null }
    if (this.ids) { try { fs.chownSync(dir, this.ids.uid, this.ids.gid) } catch {} }
    const execPaths = [...new Set([...this.execPaths, ...execs])]
    const toolReads = execPaths.flatMap(toolReadPaths)
    const listPaths = [...new Set(this.codePaths.map((p) => path.dirname(p)))]
    const argv = wrapArgv(this.isolation, { workDir: dir, readPaths: [...this.codePaths, ...toolReads, ...grants], listPaths, execPaths, runtime: this.runtime }, [this.runtime, this.entry])
    const env: Record<string, string> = {
      PATH: '/usr/bin:/bin', HOME: dir, TMPDIR: dir, LANG: 'C.UTF-8', NO_COLOR: '1', TZ: this.tz,
      // the transpiler cache would be shared state between jobs (and lives outside the job dir)
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
    }
    if (prewarm && this.preloadShell) env.WORKER_PREWARM = '1'
    if (!this.preloadShell) env.WORKER_PRELOAD = '0'
    try {
      const w = new Worker(argv, dir, env, this.ids, (gone) => {
        this.live.delete(gone)
        this.idle = this.idle.filter((x) => x !== gone)
        this.kept = this.kept.filter((k) => { if (k.w !== gone) return true; clearTimeout(k.timer); return false })
      })
      this.live.add(w)
      return w
    } catch (e) {
      this.warnings.push(`cannot start worker: ${(e as Error).message}`)
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
      return null
    }
  }

  /** Keep `warm` workers booted and waiting. Stops after repeated start-up failures (reported via info().warnings). */
  private refill() {
    while (!this.closed && this.idle.length + this.booting < this.warmTarget && this.spawnFailures < 5) {
      const w = this.spawn([], true)
      if (!w) { this.spawnFailures++; return }
      this.booting++
      const timeout = setTimeout(() => w.kill('crashed'), this.bootTimeoutMs)
      w.ready.then(() => {
        this.spawnFailures = 0
        if (this.closed) return void w.dispose()
        this.idle.push(w)
        // an idle worker that dies is dropped; the next take() refills
        void w.exited.then(() => { this.idle = this.idle.filter((x) => x !== w); void w.dispose() })
      }, () => { this.spawnFailures++; void w.dispose().then(() => { this.lastBootLog = w.log.trim().slice(0, 1000) }) }).finally(() => { clearTimeout(timeout); this.booting--; if (this.spawnFailures && this.spawnFailures < 5) this.refill() })
    }
  }

  private startWatchdog() {
    if (this.watchdog) return
    const probe = memProbe()
    if (!probe) return
    this.watchdog = setInterval(() => {
      if (!this.active.size) { clearInterval(this.watchdog!); this.watchdog = null; return }
      for (const w of this.active) {
        const t = probe.tree(w.pid)
        if (!t) continue
        if (t.bytes > w.peakRss) w.peakRss = t.bytes
        if (t.bytes > w.limits.maxRssBytes) w.kill('memory')
      }
    }, this.pollMs)
    this.watchdog.unref?.()
  }
}

// ---------- module-level convenience ----------

const env = (k: string) => process.env[`${ENV_PREFIX}_${k}`]
const envInt = (k: string): number | undefined => { const v = Number(env(k)); return env(k) && Number.isInteger(v) && v >= 0 ? v : undefined }
/** Admission limits from the environment (<PREFIX>_WORKERS_GLOBAL, _WORKERS_PER_TOKEN, _WORKERS_PER_PERSON, _WORKERS_QUEUE). */
function envLimits(prefix: string): Partial<SchedulerLimits> {
  const out: Partial<SchedulerLimits> = {}
  const set = (k: keyof SchedulerLimits, name: string) => { const v = envInt(`${prefix}_${name}`); if (v !== undefined && (v > 0 || k === 'maxQueuedPerToken')) out[k] = v }
  set('global', 'GLOBAL'); set('perToken', 'PER_TOKEN'); set('perPerson', 'PER_PERSON'); set('maxQueuedPerToken', 'QUEUE')
  return out
}
const envBase = (): ExecutorConfig => ({
  isolation: (env('ISOLATION') as Isolation | 'auto' | undefined) ?? 'auto',
  requireIsolation: env('REQUIRE_ISOLATION') !== '0',
  runAs: env('WORKER_USER') ?? null,
})

/**
 * What the process-wide executors will use, for the server's start-up message (does not start them). `problem` is set
 * when isolation is required but unavailable: then every shell command and document extraction is refused.
 */
export function isolationReport(): { isolation: Isolation; required: boolean; problem: string | null } {
  const cfg = envBase()
  const isolation = !cfg.isolation || cfg.isolation === 'auto' ? detectIsolation() : cfg.isolation
  const required = cfg.requireIsolation !== false
  if (isolation !== 'none' || !required) return { isolation, required, problem: null }
  const why = !cfg.isolation || cfg.isolation === 'auto' ? isolationProblem() : `${ENV_PREFIX}_ISOLATION=none`
  return { isolation, required, problem: `bash commands and document text extraction are refused: no OS isolation for workers. ${why}` }
}

let shared: Executor | null = null
/**
 * The process-wide executor for shell commands, configured from the environment (<PREFIX>_ISOLATION, _REQUIRE_ISOLATION,
 * _WORKER_USER, _WORKERS_WARM, _WORKER_REUSE, and the admission limits _WORKERS_GLOBAL / _PER_TOKEN / _PER_PERSON / _QUEUE).
 */
export function defaultExecutor(): Executor {
  shared ??= new Executor({
    ...envBase(),
    warm: envInt('WORKERS_WARM'),
    reuse: env('WORKER_REUSE') === '0' ? false : undefined,
    limits: envLimits('WORKERS'),
  })
  return shared
}

let sharedExtract: Executor | null = null
/**
 * The process-wide executor for document extraction. Separate from the shell's: a shell command that reads an office
 * file holds a shell slot while it waits for the text, so extraction must not queue behind shell jobs (that would
 * deadlock until the deadline). One job per process, never reused; workers do not load the shell engine.
 * Environment: the same isolation settings, <PREFIX>_EXTRACT_WARM (default 1) and _EXTRACT_GLOBAL / _PER_TOKEN /
 * _PER_PERSON / _QUEUE (defaults: half the CPUs, 2, 3, 256).
 */
export function extractExecutor(): Executor {
  const cpus = os.availableParallelism?.() ?? os.cpus().length
  sharedExtract ??= new Executor({
    ...envBase(),
    warm: envInt('EXTRACT_WARM') ?? 1,
    reuse: false,
    preloadShell: false,
    limits: { global: Math.max(2, Math.floor(cpus / 2)), perToken: 2, perPerson: 3, maxQueuedPerToken: 256, ...envLimits('EXTRACT') },
  })
  return sharedExtract
}

/**
 * Closes the process-wide executors that were started (their warm workers are killed and their job dirs removed), so a
 * one-shot process such as `cli sh` can exit. The next defaultExecutor() / extractExecutor() call starts a new one.
 */
export async function closeDefaultExecutor() {
  const ex = [shared, sharedExtract]
  shared = null
  sharedExtract = null
  await Promise.all(ex.map((e) => e?.close()))
}

/** Kills the workers the process-wide executor keeps for this token (no-op when it was never started). */
export async function discardKept(token: string, person: string) {
  await shared?.discardKept(token, person)
}

export function runIsolated<T = unknown>(job: JobSpec, opts: RunOptions & { executor?: Executor }): Promise<RunResult<T>> {
  return (opts.executor ?? defaultExecutor()).run<T>(job, opts)
}
