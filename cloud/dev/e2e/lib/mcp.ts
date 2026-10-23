// MCP through the official TypeScript SDK clients (the same ones the product's unit tests use): v2
// (@modelcontextprotocol/client, both protocol eras) and v1 (@modelcontextprotocol/sdk, 2025-11-25). Over HTTPS through
// Caddy with a person's token, exactly as Claude Code / Codex / Cursor connect.
import { Client as ClientV2, StreamableHTTPClientTransport as TransportV2, type ClientOptions } from '@modelcontextprotocol/client'
import { Client as ClientV1 } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport as TransportV1 } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Target } from './target'

const fetchFor = (t: Target) => ((url: string | URL | Request, init?: RequestInit) => fetch(url, { ...init, tls: t.tls } as RequestInit)) as typeof fetch

export type Negotiation = ClientOptions['versionNegotiation']

export async function sdkV2(t: Target, slug: string, token: string, versionNegotiation?: Negotiation): Promise<ClientV2> {
  const client = new ClientV2({ name: 'trina-e2e-sdk-v2', version: '2.3.1' }, versionNegotiation ? { versionNegotiation } : undefined)
  await client.connect(new TransportV2(new URL(`${t.teamUrl(slug)}/mcp`), { fetch: fetchFor(t), requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  return client
}

export async function sdkV1(t: Target, slug: string, token: string): Promise<ClientV1> {
  const client = new ClientV1({ name: 'trina-e2e-sdk-v1', version: '1.32.1' })
  await client.connect(new TransportV1(new URL(`${t.teamUrl(slug)}/mcp`), { fetch: fetchFor(t), requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  return client
}

/** bash through an SDK client: stdout (the text content) */
export async function sdkBash(c: ClientV1 | ClientV2, command: string): Promise<{ text: string; isError: boolean; structured: any }> {
  const r = await (c as ClientV1).callTool({ name: 'bash', arguments: { command } })
  return { text: ((r.content ?? []) as { text?: string }[]).map((x) => x.text ?? '').join('\n'), isError: !!r.isError, structured: r.structuredContent }
}
