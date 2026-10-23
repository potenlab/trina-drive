// HTTP side of the Google Drive import (/api/gdrive…, a person's session; CSRF + same-origin like every change).
// Not configured (no Google client) or not in managed storage → every route is 404 and the app shows nothing.
//
// Connecting: POST /api/gdrive/connect answers Google's consent URL and sets a short cookie that binds the round trip
// to this browser (SameSite=Lax, only sent to the callback); Google sends the person back to GET /api/gdrive/callback
// (state used once, same browser, PKCE), which keeps the tokens sealed and redirects into the app. The session cookie
// is SameSite=Strict, so the callback does not depend on it: the state says whose connection this is, and the cookie
// that only the starting browser holds stops someone from slipping their Google account into another person's Trina.
import { appendAudit } from '../audit'
import { SECRET_TAG } from '../config'
import { managedMountIds } from '../managed/core'
import { storageSettings } from '../managed/settings'
import type { Actor } from '../rights'
import { ApiError, json, notFound, type WebCtx } from '../web/http'
import { wrap } from '../managed/web'
import { googleConfigFromEnv, SCOPE_READONLY, type GoogleConfig } from './config'
import { GoogleClient, GoogleError } from './google'
import { jobOf, jobsOfPerson, jobView, startImport } from './importer'
import { accessToken, connectionOf, disconnect, ensureGdriveSchema, hasScope, newState, NotConnected, saveConnection, takeState } from './store'

export const STATE_COOKIE = `${SECRET_TAG}_gdrive`
const CALLBACK = '/api/gdrive/callback'

/** The Google client of this server, or null when the feature is off (not configured, or not managed storage). */
export function googleOf(w: WebCtx): GoogleClient | null {
  const cfg: GoogleConfig | null = w.opts.google === undefined ? googleConfigFromEnv() : w.opts.google
  if (!cfg || storageSettings(w.db, w.dataDir).mode !== 'managed') return null
  ensureGdriveSchema(w.db)
  return new GoogleClient(cfg, w.opts.googleFetch ?? fetch, w.opts.googleRetryMs ?? 1000)
}
const need = (w: WebCtx) => { const g = googleOf(w); if (!g) throw notFound(); return g }
const audit = (w: WebCtx, a: Actor, command: string, outcome = 'ok') => appendAudit(w.db, { personId: a.personId, tokenId: null, tool: 'web', command, files: [], outcome })
const isHttps = (req: Request) => new URL(req.url).protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https'

export function status(w: WebCtx, a: Actor) {
  const g = googleOf(w)
  if (!g) return { enabled: false }
  const c = connectionOf(w.db, a.personId)
  return { enabled: true, readonly: g.cfg.readonly, folders: g.cfg.readonly && hasScope(c, SCOPE_READONLY), connected: !!c && !c.broken_at, broken: !!c?.broken_at,
    email: c?.email ?? null, connected_at: c?.created_at ?? null, managed_folders: managedMountIds(w.db).size }
}

export function connect(w: WebCtx, a: Actor, req: Request, base: string, b: Record<string, unknown>) {
  const g = need(w)
  const ret = typeof b.return_path === 'string' && b.return_path.length <= 2048 && b.return_path.startsWith('/') && !b.return_path.startsWith('//') ? b.return_path : null
  const redirectUri = base + CALLBACK
  const s = newState(w.db, a.personId, redirectUri, ret)
  audit(w, a, 'gdrive connect started')
  const cookie = `${STATE_COOKIE}=${s.browser}; Path=${CALLBACK}; HttpOnly; SameSite=Lax; Max-Age=600${isHttps(req) ? '; Secure' : ''}`
  return json({ url: g.authUrl({ redirectUri, state: s.state, challenge: s.challenge }) }, 200, { 'set-cookie': cookie })
}

/** Google's redirect back. Always answers with a redirect into the app (#/files…?gdrive=connected | gdrive=<error>). */
export async function callback(w: WebCtx, req: Request, url: URL, browser: string | undefined): Promise<Response> {
  const g = need(w)
  const clear = `${STATE_COOKIE}=; Path=${CALLBACK}; HttpOnly; SameSite=Lax; Max-Age=0${isHttps(req) ? '; Secure' : ''}`
  const back = (ret: string | null, outcome: string) => {
    const p = ret ?? '/settings'
    const sep = p.includes('?') ? '&' : '?'
    return new Response(null, { status: 303, headers: { location: `/#${p}${sep}gdrive=${encodeURIComponent(outcome)}`, 'set-cookie': clear, 'cache-control': 'no-store' } })
  }
  const st = takeState(w.db, url.searchParams.get('state'), browser)
  if (!st) return back(null, 'expired')
  const who: Actor = { personId: st.person_id, admin: false }
  const active = w.db.query<{ active: number }, [number]>('SELECT active FROM people WHERE id = ?').get(st.person_id)?.active
  if (!active) return back(null, 'expired')
  const err = url.searchParams.get('error')
  const code = url.searchParams.get('code')
  if (err || !code) { audit(w, who, `gdrive connect refused at Google (${(err ?? 'no code').slice(0, 40)})`, 'refused'); return back(st.return_path, 'denied') }
  try {
    const t = await g.exchangeCode(code, st.redirect_uri, st.verifier)
    saveConnection(w.db, w.dataDir, st.person_id, t)
  } catch (e) {
    const reason = e instanceof GoogleError ? e.reason : 'failed'
    if (!(e instanceof GoogleError)) console.error('[gdrive] connecting failed:', e)
    audit(w, who, `gdrive connect failed (${reason.slice(0, 40)})`, 'failed')
    return back(st.return_path, reason === 'scope_not_granted' ? 'no_scope' : 'failed')
  }
  const c = connectionOf(w.db, st.person_id)!
  audit(w, who, `gdrive connected (${c.email ?? 'account'}; scope ${c.scope.split(' ').map((s) => s.slice(s.lastIndexOf('/') + 1)).join(' ')})`)
  return back(st.return_path, 'connected')
}

/** What the Picker in the browser needs: the person's own short-lived access token (drive.file), the key, the app id. */
export async function picker(w: WebCtx, a: Actor) {
  const g = need(w)
  let token: string
  try { token = await accessToken(w.db, w.dataDir, g, a.personId) } catch (e) {
    if (e instanceof NotConnected) throw new ApiError(409, 'not_connected', e.message)
    if (e instanceof GoogleError) throw new ApiError(502, 'google_error', `Google: ${e.message}`)
    throw e
  }
  audit(w, a, 'gdrive picker opened')
  const c = connectionOf(w.db, a.personId)
  return { access_token: token, api_key: g.cfg.apiKey, app_id: g.cfg.appId, folders: g.cfg.readonly && hasScope(c, SCOPE_READONLY) }
}

export async function disconnectOwn(w: WebCtx, a: Actor) {
  need(w)
  const had = await disconnect(w.db, w.dataDir, googleOf(w), a.personId)
  if (had) audit(w, a, 'gdrive disconnected (grant revoked at Google)')
  return { ok: true, disconnected: had }
}

export function importStart(w: WebCtx, a: Actor, b: Record<string, unknown>) {
  const g = need(w)
  return wrap(() => jobView(startImport(w, g, a.personId, b.path, b.items)))
}
export function job(w: WebCtx, a: Actor, id: string) {
  need(w)
  const j = jobOf(w.db, a.personId, id)
  if (!j) throw notFound()
  return jobView(j)
}
export function jobs(w: WebCtx, a: Actor) {
  need(w)
  return { jobs: jobsOfPerson(w.db, a.personId).map(jobView).map(({ items: _i, ...rest }) => rest) }
}
