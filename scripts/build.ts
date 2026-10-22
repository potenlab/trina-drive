#!/usr/bin/env bun
// Build a macOS release folder: the compiled CLI/server, the pinned external tools, the installer, manifests.
//
//   bun scripts/build.ts [--out dist] [--targets darwin-arm64[,darwin-x64]] [--entry src/cli.ts] [--version X]
//                        [--tools vendor|none|stub] [--daemons server,backup[,worker]] [--accept-tool-drift] [--no-tar]
//
// Output, per target: <out>/<name>-<version>-<target>/
//   bin/<cli>                  `bun build --compile` of --entry (the whole app in one Mach-O)
//   tools/bin/rg               ripgrep, official release binary, download pinned by SHA-256 (scripts/tools.json)
//   tools/bin/pdftotext        poppler from the build host's Homebrew, relinked with its libraries into tools/lib
//   tools/licenses/<package>/  license files of the bundled tools
//   install-macos.sh, uninstall-macos.sh, macos/   the installer (run it from this folder)
//   docs/                      INSTALL.md, BACKUP-FORMAT.md
//   release.json               name, version, target, daemons, commit, bun version, minimum macOS
//   tools.json                 every bundled tool: package, version, source, and each file's SHA-256
//   SHA256SUMS                 every file above (shasum -a 256 -c SHA256SUMS); the installer checks it
// and <out>/<folder>.tar.gz (+ .sha256) unless --no-tar.
//
// --tools vendor (default) bundles the tools; none leaves them out (the installer then uses Homebrew's, with a
// warning); stub writes placeholder scripts (installer tests only: the installer refuses them outside --dry-run).
//
// Signing hooks (not exercised yet; no Developer ID exists): with CODESIGN_IDENTITY set, bin/ and tools/ are signed
// with the hardened runtime and a timestamp; with NOTARY_PROFILE set too (a `xcrun notarytool store-credentials`
// profile), the folder is zipped and submitted for notarization. Without them every Mach-O we changed is ad-hoc
// signed, which Apple silicon requires to run at all.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import pkg from '../package.json'
import { CLI, LAUNCHD_LABEL, NAME } from '../src/brand'

const REPO = path.resolve(import.meta.dir, '..')
export const TARGETS = ['darwin-arm64', 'darwin-x64'] as const
export type Target = (typeof TARGETS)[number]
export const MIN_MACOS = '14.0'

interface ToolPin {
  package: string
  version: string
  license: string
  binaries: string[]
  source: 'download' | 'homebrew'
  targets: Partial<Record<Target, { url?: string; sha256?: string; dir?: string; licenses?: string[]; brewPrefix?: string }>>
}
export interface ToolEntry {
  package: string
  version: string
  source: 'download' | 'homebrew' | 'stub'
  license: string
  origin: string
  binaries: string[]
  files: { path: string; sha256: string }[]
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const has = (name: string) => process.argv.includes(name)

function run(cmd: string[], o: { cwd?: string; quiet?: boolean } = {}): string {
  const p = Bun.spawnSync(cmd, { cwd: o.cwd, stdout: 'pipe', stderr: 'pipe' })
  if (p.exitCode !== 0) throw new Error(`${cmd.join(' ')} failed (${p.exitCode}): ${p.stderr.toString().trim().slice(0, 800)}`)
  return p.stdout.toString()
}

export async function sha256File(f: string): Promise<string> {
  const h = new Bun.CryptoHasher('sha256')
  h.update(await Bun.file(f).arrayBuffer())
  return h.digest('hex')
}

function walkFiles(dir: string, rel = ''): string[] {
  return fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isSymbolicLink()) throw new Error(`symbolic link in release: ${r}`)
    return e.isDirectory() ? walkFiles(dir, r) : [r]
  })
}

/** SHA256SUMS in `shasum -a 256 -c` format, every file but itself. */
export async function writeChecksums(dir: string) {
  const lines: string[] = []
  for (const f of walkFiles(dir)) if (f !== 'SHA256SUMS') lines.push(`${await sha256File(path.join(dir, f))}  ${f}`)
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), lines.join('\n') + '\n')
}

// ---- tools ----

