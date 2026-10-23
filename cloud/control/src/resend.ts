// Resend (https://resend.com) over its HTTPS API: POST https://api.resend.com/emails with a Bearer API key. AWS did
// not give the account SES production access, so this is how the control plane's own mail (email confirmation, setup
// links, billing notices) and the teams' mail (through each host's relay, relay.ts) leave Trina Cloud by default.
//
// The key is a secret and stays one: it comes from an SSM Parameter Store SecureString read with the instance role
// (/tdcloud/control/resend-api-key on the control instance, /tdcloud/hosts/resend-api-key on the hosts) or, on a
// developer's machine, from a 0600 file (~/.config/trina-drive/resend-api-key). It is never put on a command line, in
// an env file, in a log line or in an error message (errors are redacted before they leave this file).
//
// Sending retries what is worth retrying — 429 (after Retry-After) and 5xx / network errors (backoff) — within a
// deadline, with the same Idempotency-Key on every attempt so a retry after a lost answer cannot send twice.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AwsClient, Fetch } from './aws'

export const RESEND_API = 'https://api.resend.com'
/** where a developer keeps the key (0600); also the default when no SSM parameter is configured */
export const LOCAL_KEY_FILE = path.join(os.homedir(), '.config', 'trina-drive', 'resend-api-key')

/** A secret read from an SSM SecureString (instance role) or a 0600 file, cached for a while, forgotten on demand. */
export class Secret {
  private value: string | null = null
  private at = 0
  constructor(readonly source: { param: string; aws: AwsClient } | { file: string }, private readonly ttlMs = 10 * 60_000, private readonly now: () => number = Date.now) {}

  get description() { return 'param' in this.source ? `ssm:${this.source.param}` : `file:${this.source.file}` }

  async get(): Promise<string> {
    if (this.value && this.now() - this.at < this.ttlMs) return this.value
    const v = 'param' in this.source ? await readParam(this.source.aws, this.source.param) : readSecretFile(this.source.file)
    if (!v) throw new Error(`${this.description} is empty`)
    this.value = v
    this.at = this.now()
    return v
  }

  /** after the service refused the key (rotated?): read it again next time */
  forget() { this.value = null }
}

async function readParam(aws: AwsClient, name: string): Promise<string> {
  try {
    const r = await aws.json<{ Parameter?: { Value?: string } }>('ssm', 'GetParameter', { Name: name, WithDecryption: true })
    return (r.Parameter?.Value ?? '').trim()
  } catch (e) {
    // the AWS error names the parameter and the reason, never the value
    throw new Error(`reading ${name}: ${(e as Error).message}`)
  }
}

/** The file must be readable by its owner only (like an SSH key). */
export function readSecretFile(file: string): string {
  let st: fs.Stats
  try { st = fs.statSync(file) } catch { throw new Error(`no key file ${file}`) }
  if (!st.isFile()) throw new Error(`${file} is not a file`)
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) throw new Error(`${file} is readable by others: chmod 600 ${file}`)
  return fs.readFileSync(file, 'utf8').trim()
}

export interface ResendSettings {
  /** SSM SecureString holding the API key (read with the instance role) */
  keyParam: string | null
  /** else a 0600 file */
  keyFile: string
  /** https://api.resend.com (tests: a fake) */
  endpoint: string
}

