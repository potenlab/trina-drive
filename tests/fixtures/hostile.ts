// "Extractors" that misbehave, loaded inside the worker by tests/worker.test.ts. Each is called as fn(name, bytes);
// `name` carries the test's argument. They return a description of what happened, so the test can assert on it.
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
