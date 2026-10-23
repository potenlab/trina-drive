// Remote MCP over Streamable HTTP, the minimal stateless form: POST /mcp with one JSON-RPC message, answered with
// application/json (no SSE stream, no session). Bearer tokens only (personal access tokens, and OAuth access tokens when
// the authorization server is on, src/oauth); cookies are never read here.
//
// Dual-era (MCP 2026-07-28 "Versioning and Compatibility"): a message whose _meta or MCP-Protocol-Version names a modern
// version is served statelessly by 2026-07-28 rules (server/discover, resultType, cache hints, Mcp-Method/Mcp-Name header
// checks, UnsupportedProtocolVersionError); a message with neither, or with a legacy MCP-Protocol-Version, is served by
// 2025-11-25 rules (initialize handshake, ping). subscriptions/listen is not offered: no capability advertises list
// changes, so the short cache TTL is how a client learns about new tools.
import { LEGACY_PROTOCOL_VERSIONS, LIMITS, MODERN_PROTOCOL_VERSIONS, NAME, SUPPORTED_PROTOCOL_VERSIONS, VERSION } from './config'
import { McpLimiter, type Refusal } from './ratelimit'
import type { Ctx } from './session'
import { verifyToken, type TokenRow } from './store'
import { AuditFailure, callTool, TOOL_DEFS } from './tools'
import { capabilitiesWith, clientWantsSkills, instructionsWith, NotFound as SkillNotFound, sepResourcesList, sepResourcesRead, sepSkillsGet, sepSkillsList, skillsOf, skillsToolDef } from './skills/mcp'

export interface ServerOptions {
  allowedOrigins?: string[]
  /** every authenticated JSON-RPC message (notify: connections, new-client alerts); errors are logged, never fail the request */
  onRequest?: (token: TokenRow, info: { method: string; clientName?: string; clientVersion?: string; userAgent: string | null; ip: string | null }) => void
  /** rate and concurrency limits (plan 7.1); serve() and the web server always set one */
  limiter?: McpLimiter
  /** OAuth access tokens (src/oauth): checked besides personal access tokens, and the 401 points at the RFC 9728 document */
  oauth?: McpOAuth
}

export interface McpOAuth {
  /** the grant behind an access token issued for this server's resource (RFC 8707), or why not */
  verify: (raw: string, client?: string) => { ok: true; token: TokenRow } | { ok: false; reason: 'invalid' | 'audience' }
  /** the access token prefix (anything else is tried as a personal access token) */
  prefix: string
  /** RFC 9728 protected resource metadata URL */
  resourceMetadataUrl: string
}

const INSTRUCTIONS = `Team folders, read-only. Use the bash tool (ls, cat, grep -r, rg, head, sed -n, awk …) to find and read files; ` +
  `office documents read as text. Write results to /drafts/ (markdown or csv); a person reviews and moves them.`

const SERVER_INFO = { name: NAME, version: VERSION }
const CAPABILITIES = { tools: { listChanged: false } }
/** CacheableResult hints (2026-07-28 server/utilities/caching) on server/discover and tools/list: private, because the
 * instructions and tool list are meant to carry per-person content; short, because no notification announces a change */
const CACHE_HINTS = { ttlMs: 60_000, cacheScope: 'private' } as const
// 2026-07-28 _meta keys and error codes
const META_VERSION = 'io.modelcontextprotocol/protocolVersion'
const META_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities'
const META_CLIENT = 'io.modelcontextprotocol/clientInfo'
const META_SERVER = 'io.modelcontextprotocol/serverInfo'
export const HEADER_MISMATCH = -32020
export const UNSUPPORTED_PROTOCOL_VERSION = -32022

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const rpcError = (id: unknown, code: number, message: string, status = 200, data?: unknown) =>
  json({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } }, status)
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
  const ua = req.headers.get('user-agent') ?? undefined
  let token: TokenRow | null = null
  let why = 'a valid access token is required'
  if (m && opts.oauth && m[1]!.startsWith(opts.oauth.prefix)) {
    const r = opts.oauth.verify(m[1]!, ua)
    if (r.ok) token = r.token
    else if (r.reason === 'audience') why = 'this token was issued for another resource' // RFC 8707: never accepted here
  } else if (m) token = verifyToken(ctx.db, m[1]!, ua)
  if (!token) lim?.failedAuth(addr)
  if (!token) {
    // RFC 6750 3 / RFC 9728 5.1: no error code when no credential came; resource_metadata tells an OAuth client where to start
    const params = [`realm="${NAME}"`, ...(opts.oauth ? [`resource_metadata="${opts.oauth.resourceMetadataUrl}"`] : []), ...(m || !opts.oauth ? ['error="invalid_token"'] : [])]
    return json({ error: 'invalid_token', error_description: why }, 401, { 'www-authenticate': `Bearer ${params.join(', ')}` })
  }

  if (Number(req.headers.get('content-length') ?? 0) > LIMITS.requestBytes) return json({ error: `request body is larger than ${LIMITS.requestBytes} bytes` }, 413)

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

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isIn = (list: readonly string[], v: unknown): v is string => typeof v === 'string' && list.includes(v)
const metaOf = (msg: RpcMessage) => isObject(msg.params) && isObject(msg.params._meta) ? msg.params._meta : undefined

