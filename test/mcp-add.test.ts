// `<cli> mcp add claude|codex|cursor` (plan 5.1 CLI, 7.1 token leak, M8). Every test runs with HOME set to a fresh
// temporary directory and a PATH whose `claude`, `codex` and `security` are fakes that only log (the real clients and
// the real Keychain are never invoked, and nothing outside the temporary HOME is written).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mcpCommand, upsertTomlSection, type McpIO } from '../src/client/mcp'
import { TOKEN_PREFIX } from '../src/config'
import { handleWeb } from '../src/web/server'
import { PASSWORD, webSetup, type WebEnv } from './web-helpers'

const SERVER = 'http://files.test:8787'
const FAKES: Record<string, string> = {
  claude: `#!/bin/sh\n{ printf 'cwd=%s\\n' "$PWD"; for a in "$@"; do printf 'arg=%s\\n' "$a"; done; } >> "$HOME/claude.log"\n`,
  codex: `#!/bin/sh\n{ printf 'cwd=%s\\n' "$PWD"; for a in "$@"; do printf 'arg=%s\\n' "$a"; done; } >> "$HOME/codex.log"\n` +
    `mkdir -p "$HOME/.codex"; printf '[mcp_servers.%s]\\nurl = "%s"\\nbearer_token_env_var = "%s"\\n' "$3" "$5" "$7" >> "$HOME/.codex/config.toml"\n`,
  // -i: the commands come on stdin (logged); find-generic-password: print the last stored -w value for that account
  security: `#!/bin/sh\nif [ "$1" = "-i" ]; then cat >> "$HOME/keychain.txt"; exit 0; fi\n` +
    `acct=""; while [ $# -gt 0 ]; do [ "$1" = "-a" ] && acct="$2"; shift; done\n` +
    `grep -- "-a \\"$acct\\"" "$HOME/keychain.txt" | tail -1 | sed 's/.*-w "\\(.*\\)"$/\\1/'\n`,
}

let e: WebEnv
let home: string, bin: string, out: string[], err: string[]
beforeEach(async () => {
  e = await webSetup()
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-home-')))
  bin = path.join(home, '..', path.basename(home) + '-bin')
  fs.mkdirSync(bin)
  for (const [n, body] of Object.entries(FAKES)) fs.writeFileSync(path.join(bin, n), body, { mode: 0o755 })
  out = []; err = []
})
afterEach(() => { e.cleanup(); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(bin, { recursive: true, force: true }) })

function io(stdin = PASSWORD, opts: { bins?: string[]; env?: Record<string, string> } = {}): McpIO {
  let pathVar = `${bin}:/usr/bin:/bin`
  if (opts.bins) {
    const only = path.join(bin, 'only')
    fs.mkdirSync(only, { recursive: true })
    for (const b of opts.bins) fs.copyFileSync(path.join(bin, b), path.join(only, b))
    fs.chmodSync(only, 0o755)
    for (const b of opts.bins) fs.chmodSync(path.join(only, b), 0o755)
    pathVar = `${only}:/usr/bin:/bin`
  }
  return {
    env: { HOME: home, PATH: pathVar, USER: 'kim', ...opts.env },
    out: (l) => out.push(l), err: (l) => err.push(l),
    readStdin: async () => stdin,
    fetch: (async (u: string | URL | Request, init?: RequestInit) => handleWeb(e.w, new Request(String(u), init), '10.0.0.2')) as typeof fetch,
    platform: 'darwin', hostname: 'laptop.local',
  }
}
const add = (args: string[], i = io()) => mcpCommand(['add', ...args, '--server', SERVER, '--password-stdin'], i)
const tokensOf = (name: string) => e.db.query<{ id: number; name: string; scope: string | null; read_only: number; expires_at: number | null; created_at: number; revoked_at: number | null }, [string]>(
  'SELECT t.* FROM tokens t JOIN people p ON p.id = t.person_id WHERE p.name = ? ORDER BY t.id').all(name)
const lastToken = () => {
  const kc = fs.readFileSync(path.join(home, 'keychain.txt'), 'utf8').trim().split('\n').at(-1)!
  return /-w "([^"]+)"/.exec(kc)![1]!
}
const logArgs = (f: string) => fs.readFileSync(path.join(home, f), 'utf8').trim().split('\n')
/** Run a shell snippet the way a client would (with the fake `security` first on PATH). */
const shell = (cmd: string, i = io()) => spawnSync('/bin/sh', ['-c', cmd], { env: i.env as NodeJS.ProcessEnv, encoding: 'utf8' }).stdout
async function mcpPing(token: string) {
  const r = await handleWeb(e.w, new Request(SERVER + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) }), '10.0.0.3')
  return r.status
}
/** No file under HOME except the fake keychain and token files holds the token in clear text. */
function clearTextFiles(token: string): string[] {
  const hits: string[] = []
  const walk = (d: string) => {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n)
      if (fs.lstatSync(p).isDirectory()) walk(p)
      else if (fs.readFileSync(p, 'utf8').includes(token)) hits.push(path.relative(home, p))
    }
  }
  walk(home)
  return hits
}

