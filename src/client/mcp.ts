// `<cli> mcp add claude|codex|cursor` (plan 5.1 "CLI", 7.1 token leak, M8): on the person's own computer, sign in to
// the server, make a personal token for one AI client, and connect that client in USER scope — never a repo's project
// file (.mcp.json, .cursor/mcp.json, .codex/ in a project).
//
// Where the token goes (unless --store inline):
//   macOS: the login Keychain (`security`, service "<name>-mcp", account "<client>:<entry>"); elsewhere a 0600 file in
//   ~/.config/<name>/tokens/. The client configuration only references it:
//   - Claude Code: `headersHelper`, a command Claude runs to get the Authorization header (user scope, written with
//     `claude mcp add-json --scope user`, or straight into ~/.claude.json when the claude CLI is not installed).
//   - Codex: `bearer_token_env_var` (written with `codex mcp add --url … --bearer-token-env-var …`, or straight into
//     ~/.codex/config.toml). Optional `default_tools_approval_mode = "approve"` only with --auto-approve.
//   - Cursor: ~/.cursor/mcp.json with `"Authorization": "Bearer ${env:VAR}"` (Cursor has no `mcp add` command).
//   The env variables for Codex and Cursor are set by ~/.config/<name>/env.sh (no secret in it on macOS: each line
//   reads the Keychain), which the person sources from their shell profile.
// Every entry of that client already pointing at the same server is checked: a broader token there is warned about
// (an agent can use it instead, M8), as is a token kept in clear text.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ENV_PREFIX, NAME, TOKEN_PREFIX } from '../config'

export const CLIENTS = ['claude', 'codex', 'cursor'] as const
export type Client = (typeof CLIENTS)[number]
export type Store = 'keychain' | 'file' | 'inline'

export const MCP_HELP = `  mcp add claude|codex|cursor --server URL [--login NAME] [--password-stdin | --token-stdin]
        [--name ${NAME}] [--token-name N] [--ttl 8h|1d|7d|30d|90d] [--scope folder1,folder2 | --all-folders] [--read-only]
        [--store keychain|file|inline] [--auto-approve] [--force] [--dry-run]
                                         connect an AI client on this computer (user scope; token in the Keychain)`

export interface McpIO {
  env: Record<string, string | undefined>
  out: (line: string) => void
  err: (line: string) => void
  /** whole standard input (for --password-stdin / --token-stdin) */
  readStdin?: () => Promise<string>
  /** a password typed without echo (interactive) */
  promptPassword?: (question: string) => Promise<string>
  /** standard input is a terminal: --token-stdin then asks for the token without echo (pasted; not in shell history) */
  stdinIsTTY?: boolean
  fetch?: typeof fetch
  platform?: NodeJS.Platform
  hostname?: string
}

class UsageError extends Error {}

interface Opts {
  client: Client; server: string; mcpUrl: string; name: string; tokenName?: string; ttl: string; scope?: string[]; allFolders: boolean
  readOnly: boolean; store?: Store; autoApprove: boolean; force: boolean; dryRun: boolean; login?: string; passwordStdin: boolean; tokenStdin: boolean
}

