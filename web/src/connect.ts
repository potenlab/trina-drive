// What the My tokens page tells a person to run to connect an AI client (src/client/mcp.ts, README "Connecting
// clients"). No secret is ever put on a command line: the recommended command signs in and makes its own token (kept
// in the Keychain / a private file), and a token made on this page is pasted at the CLI's hidden prompt
// (--token-stdin). Only the collapsed manual fallback writes the token into a client file, in clear text.
// Pure functions (no DOM) so they can be tested without a browser.
import { CLI, NAME } from '../../src/brand'

export const CLIENTS = ['claude', 'codex', 'cursor'] as const
export type Client = (typeof CLIENTS)[number]
export const CLIENT_LABEL: Record<Client, string> = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor' }

export interface ConnectCtx {
  /** the command on the person's computer (tdrive) */
  cli: string
  /** the MCP entry name in the client's configuration (trina-drive) */
  entry: string
  /** where this page was loaded from (the server's address as the person reaches it) */
  origin: string
  /** the person's sign-in name */
  login: string
  /** admins must narrow a token (--scope) or ask for all folders (plan 5.1) */
  admin: boolean
}

/** A word for a POSIX shell: as is when plainly safe, otherwise single-quoted. */
export function shq(s: string): string {
  return /^[A-Za-z0-9_.,:/@%+=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}

/** The product's command and MCP entry name (src/brand.ts). */
export const BRAND_CTX = { cli: CLI, entry: NAME } as const

/** Recommended: the CLI signs in (password at a hidden prompt), makes a token for this client and stores it. */
export function recommendedCommand(c: ConnectCtx, client: Client): string {
  return `${c.cli} mcp add ${client} --server ${shq(c.origin)} --login ${shq(c.login)}${c.admin ? ' --scope FOLDERS' : ''}`
}

/** For a token just made on this page: the CLI asks for it without echo, so it is in neither the screen nor history. */
export function tokenStdinCommand(c: ConnectCtx, client: Client): string {
  return `${c.cli} mcp add ${client} --server ${shq(c.origin)} --token-stdin`
}

/** Manual fallback: the client file and the entry that holds the token in clear text. */
export function manualConfig(c: ConnectCtx, client: Client, token: string): { file: string; text: string } {
  const url = `${c.origin}/mcp`
  const bearer = `Bearer ${token}`
  if (client === 'claude') {
    return { file: '~/.claude.json', text: JSON.stringify({ mcpServers: { [c.entry]: { type: 'http', url, headers: { Authorization: bearer } } } }, null, 2) }
  }
  if (client === 'codex') {
    return { file: '~/.codex/config.toml', text: `[mcp_servers.${c.entry}]\nurl = ${JSON.stringify(url)}\nhttp_headers = { Authorization = ${JSON.stringify(bearer)} }` }
  }
  return { file: '~/.cursor/mcp.json', text: JSON.stringify({ mcpServers: { [c.entry]: { url, headers: { Authorization: bearer } } } }, null, 2) }
}