describe('Claude Code', () => {
  test('makes a token with the person\'s sign-in, keeps it in the Keychain, connects through `claude mcp add-json --scope user` (headersHelper)', async () => {
    expect(await add(['claude', '--login', 'kim'])).toBe(0)
    const made = tokensOf('kim').at(-1)!
    expect(made.name).toBe('claude@laptop')
    expect(made.expires_at! - made.created_at).toBe(7 * 86400_000)
    const token = lastToken()
    expect(token).toStartWith(TOKEN_PREFIX)
    // the client CLI ran in HOME (never a project directory), user scope, and never saw the token
    const log = logArgs('claude.log')
    expect(log[0]).toBe(`cwd=${home}`)
    expect(log.slice(1, 6)).toEqual(['arg=mcp', 'arg=add-json', 'arg=--scope', 'arg=user', 'arg=shelf'])
    const entry = JSON.parse(log[6]!.slice(4))
    expect(entry).toMatchObject({ type: 'http', url: `${SERVER}/mcp` })
    expect(entry.headers).toBeUndefined()
    expect(log.join('\n')).not.toContain(token)
    // the helper prints the header Claude sends, and that token works
    const header = JSON.parse(shell(entry.headersHelper))
    expect(header).toEqual({ Authorization: `Bearer ${token}` })
    expect(await mcpPing(token)).toBe(200)
    expect(clearTextFiles(token)).toEqual(['keychain.txt'])
    expect(err.join('\n')).toContain('plain http') // a LAN address over http is warned about
    // signed out again
    expect(e.db.query('SELECT count(*) AS n FROM web_sessions WHERE revoked_at IS NULL').get()).toEqual({ n: 0 })
  })

  test('without the claude CLI: writes ~/.claude.json (user-scope mcpServers) and keeps everything else in it; --store file is 0600', async () => {
    const cfg = path.join(home, '.claude.json')
    fs.writeFileSync(cfg, JSON.stringify({ numStartups: 3, mcpServers: { other: { type: 'stdio', command: 'x' } }, projects: { '/repo': { mcpServers: {} } } }), { mode: 0o600 })
    expect(await add(['claude', '--login', 'kim', '--store', 'file'], io(PASSWORD, { bins: ['security'] }))).toBe(0)
    const j = JSON.parse(fs.readFileSync(cfg, 'utf8'))
    expect(j.numStartups).toBe(3)
    expect(j.mcpServers.other).toEqual({ type: 'stdio', command: 'x' })
    expect(j.projects['/repo'].mcpServers).toEqual({})
    expect(fs.statSync(cfg).mode & 0o777).toBe(0o600)
    const file = path.join(home, '.config', 'shelf', 'tokens', 'claude-shelf')
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    const token = fs.readFileSync(file, 'utf8').trim()
    expect(JSON.parse(shell(j.mcpServers.shelf.headersHelper))).toEqual({ Authorization: `Bearer ${token}` })
    expect(clearTextFiles(token)).toEqual(['.config/shelf/tokens/claude-shelf'])
    expect(fs.existsSync(path.join(home, '.mcp.json'))).toBe(false)
  })

  test('an entry with the same name is not replaced without --force; with --force the old one is removed first', async () => {
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { shelf: { type: 'http', url: 'http://elsewhere/mcp' } } }))
    expect(await add(['claude', '--login', 'kim'])).toBe(1)
    expect(err.join('\n')).toContain('--force')
    expect(tokensOf('kim').filter((t) => t.name.startsWith('claude@'))).toHaveLength(0) // refused before a token was made
    expect(await add(['claude', '--login', 'kim', '--force'])).toBe(0)
    const log = logArgs('claude.log')
    expect(log.slice(1, 6)).toEqual(['arg=mcp', 'arg=remove', 'arg=--scope', 'arg=user', 'arg=shelf'])
  })
})

