// grep / egrep / fgrep / rg inside the shell, run by real ripgrep (linear-time regex) over the text mirror.
// ripgrep only ever gets an explicit list of mirror files that the policy allowed for this call; it never walks a
// folder. Options are an allowlist; anything else is refused with a message rather than run some slower way.
import { defineCommand, decodeBytesToUtf8, type Command } from 'just-bash'
import { LIMITS } from './config'
import { ExtractError, TOOLS } from './extract'
import { Closed } from './policy'
import { reportInternal, type Hit, type VirtualFs } from './vfs'

type Flavor = 'grep' | 'egrep' | 'fgrep' | 'rg'

interface Opts {
  patterns: string[]; syntax: 'bre' | 'ere' | 'fixed'; icase: 'yes' | 'no' | 'smart'; word: boolean; line: boolean; invert: boolean
  count: boolean; filesWith: boolean; filesWithout: boolean; quiet: boolean; only: boolean; text: boolean; listFiles: boolean
  lineNumber: boolean; filename: boolean | null; after: number; before: number; maxCount: number | null
  recursive: boolean; noMessages: boolean; include: string[]; exclude: string[]; excludeDir: string[]; globs: string[]
  paths: string[]
}

class Usage extends Error {}

const GREP_SHORT = 'rRiynlLcqsEFGwxvohHIae:A:B:C:m:'
const RG_SHORT = 'isSnNlcqFwxvoHIae:A:B:C:m:g:uj:'
const IGNORED_LONG = new Set(['--color', '--colour', '--no-heading', '--hidden', '--no-ignore', '--sort', '--max-columns', '--threads', '--line-buffered', '--no-messages-ignored'])

