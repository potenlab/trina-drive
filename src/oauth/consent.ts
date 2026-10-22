// The consent decision, under /api/oauth/* (the web session cookie is scoped to /api): a signed-in person sees which
// app asks (its name, the domain its metadata document was fetched from — the thing that cannot be faked by a name —
// and where the answer goes), picks folders, read-only (the default) and an expiry, and approves or denies. Every
// state change needs the session's CSRF token and a same-origin Origin, like the rest of /api.
//   GET  /api/oauth/requests/:id           what the page shows
//   POST /api/oauth/requests/:id/approve   { folders: number[] | all: true, read_only, ttl } -> { redirect_to }
//   POST /api/oauth/requests/:id/deny      -> { redirect_to }
// TODO(passkeys): a step-up (passkey) before approving belongs here once the web has it (other stream).
import { appendAudit } from '../audit'
import { PRODUCT } from '../config'
import { sha256 } from '../store'
import { originOk, readCookie } from '../web/api'
import { csrfOk, lookupSession, SESSION_COOKIE } from '../web/auth'
import type { WebCtx } from '../web/http'
import { foldersView } from '../web/views'
import { GRANT_TTLS, type GrantTtl, type OAuthRuntime } from './config'
import { isLoopbackRedirect, OAuthError, redirectMatches, resolveClient } from './clients'
import { clientRedirect } from './http'
import { issueCode } from './tokens'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const fail = (status: number, error: string, message = error) => json({ error, message }, status)

interface ReqRow { id_hash: string; client_id: string; redirect_uri: string; state: string | null; code_challenge: string; resource: string; scope: string; expires_at: number; decided_at: number | null }

/** The folders this person's AI may read (the same list the My tokens page offers). */
const offerable = (w: WebCtx, personId: number, admin: boolean) =>
  foldersView(w, { personId, admin }).filter((f) => f.mine.ai).map((f) => ({ id: f.id, vpath: f.vpath }))

export async function handleConsentApi(w: WebCtx, rt: OAuthRuntime | null, req: Request): Promise<Response> {
  const url = new URL(req.url)
  const m = /^\/api\/oauth\/requests\/([A-Za-z0-9_-]{20,64})(?:\/(approve|deny))?$/.exec(url.pathname)
  if (!rt || !m) return fail(404, 'not_found', 'not found')
  const action = m[2]
  if ((action && req.method !== 'POST') || (!action && req.method !== 'GET')) return fail(405, 'method_not_allowed')
  if (action && !originOk(req, w.opts.allowedOrigins)) return fail(403, 'bad_origin', 'cross-site request refused')
  const s = lookupSession(w.db, readCookie(req, SESSION_COOKIE))
  if (!s) return fail(401, 'signed_out', 'sign in first')
  if (action && !csrfOk(s, req.headers.get('x-csrf-token'))) return fail(403, 'bad_csrf', 'missing or wrong CSRF token; reload the page')

  const r = w.db.query<ReqRow, [string]>('SELECT * FROM oauth_requests WHERE id_hash = ?').get(sha256(m[1]!))
  if (!r || r.decided_at != null || r.expires_at <= rt.now()) return fail(404, 'request_gone', 'this connection request is used or expired; start again from the AI app')
  let client
  try { client = await resolveClient(rt, w.db, r.client_id) } catch (e) { if (e instanceof OAuthError) return fail(400, e.code, e.message); throw e }
  if (!redirectMatches(client.redirect_uris, r.redirect_uri)) return fail(400, 'invalid_client', 'the app no longer lists this redirect address')
  const scopes = r.scope.split(' ')
  const canWrite = scopes.includes('drafts:write')
  const folders = offerable(w, s.personId, s.admin)
  const redirectHost = new URL(r.redirect_uri).host

  if (!action) {
    return json({
      client: { name: client.name, domain: client.domain, client_id: client.client_id, kind: client.kind, verified: client.verified,
        redirect_host: redirectHost, loopback: isLoopbackRedirect(r.redirect_uri), loopback_only: client.redirect_uris.every(isLoopbackRedirect) },
      server: PRODUCT, resource: r.resource, scopes, can_write: canWrite, admin: s.admin, folders,
      ttl_options: Object.keys(GRANT_TTLS), default_ttl: '30d', expires_at: r.expires_at,
    })
  }

  let body: Record<string, unknown> = {}
  if (action === 'approve') {
    if ((req.headers.get('content-type') ?? '').split(';')[0]!.trim() !== 'application/json') return fail(415, 'json_only', 'send application/json')
    const text = await req.text()
    if (text.length > 16 * 1024) return fail(413, 'too_large')
    try { body = JSON.parse(text || '{}') } catch { return fail(400, 'bad_json') }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'bad_json')
  }
  // one decision per request, even with two clicks racing
  if (w.db.query('UPDATE oauth_requests SET decided_at = ? WHERE id_hash = ? AND decided_at IS NULL').run(rt.now(), r.id_hash).changes !== 1) return fail(404, 'request_gone', 'this connection request is used or expired')

  if (action === 'deny') {
    appendAudit(w.db, { personId: s.personId, tokenId: null, tool: 'web', command: `oauth deny ${client.domain} (${client.name})`, files: [], outcome: 'ok' })
    return json({ redirect_to: clientRedirect(rt, r.redirect_uri, { error: 'access_denied', error_description: 'the person declined', state: r.state }) })
  }

  const undo = () => w.db.query('UPDATE oauth_requests SET decided_at = NULL WHERE id_hash = ?').run(r.id_hash)
  // folders: chosen ones the person's AI may read; "all" (everything the person reads, now and later) only for non-admins (plan 5.1, review 2.3)
  let scopeFolders: number[] | null
  if (body.all === true) {
    if (s.admin) { undo(); return fail(400, 'pick_folders', 'admins pick the folders a connection may read') }
    scopeFolders = null
  } else {
    const ids = Array.isArray(body.folders) ? body.folders : []
    const allowed = new Set(folders.map((f) => f.id))
    if (!ids.length || ids.length > 500 || !ids.every((x) => typeof x === 'number' && allowed.has(x))) { undo(); return fail(400, 'pick_folders', 'pick at least one folder you can read') }
    scopeFolders = [...new Set(ids as number[])]
  }
  const readOnly = body.read_only !== false || !canWrite
  const ttl = (typeof body.ttl === 'string' && body.ttl in GRANT_TTLS ? body.ttl : '30d') as GrantTtl
  const code = issueCode(rt, w.db, {
    client, redirectUri: r.redirect_uri, codeChallenge: r.code_challenge, resource: r.resource, personId: s.personId, scopeFolders, readOnly,
    grantedScope: readOnly ? 'files:read' : 'files:read drafts:write', grantTtlMs: GRANT_TTLS[ttl],
  })
  appendAudit(w.db, { personId: s.personId, tokenId: null, tool: 'web', files: [], outcome: 'ok',
    command: `oauth consent ${client.domain} (${client.name}${client.verified ? '' : ', unverified'}) ${scopeFolders ? `scope=${scopeFolders.length} folders` : 'all folders'}${readOnly ? ' read-only' : ' drafts'} ttl=${ttl}` })
  return json({ redirect_to: clientRedirect(rt, r.redirect_uri, { code, state: r.state }) })
}
