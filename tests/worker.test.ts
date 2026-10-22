// Isolated executor: limits, sandbox, fairness, the proxied filesystem. Prints measured latencies.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { InMemoryFs } from 'just-bash'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defaultCodePaths, Executor, extractIsolated, runShellIsolated, type CommandResult, type FsBackend, type RunOptions } from '../src/worker'
import { FairScheduler } from '../src/worker/scheduler'
import { encodeFrame, FrameDecoder, ProtocolError } from '../src/worker/protocol'
import { macProfile } from '../src/worker/sandbox'
import { sampleDocx, samplePdf } from '../src/samples'

const FIXTURES = path.join(import.meta.dir, 'fixtures')
const HOSTILE = path.join(FIXTURES, 'hostile.ts')
const SANDBOXED = process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec')

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-worker-test-')))
const tmpRoot = path.join(scratch, 'jobs')
fs.mkdirSync(tmpRoot)
const outside = path.join(scratch, 'outside')
fs.mkdirSync(outside)
fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret payroll')

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p / 100 * s.length) - 1)]! }
const fmt = (n: number) => n.toFixed(1)

/** The executor most tests use: sandboxed, cold (each test checks its own dir clean-up), fixtures readable. */
let ex: Executor
beforeAll(() => {
  ex = new Executor({ warm: 0, tmpRoot, codePaths: [...defaultCodePaths(), FIXTURES], defaults: { timeoutMs: 10_000 } })
})
afterAll(async () => {
  await ex.close()
  fs.rmSync(scratch, { recursive: true, force: true })
})

/** Runs fixture `fn(arg)` in a worker; text = what it returned. */
async function extract(fn: string, arg = 'x.txt', extra: Partial<RunOptions> = {}) {
  const run = await ex.run({ kind: 'extract', module: HOSTILE, fn, name: arg }, { token: 't', person: 'p', ...extra })
  return { status: run.status, text: run.body ? new TextDecoder().decode(run.body) : undefined, run }
}

describe('platform', () => {
  test('reports the isolation in use', () => {
    const info = ex.info()
    console.log(`[worker] isolation=${info.isolation} user=${info.user ?? '(server user)'} memProbe=${info.memProbe} warnings=${JSON.stringify(info.warnings)}`)
    if (SANDBOXED) expect(info.isolation).toBe('sandbox-exec')
    expect(info.refusal).toBeNull()
  })

  test('refuses when isolation is required but unavailable', async () => {
    const e = new Executor({ isolation: 'none', requireIsolation: true, warm: 0, tmpRoot })
    const r = await e.run({ kind: 'extract', module: HOSTILE, fn: 'upper', name: 'a' }, { token: 't', person: 'p' })
    expect(r.status).toBe('refused')
    expect(r.isolation).toBe('none')
    await e.close()
  })

  test('profile denies by default and lists only what it grants', () => {
    const p = macProfile({ workDir: '/w/job', readPaths: ['/code/src'], listPaths: ['/code'], execPaths: [], runtime: '/bin/bun' })
    expect(p).toContain('(deny default)')
    expect(p).toContain('(deny network*)')
    expect(p).toContain('(allow file-read* file-write* (subpath "/w/job"))')
    expect(p).not.toContain('process-fork')
  })
})