/** TDCLOUD_RESEND_API_KEY_PARAM / TDCLOUD_RESEND_API_KEY_FILE / TDCLOUD_RESEND_ENDPOINT */
export function resendSettings(env: Record<string, string | undefined>): ResendSettings {
  const keyParam = env.TDCLOUD_RESEND_API_KEY_PARAM || null
  if (keyParam && !/^\/[A-Za-z0-9_.\-/]+$/.test(keyParam)) throw new Error('TDCLOUD_RESEND_API_KEY_PARAM must be an SSM parameter name like /tdcloud/hosts/resend-api-key')
  const endpoint = (env.TDCLOUD_RESEND_ENDPOINT || RESEND_API).replace(/\/$/, '')
  if (!/^https?:\/\//.test(endpoint)) throw new Error('TDCLOUD_RESEND_ENDPOINT must be an http(s) URL')
  return { keyParam, keyFile: env.TDCLOUD_RESEND_API_KEY_FILE || LOCAL_KEY_FILE, endpoint }
}

export const resendSecret = (s: Pick<ResendSettings, 'keyParam' | 'keyFile'>, aws: AwsClient) =>
  new Secret(s.keyParam ? { param: s.keyParam, aws } : { file: s.keyFile })

export class ResendError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

export interface ResendMail {
  /** "Name <address>" in a domain verified in Resend */
  from: string
  to: string
  subject: string
  text: string
  html?: string
  /** Resend tags (ASCII letters, digits, _ and - only): where the mail came from, for the Resend log */
  tags?: Record<string, string>
}

export interface ResendOptions {
  key: Pick<Secret, 'get' | 'forget'>
  endpoint?: string
  fetch?: Fetch
  /** attempts in all (1 = no retry) */
  attempts?: number
  /** give up when the next try would start after this many ms (the relay answers a team that waits ~15 s) */
  deadlineMs?: number
  /** per attempt */
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

const TAG_RE = /^[A-Za-z0-9_-]{1,256}$/

export class ResendClient {
  private readonly endpoint: string
  private readonly fetchImpl: Fetch
  private readonly attempts: number
  private readonly deadlineMs: number
  private readonly timeoutMs: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number

  constructor(private readonly o: ResendOptions) {
    this.endpoint = (o.endpoint ?? RESEND_API).replace(/\/$/, '')
    this.fetchImpl = o.fetch ?? fetch
    this.attempts = Math.max(1, o.attempts ?? 4)
    this.deadlineMs = o.deadlineMs ?? 30_000
    this.timeoutMs = o.timeoutMs ?? 10_000
    this.sleep = o.sleep ?? ((ms) => Bun.sleep(ms))
    this.now = o.now ?? Date.now
  }

  /** Sends one message; returns Resend's id. Throws ResendError (status 0: no answer) with the key redacted. */
  async send(m: ResendMail): Promise<string> {
    const tags = Object.entries(m.tags ?? {}).filter(([k, v]) => TAG_RE.test(k) && TAG_RE.test(v)).map(([name, value]) => ({ name, value }))
    const body = JSON.stringify({ from: m.from, to: [m.to], subject: m.subject, text: m.text, ...(m.html !== undefined ? { html: m.html } : {}), ...(tags.length ? { tags } : {}) })
    const idempotencyKey = `tdcloud-${crypto.randomUUID()}`
    const start = this.now()
    let key = ''
    for (let attempt = 1; ; attempt++) {
      let wait: number
      let err: ResendError
      try {
        key = await this.o.key.get()
        const res = await this.fetchImpl(`${this.endpoint}/emails`, {
          method: 'POST', body, signal: AbortSignal.timeout(this.timeoutMs),
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'idempotency-key': idempotencyKey, 'user-agent': 'trina-cloud/0.1' },
        })
        const text = await res.text()
        if (res.ok) {
          let id: unknown
          try { id = (JSON.parse(text) as { id?: unknown }).id } catch { /* not JSON */ }
          return typeof id === 'string' ? id : '?'
        }
        err = new ResendError(res.status, redact(`resend: ${res.status} ${text.slice(0, 300)}`, key))
        if (res.status === 401 || res.status === 403) { this.o.key.forget(); throw err }
        if (res.status !== 429 && res.status < 500) throw err
        wait = res.status === 429 ? retryAfterMs(res.headers) ?? 1000 * attempt : 500 * 2 ** (attempt - 1)
      } catch (e) {
        if (e instanceof ResendError) throw e
        // network error, timeout, unreadable key: the message is ours or the runtime's, redacted all the same
        err = new ResendError(0, redact(`resend: ${(e as Error).message}`, key))
        if (!key) throw err
        wait = 500 * 2 ** (attempt - 1)
      }
      if (attempt >= this.attempts || this.now() - start + wait > this.deadlineMs) throw err
      await this.sleep(wait)
    }
  }
}

/** Retry-After (seconds or an HTTP date) or Resend's ratelimit-reset (seconds), in ms; capped at 10 s. */
function retryAfterMs(h: Headers): number | null {
  for (const name of ['retry-after', 'ratelimit-reset']) {
    const v = h.get(name)
    if (!v) continue
    const s = Number(v)
    const ms = Number.isFinite(s) ? s * 1000 : Date.parse(v) - Date.now()
    if (Number.isFinite(ms)) return Math.min(10_000, Math.max(0, ms))
  }
  return null
}

/** The key, and anything that looks like a Resend key, out of a message. */
export function redact(s: string, key?: string): string {
  let out = key && key.length >= 8 ? s.split(key).join('[redacted]') : s
  out = out.replace(/\bre_[A-Za-z0-9_]{8,}/g, 're_[redacted]')
  return out
}
