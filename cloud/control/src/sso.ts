// Console side of the SSO contract (docs/SSO-CONTRACT.md, test/fixtures/sso-v1.json): Ed25519 signing keys, their
// rotation, and the one-time assertion "Open drive" hands to a team's drive.
//
//   keys      one `active` key signs; `next` keys are published to the teams (TDRIVE_CLOUD_SSO_KEYS) but do not sign
//             yet; `retired` keys are neither. Private keys are wrapped by the KeyWrapper (KMS in production, context
//             {purpose: 'sso', kid}); unwrapped ones are cached in memory.
//   rotation  `sso rotate` adds a `next` key → every team's env must be written again (`teams upgrade --all` recreates
//             the containers) → `sso activate <kid>` signs with it (the old one becomes `next`, still published) →
//             `sso retire <old kid>` after the teams have restarted once more.
//   assertion v1.<base64url(JSON claims)>.<base64url(Ed25519("tdcloud-sso-v1." + payload))>, 60 s, single use (jti),
//             audience = teams.public_id, state bound by state_hash, amr and auth_time from the console session,
//             sync_seq = the team's newest member-sync seq (the drive's reactivation rule).
import crypto from 'node:crypto'
import { audit } from './audit'
import { CloudError, type Cloud } from './cloud'
import type { TeamRow } from './db'

export const SIGNING_PREFIX = 'tdcloud-sso-v1.'
export const ASSERTION_TTL_S = 60
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex')

export type Role = 'owner' | 'admin' | 'member'
export type Amr = 'pwd' | 'link' | 'totp'

/** The claims in the contract's order (the fixture's assertions are byte-for-byte this serialization). */
export interface Claims {
  iss: string; aud: string; kid: string; sub: string; email: string; name: string; role: Role
  iat: number; nbf: number; exp: number; auth_time: number; jti: string; state_hash: string; amr: Amr[]; sync_seq: number
}

const b64u = (b: Uint8Array | Buffer) => Buffer.from(b).toString('base64url')
export const stateHash = (state: string) => b64u(crypto.createHash('sha256').update(state, 'utf8').digest())

/** An Ed25519 private key from a raw 32-byte seed (the fixture's test keys). */
export const keyFromSeed = (seed: Uint8Array) => crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, Buffer.from(seed)]), format: 'der', type: 'pkcs8' })
/** base64url raw public key (JWK OKP x) */
export const publicX = (priv: crypto.KeyObject) => (crypto.createPublicKey(priv).export({ format: 'jwk' }) as { x: string }).x

export function signAssertion(claims: Claims, key: crypto.KeyObject): string {
  // explicit key order: the contract's (and the fixture's) serialization
  const ordered: Claims = {
    iss: claims.iss, aud: claims.aud, kid: claims.kid, sub: claims.sub, email: claims.email, name: claims.name, role: claims.role,
    iat: claims.iat, nbf: claims.nbf, exp: claims.exp, auth_time: claims.auth_time, jti: claims.jti, state_hash: claims.state_hash,
    amr: claims.amr, sync_seq: claims.sync_seq,
  }
  const seg = b64u(Buffer.from(JSON.stringify(ordered), 'utf8'))
  return `v1.${seg}.${b64u(crypto.sign(null, Buffer.from(SIGNING_PREFIX + seg, 'ascii'), key))}`
}

/** The reference check (tests; the drive has its own in src/tdcloud): signature + shape only. */
export function verifySignature(assertion: string, keys: { kid: string; x: string }[]): Claims | null {
  const m = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(assertion)
  if (!m) return null
  let c: Claims
  try { c = JSON.parse(Buffer.from(m[1]!, 'base64url').toString('utf8')) } catch { return null }
  const k = keys.find((x) => x.kid === c.kid)
  if (!k) return null
  const pub = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: k.x }, format: 'jwk' })
  return crypto.verify(null, Buffer.from(SIGNING_PREFIX + m[1], 'ascii'), pub, Buffer.from(m[2]!, 'base64url')) ? c : null
}

interface KeyRow { kid: string; public_key: string; private_key_enc: string; state: 'next' | 'active' | 'retired'; created_at: number; activated_at: number | null; retired_at: number | null }

export class SsoKeys {
  private readonly cache = new Map<string, crypto.KeyObject>()
  constructor(private readonly c: Cloud) {}
  private ctx(kid: string) { return { purpose: 'sso', kid } }

  list(): KeyRow[] { return this.c.db.query<KeyRow, []>('SELECT * FROM sso_keys ORDER BY created_at, kid').all() }
  /** Every key a drive must accept: active + next (written into each team's env). */
  published(): { kid: string; x: string }[] {
    return this.c.db.query<{ kid: string; x: string }, []>("SELECT kid, public_key AS x FROM sso_keys WHERE state IN ('active', 'next') ORDER BY CASE state WHEN 'active' THEN 0 ELSE 1 END, created_at").all()
  }

