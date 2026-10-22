// Worker process: runs untrusted jobs, one at a time, for one token. Started by pool.ts, usually inside sandbox-exec or
// bwrap. It boots (loads just-bash), says `ready`, waits for a `job`, runs it, says `done`, and waits for the next job
// until the server kills it (the server decides whether a process is used again; see pool.ts). It never reads team files by
// itself: shell jobs see the parent's VFS through ProxyFs; extraction jobs get bytes in the frame body (or a path the
// sandbox explicitly grants).
import { encodeFrame, FrameDecoder, PROTOCOL_VERSION, type ExtractJob, type Frame, type FromWorker, type FsOp, type ShellJob, type ToWorker, type WireError } from './protocol'

// stdout is the protocol channel: anything printed by the runtime or a library goes to stderr instead
const toStderr = (...a: unknown[]) => console.error(...a)
console.log = console.info = console.debug = console.warn = toStderr

const sink = Bun.stdout.writer()
function send(h: FromWorker, body?: Uint8Array) {
  sink.write(encodeFrame(h, body))
  return sink.flush()
}

let nextId = 1
const pending = new Map<number, { resolve: (r: { value: unknown; body?: Uint8Array }) => void; reject: (e: unknown) => void }>()
let onJob: ((f: Frame<ToWorker>) => void) | null = null

async function readLoop() {
  const decoder = new FrameDecoder<ToWorker>(16 << 20, 1 << 30)
  for await (const chunk of Bun.stdin.stream()) {
    for (const f of decoder.push(chunk)) {
      const h = f.h
      if (h.t === 'reply') {
        const p = pending.get(h.id)
        if (!p) continue
        pending.delete(h.id)
        if (h.ok) p.resolve({ value: h.value, body: f.body })
        else p.reject(h.error)
      } else if (h.t === 'job') onJob?.(f)
    }
  }
  // parent closed the channel: nothing more to do
  process.exit(3)
}

function request(h: { t: 'fs'; op: FsOp; args: unknown[]; cmd?: string[] } | { t: 'cmd'; name: string; args: string[]; cwd: string; cmd?: string[] }, body?: Uint8Array) {
  const id = nextId++
  return new Promise<{ value: unknown; body?: Uint8Array }>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    void send({ ...h, id } as FromWorker, body)
  })
}

const errOut = (e: unknown): WireError => {
  if (e && typeof e === 'object' && 'code' in e && typeof (e as { code: unknown }).code === 'string')
    return { code: (e as { code: string }).code, message: String((e as { message?: unknown }).message ?? e), path: (e as { path?: string }).path }
  return { code: 'EJOB', message: e instanceof Error ? e.message : String(e) }
}

const cut = (s: string, max: number | undefined, what: string) => {
  if (!max) return s
  const b = Buffer.from(s)
  if (b.length <= max) return s
  return new TextDecoder().decode(b.subarray(0, max)).replace(/�$/, '') + `\n[${what} truncated at ${Math.round(max / 1024)} KB]\n`
}

// ---------- boot: load the shell engine before the job arrives (this is what a warm worker saves) ----------
const jb = await import('just-bash')
const { ProxyFs, currentCommand, fromWire, WorkerFsError } = await import('./proxy-fs')
const sysFs = new jb.InMemoryFs()
new jb.Bash({ fs: sysFs }) // lays out /bin, /usr/bin, /dev, /proc stubs

// Pool workers (started before any job exists) also run the common commands once on a throwaway in-memory filesystem:
// just-bash loads each command's code on first use, which costs ~35 ms. No job data is involved.
if (process.env.WORKER_PREWARM === '1') {
  const scratch = new jb.InMemoryFs({ '/w/a.txt': 'b 2\na 1\nb 2\n', '/w/b.csv': 'x,y\n1,2\n' })
  const warm = new jb.Bash({ fs: scratch, cwd: '/w', executionLimitProfile: 'hardened' })
  await warm.exec([
    'ls -la /w; ls /w | wc -l; cat a.txt | sort | uniq -c | sort -rn | head -n 1 | tail -n 1',
    'cut -d, -f1 b.csv | tr a-z A-Z; sed -n 1p a.txt; awk \'{print $1}\' a.txt; find /w -name "*.txt" -type f',
    'stat a.txt >/dev/null; du -sh /w; wc -c a.txt; diff a.txt a.txt; sha256sum a.txt; printf "%s\\n" x | xargs echo',
    'test -f a.txt && echo y; [ -d /w ] && echo y; echo hi > c.txt; cat c.txt; basename /w/a.txt; dirname /w/a.txt; nl a.txt; tee d.txt < a.txt > /dev/null',
    'for f in *.txt; do echo "$f"; done; x=$(cat a.txt | head -1); echo ${x}; rev a.txt; seq 3; od -c a.txt | head -1; file a.txt; base64 a.txt | head -1; md5sum a.txt; column -t a.txt; paste a.txt a.txt; comm a.txt a.txt; join a.txt a.txt; tac a.txt; fold -w 3 a.txt; expand a.txt; split --help >/dev/null 2>&1; date +%Y >/dev/null',
  ].join('\n'))
}

