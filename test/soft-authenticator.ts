// A software WebAuthn authenticator for tests: an ES256 key pair, "none" attestation, user presence + verification
// flags, a signature counter. It answers the server's JSON options with the JSON a browser would send back.
import crypto from 'node:crypto'
import { isoCBOR } from '@simplewebauthn/server/helpers'

const b64u = (b: Uint8Array | Buffer) => Buffer.from(b).toString('base64url')
const sha = (b: Uint8Array | Buffer) => crypto.createHash('sha256').update(b).digest()

export class SoftAuthenticator {
  readonly key = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
  readonly credId = crypto.randomBytes(16)
  counter = 0
  /** user verification (PIN / biometrics) — a step-up requires it */
  uv = true

  constructor(readonly origin: string, readonly rpId = new URL(origin).hostname) {}

  get id() { return b64u(this.credId) }

  private cose(): Uint8Array {
    const jwk = this.key.publicKey.export({ format: 'jwk' }) as { x: string; y: string }
    return isoCBOR.encode(new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]))
  }

  private authData(attested: boolean, rpId = this.rpId): Buffer {
    const flags = 0x01 | (this.uv ? 0x04 : 0) | (attested ? 0x40 : 0)
    const counter = Buffer.alloc(4)
    counter.writeUInt32BE(this.counter)
    const parts: Buffer[] = [sha(Buffer.from(rpId)), Buffer.from([flags]), counter]
    if (attested) {
      const len = Buffer.alloc(2)
      len.writeUInt16BE(this.credId.length)
      parts.push(Buffer.alloc(16), len, this.credId, Buffer.from(this.cose()))
    }
    return Buffer.concat(parts)
  }

  private clientData(type: string, challenge: string, origin = this.origin) {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }))
  }

  /** navigator.credentials.create() */
  register(options: { challenge: string }, o: { origin?: string } = {}) {
    const clientDataJSON = this.clientData('webauthn.create', options.challenge, o.origin)
    const attestationObject = isoCBOR.encode(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', this.authData(true)]]) as never)
    return {
      id: this.id, rawId: this.id, type: 'public-key',
      response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ['internal'] },
      clientExtensionResults: {}, authenticatorAttachment: 'platform',
    }
  }

  /** navigator.credentials.get() */
  assert(options: { challenge: string }, o: { origin?: string; rpId?: string; tamper?: boolean } = {}) {
    this.counter++
    const clientDataJSON = this.clientData('webauthn.get', options.challenge, o.origin)
    const authenticatorData = this.authData(false, o.rpId)
    const signature = crypto.sign('sha256', Buffer.concat([authenticatorData, sha(clientDataJSON)]), this.key.privateKey)
    if (o.tamper) signature[signature.length - 1]! ^= 1
    return {
      id: this.id, rawId: this.id, type: 'public-key',
      response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authenticatorData), signature: b64u(signature) },
      clientExtensionResults: {}, authenticatorAttachment: 'platform',
    }
  }
}