describe('limits', () => {
  test('an infinite loop is killed at the deadline', async () => {
    const t = performance.now()
    const r = await extract('spin', 'x', { timeoutMs: 700 })
    const took = performance.now() - t
    console.log(`[worker] infinite loop: status=${r.status} killed after ${fmt(r.run.stats.runMs)} ms (deadline 700)`)
    expect(r.status).toBe('timeout')
    expect(r.run.stats.runMs).toBeLessThan(700 + 500)
    expect(took).toBeLessThan(5000)
    expect(alive(r.run.stats.pid)).toBe(false)
  })

  test('a memory bomb is killed at the RSS cap', async () => {
    const r = await extract('bomb', 'x', { maxRssBytes: 256 << 20, timeoutMs: 30_000 })
    console.log(`[worker] memory bomb: status=${r.status} peak=${Math.round(r.run.stats.peakRssBytes / 1e6)} MB (cap 268 MB) after ${fmt(r.run.stats.runMs)} ms`)
    expect(r.status).toBe('memory')
    expect(r.run.stats.peakRssBytes).toBeGreaterThan(256 << 20)
    expect(alive(r.run.stats.pid)).toBe(false)
  })

  test('a flood on stderr is cut off', async () => {
    const r = await extract('flood', 'x', { maxLogBytes: 4096 })
    expect(r.status).toBe('output')
    expect(r.run.log.length).toBeLessThanOrEqual(4096)
  })

  test('junk on the protocol channel ends the job', async () => {
    const r = await extract('garbage', 'x', { timeoutMs: 5000 })
    expect(['crashed', 'output']).toContain(r.status)
    expect(r.run.stats.runMs).toBeLessThan(2000)
    expect(alive(r.run.stats.pid)).toBe(false)
  })

  test('a timeout leaves no process and no job dir behind (child processes included)', async () => {
    const e = new Executor({ warm: 0, tmpRoot, codePaths: [...defaultCodePaths(), FIXTURES], execPaths: ['/bin/sleep'] })
    const r = await e.run({ kind: 'extract', module: HOSTILE, fn: 'spawnAndSpin', name: 'x' }, { token: 't', person: 'p', timeoutMs: 1500 })
    expect(r.status).toBe('timeout')
    const child = Number(/child-pid (\d+)/.exec(r.log)?.[1])
    expect(child).toBeGreaterThan(0)
    expect(alive(r.stats.pid)).toBe(false)
    // the orphaned child is in the worker's process group, which was SIGKILLed
    const deadline = Date.now() + 2000
    while (alive(child) && Date.now() < deadline) await Bun.sleep(20)
    expect(alive(child)).toBe(false)
    expect(fs.readdirSync(tmpRoot)).toEqual([])
    await e.close()
  })

  test('the per-job temp dir is removed after a normal run', async () => {
    const r = await extract('writeTo', 'inside.txt')
    expect(r.text).toBe('WRITE-OK')
    expect(fs.readdirSync(tmpRoot)).toEqual([])
  })
})

describe.if(SANDBOXED)('sandbox (macOS sandbox-exec)', () => {
  test('network is blocked', async () => {
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('hi') })
    const r = await extract('network', String(server.port))
    server.stop(true)
    console.log(`[worker] network attempts: ${r.text}`)
    expect(r.status).toBe('ok')
    expect(r.text).toContain('fetch:BLOCKED')
    expect(r.text).toContain('tcp:BLOCKED')
    expect(r.text).toContain('local-fetch:BLOCKED')
    expect(r.text).toContain('local-tcp:BLOCKED')
    expect(r.text).not.toContain(':OK')
  })

  test('writes outside the job dir are blocked; inside it they work', async () => {
    const target = path.join(outside, 'pwned.txt')
    const home = path.join(os.homedir(), `.shelf-worker-test-${process.pid}`)
    const a = await extract('writeTo', target)
    const b = await extract('writeTo', home)
    const c = await extract('writeTo', '/tmp/shelf-worker-test-pwned')
    expect(a.text).toContain('WRITE-BLOCKED')
    expect(b.text).toContain('WRITE-BLOCKED')
    expect(c.text).toContain('WRITE-BLOCKED')
    expect(fs.existsSync(target)).toBe(false)
    expect(fs.existsSync(home)).toBe(false)
    // relative paths resolve inside the job dir (the worker's cwd), which is writable
    const d = await extract('writeTo', 'inside.txt')
    expect(d.text).toBe('WRITE-OK')
  })

  test('reads and listings outside the grants are blocked', async () => {
    const secret = path.join(outside, 'secret.txt')
    expect((await extract('readFrom', secret)).text).toContain('READ-BLOCKED')
    expect((await extract('listDir', outside)).text).toContain('LIST-BLOCKED')
    expect((await extract('listDir', os.homedir())).text).toContain('LIST-BLOCKED')
    expect((await extract('readFrom', path.join(os.homedir(), '.zshrc'))).text).toContain('READ-BLOCKED')
    // the worker's own code is readable (that is how it runs)
    expect((await extract('readFrom', HOSTILE)).text).toContain('READ-OK')
  })

  test('a path granted for one job is readable by that job only', async () => {
    const secret = path.join(outside, 'secret.txt')
    const granted = await ex.run({ kind: 'extract', module: HOSTILE, fn: 'readFrom', name: secret }, { token: 't', person: 'p', readPaths: [secret] })
    expect(new TextDecoder().decode(granted.body)).toBe('READ-OK top secret payroll')
    expect((await extract('readFrom', secret)).text).toContain('READ-BLOCKED')
  })

  test('starting other programs is blocked', async () => {
    expect((await extract('exec', '/bin/sh')).text).toContain('EXEC-BLOCKED')
    expect((await extract('exec', '/usr/bin/curl')).text).toContain('EXEC-BLOCKED')
  })
})