async function runShell(job: ShellJob) {
  const rpc = {
    fs: (op: FsOp, args: unknown[], body?: Uint8Array, cmd?: string[]) =>
      request({ t: 'fs', op, args, cmd }, body).catch((e: WireError) => { throw fromWire(e) }),
  }
  const fs = new ProxyFs(rpc, sysFs)
  const wrapped = (job.wrap ?? []).map((name) => jb.defineCommand(name, (args, ctx) =>
    currentCommand.run([name, ...args], () => ctx.origCommand ? ctx.origCommand(args) : Promise.resolve({ stdout: '', stderr: `${name}: not available\n`, exitCode: 127 }))))
  const remote = (job.parentCommands ?? []).map((name) => jb.defineCommand(name, async (args, ctx) => {
    const stdin = ctx.stdin ? Buffer.from(ctx.stdin as unknown as string, 'latin1') : undefined
    try {
      const r = await request({ t: 'cmd', name, args, cwd: ctx.cwd, cmd: currentCommand.getStore() }, stdin)
      const v = r.value as { stdout: string; stderr: string; exitCode: number }
      return { stdout: v.stdout, stderr: v.stderr, exitCode: v.exitCode }
    } catch (e) {
      return { stdout: '', stderr: `${name}: ${(e as WireError).message ?? 'failed'}\n`, exitCode: 2 }
    }
  }))
  // commands the server does not offer are absent from /bin too (same as the in-process shell)
  if (job.bash?.commands) {
    const offered = new Set(job.bash.commands)
    for (const n of jb.getCommandNames()) if (!offered.has(n)) for (const d of ['/bin', '/usr/bin']) await sysFs.rm(`${d}/${n}`, { force: true }).catch(() => {})
  }
  const bash = new jb.Bash({
    fs, cwd: job.cwd ?? '/',
    env: job.env ?? { HOME: '/', PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    customCommands: [...remote, ...wrapped],
    ...(job.bash?.commands ? { commands: job.bash.commands as never } : {}),
    executionLimitProfile: (job.bash?.executionLimitProfile ?? 'hardened') as never,
    executionLimits: job.bash?.executionLimits as never,
  })
  let r: { stdout: string; stderr: string; exitCode: number }
  try {
    const out = await bash.exec(job.command)
    r = { stdout: out.stdout, stderr: out.stderr, exitCode: out.exitCode }
  } catch (e) {
    // just-bash lets some redirect failures escape exec(); report them like bash would
    if (!(e instanceof WorkerFsError)) throw e
    r = { stdout: '', stderr: `bash: ${e.path}: ${e.code === 'ENOENT' ? 'No such file or directory' : e.message}\n`, exitCode: 1 }
  }
  return { stdout: cut(r.stdout, job.maxStdoutBytes, 'output'), stderr: cut(r.stderr, job.maxStderrBytes, 'stderr'), exitCode: r.exitCode }
}

async function runExtract(job: ExtractJob, body?: Uint8Array): Promise<Uint8Array> {
  const mod = await import(job.module) as Record<string, unknown>
  const fn = mod[job.fn ?? 'extractText']
  if (typeof fn !== 'function') throw new Error(`extractor ${job.fn ?? 'extractText'} not found`)
  const bytes = job.path ? new Uint8Array(await Bun.file(job.path).arrayBuffer()) : body ?? new Uint8Array()
  const text = await (fn as (name: string, b: Uint8Array) => Promise<string> | string)(job.name, bytes)
  if (typeof text !== 'string') throw new Error('extractor returned no text')
  return new TextEncoder().encode(text)
}

// One job at a time. After `done` the server either kills this process or sends the next job of the same token.
const handleJob = (f: Frame<ToWorker>) => {
  onJob = null
  const h = f.h as Extract<ToWorker, { t: 'job' }>
  const finish = async (msg: FromWorker, body?: Uint8Array) => { await send(msg, body); onJob = handleJob }
  if (h.v !== PROTOCOL_VERSION) { void finish({ t: 'done', ok: false, error: { code: 'EPROTO', message: `protocol ${h.v} not supported (worker speaks ${PROTOCOL_VERSION})` } }); return }
  const job = h.job
  const run = job.kind === 'shell'
    ? runShell(job).then((result) => finish({ t: 'done', ok: true, result }))
    : job.kind === 'extract'
      ? runExtract(job, f.body).then((text) => finish({ t: 'done', ok: true, result: { bytes: text.byteLength } }, text))
      : Promise.reject(new Error(`unknown job kind`))
  run.catch((e) => finish({ t: 'done', ok: false, error: errOut(e) }))
}
onJob = handleJob

void readLoop()
await send({ t: 'ready', v: PROTOCOL_VERSION })
