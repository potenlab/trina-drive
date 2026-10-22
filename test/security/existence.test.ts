// Principle 2 (plan §4): what a token cannot see answers exactly like what does not exist — stdout, stderr, exit
// code, folder sizes and counts. Every command runs on a hidden path and on a nonexistent sibling; outputs are compared
// byte for byte after replacing each path (and its last name) with a placeholder.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { setFlag, setRule } from '../../src/store'
import { textOf } from '../helpers'
import { securitySetup, xsym, type Role, type SecEnv } from './fixture'

let e: SecEnv
beforeAll(() => { e = securitySetup() })
afterAll(() => e.cleanup())

/** %P = the path, %B = its last name, %D = its parent. */
export const COMMANDS = [
  'ls %P', 'ls -la %P', 'ls -d %P', 'ls -R %P', 'ls -la %P/', 'ls %P/..', 'ls -la %D', 'ls %D | wc -l',
  'stat %P', 'stat %P/c.md', 'du %P', 'du -s %P', 'du -a %D', 'find %P', 'find %P -type f', 'find %D -name %B', 'find %D -maxdepth 1 | wc -l',
  'wc %P', 'wc -c %P', 'wc -l %P/c.md', 'head %P', 'head -c 5 %P/c.md', 'tail %P', 'cat %P', 'cat %P/c.md', 'cat /.raw%P/c.md', 'ls /.raw%P',
  'grep -r x %P', 'grep -rl secret %P', 'grep -rc secret %P', 'grep -l secret %P/c.md', 'grep -c secret %P/c.md', 'grep -q secret %P/c.md; echo $?',
  'rg x %P', 'rg --files %P', 'rg -c secret %P', 'grep -r secret %D | wc -l',
  'test -e %P; echo $?', 'test -d %P; echo $?', 'test -f %P/c.md; echo $?', '[ -f %P ] && echo y || echo n', '[ -r %P ]; echo $?', '[ -s %P/c.md ]; echo $?',
  'cd %P; echo $?; pwd', 'cd %P/..; pwd', 'tree %P', 'tree %D', 'echo %P*', 'echo %P/*', 'echo %D/*', 'echo {%P,%P}/c.md', 'echo %P/{a,c}.md', 'compgen -f %P', 'compgen -f %D/',
  'readlink -f %P', 'realpath %P', 'file %P', 'file %P/c.md', 'sha256sum %P/c.md', 'md5sum %P/c.md', 'od -c %P/c.md | head -2',
  'diff %P/c.md /공용/c.md', 'cp %P/c.md /drafts/x.md', 'cp -r %P /drafts/xd', 'mv %P /drafts/y', 'rm %P', 'rm -rf %P', 'touch %P', 'mkdir %P', 'mkdir -p %P/a',
  'echo x > %P', 'echo x >> %P/c.md', 'echo x > %P/new.md', 'tar -cf /drafts/t.tar %P', 'source %P/c.md', '. %P/c.md', 'bash %P/c.md',
  'cat < %P/c.md', 'x=$(< %P/c.md); echo ${#x}', 'echo %P/c.md | xargs cat', 'sort %P/c.md', 'ls %P 2>&1 | wc -c', 'jq . %P/c.md',
  'sqlite3 %P/c.md "select 1"', 'basename %P', 'cat %P/c.md 2>&1; echo "[$?]"', 'for f in %P/*; do echo "$f"; done', 'shopt -s nullglob; echo %P/*',
  'ls -la %P %D 2>&1 | tail -n +1', 'stat -c %s %P', 'head -n1 %P/c.md %D/c.md 2>&1', 'cat /drafts/../%P/c.md', 'ls %P/./',
]

