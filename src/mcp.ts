// Remote MCP over Streamable HTTP, the minimal stateless form: POST /mcp with one JSON-RPC message, answered with
// application/json (no SSE stream, no session). Bearer personal access tokens only; cookies are never read here.
import { LATEST_PROTOCOL_VERSION, LIMITS, NAME, SUPPORTED_PROTOCOL_VERSIONS, VERSION } from './config'
import { McpLimiter, type Refusal } from './ratelimit'
import type { Ctx } from './session'
import { verifyToken, type TokenRow } from './store'
import { AuditFailure, callTool, TOOL_DEFS } from './tools'

export interface ServerOptions {
  allowedOrigins?: string[]
  /** every authenticated JSON-RPC message (notify: connections, new-client alerts); errors are logged, never fail the request */
  onRequest?: (token: TokenRow, info: { method: string; clientName?: string; clientVersion?: string; userAgent: string | null; ip: string | null }) => void
  /** rate and concurrency limits (plan 7.1); serve() and the web server always set one */
  limiter?: McpLimiter
}

const INSTRUCTIONS = `Team folders, read-only. Use the bash tool (ls, cat, grep -r, rg, head, sed -n, awk …) to find and read files; ` +
  `office documents read as text. Write results to /drafts/ (markdown or csv); a person reviews and moves them.`

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const rpcError = (id: unknown, code: number, message: string, status = 200) => json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }, status)
/** 429 + Retry-After, with a JSON-RPC error body (implementation-defined server error code) */
export const RATE_LIMIT_CODE = -32029
const tooMany = (id: unknown, r: Refusal) => json({ jsonrpc: '2.0', id: id ?? null, error: { code: RATE_LIMIT_CODE, message: `rate limit: ${r.reason}; retry after ${r.retryAfter} s`, data: { retry_after: r.retryAfter } } },
  429, { 'retry-after': String(r.retryAfter) })

function originAllowed(origin: string | null, allowed: string[]): boolean {
  if (!origin) return true // non-browser clients send no Origin
  if (allowed.includes(origin)) return true
  try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname) } catch { return false }
}

export async function handleRequest(ctx: Ctx, req: Request, opts: ServerOptions = {}, ip?: string): Promise<Response> {
  const url = new URL(req.url)
  if (url.pathname === '/health') return json({ ok: true, name: NAME, version: VERSION })
  if (url.pathname !== '/mcp') return json({ error: 'not found' }, 404)
  // DNS-rebinding guard: a browser page on another site must not reach a LAN server
  if (!originAllowed(req.headers.get('origin'), opts.allowedOrigins ?? [])) return json({ error: 'origin not allowed' }, 403)
  if (req.method !== 'POST') return json({ error: 'use POST (this server does not open SSE streams)' }, 405, { allow: 'POST' })

  const lim = opts.limiter, addr = ip ?? 'unknown'
  const byAddr = lim?.checkAddress(addr)
  if (byAddr) return tooMany(null, byAddr)

  const auth = req.headers.get('authorization') ?? ''
  const m = /^Bearer\s+(\S+)$/i.exec(auth)
  const token: TokenRow | null = m ? verifyToken(ctx.db, m[1]!, req.headers.get('user-agent') ?? undefined) : null
  if (!token) lim?.failedAuth(addr)
  if (!token) return json({ error: 'invalid_token', error_description: 'a valid personal access token is required' }, 401, { 'www-authenticate': `Bearer realm="${NAME}", error="invalid_token"` })

  if (Number(req.headers.get('content-length') ?? 0) > LIMITS.requestBytes) return json({ error: `request body is larger than ${LIMITS.requestBytes} bytes` }, 413)

  const pv = req.headers.get('mcp-protocol-version')
  if (pv && !(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(pv)) return rpcError(null, -32600, `unsupported MCP-Protocol-Version ${pv}`, 400)
  // the media type itself, not a substring ("text/plain; x=application/json" is a CORS-simple type)
  if ((req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase() !== 'application/json') return json({ error: 'content-type must be application/json' }, 415)

  let msg: RpcMessage
  try { msg = (await req.json()) as typeof msg } catch { return rpcError(null, -32700, 'parse error', 400) }
  if (Array.isArray(msg)) return rpcError(null, -32600, 'batched messages are not supported', 400)
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    // a response or something else from the client: nothing to answer
    return msg && msg.jsonrpc === '2.0' && !('method' in msg) ? new Response(null, { status: 202 }) : rpcError(msg?.id, -32600, 'invalid request', 400)
  }
  if (lim) {
    const r = lim.checkToken(token.id)
    if (r) return tooMany(msg.id, r)
    const slot = lim.acquire(token.id, addr)
    if (typeof slot !== 'function') return tooMany(msg.id, slot)
    try { return await dispatch(ctx, token, msg, req, opts, ip) } finally { slot() }
  }
  return dispatch(ctx, token, msg, req, opts, ip)
}

type RpcMessage = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }

async function dispatch(ctx: Ctx, token: TokenRow, msg: RpcMessage, req: Request, opts: ServerOptions, ip?: string): Promise<Response> {
  if (opts.onRequest) {
    const ci = msg.method === 'initialize' ? (msg.params?.clientInfo ?? {}) as { name?: unknown; version?: unknown } : {}
    try {
      opts.onRequest(token, { method: msg.method ?? "", clientName: typeof ci.name === 'string' ? ci.name.slice(0, 128) : undefined,
        clientVersion: typeof ci.version === 'string' ? ci.version.slice(0, 64) : undefined, userAgent: req.headers.get('user-agent'), ip: ip ?? null })
    } catch (e) { console.error(`[${NAME}] onRequest failed:`, e) }
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
  const limited: ServerOptions = { ...opts, limiter: opts.limiter ?? new McpLimiter() }
  return Bun.serve({
    port, hostname,
    // never Bun's development error page (it shows source and stack traces to the caller)
    development: false,
    // bodies without a Content-Length are cut here too
    maxRequestBodySize: LIMITS.requestBytes,
    fetch: async (req, srv) => {
      try { return await handleRequest(ctx, req, limited, srv.requestIP(req)?.address) } catch (e) {
        console.error(`[${NAME}] request failed:`, e)
        return rpcError(null, -32603, 'internal error', 500)
      }
    },
  })
}