function parse(args: string[]): Opts {
  const a = [...args]
  const flag = (n: string) => { const i = a.indexOf(n); if (i < 0) return undefined; const v = a[i + 1]; if (v === undefined || v.startsWith('--')) throw new UsageError(`${n} needs a value`); a.splice(i, 2); return v }
  const bool = (n: string) => { const i = a.indexOf(n); if (i >= 0) a.splice(i, 1); return i >= 0 }
  const o = {
    server: flag('--server'), name: flag('--name') ?? NAME, tokenName: flag('--token-name'), ttl: flag('--ttl') ?? '7d', scope: flag('--scope'),
    store: flag('--store') as Store | undefined, login: flag('--login'),
    allFolders: bool('--all-folders'), readOnly: bool('--read-only'), autoApprove: bool('--auto-approve'), force: bool('--force'), dryRun: bool('--dry-run'),
    passwordStdin: bool('--password-stdin'), tokenStdin: bool('--token-stdin'),
  }
  if (a.includes('--token')) throw new UsageError('pass the token on standard input with --token-stdin (an argument would land in your shell history)')
  const client = a.shift() as Client
  if (!CLIENTS.includes(client)) throw new UsageError(`client must be one of ${CLIENTS.join(', ')}`)
  if (a.length) throw new UsageError(`unknown arguments: ${a.join(' ')}`)
  if (!o.server) throw new UsageError('--server URL is required (the address of the server, e.g. http://files.lan:8787)')
  let u: URL
  try { u = new URL(o.server) } catch { throw new UsageError(`not a URL: ${o.server}`) }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new UsageError('--server must be http(s)')
  const server = u.origin + u.pathname.replace(/\/(mcp)?\/?$/, '')
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(o.name)) throw new UsageError('--name: letters, digits, _ and - only')
  if (!['8h', '1d', '7d', '30d', '90d'].includes(o.ttl)) throw new UsageError('--ttl: 8h, 1d, 7d, 30d or 90d')
  if (o.store && !['keychain', 'file', 'inline'].includes(o.store)) throw new UsageError('--store: keychain, file or inline')
  if (o.scope && o.allFolders) throw new UsageError('--scope and --all-folders together')
  if (o.passwordStdin && o.tokenStdin) throw new UsageError('--password-stdin and --token-stdin together')
  return { ...o, client, server, mcpUrl: server + '/mcp', scope: o.scope?.split(',').map((s) => s.trim().replace(/^\/+|\/+$/g, '')).filter(Boolean) } as Opts
}

