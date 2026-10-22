// The My tokens page's "connect a client" commands (web/src/connect.ts): no token on a command line; the commands are
// ones `mcp add` accepts; the manual fallback is what the clients (and mcp add's own checks) read as a clear-text token.
import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { clientPaths, existingEntries, mcpCommand, type McpIO } from '../src/client/mcp'
import { NAME, TOKEN_PREFIX } from '../src/config'
import { CLIENTS, cliName, manualConfig, recommendedCommand, shq, tokenStdinCommand, type ConnectCtx } from '../web/src/connect'

const TOKEN = `${TOKEN_PREFIX}AbCdEfGhIjKlMnOpQrStUv0123456789`
const ctx: ConnectCtx = { cli: cliName(NAME), origin: 'https://files.example.lan', login: 'kim', admin: false }
const homes: string[] = []
afterAll(() => homes.forEach((h) => fs.rmSync(h, { recursive: true, force: true })))
const tmpHome = () => { const h = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-connect-'))); homes.push(h); return h }

/** Split a generated command line the way sh would (only plain words and single quotes are generated). */
const words = (cmd: string) => [...cmd.matchAll(/'((?:[^']|'\\'')*)'|(\S+)/g)].map((m) => m[1] !== undefined ? m[1].replace(/'\\''/g, "'") : m[2]!)

function dryRun(cmd: string, stdin = '') {
  const out: string[] = [], err: string[] = []
  const io: McpIO = { env: { HOME: tmpHome(), PATH: '/usr/bin:/bin' }, out: (l) => out.push(l), err: (l) => err.push(l), readStdin: async () => stdin, platform: 'linux', fetch: (() => { throw new Error('a dry run contacts nothing') }) as never }
  const w = words(cmd)
  expect(w[0]).toBe(ctx.cli)
  expect(w[1]).toBe('mcp')
  return { code: mcpCommand([...w.slice(2), '--dry-run'], io), out, err }
}

describe('My tokens: connect commands', () => {
  test('recommended per client: `<cli> mcp add <client> --server <origin> --login <me>`, no token anywhere; mcp add accepts it', async () => {
    for (const client of CLIENTS) {
      const cmd = recommendedCommand(ctx, client)
      expect(cmd).toBe(`${ctx.cli} mcp add ${client} --server https://files.example.lan --login kim`)
      expect(cmd).not.toMatch(/Bearer|Authorization|--header|_pat_/)
      const r = dryRun(cmd)
      expect(await r.code).toBe(0)
      expect(r.out.join('\n')).toContain('would be made on https://files.example.lan')
    }
    // admins narrow it (plan 5.1): a placeholder they replace
    expect(recommendedCommand({ ...ctx, admin: true }, 'codex')).toEndWith('--login kim --scope FOLDERS')
  })

  test('a freshly made token: --token-stdin (pasted at a hidden prompt), never the token itself', async () => {
    for (const client of CLIENTS) {
      const cmd = tokenStdinCommand(ctx, client)
      expect(cmd).toBe(`${ctx.cli} mcp add ${client} --server https://files.example.lan --token-stdin`)
      expect(cmd).not.toContain(TOKEN)
      expect(await dryRun(cmd).code).toBe(0)
    }
  })

  test('names that need quoting are quoted for sh', () => {
    expect(shq('kim')).toBe('kim')
    expect(shq('김민수')).toBe(`'김민수'`)
    expect(shq(`o'neil x`)).toBe(`'o'\\''neil x'`)
    expect(words(recommendedCommand({ ...ctx, login: `o'neil x` }, 'claude')).at(-1)).toBe(`o'neil x`)
    expect(cliName('Shelf')).toBe('shelf')
    expect(cliName('')).toBe('shelf')
  })

  test('manual fallback: each client file holds the token in clear text where mcp add (and the client) look for it', () => {
    for (const client of CLIENTS) {
      const m = manualConfig(ctx, client, TOKEN)
      const home = tmpHome()
      const file = clientPaths({ HOME: home })[client]
      expect(m.file.replace('~', home)).toBe(file)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, m.text)
      const ex = existingEntries(client, { HOME: home }, `${ctx.origin}/mcp`)
      expect(ex).toEqual([expect.objectContaining({ name: ctx.cli, ref: { kind: 'literal', token: TOKEN } })])
    }
  })
})
