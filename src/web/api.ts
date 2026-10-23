// REST API under /api (JSON). People sign in with a password and get a session cookie (Path=/api, HttpOnly,
// SameSite=Strict, Secure on https). Every state change needs the session's CSRF token (X-CSRF-Token) and, from a
// browser, a same-origin Origin. Handlers only parse and route: who may see or change what is decided in rights.ts
// (admin side) and policy.ts (drafts), reached through ops.ts and views.ts.
// The route table is assembled from modules (W0 seams): sign-in in auth-routes.ts, people in people-ops.ts, rules in
// src/share/rules.ts, and feature routes registered in routes.ts. A feature adds routes in its own module.
import { appendAudit } from '../audit'
import { NAME } from '../config'
import { PeopleLimitError, StoreError } from '../store'
import type { Actor } from '../rights'
import { AuthError, csrfOk, lookupSession, SESSION_COOKIE } from './auth'
import * as approve from './approve'
import * as files from './files'
import * as managed from '../managed/web'
import * as gdrive from '../gdrive/web'
import * as apppw from '../dav/apppw'
import { ManagedError } from '../managed/core'
import { ApiError, bad, json, notFound, type WebCtx } from './http'
import { markNoticesRead, noticesOf } from './notices'
import * as ops from './ops'
import * as people from './people-ops'
import * as rules from '../share/rules'
import { id, R, type Call, type Route } from './route'
import { authRoutes } from './auth-routes'
import { MODULE_ROUTES } from './routes'
import { ensureWebSchema } from './schema'
import * as views from './views'

const MAX_BODY = 64 * 1024
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return undefined
}

/** The origin this server is reached at (what a same-origin browser request carries in Origin). */
export const ownOrigin = (req: Request) => new URL(req.url).origin

/**
 * Browser requests that change state must come from this server's own pages: Origin must match (or be explicitly
 * allowed); without Origin, Sec-Fetch-Site must not say cross-site. Non-browser clients send neither and still need
 * the CSRF token (which only a page of ours can read).
 */
export function originOk(req: Request, allowed: string[] = []): boolean {
  const origin = req.headers.get('origin')
  if (origin) return origin === ownOrigin(req) || allowed.includes(origin)
  const site = req.headers.get('sec-fetch-site')
  return !site || site === 'same-origin' || site === 'none'
}

async function body(req: Request): Promise<Record<string, unknown>> {
  if (!STATE_CHANGING.has(req.method)) return {}
  const len = Number(req.headers.get('content-length') ?? 0)
  if (len > MAX_BODY) throw new ApiError(413, 'too_large')
  const text = await req.text()
  if (!text) return {}
  if (!(req.headers.get('content-type') ?? '').includes('application/json')) throw new ApiError(415, 'json_only', 'send application/json')
  if (text.length > MAX_BODY) throw new ApiError(413, 'too_large')
  try { const v = JSON.parse(text); if (v && typeof v === 'object' && !Array.isArray(v)) return v; throw 0 } catch { throw bad('bad_json') }
}

export const base = (w: WebCtx, req: Request) => (w.opts.publicUrl ?? ownOrigin(req)).replace(/\/$/, '')

