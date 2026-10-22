// What `public enable` stores (meta table, key public_settings): the public HTTPS address (= OAuth issuer, the MCP
// resource is <url>/mcp), the separate public listener, which proxy's forwarded address is believed, the client trust
// policy, and the two confirmations the public gate asks for until the web has its own 2FA flag.
import type { DB } from '../db'
import { DEFAULT_CLIENT_HOSTS, type OAuthOptions } from './config'

export interface PublicSettings {
  enabled: boolean
  /** https://files.example.com (no path) */
  url: string | null
  port: number
  host: string
  /** the tunnel connector's address: CF-Connecting-IP / X-Forwarded-For are believed only from it */
  trustedProxy: string | null
  dcr: boolean
  clientHosts: string[] | 'any'
  /** until the web records admin 2FA (other stream), the operator confirms it; see requireAdmin2FA() in web/public.ts */
  admin2faConfirmedAt: number | null
  /** the v0.2 security gate (plan 10) was passed for this release */
  gateConfirmedAt: number | null
  gateVersion: string | null
}

export const DEFAULT_PUBLIC: PublicSettings = {
  enabled: false, url: null, port: 8788, host: '127.0.0.1', trustedProxy: null, dcr: false, clientHosts: DEFAULT_CLIENT_HOSTS,
  admin2faConfirmedAt: null, gateConfirmedAt: null, gateVersion: null,
}

const KEY = 'public_settings'

export function readPublicSettings(db: DB): PublicSettings {
  const v = db.query<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?').get(KEY)?.value
  if (!v) return { ...DEFAULT_PUBLIC }
  try { return { ...DEFAULT_PUBLIC, ...(JSON.parse(v) as Partial<PublicSettings>) } } catch { return { ...DEFAULT_PUBLIC } }
}

export function writePublicSettings(db: DB, s: PublicSettings) {
  db.query('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(KEY, JSON.stringify(s))
}

/** OAuth is on when a public HTTPS address is configured (the issuer must be reachable by claude.ai / ChatGPT). */
export function oauthOptionsFromSettings(s: PublicSettings): OAuthOptions | null {
  if (!s.url) return null
  return { issuer: s.url, dcr: s.dcr, clientHosts: s.clientHosts }
}