function parse(flavor: Flavor, args: string[]): Opts {
  const o: Opts = { patterns: [], syntax: flavor === 'egrep' || flavor === 'rg' ? 'ere' : flavor === 'fgrep' ? 'fixed' : 'bre', icase: flavor === 'rg' ? 'no' : 'no',
    word: false, line: false, invert: false, count: false, filesWith: false, filesWithout: false, quiet: false, only: false, text: false, listFiles: false,
    lineNumber: false, filename: null, after: 0, before: 0, maxCount: null, recursive: flavor === 'rg', noMessages: false,
    include: [], exclude: [], excludeDir: [], globs: [], paths: [] }
  const rg = flavor === 'rg'
  const spec = rg ? RG_SHORT : GREP_SHORT
  const num = (v: string | undefined, flag: string) => { if (v === undefined || !/^\d+$/.test(v)) throw new Usage(`option ${flag} needs a number`); return Number(v) }
  const positional: string[] = []
  const set = (flag: string, v?: string) => {
    switch (flag) {
      case 'r': case 'R': case 'recursive': case 'dereference-recursive': if (!rg) o.recursive = true; else throw new Usage(`unsupported option -${flag}`); break
      case 'i': case 'y': case 'ignore-case': o.icase = 'yes'; break
      case 'S': case 'smart-case': o.icase = 'smart'; break
      case 's': if (rg) o.icase = 'no'; else o.noMessages = true; break
      case 'case-sensitive': o.icase = 'no'; break
      case 'no-messages': o.noMessages = true; break
      case 'n': case 'line-number': o.lineNumber = true; break
      case 'N': case 'no-line-number': o.lineNumber = false; break
      case 'l': case 'files-with-matches': o.filesWith = true; break
      case 'L': case 'files-without-match': o.filesWithout = true; break
      case 'c': case 'count': o.count = true; break
      case 'q': case 'quiet': case 'silent': o.quiet = true; break
      case 'E': case 'extended-regexp': o.syntax = 'ere'; break
      case 'F': case 'fixed-strings': o.syntax = 'fixed'; break
      case 'G': case 'basic-regexp': o.syntax = 'bre'; break
      case 'w': case 'word-regexp': o.word = true; break
      case 'x': case 'line-regexp': o.line = true; break
      case 'v': case 'invert-match': o.invert = true; break
      case 'o': case 'only-matching': o.only = true; break
      case 'h': case 'no-filename': o.filename = false; break
      case 'H': case 'with-filename': o.filename = true; break
      case 'I': if (rg) o.filename = false; break // grep -I: skip binary files (the mirror holds text)
      case 'a': case 'text': o.text = true; break
      case 'u': break
      case 'e': case 'regexp': o.patterns.push(v!); break
      case 'A': case 'after-context': o.after = num(v, '-A'); break
      case 'B': case 'before-context': o.before = num(v, '-B'); break
      case 'C': case 'context': o.after = o.before = num(v, '-C'); break
      case 'm': case 'max-count': o.maxCount = num(v, '-m'); break
      case 'g': case 'glob': o.globs.push(v!); break
      case 'include': o.include.push(v!); break
      case 'exclude': o.exclude.push(v!); break
      case 'exclude-dir': o.excludeDir.push(v!); break
      case 'files': if (rg) o.listFiles = true; else throw new Usage('unsupported option --files'); break
      case 'j': break
      default: throw new Usage(`unsupported option ${flag.length === 1 ? '-' : '--'}${flag}`)
    }
  }
  const takesValue = (f: string) => ['e', 'A', 'B', 'C', 'm', 'g', 'j'].includes(f) && spec.includes(f + ':')
  const LONG_VALUE = new Set(['regexp', 'after-context', 'before-context', 'context', 'max-count', 'glob', 'include', 'exclude', 'exclude-dir', 'threads', 'sort', 'max-columns', 'color', 'colour'])
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--') { positional.push(...args.slice(i + 1)); break }
    if (a.startsWith('--')) {
      const [name, inline] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined]
      if (IGNORED_LONG.has('--' + name)) { if (inline === undefined && LONG_VALUE.has(name) && !['color', 'colour'].includes(name)) i++; continue }
      const v = LONG_VALUE.has(name) ? inline ?? args[++i] : undefined
      if (LONG_VALUE.has(name) && v === undefined) throw new Usage(`option --${name} needs a value`)
      set(name, v)
      continue
    }
    if (a.startsWith('-') && a.length > 1) {
      if (/^-\d+$/.test(a)) { o.after = o.before = Number(a.slice(1)); continue }
      for (let j = 1; j < a.length; j++) {
        const f = a[j]!
        if (!spec.includes(f)) throw new Usage(`unsupported option -${f}`)
        if (takesValue(f)) {
          const v = j + 1 < a.length ? a.slice(j + 1) : args[++i]
          if (v === undefined) throw new Usage(`option -${f} needs a value`)
          set(f, v)
          break
        }
        set(f)
      }
      continue
    }
    positional.push(a)
  }
  if (!o.patterns.length && !o.listFiles) {
    if (!positional.length) throw new Usage('no pattern given')
    o.patterns.push(positional.shift()!)
  }
  o.paths = positional
  return o
}

/** GNU BRE -> ERE: \| \( \) \{ \} \+ \? are operators, the bare characters are literals. Plus \< \> word edges. */
export function breToEre(p: string): string {
  let out = ''
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!
    if (c === '\\' && i + 1 < p.length) {
      const n = p[++i]!
      out += '|(){}+?'.includes(n) ? n : n === '<' || n === '>' ? '\\b' : '\\' + n
    } else out += '|(){}+?'.includes(c) ? '\\' + c : c
  }
  return out
}
const ereFix = (p: string) => p.replace(/\\[<>]/g, '\\b')

interface Target { vpath: string; textPath: () => Promise<string>; touch: (strong: boolean) => void; recheck: () => void }

const globRe = (g: string) => new Bun.Glob(g)
const base = (p: string) => p.slice(p.lastIndexOf('/') + 1)

