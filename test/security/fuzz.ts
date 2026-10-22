// Path / argument fuzzer for the agent shell and the MCP tools (plan §7.1 "경로 퍼저", §7.4 "퍼저 24시간 0건").
//
//   bun run test:fuzz                        60 s, random seed (CI mode)
//   bun run test:fuzz --seconds 86400 --seed 42
//   FUZZ_SECONDS=600 FUZZ_SEED=7 bun run test:fuzz
//
// Oracle, per call:
//   1. no output (stdout, stderr, tool text) holds a canary from a file the calling token may not read (plan §4.1 R1)
//   2. no output names a hidden folder/file that the command itself did not type (principle 2)
//   3. nothing is ever written outside the draft box: the original tree is byte-identical at the end
//   4. the server never throws (an uncaught error would be an MCP internal error), and
//   5. every call returns within the command deadline (+ slack)
// At the end: every stored draft is checked against its writer's forbidden canaries, and the audit chain verifies.
import { verifyAudit } from '../../src/audit'
import { LIMITS } from '../../src/config'
import { textOf } from '../helpers'
import { ALL_CASES, ROLES, SYSTEM_DIRS, securitySetup, type Role, type SecEnv } from './fixture'

export interface FuzzOptions { seconds: number; seed: number; log?: (s: string) => void; maxFailures?: number }
export interface Failure { iteration: number; role: Role; kind: string; detail: string; input: string }
export interface FuzzStats {
  seed: number; seconds: number; iterations: number; shellCalls: number; toolCalls: number; callsPerSecond: number
  maxCallMs: number; exitCodes: Record<string, number>; templates: number; failures: Failure[]
}

/** mulberry32: small, seedable, good enough to pick things. */
export function rng(seed: number) {
  let a = seed >>> 0
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!, chance: (p: number) => next() < p }
}
type R = ReturnType<typeof rng>

const SEGS = (p: string) => p.split('/').filter(Boolean)

/** Names that exist only where `role` cannot see (never in any path the role can read, never generic). */
export function hiddenNames(role: Role): string[] {
  const generic = new Set(['c.md', 'c.csv', 'sub', 'drafts'])
  const seen = new Set(ALL_CASES.filter((c) => c.readers.includes(role)).flatMap((c) => SEGS(c.vpath)))
  // folders the demo always shows to everyone in 전체 plus the scope roots
  for (const s of ['프로젝트', '공용', '개인_kim', '경영', 'README.md', '견적_2026.md', '사양서.docx', '일정.hwpx', '회의록.hwp', '공지.md', '메모.md']) if (role !== 'bossNarrow' && role !== 'kimScoped') seen.add(s)
  return [...new Set(ALL_CASES.filter((c) => !c.readers.includes(role)).flatMap((c) => SEGS(c.vpath)))].filter((n) => !seen.has(n) && !generic.has(n))
}

// ---------- generators ----------
const EXTRA_PATHS = ['/', '/drafts', '/drafts/@boss-laptop', '/drafts/@kim-laptop', '/.raw', '/.raw/공용', '/bin', '/proc/self', '/dev/null', '/tmp', '/home', '.', '..', '~',
  '/없는폴더', '/공용/없음.md', '/경영', '/인사', '/영업', '/대외비', '/프로젝트/외주', '/공용/잠금/아래', '/개인_kim/sub']

function basePath(r: R): string {
  if (r.chance(0.7)) return r.pick(ALL_CASES).vpath
  if (r.chance(0.5)) { const p = r.pick(ALL_CASES).vpath; return p.slice(0, p.lastIndexOf('/')) || '/' }
  return r.pick(EXTRA_PATHS)
}

