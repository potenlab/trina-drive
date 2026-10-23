// Wrapping small secrets the control plane must keep (each team's backup SECRET key, so we can restore or export for
// the customer). Production: AWS KMS (the key never leaves KMS; the encryption context binds a ciphertext to its team).
// Dev and tests: AES-256-GCM under a local 32-byte master key file (0600). Setup tokens are never kept at all.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { AwsClient } from './aws'

export interface KeyWrapper {
  readonly kind: string
  wrap(plaintext: Uint8Array, context: Record<string, string>): Promise<string>
  unwrap(wrapped: string, context: Record<string, string>): Promise<Uint8Array>
}

const aad = (ctx: Record<string, string>) => Buffer.from(JSON.stringify(Object.entries(ctx).sort(([a], [b]) => (a < b ? -1 : 1))))

export class LocalKeyWrapper implements KeyWrapper {
  readonly kind = 'local'
  private readonly key: Buffer
  constructor(key: Uint8Array) {
    if (key.length !== 32) throw new Error('master key must be 32 bytes')
    this.key = Buffer.from(key)
  }
  /** Reads the key file (base64), creating it (0600) when missing. */
  static fromFile(file: string): LocalKeyWrapper {
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      fs.writeFileSync(file, crypto.randomBytes(32).toString('base64') + '\n', { mode: 0o600, flag: 'wx' })
    }
    const st = fs.statSync(file)
    if ((st.mode & 0o077) !== 0) throw new Error(`${file} must not be readable by group or others (chmod 600)`)
    return new LocalKeyWrapper(Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64'))
  }
  async wrap(plaintext: Uint8Array, context: Record<string, string>) {
    const iv = crypto.randomBytes(12)
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv)
    c.setAAD(aad(context))
    const ct = Buffer.concat([c.update(plaintext), c.final()])
    return `l1.${iv.toString('base64url')}.${ct.toString('base64url')}.${c.getAuthTag().toString('base64url')}`
  }
  async unwrap(wrapped: string, context: Record<string, string>) {
    const [v, iv, ct, tag] = wrapped.split('.')
    if (v !== 'l1' || !iv || !ct || !tag) throw new Error('not a local-wrapped value')
    const d = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'))
    d.setAAD(aad(context))
    d.setAuthTag(Buffer.from(tag, 'base64url'))
    return new Uint8Array(Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]))
  }
}

export class KmsKeyWrapper implements KeyWrapper {
  readonly kind = 'kms'
  constructor(private readonly aws: AwsClient, private readonly keyId: string) {}
  async wrap(plaintext: Uint8Array, context: Record<string, string>) { return `k1.${await this.aws.kmsEncrypt(this.keyId, plaintext, context)}` }
  async unwrap(wrapped: string, context: Record<string, string>) {
    if (!wrapped.startsWith('k1.')) throw new Error('not a KMS-wrapped value')
    return this.aws.kmsDecrypt(wrapped.slice(3), context)
  }
}

export const hashPassword = (pw: string) => Bun.password.hash(pw, { algorithm: 'argon2id' })
let dummy: Promise<string> | null = null
/** Same work for unknown accounts, so a wrong email and a wrong password take the same time. */
export async function verifyPassword(pw: string, hash: string | null | undefined): Promise<boolean> {
  if (!hash) { dummy ??= hashPassword(crypto.randomBytes(16).toString('hex')); await Bun.password.verify(pw, await dummy).catch(() => false); return false }
  return Bun.password.verify(pw, hash).catch(() => false)
}