/** Files under the given paths that this call may read, in a stable order, plus error lines. */
async function collect(vfs: VirtualFs, o: Opts, flavor: Flavor, cwd: string): Promise<{ targets: Target[]; errors: string[]; anyDir: boolean }> {
  const targets: Target[] = []
  const errors: string[] = []
  let anyDir = false
  const s = vfs.s
  const add = (h: Hit, vpath: string, explicit: boolean) => {
    const name = base(vpath)
    if (!explicit || flavor === 'rg') {
      if (o.include.length && !o.include.some((g) => globRe(g).match(name))) return
      if (o.exclude.some((g) => globRe(g).match(name))) return
      if (o.globs.length) {
        const pos = o.globs.filter((g) => !g.startsWith('!')), neg = o.globs.filter((g) => g.startsWith('!')).map((g) => g.slice(1))
        const m = (g: string) => g.includes('/') ? globRe(g.replace(/^\//, '')).match(vpath.replace(/^\//, '')) || globRe('**/' + g).match(vpath) : globRe(g).match(name)
        if (pos.length && !pos.some(m)) return
        if (neg.some(m)) return
      }
    }
    if (h.t === 'file') {
      const f = h.f
      targets.push({ vpath, textPath: () => s.ctx.mirror.textPath(s.access, f), touch: (strong) => s.touchFile(f, strong), recheck: () => s.access.recheck(f) })
    } else if (h.t === 'draft') {
      const item = h.item
      targets.push({ vpath, textPath: async () => s.ctx.blobs.path(item.pending ? s.ctx.blobs.put(item.pending) : item.draft!.sha256), touch: (strong) => s.touchDraft(item, strong), recheck: () => {} })
    }
  }
  const walk = (h: Hit, vpath: string, explicit: boolean) => {
    if (h.t === 'file' || h.t === 'draft') return add(h, vpath, explicit)
    if (h.t === 'sys' || h.t === 'rawroot' || (h.t === 'dir' && h.raw)) { if (explicit) errors.push(`${flavor}: ${vpath}: searching here is not supported (search the normal path; /.raw/ holds original bytes)`); return }
    if (h.t === 'dir') s.touchNode(h.node, false)
    for (const c of vfs.children(h)) {
      if (c.dir && o.excludeDir.some((g) => globRe(g).match(c.name))) continue
      const ch = vfs.resolve(c.path)
      if (ch) walk(ch, c.path, false)
    }
  }
  const paths = o.paths.length ? o.paths : ['.']
  for (const p of paths) {
    const abs = vfs.resolvePath(cwd, p)
    const h = vfs.resolve(abs)
    const shown = p === '.' && !o.paths.length ? '.' : p
    if (!h) { errors.push(flavor === 'rg' ? `rg: ${shown}: IO error for operation on ${shown}: No such file or directory (os error 2)` : `${flavor}: ${shown}: No such file or directory`); continue }
    const isDir = !(h.t === 'file' || h.t === 'draft')
    if (isDir) {
      anyDir = true
      if (!o.recursive) { errors.push(`${flavor}: ${shown}: Is a directory`); continue }
      const before = targets.length
      walk(h, abs, true)
      // show paths the way the user wrote them (relative stays relative)
      if (!p.startsWith('/')) for (let i = before; i < targets.length; i++) targets[i]!.vpath = relTo(abs, targets[i]!.vpath, shown)
    } else {
      walk(h, abs, true)
      if (!p.startsWith('/')) targets[targets.length - 1] && (targets[targets.length - 1]!.vpath = shown)
    }
  }
  return { targets, errors, anyDir }
}

function relTo(absDir: string, vpath: string, shown: string) {
  // vpaths are NFC; the typed directory may not be (an NFD name is longer in code units)
  const dir = absDir.normalize('NFC')
  const rest = vpath.slice(dir === '/' ? 1 : dir.length + 1)
  if (shown === '.' ) return rest
  return shown.replace(/\/+$/, '') + '/' + rest
}

export interface RgEvent { type: string; data: { path?: { text?: string }; lines?: { text?: string; bytes?: string }; line_number?: number; submatches?: { match: { text?: string; bytes?: string } }[] } }
export const evText = (x?: { text?: string; bytes?: string }) => x?.text ?? (x?.bytes ? Buffer.from(x.bytes, 'base64').toString('utf8') : '')

/** Run ripgrep with --json over explicit files (or stdin). Events grouped by path. */
export async function runRg(args: string[], files: string[], stdin: string | null, quietStop: boolean): Promise<{ events: Map<string, RgEvent[]>; code: number; stderr: string; timedOut: boolean }> {
  const p = Bun.spawn([TOOLS.rg!, ...args, '--', ...(stdin === null ? files : ['-'])], {
    cwd: '/', stdin: stdin === null ? 'ignore' : new TextEncoder().encode(stdin), stdout: 'pipe', stderr: 'pipe',
    env: { PATH: '/usr/bin:/bin', RIPGREP_CONFIG_PATH: '' },
  })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; p.kill('SIGKILL') }, LIMITS.rgMs)
  const events = new Map<string, RgEvent[]>()
  const errP = new Response(p.stderr).text()
  let buf = ''
  let size = 0
  const dec = new TextDecoder()
  outer: for await (const chunk of p.stdout) {
    buf += dec.decode(chunk, { stream: true })
    size += chunk.length
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      const ev = JSON.parse(line) as RgEvent
      if (ev.type !== 'match' && ev.type !== 'context') continue
      const key = ev.data.path?.text ?? '-'
      if (!events.has(key)) events.set(key, [])
      events.get(key)!.push(ev)
      if (quietStop && ev.type === 'match') { p.kill('SIGKILL'); break outer }
    }
    if (size > LIMITS.stdoutBytes * 8) { p.kill('SIGKILL'); break }
  }
  const code = await p.exited
  clearTimeout(timer)
  return { events, code, stderr: await errP, timedOut }
}