/** [hidden path, role, why]. Compared with sib(path): a nonexistent sibling whose name has the same byte length. */
const PAIRS: [string, Role, string][] = [
  ['/인사', 'kim', 'hidden registered folder'],
  ['/대외비', 'kim', 'no-AI registered folder'],
  ['/영업', 'boss', 'hidden registered folder'],
  ['/프로젝트/비공개', 'kim', 'inherit break'],
  ['/프로젝트/외주', 'kim', 'nested registration'],
  ['/프로젝트/hr', 'lee', 'symlinked folder'],
  ['/공용/잠금', 'kim', 'no-AI flag'],
  ['/공용/격리', 'kim', 'quarantine'],
  ['/공용/대기', 'kim', 'widened-pending'],
  ['/공용/#recycle', 'kim', 'NAS system folder'],
  ['/공용/@eaDir', 'kim', 'NAS system folder'],
  ['/공용/kim만', 'boss', 'break + person rule'],
  ['/개인_kim', 'dion', 'personal folder vs admin'],
  ['/경영', 'bossNarrow', 'outside the token scope'],
  ['/공용', 'bossNarrow', 'outside the token scope'],
  ['/공용/회계2', 'kimScoped', 'outside a sub-folder scope'],
]
/** Hidden files, for file-level commands (%P is the file). */
const FILE_PAIRS: [string, Role, string][] = [
  ['/경영/c.md', 'kim', 'file in a folder shown only as a bare path'],
  ['/프로젝트/급여링크.csv', 'lee', 'symlink to a file the role CAN read'],
  ['/프로젝트/평가사본.csv', 'kim', 'hard link'],
  ['/프로젝트/참고.xlsx', 'kim', 'XSym link file'],
  ['/공용/.DS_Store', 'kim', 'OS litter'],
  ['/drafts/@boss-laptop', 'kim', 'another person\'s token drafts'],
]
const FILE_COMMANDS = ['cat %P', 'head -1 %P', 'wc -c %P', 'stat %P', 'ls -l %P', 'grep x %P', 'grep -c x %P', 'rg x %P', 'sha256sum %P', 'file %P', 'test -e %P; echo $?',
  '[ -f %P ] && echo y || echo n', 'cp %P /drafts/z.md', 'echo x > %P', 'echo x >> %P', 'rm %P', 'touch %P', 'mv %P /drafts/w.md', 'cat /.raw%P', 'du %P', 'find %P',
  'diff %P /공용/c.md', 'sort %P', 'cat < %P', 'ls -la "$(dirname %P)" | grep -c .', 'echo %P*', 'tail -c 3 %P']

/** A nonexistent sibling: the last character swapped for another of the same UTF-8 length. */
export function sib(p: string): string {
  const c = p.at(-1)!
  const alt = Buffer.byteLength(c) === 1 ? (c === 'q' ? 'z' : 'q') : Buffer.byteLength(c) === 3 ? (c === '가' ? '나' : '가') : (() => { throw new Error(c) })()
  return p.slice(0, -1) + alt
}

function norm(s: string, p: string) {
  const b = p.slice(p.lastIndexOf('/') + 1)
  return s.replaceAll(p, '«P»').replaceAll(b, '«B»')
}
async function run(role: Role, tmpl: string, p: string) {
  const d = p.slice(0, p.lastIndexOf('/')) || '/'
  const cmd = tmpl.replaceAll('%P', p).replaceAll('%D', d).replaceAll('%B', p.slice(p.lastIndexOf('/') + 1))
  const r = await e.sh(role, cmd)
  return { out: norm(r.stdout, p), err: norm(r.stderr, p), code: r.exitCode }
}

describe.each(PAIRS)('hidden folder %s (as %s: %s)', (hidden, role) => {
  const missing = sib(hidden)
  test.each(COMMANDS.map((c) => [c]))('%s', async (c) => {
    expect(await run(role, c, hidden)).toEqual(await run(role, c, missing))
  })
  test('MCP read / write / edit / history', async () => {
    for (const [tool, args] of [['read', {}], ['write', { content: 'x' }], ['edit', { old_string: 'a', new_string: 'b' }], ['history', { action: 'list' }]] as const) {
      for (const sub of ['', '/c.md', '/new.md']) {
        const a = await e.tool(role, tool, { ...args, path: hidden + sub }), b = await e.tool(role, tool, { ...args, path: missing + sub })
        expect({ tool, sub, t: norm(textOf(a), hidden), err: a.isError }).toEqual({ tool, sub, t: norm(textOf(b), missing), err: b.isError })
      }
    }
  })
})

