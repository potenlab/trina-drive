// Isolated executor (plan 5.1 "격리 실행기", 6, 7.1): untrusted work runs in a separate, sandboxed, short-lived process.
//   - one job per process; a small pool of pre-started ("warm") processes hides the start-up cost. A warm process has
//     loaded code only, no job data, and is used once, so nothing carries over between jobs or tokens.
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
import { detectIsolation, lookupUser, wrapArgv, type Isolation } from './sandbox'
import { Aborted, Busy, FairScheduler, type SchedulerLimits } from './scheduler'

// ---------- what the integrator implements ----------

export interface BackendStat { isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean; mode: number; size: number; mtime: Date }
export interface BackendDirent { name: string; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }

/**
 * The filesystem a shell worker sees: a subset of just-bash's IFileSystem, so the server's permission-filtered VirtualFs
 * (src/vfs.ts) can be passed as is. Errors with a string `code` (ENOENT, EROFS, ...) are passed to the shell; any other
 * error ends the job with status 'host-error'.
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
  /** Dedicated unprivileged user for workers (e.g. `_shelfwork`). Needs the server to run as root (see docs/worker.md). */
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
  /** worker start-up deadline */
  bootTimeoutMs?: number
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
  | 'host-error'  // the backend threw a non-fs error (error holds it)

export interface RunStats { queuedMs: number; startMs: number; runMs: number; totalMs: number; warm: boolean; peakRssBytes: number; fsCalls: number; pid: number }

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

type KillReason = 'timeout' | 'memory' | 'output' | 'crashed' | 'aborted' | 'host-error' | 'done'

class Worker {
  readonly proc: Subprocess<'pipe', 'pipe', 'pipe'>
  readonly ready: Promise<void>
  readonly exited: Promise<number>
  readonly startedAt = performance.now()
  killReason: KillReason | null = null
  hostError: Error | null = null
  peakRss = 0
  fsCalls = 0
  log = ''
  private logBytes = 0
  private channelBytes = 0
  private inFlight = 0
  private markReady!: () => void
  private failReady!: (e: Error) => void
  private onDone: ((m: Extract<FromWorker, { t: 'done' }>, body?: Uint8Array) => void) | null = null
  private backend: FsBackend | null = null
  private hooks: ShellHooks = {}
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
    this.backend = backend
    this.hooks = hooks
    const done = new Promise<{ m: Extract<FromWorker, { t: 'done' }>; body?: Uint8Array } | null>((resolve) => {
      this.onDone = (m, b) => resolve({ m, body: b })
      // the last frames may still be in the pipe when the exit is seen
      void Promise.all([this.exited, this.outDone]).then(() => resolve(null))
    })
    this.send({ t: 'job', v: PROTOCOL_VERSION, job }, body)
    return done
  }

  kill(reason: KillReason) {
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

  private send(h: ToWorker, body?: Uint8Array) {
    try { this.proc.stdin.write(encodeFrame(h, body)); void this.proc.stdin.flush() } catch { /* worker gone; exit handling reports it */ }
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
        const cb = this.onDone
        this.onDone = null
        cb?.(h, body)
        return
      }
      case 'fs':
      case 'cmd':
        if (!this.backend && h.t === 'fs') return this.reply(h.id, { code: 'ENOSYS', message: 'no filesystem for this job' })
        if (++this.inFlight > 256) { this.log += '\n[protocol] too many requests in flight\n'; this.kill('crashed'); return }
        void this.serve(h, body).finally(() => this.inFlight--)
    }
  }

  private reply(id: number, error: WireError | null, value?: unknown, body?: Uint8Array) {
    this.send(error ? { t: 'reply', id, ok: false, error } : { t: 'reply', id, ok: true, value }, body)
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
      this.hostError = e instanceof Error ? e : new Error(String(e))
      this.kill('host-error')
    }
  }
}

