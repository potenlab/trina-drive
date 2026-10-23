// Notify settings: <data dir>/notify.json (created with defaults on first use). Secrets (SMTP password, webhooks)
// stay in the data directory (0700); $<NAME>_SMTP_PASS overrides the stored SMTP password.
// The outgoing mailer can come entirely from the environment instead (a hosted instance: the control plane writes the
// team's env file); it then also sends the web's invites and password resets (mailEnv below).
import fs from 'node:fs'
import path from 'node:path'
import { ENV_PREFIX } from '../config'
import type { Lang } from './messages'
import type { SesOptions } from './ses'

export interface NotifyConfig {
  /** where links in messages point (the web UI) */
  baseUrl: string
  /** default language for people without one */
  lang: Lang
  email: {
    mode: 'off' | 'outbox' | 'smtp' | 'ses'
    from: string
    /** outbox mode: directory for .eml files (default <data>/outbox) */
    outboxDir?: string
    /** secure: implicit TLS (465); starttls: STARTTLS required (587) */
    smtp?: { host: string; port: number; secure?: boolean; starttls?: boolean; user?: string; pass?: string }
    /** Amazon SES v2; credentials from AWS_* in the environment or the instance role */
    ses?: SesOptions
  }
  /** at most this many messages per destination (one webhook, one address) per minute; the rest waits and coalesces */
  perMinute: number
  /** how often the server flushes pending deliveries */
  flushMs: number
  /** local hour (0–23) of the daily digest */
  digestHour: number
  bulkRead: {
    windowMs: number
    /** thresholds inside the window; any one crossed fires bulk_read (0 = off) */
    files: number
    bytes: number
    folders: number
    /** revoke the token when the alarm fires (off by default) */
    autoSuspend: boolean
  }
  /** a connection from a new source IP counts as a new client */
  newClientByIp: boolean
  anchor: {
    /** 0 = no periodic anchors */
    intervalMs: number
    /** directory outside the data dir (another disk, a synced folder) where each anchor is also written */
    dir?: string
    /** email each anchor to the admins */
    email: boolean
  }
}

export const DEFAULT_NOTIFY: NotifyConfig = {
  baseUrl: 'http://127.0.0.1:8787',
  lang: 'en',
  email: { mode: 'outbox', from: 'tdrive@localhost' },
  perMinute: 6,
  flushMs: 5_000,
  digestHour: 9,
  bulkRead: { windowMs: 10 * 60_000, files: 200, bytes: 50 * 1024 * 1024, folders: 20, autoSuspend: false },
  newClientByIp: true,
  anchor: { intervalMs: 24 * 3600_000, email: true },
}

type Plain = Record<string, unknown>
const isObj = (v: unknown): v is Plain => !!v && typeof v === 'object' && !Array.isArray(v)
function merge<T>(base: T, over: unknown): T {
  if (!isObj(base) || !isObj(over)) return (over === undefined ? base : over) as T
  const out: Plain = { ...base }
  for (const [k, v] of Object.entries(over)) out[k] = merge((base as Plain)[k], v)
  return out as T
}

export const configPath = (dataDir: string) => path.join(dataDir, 'notify.json')

export function loadNotifyConfig(dataDir: string, override: Partial<NotifyConfig> = {}, env: Record<string, string | undefined> = process.env): NotifyConfig {
  let stored: unknown = {}
  try { stored = JSON.parse(fs.readFileSync(configPath(dataDir), 'utf8')) } catch (e) { if ((e as { code?: string }).code !== 'ENOENT') throw e }
  const c = merge(merge(DEFAULT_NOTIFY, stored), override)
  const fromEnv = mailEnv(env)
  if (fromEnv) c.email = { ...c.email, ...fromEnv }
  const pass = env[`${ENV_PREFIX}_SMTP_PASS`]
  if (pass && c.email.smtp) c.email.smtp = { ...c.email.smtp, pass }
  return c
}

