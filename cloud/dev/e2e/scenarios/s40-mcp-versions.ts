// S40 — MCP versions: the official SDK clients connect through Caddy in every way they negotiate (v2 auto → 2026-07-28
// via server/discover, pinned modern, legacy initialize → 2025-11-25; v1 SDK) and get the same instructions and tools;
// an unknown version is answered with 2025-11-25. Optional: the real Claude Code CLI in a throwaway config dir
// (CLAUDE_CONFIG_DIR; ~/.claude* untouched) health-checks the server; with ANTHROPIC_API_KEY it also asks a question,
// and with OPENAI_API_KEY/CODEX_API_KEY so does Codex (CODEX_HOME in a temp dir).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CANARY } from '../../seed-team'
import type { Scenario, T } from '../lib/ctx'
import { mcpRaw } from '../lib/drive'
import { sdkBash, sdkV1, sdkV2 } from '../lib/mcp'

export default {
  id: 'S40', title: 'MCP versions: SDK v2 (auto/modern/legacy) + v1 through Caddy, same instructions; real Claude Code (optional)', phase: 1, targets: ['local', 'aws'], uses: 'MCP',
  async run(t) {
    const fx = t.fx
    const tok = await fx.token('mina')
    const init = await mcpRaw(t.http, fx.slug, tok, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'e2e-raw', version: '1' } })
    const instructions = init.json().result?.instructions as string
    t.check('raw initialize 2025-11-25 → instructions mention /drafts/', init.status === 200 && /\/drafts\//.test(instructions ?? ''), init.text.slice(0, 200))
    for (const v of ['2099-01-01', '2024-11-05', '2026-07-28']) {
      const r = await mcpRaw(t.http, fx.slug, tok, 'initialize', { protocolVersion: v, capabilities: {}, clientInfo: { name: 'e2e-raw', version: '1' } })
      t.check(`initialize asking ${v} → answered with 2025-11-25`, r.json().result?.protocolVersion === '2025-11-25', r.text.slice(0, 200))
    }
    const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': { name: 'e2e-raw', version: '1' } }
    const disc = await mcpRaw(t.http, fx.slug, tok, 'server/discover', { _meta: meta }, { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'server/discover' })
    const d = disc.status === 200 ? disc.json().result : {}
    t.check('server/discover (2026-07-28): no method-not-found; the same instructions as initialize', disc.status === 200 && d.instructions === instructions, disc.text.slice(0, 300))
    t.check(`server/discover advertises what it implements (${JSON.stringify(d.supportedVersions)})`, Array.isArray(d.supportedVersions) && d.supportedVersions.includes('2025-11-25'), d.supportedVersions)

    for (const [label, mk] of [
      ['SDK v2, auto (discover)', () => sdkV2(t.target, fx.slug, tok, { mode: 'auto' })],
      ['SDK v2, pinned 2026-07-28', () => sdkV2(t.target, fx.slug, tok, { mode: { pin: '2026-07-28' } })],
      ['SDK v2, legacy (initialize)', () => sdkV2(t.target, fx.slug, tok)],
      ['SDK v1 (1.32.1)', () => sdkV1(t.target, fx.slug, tok)],
    ] as const) {
      try {
        const c = await (mk as () => Promise<any>)()
        const ver = c.getNegotiatedProtocolVersion?.() ?? '2025-11-25'
        const tools = (await c.listTools()).tools.map((x: { name: string }) => x.name)
        const r = await sdkBash(c, "cat '/공용/notice.md'")
        t.check(`${label}: connects (${ver}), tools/list has bash, same instructions, reads a file`, tools.includes('bash') && c.getInstructions() === instructions && r.text.includes(CANARY.공용), { ver, tools, text: r.text.slice(0, 100) })
        await c.close()
      } catch (e) { t.check(`${label}: connects`, false, (e as Error).message) }
    }
    await realClaude(t, tok)
    await realCodex(t, tok)
  },
} satisfies Scenario

