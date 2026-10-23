// The SSO contract fixture (test/fixtures/sso-v1.json) is what scripts/gen-sso-fixture.ts makes, and a small reference
// verifier that follows docs/SSO-CONTRACT.md exactly gives every vector its expected answer. B1 (drive) and D1
// (console) run the same vectors against their own code; this test keeps the fixture itself honest.
import { describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { FIXTURE, render } from '../scripts/gen-sso-fixture'
import fx from './fixtures/sso-v1.json'

type Claims = Record<string, unknown>
const SEG = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/
const sha = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('base64url')
const int = (x: unknown) => typeof x === 'number' && Number.isSafeInteger(x)

function verify(assertion: string, o: { now: number; state: string; cookieState: string | null; seen: Set<string> }): { ok: true; claims: Claims } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error })
  if (o.cookieState === null || o.cookieState.length !== o.state.length || !crypto.timingSafeEqual(Buffer.from(o.cookieState), Buffer.from(o.state))) return fail('bad_state')
  const m = SEG.exec(assertion)
  if (!m || assertion.length > fx.assertion.max_length) return fail('malformed')
  let c: Claims
  try { c = JSON.parse(Buffer.from(m[1]!, 'base64url').toString('utf8')) } catch { return fail('malformed') }
  if (!c || typeof c !== 'object' || Array.isArray(c)) return fail('malformed')
  if (fx.assertion.required.some((k) => !(k in c))) return fail('malformed')
  if (!['iss', 'aud', 'kid', 'email', 'name', 'state_hash'].every((k) => typeof c[k] === 'string')) return fail('malformed')
  if (!/^usr_[0-9a-f]{20}$/.test(String(c.sub)) || !['owner', 'admin', 'member'].includes(String(c.role)) || !/^[A-Za-z0-9_-]{22}$/.test(String(c.jti))) return fail('malformed')
  if (!['iat', 'nbf', 'exp', 'auth_time', 'sync_seq'].every((k) => int(c[k])) || (c.sync_seq as number) < 0) return fail('malformed')
  if (!Array.isArray(c.amr) || !c.amr.every((a) => ['pwd', 'link', 'totp'].includes(a))) return fail('malformed')
  const keys = JSON.parse(fx.env.TDRIVE_CLOUD_SSO_KEYS) as { kid: string; x: string }[]
  const k = keys.find((x) => x.kid === c.kid)
  if (!k) return fail('unknown_kid')
  const pub = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: k.x }, format: 'jwk' })
  if (!crypto.verify(null, Buffer.from('tdcloud-sso-v1.' + m[1], 'ascii'), pub, Buffer.from(m[2]!, 'base64url'))) return fail('bad_signature')
  if (c.iss !== fx.env.TDRIVE_CLOUD_ISSUER) return fail('bad_issuer')
  if (c.aud !== fx.env.TDRIVE_CLOUD_TEAM) return fail('bad_audience')
  const { iat, nbf, exp } = c as { iat: number; nbf: number; exp: number }
  const { skew_s, max_lifetime_s } = fx.assertion.clock
  if (iat > o.now + skew_s || nbf > o.now + skew_s) return fail('not_yet_valid')
  if (o.now > exp + skew_s) return fail('expired')
  if (exp <= iat || exp - iat > max_lifetime_s) return fail('bad_lifetime')
  if (c.state_hash !== sha(o.state)) return fail('bad_state')
  if (o.seen.has(String(c.jti))) return fail('replayed')
  return { ok: true, claims: c }
}

describe('sso-v1 contract fixture', () => {
  test('is what scripts/gen-sso-fixture.ts makes (regenerate after changing the contract)', () => {
    expect(fs.readFileSync(FIXTURE, 'utf8')).toBe(render())
  })

  test('every error code is used by a vector, and every vector expects a known answer', () => {
    const used = new Set(fx.vectors.filter((v) => !v.expect.ok).map((v) => (v.expect as { error: string }).error))
    expect([...used].sort()).toEqual([...fx.assertion.errors].sort())
    expect(new Set(fx.vectors.map((v) => v.name)).size).toBe(fx.vectors.length)
  })

  for (const v of fx.vectors) {
    test(`${v.name}: ${v.why}`, () => {
      const got = verify(v.assertion, { now: v.now, state: v.state, cookieState: v.cookie_state, seen: new Set(v.seen_jti ?? []) })
      expect(got).toEqual(v.expect as typeof got)
    })
  }

  test('the test keys in the fixture are the configured public keys', () => {
    for (const kid of ['k1', 'k2'] as const) {
      const seed = Buffer.from(fx.test_keys[kid].seed, 'base64url')
      const priv = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' })
      expect((crypto.createPublicKey(priv).export({ format: 'jwk' }) as { x: string }).x).toBe(fx.test_keys[kid].x)
    }
    expect(JSON.parse(fx.env.TDRIVE_CLOUD_SSO_KEYS).map((k: { kid: string }) => k.kid)).toEqual(['k1', 'k2'])
  })

  test('member sync: seq rule vectors are consistent with "apply only when seq > applied"', () => {
    for (const s of fx.member_sync.vectors.filter((x) => 'payload_seq' in x) as { applied_before: number; payload_seq: number; expect: { applied: boolean; applied_after: number } }[]) {
      expect(s.expect.applied).toBe(s.payload_seq > s.applied_before)
      expect(s.expect.applied_after).toBe(Math.max(s.applied_before, s.payload_seq))
    }
    for (const s of fx.member_sync.vectors.filter((x) => 'assertion_sync_seq' in x) as { applied_before: number; person: string; assertion_sync_seq: number; expect: { sign_in: boolean } }[]) {
      if (s.person === 'inactive') expect(s.expect.sign_in).toBe(s.assertion_sync_seq > s.applied_before)
      else expect(s.expect.sign_in).toBe(true)
    }
    expect(fx.member_sync.payload.version).toBe(2)
    expect(fx.member_sync.payload.team).toBe(fx.team)
  })
})
