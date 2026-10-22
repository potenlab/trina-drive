// HTTP side of the authorization server (MCP authorization, 2025-11-25 and 2026-07-28):
//   GET  /.well-known/oauth-protected-resource[/mcp]   RFC 9728 (the 401 on /mcp points here)
//   GET  /.well-known/oauth-authorization-server        RFC 8414
//   GET  /oauth/authorize    checks client (CIMD / DCR), redirect URI, PKCE S256, resource; parks the request and sends
//                            the browser to the consent page of the web app (#/oauth/<id>), which needs a signed-in person
//   POST /oauth/token        authorization_code (+ PKCE) and refresh_token (rotation, reuse detection); form-urlencoded
//   POST /oauth/revoke       RFC 7009
//   POST /oauth/register     RFC 7591, only when enabled (public enable --allow-dcr)
// The consent decision itself is /api/oauth/* (consent.ts): it needs the web session and its CSRF token.
import crypto from 'node:crypto'
import { NAME } from '../config'
import type { DB } from '../db'
import { sha256 } from '../store'
import { canonicalUrl, REQUEST_TTL_MS, SCOPES, type OAuthRuntime } from './config'
import { OAuthError, redirectMatches, registerClient, resolveClient } from './clients'
import { exchangeCode, refreshTokens, revokeOAuthToken } from './tokens'

const NO_STORE = { 'cache-control': 'no-store', pragma: 'no-cache' }
/** Metadata and the token, revoke and register endpoints carry no ambient credential: any origin may call them. */
const OPEN_CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, authorization, mcp-protocol-version', 'cross-origin-resource-policy': 'cross-origin' }
const jsonRes = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const oauthErr = (e: OAuthError) => jsonRes({ error: e.code, error_description: e.message }, e.code === 'invalid_client' ? 401 : e.status, { ...NO_STORE, ...OPEN_CORS })

export function asMetadataPath(rt: OAuthRuntime) {
  const p = new URL(rt.issuer).pathname
  return `/.well-known/oauth-authorization-server${p === '/' ? '' : p}`
}

export const protectedResourceMetadata = (rt: OAuthRuntime) => ({
  resource: rt.resource, authorization_servers: [rt.issuer], bearer_methods_supported: ['header'],
  scopes_supported: [...SCOPES], resource_name: NAME,
})