function which(bin: string): string | null {
  const r = Bun.spawnSync(['/bin/sh', '-c', `command -v ${bin}`], { stdout: 'pipe' })
  const p = r.stdout.toString().trim()
  return r.exitCode === 0 && p.startsWith('/') ? p : null
}

/** the real Claude Code CLI with its config in a temp dir (never ~/.claude, ~/.claude.json) */
async function realClaude(t: T, tok: string) {
  const claude = which('claude')
  if (!claude) { t.skipPart('real Claude Code health check', 'the claude CLI is not installed here (optional)'); return }
  const fx = t.fx
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trina-e2e-claude-'))
  const home = fs.statSync(path.join(os.homedir(), '.claude.json'), { throwIfNoEntry: false })?.mtimeMs
  const env = { ...process.env, CLAUDE_CONFIG_DIR: dir, ...(t.target.caFile ? { NODE_EXTRA_CA_CERTS: t.target.caFile } : {}) }
  const run = (args: string[]) => Bun.spawnSync([claude, ...args], { env, cwd: dir, stdout: 'pipe', stderr: 'pipe', timeout: 120_000 })
  try {
    const add = run(['mcp', 'add', '--transport', 'http', '--scope', 'user', 'trina', `${fx.url}/mcp`, '--header', `Authorization: Bearer ${tok}`])
    t.check('claude mcp add (temp CLAUDE_CONFIG_DIR)', add.exitCode === 0, add.stderr.toString().slice(0, 300))
    const list = run(['mcp', 'list'])
    const out = list.stdout.toString()
    t.check('claude mcp list: trina ✓ Connected (the real client\'s handshake + tools/list)', /trina.*(Connected|✓)/.test(out), out.slice(0, 400))
    const after = fs.statSync(path.join(os.homedir(), '.claude.json'), { throwIfNoEntry: false })?.mtimeMs
    t.check('~/.claude.json untouched', after === home)
    if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      const ask = run(['-p', 'Use the trina bash tool to cat /공용/notice.md and print the line that starts with CANARY.', '--allowedTools', 'mcp__trina__bash', '--max-turns', '4'])
      t.check('claude -p answers with the /공용 canary (S20-style, mina\'s token)', ask.stdout.toString().includes(CANARY.공용), ask.stdout.toString().slice(0, 300))
    } else t.skipPart('claude -p question (S20-style)', 'no ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN in env (optional; a temp config dir has no login)')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

/** the real Codex CLI with CODEX_HOME in a temp dir (never ~/.codex) */
async function realCodex(t: T, tok: string) {
  const codex = which('codex')
  if (!codex) { t.skipPart('real Codex question', 'the codex CLI is not installed here (optional)'); return }
  const key = process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY
  if (!key) { t.skipPart('real Codex question (S21-style)', 'no OPENAI_API_KEY / CODEX_API_KEY in env (optional; a temp CODEX_HOME has no login)'); return }
  const fx = t.fx
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trina-e2e-codex-'))
  try {
    fs.writeFileSync(path.join(dir, 'config.toml'), `[mcp_servers.trina]\nurl = "${fx.url}/mcp"\nbearer_token_env_var = "TRINA_E2E_TOKEN"\n`)
    const env = { ...process.env, CODEX_HOME: dir, TRINA_E2E_TOKEN: tok, OPENAI_API_KEY: key, ...(t.target.caFile ? { SSL_CERT_FILE: t.target.caFile, CODEX_CA_CERTIFICATE: t.target.caFile } : {}) }
    const r = Bun.spawnSync([codex, 'exec', '--skip-git-repo-check', 'Use the trina MCP bash tool to cat /공용/notice.md and print the line that starts with CANARY.'], { env, cwd: dir, stdout: 'pipe', stderr: 'pipe', timeout: 300_000 })
    t.check('codex exec answers with the /공용 canary', r.stdout.toString().includes(CANARY.공용), (r.stdout.toString() + r.stderr.toString()).slice(-400))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}