// ---------- shell over a proxied filesystem ----------

/** Toy policy backend: an in-memory tree, read-only except /drafts (as the real VFS); records what it served and how. */
class TestBackend implements FsBackend {
  readonly mem = new InMemoryFs({
    '/docs/a.txt': 'alpha\nbeta\ngamma\n',
    '/docs/b.txt': 'beta two\n',
    '/docs/sub/c.md': '# title\nbeta three\n',
    '/drafts/.keep': '',
  })
  readonly reads: { path: string; cmd?: string[] }[] = []
  cmd: string[] | undefined
  private ro(p: string) { if (!p.startsWith('/drafts/')) throw Object.assign(new Error('Originals are read-only. Write to /drafts/.'), { code: 'EROFS', path: p }) }
  readFileBuffer = async (p: string) => { this.reads.push({ path: p, cmd: this.cmd }); return this.mem.readFileBuffer(p) }
  writeFile = async (p: string, c: Uint8Array) => { this.ro(p); return this.mem.writeFile(p, c) }
  appendFile = async (p: string, c: Uint8Array) => { this.ro(p); return this.mem.appendFile(p, c) }
  exists = (p: string) => this.mem.exists(p)
  stat = (p: string) => this.mem.stat(p)
  readdir = (p: string) => this.mem.readdir(p)
  readdirWithFileTypes = (p: string) => this.mem.readdirWithFileTypes(p)
  mkdir = async (p: string, o?: { recursive?: boolean }) => { this.ro(p + '/'); return this.mem.mkdir(p, o) }
  rm = async (p: string, o?: { recursive?: boolean; force?: boolean }) => { this.ro(p); return this.mem.rm(p, o) }
  cp = async (s: string, d: string, o?: { recursive?: boolean }) => { this.ro(d); return this.mem.cp(s, d, o) }
  mv = async (s: string, d: string) => { this.ro(s); this.ro(d); return this.mem.mv(s, d) }
  chmod = async (p: string, m: number) => { this.ro(p); return this.mem.chmod(p, m) }
  symlink = async (_t: string, l: string) => { throw Object.assign(new Error('Links are not supported.'), { code: 'EPERM', path: l }) }
  link = async (_e: string, l: string) => { throw Object.assign(new Error('Links are not supported.'), { code: 'EPERM', path: l }) }
  readlink = (p: string) => this.mem.readlink(p)
}