  private nextKid(): string {
    const n = this.c.db.query<{ n: number | null }, []>("SELECT max(CAST(substr(kid, 2) AS INTEGER)) AS n FROM sso_keys WHERE kid GLOB 'k[0-9]*'").get()?.n ?? 0
    return `k${n + 1}`
  }

  private async add(state: 'next' | 'active', actor: string): Promise<string> {
    const kid = this.nextKid()
    const { privateKey } = crypto.generateKeyPairSync('ed25519')
    const der = privateKey.export({ format: 'der', type: 'pkcs8' })
    const enc = await this.c.keys.wrap(new Uint8Array(der), this.ctx(kid))
    this.c.db.query('INSERT INTO sso_keys (kid, public_key, private_key_enc, state, created_at, activated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(kid, publicX(privateKey), enc, state, Date.now(), state === 'active' ? Date.now() : null)
    this.cache.set(kid, privateKey)
    audit(this.c.db, { actor, action: state === 'active' ? 'sso.key_created' : 'sso.key_added', detail: { kid } })
    return kid
  }

  /** The signing key, made on first use. */
  async ensure(actor = 'system'): Promise<string> {
    const a = this.c.db.query<{ kid: string }, []>("SELECT kid FROM sso_keys WHERE state = 'active' LIMIT 1").get()
    if (a) return a.kid
    return this.add('active', actor)
  }

  /** `sso rotate`: a new key published (state next); it signs after `sso activate`. */
  rotate(actor: string) { return this.add('next', actor) }

  activate(kid: string, actor: string) {
    const k = this.c.db.query<KeyRow, [string]>('SELECT * FROM sso_keys WHERE kid = ?').get(kid)
    if (!k || k.state !== 'next') throw new CloudError('usage', `${kid} is not a published (next) key`)
    this.c.db.transaction(() => {
      this.c.db.query("UPDATE sso_keys SET state = 'next' WHERE state = 'active'").run()
      this.c.db.query("UPDATE sso_keys SET state = 'active', activated_at = ? WHERE kid = ?").run(Date.now(), kid)
    })()
    audit(this.c.db, { actor, action: 'sso.key_activated', detail: { kid } })
  }

  retire(kid: string, actor: string) {
    const k = this.c.db.query<KeyRow, [string]>('SELECT * FROM sso_keys WHERE kid = ?').get(kid)
    if (!k || k.state !== 'next') throw new CloudError('usage', `${kid} is not a published, non-signing key (activate another one first)`)
    this.c.db.query("UPDATE sso_keys SET state = 'retired', retired_at = ? WHERE kid = ?").run(Date.now(), kid)
    this.cache.delete(kid)
    audit(this.c.db, { actor, action: 'sso.key_retired', detail: { kid } })
  }

  private async privateKey(kid: string): Promise<crypto.KeyObject> {
    const hit = this.cache.get(kid)
    if (hit) return hit
    const k = this.c.db.query<KeyRow, [string]>('SELECT * FROM sso_keys WHERE kid = ?').get(kid)
    if (!k) throw new Error(`no SSO key ${kid}`)
    const der = await this.c.keys.unwrap(k.private_key_enc, this.ctx(kid))
    const key = crypto.createPrivateKey({ key: Buffer.from(der), format: 'der', type: 'pkcs8' })
    this.cache.set(kid, key)
    return key
  }

  /** A signed assertion for this member of this team (the caller checked membership, state and freshness). */
  async issue(o: { team: TeamRow; sub: string; email: string; name: string; role: Role; state: string; amr: Amr[]; authTime: number; syncSeq: number; actor: string }): Promise<string> {
    const kid = await this.ensure()
    const iat = Math.floor(Date.now() / 1000)
    const claims: Claims = {
      iss: this.c.cfg.controlUrl, aud: o.team.public_id, kid, sub: o.sub, email: o.email, name: o.name, role: o.role,
      iat, nbf: iat, exp: iat + ASSERTION_TTL_S, auth_time: Math.floor(o.authTime / 1000), jti: b64u(crypto.randomBytes(16)),
      state_hash: stateHash(o.state), amr: o.amr, sync_seq: o.syncSeq,
    }
    const a = signAssertion(claims, await this.privateKey(kid))
    // the audit names who and where only (never the assertion, the state or the jti)
    audit(this.c.db, { actor: o.actor, action: 'sso.issued', teamId: o.team.id, detail: { sub: o.sub, aud: o.team.public_id, kid, role: o.role, amr: o.amr } })
    return a
  }
}
