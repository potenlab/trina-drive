import crypto from 'node:crypto'

export const sha256 = (data: string | Uint8Array) => crypto.createHash('sha256').update(data).digest('hex')
export const random = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url')
export const now = () => Date.now()
export const DAY = 86400_000
export const HOUR = 3600_000

export function timingSafeEqualStr(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

/** A short public id for rows shown in URLs (never the integer id). */
export const publicId = (prefix: string) => `${prefix}_${crypto.randomBytes(10).toString('hex')}`

export const iso = (ms: number | null | undefined) => (ms == null ? '-' : new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z'))

/** POSIX shell single-quoting (commands sent to hosts through SSM). */
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

export const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/