describe.each(FILE_PAIRS)('hidden file %s (as %s: %s)', (hidden, role) => {
  const missing = sib(hidden)
  test.each(FILE_COMMANDS.map((c) => [c]))('%s', async (c) => {
    expect(await run(role, c, hidden)).toEqual(await run(role, c, missing))
  })
})

describe('folder sizes and counts do not move when hidden things appear', () => {
  const probes = ['ls -la /공용', 'ls -laR /공용', 'du -a /공용', 'du -s /', 'stat /공용', 'find / | wc -l', 'find /공용 -type d | wc -l', 'ls / | wc -l', 'tree /공용 | tail -1',
    'ls -la /', 'stat /', 'echo /공용/*', 'grep -rc secret /공용 | wc -l', 'rg --files / | wc -l', 'ls -la /프로젝트', 'du -s /프로젝트', 'ls -la /경영']
  test.each([['kim'], ['boss'], ['bossNarrow'], ['kimScoped']] as [Role][])('as %s', async (role) => {
    const before = await Promise.all(probes.map((p) => e.sh(role, p)))
    const mk = (rel: string, body = 'HIDDEN_ADDED\n') => { const p = e.R(rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body) }
    const added: string[] = []
    const add = (rel: string) => { added.push(e.R(rel)) }
    // a new no-AI folder, a new system folder, a symlink, a hard link, a new break folder for someone else, a new
    // registered top folder nobody may read, files inside hidden folders, and an XSym file
    mk('공용/새잠금/a.md'); setFlag(e.db, e.R('공용/새잠금'), 'no_ai', true); add('공용/새잠금')
    mk('공용/#snapshot/new/a.md'); add('공용/#snapshot/new')
    fs.symlinkSync('../경영/c.md', e.R('공용/link.md')); add('공용/link.md')
    mk('인사/hl-src.csv'); fs.linkSync(e.R('인사/hl-src.csv'), e.R('공용/hl.md')); add('공용/hl.md'); add('인사/hl-src.csv')
    mk('공용/park전용/a.md'); setRule(e.db, e.R('공용/park전용'), 'park', 'read', { breakInherit: true }); add('공용/park전용')
    mk('프로젝트/외주/new.md'); add('프로젝트/외주/new.md')
    mk('인사/new.md'); add('인사/new.md')
    fs.writeFileSync(e.R('공용/xs.md'), xsym('../인사/c.csv')); add('공용/xs.md')
    try {
      const after = await Promise.all(probes.map((p) => e.sh(role, p)))
      for (let i = 0; i < probes.length; i++) expect({ probe: probes[i], ...after[i]! }).toEqual({ probe: probes[i], ...before[i]! })
    } finally {
      for (const p of added.reverse()) fs.rmSync(p, { recursive: true, force: true })
    }
  })

  test('as kim, with nothing visible changing: sizes and counts are byte-identical', async () => {
    const strictProbes = ['ls -la /', 'ls -la /경영', 'du -a /경영', 'stat /경영', 'find /경영 | wc -l', 'ls -la /프로젝트', 'du -a /프로젝트', 'find / -type d | wc -l', 'tree /프로젝트 | tail -1']
    const before = await Promise.all(strictProbes.map((p) => e.sh('kim', p)))
    const added = [e.R('경영/new2.md'), e.R('경영/sub-new'), e.R('프로젝트/외주/new2.md'), e.R('프로젝트/비공개/new2.md'), e.R('프로젝트/#recycle')]
    fs.writeFileSync(added[0]!, 'x'); fs.mkdirSync(added[1]!); fs.writeFileSync(path.join(added[1]!, 'a.md'), 'x')
    fs.writeFileSync(added[2]!, 'x'); fs.writeFileSync(added[3]!, 'x'); fs.mkdirSync(added[4]!); fs.writeFileSync(path.join(added[4]!, 'a.md'), 'x')
    try {
      const after = await Promise.all(strictProbes.map((p) => e.sh('kim', p)))
      for (let i = 0; i < strictProbes.length; i++) expect({ p: strictProbes[i], ...after[i] }).toEqual({ p: strictProbes[i], ...before[i]! })
    } finally { for (const p of added) fs.rmSync(p, { recursive: true, force: true }) }
  })
})

