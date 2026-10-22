// Notify settings: <data dir>/notify.json (created with defaults on first use). Secrets (SMTP password, webhooks)
// stay in the data directory (0700); $<NAME>_SMTP_PASS overrides the stored SMTP password.
import fs from 'node:fs'
import path from 'node:path'
import { ENV_PREFIX } from '../config'
import type { Lang } from './messages'

export interface NotifyConfig {
  /** where links in messages point (the web UI) */
  baseUrl: string
  /** default language for people without one */
  lang: Lang
  email: {
    mode: 'off' | 'outbox' | 'smtp'
    from: string
    /** outbox mode: directory for .eml files (default <data>/outbox) */
    outboxDir?: string
    smtp?: { host: string; port: number; secure?: boolean; user?: string; pass?: string }
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
  email: { mode: 'outbox', from: 'shelf@localhost' },
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

export function loadNotifyConfig(dataDir: string, override: Partial<NotifyConfig> = {}): NotifyConfig {
  let stored: unknown = {}
  try { stored = JSON.parse(fs.readFileSync(configPath(dataDir), 'utf8')) } catch (e) { if ((e as { code?: string }).code !== 'ENOENT') throw e }
  const c = merge(merge(DEFAULT_NOTIFY, stored), override)
  const pass = process.env[`${ENV_PREFIX}_SMTP_PASS`]
  if (pass && c.email.smtp) c.email.smtp = { ...c.email.smtp, pass }
  return c
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
