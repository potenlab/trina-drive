// Per-team backup encryption for the team's files (the product's own `backup run` covers its database and drafts with
// the product's key; the files of the volume are sealed here). Public-key, so the host that makes a backup never holds
// a key that can read one: X25519 (ephemeral ⨯ team key) → HKDF-SHA256 → AES-256-GCM in 1 MiB records, each record's
// nonce = 8-byte random prefix ‖ record counter, the last record marked in its additional data (a cut-off file fails).
//
//   file  = "TDCB1\n" ‖ ephemeral public key (32) ‖ nonce prefix (8) ‖ record*
//   record = u32be length ‖ AES-GCM(ciphertext ‖ tag), AAD = "tdcb1" ‖ u8 last
import crypto from 'node:crypto'

const MAGIC = Buffer.from('TDCB1\n')
const RECORD = 1024 * 1024
const PUB = 'tdcpub1.', SEC = 'tdcsec1.'

export interface TeamBackupKey { publicKey: string; secretKey: string }

export function generateTeamKey(): TeamBackupKey {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519')
  const pub = publicKey.export({ format: 'jwk' }) as { x: string }
  const sec = privateKey.export({ format: 'jwk' }) as { d: string }
  return { publicKey: PUB + pub.x, secretKey: SEC + sec.d }
}

const rawPub = (s: string) => {
  if (!s.startsWith(PUB)) throw new Error('not a team backup public key')
  const b = Buffer.from(s.slice(PUB.length), 'base64url')
  if (b.length !== 32) throw new Error('bad public key length')
  return b
}
const pubKeyObj = (raw: Buffer) => crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: raw.toString('base64url') }, format: 'jwk' })
const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex')
const secKeyObj = (s: string) => {
  if (!s.startsWith(SEC)) throw new Error('not a team backup secret key')
  const d = Buffer.from(s.slice(SEC.length), 'base64url')
  if (d.length !== 32) throw new Error('bad secret key length')
  const priv = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_X25519, d]), format: 'der', type: 'pkcs8' })
  const pub = Buffer.from((crypto.createPublicKey(priv).export({ format: 'jwk' }) as { x: string }).x, 'base64url')
  return { priv, pub }
}
/** The public key that belongs to a secret key (checks a stored pair). */
export const publicOf = (secretKey: string) => PUB + secKeyObj(secretKey).pub.toString('base64url')

const deriveKey = (shared: Buffer, eph: Buffer, recipient: Buffer) =>
  Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.concat([eph, recipient]), 'tdcloud backup v1', 32))

const nonce = (prefix: Buffer, n: number) => { const b = Buffer.alloc(12); prefix.copy(b, 0); b.writeUInt32BE(n, 8); return b }
const aad = (last: boolean) => Buffer.concat([Buffer.from('tdcb1'), Buffer.from([last ? 1 : 0])])

/** Encrypts a byte stream to the team's public key. */
export async function seal(input: AsyncIterable<Uint8Array>, write: (b: Uint8Array) => void | Promise<void>, recipient: string) {
  const r = rawPub(recipient)
  const eph = crypto.generateKeyPairSync('x25519')
  const ephRaw = Buffer.from((eph.publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url')
  const key = deriveKey(crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: pubKeyObj(r) }), ephRaw, r)
  const prefix = crypto.randomBytes(8)
  await write(Buffer.concat([MAGIC, ephRaw, prefix]))
  let n = 0
  let buf = Buffer.alloc(0)
  const emit = async (chunk: Buffer, last: boolean) => {
    if (n === 0xffffffff) throw new Error('backup too large')
    const c = crypto.createCipheriv('aes-256-gcm', key, nonce(prefix, n++))
    c.setAAD(aad(last))
    const ct = Buffer.concat([c.update(chunk), c.final(), c.getAuthTag()])
    const len = Buffer.alloc(4); len.writeUInt32BE(ct.length)
    await write(Buffer.concat([len, ct]))
  }
  for await (const piece of input) {
    buf = Buffer.concat([buf, Buffer.from(piece)])
    while (buf.length > RECORD) { await emit(buf.subarray(0, RECORD), false); buf = buf.subarray(RECORD) }
  }
  await emit(buf, true)
}

/** Decrypts (and authenticates every record, and that the stream was not cut short). */
export async function unseal(input: AsyncIterable<Uint8Array>, write: (b: Uint8Array) => void | Promise<void>, secretKey: string) {
  const { priv, pub } = secKeyObj(secretKey)
  let buf = Buffer.alloc(0)
  let key: Buffer | null = null, prefix: Buffer | null = null
  let n = 0, sawLast = false
  const take = async function* () { for await (const p of input) yield Buffer.from(p) }
  for await (const piece of take()) {
    buf = Buffer.concat([buf, piece])
    if (!key) {
      if (buf.length < MAGIC.length + 40) continue
      if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not a sealed team backup')
      const eph = buf.subarray(MAGIC.length, MAGIC.length + 32)
      prefix = Buffer.from(buf.subarray(MAGIC.length + 32, MAGIC.length + 40))
      key = deriveKey(crypto.diffieHellman({ privateKey: priv, publicKey: pubKeyObj(Buffer.from(eph)) }), Buffer.from(eph), pub)
      buf = buf.subarray(MAGIC.length + 40)
    }
    for (;;) {
      if (buf.length < 4) break
      const len = buf.readUInt32BE(0)
      if (len < 16 || len > RECORD + 16) throw new Error('corrupt record length')
      if (buf.length < 4 + len) break
      if (sawLast) throw new Error('data after the last record')
      const rec = buf.subarray(4, 4 + len)
      buf = buf.subarray(4 + len)
      const pt = openRecord(key, prefix!, n++, rec)
      sawLast = pt.last
      await write(pt.data)
    }
  }
  if (!key) throw new Error('not a sealed team backup (too short)')
  if (buf.length) throw new Error('trailing bytes after the last record')
  if (!sawLast) throw new Error('backup is truncated (no final record)')
}

function openRecord(key: Buffer, prefix: Buffer, n: number, rec: Buffer): { data: Buffer; last: boolean } {
  for (const last of [false, true]) {
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', key, nonce(prefix, n))
      d.setAAD(aad(last))
      d.setAuthTag(rec.subarray(rec.length - 16))
      return { data: Buffer.concat([d.update(rec.subarray(0, rec.length - 16)), d.final()]), last }
    } catch { /* try the other flag */ }
  }
  throw new Error(`record ${n} failed authentication`)
}
