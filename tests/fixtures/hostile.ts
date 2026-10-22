// "Extractors" that misbehave, loaded inside the worker by tests/worker.test.ts. Each is called as fn(name, bytes);
// `name` carries the test's argument. They return a description of what happened, so the test can assert on it.
import { dlopen, FFIType, ptr } from 'bun:ffi'
import fs from 'node:fs'
import net from 'node:net'

/** Infinite loop: never returns, never yields. */
export function spin(): string {
  for (;;) { /* burn */ }
}

/** Memory bomb: grows without bound. */
export function bomb(): string {
  const arr: number[][] = []
  for (;;) arr.push(new Array(100_000).fill(Math.random()))
}

/** Busy for `name` milliseconds, then answer (a "heavy" but finite job). */
export function busy(name: string): string {
  const until = performance.now() + Number(name)
  let x = 0
  while (performance.now() < until) x++
  return `done ${x > 0}`
}

/** Starts a long-lived child (the test grants /bin/sleep), reports its pid on stderr, then spins forever. */
export function spawnAndSpin(): string {
  const child = Bun.spawn(['/bin/sleep', '300'], { stdout: 'ignore', stderr: 'ignore' })
  fs.writeSync(2, `child-pid ${child.pid}\n`)
  for (;;) { /* burn */ }
}

/** Tries the network in several ways; `name` is the port of a server the test runs on 127.0.0.1. */
export async function network(name: string): Promise<string> {
  const results: string[] = []
  const attempt = async (label: string, f: () => Promise<unknown>) => {
    try { await f(); results.push(`${label}:OK`) } catch (e) { results.push(`${label}:BLOCKED(${(e as Error).message.slice(0, 60)})`) }
  }
  const tcp = (host: string, port: number) => new Promise((resolve, reject) => {
    const s = net.connect({ host, port, timeout: 3000 }, () => { s.destroy(); resolve(null) })
    s.on('error', reject)
    s.on('timeout', () => { s.destroy(); reject(new Error('timeout')) })
  })
  await attempt('fetch', () => fetch('http://example.com', { signal: AbortSignal.timeout(3000) }).then((r) => r.status))
  await attempt('tcp', () => tcp('1.1.1.1', 80))
  await attempt('local-fetch', () => fetch(`http://127.0.0.1:${name}/`, { signal: AbortSignal.timeout(3000) }).then((r) => r.status))
  await attempt('local-tcp', () => tcp('127.0.0.1', Number(name)))
  return results.join(' ')
}

/** Tries to write `name` (an absolute path). */
export function writeTo(name: string): string {
  try { fs.writeFileSync(name, 'pwned'); return 'WRITE-OK' } catch (e) { return `WRITE-BLOCKED ${(e as NodeJS.ErrnoException).code}` }
}

/** Tries to read `name`. */
export function readFrom(name: string): string {
  try { return `READ-OK ${fs.readFileSync(name, 'utf8').slice(0, 40)}` } catch (e) { return `READ-BLOCKED ${(e as NodeJS.ErrnoException).code}` }
}

/** Tries to list `name`. */
export function listDir(name: string): string {
  try { return `LIST-OK ${fs.readdirSync(name).join(',')}` } catch (e) { return `LIST-BLOCKED ${(e as NodeJS.ErrnoException).code}` }
}

/** Tries to start a process. */
export function exec(name: string): string {
  try { const r = Bun.spawnSync([name]); return `EXEC-OK ${r.exitCode}` } catch (e) { return `EXEC-BLOCKED ${(e as Error).message.slice(0, 60)}` }
}

/** Writes a lot to stdout (the protocol channel) and stderr. */
export function flood(): string {
  const chunk = Buffer.alloc(1 << 20, 0x41)
  for (;;) fs.writeSync(2, chunk)
}

/** A well-behaved extractor. */
export function upper(name: string, bytes: Uint8Array): string {
  return `${name}: ${new TextDecoder().decode(bytes).toUpperCase()}`
}

/** Writes junk onto the protocol channel (stdout), then waits. */
export function garbage(): string {
  fs.writeSync(1, 'this is not a frame, just noise from a confused library\n')
  for (;;) { /* wait to be killed */ }
}

/** Speaks the protocol dishonestly. `name`: 'cmd' asks the parent to run a command the job did not offer;
 *  'late' reports done and then still sends a write. */
