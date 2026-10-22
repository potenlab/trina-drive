// WebAuthn in the browser: the server's JSON options (base64url strings) to the binary form navigator.credentials
// wants, and the credential back to JSON for the server (@simplewebauthn/server's shapes).
const toBuf = (s: string) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='))
  return Uint8Array.from(b, (c) => c.charCodeAt(0)).buffer
}
const toB64u = (b: ArrayBuffer | null | undefined) => {
  if (!b) return undefined
  let s = ''
  for (const x of new Uint8Array(b)) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export const passkeysSupported = () => typeof window !== 'undefined' && !!window.PublicKeyCredential && !!navigator.credentials

type Desc = { id: string; type?: string; transports?: string[] }
const desc = (d: Desc) => ({ ...d, type: 'public-key' as const, id: toBuf(d.id), transports: d.transports as AuthenticatorTransport[] | undefined })

export async function createPasskey(o: any): Promise<unknown> {
  const publicKey: PublicKeyCredentialCreationOptions = {
    ...o, challenge: toBuf(o.challenge), user: { ...o.user, id: toBuf(o.user.id) },
    excludeCredentials: (o.excludeCredentials ?? []).map(desc),
  }
  const c = await navigator.credentials.create({ publicKey }) as PublicKeyCredential | null
  if (!c) throw new Error('cancelled')
  const r = c.response as AuthenticatorAttestationResponse
  return {
    id: c.id, rawId: toB64u(c.rawId), type: c.type, clientExtensionResults: c.getClientExtensionResults(),
    authenticatorAttachment: c.authenticatorAttachment ?? undefined,
    response: { clientDataJSON: toB64u(r.clientDataJSON), attestationObject: toB64u(r.attestationObject), transports: r.getTransports?.() ?? [] },
  }
}

export async function getPasskey(o: any): Promise<unknown> {
  const publicKey: PublicKeyCredentialRequestOptions = { ...o, challenge: toBuf(o.challenge), allowCredentials: (o.allowCredentials ?? []).map(desc) }
  const c = await navigator.credentials.get({ publicKey }) as PublicKeyCredential | null
  if (!c) throw new Error('cancelled')
  const r = c.response as AuthenticatorAssertionResponse
  return {
    id: c.id, rawId: toB64u(c.rawId), type: c.type, clientExtensionResults: c.getClientExtensionResults(),
    authenticatorAttachment: c.authenticatorAttachment ?? undefined,
    response: { clientDataJSON: toB64u(r.clientDataJSON), authenticatorData: toB64u(r.authenticatorData), signature: toB64u(r.signature), userHandle: toB64u(r.userHandle) },
  }
}