async function grepMain(flavor: Flavor, vfs: VirtualFs, args: string[], cwd: string, stdinText: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const name = flavor
  let o: Opts
  try { o = parse(flavor, args) } catch (e) {
    if (e instanceof Usage) return { stdout: '', stderr: `${name}: ${e.message}\n${name}: supported here: ${flavor === 'rg' ? '-i -S -s -n -N -l -c -q -F -w -x -v -o -H -I -a -e -A -B -C -m -g --files' : '-r -R -i -n -l -L -c -q -s -E -F -G -w -x -v -o -h -H -a -e -A -B -C -m --include --exclude --exclude-dir'}\n`, exitCode: 2 }
    throw e
  }
  if (!TOOLS.rg) return { stdout: '', stderr: `${name}: ripgrep is not installed on the server\n`, exitCode: 2 }
  const useStdin = !o.paths.length && !o.recursive || (flavor === 'rg' && !o.paths.length && stdinText.length > 0)
  if (useStdin) o.recursive = false
  const { targets, errors, anyDir } = useStdin ? { targets: [], errors: [], anyDir: false } : await collect(vfs, o, flavor, cwd)
  const err = (lines: string[]) => o.noMessages ? '' : lines.map((l) => l + '\n').join('')

  // every file the command looked at is a (weak) touch, even without a match
  for (const t of targets) t.touch(false)
  if (o.listFiles) return { stdout: targets.map((t) => t.vpath + '\n').join(''), stderr: err(errors), exitCode: targets.length ? 0 : 1 }

  // mirror files (one per distinct content); files whose text cannot be extracted are reported, not searched
  const byMirror = new Map<string, Target[]>()
  const mirrorFor = new Map<Target, string>()
  const unreadable: string[] = []
  for (const t of targets) {
    try {
      const mp = await t.textPath()
      if (!byMirror.has(mp)) byMirror.set(mp, [])
      byMirror.get(mp)!.push(t)
      mirrorFor.set(t, mp)
    } catch (e) {
      if (e instanceof ExtractError || e instanceof Closed) { if (e instanceof ExtractError) unreadable.push(t.vpath); continue }
      throw e
    }
  }
  if (unreadable.length) errors.push(`${name}: note: ${unreadable.length} file(s) could not be read as text and were not searched: ${unreadable.slice(0, 5).join(', ')}${unreadable.length > 5 ? ', …' : ''}`)
  if (!useStdin && !byMirror.size) return { stdout: '', stderr: err(errors), exitCode: errors.length && !unreadable.length ? 2 : 1 }

  const pats = o.patterns.flatMap((p) => p.split('\n'))
  const rgArgs = ['--json', '--no-config', '--no-ignore', '--hidden', '--no-follow', '--max-filesize', '50M', '--regex-size-limit', '20M', '--dfa-size-limit', '50M',
    o.icase === 'yes' ? '-i' : o.icase === 'smart' ? '-S' : '-s']
  if (o.syntax === 'fixed') rgArgs.push('-F')
  if (o.word) rgArgs.push('-w')
  if (o.line) rgArgs.push('-x')
  if (o.invert) rgArgs.push('-v')
  if (o.text) rgArgs.push('-a')
  if (o.maxCount !== null) rgArgs.push('-m', String(o.maxCount))
  if (o.filesWith || o.filesWithout) rgArgs.push('-m', '1')
  const showContext = !(o.count || o.filesWith || o.filesWithout || o.quiet)
  if (showContext && o.after) rgArgs.push('-A', String(o.after))
  if (showContext && o.before) rgArgs.push('-B', String(o.before))
  for (const p of pats) rgArgs.push('-e', o.syntax === 'bre' ? breToEre(p) : o.syntax === 'ere' ? ereFix(p) : p)

  const mirrors = [...byMirror.keys()]
  const r = await runRg(rgArgs, mirrors, useStdin ? stdinText : null, o.quiet)
  if (r.timedOut) return { stdout: '', stderr: `${name}: the search took too long and was stopped (${LIMITS.rgMs / 1000} s)\n`, exitCode: 2 }
  if (r.code === 2 && !r.events.size) {
    const msg = r.stderr.split(vfs.s.ctx.mirror.dir).join('<mirror>').trim()
    return { stdout: '', stderr: err([...errors, `${name}: ${msg.replace(/^rg: /, '') || 'search failed'}`]), exitCode: 2 }
  }

  const showName = o.filename ?? (useStdin ? false : targets.length > 1 || anyDir)
  let out = ''
  let matched = false
  const emitFile = (vpath: string, evs: RgEvent[]) => {
    const matches = evs.filter((e) => e.type === 'match')
    if (matches.length) matched = true
    if (o.quiet) return
    const pre = showName ? vpath : ''
    if (o.filesWith) { if (matches.length) out += vpath + '\n'; return }
    if (o.filesWithout) { if (!matches.length) out += vpath + '\n'; return }
    if (o.count) { if (flavor !== 'rg' || matches.length) out += (pre ? pre + ':' : '') + matches.length + '\n'; return }
    let last = -1
    for (const e of evs) {
      const n = e.data.line_number ?? 0
      if ((o.after || o.before) && last >= 0 && n > last + 1) out += '--\n'
      last = n
      const sep = e.type === 'match' ? ':' : '-'
      const prefix = (pre ? pre + sep : '') + (o.lineNumber ? n + sep : '')
      if (o.only) { if (e.type === 'match' && !o.invert) for (const sm of e.data.submatches ?? []) out += prefix + evText(sm.match) + '\n' }
      else { const t = evText(e.data.lines); out += prefix + t + (t.endsWith('\n') ? '' : '\n') }
    }
  }
  if (useStdin) emitFile('(standard input)', r.events.get('-') ?? r.events.get('<stdin>') ?? [...r.events.values()][0] ?? [])
  else {
    let prevHadContext = false
    for (const t of targets) {
      const evs = r.events.get(mirrorFor.get(t) ?? '') ?? []
      if (!evs.length && !o.filesWithout && !(o.count && flavor !== 'rg')) continue
      // ⑦ re-check right before content leaves; a file that changed under us is dropped (same as never there)
      try { t.recheck() } catch { continue }
      const contentOut = showContext && evs.some((e) => e.type === 'match')
      if (contentOut) t.touch(true)
      if (showContext && (o.after || o.before) && prevHadContext && evs.length) out += '--\n'
      emitFile(t.vpath, evs)
      prevHadContext = contentOut
      if (out.length > LIMITS.stdoutBytes * 2) break
    }
  }
  const exitCode = matched ? (errors.length && !o.quiet && !unreadable.length ? 2 : 0) : errors.length && !unreadable.length ? 2 : 1
  return { stdout: out, stderr: err(errors), exitCode }
}

export function grepCommands(vfs: VirtualFs): Command[] {
  return (['grep', 'egrep', 'fgrep', 'rg'] as const).map((flavor) =>
    defineCommand(flavor, async (args, ctx) => {
      try { return await grepMain(flavor, vfs, args, ctx.cwd, decodeBytesToUtf8(ctx.stdin)) } catch (e) {
        // same rule as the VFS: an unexpected error is reported here and shown as a fixed I/O error, never its own text
        reportInternal(flavor, args.join(' '), e)
        return { stdout: '', stderr: `${flavor}: input/output error\n`, exitCode: 2 }
      }
    }))
}

export const _test = { parse, breToEre }