describe('Codex', () => {
  test('`codex mcp add --url --bearer-token-env-var`; the env file reads the Keychain; approvals stay with the person by default', async () => {
    expect(await add(['codex', '--login', 'kim'])).toBe(0)
    const log = logArgs('codex.log')
    expect(log).toEqual([`cwd=${home}`, 'arg=mcp', 'arg=add', 'arg=shelf', 'arg=--url', `arg=${SERVER}/mcp`, 'arg=--bearer-token-env-var', 'arg=SHELF_TOKEN_CODEX'])
    const toml = Bun.TOML.parse(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8')) as any
    expect(toml.mcp_servers.shelf.default_tools_approval_mode).toBeUndefined()
    const envFile = path.join(home, '.config', 'shelf', 'env.sh')
    const token = lastToken()
    expect(shell(`. '${envFile}'; printf %s "$SHELF_TOKEN_CODEX"`)).toBe(token)
    expect(clearTextFiles(token)).toEqual(['keychain.txt'])
    expect(out.join('\n')).toContain('--auto-approve')
  })

  test('--auto-approve sets default_tools_approval_mode = "approve" in that server\'s table only', async () => {
    expect(await add(['codex', '--login', 'kim', '--auto-approve'])).toBe(0)
    const toml = Bun.TOML.parse(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8')) as any
    expect(toml.mcp_servers.shelf).toEqual({ url: `${SERVER}/mcp`, bearer_token_env_var: 'SHELF_TOKEN_CODEX', default_tools_approval_mode: 'approve' })
  })

  test('without the codex CLI: edits ~/.codex/config.toml, keeping other settings and servers; CODEX_HOME is honoured', async () => {
    const ch = path.join(home, 'codexhome')
    fs.mkdirSync(ch)
    fs.writeFileSync(path.join(ch, 'config.toml'), 'model = "o3"\n\n[mcp_servers.docs]\ncommand = "docs-mcp"\n\n[mcp_servers.shelf]\nurl = "http://old/mcp"\n\n[mcp_servers.shelf.tools.bash]\napproval_mode = "approve"\n\n[profiles.x]\nmodel = "y"\n')
    expect(await add(['codex', '--login', 'kim', '--force'], io(PASSWORD, { bins: ['security'], env: { CODEX_HOME: ch } }))).toBe(0)
    const toml = Bun.TOML.parse(fs.readFileSync(path.join(ch, 'config.toml'), 'utf8')) as any
    expect(toml.model).toBe('o3')
    expect(toml.mcp_servers.docs).toEqual({ command: 'docs-mcp' })
    expect(toml.mcp_servers.shelf).toEqual({ url: `${SERVER}/mcp`, bearer_token_env_var: 'SHELF_TOKEN_CODEX' })
    expect(toml.profiles.x).toEqual({ model: 'y' })
    expect(fs.existsSync(path.join(home, '.codex'))).toBe(false)
  })

  test('upsertTomlSection handles quoted names and an empty file', () => {
    expect(upsertTomlSection('', 'a-b', ['url = "u"'])).toBe('[mcp_servers.a-b]\nurl = "u"\n')
    expect(upsertTomlSection('[mcp_servers."a-b"]\nurl = "old"\n[x]\ny = 1\n', 'a-b', ['url = "u"'])).toBe('[x]\ny = 1\n\n[mcp_servers.a-b]\nurl = "u"\n')
  })
})

describe('Cursor', () => {
  test('~/.cursor/mcp.json (user scope) with ${env:…}; other servers kept; env file line', async () => {
    fs.mkdirSync(path.join(home, '.cursor'))
    fs.writeFileSync(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { gh: { command: 'gh-mcp' } } }))
    expect(await add(['cursor', '--login', 'kim'])).toBe(0)
    const j = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8'))
    expect(j.mcpServers.gh).toEqual({ command: 'gh-mcp' })
    expect(j.mcpServers.shelf).toEqual({ url: `${SERVER}/mcp`, headers: { Authorization: 'Bearer ${env:SHELF_TOKEN_CURSOR}' } })
    const token = lastToken()
    expect(shell(`. '${path.join(home, '.config', 'shelf', 'env.sh')}'; printf %s "$SHELF_TOKEN_CURSOR"`)).toBe(token)
    expect(clearTextFiles(token)).toEqual(['keychain.txt'])
  })

  test('M8: an entry for the same server with a broader token is warned about (and a clear-text one)', async () => {
    fs.mkdirSync(path.join(home, '.cursor'))
    const wide = e.secrets.kim! // all folders, can write drafts
    fs.writeFileSync(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { old: { url: `${SERVER}/mcp/`, headers: { Authorization: `Bearer ${wide}` } } } }))
    expect(await add(['cursor', '--login', 'kim', '--read-only', '--scope', '공용'])).toBe(0)
    const w = err.join('\n')
    expect(w).toContain('"old" keeps a token in clear text')
    expect(w).toMatch(/"old" uses a broader token "[^"]+" \(can write drafts, all folders\)/)
    const made = tokensOf('kim').at(-1)!
    expect(made.read_only).toBe(1)
    expect(JSON.parse(made.scope!)).toEqual([e.fid('공용')])
    // the warning names no secret
    expect(w).not.toContain(wide.slice(TOKEN_PREFIX.length))
  })

  test('M8: an entry whose token cannot be read is still reported', async () => {
    fs.mkdirSync(path.join(home, '.cursor'))
    fs.writeFileSync(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { mystery: { url: `${SERVER}/mcp`, headers: { Authorization: 'Bearer ${env:NOT_SET_HERE}' } } } }))
    expect(await add(['cursor', '--login', 'kim'])).toBe(0)
    expect(err.join('\n')).toContain('"mystery" also connects to this server; its token could not be checked')
  })
})

