// The CLI as a process: `sh` runs one command in the isolated executor and exits (its warm pool must not keep it alive).
import { afterAll, beforeAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CLI = path.resolve(import.meta.dir, '../src/cli.ts')
let dir: string, tmp: string, kim: string

beforeAll(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tdrive-cli-test-')))
  tmp = path.join(dir, 'tmp')
  fs.mkdirSync(tmp)
  const seed = Bun.spawnSync([process.execPath, CLI, '--data', path.join(dir, 'data'), 'demo', 'seed'], { stdout: 'pipe', stderr: 'pipe' })
  expect(seed.exitCode).toBe(0)
  kim = /kim token:\s+(\S+)/.exec(seed.stdout.toString())![1]!
})
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

/** pid, ppid of every running isolated worker (bun …/src/worker/entry.ts). */
function workers(): Map<number, number> {
  const ps = Bun.spawnSync(['ps', '-axo', 'pid=,ppid=,command='], { stdout: 'pipe' }).stdout.toString()
  const out = new Map<number, number>()
  for (const line of ps.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (m && m[3]!.includes('src/worker/entry.ts')) out.set(Number(m[1]), Number(m[2]))
  }
  return out
}

async function sh(command: string, env: Record<string, string> = {}) {
  const t0 = performance.now()
  // TMPDIR: the executor's job dirs land under it, so we can check they are all gone afterwards
  const p = Bun.spawn([process.execPath, CLI, '--data', path.join(dir, 'data'), 'sh', '--token', kim, '-c', command], {
    stdout: 'pipe', stderr: 'pipe', env: { ...process.env, TMPDIR: tmp, TDRIVE_SHELL: 'isolated', ...env },
  })
  const seen = new Set<number>()
  const watch = setInterval(() => { for (const [pid, ppid] of workers()) if (ppid === p.pid) seen.add(pid) }, 25)
  const killer = setTimeout(() => p.kill('SIGKILL'), 15_000)
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  clearInterval(watch)
  clearTimeout(killer)
  return { stdout, stderr, code, ms: performance.now() - t0, workers: seen }
}

test('cli sh runs the command in an isolated worker, exits promptly and leaves no worker behind', async () => {
  // (the sleep keeps the worker alive long enough for the ps poll to see it)
  const r = await sh('ls /; cat /프로젝트/README.md | wc -l; sleep 0.3')
  expect(r.stdout).toBe('drafts\n개인_kim\n공용\n프로젝트\n3\n')
  expect(r.code).toBe(0)
  expect(r.ms).toBeLessThan(5000)
  expect(r.workers.size).toBeGreaterThan(0) // the command really went through worker processes
  await Bun.sleep(200)
  const live = workers()
  for (const pid of r.workers) expect(live.has(pid)).toBe(false)
  // every job dir was removed (that happens only after its worker exited)
  const roots = fs.readdirSync(tmp).filter((n) => n.startsWith('tdrive-work-'))
  for (const root of roots) expect(fs.readdirSync(path.join(tmp, root))).toEqual([])
})

test('cli sh exits with the command\'s exit code, also when the command fails', async () => {
  const r = await sh('cat /경영/손익.csv')
  expect(r.stderr).toContain('No such file or directory')
  expect(r.code).toBe(1)
  expect(r.ms).toBeLessThan(5000)
})