const MUTATORS: ((p: string, r: R) => string)[] = [
  (p) => p.replace(/\//g, '//'),
  (p) => p.replace(/\/([^/]+)$/, '/./$1'),
  (p, r) => { const s = SEGS(p); if (!s.length) return p; const i = r.int(s.length); s.splice(i, 0, r.pick(['x', '..', '.', '없음', s[0]!]), '..'); return '/' + s.join('/') },
  (p) => '/drafts/..' + p,
  (p) => '/drafts/@boss-laptop/../..' + p,
  (p) => '/.raw' + p,
  (p) => '/.raw/..' + p,
  (p) => '/.raw/.raw' + p,
  (p) => p.normalize('NFD'),
  (p) => p.normalize('NFKC'),
  (p, r) => p.replace(/[a-z]/g, (c) => r.chance(0.5) ? c.toUpperCase() : c),
  (p) => p + '.',
  (p) => p + ' ',
  (p) => p + '/',
  (p) => p + '/.',
  (p) => p + '/..',
  (p) => p.replace(/\.\./g, '%2e%2e').replace(/\//g, (m) => m),
  (p) => encodeURI(p),
  (p) => p.replace(/\//g, '／'),
  (p) => p.replace(/\//g, '∕'),
  (p, r) => { const i = r.int(p.length + 1); return p.slice(0, i) + r.pick(['\u200b', '\u202e', '\ufeff', '\u00ad']) + p.slice(i) },
  (p, r) => p + '/' + 'a'.repeat(r.pick([255, 256, 1024, 5000])),
  (p, r) => '/' + Array.from({ length: r.pick([50, 300]) }, () => '..').join('/') + p,
  (p, r) => p.replace(/[^/]$/, r.pick(['*', '?', '[a-z가-힣]', '{d,v}'])),
  (p, r) => { const s = SEGS(p); if (!s.length) return '/*'; s[r.int(s.length)] = r.pick(['*', '?*', '.*', '[#@.~$]*', '**']); return '/' + s.join('/') },
  (p, r) => { const s = SEGS(p); if (!s.length) return p; const i = r.int(s.length); s[i] = `{${s[i]},${r.pick(SYSTEM_DIRS)},인사,잠금}`; return '/' + s.join('/') },
  (p, r) => p.replace(/[^/]+$/, (b) => r.pick(['->', ' -> ', '@']) + b),
  (p) => p.replace(/^\//, '~/../'),
  (p) => p.replace(/^\//, '$HOME/../'),
  (p, r) => p.replace(/[^/]+$/, (b) => r.pick(['#recycle/', '@eaDir/', '.snapshot/', '._', '~$']) + b),
  (p, r) => p.replace(/[가-힣]/, (c) => r.chance(0.5) ? c.normalize('NFD') : c),
]

/** Bash-quote a path in one of several ways (all meaning the same bytes, or deliberately not). */
function quote(p: string, r: R): string {
  switch (r.int(8)) {
    case 0: return p.replace(/([\s'"\\$`!;&|<>(){}*?[\]#~])/g, '\\$1')
    case 1: return `'${p.replace(/'/g, `'\\''`)}'`
    case 2: return `"${p.replace(/(["\\$`])/g, '\\$1')}"`
    case 3: return `$'${[...p].map((c) => c === '/' ? '\\x2f' : c === "'" ? "\\'" : c === '\\' ? '\\\\' : c).join('')}'`
    case 4: return `$'${p.replace(/'/g, "\\'")}\\x00tail'`
    case 5: return `"$(printf %s ${JSON.stringify(p).replace(/\$/g, '\\$')})"`
    case 6: return `\`echo ${JSON.stringify(p).replace(/\$/g, '\\$')}\``
    default: return p // unquoted: globs and braces expand
  }
}

const TEMPLATES = [
  'cat P', 'cat P Q', 'ls -la P', 'ls -laR P', 'ls -d P', 'head -c 300 P', 'tail -n 5 P', 'wc P', 'stat P', 'du -a P', 'find P', 'find P -type f -exec cat {} \\;',
  'tree P', 'file P', 'sha256sum P', 'od -c P | head', 'base64 P', 'strings P', 'sort P', 'uniq P', 'sed -n p P', "awk '{print}' P", 'nl P', 'rev P', 'tac P', 'cut -c1-80 P',
  'grep -r CANARY P', 'grep -rl . P', 'grep -rc . P', 'grep -h . P', 'grep -ro "CANARY_[A-Za-z]*" P', 'egrep -r "secret|CANARY" P', 'fgrep -r CANARY P', 'rg -n . P',
  'rg --files P', 'rg -l CANARY P', 'rg -g "*" CANARY P', 'grep -r --include="*" CANARY P', 'grep -q CANARY P && echo FOUND', 'jq -R . P', 'xan headers P',
  'cat P > /drafts/fN.md; cat /drafts/fN.md', 'cp P /drafts/cN.md && cat /drafts/cN.md', 'cp -r P /drafts/dN && grep -r . /drafts/dN', 'tar -cf /drafts/tN.tar P && tar -tf /drafts/tN.tar',
  'echo x > P', 'echo x >> P', 'printf x | tee P', 'touch P', 'mkdir -p P/new', 'rm -rf P', 'mv P /drafts/mN', 'sed -i s/a/b/ P', 'chmod 777 P', 'cp /공용/c.md P',
  'cat $(echo P)', 'cat `echo P`', 'cat <<EOF\n$(cat P)\nEOF', 'while read -r l; do echo "$l"; done < P', 'cd P && cat *', 'cd P && grep -r . .', 'cd P/.. && ls -la',
  'echo P | xargs cat', 'xargs cat <<< P', 'for f in P; do cat "$f"; done', 'source P', '. P', 'bash P', 'bash -c "cat P"', 'eval "cat P"', 'sh -c \'cat "$1"\' _ P',
  'test -f P && cat P', '[ -d P ] && ls P', 'diff P Q', 'paste P Q', 'join P Q', 'comm P Q', 'exec 3< P; cat <&3', 'cat 0< P', 'cat < P > /drafts/rN.md',
  'ln -s P /drafts/lN; cat /drafts/lN', 'sqlite3 P .dump', 'gzip -c P | gunzip', 'split -l 1 P /drafts/sN && cat /drafts/sN*', 'echo P*', 'ls P/*', 'compgen -f P',
  'readlink -f P', 'realpath P', 'cat /drafts/*', 'cat /drafts/@*/*', 'grep -r . /drafts', 'ls -laR /drafts', 'basename P; dirname P', 'declare -a a=(P); cat "${a[@]}"',
]

/** grep/rg options, allowed and refused ones (the allowlist must hold under any mix). */
const GREP_FLAGS = ['-r', '-R', '-i', '-n', '-l', '-L', '-c', '-q', '-s', '-E', '-F', '-G', '-w', '-x', '-v', '-o', '-h', '-H', '-a', '-I', '-A1', '-B 2', '-C1', '-m1', '-e CANARY',
  '-e -x', '--include=*', '--exclude=*.md', '--exclude-dir=*', '-P', '-z', '-f P', '--files-from=P', '--null', '-Z', '--binary-files=text', '--label=x', '-U', '--line-buffered', '--color=always', '-D skip', '-d recurse']
const RG_FLAGS = ['-i', '-S', '-s', '-n', '-N', '-l', '-c', '-q', '-F', '-w', '-x', '-v', '-o', '-H', '-I', '-a', '-u', '-uu', '-uuu', '-A1', '-m1', '-g *', '-g !*.md', '-g /**', '--files', '--hidden',
  '--no-ignore', '-L', '--follow', '--pre cat', '--pre=sh', '--pre-glob *', '-z', '--search-zip', '--ignore-file P', '--no-config', '--type-add x:*', '-t md', '--replace X', '-r X', '--json',
  '--path-separator x', '--max-depth 1', '--sort path', '--threads 1', '-j1', '--debug', '--trace', '-P', '--engine pcre2', '--mmap', '--null-data', '--files-with-matches', '-0']

function command(r: R, n: number): string {
  const one = () => {
    let t = r.pick(TEMPLATES)
    if (r.chance(0.1)) {
      const rg = r.chance(0.5)
      const flags = Array.from({ length: 1 + r.int(3) }, () => r.pick(rg ? RG_FLAGS : GREP_FLAGS)).join(' ')
      t = `${rg ? 'rg' : r.pick(['grep', 'egrep', 'fgrep'])} ${flags} ${r.pick(['CANARY', 'secret', '.', "'C.N.RY'", '-', '--'])} P`
    }
    const path = () => { let p = basePath(r); for (let i = r.int(4); i > 0; i--) p = r.pick(MUTATORS)(p, r); return quote(p, r) }
    return t.replaceAll('P', path).replaceAll('Q', path).replaceAll('fN', `f${n}`).replaceAll('cN', `c${n}`).replaceAll('dN', `d${n}`).replaceAll('tN', `t${n}`)
      .replaceAll('mN', `m${n}`).replaceAll('rN', `r${n}`).replaceAll('lN', `l${n}`).replaceAll('sN', `s${n}`)
  }
  let c = one()
  for (let i = r.int(3); i > 0; i--) c += r.pick(['; ', ' && ', ' || ', ' | ']) + one()
  if (r.chance(0.1)) c += ' 2>&1'
  return c
}

function toolCall(r: R): [string, Record<string, unknown>] {
  let p = basePath(r)
  for (let i = r.int(4); i > 0; i--) p = r.pick(MUTATORS)(p, r)
  if (r.chance(0.2)) p = '/drafts/' + r.pick(['a.md', '@boss-laptop/x.md', '../경영/c.md', 'x/../../인사/c.csv', 'f1.md', 'sub/a.csv', 'a.docx', ''])
  const name = r.pick(['read', 'read', 'write', 'edit', 'history'])
  const args: Record<string, unknown> = { path: p }
  if (name === 'read') { if (r.chance(0.3)) args.offset = r.pick([0, -5, 1, 2, 1e9, 'x', null]); if (r.chance(0.3)) args.limit = r.pick([0, -1, 1, 1e12, 'x']) }
  if (name === 'write') { args.content = r.pick(['x', '', 'CANARY_fake\n', 'a'.repeat(1000)]); if (r.chance(0.2)) args.expected_sha256 = r.pick(['0'.repeat(64), 'zz']) }
  if (name === 'edit') { args.old_string = r.pick(['x', '', 'secret', 'a']); args.new_string = 'y'; if (r.chance(0.3)) args.replace_all = true }
  if (name === 'history') { args.action = r.pick(['list', 'read', 'restore', 'nuke']); if (r.chance(0.6)) args.version = r.pick([1, 2, 0, -1, 99, 'x']) }
  return [name, args]
}

// ---------- oracle ----------
/** What bash brace expansion can build from the typed text (a{b,c}d -> abd acd), capped. A name built that way was typed. */
export function expandBraces(s: string, cap = 256): string[] {
  const out: string[] = []
  const go = (t: string) => {
    if (out.length >= cap) return
    const m = /\{([^{}]*,[^{}]*)\}/.exec(t)
    if (!m) { out.push(t); return }
    for (const alt of m[1]!.split(',')) go(t.slice(0, m.index) + alt + t.slice(m.index + m[0].length))
  }
  go(s)
  return out
}

function makeOracle(e: SecEnv) {
  const forbidden = new Map(ROLES.map((role) => [role, e.forbidden(role).filter((c) => c.startsWith('CANARY_'))]))
  const names = new Map(ROLES.map((role) => [role, hiddenNames(role)]))
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const nameRe = new Map([...names].map(([role, ns]) => [role, ns.map((n) => [n, new RegExp(`(^|[\\s/'":])${esc(n)}($|[\\s/:'"])`, 'm')] as const)]))
  /** `drafts`: names and text of the person's drafts (earlier commands may have stored typed names there). */
  return (role: Role, input: string, output: string, drafts: string): { kind: string; detail: string } | null => {
    for (const c of forbidden.get(role)!) if (output.includes(c)) return { kind: 'canary', detail: c }
    const plain = input.replace(/\\x([0-9a-fA-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))).replace(/\\(.)/g, '$1')
    const typed = [input, plain, ...expandBraces(plain), drafts].map((t) => t + '\n' + t.normalize('NFC') + '\n' + t.normalize('NFD')).join('\n')
    for (const [n, re] of nameRe.get(role)!) {
      if (typed.includes(n) || typed.includes(n.normalize('NFD'))) continue
      // brace/glob inputs may legitimately produce a hidden name only as the unexpanded word: those contain the name typed
      if (re.test(output.normalize('NFC'))) return { kind: 'hidden-name', detail: n }
    }
    return null
  }
}

export async function runFuzz(opts: FuzzOptions): Promise<FuzzStats> {
  const log = opts.log ?? (() => {})
  const e = securitySetup()
  const r = rng(opts.seed)
  const before = e.snapshot()
  const oracle = makeOracle(e)
  const stats: FuzzStats = { seed: opts.seed, seconds: opts.seconds, iterations: 0, shellCalls: 0, toolCalls: 0, callsPerSecond: 0, maxCallMs: 0, exitCodes: {}, templates: TEMPLATES.length, failures: [] }
  const deadline = LIMITS.commandMs + 5000
  const fuzzRoles: Role[] = ['kim', 'bossNarrow', 'kimScoped', 'lee', 'park', 'dion', 'kimRO', 'boss']
  const draftCache = new Map<number, { stamp: number; text: string }>()
  /** Paths and contents of every draft (all versions) of the role's person: typed names can come back from there. */
  const draftText = (role: Role) => {
    const person = e.tok(role).person_id
    const stamp = e.db.query<{ n: number }, []>('SELECT coalesce(max(rowid), 0) AS n FROM draft_versions').get()!.n
    const hit = draftCache.get(person)
    if (hit && hit.stamp === stamp) return hit.text
    const rows = e.db.query<{ path: string; sha256: string }, [number]>('SELECT d.path, v.sha256 FROM drafts d JOIN draft_versions v ON v.draft_id = d.id WHERE d.person_id = ?').all(person)
    const text = rows.map((r) => r.path + '\n' + new TextDecoder().decode(e.ctx.blobs.get(r.sha256))).join('\n')
    draftCache.set(person, { stamp, text })
    return text
  }
  const fail = (f: Failure) => { stats.failures.push(f); log(`FAIL #${f.iteration} [${f.role}] ${f.kind}: ${f.detail}\n  input: ${JSON.stringify(f.input)}`) }
  const t0 = performance.now()
  try {
    while (performance.now() - t0 < opts.seconds * 1000 && stats.failures.length < (opts.maxFailures ?? 20)) {
      const i = stats.iterations++
      const role = r.pick(fuzzRoles)
      const shell = r.chance(0.8)
      const started = performance.now()
      let input = '', output = ''
      try {
        if (shell) {
          input = command(r, i)
          const res = await e.sh(role, input)
          stats.shellCalls++
          output = res.stdout + '\n' + res.stderr
          stats.exitCodes[res.exitCode] = (stats.exitCodes[res.exitCode] ?? 0) + 1
        } else {
          const [name, args] = toolCall(r)
          input = `${name} ${JSON.stringify(args)}`
          const res = await e.tool(role, name, args)
          stats.toolCalls++
          output = textOf(res)
        }
      } catch (err) {
        fail({ iteration: i, role, kind: 'crash', detail: String((err as Error)?.stack ?? err).slice(0, 500), input })
        continue
      }
      const ms = performance.now() - started
      stats.maxCallMs = Math.max(stats.maxCallMs, ms)
      if (ms > deadline) fail({ iteration: i, role, kind: 'timeout', detail: `${ms.toFixed(0)} ms`, input })
      const bad = oracle(role, input, output, draftText(role))
      if (bad) fail({ iteration: i, role, ...bad, input: input + '\n--- output ---\n' + output.slice(0, 2000) })
      if (i % 500 === 499) log(`… ${i + 1} iterations, ${stats.failures.length} failures, ${((performance.now() - t0) / 1000).toFixed(0)} s`)
    }
    // 3: originals never written
    const after = e.snapshot()
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (before[k] !== after[k]) fail({ iteration: -1, role: 'kim', kind: 'original-changed', detail: `${k}: ${before[k]} -> ${after[k]}`, input: '' })
    }
    // drafts: nobody stored bytes they could not read
    for (const role of fuzzRoles) {
      const forb = e.forbidden(role).filter((c) => c.startsWith('CANARY_'))
      const rows = e.db.query<{ sha256: string; path: string }, [number]>('SELECT v.sha256, d.path FROM drafts d JOIN draft_versions v ON v.draft_id = d.id WHERE d.token_id = ?').all(e.tok(role).id)
      for (const row of rows) {
        const text = new TextDecoder().decode(e.ctx.blobs.get(row.sha256))
        for (const c of forb) if (text.includes(c)) fail({ iteration: -1, role, kind: 'draft-canary', detail: `${row.path} holds ${c}`, input: '' })
      }
    }
    const audit = verifyAudit(e.db)
    if (!audit.ok) fail({ iteration: -1, role: 'kim', kind: 'audit-chain', detail: `broken at ${audit.brokenAt}`, input: '' })
  } finally { e.cleanup() }
  stats.callsPerSecond = +(stats.iterations / ((performance.now() - t0) / 1000)).toFixed(1)
  stats.maxCallMs = +stats.maxCallMs.toFixed(1)
  return stats
}

if (import.meta.main) {
  const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined }
  const seconds = Number(arg('--seconds') ?? process.env.FUZZ_SECONDS ?? 60)
  const seed = Number(arg('--seed') ?? process.env.FUZZ_SEED ?? Math.floor(Math.random() * 2 ** 31))
  console.log(`fuzz: seed ${seed}, ${seconds} s (repeat with --seed ${seed})`)
  const stats = await runFuzz({ seconds, seed, log: (s) => console.log(s), maxFailures: Number(arg('--max-failures') ?? 20) })
  console.log(JSON.stringify({ ...stats, failures: stats.failures.length }, null, 2))
  process.exit(stats.failures.length ? 1 : 0)
}
