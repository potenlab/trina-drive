// Remote MCP over Streamable HTTP, the minimal stateless form: POST /mcp with one JSON-RPC message, answered with
// application/json (no SSE stream, no session). Bearer personal access tokens only; cookies are never read here.
import { LATEST_PROTOCOL_VERSION, LIMITS, NAME, SUPPORTED_PROTOCOL_VERSIONS, VERSION } from './config'
import type { Ctx } from './session'
import { verifyToken, type TokenRow } from './store'
import { AuditFailure, callTool, TOOL_DEFS } from './tools'

export interface ServerOptions { allowedOrigins?: string[] }

const INSTRUCTIONS = `Team folders, read-only. Use the bash tool (ls, cat, grep -r, rg, head, sed -n, awk …) to find and read files; ` +
  `office documents read as text. Write results to /drafts/ (markdown or csv); a person reviews and moves them.`

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const rpcError = (id: unknown, code: number, message: string, status = 200) => json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }, status)

function originAllowed(origin: string | null, allowed: string[]): boolean {
  if (!origin) return true // non-browser clients send no Origin
  if (allowed.includes(origin)) return true
  try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname) } catch { return false }
}

export async function handleRequest(ctx: Ctx, req: Request, opts: ServerOptions = {}): Promise<Response> {
  const url = new URL(req.url)
  if (url.pathname === '/health') return json({ ok: true, name: NAME, version: VERSION })
  if (url.pathname !== '/mcp') return json({ error: 'not found' }, 404)
  // DNS-rebinding guard: a browser page on another site must not reach a LAN server
  if (!originAllowed(req.headers.get('origin'), opts.allowedOrigins ?? [])) return json({ error: 'origin not allowed' }, 403)
  if (req.method !== 'POST') return json({ error: 'use POST (this server does not open SSE streams)' }, 405, { allow: 'POST' })

  const auth = req.headers.get('authorization') ?? ''
  const m = /^Bearer\s+(\S+)$/i.exec(auth)
  const token: TokenRow | null = m ? verifyToken(ctx.db, m[1]!, req.headers.get('user-agent') ?? undefined) : null
  if (!token) return json({ error: 'invalid_token', error_description: 'a valid personal access token is required' }, 401, { 'www-authenticate': `Bearer realm="${NAME}", error="invalid_token"` })

  if (Number(req.headers.get('content-length') ?? 0) > LIMITS.requestBytes) return json({ error: `request body is larger than ${LIMITS.requestBytes} bytes` }, 413)

  const pv = req.headers.get('mcp-protocol-version')
  if (pv && !(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(pv)) return rpcError(null, -32600, `unsupported MCP-Protocol-Version ${pv}`, 400)
  // the media type itself, not a substring ("text/plain; x=application/json" is a CORS-simple type)
  if ((req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase() !== 'application/json') return json({ error: 'content-type must be application/json' }, 415)

  let msg: { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }
  try { msg = (await req.json()) as typeof msg } catch { return rpcError(null, -32700, 'parse error', 400) }
  if (Array.isArray(msg)) return rpcError(null, -32600, 'batched messages are not supported', 400)
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    // a response or something else from the client: nothing to answer
    return msg && msg.jsonrpc === '2.0' && !('method' in msg) ? new Response(null, { status: 202 }) : rpcError(msg?.id, -32600, 'invalid request', 400)
  }
  if (msg.id === undefined || msg.id === null) return new Response(null, { status: 202 }) // notification
  if (msg.params !== undefined && (msg.params === null || typeof msg.params !== 'object' || Array.isArray(msg.params))) return rpcError(msg.id, -32602, 'params must be an object')

  const { id, method, params = {} } = msg
  switch (method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
      const protocolVersion = (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : LATEST_PROTOCOL_VERSION
      return json({ jsonrpc: '2.0', id, result: { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: NAME, version: VERSION }, instructions: INSTRUCTIONS } })
    }
    case 'ping': return json({ jsonrpc: '2.0', id, result: {} })
    case 'tools/list': return json({ jsonrpc: '2.0', id, result: { tools: TOOL_DEFS } })
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : ''
      if (!TOOL_DEFS.some((t) => t.name === name)) return rpcError(id, -32602, `unknown tool: ${name}`)
      const args = (params.arguments ?? {}) as Record<string, unknown>
      try {
        return json({ jsonrpc: '2.0', id, result: await callTool(ctx, token, name, args) })
      } catch (e) {
        if (e instanceof AuditFailure) return rpcError(id, -32603, e.message)
        console.error(`[${NAME}] tool ${name} failed:`, e)
        return rpcError(id, -32603, 'internal error')
      }
    }
    default: return rpcError(id, -32601, `method not found: ${method}`)
  }
}

export function serve(ctx: Ctx, port: number, hostname = '127.0.0.1', opts: ServerOptions = {}) {
  return Bun.serve({
    port, hostname,
    // never Bun's development error page (it shows source and stack traces to the caller)
    development: false,
    // bodies without a Content-Length are cut here too
    maxRequestBodySize: LIMITS.requestBytes,
    fetch: async (req) => {
      try { return await handleRequest(ctx, req, opts) } catch (e) {
        console.error(`[${NAME}] request failed:`, e)
        return rpcError(null, -32603, 'internal error', 500)
      }
    },
  })
}
