// Backup encryption (docs/BACKUP-FORMAT.md): age-like public-key encryption so the server can make backups without
// being able to read them. The server keeps only the public key (the "recipient"); the secret key is shown to the
// administrator once and never stored on the server.
//
//   X25519 (ephemeral-static) -> HKDF-SHA256 -> AES-256-GCM wraps a random 32-byte file key (header authenticated as AAD)
//   file key -> HKDF-SHA256 (random salt) -> payload key -> AES-256-GCM STREAM in 64 KiB chunks
//   chunk nonce = 11-byte big-endian counter || 1 byte "last chunk" flag, so truncation, reordering and appended data fail
//
// node:crypto (BoringSSL inside Bun) is used rather than crypto.subtle because it is synchronous, which keeps the
// streaming code simple; the primitives are the same.
import crypto from 'node:crypto'
import fs from 'node:fs'
import { NAME } from '../config'

export class BackupError extends Error {
  constructor(readonly code: 'format' | 'wrong-key' | 'tampered' | 'truncated' | 'unsafe' | 'config' | 'io', message: string) {
    super(message)
  }
}

export const MAGIC = Uint8Array.from([0x89, 0x42, 0x4b, 0x50, 0x0d, 0x0a, 0x1a, 0x0a]) // \x89 B K P \r \n \x1a \n
export const FORMAT_VERSION = 1
export const SUITE_X25519_AESGCM = 1
export const CHUNK_LOG2 = 16
export const CHUNK = 1 << CHUNK_LOG2
const TAG = 16
export const HEADER_LEN = 124
const AAD_LEN = 76 // header bytes covered by the wrap tag (everything before the wrapped key)

const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex')
const SPKI_X25519 = Buffer.from('302a300506032b656e032100', 'hex')
const SECRET_TAG = '_bksec1_'
const PUBLIC_TAG = '_bkpub1_'

export interface SecretKey { secret: Uint8Array; publicKey: Uint8Array }

const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url')
const sha256 = (...parts: Uint8Array[]) => { const h = crypto.createHash('sha256'); for (const p of parts) h.update(p); return new Uint8Array(h.digest()) }
const checksum = (secret: Uint8Array) => b64u(sha256(new TextEncoder().encode('bksec1'), secret)).slice(0, 6)

function privateKeyObject(secret: Uint8Array) {
  return crypto.createPrivateKey({ key: Buffer.concat([PKCS8_X25519, secret]), format: 'der', type: 'pkcs8' })
}
function publicKeyObject(pub: Uint8Array) {
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_X25519, pub]), format: 'der', type: 'spki' })
}
function rawPublic(key: crypto.KeyObject): Uint8Array {
  const der = (key.type === 'private' ? crypto.createPublicKey(key) : key).export({ format: 'der', type: 'spki' })
  return new Uint8Array(der.subarray(der.length - 32))
}

export function generateKey(): { secretText: string; publicText: string; key: SecretKey } {
  const { privateKey } = crypto.generateKeyPairSync('x25519')
  const der = privateKey.export({ format: 'der', type: 'pkcs8' })
  const secret = new Uint8Array(der.subarray(der.length - 32))
  const key = { secret, publicKey: rawPublic(privateKey) }
  return { secretText: formatSecret(secret), publicText: formatPublic(key.publicKey), key }
}

export const formatSecret = (secret: Uint8Array) => `${NAME}${SECRET_TAG}${b64u(secret)}${checksum(secret)}`
export const formatPublic = (pub: Uint8Array) => `${NAME}${PUBLIC_TAG}${b64u(pub)}`

/** Key id: the first 16 bytes of SHA-256(public key). Its first 8 bytes in hex are the fingerprint people compare. */
export const keyId = (pub: Uint8Array) => sha256(pub).subarray(0, 16)
export const fingerprint = (pub: Uint8Array) => Buffer.from(keyId(pub).subarray(0, 8)).toString('hex').replace(/(.{4})(?!$)/g, '$1-')

