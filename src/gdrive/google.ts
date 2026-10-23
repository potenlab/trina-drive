// The few Google endpoints the import uses (OAuth 2.0 for web server apps, Drive API v3), over an injectable fetch so
// tests run against a mock with no network. Nothing here decides anything about Trina's folders.
import type { GoogleConfig } from './config'
import { scopesOf } from './config'

export const GOOGLE = {
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  drive: 'https://www.googleapis.com/drive/v3',
}

export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export class GoogleError extends Error {
  constructor(readonly status: number, readonly reason: string, message: string) { super(message) }
}

export interface TokenResponse { access_token: string; expires_in?: number; refresh_token?: string; scope?: string; id_token?: string }

export interface DriveFile {
  id: string; name: string; mimeType: string; modifiedTime?: string; size?: string; version?: string; md5Checksum?: string
  trashed?: boolean; exportLinks?: Record<string, string>; shortcutDetails?: { targetId?: string }
}

export const FILE_FIELDS = 'id,name,mimeType,modifiedTime,size,version,md5Checksum,trashed,exportLinks,shortcutDetails'

async function errorOf(res: Response): Promise<GoogleError> {
  let reason = `http_${res.status}`, message = `Google answered ${res.status}`
  try {
    const j = await res.json() as { error?: string | { message?: string; errors?: { reason?: string }[]; status?: string }; error_description?: string }
    if (typeof j.error === 'string') { reason = j.error; message = j.error_description ?? j.error }
    else if (j.error) { reason = j.error.errors?.[0]?.reason ?? j.error.status ?? reason; message = j.error.message ?? message }
  } catch {}
  return new GoogleError(res.status, reason, message)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const slowDown = (e: GoogleError) => e.status === 429 || (e.status === 403 && /rateLimitExceeded|userRateLimitExceeded/.test(e.reason)) || e.status >= 500

export class GoogleClient {
  constructor(readonly cfg: GoogleConfig, private readonly f: Fetch = fetch, private readonly retryMs = 1000, private readonly retries = 3) {}

  authUrl(o: { redirectUri: string; state: string; challenge: string; loginHint?: string }): string {
    const u = new URL(GOOGLE.auth)
    const q = { client_id: this.cfg.clientId, redirect_uri: o.redirectUri, response_type: 'code', scope: scopesOf(this.cfg).join(' '), access_type: 'offline',
      prompt: 'consent', include_granted_scopes: 'true', state: o.state, code_challenge: o.challenge, code_challenge_method: 'S256', ...(o.loginHint ? { login_hint: o.loginHint } : {}) }
    for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v)
    return u.toString()
  }

  private async form(url: string, body: Record<string, string>): Promise<Response> {
    return this.f(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString(), redirect: 'error' })
  }

  async exchangeCode(code: string, redirectUri: string, verifier: string): Promise<TokenResponse> {
    const res = await this.form(GOOGLE.token, { code, client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier })
    if (!res.ok) throw await errorOf(res)
    return await res.json() as TokenResponse
  }

  async refresh(refreshToken: string): Promise<TokenResponse> {
    const res = await this.form(GOOGLE.token, { refresh_token: refreshToken, client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, grant_type: 'refresh_token' })
    if (!res.ok) throw await errorOf(res)
    return await res.json() as TokenResponse
  }

  /** Best effort: the grant ends at Google too (a refresh token revokes the whole grant). */
  async revoke(token: string): Promise<boolean> {
    try { return (await this.form(GOOGLE.revoke, { token })).ok } catch { return false }
  }

  /** A Drive call with the person's access token; "slow down" answers are retried with backoff. */
  private async drive(path: string, token: string, query: Record<string, string> = {}): Promise<Response> {
    const u = new URL(GOOGLE.drive + path)
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v)
    return this.authed(u.toString(), token)
  }
  async authed(url: string, token: string): Promise<Response> {
    for (let i = 0; ; i++) {
      const res = await this.f(url, { headers: { authorization: `Bearer ${token}` }, redirect: 'follow' })
      if (res.ok) return res
      const e = await errorOf(res)
      if (i < this.retries && slowDown(e)) { await sleep(this.retryMs * 2 ** i); continue }
      throw e
    }
  }

  async file(id: string, token: string): Promise<DriveFile> {
    return await (await this.drive(`/files/${encodeURIComponent(id)}`, token, { fields: FILE_FIELDS, supportsAllDrives: 'true' })).json() as DriveFile
  }

  /** Direct children of a folder (readonly mode), every page. */
  async children(folderId: string, token: string, max: number): Promise<DriveFile[]> {
    const out: DriveFile[] = []
    let pageToken = ''
    do {
      const q: Record<string, string> = { q: `'${folderId.replace(/['\\]/g, '')}' in parents and trashed = false`, fields: `nextPageToken,files(${FILE_FIELDS})`,
        pageSize: '1000', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', orderBy: 'folder,name' }
      if (pageToken) q.pageToken = pageToken
      const j = await (await this.drive('/files', token, q)).json() as { files?: DriveFile[]; nextPageToken?: string }
      out.push(...(j.files ?? []))
      pageToken = j.nextPageToken ?? ''
    } while (pageToken && out.length < max)
    return out
  }

  /** The bytes of a file that has its own (PDF, HWP, images…). */
  media(id: string, token: string) { return this.drive(`/files/${encodeURIComponent(id)}`, token, { alt: 'media', supportsAllDrives: 'true' }) }

  /** A Google Docs/Sheets/Slides file exported; over files.export's 10 MB limit, the file's own export link. */
  async exported(f: DriveFile, mime: string, token: string): Promise<Response> {
    try { return await this.drive(`/files/${encodeURIComponent(f.id)}/export`, token, { mimeType: mime }) } catch (e) {
      const link = f.exportLinks?.[mime]
      if (e instanceof GoogleError && e.status === 403 && /exportSizeLimitExceeded/i.test(e.reason) && link && googleHost(link)) return this.authed(link, token)
      throw e
    }
  }
}

/** Our bearer token only ever goes to Google's own hosts. */
const googleHost = (link: string) => {
  try { const u = new URL(link); return u.protocol === 'https:' && /(^|\.)(google\.com|googleapis\.com|googleusercontent\.com)$/.test(u.hostname) } catch { return false }
}

/** The mail address in an ID token straight from Google's token endpoint (over TLS: no signature check needed, OIDC 3.1.3.7). */
export function emailOfIdToken(idToken: string | undefined): string | null {
  const part = idToken?.split('.')[1]
  if (!part) return null
  try { const p = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { email?: unknown }; return typeof p.email === 'string' ? p.email.slice(0, 254) : null } catch { return null }
}