/** Stand-in for the server's ripgrep-backed grep: runs in the parent (this test process), over the backend's files. */
function parentGrep(backend: TestBackend, ran: { name: string; args: string[]; pid: number }[]) {
  return async (name: string, args: string[], ctx: { cwd: string; stdin: Uint8Array }): Promise<CommandResult> => {
    ran.push({ name, args, pid: process.pid })
    const flags = args.filter((a) => a.startsWith('-'))
    const [pattern, ...paths] = args.filter((a) => !a.startsWith('-'))
    const re = new RegExp(pattern!, flags.includes('-i') ? 'i' : '')
    let out = ''
    const scan = (label: string | null, text: string) => { for (const line of text.split('\n')) if (line && re.test(line)) out += (label ? label + ':' : '') + line + '\n' }
    if (!paths.length) scan(null, new TextDecoder().decode(ctx.stdin))
    else {
      const files: string[] = []
      const walk = async (p: string) => { if ((await backend.mem.stat(p)).isDirectory) { for (const n of (await backend.mem.readdir(p)).sort()) await walk(p.replace(/\/$/, '') + '/' + n) } else files.push(p) }
      for (const p of paths) await walk(backend.mem.resolvePath(ctx.cwd, p))
      for (const f of files) scan(files.length > 1 || flags.includes('-r') ? f : null, await backend.mem.readFile(f))
    }
    return { stdout: out, stderr: '', exitCode: out ? 0 : 1 }
  }
}

describe('shell in a worker over a proxied filesystem', () => {
  const backend = new TestBackend()
  const ran: { name: string; args: string[]; pid: number }[] = []
  const sh = (command: string, cwd = '/') => runShellIsolated(command, backend, {
    executor: ex, token: 'tok', person: 'kim',
    job: { cwd, wrap: ['wc', 'sha256sum'], parentCommands: ['grep', 'rg'] },
    hooks: {
      withCommand: async (cmd, fn) => { backend.cmd = cmd; try { return await fn() } finally { backend.cmd = undefined } },
      runCommand: parentGrep(backend, ran),
    },
  })

  test('ls, cat, pipes', async () => {
    const r = await sh('ls /docs; cat /docs/a.txt | head -n 2 | tr a-z A-Z; cd /docs && cat *.txt | wc -l')
    expect(r.stderr).toBe('')
    expect(r.stdout).toBe('a.txt\nb.txt\nsub\nALPHA\nBETA\n4\n')
    expect(r.exitCode).toBe(0)
    expect(r.run.isolation).toBe(SANDBOXED ? 'sandbox-exec' : r.run.isolation)
  })

  test('grep runs in the parent (stub for ripgrep), on files and on a pipe', async () => {
    ran.length = 0
    const r = await sh('grep -r beta /docs; cat /docs/a.txt | grep -i GAMMA; rg nothing /docs; echo "exit=$?"')
    expect(r.stdout).toBe('/docs/a.txt:beta\n/docs/b.txt:beta two\n/docs/sub/c.md:beta three\ngamma\nexit=1\n')
    expect(ran.map((x) => x.name)).toEqual(['grep', 'grep', 'rg'])
    expect(ran.every((x) => x.pid === process.pid)).toBe(true)
    expect(r.run.stats.pid).not.toBe(process.pid)
  })

  test('errors come from the backend, as the shell prints them', async () => {
    const r = await sh('cat /docs/nope.txt; echo "exit=$?"')
    expect(r.stderr).toContain('No such file or directory')
    expect(r.stdout).toBe('exit=1\n')
    // a failed redirect ends the script (just-bash lets it escape exec(); the worker reports it like bash would)
    const w = await sh('echo x > /docs/new.txt')
    expect(w.stderr).toBe('bash: /docs/new.txt: Originals are read-only. Write to /drafts/.\n')
    expect(w.exitCode).toBe(1)
    expect(await backend.mem.exists('/docs/new.txt')).toBe(false)
  })

  test('writes to /drafts go to the backend', async () => {
    const r = await sh('mkdir -p /drafts/q && cat /docs/a.txt | sort -r > /drafts/q/out.txt && cat /drafts/q/out.txt')
    expect(r.stdout).toBe('gamma\nbeta\nalpha\n')
    expect(await backend.mem.readFile('/drafts/q/out.txt')).toBe('gamma\nbeta\nalpha\n')
  })

  test('calls inside wrapped commands carry the command line (for read modes)', async () => {
    backend.reads.length = 0
    await sh('wc -c /docs/a.txt; cat /docs/b.txt')
    expect(backend.reads).toEqual([{ path: '/docs/a.txt', cmd: ['wc', '-c', '/docs/a.txt'] }, { path: '/docs/b.txt', cmd: undefined }])
  })

  test('a shell infinite loop is killed at the deadline', async () => {
    const r = await runShellIsolated('while true; do :; done', backend, {
      executor: ex, token: 'tok', person: 'kim', timeoutMs: 800,
      job: { bash: { executionLimits: { maxLoopIterations: 1e12, maxCommandCount: 1e12 } } },
    })
    expect(r.run.status).toBe('timeout')
    expect(r.exitCode).toBe(124)
    expect(alive(r.run.stats.pid)).toBe(false)
  })
})