// ---------- where things live (all under $HOME; user scope only) ----------
export function clientPaths(env: McpIO['env']) {
  const home = env.HOME || os.homedir()
  const config = env.XDG_CONFIG_HOME || path.join(home, '.config')
  return {
    home,
    claude: path.join(env.CLAUDE_CONFIG_DIR || home, '.claude.json'),
    codex: path.join(env.CODEX_HOME || path.join(home, '.codex'), 'config.toml'),
    cursor: path.join(home, '.cursor', 'mcp.json'),
    own: path.join(config, NAME),
  }
}
const which = (bin: string, env: McpIO['env']) => Bun.which(bin, { PATH: env.PATH ?? '' }) ?? null
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
export const envVarFor = (client: Client, name: string) =>
  `${ENV_PREFIX}_TOKEN_${client.toUpperCase()}${name === NAME ? '' : '_' + name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
const KEYCHAIN_SERVICE = `${NAME}-mcp`

/** A git work tree holding the path (a dotfiles repo, or HOME itself under git). */
function gitRootOf(p: string): string | null {
  let d = path.dirname(path.resolve(p))
  for (;;) {
    if (fs.existsSync(path.join(d, '.git'))) return d
    const up = path.dirname(d)
    if (up === d) return null
    d = up
  }
}

// ---------- existing entries of a client (M8) ----------
type TokenRef = { kind: 'literal'; token: string } | { kind: 'env'; name: string } | { kind: 'keychain'; service: string; account: string } | { kind: 'file'; file: string } | { kind: 'unknown' }
export interface Existing { name: string; url: string; ref: TokenRef; extra?: string }

function sameServer(a: string, b: string) {
  try {
    const x = new URL(a), y = new URL(b)
    const loop = (h: string) => ['127.0.0.1', 'localhost', '[::1]'].includes(h) ? 'loopback' : h
    return x.protocol === y.protocol && loop(x.hostname) === loop(y.hostname) && x.port === y.port && x.pathname.replace(/\/$/, '') === y.pathname.replace(/\/$/, '')
  } catch { return false }
}
function refFromHeader(v: unknown): TokenRef {
  if (typeof v !== 'string') return { kind: 'unknown' }
  const lit = new RegExp(`(${TOKEN_PREFIX}[A-Za-z0-9_-]+)`).exec(v)
  if (lit) return { kind: 'literal', token: lit[1]! }
  const env = /\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}/.exec(v)
  return env ? { kind: 'env', name: env[1]! } : { kind: 'unknown' }
}
function refFromHelper(cmd: unknown): TokenRef {
  if (typeof cmd !== 'string') return { kind: 'unknown' }
  const k = /find-generic-password -s '([^']+)' -a '([^']+)'/.exec(cmd)
  if (k) return { kind: 'keychain', service: k[1]!, account: k[2]! }
  const f = /\$\(cat '([^']+)'\)/.exec(cmd)
  return f ? { kind: 'file', file: f[1]! } : { kind: 'unknown' }
}
const readJson = (file: string): Record<string, any> | null => {
  if (!fs.existsSync(file)) return null
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { throw new UsageError(`${file} is not valid JSON; fix it first (nothing was changed)`) }
}

export function existingEntries(client: Client, env: McpIO['env'], mcpUrl: string): Existing[] {
  const p = clientPaths(env)
  const out: Existing[] = []
  if (client === 'claude') {
    const j = readJson(p.claude) ?? {}
    const scan = (servers: Record<string, any> | undefined, where: string) => {
      for (const [name, s] of Object.entries(servers ?? {})) {
        if (!s || typeof s.url !== 'string' || !sameServer(s.url, mcpUrl)) continue
        const auth = Object.entries(s.headers ?? {}).find(([k]) => k.toLowerCase() === 'authorization')?.[1]
        out.push({ name, url: s.url, ref: s.headersHelper ? refFromHelper(s.headersHelper) : refFromHeader(auth), extra: where })
      }
    }
    scan(j.mcpServers, 'user')
    for (const [dir, proj] of Object.entries((j.projects ?? {}) as Record<string, any>)) scan(proj?.mcpServers, `local, ${dir}`)
  } else if (client === 'codex') {
    if (fs.existsSync(p.codex)) {
      let t: Record<string, any>
      try { t = Bun.TOML.parse(fs.readFileSync(p.codex, 'utf8')) as Record<string, any> } catch { throw new UsageError(`${p.codex} is not valid TOML; fix it first (nothing was changed)`) }
      for (const [name, s] of Object.entries((t.mcp_servers ?? {}) as Record<string, any>)) {
        if (!s || typeof s.url !== 'string' || !sameServer(s.url, mcpUrl)) continue
        const auth = Object.entries(s.http_headers ?? {}).find(([k]) => k.toLowerCase() === 'authorization')?.[1]
        out.push({ name, url: s.url, ref: s.bearer_token_env_var ? { kind: 'env', name: s.bearer_token_env_var } : refFromHeader(auth) })
      }
    }
  } else {
    const j = readJson(p.cursor) ?? {}
    for (const [name, s] of Object.entries((j.mcpServers ?? {}) as Record<string, any>)) {
      if (!s || typeof s.url !== 'string' || !sameServer(s.url, mcpUrl)) continue
      const auth = Object.entries(s.headers ?? {}).find(([k]) => k.toLowerCase() === 'authorization')?.[1]
      out.push({ name, url: s.url, ref: refFromHeader(auth) })
    }
  }
  return out
}

// ---------- the server API (the person's own session) ----------
interface ServerToken { id: number; name: string; hint: string; read_only: boolean; status: string; expires_at: number | null; scope: { id: number; vpath: string | null }[] | null }

class Api {
  private cookie = ''
  private csrf = ''
  constructor(private readonly base: string, private readonly f: typeof fetch) {}
  async call<T>(method: string, p: string, body?: unknown): Promise<{ status: number; data: T }> {
    const headers: Record<string, string> = {}
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (this.cookie) headers.cookie = this.cookie
    if (method !== 'GET' && this.csrf) headers['x-csrf-token'] = this.csrf
    let res: Response
    try { res = await this.f(this.base + '/api' + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error' }) }
    catch (e) { throw new UsageError(`cannot reach ${this.base} (${(e as Error).message})`) }
    const m = new RegExp(`(${NAME}_session=[^;]*)`).exec(res.headers.get('set-cookie') ?? '')
    if (m) this.cookie = m[1]!
    const data = await res.json().catch(() => ({})) as T & { csrf?: string; message?: string }
    if (data && typeof data.csrf === 'string') this.csrf = data.csrf
    return { status: res.status, data }
  }
}

// ---------- writing configs ----------
function writeFileAtomic(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, text, { mode })
  fs.renameSync(tmp, file)
}

const tomlKey = (name: string) => /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name)
/** Replace (or add) [mcp_servers.<name>] and its sub-tables with `body` lines. */
export function upsertTomlSection(text: string, name: string, body: string[]): string {
  const head = new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*(?:${name}|"${name}")\\s*(\\]|\\.)`)
  const lines = text.split('\n')
  const out: string[] = []
  let skipping = false
  for (const l of lines) {
    if (/^\s*\[/.test(l)) skipping = head.test(l)
    if (!skipping) out.push(l)
  }
  while (out.length && out.at(-1)!.trim() === '') out.pop()
  return (out.length ? out.join('\n') + '\n\n' : '') + [`[mcp_servers.${tomlKey(name)}]`, ...body].join('\n') + '\n'
}
/** Set one key inside [mcp_servers.<name>] (the section must exist). */
export function setTomlKey(text: string, name: string, key: string, value: string): string {
  const head = new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*(?:${name}|"${name}")\\s*\\]`)
  const lines = text.split('\n')
  const start = lines.findIndex((l) => head.test(l))
  if (start < 0) throw new UsageError(`[mcp_servers.${name}] not found in the Codex config`)
  let end = start + 1
  while (end < lines.length && !/^\s*\[/.test(lines[end]!)) end++
  const k = lines.slice(start + 1, end).findIndex((l) => new RegExp(`^\\s*${key}\\s*=`).test(l))
  if (k >= 0) lines[start + 1 + k] = `${key} = ${value}`
  else lines.splice(start + 1, 0, `${key} = ${value}`)
  return lines.join('\n')
}

/** ~/.config/<name>/env.sh: one export line per variable (replaced in place). */
function upsertEnvLine(file: string, varName: string, line: string) {
  const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : `# ${NAME}: tokens for AI clients that read them from the environment (Codex, Cursor).\n# Source this from your shell profile: . "${file}"\n`
  const kept = cur.split('\n').filter((l) => !l.startsWith(`export ${varName}=`))
  while (kept.length && kept.at(-1) === '') kept.pop()
  writeFileAtomic(file, [...kept, line].join('\n') + '\n')
}