export function parseSecret(text: string): SecretKey {
  const m = /^([a-z0-9-]+)_bksec1_([A-Za-z0-9_-]{43})([A-Za-z0-9_-]{6})$/.exec(text.trim())
  if (!m) throw new BackupError('format', 'that is not a backup secret key (it starts with "<name>_bksec1_")')
  const secret = new Uint8Array(Buffer.from(m[2]!, 'base64url'))
  if (secret.length !== 32 || checksum(secret) !== m[3]) throw new BackupError('format', 'the backup secret key has a typo (checksum mismatch)')
  return { secret, publicKey: rawPublic(privateKeyObject(secret)) }
}

export function parsePublic(text: string): Uint8Array {
  const m = /^([a-z0-9-]+)_bkpub1_([A-Za-z0-9_-]{43})$/.exec(text.trim())
  if (!m) throw new BackupError('format', 'that is not a backup public key (it starts with "<name>_bkpub1_")')
  const pub = new Uint8Array(Buffer.from(m[2]!, 'base64url'))
  if (pub.length !== 32) throw new BackupError('format', 'bad backup public key length')
  publicKeyObject(pub) // throws on an invalid point encoding
  return pub
}

function hkdf(ikm: Uint8Array, salt: Uint8Array, info: string): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, 32))
}

function chunkNonce(counter: number, last: boolean): Buffer {
  const n = Buffer.alloc(12)
  // 11-byte counter; 2^53 chunks is far beyond any archive, so the high bytes stay 0
  n.writeUIntBE(counter, 5, 6)
  n[11] = last ? 1 : 0
  return n
}

function gcmSeal(key: Buffer, nonce: Buffer, plain: Uint8Array, aad?: Uint8Array): Buffer {
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce)
  if (aad) c.setAAD(aad)
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()])
}
function gcmOpen(key: Buffer, nonce: Buffer, sealed: Uint8Array, aad?: Uint8Array): Buffer | null {
  if (sealed.length < TAG) return null
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, nonce)
    if (aad) d.setAAD(aad)
    d.setAuthTag(sealed.subarray(sealed.length - TAG))
    return Buffer.concat([d.update(sealed.subarray(0, sealed.length - TAG)), d.final()])
  } catch {
    return null
  }
}

/** Streaming encryptor. `sink` receives the header first, then sealed chunks. */
export class Encryptor {
  private buf: Buffer[] = []
  private buffered = 0
  private counter = 0
  private closed = false
  private readonly payloadKey: Buffer
  bytesOut = 0

  constructor(private readonly sink: (b: Uint8Array) => void, recipient: Uint8Array) {
    const eph = crypto.generateKeyPairSync('x25519')
    const ephPub = rawPublic(eph.privateKey)
    const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: publicKeyObject(recipient) })
    const fileKey = crypto.randomBytes(32)
    const salt = crypto.randomBytes(16)
    const head = Buffer.alloc(HEADER_LEN)
    head.set(MAGIC, 0)
    head[8] = FORMAT_VERSION
    head[9] = SUITE_X25519_AESGCM
    head[10] = CHUNK_LOG2
    head[11] = 0
    head.set(keyId(recipient), 12)
    head.set(ephPub, 28)
    head.set(salt, 60)
    const wrapKey = hkdf(shared, Buffer.concat([ephPub, recipient]), 'bkp/v1 wrap')
    head.set(gcmSeal(wrapKey, Buffer.alloc(12), fileKey, head.subarray(0, AAD_LEN)), AAD_LEN)
    this.payloadKey = hkdf(fileKey, salt, 'bkp/v1 payload')
    fileKey.fill(0)
    this.emit(head)
  }

  private emit(b: Uint8Array) { this.sink(b); this.bytesOut += b.length }

  write(data: Uint8Array) {
    if (this.closed) throw new Error('write after close')
    if (!data.length) return
    if (this.buffered + data.length <= CHUNK) {
      // copied: callers may reuse their buffer
      this.buf.push(Buffer.from(data))
      this.buffered += data.length
      return
    }
    // keep at least one byte back: which chunk is the last one is only known at close()
    const all = Buffer.concat([...this.buf, data])
    let off = 0
    while (all.length - off > CHUNK) {
      this.emit(gcmSeal(this.payloadKey, chunkNonce(this.counter++, false), all.subarray(off, off + CHUNK)))
      off += CHUNK
    }
    this.buf = [Buffer.from(all.subarray(off))]
    this.buffered = all.length - off
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.emit(gcmSeal(this.payloadKey, chunkNonce(this.counter++, true), Buffer.concat(this.buf)))
    this.buf = []
    this.payloadKey.fill(0)
  }
}

