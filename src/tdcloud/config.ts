// Trina Cloud mode: the TDRIVE_CLOUD_* environment the console writes into a team drive's env (docs/SSO-CONTRACT.md).
// Without TDRIVE_CLOUD_ISSUER, TDRIVE_CLOUD_TEAM and TDRIVE_CLOUD_SSO_KEYS this is a self-hosted install: every
// function here answers "not cloud" and nothing in src/tdcloud changes behaviour.
import crypto from 'node:crypto'
import { ENV_PREFIX } from '../config'
import type { DB } from '../db'

export interface SsoKey { kid: string; key: crypto.KeyObject }
export interface CloudConfig {
  issuer: string
  team: string
  keys: SsoKey[]
  /** drive → console calls (POST /api/team-callback/invites) */
  callbackToken: string | null
  consoleUrl: string
  /** TDRIVE_SSO_ONLY=1: password sign-in refused for console-managed people, /api/setup gone, people APIs read-only */
  ssoOnly: boolean
  /** the clock (tests replace it) */
  now: () => number
}

const truthy = (v: string | undefined) => ['1', 'true', 'yes', 'on'].includes((v ?? '').trim().toLowerCase())

/** Parse `[{"kid":"k1","x":"<base64url raw Ed25519 key>"}]`; bad entries are an error (a typo must not open anything). */
export function parseKeys(raw: string): SsoKey[] {
  const list = JSON.parse(raw) as unknown
  if (!Array.isArray(list) || !list.length) throw new Error('TDRIVE_CLOUD_SSO_KEYS: a non-empty JSON array')
  return list.map((k) => {
    const { kid, x } = (k ?? {}) as { kid?: unknown; x?: unknown }
    if (typeof kid !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(kid) || typeof x !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(x)) throw new Error('TDRIVE_CLOUD_SSO_KEYS: entries are {kid, x}')
    return { kid, key: crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' }) }
  })
}

const envCache = new Map<string, CloudConfig | null>()

export function cloudConfigFromEnv(env: Record<string, string | undefined> = process.env): CloudConfig | null {
  const v = (k: string) => env[`${ENV_PREFIX}_${k}`]?.trim() || undefined
  const issuer = v('CLOUD_ISSUER'), team = v('CLOUD_TEAM'), keys = v('CLOUD_SSO_KEYS')
  if (!issuer || !team || !keys) return null
  const cacheKey = JSON.stringify([issuer, team, keys, v('CLOUD_CALLBACK_TOKEN'), v('CLOUD_CONSOLE_URL'), v('SSO_ONLY')])
  if (envCache.has(cacheKey)) return envCache.get(cacheKey)!
  let cfg: CloudConfig | null
  try {
    cfg = {
      issuer, team, keys: parseKeys(keys), callbackToken: v('CLOUD_CALLBACK_TOKEN') ?? null,
      consoleUrl: (v('CLOUD_CONSOLE_URL') ?? issuer).replace(/\/$/, ''), ssoOnly: truthy(v('SSO_ONLY')), now: Date.now,
    }
  } catch (e) {
    // a broken key list closes sign-in (no keys = nothing verifies) rather than falling back to self-hosted rules
    console.error(`[tdcloud] ${(e as Error).message}`)
    cfg = { issuer, team, keys: [], callbackToken: v('CLOUD_CALLBACK_TOKEN') ?? null, consoleUrl: (v('CLOUD_CONSOLE_URL') ?? issuer).replace(/\/$/, ''), ssoOnly: truthy(v('SSO_ONLY')), now: Date.now }
  }
  envCache.set(cacheKey, cfg)
  return cfg
}

// tests (and one process serving one team) set the configuration per database instead of through process.env
const overrides = new WeakMap<DB, CloudConfig | null>()
export function setCloudConfig(db: DB, cfg: CloudConfig | null | undefined) {
  if (cfg === undefined) overrides.delete(db)
  else overrides.set(db, cfg)
}

/** This drive's cloud configuration, or null on a self-hosted install. */
export function cloudConfig(db: DB): CloudConfig | null {
  return overrides.has(db) ? overrides.get(db)! : cloudConfigFromEnv()
}
export const isCloud = (db: DB) => cloudConfig(db) !== null
export const ssoOnly = (db: DB) => !!cloudConfig(db)?.ssoOnly