// ---------- the command ----------
export async function mcpCommand(args: string[], io: McpIO): Promise<number> {
  const [sub, ...rest] = args
  if (sub !== 'add') { io.err(`usage:\n${MCP_HELP}`); return 2 }
  try { return await add(parse(rest), io) } catch (e) {
    if (e instanceof UsageError) { io.err(`error: ${e.message}`); return 1 }
    throw e
  }
}

async function add(o: Opts, io: McpIO): Promise<number> {
  const env = io.env
  const p = clientPaths(env)
  const platform = io.platform ?? process.platform
  const security = which('security', env)
  const store: Store = o.store ?? (platform === 'darwin' && security ? 'keychain' : 'file')
  if (store === 'keychain' && !security) throw new UsageError('the macOS Keychain (security) is not available here; use --store file')
  const say = io.out
  const warn = (s: string) => io.err(`warning: ${s}`)
  const configFile = p[o.client]
  const account = `${o.client}:${o.name}`
  const tokenFile = path.join(p.own, 'tokens', `${o.client}-${o.name}`)
  const envFile = path.join(p.own, 'env.sh')
  const varName = envVarFor(o.client, o.name)
  const bin = o.client === 'cursor' ? null : which(o.client, env)

  // 1. what this client already has for this server (M8), and the entry name
  const existing = existingEntries(o.client, env, o.mcpUrl)
  const sameName = o.client === 'claude'
    ? Object.hasOwn(readJson(p.claude)?.mcpServers ?? {}, o.name)
    : o.client === 'codex' ? fs.existsSync(p.codex) && new RegExp(`^\\s*\\[\\s*mcp_servers\\.(${o.name}|"${o.name}")\\s*\\]`, 'm').test(fs.readFileSync(p.codex, 'utf8'))
    : Object.hasOwn(readJson(p.cursor)?.mcpServers ?? {}, o.name)
  if (sameName && !o.force) throw new UsageError(`${o.client} already has an MCP server named "${o.name}" in ${configFile}; pass --force to replace it or --name to pick another`)
  const git = gitRootOf(configFile)
  if (git) {
    if (store === 'inline' && !o.force) throw new UsageError(`${configFile} is inside a git repository (${git}); a token in clear text there could be committed. Use the Keychain or --store file (or --force)`)
    warn(`${configFile} is inside a git repository (${git}); the token itself is not written there, but check what you commit`)
  }
  if (new URL(o.server).protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(o.server).hostname)) {
    warn(`${o.server} is plain http: your password and token cross the network unencrypted (use it only on a trusted LAN or VPN)`)
  }

  // 2. the token: given on stdin, or made on the server with the person's sign-in
  let token = '<token>'
  let made: { id: number; name: string } | null = null
  let mine: ServerToken[] | null = null
  let newScope: number[] | null = null
  const tokenName = o.tokenName ?? `${o.client}@${(io.hostname ?? os.hostname()).split('.')[0]}`.slice(0, 64)
  if (o.dryRun) {
    say(`# dry run: nothing is written and the server is not contacted`)
    say(o.tokenStdin ? '# token: the one given on standard input' : `# token: would be made on ${o.server} as "${tokenName}" (expires in ${o.ttl}${o.readOnly ? ', read-only' : ''}, ${o.scope ? `folders: ${o.scope.join(', ')}` : 'all folders you can read'})`)
  } else if (o.tokenStdin) {
    token = (io.stdinIsTTY && io.promptPassword ? await io.promptPassword('paste the token (it is not shown): ')
      : await (io.readStdin ?? (() => Bun.stdin.text()))()).trim()
    if (!new RegExp(`^${TOKEN_PREFIX}[A-Za-z0-9_-]{16,}$`).test(token)) throw new UsageError(`standard input does not hold a ${TOKEN_PREFIX}… token`)
  } else {
    const api = new Api(o.server, io.fetch ?? fetch)
    const login = o.login ?? env.USER ?? ''
    if (!login) throw new UsageError('--login NAME is required')
    const password = o.passwordStdin ? (await (io.readStdin ?? (() => Bun.stdin.text()))()).replace(/\r?\n$/, '')
      : env[`${ENV_PREFIX}_PASSWORD`] ?? (io.promptPassword ? await io.promptPassword(`password for ${login} at ${o.server}: `) : '')
    if (!password) throw new UsageError(`no password (use --password-stdin, $${ENV_PREFIX}_PASSWORD or a terminal)`)
    const li = await api.call<{ me?: { admin: boolean }; message?: string }>('POST', '/login', { login, password })
    if (li.status !== 200) throw new UsageError(`sign-in failed (${li.status}${li.data.message ? `: ${li.data.message}` : ''})`)
    try {
      if (li.data.me?.admin && !o.scope && !o.allFolders) throw new UsageError('admin tokens are narrowed by default (plan 5.1): pass --scope folder1,folder2, or --all-folders')
      if (o.scope) {
        const f = await api.call<{ folders: { id: number; name: string; vpath: string | null; mine: { ai: boolean } }[] }>('GET', '/folders')
        newScope = o.scope.map((want) => {
          const hit = f.data.folders.find((x) => x.mine.ai && (x.vpath === '/' + want || x.vpath?.slice(1).normalize('NFC') === want.normalize('NFC')))
          if (!hit) throw new UsageError(`no folder "${want}" that you can read`)
          return hit.id
        })
      }
      for (let i = 1; !made; i++) {
        const name = i === 1 ? tokenName : `${tokenName}-${i}`
        const r = await api.call<{ id: number; token: string; message?: string }>('POST', '/tokens', { name, ttl: o.ttl, read_only: o.readOnly, scope: newScope ?? undefined })
        if (r.status === 409 && i < 20) continue
        if (r.status !== 200) throw new UsageError(`the server did not make a token (${r.status}${r.data.message ? `: ${r.data.message}` : ''})`)
        token = r.data.token
        made = { id: r.data.id, name }
      }
      mine = (await api.call<{ tokens: ServerToken[] }>('GET', '/tokens')).data.tokens
    } finally { await api.call('POST', '/logout').catch(() => {}) }
  }

  // 3. M8: other entries of this client pointing at the same server
  for (const ex of existing) {
    if (ex.name === o.name) continue
    const where = `${o.client} entry "${ex.name}"${ex.extra ? ` (${ex.extra})` : ''}`
    if (ex.ref.kind === 'literal') warn(`${where} keeps a token in clear text in ${configFile}`)
    const other = resolveRef(ex.ref, env)
    const row = other && mine?.find((t) => other.startsWith(t.hint) && t.status === 'active')
    if (!row) { warn(`${where} also connects to this server; its token could not be checked — if it is broader, an agent can use it instead of the new one`); continue }
    const wider: string[] = []
    if (!row.read_only && o.readOnly) wider.push('can write drafts')
    if (row.scope === null && newScope) wider.push('all folders')
    else if (row.scope && newScope && newScope.every((id) => row.scope!.some((s) => s.id === id)) && row.scope.length > newScope.length) wider.push('more folders')
    if (wider.length) warn(`${where} uses a broader token "${row.name}" (${wider.join(', ')}): an agent can use it instead of the new one. Remove that entry or revoke the token (web: My tokens)`)
  }

  // 4. keep the token (Keychain / 0600 file) and build the reference the client config holds
  const helperGet = store === 'keychain' ? `"$(${sq(security!)} find-generic-password -s ${sq(KEYCHAIN_SERVICE)} -a ${sq(account)} -w)"` : `"$(cat ${sq(tokenFile)})"`
  if (store === 'keychain') {
    say(`Keychain: service ${KEYCHAIN_SERVICE}, account ${account}`)
    if (!o.dryRun) {
      // through `security -i` on stdin: the token never appears in a process argument list
      const r = spawnSync(security!, ['-i'], { input: `add-generic-password -U -s "${KEYCHAIN_SERVICE}" -a "${account}" -l "${NAME} MCP token (${o.client})" -w "${token}"\n`, env: env as NodeJS.ProcessEnv, encoding: 'utf8' })
      if (r.status !== 0) throw new UsageError(`could not store the token in the Keychain: ${(r.stderr || r.stdout || '').trim()}`)
    }
  } else if (store === 'file') {
    say(`token file (mode 0600): ${tokenFile}`)
    if (!o.dryRun) {
      fs.mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 })
      writeFileAtomic(tokenFile, token + '\n')
      fs.chmodSync(tokenFile, 0o600)
    }
  } else {
    warn(`--store inline: the token is written in clear text into ${configFile} (anyone who can read that file can use it)`)
  }
  const envLine = `export ${varName}=${store === 'keychain' ? `"$(${sq(security!)} find-generic-password -s ${sq(KEYCHAIN_SERVICE)} -a ${sq(account)} -w 2>/dev/null)"` : `"$(cat ${sq(tokenFile)} 2>/dev/null)"`}`

  // 5. the client's configuration, user scope
  const run = (cmd: string[], what: string) => {
    say(`$ ${cmd.map((c) => /^[\w@%+=:,./-]+$/.test(c) ? c : sq(c)).join(' ')}`.replace(token, '<token>'))
    if (o.dryRun) return
    const r = spawnSync(cmd[0]!, cmd.slice(1), { cwd: p.home, env: env as NodeJS.ProcessEnv, encoding: 'utf8' })
    if (r.status !== 0) throw new UsageError(`${what} failed: ${(r.stderr || r.stdout || `exit ${r.status}`).trim()}`)
  }
  const writeFile = (file: string, text: string) => {
    say(`write ${file}:`)
    for (const l of text.replace(token, '<token>').trimEnd().split('\n')) say(`  ${l}`)
    if (!o.dryRun) writeFileAtomic(file, text)
  }

  if (o.client === 'claude') {
    const entry: Record<string, unknown> = { type: 'http', url: o.mcpUrl }
    if (store === 'inline') entry.headers = { Authorization: `Bearer ${token}` }
    else entry.headersHelper = `printf '{"Authorization":"Bearer %s"}' ${helperGet}`
    if (bin && store !== 'inline') {
      if (sameName) run([bin, 'mcp', 'remove', '--scope', 'user', o.name], 'claude mcp remove')
      run([bin, 'mcp', 'add-json', '--scope', 'user', o.name, JSON.stringify(entry)], 'claude mcp add-json')
    } else {
      // no claude CLI here (or a clear-text token, which must not go through a process argument): edit the file
      const j = readJson(p.claude) ?? {}
      j.mcpServers = { ...(j.mcpServers ?? {}), [o.name]: entry }
      writeFile(p.claude, JSON.stringify(j, null, 2) + '\n')
    }
  } else if (o.client === 'codex') {
    if (bin && store !== 'inline') {
      run([bin, 'mcp', 'add', o.name, '--url', o.mcpUrl, '--bearer-token-env-var', varName], 'codex mcp add')
      if (o.autoApprove) {
        const text = setTomlKey(fs.existsSync(p.codex) ? fs.readFileSync(p.codex, 'utf8') : `[mcp_servers.${tomlKey(o.name)}]\n`, o.name, 'default_tools_approval_mode', '"approve"')
        if (o.dryRun) say(`then set default_tools_approval_mode = "approve" in [mcp_servers.${o.name}] of ${p.codex}`)
        else writeFileAtomic(p.codex, text)
      }
    } else {
      const body = [`url = ${JSON.stringify(o.mcpUrl)}`,
        store === 'inline' ? `http_headers = { Authorization = ${JSON.stringify(`Bearer ${token}`)} }` : `bearer_token_env_var = ${JSON.stringify(varName)}`,
        ...(o.autoApprove ? ['default_tools_approval_mode = "approve"'] : [])]
      writeFile(p.codex, upsertTomlSection(fs.existsSync(p.codex) ? fs.readFileSync(p.codex, 'utf8') : '', o.name, body))
    }
  } else {
    const j = readJson(p.cursor) ?? {}
    j.mcpServers = { ...(j.mcpServers ?? {}), [o.name]: { url: o.mcpUrl, headers: { Authorization: store === 'inline' ? `Bearer ${token}` : `Bearer \${env:${varName}}` } } }
    writeFile(p.cursor, JSON.stringify(j, null, 2) + '\n')
  }
  if (o.client !== 'claude' && store !== 'inline') {
    say(`env file ${envFile}: ${envLine}`)
    if (!o.dryRun) upsertEnvLine(envFile, varName, envLine)
  }

  // 6. what the person does next
  say('')
  if (made) say(`token "${made.name}" (id ${made.id}) made for ${o.client}; expires in ${o.ttl}${o.readOnly ? '; read-only' : ''}${newScope ? `; folders: ${o.scope!.join(', ')}` : ''}. Revoke it on the web (My tokens) when you stop using it.`)
  if (o.client === 'claude') say(`Claude Code: ${o.dryRun ? 'would be connected' : 'connected'} in user scope as "${o.name}" (check: claude mcp get ${o.name}). Never add it to a project .mcp.json.`)
  if (o.client !== 'claude' && store !== 'inline') {
    say(`${o.client === 'codex' ? 'Codex' : 'Cursor'} reads the token from $${varName}. Add this line to your shell profile (~/.zshrc or ~/.bashrc) once, then open a new terminal${o.client === 'cursor' ? ' and restart Cursor' : ''}:`)
    say(`  . ${sq(envFile)}`)
  }
  if (o.client === 'codex') say(o.autoApprove ? 'Codex: tools of this server are approved automatically (default_tools_approval_mode = "approve").'
    : 'Codex asks before each tool call of this server; with `codex exec` (approval policy "never") calls are refused — rerun with --auto-approve to approve this server\'s tools.')
  if (o.client === 'cursor') say('Cursor: enable the server in Settings → MCP (cursor-agent: `cursor-agent mcp enable ' + o.name + '` or --approve-mcps).')
  return 0
}