/**
 * The mailer from the environment, or null when $<PREFIX>_MAILER is not set:
 *   <PREFIX>_MAILER=smtp|ses|outbox|off   <PREFIX>_MAIL_FROM=team@example.com
 *   smtp: <PREFIX>_SMTP_HOST, _SMTP_PORT (587), _SMTP_TLS=starttls|tls|none (465 → tls, else starttls), _SMTP_USER, _SMTP_PASS
 *   ses:  <PREFIX>_SES_REGION (else AWS_REGION), _SES_ENDPOINT, _SES_CONFIGURATION_SET; AWS_* credentials or the instance role
 * A half-configured mailer throws (a hosted instance must not start with mail quietly going nowhere).
 */
export function mailEnv(env: Record<string, string | undefined>): Partial<NotifyConfig['email']> | null {
  const v = (k: string) => env[`${ENV_PREFIX}_${k}`]?.trim() || undefined
  const mode = v('MAILER')
  if (!mode) return null
  const from = v('MAIL_FROM')
  const out: Partial<NotifyConfig['email']> = from ? { from } : {}
  if (mode === 'off' || mode === 'outbox') return { ...out, mode }
  if (!from) throw new Error(`${ENV_PREFIX}_MAILER=${mode} needs ${ENV_PREFIX}_MAIL_FROM`)
  if (mode === 'smtp') {
    const host = v('SMTP_HOST')
    if (!host) throw new Error(`${ENV_PREFIX}_MAILER=smtp needs ${ENV_PREFIX}_SMTP_HOST`)
    const port = Number(v('SMTP_PORT') ?? 587)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`${ENV_PREFIX}_SMTP_PORT is not a port`)
    const sec = v('SMTP_TLS') ?? (port === 465 ? 'tls' : 'starttls')
    if (!['tls', 'starttls', 'none'].includes(sec)) throw new Error(`${ENV_PREFIX}_SMTP_TLS must be starttls, tls or none`)
    const user = v('SMTP_USER')
    return { ...out, mode, smtp: { host, port, secure: sec === 'tls', starttls: sec === 'starttls', ...(user ? { user } : {}), ...(v('SMTP_PASS') ? { pass: v('SMTP_PASS') } : {}) } }
  }
  if (mode === 'ses') {
    const region = v('SES_REGION') ?? (env.AWS_REGION?.trim() || env.AWS_DEFAULT_REGION?.trim())
    if (!region || !/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) throw new Error(`${ENV_PREFIX}_MAILER=ses needs ${ENV_PREFIX}_SES_REGION (e.g. ap-northeast-2)`)
    const endpoint = v('SES_ENDPOINT'), configurationSet = v('SES_CONFIGURATION_SET')
    return { ...out, mode, ses: { region, ...(endpoint ? { endpoint } : {}), ...(configurationSet ? { configurationSet } : {}) } }
  }
  throw new Error(`${ENV_PREFIX}_MAILER must be smtp, ses, outbox or off`)
}

/** Set one dotted key (value parsed as JSON when it parses, else kept as a string). */
export function setNotifyConfig(dataDir: string, key: string, raw: string): NotifyConfig {
  let stored: Plain = {}
  try { stored = JSON.parse(fs.readFileSync(configPath(dataDir), 'utf8')) } catch {}
  let value: unknown
  try { value = JSON.parse(raw) } catch { value = raw }
  const parts = key.split('.')
  let cur = stored
  for (const p of parts.slice(0, -1)) cur = (isObj(cur[p]) ? cur[p] : (cur[p] = {})) as Plain
  cur[parts.at(-1)!] = value
  fs.writeFileSync(configPath(dataDir), JSON.stringify(stored, null, 2) + '\n', { mode: 0o600 })
  return loadNotifyConfig(dataDir)
}

/** For display: secrets masked. */
export function maskedConfig(c: NotifyConfig): NotifyConfig {
  return { ...c, email: { ...c.email, ...(c.email.smtp ? { smtp: { ...c.email.smtp, ...(c.email.smtp.pass ? { pass: '***' } : {}) } } : {}) } }
}