describe('refusals and dry run', () => {
  test('--dry-run prints the plan and writes nothing, makes no token, runs no client', async () => {
    const before = tokensOf('kim').length
    for (const c of ['claude', 'codex', 'cursor']) expect(await mcpCommand(['add', c, '--server', SERVER, '--dry-run'], io())).toBe(0)
    expect(tokensOf('kim').length).toBe(before)
    expect(fs.readdirSync(home)).toEqual([])
    const text = out.join('\n')
    expect(text).toContain('add-json --scope user shelf')
    expect(text).toContain('codex mcp add shelf --url')
    expect(text).toContain('Bearer ${env:SHELF_TOKEN_CURSOR}')
  })

  test('the CLI entry point: `mcp add … --dry-run` with HOME set never opens a data directory or writes', () => {
    const r = spawnSync(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'cli.ts'), 'mcp', 'add', 'cursor', '--server', SERVER, '--dry-run'],
      { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, SHELF_HOME: path.join(home, 'nodata') }, encoding: 'utf8' })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain(path.join(home, '.cursor', 'mcp.json'))
    expect(fs.readdirSync(home).filter((n) => n !== 'Library')).toEqual([])
  })

  test('wrong password, unknown folder, admin without a narrowed scope: refused, no token made', async () => {
    const before = e.db.query('SELECT count(*) AS n FROM tokens').get()
    expect(await add(['cursor', '--login', 'kim'], io('wrong password!'))).toBe(1)
    expect(err.at(-1)).toContain('sign-in failed (401')
    expect(await add(['cursor', '--login', 'kim', '--scope', '경영'])).toBe(1) // kim cannot read it: same as nonexistent
    expect(err.at(-1)).toContain('no folder "경영"')
    expect(await add(['cursor', '--login', 'dion'])).toBe(1)
    expect(err.at(-1)).toContain('--scope')
    expect(e.db.query('SELECT count(*) AS n FROM tokens').get()).toEqual(before)
    expect(fs.existsSync(path.join(home, '.cursor'))).toBe(false)
  })

  test('--token-stdin takes an existing token without signing in; a token on the command line is refused', async () => {
    expect(await mcpCommand(['add', 'cursor', '--server', SERVER, '--token-stdin'], io(e.secrets.boss!))).toBe(0)
    expect(lastToken()).toBe(e.secrets.boss!)
    expect(await mcpCommand(['add', 'cursor', '--server', SERVER, '--token', e.secrets.boss!], io())).toBe(1)
    expect(err.at(-1)).toContain('--token-stdin')
  })

  test('--token-stdin on a terminal asks for the token without echo (the web page\'s command: nothing in shell history)', async () => {
    const asked: string[] = []
    const i: McpIO = { ...io('not read: stdin is a terminal'), stdinIsTTY: true, promptPassword: async (q) => { asked.push(q); return e.secrets.kim! + '\n' } }
    expect(await mcpCommand(['add', 'claude', '--server', SERVER, '--token-stdin'], i)).toBe(0)
    expect(asked).toEqual(['paste the token (it is not shown): '])
    expect(lastToken()).toBe(e.secrets.kim!)
    expect(out.join('\n')).not.toContain(e.secrets.kim!)
  })

  test('a config inside a git repository (dotfiles HOME): a clear-text token is refused, otherwise a warning', async () => {
    fs.mkdirSync(path.join(home, '.git'))
    expect(await add(['cursor', '--login', 'kim', '--store', 'inline'])).toBe(1)
    expect(err.at(-1)).toContain('git repository')
    expect(await add(['cursor', '--login', 'kim'])).toBe(0)
    expect(err.join('\n')).toContain('inside a git repository')
    expect(clearTextFiles(lastToken())).toEqual(['keychain.txt'])
  })

  test('--store inline writes the token in clear text with a warning (Cursor)', async () => {
    expect(await add(['cursor', '--login', 'kim', '--store', 'inline'])).toBe(0)
    expect(err.join('\n')).toContain('clear text')
    const j = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8'))
    expect(j.mcpServers.shelf.headers.Authorization).toStartWith(`Bearer ${TOKEN_PREFIX}`)
    expect(fs.existsSync(path.join(home, 'keychain.txt'))).toBe(false)
  })
})