function resolveRef(ref: TokenRef, env: McpIO['env']): string | null {
  try {
    if (ref.kind === 'literal') return ref.token
    if (ref.kind === 'env') return env[ref.name] ?? null
    if (ref.kind === 'file') return fs.readFileSync(ref.file, 'utf8').trim()
    if (ref.kind === 'keychain') {
      const sec = which('security', env)
      if (!sec) return null
      const r = spawnSync(sec, ['find-generic-password', '-s', ref.service, '-a', ref.account, '-w'], { env: env as NodeJS.ProcessEnv, encoding: 'utf8' })
      return r.status === 0 ? r.stdout.trim() : null
    }
  } catch { /* unreadable: unknown */ }
  return null
}

/** Read a password from the terminal without echo (null when stdin is not a terminal). */
export function ttyPassword(question: string): Promise<string> {
  const stdin = process.stdin
  if (!stdin.isTTY) return Promise.resolve('')
  process.stderr.write(question)
  return new Promise((resolve) => {
    let buf = ''
    stdin.setRawMode(true)
    stdin.resume()
    const done = (v: string) => { stdin.setRawMode(false); stdin.pause(); stdin.off('data', on); process.stderr.write('\n'); resolve(v) }
    const on = (d: Buffer) => {
      for (const ch of d.toString('utf8')) {
        if (ch === '\r' || ch === '\n') return done(buf)
        if (ch === '\u0003') { done(''); process.exit(130) }
        if (ch === '\u007f' || ch === '\b') buf = [...buf].slice(0, -1).join('')
        else buf += ch
      }
    }
    stdin.on('data', on)
  })
}
