// RFC 6238 TOTP (HMAC-SHA1, 30 s steps, 6 digits), written here rather than taken from the product or the console.
import crypto from 'node:crypto'
import fs from 'node:fs'

export function totp(secretB32: string, ms = Date.now()): string {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''
  for (const ch of secretB32.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase()) {
    const v = A.indexOf(ch)
    if (v < 0) throw new Error('not base32')
    bits += v.toString(2).padStart(5, '0')
  }
  const key = Buffer.from(Array.from({ length: Math.floor(bits.length / 8) }, (_, i) => parseInt(bits.slice(i * 8, i * 8 + 8), 2)))
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(ms / 30_000)))
  const h = crypto.createHmac('sha1', key).update(counter).digest()
  const o = h[19]! & 0xf
  const bin = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!
  return String(bin % 1_000_000).padStart(6, '0')
}

/**
 * A code nobody has used yet for this secret: servers refuse a code twice (replay), so successive sign-ins in one
 * run take the next 30 s step's code — accepted within the usual ±1 step window — and wait for a fresh step after that.
 */
const lastStep = new Map<string, number>()
let store: string | null = null
/** remember used steps in a file too, so a code used by the previous run (same 30 s) is not offered again */
export function useTotpStore(file: string) {
  store = file
  try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, number>)) lastStep.set(k, v) } catch { /* none yet */ }
}
const key = (secret: string) => crypto.createHash('sha256').update(secret).digest('hex').slice(0, 16)
export async function freshTotp(secret: string): Promise<string> {
  for (;;) {
    const now = Date.now()
    const step = Math.floor(now / 30_000)
    const last = lastStep.get(key(secret)) ?? -Infinity
    for (const s of [step, step + 1]) {
      if (s > last) {
        lastStep.set(key(secret), s)
        if (store) try { fs.writeFileSync(store, JSON.stringify(Object.fromEntries(lastStep)), { mode: 0o600 }) } catch { /* best effort */ }
        return totp(secret, s * 30_000)
      }
    }
    await Bun.sleep(((step + 1) * 30_000 - now) + 200)
  }
}