const coreRoutes: Route[] = [
  // ---------- signed in ----------
  R('GET', '/session', true, ({ w, s, actor }) => ({ me: views.me(w, actor), csrf: s!.csrf })),
  R('POST', '/me/password', true, ({ op, s, body: b }) => people.changeOwnPassword(op, s!.idHash, b)),
  R('GET', '/notices', true, ({ w, actor }) => ({ notices: noticesOf(w.db, actor.personId) })),
  R('POST', '/notices/read', true, ({ w, actor }) => { markNoticesRead(w.db, actor.personId); return { ok: true } }),

  R('GET', '/people', true, ({ w, actor }) => views.peopleView(w, actor)),
  R('POST', '/people', true, ({ op, body: b }) => people.createPerson(op, b)),
  R('PATCH', '/people/:id', true, (c) => people.updatePerson(c.op, id(c), c.body)),
  R('POST', '/people/:id/invite', true, (c) => people.invitePerson(c.op, id(c), c.body)),
  R('POST', '/people/:id/reset', true, (c) => people.resetPassword(c.op, id(c))),
  R('POST', '/groups', true, ({ op, body: b }) => people.createGroup(op, b)),
  R('DELETE', '/groups/:id', true, (c) => people.deleteGroup(c.op, id(c))),
  R('PUT', '/groups/:id/members/:pid', true, (c) => people.setMember(c.op, id(c), id(c, 'pid'), true)),
  R('DELETE', '/groups/:id/members/:pid', true, (c) => people.setMember(c.op, id(c), id(c, 'pid'), false)),

  R('GET', '/folders', true, ({ w, actor }) => ({ folders: views.foldersView(w, actor) })),
  R('POST', '/folders', true, ({ op, body: b }) => ops.registerFolder(op, b)),
  R('GET', '/folders/:id', true, (c) => views.folderView(c.op, id(c))),
  R('PATCH', '/folders/:id', true, (c) => rules.setFlags(c.op, id(c), c.body)),
  R('DELETE', '/folders/:id', true, (c) => ops.unregisterFolder(c.op, id(c))),
  R('PUT', '/folders/:id/rules', true, (c) => rules.setRule(c.op, id(c), c.body)),
  R('PUT', '/folders/:id/nas', true, (c) => ops.setNas(c.op, id(c), c.body)),
  R('PUT', '/folders/:id/owner', true, (c) => ops.setOwner(c.op, id(c), c.body)),
  R('POST', '/folders/:id/subfolders', true, (c) => ops.ensureSubfolder(c.op, id(c), c.body)),
  R('PUT', '/folders/:id/managers/:pid', true, (c) => rules.setManage(c.op, id(c), id(c, 'pid'), true)),
  R('DELETE', '/folders/:id/managers/:pid', true, (c) => rules.setManage(c.op, id(c), id(c, 'pid'), false)),

  R('GET', '/tokens', true, ({ w, actor }) => ({ tokens: views.tokensView(w, actor) })),
  R('POST', '/tokens', true, ({ op, body: b }) => ops.createOwnToken(op, b)),
  R('DELETE', '/tokens/:id', true, (c) => ops.revokeOwnToken(c.op, id(c))),
  R('POST', '/me/reauth', true, ({ op, s, body: b }) => people.reauth(op, s!.idHash, b)),
  R('POST', '/tokens/:id/provenance-reset', true, (c) => ops.resetProvenance(c.op, c.s!.idHash, id(c), c.body)),

  // second factors (own only; changes need the password typed within 5 minutes)
  R('GET', '/me/2fa', true, ({ w, actor }) => approve.factorsView(w, actor.personId)),
  R('POST', '/me/passkeys/options', true, ({ op, s }) => approve.passkeyOptions(op, s!.idHash)),
  R('POST', '/me/passkeys', true, ({ op, s, body: b }) => approve.passkeyAdd(op, s!.idHash, b)),
  R('DELETE', '/me/passkeys/:id', true, (c) => approve.passkeyDelete(c.op, c.s!.idHash, id(c))),
  R('POST', '/me/totp/setup', true, ({ op, s }) => approve.totpSetup(op, s!.idHash)),
  R('POST', '/me/totp/confirm', true, ({ op, body: b }) => approve.totpEnable(op, b)),
  R('DELETE', '/me/totp', true, ({ op, s }) => approve.totpDisable(op, s!.idHash)),
  R('POST', '/me/recovery-codes', true, ({ op, s }) => approve.newRecoveryCodes(op, s!.idHash)),

  // draft promote (plan 5.2) and the approval inbox (R8): sessions only, every approval click needs its own step-up
  R('GET', '/promote/targets', true, ({ w, actor }) => approve.promoteTargetsView(w, actor)),
  R('POST', '/drafts/:id/promote', true, (c) => approve.promoteFromWeb(c.op, id(c), c.body)),
  R('PUT', '/folders/:id/promote', true, (c) => approve.setFolderPromote(c.op, id(c), c.body)),
  R('GET', '/approvals', true, ({ w, actor }) => approve.approvalsView(w, actor)),
  R('GET', '/approvals/:id', true, (c) => approve.approvalView(c.w, c.actor, id(c))),
  R('POST', '/approvals/:id/step-up/options', true, (c) => approve.stepUpOptions(c.op, c.s!.idHash, id(c), c.body)),
  R('POST', '/approvals/:id/step-up', true, (c) => approve.stepUp(c.op, c.s!.idHash, id(c), c.body)),
  R('POST', '/approvals/:id/approve', true, (c) => approve.approveRequest(c.op, c.s!.idHash, id(c), c.body)),
  R('POST', '/approvals/:id/reject', true, (c) => approve.rejectRequest(c.op, id(c), c.body)),

  R('GET', '/drafts', true, ({ w, actor }) => views.draftsView(w, actor)),
  R('GET', '/drafts/:id/download', true, (c) => {
    const d = views.draftForDownload(c.w, c.actor, id(c))
    const bytes = c.w.blobs.get(d.sha256)
    appendAudit(c.w.db, { personId: c.actor.personId, tokenId: null, tool: 'web', command: `draft download ${d.path} v${d.version}`, files: ['/drafts/' + d.path], outcome: 'ok' })
    const fname = d.path.slice(d.path.lastIndexOf('/') + 1)
    return new Response(bytes, { headers: {
      'content-type': 'application/octet-stream', 'cache-control': 'no-store',
      'content-disposition': `attachment; filename="${fname.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(fname)}`,
    } })
  }),
  // people's read-only file view (files.ts; GET only, the session is required, R1 decides)
  R('GET', '/files', true, ({ w, actor, url }) => files.list(w, actor, url)),
  R('GET', '/files/stat', true, ({ w, actor, url }) => files.stat(w, actor, url)),
  R('GET', '/files/download', true, ({ w, actor, url }) => files.download(w, actor, url)),
  R('GET', '/files/text', true, ({ w, actor, url }) => files.text(w, actor, url)),
  R('GET', '/files/who', true, ({ w, actor, url }) => files.who(w, actor, url)),
  R('GET', '/search', true, ({ w, actor, url }) => files.search(w, actor, url)),
  // managed storage (src/managed): people change files where the server owns them; every op is R0/R1 + write
  R('POST', '/files/folder', true, ({ w, actor, body: b }) => managed.mkdir(w, actor, b)),
  R('POST', '/files/upload', true, ({ w, actor, req, url }) => managed.upload(w, actor, req, url), true),
  R('POST', '/files/rename', true, ({ w, actor, body: b }) => managed.rename(w, actor, b)),
  R('POST', '/files/move', true, ({ w, actor, body: b }) => managed.move(w, actor, b)),
  R('POST', '/files/copy', true, ({ w, actor, body: b }) => managed.copy(w, actor, b)),
  R('POST', '/files/delete', true, ({ w, actor, body: b }) => managed.remove(w, actor, b)),
  R('GET', '/files/versions', true, ({ w, actor, url }) => managed.versions(w, actor, url)),
  R('GET', '/files/versions/download', true, ({ w, actor, url }) => managed.versionDownload(w, actor, url)),
  R('POST', '/files/versions/restore', true, ({ w, actor, body: b }) => managed.restoreVersion(w, actor, b)),
  R('POST', '/files/share', true, ({ w, actor, body: b }) => managed.shareSettings(w, actor, b)),
  R('POST', '/uploads', true, ({ w, actor, body: b }) => managed.uploadStart(w, actor, b)),
  R('GET', '/uploads/:uid', true, (c) => managed.uploadGet(c.w, c.actor, c.m.groups!.uid!)),
  R('PUT', '/uploads/:uid', true, (c) => managed.uploadChunk(c.w, c.actor, c.m.groups!.uid!, c.req, c.url), true),
  R('POST', '/uploads/:uid/complete', true, (c) => managed.uploadComplete(c.w, c.actor, c.m.groups!.uid!, c.body)),
  R('DELETE', '/uploads/:uid', true, (c) => managed.uploadCancel(c.w, c.actor, c.m.groups!.uid!)),
  R('GET', '/trash', true, ({ w, actor }) => managed.trash(w, actor)),
  R('POST', '/trash/empty', true, ({ w, actor }) => managed.emptyTrash(w, actor)),
  R('POST', '/trash/:id/restore', true, (c) => managed.restore(c.w, c.actor, id(c))),
  R('DELETE', '/trash/:id', true, (c) => managed.purge(c.w, c.actor, id(c))),
  R('GET', '/storage', true, ({ w, actor }) => managed.storageView(w, actor)),
  // Google Drive import (src/gdrive): 404 everywhere unless configured; the callback comes back from Google (no session)
  R('GET', '/gdrive', true, ({ w, actor }) => gdrive.status(w, actor)),
  R('POST', '/gdrive/connect', true, ({ w, actor, req, body: b }) => gdrive.connect(w, actor, req, base(w, req), b)),
  R('GET', '/gdrive/callback', false, ({ w, req, url }) => gdrive.callback(w, req, url, readCookie(req, gdrive.STATE_COOKIE))),
  R('GET', '/gdrive/picker', true, ({ w, actor }) => gdrive.picker(w, actor)),
  R('DELETE', '/gdrive', true, ({ w, actor }) => gdrive.disconnectOwn(w, actor)),
  R('POST', '/gdrive/import', true, ({ w, actor, body: b }) => gdrive.importStart(w, actor, b)),
  R('GET', '/gdrive/jobs', true, ({ w, actor }) => gdrive.jobs(w, actor)),
  R('GET', '/gdrive/jobs/:jid', true, (c) => gdrive.job(c.w, c.actor, c.m.groups!.jid!)),
  // WebDAV mount (src/dav): app passwords (own only; shown once, kept as sha256) and the address to mount
  R('GET', '/me/app-passwords', true, ({ w, actor, req }) => apppw.view(w, actor, base(w, req))),
  R('POST', '/me/app-passwords', true, ({ op, s, body: b }) => apppw.create(op, s!.idHash, b)),
  R('DELETE', '/me/app-passwords/:id', true, (c) => apppw.revoke(c.w, c.actor, id(c))),
  R('GET', '/audit', true, ({ w, actor, url }) => views.auditView(w, actor, url.searchParams.get('view') ?? 'mine', Number(url.searchParams.get('before') ?? '') || undefined)),
]