type Era = { era: 'legacy' } | { era: 'modern'; version: string }

/** The protocol era a message speaks, or the 400 that refuses it (2026-07-28 basic/versioning, Streamable HTTP "Protocol
 * Version Header"). No version anywhere, or a legacy MCP-Protocol-Version without a _meta version, is legacy (initialize,
 * and every later request of a 2025-11-25 client). Anything else must be a supported modern version, named the same in
 * the header and in _meta. */
function eraOf(msg: RpcMessage, req: Request): Era | Response {
  const header = req.headers.get('mcp-protocol-version') || null // an empty header counts as none
  const body = metaOf(msg)?.[META_VERSION]
  const id = msg.id
  if (body === undefined && msg.method !== 'server/discover' && (header === null || isIn(LEGACY_PROTOCOL_VERSIONS, header))) return { era: 'legacy' }
  if (header !== null && body !== undefined && header !== body) return rpcError(id, HEADER_MISMATCH, 'header mismatch: MCP-Protocol-Version does not match the protocol version in _meta', 400)
  const asked = body ?? header
  if (asked !== null && !isIn(MODERN_PROTOCOL_VERSIONS, asked)) {
    return rpcError(id, UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', 400,
      { supported: [...SUPPORTED_PROTOCOL_VERSIONS], requested: typeof asked === 'string' ? asked.slice(0, 64) : JSON.stringify(asked).slice(0, 64) })
  }
  // 2026-07-28 defines no client notifications over HTTP and no header rules for them: a supported version is enough
  if (id === undefined || id === null) return body === undefined ? { era: 'legacy' } : { era: 'modern', version: String(body) }
  if (body === undefined) return rpcError(id, -32602, `invalid params: _meta["${META_VERSION}"] is required`, 400)
  if (header === null) return rpcError(id, HEADER_MISMATCH, 'header mismatch: the MCP-Protocol-Version header is required', 400)
  return { era: 'modern', version: body as string }
}

/** Header value as sent, or decoded from the =?base64?…?= form; undefined when it is not a valid header value */
function headerValue(v: string): string | undefined {
  if (!/^[\t\x20-\x7e]*$/.test(v)) return undefined
  const m = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/.exec(v)
  if (!m) return v
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(m[1]!), (c) => c.charCodeAt(0))) } catch { return undefined }
}

/** 2026-07-28 per-request checks on a modern request: client capabilities declared, Mcp-Method (and for tools/call
 * Mcp-Name) present and equal to the body, so nothing routing on the headers sees a different request than this server */
function modernRequestError(msg: RpcMessage, params: Record<string, unknown>, req: Request): Response | undefined {
  const meta = metaOf(msg)!
  if (!isObject(meta[META_CAPABILITIES])) return rpcError(msg.id, -32602, `invalid params: _meta["${META_CAPABILITIES}"] is required`, 400)
  const method = req.headers.get('mcp-method')
  if (method === null) return rpcError(msg.id, HEADER_MISMATCH, 'header mismatch: the Mcp-Method header is required', 400)
  if (method !== msg.method) return rpcError(msg.id, HEADER_MISMATCH, 'header mismatch: Mcp-Method does not match the method', 400)
  if (msg.method === 'tools/call') {
    const name = req.headers.get('mcp-name')
    if (name === null) return rpcError(msg.id, HEADER_MISMATCH, 'header mismatch: the Mcp-Name header is required for tools/call', 400)
    if (headerValue(name) !== params.name) return rpcError(msg.id, HEADER_MISMATCH, 'header mismatch: Mcp-Name does not match params.name', 400)
  }
  return undefined
}