describe('extraction', () => {
  test('pluggable extractor gets the bytes and returns text', async () => {
    const r = await extractIsolated(new TextEncoder().encode('hello'), 'note.txt', { executor: ex, module: HOSTILE, fn: 'upper', token: 't', person: 'p' })
    expect(r.text).toBe('note.txt: HELLO')
  })

  test('the server extractor (src/extract) runs in the worker: docx from bytes, pdf via pdftotext from a granted path', async () => {
    const docx = await extractIsolated(sampleDocx(['Quarterly plan', '매출 목표']), 'docx', { executor: ex, token: 't', person: 'p' })
    expect(docx.status).toBe('ok')
    expect(docx.text).toContain('매출 목표')
    const pdftotext = ['/opt/homebrew/bin/pdftotext', '/usr/local/bin/pdftotext', '/usr/bin/pdftotext'].find((p) => fs.existsSync(p))
    if (!pdftotext) return
    const e = new Executor({ warm: 0, tmpRoot, execPaths: [pdftotext] })
    const file = path.join(outside, 'report.pdf')
    fs.writeFileSync(file, samplePdf(['Revenue 2026 forecast']))
    const pdf = await extractIsolated(file, 'pdf', { executor: e, token: 't', person: 'p' })
    expect(pdf.error ?? '').toBe('')
    expect(pdf.text).toContain('Revenue 2026 forecast')
    await e.close()
  })

  test('an extractor that throws gives status error', async () => {
    const r = await extractIsolated(new Uint8Array(), 'x', { executor: ex, module: HOSTILE, fn: 'missing', token: 't', person: 'p' })
    expect(r.status).toBe('error')
    expect(r.error).toContain('not found')
  })
})