describe('timing: hidden vs nonexistent (reported; fails only above 3x)', () => {
  const N = Number(process.env.TDRIVE_TIMING_RUNS ?? 200)
  const pct = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))]!
  const cases: [string, string, Role, string][] = [
    ['cat /인사/c.csv', 'cat /인사x/c.csv', 'kim', 'hidden mount'],
    ['cat /경영/c.md', 'cat /경영/x.md', 'kim', 'hidden file in bare folder'],
    ['ls /프로젝트/외주', 'ls /프로젝트/외주x', 'kim', 'nested registered folder'],
    ['stat /공용/잠금/c.md', 'stat /공용/잠금x/c.md', 'kim', 'no-AI folder'],
    ['cat /경영/c.md', 'cat /경영x/c.md', 'bossNarrow', 'outside scope'],
  ]
  test.each(cases)('%s vs %s (%s)', async (hiddenCmd, missingCmd, role, label) => {
    const h: number[] = [], m: number[] = []
    for (let i = 0; i < N; i++) {
      // interleave so drift hits both sides
      for (const [cmd, xs] of (i % 2 ? [[hiddenCmd, h], [missingCmd, m]] : [[missingCmd, m], [hiddenCmd, h]]) as [string, number[]][]) {
        const t0 = performance.now()
        await e.sh(role, cmd)
        xs.push(performance.now() - t0)
      }
    }
    const r = { label, role, hiddenP50: +pct(h, 0.5).toFixed(2), missingP50: +pct(m, 0.5).toFixed(2), hiddenP95: +pct(h, 0.95).toFixed(2), missingP95: +pct(m, 0.95).toFixed(2) }
    console.log(`[timing] ${JSON.stringify(r)}`)
    expect(r.hiddenP50).toBeLessThan(3 * r.missingP50)
    expect(r.missingP50).toBeLessThan(3 * r.hiddenP50)
    expect(r.hiddenP95).toBeLessThan(3 * r.missingP95)
  }, 120_000)

  test('with 2000 known folders under a hidden mount (policy work grows with folder rows)', async () => {
    const env = securitySetup()
    try {
      for (let i = 0; i < 2000; i++) { const d = env.R(`인사/d${i}`); fs.mkdirSync(d); setRule(env.db, d, '@인사', 'read') }
      const h: number[] = [], m: number[] = []
      for (let i = 0; i < Math.min(N, 100); i++) {
        for (const [cmd, xs] of (i % 2 ? [['cat /인사/d1/c.md', h], ['cat /인가/d1/c.md', m]] : [['cat /인가/d1/c.md', m], ['cat /인사/d1/c.md', h]]) as [string, number[]][]) {
          const t0 = performance.now(); await env.sh('kim', cmd); xs.push(performance.now() - t0)
        }
      }
      const r = { label: '2000 folders under hidden mount', hiddenP50: +pct(h, 0.5).toFixed(2), missingP50: +pct(m, 0.5).toFixed(2), hiddenP95: +pct(h, 0.95).toFixed(2), missingP95: +pct(m, 0.95).toFixed(2) }
      console.log(`[timing] ${JSON.stringify(r)}`)
      expect(r.hiddenP50).toBeLessThan(3 * r.missingP50)
    } finally { env.cleanup() }
  }, 300_000)
})