class ArgError extends Error {}

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
  private idle: Worker[] = []
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
    if ((cfg.requireIsolation ?? true) && this.isolation === 'none') refusal = 'no OS isolation is available (sandbox-exec on macOS, bwrap on Linux), and isolation is required'

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
    this.codePaths = (cfg.codePaths ?? defaultCodePaths()).map((p) => realOrNull(p)).filter((p): p is string => !!p)
    // both the configured path (often a symlink) and its target: exec checks may see either
    this.execPaths = [...new Set((cfg.execPaths ?? []).flatMap((p) => { const r = realOrNull(p); return r ? [path.resolve(p), r] : [] }))]
    this.runtime = realOrNull(cfg.runtime ?? process.execPath) ?? process.execPath
    this.entry = cfg.entry ?? path.join(HERE, 'entry.ts')
    this.warmTarget = this.refusal ? 0 : Math.max(0, cfg.warm ?? 2)
    this.warmReserve = Math.min(this.warmTarget, cfg.warmReserve ?? 1)
    this.pollMs = cfg.pollMs ?? 20
    this.bootTimeoutMs = cfg.bootTimeoutMs ?? 10_000
    this.refill()
  }

  info() {
    return { isolation: this.isolation, user: this.user, refusal: this.refusal, warnings: this.warnings, memProbe: memProbe()?.kind ?? null, warm: this.idle.length, ...this.scheduler.stats }
  }

  /** Runs one job in an isolated worker. Never throws for job failures: see RunResult.status. */
  async run<T = unknown>(job: JobSpec, opts: RunOptions): Promise<RunResult<T>> {
    const t0 = performance.now()
    const stats: RunStats = { queuedMs: 0, startMs: 0, runMs: 0, totalMs: 0, warm: false, peakRssBytes: 0, fsCalls: 0, pid: 0 }
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
    const onAbort = () => w?.kill('aborted')
    try {
      const t1 = performance.now()
      // the last `warmReserve` warm workers go to tokens with nothing else running: a token already busy with other
      // jobs starts cold (~100 ms more), so a flood cannot drain the pool and slow down everyone else's first command
      const busy = this.scheduler.runningFor(opts.token) > 1
      const got = await this.take(opts.readPaths ?? [], limits, busy)
      if (!got) return result('crashed', { error: new Error(`worker failed to start${this.lastBootLog ? ': ' + this.lastBootLog : ''}`) })
      w = got.w
      stats.warm = got.warm
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
      stats.runMs = performance.now() - t2
      stats.peakRssBytes = w.peakRss
      stats.fsCalls = w.fsCalls
      // a limit breach wins over a `done` that raced with the kill
      const reason = w.killReason
      if (reason && reason !== 'done') {
        await w.dispose()
        return result(reason === 'aborted' ? 'aborted' : reason, { error: reason === 'host-error' ? w.hostError ?? undefined : undefined, log: w.log })
      }
      if (!done) {
        await w.dispose()
        return result('crashed', { error: new Error(`worker exited (${w.proc.exitCode ?? w.proc.signalCode})`), log: w.log })
      }
      return done.m.ok
        ? result('ok', { value: done.m.result as T, body: done.body, log: w.log })
        : result('error', { error: done.m.error, log: w.log })
    } finally {
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      if (w) { this.active.delete(w); await w.dispose() }
      release()
    }
  }

  async close() {
    this.closed = true
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null }
    await Promise.all([...this.live].map((w) => w.dispose()))
  }

  /** A ready worker: a warm one if the job needs no extra grants, else a fresh one. */
  private async take(readPaths: string[], limits: JobLimits, busyToken: boolean): Promise<{ w: Worker; warm: boolean } | null> {
    const grants = readPaths.map((p) => realOrNull(p)).filter((p): p is string => !!p)
    const mayUseWarm = !grants.length && (!busyToken || this.idle.length > this.warmReserve)
    let w: Worker | null | undefined = mayUseWarm ? this.idle.shift() : undefined
    const warm = !!w
    this.refill()
    if (!w) {
      w = this.spawn(grants)
      if (!w) return null
      w.setLimits(limits)
      const ok = await Promise.race([w.ready.then(() => true, () => false), Bun.sleep(this.bootTimeoutMs).then(() => false)])
      if (!ok) { this.spawnFailures++; await w.dispose(); this.lastBootLog = w.log.trim().slice(0, 1000); return null }
      this.spawnFailures = 0
    } else w.setLimits(limits)
    return { w, warm }
  }

  private spawn(grants: string[], prewarm = false): Worker | null {
    let dir: string
    try { dir = fs.mkdtempSync(path.join(this.tmpRoot, 'job-')) } catch (e) { this.warnings.push(`cannot create job dir: ${(e as Error).message}`); return null }
    if (this.ids) { try { fs.chownSync(dir, this.ids.uid, this.ids.gid) } catch {} }
    const toolReads = this.execPaths.flatMap(toolReadPaths)
    const listPaths = [...new Set(this.codePaths.map((p) => path.dirname(p)))]
    const argv = wrapArgv(this.isolation, { workDir: dir, readPaths: [...this.codePaths, ...toolReads, ...grants], listPaths, execPaths: this.execPaths, runtime: this.runtime }, [this.runtime, this.entry])
    const env: Record<string, string> = {
      PATH: '/usr/bin:/bin', HOME: dir, TMPDIR: dir, LANG: 'C.UTF-8', NO_COLOR: '1', TZ: this.tz,
      // the transpiler cache would be shared state between jobs (and lives outside the job dir)
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
    }
    if (prewarm) env.WORKER_PREWARM = '1'
    try {
      const w = new Worker(argv, dir, env, this.ids, (gone) => { this.live.delete(gone); this.idle = this.idle.filter((x) => x !== gone) })
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

let shared: Executor | null = null
/** The process-wide executor, configured from the environment (<PREFIX>_ISOLATION, _REQUIRE_ISOLATION, _WORKER_USER, _WORKERS_WARM). */
export function defaultExecutor(): Executor {
  if (!shared) {
    const env = (k: string) => process.env[`${ENV_PREFIX}_${k}`]
    shared = new Executor({
      isolation: (env('ISOLATION') as Isolation | 'auto' | undefined) ?? 'auto',
      requireIsolation: env('REQUIRE_ISOLATION') !== '0',
      runAs: env('WORKER_USER') ?? null,
      warm: env('WORKERS_WARM') ? Number(env('WORKERS_WARM')) : undefined,
    })
  }
  return shared
}

export function runIsolated<T = unknown>(job: JobSpec, opts: RunOptions & { executor?: Executor }): Promise<RunResult<T>> {
  return (opts.executor ?? defaultExecutor()).run<T>(job, opts)
}