async function download(url: string, sha: string, cacheDir: string): Promise<string> {
  fs.mkdirSync(cacheDir, { recursive: true })
  const f = path.join(cacheDir, `${sha}-${path.basename(new URL(url).pathname)}`)
  if (fs.existsSync(f) && (await sha256File(f)) === sha) return f
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`download ${url}: HTTP ${res.status}`)
  const tmp = `${f}.partial`
  await Bun.write(tmp, res)
  const got = await sha256File(tmp)
  if (got !== sha) { fs.rmSync(tmp, { force: true }); throw new Error(`download ${url}: SHA-256 ${got}, pinned ${sha}; refusing it`) }
  fs.renameSync(tmp, f)
  return f
}

export async function vendorDownload(pin: ToolPin, t: NonNullable<ToolPin['targets'][Target]>, rel: string, cacheDir: string): Promise<ToolEntry> {
  const archive = await download(t.url!, t.sha256!, cacheDir)
  const x = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-'))
  try {
    run(['/usr/bin/tar', '-xzf', archive, '-C', x])
    const files: ToolEntry['files'] = []
    for (const b of pin.binaries) {
      const dst = path.join(rel, 'tools', 'bin', b)
      fs.copyFileSync(path.join(x, t.dir!, b), dst)
      fs.chmodSync(dst, 0o755)
    }
    for (const l of t.licenses ?? []) {
      const d = path.join(rel, 'tools', 'licenses', pin.package)
      fs.mkdirSync(d, { recursive: true })
      fs.copyFileSync(path.join(x, t.dir!, l), path.join(d, l))
    }
    for (const b of pin.binaries) files.push({ path: `tools/bin/${b}`, sha256: await sha256File(path.join(rel, 'tools', 'bin', b)) })
    return { package: pin.package, version: pin.version, source: 'download', license: pin.license, origin: `${t.url} (sha256 ${t.sha256})`, binaries: pin.binaries, files }
  } finally {
    fs.rmSync(x, { recursive: true, force: true })
  }
}

const SYSTEM_LIB = /^\/(usr\/lib|System)\//