export const authorizationServerMetadata = (rt: OAuthRuntime) => ({
  issuer: rt.issuer,
  authorization_endpoint: `${rt.issuer}/oauth/authorize`,
  token_endpoint: `${rt.issuer}/oauth/token`,
  revocation_endpoint: `${rt.issuer}/oauth/revoke`,
  ...(rt.dcr ? { registration_endpoint: `${rt.issuer}/oauth/register` } : {}),
  response_types_supported: ['code'],
  response_modes_supported: ['query'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  // public clients only (CIMD and DCR register Claude and ChatGPT as public clients); Claude picks CIMD only when "none" is here
  token_endpoint_auth_methods_supported: ['none'],
  revocation_endpoint_auth_methods_supported: ['none'],
  scopes_supported: [...SCOPES, 'offline_access'],
  client_id_metadata_document_supported: true,
  authorization_response_iss_parameter_supported: true,
})

export const isOAuthPath = (p: string) => p.startsWith('/oauth/') || p.startsWith('/.well-known/')

function page(status: number, title: string, text: string): Response {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title>` +
    `<body style="font:16px system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem"><h1 style="font-size:1.3rem">${esc(title)}</h1><p>${esc(text)}</p>` +
    `<p style="color:#666">연결을 시작한 AI 앱으로 돌아가 다시 시도하거나 관리자에게 문의하세요. Go back to the AI app that started this and try again, or ask your admin.</p></body>`,
  { status, headers: { 'content-type': 'text/html; charset=utf-8', ...NO_STORE } })
}

/** Back to the client with the result (RFC 6749 4.1.2) and iss (RFC 9207). */
export function clientRedirect(rt: OAuthRuntime, redirectUri: string, params: Record<string, string | null | undefined>): string {
  const u = new URL(redirectUri)
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v)
  u.searchParams.set('iss', rt.issuer)
  return u.toString()
}
const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to, ...NO_STORE } })

export async function handleOAuth(rt: OAuthRuntime, db: DB, req: Request, addr: string): Promise<Response> {
  const url = new URL(req.url)
  const p = url.pathname
  if (req.method === 'OPTIONS' && (p.startsWith('/.well-known/') || ['/oauth/token', '/oauth/revoke', '/oauth/register'].includes(p))) return new Response(null, { status: 204, headers: OPEN_CORS })
  const get = req.method === 'GET' || req.method === 'HEAD'
  const resPath = new URL(rt.prmUrl).pathname
  if (get && (p === resPath || p === '/.well-known/oauth-protected-resource')) return jsonRes(protectedResourceMetadata(rt), 200, { ...OPEN_CORS, 'cache-control': 'max-age=300' })
  if (get && p === asMetadataPath(rt)) return jsonRes(authorizationServerMetadata(rt), 200, { ...OPEN_CORS, 'cache-control': 'max-age=300' })
  try {
    if (p === '/oauth/authorize' && get) return await authorize(rt, db, url, addr)
    if (p === '/oauth/token' && req.method === 'POST') return await token(rt, db, req, addr)
    if (p === '/oauth/revoke' && req.method === 'POST') { const f = await form(req); revokeOAuthToken(rt, db, f.get('token'), f.get('client_id') ?? undefined); return new Response(null, { status: 200, headers: { ...NO_STORE, ...OPEN_CORS } }) }
    if (p === '/oauth/register' && req.method === 'POST' && rt.dcr) return await register(rt, db, req, addr)
  } catch (e) {
    if (e instanceof OAuthError) return oauthErr(e)
    throw e
  }
  return jsonRes({ error: 'not_found' }, 404)
}

const FORM_MAX = 16 * 1024
async function form(req: Request): Promise<URLSearchParams> {
  const ct = (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (ct !== 'application/x-www-form-urlencoded') throw new OAuthError('invalid_request', 'send application/x-www-form-urlencoded')
  if (Number(req.headers.get('content-length') ?? 0) > FORM_MAX) throw new OAuthError('invalid_request', 'request too large')
  const text = await req.text()
  if (text.length > FORM_MAX) throw new OAuthError('invalid_request', 'request too large')
  const f = new URLSearchParams(text)
  for (const k of new Set(f.keys())) if (f.getAll(k).length > 1) throw new OAuthError('invalid_request', `${k} is given more than once`)
  return f
}
const opt = (f: URLSearchParams, k: string) => f.get(k) ?? undefined

async function token(rt: OAuthRuntime, db: DB, req: Request, addr: string): Promise<Response> {
  if (!rt.limits.token.hit(addr)) throw new OAuthError('slow_down', 'too many token requests from this address', 429)
  const f = await form(req)
  if (f.has('client_secret') || f.has('client_assertion') || req.headers.has('authorization')) {
    // every client here is public (token_endpoint_auth_method "none"); a secret means a confused client
    throw new OAuthError('invalid_client', 'this server registers public clients only (no client secret)')
  }
  const g = f.get('grant_type')
  const out = g === 'authorization_code'
    ? exchangeCode(rt, db, { code: f.get('code'), clientId: opt(f, 'client_id'), redirectUri: opt(f, 'redirect_uri'), verifier: f.get('code_verifier'), resource: opt(f, 'resource') })
    : g === 'refresh_token'
      ? refreshTokens(rt, db, { refreshToken: f.get('refresh_token'), clientId: opt(f, 'client_id'), resource: opt(f, 'resource'), scope: opt(f, 'scope') })
      : (() => { throw new OAuthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token') })()
  return jsonRes(out, 200, { ...NO_STORE, ...OPEN_CORS })
}

async function register(rt: OAuthRuntime, db: DB, req: Request, addr: string): Promise<Response> {
  if (!rt.limits.register.hit(addr)) throw new OAuthError('slow_down', 'too many registrations from this address', 429)
  if ((req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase() !== 'application/json') throw new OAuthError('invalid_client_metadata', 'send application/json')
  const text = await req.text()
  if (text.length > FORM_MAX) throw new OAuthError('invalid_client_metadata', 'request too large')
  let body: unknown
  try { body = JSON.parse(text) } catch { throw new OAuthError('invalid_client_metadata', 'not JSON') }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new OAuthError('invalid_client_metadata', 'not a JSON object')
  return jsonRes(registerClient(rt, db, body as Record<string, unknown>, addr), 201, { ...NO_STORE, ...OPEN_CORS })
}

/** The scopes a request asked for, as this server understands them (unknown ones are ignored; none → files:read). */
export function requestedScopes(raw: string | null): string[] {
  if (raw === null) return [...SCOPES]
  const asked = raw.trim().split(/\s+/)
  const known = SCOPES.filter((s) => asked.includes(s))
  return known.length ? known : ['files:read']
}

async function authorize(rt: OAuthRuntime, db: DB, url: URL, addr: string): Promise<Response> {
  if (!rt.limits.authorize.hit(addr)) return page(429, 'Too many requests / 요청이 너무 많습니다', 'Wait a minute and try again.')
  const q = url.searchParams
  for (const k of new Set(q.keys())) if (k !== 'resource' && q.getAll(k).length > 1) return page(400, 'Bad request / 잘못된 요청', `${k} is given more than once.`)
  // client and redirect URI first: until both check out, nothing is sent back to the redirect URI (RFC 6749 4.1.2.1)
  let client
  try { client = await resolveClient(rt, db, q.get('client_id')) } catch (e) {
    if (e instanceof OAuthError) return page(e.status === 429 ? 429 : 400, 'This app cannot connect / 이 앱은 연결할 수 없습니다', e.message)
    throw e
  }
  const asked = q.get('redirect_uri')
  const redirectUri = asked ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0]! : null)
  if (!redirectUri || !redirectMatches(client.redirect_uris, redirectUri)) return page(400, 'This app cannot connect / 이 앱은 연결할 수 없습니다', 'The redirect address is not one the app registered.')
  const state = q.get('state')
  const back = (error: string, description: string) => redirect(clientRedirect(rt, redirectUri, { error, error_description: description, state }))
  if (state !== null && state.length > 1024) return back('invalid_request', 'state is too long')
  if (q.get('response_type') !== 'code') return back('unsupported_response_type', 'response_type must be code')
  const challenge = q.get('code_challenge')
  if (q.get('code_challenge_method') !== 'S256' || !challenge) return back('invalid_request', 'PKCE with code_challenge_method=S256 is required')
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) return back('invalid_request', 'code_challenge must be a base64url SHA-256 (43 characters)')
  // RFC 8707: tokens are only for this server's MCP endpoint
  const resources = q.getAll('resource')
  if (resources.length > 1) return back('invalid_target', 'only one resource is served here')
  const resource = resources.length ? canonicalUrl(resources[0]!) : rt.resource
  if (resource !== rt.resource) return back('invalid_target', `this server issues tokens only for ${rt.resource}`)
  const scope = requestedScopes(q.get('scope')).join(' ')
  const rid = crypto.randomBytes(24).toString('base64url'), t = rt.now()
  db.query('DELETE FROM oauth_requests WHERE expires_at < ?').run(t - 86400_000)
  db.query('INSERT INTO oauth_requests (id_hash, client_id, redirect_uri, state, code_challenge, resource, scope, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(sha256(rid), client.client_id, redirectUri, state, challenge, resource, scope, t, t + REQUEST_TTL_MS)
  // the id travels in the #fragment: it never reaches a log or a Referer
  return redirect(`${rt.issuer}/#/oauth/${rid}`)
}
