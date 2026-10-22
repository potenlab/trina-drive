// REST API under /api (JSON). People sign in with a password and get a session cookie (Path=/api, HttpOnly,
// SameSite=Strict, Secure on https). Every state change needs the session's CSRF token (X-CSRF-Token) and, from a
// browser, a same-origin Origin. Handlers only parse and route: who may see or change what is decided in rights.ts
// (admin side) and policy.ts (drafts), reached through ops.ts and views.ts.
import { appendAudit } from '../audit'
import { NAME, VERSION } from '../config'
import { StoreError, addPerson } from '../store'
import type { Actor } from '../rights'
import {
  accountByLogin, AuthError, checkPasswordRules, consumeLink, consumeSetupToken, createSession, csrfOk, hashPassword, lookupSession,
  peekLink, revokeSession, SESSION_COOKIE, SESSION_MAX_MS, setPassword, setupDone, setupPending, verifyPassword, type WebSession,
} from './auth'
import * as files from './files'
import { ApiError, bad, json, notFound, rateLimited, type WebCtx } from './http'
import { markNoticesRead, noticesOf } from './notices'
import * as ops from './ops'
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

const isHttps = (req: Request) => new URL(req.url).protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https'
function sessionCookie(req: Request, value: string, maxAgeS: number) {
  return `${SESSION_COOKIE}=${value}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}${isHttps(req) ? '; Secure' : ''}`
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

const base = (w: WebCtx, req: Request) => (w.opts.publicUrl ?? ownOrigin(req)).replace(/\/$/, '')

function startSession(w: WebCtx, req: Request, personId: number, previous?: WebSession | null) {
  if (previous) revokeSession(w.db, previous.idHash) // a new id on every sign-in (no fixation)
  const s = createSession(w.db, personId, req.headers.get('user-agent') ?? undefined)
  return { csrf: s.csrf, cookie: sessionCookie(req, s.cookie, SESSION_MAX_MS / 1000) }
}

type Route = { method: string; re: RegExp; auth: boolean; fn: (c: Call) => Promise<Response | unknown> | Response | unknown }
interface Call { w: WebCtx; req: Request; m: RegExpExecArray; body: Record<string, unknown>; s: WebSession | null; actor: Actor; op: ops.Op; addr: string; url: URL }

const R = (method: string, path: string, auth: boolean, fn: Route['fn']): Route =>
  ({ method, re: new RegExp('^/api' + path.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), auth, fn })
const id = (c: Call, k = 'id') => { const v = Number(c.m.groups?.[k]); if (!Number.isSafeInteger(v) || v <= 0) throw notFound(); return v }

const routes: Route[] = [
  // ---------- before sign-in ----------
  R('GET', '/state', false, ({ w }) => ({ name: NAME, version: VERSION, setup_pending: setupPending(w.db), setup_done: setupDone(w.db) })),
  R('POST', '/setup', false, async ({ w, req, body: b, s, addr }) => {
    if (!w.linkByAddr.hit(`setup:${addr}`)) throw rateLimited(w.linkByAddr.retryAfter(`setup:${addr}`))
    const pw = checkPasswordRules(b.password)
    const hash = await hashPassword(pw)
    const name = typeof b.name === 'string' ? b.name.trim().normalize('NFC') : ''
    const email = typeof b.email === 'string' ? b.email.trim() : ''
    if (!/^[^\s/\\@#][^/\\\p{Cc}]{0,63}$/u.test(name) || !/^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw bad('bad_input', 'a name and a valid mail address are required')
    if (!consumeSetupToken(w.db, b.setup_token)) throw new ApiError(403, 'bad_setup_token', 'that setup token is not valid (it is used once and printed by init)')
    let personId = 0
    w.db.transaction(() => {
      const p = w.db.query<{ id: number; admin: number }, [string]>('SELECT id, admin FROM people WHERE name = ?').get(name)
      if (p && !p.admin) throw new ApiError(409, 'not_admin', 'a person with that name exists and is not an admin')
      personId = p?.id ?? addPerson(w.db, name, true).id
      w.db.query('INSERT INTO accounts (person_id, email, password_hash, created_at, password_set_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (person_id) DO UPDATE SET email = excluded.email, password_hash = excluded.password_hash, password_set_at = excluded.password_set_at')
        .run(personId, email, hash, Date.now(), Date.now())
      appendAudit(w.db, { personId, tokenId: null, tool: 'web', command: `setup: first admin ${name}`, files: [], outcome: 'ok' })
    })()
    const everyone = ops.everyoneGroup(w)
    w.db.query('INSERT OR IGNORE INTO memberships (group_id, person_id) VALUES (?, ?)').run(everyone, personId)
    const ss = startSession(w, req, personId, s)
    return json({ me: views.me(w, { personId, admin: true }), csrf: ss.csrf }, 200, { 'set-cookie': ss.cookie })
  }),
  R('POST', '/login', false, async ({ w, req, body: b, s, addr }) => {
    const login = typeof b.login === 'string' ? b.login.trim().toLowerCase().slice(0, 254) : ''
    const pw = typeof b.password === 'string' ? b.password : ''
    if (!login || !pw) throw bad('bad_input', 'name or mail address, and password')
    if (w.loginByName.blocked(login)) throw rateLimited(w.loginByName.retryAfter(login))
    if (!w.loginByAddr.hit(addr)) throw rateLimited(w.loginByAddr.retryAfter(addr))
    const acc = accountByLogin(w.db, login)
    const ok = await verifyPassword(pw, acc?.password_hash)
    if (!ok || !acc || !acc.active) {
      w.loginByName.hit(login)
      throw new ApiError(401, 'bad_login', 'wrong name or password')
    }
    w.loginByName.reset(login)
    const ss = startSession(w, req, acc.person_id, s)
    return json({ me: views.me(w, { personId: acc.person_id, admin: !!acc.admin }), csrf: ss.csrf }, 200, { 'set-cookie': ss.cookie })
  }),
  R('POST', '/logout', true, ({ w, req, s }) => {
    revokeSession(w.db, s!.idHash)
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie(req, '', 0) })
  }),
  R('POST', '/links/check', false, ({ w, body: b, addr }) => {
    if (!w.linkByAddr.hit(`link:${addr}`)) throw rateLimited(w.linkByAddr.retryAfter(`link:${addr}`))
    const kind = b.kind === 'reset' ? 'reset' : 'invite'
    const pid = peekLink(w.db, kind, b.token)
    if (pid == null) throw new ApiError(404, 'bad_link', 'this link is used, expired or wrong')
    return { name: w.db.query<{ name: string }, [number]>('SELECT name FROM people WHERE id = ?').get(pid)?.name }
  }),
  R('POST', '/links/accept', false, async ({ w, req, body: b, s, addr }) => {
    if (!w.linkByAddr.hit(`link:${addr}`)) throw rateLimited(w.linkByAddr.retryAfter(`link:${addr}`))
    const kind = b.kind === 'reset' ? 'reset' : 'invite'
    const pw = checkPasswordRules(b.password)
    const pid = consumeLink(w.db, kind, b.token)
    if (pid == null) throw new ApiError(404, 'bad_link', 'this link is used, expired or wrong')
    await setPassword(w.db, pid, pw)
    appendAudit(w.db, { personId: pid, tokenId: null, tool: 'web', command: kind === 'invite' ? 'invite accepted' : 'password reset completed', files: [], outcome: 'ok' })
    const p = w.db.query<{ admin: number; active: number }, [number]>('SELECT admin, active FROM people WHERE id = ?').get(pid)!
    if (!p.active) return { ok: true }
    const ss = startSession(w, req, pid, s)
    return json({ me: views.me(w, { personId: pid, admin: !!p.admin }), csrf: ss.csrf }, 200, { 'set-cookie': ss.cookie })
  }),

  // ---------- signed in ----------
  R('GET', '/session', true, ({ w, s, actor }) => ({ me: views.me(w, actor), csrf: s!.csrf })),
  R('POST', '/me/password', true, ({ op, s, body: b }) => ops.changeOwnPassword(op, s!.idHash, b)),
  R('GET', '/notices', true, ({ w, actor }) => ({ notices: noticesOf(w.db, actor.personId) })),
  R('POST', '/notices/read', true, ({ w, actor }) => { markNoticesRead(w.db, actor.personId); return { ok: true } }),

  R('GET', '/people', true, ({ w, actor }) => views.peopleView(w, actor)),
  R('POST', '/people', true, ({ op, body: b }) => ops.createPerson(op, b)),
  R('PATCH', '/people/:id', true, (c) => ops.updatePerson(c.op, id(c), c.body)),
  R('POST', '/people/:id/invite', true, (c) => ops.invitePerson(c.op, id(c), c.body)),
  R('POST', '/people/:id/reset', true, (c) => ops.resetPassword(c.op, id(c))),
  R('POST', '/groups', true, ({ op, body: b }) => ops.createGroup(op, b)),
  R('DELETE', '/groups/:id', true, (c) => ops.deleteGroup(c.op, id(c))),
  R('PUT', '/groups/:id/members/:pid', true, (c) => ops.setMember(c.op, id(c), id(c, 'pid'), true)),
  R('DELETE', '/groups/:id/members/:pid', true, (c) => ops.setMember(c.op, id(c), id(c, 'pid'), false)),

  R('GET', '/folders', true, ({ w, actor }) => ({ folders: views.foldersView(w, actor) })),
  R('POST', '/folders', true, ({ op, body: b }) => ops.registerFolder(op, b)),
  R('GET', '/folders/:id', true, (c) => views.folderView(c.op, id(c))),
  R('PATCH', '/folders/:id', true, (c) => ops.setFlags(c.op, id(c), c.body)),
  R('DELETE', '/folders/:id', true, (c) => ops.unregisterFolder(c.op, id(c))),
  R('PUT', '/folders/:id/rules', true, (c) => ops.setRule(c.op, id(c), c.body)),
  R('PUT', '/folders/:id/nas', true, (c) => ops.setNas(c.op, id(c), c.body)),
  R('PUT', '/folders/:id/owner', true, (c) => ops.setOwner(c.op, id(c), c.body)),
  R('POST', '/folders/:id/subfolders', true, (c) => ops.ensureSubfolder(c.op, id(c), c.body)),
  R('PUT', '/folders/:id/managers/:pid', true, (c) => ops.setManage(c.op, id(c), id(c, 'pid'), true)),
  R('DELETE', '/folders/:id/managers/:pid', true, (c) => ops.setManage(c.op, id(c), id(c, 'pid'), false)),

  R('GET', '/tokens', true, ({ w, actor }) => ({ tokens: views.tokensView(w, actor) })),
  R('POST', '/tokens', true, ({ op, body: b }) => ops.createOwnToken(op, b)),
  R('DELETE', '/tokens/:id', true, (c) => ops.revokeOwnToken(c.op, id(c))),
  R('POST', '/me/reauth', true, ({ op, s, body: b }) => ops.reauth(op, s!.idHash, b)),
  R('POST', '/tokens/:id/provenance-reset', true, (c) => ops.resetProvenance(c.op, c.s!.idHash, id(c), c.body)),

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
  R('GET', '/audit', true, ({ w, actor, url }) => views.auditView(w, actor, url.searchParams.get('view') ?? 'mine', Number(url.searchParams.get('before') ?? '') || undefined)),
]

export async function handleApi(w: WebCtx, req: Request, addr = 'unknown'): Promise<Response> {
  ensureWebSchema(w.db)
  const url = new URL(req.url)
  try {
    const candidates = routes.filter((r) => r.re.test(url.pathname))
    if (!candidates.length) throw notFound()
    const route = candidates.find((r) => r.method === req.method)
    if (!route) return json({ error: 'method_not_allowed' }, 405, { allow: candidates.map((r) => r.method).join(', ') })
    const changing = STATE_CHANGING.has(req.method)
    if (changing && !originOk(req, w.opts.allowedOrigins)) throw new ApiError(403, 'bad_origin', 'cross-site request refused')
    const s = lookupSession(w.db, readCookie(req, SESSION_COOKIE))
    if (route.auth && !s) throw new ApiError(401, 'signed_out', 'sign in first')
    // CSRF: every state change made with a session carries the session's token
    if (changing && s && route.auth && !csrfOk(s, req.headers.get('x-csrf-token'))) throw new ApiError(403, 'bad_csrf', 'missing or wrong CSRF token; reload the page')
    const actor: Actor = s ? { personId: s.personId, admin: s.admin } : { personId: -1, admin: false }
    const call: Call = { w, req, m: route.re.exec(url.pathname)!, body: await body(req), s, actor, op: { w, actor, base: base(w, req) }, addr, url }
    const out = await route.fn(call)
    return out instanceof Response ? out : json(out)
  } catch (e) {
    if (e instanceof ApiError || e instanceof AuthError) return json({ error: e.code, message: e.message }, e.status, e instanceof ApiError ? e.headers : undefined)
    if (e instanceof StoreError) return json({ error: 'bad_request', message: e.message }, 400)
    console.error(`[${NAME}] ${req.method} ${url.pathname} failed:`, e)
    return json({ error: 'internal', message: 'internal error' }, 500)
  }
}