export interface HeaderInfo { version: number; suite: number; keyId: Uint8Array; fingerprintHint: string }

/** Read and check the header of an encrypted file without a key (format, version, which key it is for). */
export function readHeader(head: Uint8Array): HeaderInfo {
  if (head.length < HEADER_LEN) throw new BackupError('truncated', 'the file is shorter than a backup header')
  if (!MAGIC.every((b, i) => head[i] === b)) throw new BackupError('format', 'not an encrypted backup (bad magic bytes)')
  if (head[8] !== FORMAT_VERSION) throw new BackupError('format', `backup format version ${head[8]} is not supported by this version (it reads ${FORMAT_VERSION})`)
  if (head[9] !== SUITE_X25519_AESGCM || head[10] !== CHUNK_LOG2 || head[11] !== 0) throw new BackupError('format', 'unknown backup cipher suite')
  const id = head.slice(12, 28)
  return { version: head[8]!, suite: head[9]!, keyId: id, fingerprintHint: Buffer.from(id.subarray(0, 8)).toString('hex').replace(/(.{4})(?!$)/g, '$1-') }
}

/**
 * Decrypt a file chunk by chunk. Yields plaintext pieces; throws BackupError on a wrong key, any modified byte,
 * a missing last chunk (truncation) or bytes after it.
 */
export function* decryptFile(file: string, key: SecretKey): Generator<Uint8Array> {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const head = Buffer.alloc(HEADER_LEN)
    const got = fs.readSync(fd, head, 0, Math.min(HEADER_LEN, size), 0)
    if (got >= MAGIC.length && !MAGIC.every((b, i) => head[i] === b)) throw new BackupError('format', 'not an encrypted backup (bad magic bytes)')
    if (got < HEADER_LEN) throw new BackupError('truncated', 'the file is shorter than a backup header')
    const h = readHeader(head)
    const mine = keyId(key.publicKey)
    if (!Buffer.from(h.keyId).equals(Buffer.from(mine))) {
      throw new BackupError('wrong-key', `this backup was made for key ${h.fingerprintHint}, not for the key you gave (${fingerprint(key.publicKey)})`)
    }
    const ephPub = head.subarray(28, 60)
    const salt = head.subarray(60, 76)
    const shared = crypto.diffieHellman({ privateKey: privateKeyObject(key.secret), publicKey: publicKeyObject(ephPub) })
    const wrapKey = hkdf(shared, Buffer.concat([ephPub, key.publicKey]), 'bkp/v1 wrap')
    const fileKey = gcmOpen(wrapKey, Buffer.alloc(12), head.subarray(AAD_LEN, HEADER_LEN), head.subarray(0, AAD_LEN))
    if (!fileKey) throw new BackupError('wrong-key', 'the backup key does not open this file (wrong key, or the header was changed)')
    const payloadKey = hkdf(fileKey, salt, 'bkp/v1 payload')
    fileKey.fill(0)

    const sealedChunk = CHUNK + TAG
    let pos = HEADER_LEN
    let counter = 0
    const buf = Buffer.alloc(sealedChunk)
    for (;;) {
      const left = size - pos
      if (left < TAG) throw new BackupError('truncated', `the backup is cut short (${left} stray bytes where a chunk should start)`)
      const last = left <= sealedChunk
      const n = last ? left : sealedChunk
      if (fs.readSync(fd, buf, 0, n, pos) !== n) throw new BackupError('io', 'short read')
      const plain = gcmOpen(payloadKey, chunkNonce(counter, last), buf.subarray(0, n))
      if (!plain) {
        // a full-size chunk that only opens as "not last" means the rest of the file is missing
        if (last && n === sealedChunk && gcmOpen(payloadKey, chunkNonce(counter, false), buf.subarray(0, n))) {
          throw new BackupError('truncated', 'the backup is cut short (its last part is missing)')
        }
        throw new BackupError('tampered', `the backup was changed or damaged (chunk ${counter} does not authenticate)`)
      }
      counter++
      pos += n
      if (plain.length) yield plain
      if (last) break
    }
    payloadKey.fill(0)
  } finally {
    fs.closeSync(fd)
  }
}
