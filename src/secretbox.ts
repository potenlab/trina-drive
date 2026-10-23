// Small secrets the server must be able to use again later (people's Google refresh tokens), encrypted at rest.
// Passwords, tokens and app passwords are only ever hashed; these cannot be, because the server presents them to
// someone else. The key is the install's data key: $TDRIVE_SECRET_KEY (32 bytes, base64 or hex; set it in Trina Cloud
// from the operator's secret store), or else <data>/keys/data.key, made (0600, in a 0700 folder) on first use the way
// the audit anchor key is (src/notify/anchor.ts). Backups carry the database, never this key: a restored database
// cannot decrypt these values until the same key is put back (or people connect again).
//
//   sealed = "sb1." base64url(12-byte nonce) "." base64url(AES-256-GCM ciphertext || 16-byte tag)
//   AAD    = the purpose string (e.g. "gdrive:refresh:17"): a value copied into another row or another person's row
//            does not open.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ENV_PREFIX } from './config'

export class SecretBoxError extends Error {}

const cache = new Map<string, Buffer>()

function parseKey(text: string): Buffer {
  const t = text.trim()
  const b = /^[0-9a-fA-F]{64}$/.test(t) ? Buffer.from(t, 'hex') : Buffer.from(t, 'base64')
  if (b.length !== 32) throw new SecretBoxError(`${ENV_PREFIX}_SECRET_KEY must be 32 bytes (64 hex characters or base64)`)
  return b
}

/** The install's data key (made on first use unless it comes from the environment). */
export function dataKey(dataDir: string): Buffer {
  const env = process.env[`${ENV_PREFIX}_SECRET_KEY`]
  if (env) return parseKey(env)
  const file = path.join(dataDir, 'keys', 'data.key')
  const hit = cache.get(file)
  if (hit) return hit
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    try { fs.writeFileSync(file, crypto.randomBytes(32).toString('base64') + '\n', { mode: 0o600, flag: 'wx' }) } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e // another process made it first: use theirs
    }
  }
  const key = parseKey(fs.readFileSync(file, 'utf8'))
  cache.set(file, key)
  return key
}

export function seal(key: Buffer, purpose: string, plain: string): string {
  const nonce = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce)
  c.setAAD(Buffer.from(purpose))
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final(), c.getAuthTag()])
  return `sb1.${nonce.toString('base64url')}.${body.toString('base64url')}`
}

/** The plaintext, or an error when the value was made with another key, for another purpose, or changed. */
export function open(key: Buffer, purpose: string, sealed: string): string {
  const m = /^sb1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{22,})$/.exec(sealed)
  if (!m) throw new SecretBoxError('not a sealed value')
  const nonce = Buffer.from(m[1]!, 'base64url'), body = Buffer.from(m[2]!, 'base64url')
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, nonce)
    d.setAAD(Buffer.from(purpose))
    d.setAuthTag(body.subarray(body.length - 16))
    return Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()]).toString('utf8')
  } catch {
    throw new SecretBoxError('this value cannot be opened with this server\'s data key (another key, another purpose, or changed)')
  }
}