/**
 * The whole table, in match order: signing in (auth-routes.ts), the core routes above, then the feature modules'
 * routes (routes.ts: src/share/http.ts, src/tdcloud/http.ts, …). A path that matches several routes picks the first
 * with the request's method.
 */
export const routes: Route[] = [...authRoutes, ...coreRoutes, ...MODULE_ROUTES]

export async function handleApi(w: WebCtx, req: Request, addr = 'unknown'): Promise<Response> {
  ensureWebSchema(w.db)
  const url = new URL(req.url)
  try {
    const candidates = routes.filter((r) => r.re.test(url.pathname))
    if (!candidates.length) throw notFound()
    const route = candidates.find((r) => r.method === req.method)
    if (!route) return json({ error: 'method_not_allowed' }, 405, { allow: candidates.map((r) => r.method).join(', ') })
    const changing = STATE_CHANGING.has(req.method)
    if (changing && !route.crossOrigin && !originOk(req, w.opts.allowedOrigins)) throw new ApiError(403, 'bad_origin', 'cross-site request refused')
    const s = lookupSession(w.db, readCookie(req, SESSION_COOKIE))
    if (route.auth && !s) throw new ApiError(401, 'signed_out', 'sign in first')
    // CSRF: every state change made with a session carries the session's token
    if (changing && s && route.auth && !csrfOk(s, req.headers.get('x-csrf-token'))) throw new ApiError(403, 'bad_csrf', 'missing or wrong CSRF token; reload the page')
    const actor: Actor = s ? { personId: s.personId, admin: s.admin } : { personId: -1, admin: false }
    const call: Call = { w, req, m: route.re.exec(url.pathname)!, body: route.raw ? {} : await body(req), s, actor, op: { w, actor, base: base(w, req) }, addr, url }
    const out = await route.fn(call)
    return out instanceof Response ? out : json(out)
  } catch (e) {
    if (e instanceof ApiError || e instanceof AuthError) return json({ error: e.code, message: e.message }, e.status, e instanceof ApiError ? e.headers : undefined)
    // the plan's people limit (TDRIVE_MAX_PEOPLE): the web shows this message on the People page
    if (e instanceof PeopleLimitError) return json({ error: e.code, message: e.message, max_people: e.max }, 403)
    if (e instanceof StoreError) return json({ error: 'bad_request', message: e.message }, 400)
    if (e instanceof ManagedError) return json({ error: e.code, message: e.message }, e.status)
    console.error(`[${NAME}] ${req.method} ${url.pathname} failed:`, e)
    return json({ error: 'internal', message: 'internal error' }, 500)
  }
}
