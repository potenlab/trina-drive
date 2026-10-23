// A software passkey (WebAuthn, ES256, "none" attestation, user verified) so HTTP scenarios can register a passkey and
// answer step-ups the way a browser with a platform authenticator would. The browser flows use Chromium's virtual
// authenticator instead. Nothing here is trusted by the server beyond what WebAuthn verification checks.
import crypto from 'node:crypto'

// ---- minimal CBOR encoder (major types 0, 1, 2, 3, 4, 5)
function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n])
  if (n < 256) return Buffer.from([(major << 5) | 24, n])
  if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b }
  const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b
}
type Cbor = number | string | Uint8Array | Cbor[] | Map<Cbor, Cbor> | { [k: string]: Cbor }
export function cbor(v: Cbor): Buffer {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v)
  if (typeof v === 'string') { const b = Buffer.from(v, 'utf8'); return Buffer.concat([head(3, b.length), b]) }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)])
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)])
  const entries = v instanceof Map ? [...v] : Object.entries(v)
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, x]) => [cbor(k as Cbor), cbor(x)])])
}

const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url')
const sha = (b: Uint8Array | string) => crypto.createHash('sha256').update(b).digest()

export class SoftPasskey {
  private key = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
  readonly credId = crypto.randomBytes(16)
  private count = 0
  constructor(public origin: string) {}

  private cose(): Buffer {
    const jwk = this.key.publicKey.export({ format: 'jwk' }) as { x: string; y: string }
    return cbor(new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]))
  }
  private authData(rpId: string, attested: boolean): Buffer {
    const flags = 0x01 | 0x04 | (attested ? 0x40 : 0) // user present, user verified, attested credential data
    const c = Buffer.alloc(4); c.writeUInt32BE(++this.count)
    const parts = [sha(rpId), Buffer.from([flags]), c]
    if (attested) { const len = Buffer.alloc(2); len.writeUInt16BE(this.credId.length); parts.push(Buffer.alloc(16), len, this.credId, this.cose()) }
    return Buffer.concat(parts)
  }
  private clientData(type: string, challenge: string) {
    return Buffer.from(JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }))
  }

  /** answer PublicKeyCredentialCreationOptions (JSON, as @simplewebauthn/server makes them) */
  register(options: { challenge: string; rp: { id?: string } }) {
    const rpId = options.rp.id ?? new URL(this.origin).hostname
    const att = cbor({ fmt: 'none', attStmt: {}, authData: this.authData(rpId, true) })
    return { id: b64u(this.credId), rawId: b64u(this.credId), type: 'public-key', clientExtensionResults: {}, authenticatorAttachment: 'platform',
      response: { clientDataJSON: b64u(this.clientData('webauthn.create', options.challenge)), attestationObject: b64u(att), transports: ['internal'] } }
  }

  /** answer PublicKeyCredentialRequestOptions */
  assert(options: { challenge: string; rpId?: string }) {
    const rpId = options.rpId ?? new URL(this.origin).hostname
    const ad = this.authData(rpId, false)
    const cd = this.clientData('webauthn.get', options.challenge)
    const sig = crypto.sign('sha256', Buffer.concat([ad, sha(cd)]), this.key.privateKey)
    return { id: b64u(this.credId), rawId: b64u(this.credId), type: 'public-key', clientExtensionResults: {}, authenticatorAttachment: 'platform',
      response: { clientDataJSON: b64u(cd), authenticatorData: b64u(ad), signature: b64u(sig), userHandle: null } }
  }

  toJSON() { return { origin: this.origin, credId: b64u(this.credId), count: this.count, key: this.key.privateKey.export({ format: 'pem', type: 'pkcs8' }) } }
  static fromJSON(j: { origin: string; credId: string; count: number; key: string }): SoftPasskey {
    const p = new SoftPasskey(j.origin)
    const priv = crypto.createPrivateKey(j.key)
    Object.assign(p, { key: { privateKey: priv, publicKey: crypto.createPublicKey(priv) }, credId: Buffer.from(j.credId, 'base64url'), count: j.count })
    return p
  }
}
