// TOTP (RFC 6238 over RFC 4226 HOTP): HMAC-SHA1, 6 digits, 30-second steps — what every authenticator app does by
// default. Pure functions; replay protection (each step used once per person) lives with the stored secret (mfa.ts).
import crypto from 'node:crypto'

export const TOTP_STEP_S = 30
export const TOTP_DIGITS = 6
/** Steps accepted on either side of now (clock drift): ±1 step = a 90-second window. */
export const TOTP_WINDOW = 1

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(b: Uint8Array): string {
  let bits = 0, value = 0, out = ''
  for (const byte of b) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5 }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(s: string): Uint8Array {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '')
  let bits = 0, value = 0
  const out: number[] = []
  for (const c of clean) {
    const i = B32.indexOf(c)
    if (i < 0) throw new Error('bad base32')
    value = (value << 5) | i
    bits += 5
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8 }
  }
  return Uint8Array.from(out)
}

/** A new 160-bit secret (RFC 4226 recommends at least 128 bits; 160 matches SHA-1's block use). */
export const newTotpSecret = () => base32Encode(crypto.randomBytes(20))

/** HOTP value for one counter (RFC 4226 §5.3 dynamic truncation). */
export function hotp(secret: Uint8Array, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter))
  const h = crypto.createHmac('sha1', secret).update(msg).digest()
  const off = h[h.length - 1]! & 0x0f
  const bin = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!
  return String(bin % 10 ** digits).padStart(digits, '0')
}

export const stepAt = (ms: number) => Math.floor(ms / 1000 / TOTP_STEP_S)
export const totpAt = (secretB32: string, ms: number, digits = TOTP_DIGITS) => hotp(base32Decode(secretB32), stepAt(ms), digits)

/**
 * The step a presented code belongs to (within ±TOTP_WINDOW of `ms`), or null. Compared in constant time per step.
 * The caller must refuse a step at or below the last one it accepted (replay).
 */
export function matchTotp(secretB32: string, code: unknown, ms: number): number | null {
  if (typeof code !== 'string') return null
  const c = code.replace(/\s/g, '')
  if (!/^\d{6}$/.test(c)) return null
  const key = base32Decode(secretB32)
  const now = stepAt(ms)
  let found: number | null = null
  for (let s = now - TOTP_WINDOW; s <= now + TOTP_WINDOW; s++) {
    if (crypto.timingSafeEqual(Buffer.from(hotp(key, s)), Buffer.from(c)) && found === null) found = s
  }
  return found
}

/** otpauth:// URI for authenticator apps (shown as text; the web app may render it as a QR code). */
export function otpauthUri(issuer: string, account: string, secretB32: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`)
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_S}`
}