export async function forge(name: string): Promise<string> {
  const { encodeFrame } = await import('../../src/worker/protocol')
  if (name === 'cmd') fs.writeSync(1, encodeFrame({ t: 'cmd', id: 9001, name: 'rm', args: ['-rf', '/'], cwd: '/' }))
  if (name === 'late') {
    fs.writeSync(1, encodeFrame({ t: 'done', ok: true, result: { bytes: 0 } }))
    fs.writeSync(1, encodeFrame({ t: 'fs', id: 9002, op: 'write', args: ['/drafts/late.txt'] }, new TextEncoder().encode('sneaked in')))
  }
  for (;;) { /* wait to be killed */ }
}

/** Reads another process's argv + initial environment (sysctl KERN_PROCARGS2); `name` = pid. Reports whether
 *  the variable TDRIVE_TEST_CANARY was visible. */
export function procargs(name: string): string {
  const lib = dlopen('/usr/lib/libSystem.B.dylib', { sysctl: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 } })
  const mib = new Int32Array([1, 49, Number(name)]) // CTL_KERN, KERN_PROCARGS2, pid
  const buf = new Uint8Array(1 << 18)
  const len = new BigUint64Array([BigInt(buf.length)])
  if (lib.symbols.sysctl(ptr(mib), 3, ptr(buf), ptr(len), null, 0) !== 0) return 'PROCARGS-BLOCKED'
  return `PROCARGS-OK canary=${new TextDecoder().decode(buf.subarray(0, Number(len[0]))).includes('TDRIVE_TEST_CANARY=')}`
}

/** Sends signal 0 to `name` (a pid). */
export function signal(name: string): string {
  try { process.kill(Number(name), 0); return 'SIGNAL-OK' } catch (e) { return `SIGNAL-BLOCKED ${(e as NodeJS.ErrnoException).code}` }
}

/** Asks the parent for `name` (a count) reads of /big at once, then never reads its stdin again (a busy loop). */
export async function readFlood(name: string): Promise<string> {
  const { encodeFrame } = await import('../../src/worker/protocol')
  for (let i = 0; i < Number(name); i++) fs.writeSync(1, encodeFrame({ t: 'fs', id: 7000 + i, op: 'read', args: ['/big'] }))
  for (;;) { /* never read the replies */ }
}

/** Linux: every process this worker can see in /proc, their command lines, and whether any readable environment or
 *  command line holds TDRIVE_TEST_CANARY (the test runner's environment). */
export function procScan(): string {
  const pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).map(Number)
  const cmdlines: string[] = [], environs: string[] = []
  let canary = false
  for (const p of pids) {
    for (const [file, out] of [['cmdline', cmdlines], ['environ', environs]] as const) {
      try {
        const t = fs.readFileSync(`/proc/${p}/${file}`, 'utf8')
        out.push(`${p}:${t.replace(/\0/g, ' ').trim()}`)
        if (t.includes('TDRIVE_TEST_CANARY')) canary = true
      } catch (e) { out.push(`${p}:${(e as NodeJS.ErrnoException).code}`) }
    }
  }
  return JSON.stringify({ pids, cmdlines, environs: environs.map((e) => e.slice(0, 200)), canary })
}

/** Linux: the privilege lines of /proc/self/status. */
export function selfStatus(): string {
  return fs.readFileSync('/proc/self/status', 'utf8').split('\n').filter((l) => /^(Uid|NoNewPrivs|Seccomp|Cap(Inh|Prm|Eff|Bnd|Amb)):/.test(l)).join(' | ')
}

/** Linux: signal 0 to every pid up to `name`; returns the processes (thread groups) it reached other than itself and
 *  pid 1 (bwrap's init in its namespace). Thread ids of the worker's own threads also answer kill(); /proc/<tid>/status
 *  tells them apart. */
export function signalScan(name: string): string {
  const reached = new Set<number>()
  for (let p = 2; p <= Number(name); p++) {
    try { process.kill(p, 0) } catch { continue }
    let tgid = p
    try { tgid = Number(/^Tgid:\s*(\d+)/m.exec(fs.readFileSync(`/proc/${p}/status`, 'utf8'))?.[1] ?? p) } catch {}
    if (tgid !== process.pid && tgid !== 1) reached.add(tgid)
  }
  return JSON.stringify([...reached])
}