function machoDeps(f: string): string[] {
  return run(['/usr/bin/otool', '-L', f]).split('\n').slice(1).map((l) => l.trim().split(' (')[0]!).filter(Boolean)
}
function machoId(f: string): string | null {
  const out = run(['/usr/bin/otool', '-D', f]).split('\n').slice(1).map((s) => s.trim()).filter(Boolean)
  return out[0] ?? null
}
function machoRpaths(f: string): string[] {
  const lines = run(['/usr/bin/otool', '-l', f]).split('\n')
  const out: string[] = []
  lines.forEach((l, i) => { if (l.includes('cmd LC_RPATH')) { const m = /path (.*) \(offset/.exec(lines[i + 2] ?? ''); if (m) out.push(m[1]!) } })
  return out
}

/**
 * Copy a Homebrew executable and every non-system library it loads (transitively) into tools/, rewrite every load
 * path to @rpath/<library> (tools/bin -> @loader_path/../lib), and ad-hoc sign the changed files.
 */
export function vendorMacho(exe: string, brewPrefix: string, toolsDir: string): { files: string[]; cellars: Set<string> } {
  const libDir = path.join(toolsDir, 'lib')
  fs.mkdirSync(libDir, { recursive: true })
  const resolveDep = (dep: string, loader: string): string => {
    const cands: string[] = []
    if (dep.startsWith('@rpath/')) {
      const base = dep.slice(7)
      for (const rp of machoRpaths(loader)) cands.push(path.join(rp.replace('@loader_path', path.dirname(loader)), base))
      cands.push(path.join(brewPrefix, 'lib', base))
    } else if (dep.startsWith('@loader_path/')) cands.push(path.join(path.dirname(loader), dep.slice(13)))
    else cands.push(dep)
    for (const c of cands) if (fs.existsSync(c)) return fs.realpathSync(c)
    throw new Error(`cannot find ${dep} (needed by ${loader})`)
  }
  const realExe = fs.realpathSync(exe)
  const names = new Map<string, string>() // real path -> file name in tools/lib
  const deps = new Map<string, [string, string][]>() // real path -> [load path as written, real path]
  const todo = [realExe]
  while (todo.length) {
    const f = todo.pop()!
    const list: [string, string][] = []
    for (const d of machoDeps(f)) {
      if (SYSTEM_LIB.test(d)) continue
      const real = resolveDep(d, f)
      if (real === f) continue // a library lists its own id
      list.push([d, real])
      if (!names.has(real)) {
        const id = machoId(real)
        names.set(real, path.basename(id ?? real))
        todo.push(real)
      }
    }
    deps.set(f, list)
  }
  const out: string[] = []
  const place = (real: string) => (real === realExe ? path.join(toolsDir, 'bin', path.basename(exe)) : path.join(libDir, names.get(real)!))
  for (const [real] of deps) {
    const dst = place(real)
    fs.copyFileSync(real, dst)
    fs.chmodSync(dst, real === realExe ? 0o755 : 0o644)
    const cmd = ['/usr/bin/install_name_tool']
    if (real !== realExe) cmd.push('-id', `@rpath/${names.get(real)}`)
    for (const [written, target] of deps.get(real)!) if (written !== `@rpath/${names.get(target)}`) cmd.push('-change', written, `@rpath/${names.get(target)}`)
    const want = real === realExe ? '@loader_path/../lib' : '@loader_path'
    const rpaths = machoRpaths(real)
    for (const rp of rpaths) if (rp !== want) cmd.push('-delete_rpath', rp)
    if (!rpaths.includes(want)) cmd.push('-add_rpath', want)
    if (cmd.length > 1) run([...cmd, dst])
    run(['/usr/bin/codesign', '--force', '--sign', '-', dst])
    out.push(dst)
  }
  // nothing may still point outside tools/ or the system
  for (const f of out) {
    for (const d of machoDeps(f)) if (!SYSTEM_LIB.test(d) && !d.startsWith('@rpath/')) throw new Error(`${f} still loads ${d}`)
    for (const rp of machoRpaths(f)) if (!rp.startsWith('@loader_path')) throw new Error(`${f} still has rpath ${rp}`)
  }
  const cellars = new Set([...deps.keys()].map((r) => /\/Cellar\/([^/]+\/[^/]+)\//.exec(r)?.[1]).filter((c): c is string => !!c))
  return { files: out, cellars }
}

async function vendorHomebrew(pin: ToolPin, t: NonNullable<ToolPin['targets'][Target]>, rel: string, acceptDrift: boolean): Promise<ToolEntry> {
  const prefix = t.brewPrefix!
  const cellar = path.join(prefix, 'Cellar', pin.package)
  const versions = fs.existsSync(cellar) ? fs.readdirSync(cellar) : []
  if (!versions.length) throw new Error(`${pin.package} is not installed in ${prefix} (brew install ${pin.package}), or use --tools none`)
  const version = versions.includes(pin.version) ? pin.version : versions.sort().at(-1)!
  if (version !== pin.version && !acceptDrift) throw new Error(`Homebrew has ${pin.package} ${version}, the pin is ${pin.version}: update scripts/tools.json or pass --accept-tool-drift`)
  const toolsDir = path.join(rel, 'tools')
  const files: string[] = []
  const cellars = new Set<string>()
  for (const b of pin.binaries) {
    const r = vendorMacho(path.join(cellar, version, 'bin', b), prefix, toolsDir)
    files.push(...r.files)
    r.cellars.forEach((c) => cellars.add(c))
  }
  for (const c of cellars) {
    const src = path.join(prefix, 'Cellar', c)
    const lic = fs.readdirSync(src).filter((n) => /^(COPYING|LICENSE|LICENCE|COPYRIGHT)/i.test(n))
    const d = path.join(toolsDir, 'licenses', c.split('/')[0]!)
    fs.mkdirSync(d, { recursive: true })
    for (const l of lic) fs.copyFileSync(path.join(src, l), path.join(d, l))
    if (!lic.length) fs.writeFileSync(path.join(d, 'SOURCE.txt'), `${c}: see the Homebrew formula for its license and source (brew info ${c.split('/')[0]})\n`)
  }
  const entries: ToolEntry['files'] = []
  for (const f of [...new Set(files)].sort()) entries.push({ path: path.relative(rel, f), sha256: await sha256File(f) })
  return { package: pin.package, version, source: 'homebrew', license: pin.license, origin: `Homebrew bottle ${pin.package} ${version} (${[...cellars].sort().join(', ')})`, binaries: pin.binaries, files: entries }
}

async function stubTool(pin: ToolPin, rel: string): Promise<ToolEntry> {
  const files: ToolEntry['files'] = []
  for (const b of pin.binaries) {
    const f = path.join(rel, 'tools', 'bin', b)
    fs.writeFileSync(f, `#!/bin/sh\n# placeholder ${b} for installer tests (scripts/build.ts --tools stub)\necho "${b} stub" >&2\nexit 1\n`, { mode: 0o755 })
    files.push({ path: `tools/bin/${b}`, sha256: await sha256File(f) })
  }
  return { package: pin.package, version: pin.version, source: 'stub', license: pin.license, origin: 'stub', binaries: pin.binaries, files }
}

// ---- signing hooks ----

function signRelease(rel: string) {
  const id = process.env.CODESIGN_IDENTITY
  if (!id) return false
  const machos = walkFiles(rel).filter((f) => f.startsWith('bin/') || f.startsWith('tools/bin/') || f.startsWith('tools/lib/'))
  for (const f of machos) run(['/usr/bin/codesign', '--force', '--options', 'runtime', '--timestamp', '--sign', id, path.join(rel, f)])
  return true
}
function notarize(rel: string) {
  const profile = process.env.NOTARY_PROFILE
  if (!profile || !process.env.CODESIGN_IDENTITY) return false
  const zip = `${rel}.notarize.zip`
  run(['/usr/bin/ditto', '-c', '-k', '--keepParent', rel, zip])
  try { run(['/usr/bin/xcrun', 'notarytool', 'submit', zip, '--keychain-profile', profile, '--wait']) } finally { fs.rmSync(zip, { force: true }) }
  // command-line tools cannot be stapled; Gatekeeper checks the ticket online
  return true
}

// ---- build ----

export interface BuildOptions {
  out: string
  target: Target
  entry: string
  version: string
  tools: 'vendor' | 'none' | 'stub'
  daemons: string[]
  acceptDrift?: boolean
  tar?: boolean
  cacheDir?: string
  log?: (s: string) => void
}

export async function buildRelease(o: BuildOptions): Promise<string> {
  const log = o.log ?? ((s: string) => console.log(s))
  if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,49}$/.test(o.version)) throw new Error(`bad version ${o.version}`)
  const entry = path.resolve(REPO, o.entry)
  if (!fs.existsSync(entry)) throw new Error(`entry ${o.entry} does not exist (the server CLI is src/cli.ts)`)
  const common = fs.readFileSync(path.join(REPO, 'scripts', 'macos', 'common.sh'), 'utf8')
  for (const [k, v] of [['NAME', NAME], ['CLI', CLI], ['LABEL', LAUNCHD_LABEL]] as const) {
    const got = new RegExp(`^${k}=(\\S*)`, 'm').exec(common)?.[1]
    if (got !== v) throw new Error(`scripts/macos/common.sh ${k}=${got} differs from src/brand.ts "${v}"`)
  }
  const folder = `${NAME}-${o.version}-${o.target}`
  const rel = path.join(path.resolve(o.out), folder)
  fs.rmSync(rel, { recursive: true, force: true })
  for (const d of ['bin', 'tools/bin', 'macos', 'docs']) fs.mkdirSync(path.join(rel, d), { recursive: true })

  log(`[${o.target}] compiling ${o.entry}`)
  const exe = path.join(rel, 'bin', CLI)
  run([process.execPath, 'build', '--compile', `--target=bun-${o.target}`, '--outfile', exe, entry], { cwd: REPO })
  // Bun 1.3.12 leaves a signature that codesign rejects ("not signed at all") and Apple silicon kills the process
  // (SIGKILL, exit 137): replace it with an ad-hoc signature (a Developer ID one replaces that below)
  if (Bun.spawnSync(['/usr/bin/codesign', '-v', exe]).exitCode !== 0) {
    run(['/usr/bin/codesign', '--remove-signature', exe])
    run(['/usr/bin/codesign', '--force', '--sign', '-', exe])
  }

  const pins = (JSON.parse(fs.readFileSync(path.join(REPO, 'scripts', 'tools.json'), 'utf8')) as { tools: ToolPin[] }).tools
  const tools: ToolEntry[] = []
  const missing: string[] = []
  const hostTarget: Target = process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
  for (const pin of pins) {
    if (o.tools === 'none') { missing.push(pin.package); continue }
    if (o.tools === 'stub') { tools.push(await stubTool(pin, rel)); continue }
    const t = pin.targets[o.target]
    if (!t) { missing.push(pin.package); continue }
    if (pin.source === 'homebrew' && o.target !== hostTarget) {
      log(`[${o.target}] ${pin.package}: can only be vendored on a ${o.target} build host; left out`)
      missing.push(pin.package)
      continue
    }
    tools.push(pin.source === 'download' ? await vendorDownload(pin, t, rel, o.cacheDir ?? path.join(REPO, 'dist', '.cache')) : await vendorHomebrew(pin, t, rel, !!o.acceptDrift))
    log(`[${o.target}] ${pin.package} ${tools.at(-1)!.version} (${pin.source})`)
  }
  if (!fs.readdirSync(path.join(rel, 'tools', 'bin')).length) fs.rmSync(path.join(rel, 'tools'), { recursive: true })

  fs.copyFileSync(path.join(REPO, 'scripts', 'install-macos.sh'), path.join(rel, 'install-macos.sh'))
  fs.copyFileSync(path.join(REPO, 'scripts', 'uninstall-macos.sh'), path.join(rel, 'uninstall-macos.sh'))
  for (const f of fs.readdirSync(path.join(REPO, 'scripts', 'macos'))) fs.copyFileSync(path.join(REPO, 'scripts', 'macos', f), path.join(rel, 'macos', f))
  for (const f of ['install-macos.sh', 'uninstall-macos.sh']) fs.chmodSync(path.join(rel, f), 0o755)
  for (const f of ['INSTALL.md', 'BACKUP-FORMAT.md']) if (fs.existsSync(path.join(REPO, 'docs', f))) fs.copyFileSync(path.join(REPO, 'docs', f), path.join(rel, 'docs', f))

  let commit = 'unknown'
  try { commit = run(['git', 'rev-parse', 'HEAD'], { cwd: REPO }).trim() + (run(['git', 'status', '--porcelain'], { cwd: REPO }).trim() ? '-dirty' : '') } catch {}
  const release = { name: NAME, version: o.version, target: o.target, daemons: o.daemons, minMacOS: MIN_MACOS, bun: Bun.version, commit, entry: o.entry, builtAt: new Date().toISOString(), missingTools: missing }
  fs.writeFileSync(path.join(rel, 'release.json'), JSON.stringify(release, null, 2) + '\n')
  fs.writeFileSync(path.join(rel, 'tools.json'), JSON.stringify({ tools }, null, 2) + '\n')

  if (signRelease(rel)) log(`[${o.target}] signed with ${process.env.CODESIGN_IDENTITY}`)
  else log(`[${o.target}] not signed with a Developer ID (set CODESIGN_IDENTITY); bundled tools are ad-hoc signed`)
  if (notarize(rel)) log(`[${o.target}] notarized`)

  await writeChecksums(rel)
  if (o.tar !== false) {
    const tgz = `${rel}.tar.gz`
    run(['/usr/bin/tar', '-czf', tgz, '-C', path.dirname(rel), folder])
    fs.writeFileSync(`${tgz}.sha256`, `${await sha256File(tgz)}  ${path.basename(tgz)}\n`)
  }
  if (missing.length) log(`[${o.target}] tools NOT bundled: ${missing.join(', ')} (the installer falls back to Homebrew and warns)`)
  log(`[${o.target}] ${rel}`)
  return rel
}

if (import.meta.main) {
  const targets = (arg('--targets') ?? 'darwin-arm64').split(',') as Target[]
  for (const t of targets) if (!TARGETS.includes(t)) throw new Error(`unknown target ${t} (${TARGETS.join(', ')})`)
  const tools = (arg('--tools') ?? 'vendor') as BuildOptions['tools']
  if (!['vendor', 'none', 'stub'].includes(tools)) throw new Error('--tools is vendor, none or stub')
  const daemons = (arg('--daemons') ?? 'server,backup').split(',')
  for (const d of daemons) if (!['server', 'backup', 'worker'].includes(d)) throw new Error(`unknown daemon ${d}`)
  for (const target of targets) {
    await buildRelease({
      out: arg('--out') ?? path.join(REPO, 'dist'), target, entry: arg('--entry') ?? 'src/cli.ts', version: arg('--version') ?? pkg.version,
      tools, daemons, acceptDrift: has('--accept-tool-drift'), tar: !has('--no-tar'),
    })
  }
}