async function dispatch(ctx: Ctx, token: TokenRow, msg: RpcMessage, req: Request, opts: ServerOptions, ip?: string): Promise<Response> {
  const era = eraOf(msg, req)
  if (era instanceof Response) return era
  const modern = era.era === 'modern'
  if (opts.onRequest) {
    // legacy clients name themselves once, in initialize; modern ones on every request
    const ci = (modern ? metaOf(msg)?.[META_CLIENT] : msg.method === 'initialize' && isObject(msg.params) ? msg.params.clientInfo : undefined) ?? {}
    try {
      const { name, version } = isObject(ci) ? ci : {}
      opts.onRequest(token, { method: msg.method ?? "", clientName: typeof name === 'string' ? name.slice(0, 128) : undefined,
        clientVersion: typeof version === 'string' ? version.slice(0, 64) : undefined, userAgent: req.headers.get('user-agent'), ip: ip ?? null })
    } catch (e) { console.error(`[${NAME}] onRequest failed:`, e) }
  }
  if (msg.id === undefined || msg.id === null) return new Response(null, { status: 202 }) // notification
  if (msg.params !== undefined && (msg.params === null || typeof msg.params !== 'object' || Array.isArray(msg.params))) return rpcError(msg.id, -32602, 'params must be an object')

  const { id, method, params = {} } = msg
  if (modern) {
    const bad = modernRequestError(msg, params, req)
    if (bad) return bad
  }
  /** a result in the era's shape: modern results carry resultType and serverInfo, and cache hints where the spec asks */
  const ok = (result: Record<string, unknown>, cacheable = false) => json({ jsonrpc: '2.0', id, result: !modern ? result
    : { resultType: 'complete', ...result, ...(cacheable ? CACHE_HINTS : {}), _meta: { ...(isObject(result._meta) ? result._meta : {}), [META_SERVER]: SERVER_INFO } } })
  // a method this era does not have (initialize and ping are gone in 2026-07-28; Streamable HTTP wants a 404 for those)
  const notFound = () => rpcError(id, -32601, `method not found: ${method}`, modern ? 404 : 200)
  // team skills (src/skills): the catalog this token may read, from approved snapshots only
  const skills = () => skillsOf(ctx, token)
  const tools = () => [...TOOL_DEFS, ...skillsToolDef(skills())]
  // SEP-2640 is offered to a client that declares it (initialize capabilities, or a modern request's _meta)
  const wantsSkills = clientWantsSkills(modern ? metaOf(msg)?.[META_CAPABILITIES] : isObject(params.capabilities) ? params.capabilities : undefined)
  // a modern request says on every call what the client speaks; a legacy one only said it in initialize (not kept)
  const sep = (f: () => Record<string, unknown>, cacheable = false) => {
    if (modern && !wantsSkills) return notFound()
    try { return ok(f(), cacheable) } catch (e) {
      if (e instanceof SkillNotFound) return rpcError(id, -32602, e.message)
      throw e
    }
  }
  switch (method) {
    case 'server/discover':
      return ok({ supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS], capabilities: capabilitiesWith(CAPABILITIES, wantsSkills), instructions: instructionsWith(INSTRUCTIONS, skills()) }, true)
    case 'initialize': {
      if (modern) return notFound()
      // the handshake only exists up to 2025-11-25: never answer it with a modern version
      const asked = params.protocolVersion
      const protocolVersion = isIn(LEGACY_PROTOCOL_VERSIONS, asked) ? asked : LEGACY_PROTOCOL_VERSIONS[0]
      return ok({ protocolVersion, capabilities: capabilitiesWith(CAPABILITIES, wantsSkills), serverInfo: SERVER_INFO, instructions: instructionsWith(INSTRUCTIONS, skills()) })
    }
    case 'ping': return modern ? notFound() : ok({})
    case 'tools/list': return ok({ tools: tools() }, true)
    // SEP-2640 Skills Extension (minimal): listing, one entry, and the approved files as skill:// resources
    case 'skills/list': return sep(() => sepSkillsList(ctx, token), true)
    case 'skills/get': return sep(() => sepSkillsGet(ctx, token, params))
    case 'resources/list': return sep(() => sepResourcesList(ctx, token), true)
    case 'resources/templates/list': return sep(() => ({ resourceTemplates: [] }), true)
    case 'resources/read': return sep(() => sepResourcesRead(ctx, token, params))
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : ''
      if (!tools().some((t) => t.name === name)) return rpcError(id, -32602, `unknown tool: ${name}`)
      const args = (params.arguments ?? {}) as Record<string, unknown>
      try {
        return ok({ ...await callTool(ctx, token, name, args) })
      } catch (e) {
        if (e instanceof AuditFailure) return rpcError(id, -32603, e.message)
        console.error(`[${NAME}] tool ${name} failed:`, e)
        return rpcError(id, -32603, 'internal error')
      }
    }
    default: return notFound()
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