describe('fairness and latency', () => {
  test('cold and warm start latency', async () => {
    const backend = new TestBackend()
    const cold: number[] = [], warm: number[] = []
    for (let i = 0; i < 5; i++) {
      const r = await runShellIsolated('cat /docs/a.txt | wc -l', backend, { executor: ex, token: 't', person: 'p' })
      expect(r.stdout).toBe('3\n')
      cold.push(r.run.stats.totalMs)
    }
    const pool = new Executor({ warm: 2, tmpRoot, codePaths: [...defaultCodePaths(), FIXTURES] })
    for (let i = 0; i < 8; i++) {
      // let the pool refill (a burst beyond the pool size falls back to cold starts)
      for (let k = 0; k < 150 && pool.info().warm < 1; k++) await Bun.sleep(20)
      const r = await runShellIsolated('cat /docs/a.txt | wc -l', backend, { executor: pool, token: 't', person: 'p' })
      expect(r.stdout).toBe('3\n')
      expect(r.run.stats.warm).toBe(true)
      warm.push(r.run.stats.totalMs)
    }
    await pool.close()
    console.log(`[worker] spawn+run, cold: median ${fmt(pct(cold, 50))} ms, max ${fmt(Math.max(...cold))} ms | warm pool: median ${fmt(pct(warm, 50))} ms, max ${fmt(Math.max(...warm))} ms`)
    expect(pct(warm, 50)).toBeLessThan(50)
  })

  test('a flood of 50 heavy jobs from token A does not hold up token B', async () => {
    const pool = new Executor({ warm: 3, tmpRoot, codePaths: [...defaultCodePaths(), FIXTURES], limits: { global: 4, perToken: 2, perPerson: 2, maxQueuedPerToken: 64 } })
    for (let k = 0; k < 150 && pool.info().warm < 3; k++) await Bun.sleep(20)
    const stop = new AbortController()
    const flood = Array.from({ length: 50 }, () =>
      pool.run({ kind: 'extract', module: HOSTILE, fn: 'busy', name: '400' }, { token: 'A', person: 'alice', signal: stop.signal, timeoutMs: 5000 }))
    await Bun.sleep(100)
    const backend = new TestBackend()
    const lat: number[] = []
    for (let i = 0; i < 25; i++) {
      const t = performance.now()
      const r = await runShellIsolated('ls /docs | wc -l', backend, { executor: pool, token: 'B', person: 'bob' })
      lat.push(performance.now() - t)
      if (performance.now() - t > 250) console.log(`[worker]   slow B job: ${fmt(performance.now() - t)} ms ${JSON.stringify(r.run.stats)}`)
      expect(r.stdout).toBe('3\n')
      await Bun.sleep(40)
    }
    const midFlood = pool.info()
    stop.abort()
    const results = await Promise.all(flood)
    const counts: Record<string, number> = {}
    for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1
    console.log(`[worker] token B during A's flood (A queued ${midFlood.queued}, running ${midFlood.running}): p50 ${fmt(pct(lat, 50))} ms, p99 ${fmt(pct(lat, 99))} ms, max ${fmt(Math.max(...lat))} ms; A results ${JSON.stringify(counts)}`)
    expect(midFlood.queued).toBeGreaterThan(20) // A was still flooding while B ran
    expect(pct(lat, 99)).toBeLessThan(500)
    expect(Object.keys(counts).every((s) => s === 'ok' || s === 'aborted')).toBe(true)
    await pool.close()
    expect(fs.readdirSync(tmpRoot)).toEqual([])
  }, 30_000)
})

describe('scheduler', () => {
  test('round-robin across tokens, per-token / per-person / global limits, queue cap', async () => {
    const s = new FairScheduler({ global: 3, perToken: 2, perPerson: 2, maxQueuedPerToken: 2 })
    const order: string[] = []
    const releases: (() => void)[] = []
    const ask = (token: string, person: string) => s.acquire(token, person).then((r) => { order.push(token); releases.push(r) })
    const pending = [ask('A', 'x'), ask('A', 'x'), ask('A', 'x'), ask('A', 'x'), ask('B', 'y'), ask('C', 'x')]
    await Bun.sleep(0)
    // A gets its 2, B gets 1 (global 3); C shares person x with A (perPerson 2) so waits
    expect(order).toEqual(['A', 'A', 'B'])
    await expect(s.acquire('A', 'x')).rejects.toThrow('too many')
    releases[0]!() // frees an A slot (and person x): next in ring after A's turn... C is blocked by nothing now
    await Bun.sleep(0)
    expect(order.length).toBe(4)
    for (const r of [...releases]) r()
    await Bun.sleep(0)
    for (const r of releases.slice(4)) r()
    await Promise.all(pending)
    expect(s.stats).toEqual({ running: 0, queued: 0 })
  })
})

describe('protocol', () => {
  test('frames round-trip, split anywhere', () => {
    const a = encodeFrame({ t: 'x', n: 1 }, new Uint8Array([1, 2, 3]))
    const b = encodeFrame({ t: 'y' })
    const all = new Uint8Array([...a, ...b])
    for (let cut = 0; cut <= all.length; cut++) {
      const d = new FrameDecoder(1024, 1024)
      const frames = [...d.push(all.subarray(0, cut)), ...d.push(all.subarray(cut))]
      expect(frames.map((f) => f.h)).toEqual([{ t: 'x', n: 1 }, { t: 'y' }])
      expect([...frames[0]!.body!]).toEqual([1, 2, 3])
    }
  })

  test('oversized frames are rejected from the length prefix', () => {
    const d = new FrameDecoder(64, 64)
    const big = encodeFrame({ t: 'x' }, new Uint8Array(1000))
    expect(() => d.push(big.subarray(0, 8))).toThrow(ProtocolError)
  })
})
