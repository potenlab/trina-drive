// Second factors (src/web/mfa.ts, src/web/totp.ts): TOTP per RFC 6238 with its window and replay protection, recovery
// codes, passkeys through a software authenticator, step-up assertions and the admin-2FA gate.
import { afterEach, describe, expect, test } from 'bun:test'
import {
  adminHas2FA, adminsWithout2FA, allAdminsHave2FA, consumeStepUp, has2FA, issueStepUp, makeRecoveryCodes, MfaError, passkeyAssertionOptions,
  passkeyConfig, passkeyRegister, passkeyRegistrationOptions, passkeyRemove, passkeyVerify, recoveryRemaining, requireAdmin2FA, STEPUP_TTL_MS,
  totpBegin, totpConfirm, totpRemove, totpVerify, useRecoveryCode,
} from '../src/web/mfa'
import { base32Decode, base32Encode, hotp, matchTotp, totpAt } from '../src/web/totp'
import { ensureWebSchema } from '../src/web/schema'
import { setup, type Env } from './helpers'
import { SoftAuthenticator } from './soft-authenticator'

let e: Env
afterEach(() => e?.cleanup())
const pid = (n: string) => e.db.query<{ id: number }, [string]>('SELECT id FROM people WHERE name = ?').get(n)!.id
const T0 = 1_700_000_000_000

describe('TOTP (RFC 6238)', () => {
  test('RFC 6238 appendix B vectors (SHA-1, 8 digits) and RFC 4226 HOTP vectors', () => {
    const key = new TextEncoder().encode('12345678901234567890')
    const b32 = base32Encode(key)
    expect(base32Decode(b32)).toEqual(key)
    expect(totpAt(b32, 59_000, 8)).toBe('94287082')
    expect(totpAt(b32, 1111111109_000, 8)).toBe('07081804')
    expect(totpAt(b32, 1234567890_000, 8)).toBe('89005924')
    expect(totpAt(b32, 20000000000_000, 8)).toBe('65353130')
    expect(['755224', '287082', '359152', '969429', '338314'].map((v, i) => hotp(key, i) === v)).toEqual([true, true, true, true, true])
  })

  test('window: one step either side of now, not two', () => {
    const s = base32Encode(new TextEncoder().encode('12345678901234567890'))
    expect(matchTotp(s, totpAt(s, T0), T0)).not.toBeNull()
    expect(matchTotp(s, totpAt(s, T0 - 30_000), T0)).not.toBeNull()
    expect(matchTotp(s, totpAt(s, T0 + 30_000), T0)).not.toBeNull()
    expect(matchTotp(s, totpAt(s, T0 - 61_000), T0)).toBeNull()
    expect(matchTotp(s, totpAt(s, T0 + 61_000), T0)).toBeNull()
    expect(matchTotp(s, '12345', T0)).toBeNull()
    expect(matchTotp(s, 123456 as unknown, T0)).toBeNull()
  })

  test('setup needs a confirming code; a code is accepted once (replay), an older step never after a newer one', () => {
    e = setup()
    ensureWebSchema(e.db)
    const kim = pid('kim')
    const { secret, uri } = totpBegin(e.db, kim, 'kim')
    expect(uri).toStartWith('otpauth://totp/')
    expect(has2FA(e.db, kim)).toBe(false) // not confirmed yet
    expect(totpVerify(e.db, kim, totpAt(secret, T0), T0)).toBe(false)
    expect(totpConfirm(e.db, kim, '000000', T0)).toBe(false)
    expect(totpConfirm(e.db, kim, totpAt(secret, T0), T0)).toBe(true)
    expect(has2FA(e.db, kim)).toBe(true)
    expect(() => totpBegin(e.db, kim, 'kim')).toThrow(MfaError)
    // the confirming code is spent; so is anything at or before its step
    expect(totpVerify(e.db, kim, totpAt(secret, T0), T0)).toBe(false)
    expect(totpVerify(e.db, kim, totpAt(secret, T0 - 30_000), T0)).toBe(false)
    const next = T0 + 30_000
    expect(totpVerify(e.db, kim, totpAt(secret, next), next)).toBe(true)
    expect(totpVerify(e.db, kim, totpAt(secret, next), next + 5_000)).toBe(false) // replay inside the window
    expect(totpRemove(e.db, kim)).toBe(true)
    expect(has2FA(e.db, kim)).toBe(false)
  })
})

describe('recovery codes', () => {
  test('ten single-use codes; making new ones voids the old', () => {
    e = setup()
    const kim = pid('kim')
    const codes = makeRecoveryCodes(e.db, kim)
    expect(codes).toHaveLength(10)
    expect(new Set(codes).size).toBe(10)
    expect(useRecoveryCode(e.db, kim, codes[0]!.toUpperCase())).toBe(true)
    expect(useRecoveryCode(e.db, kim, codes[0])).toBe(false)
    expect(useRecoveryCode(e.db, pid('boss'), codes[1])).toBe(false)
    expect(recoveryRemaining(e.db, kim)).toBe(9)
    const fresh = makeRecoveryCodes(e.db, kim)
    expect(useRecoveryCode(e.db, kim, codes[1])).toBe(false)
    expect(useRecoveryCode(e.db, kim, fresh[1])).toBe(true)
    expect(has2FA(e.db, kim)).toBe(false) // recovery codes alone are not a second factor
  })
})

describe('passkeys', () => {
  const cfg = passkeyConfig('https://files.example.com')!
  test('RP ID comes from the public https address; LAN http and IP addresses have none', () => {
    expect(cfg).toEqual({ rpId: 'files.example.com', origin: 'https://files.example.com', rpName: 'shelf' })
    expect(passkeyConfig(undefined)).toBeNull()
    expect(passkeyConfig('http://files.lan:8787')).toBeNull()
    expect(passkeyConfig('https://192.168.0.10')).toBeNull()
    expect(passkeyConfig('http://localhost:8787')?.rpId).toBe('localhost')
  })

  test('register, assert, counter, challenge single-use and bound, wrong origin / RP / signature / no UV refused', async () => {
    e = setup()
    ensureWebSchema(e.db)
    const kim = pid('kim')
    const a = new SoftAuthenticator(cfg.origin)
    const reg = await passkeyRegistrationOptions(e.db, cfg, { id: kim, name: 'kim' }, 'sess1')
    expect(reg.rp.id).toBe('files.example.com')
    // another session cannot finish this registration
    await expect(passkeyRegister(e.db, cfg, kim, 'sess2', a.register(reg), 'x')).rejects.toThrow(/expired or was already used/)
    const reg2 = await passkeyRegistrationOptions(e.db, cfg, { id: kim, name: 'kim' }, 'sess1')
    await passkeyRegister(e.db, cfg, kim, 'sess1', a.register(reg2), 'Laptop')
    expect(has2FA(e.db, kim)).toBe(true)
    // the same challenge twice
    await expect(passkeyRegister(e.db, cfg, kim, 'sess1', a.register(reg2), 'again')).rejects.toThrow(MfaError)

    const opts = (await passkeyAssertionOptions(e.db, cfg, kim, 'stepup', 'approval:1:abc:sess1'))!
    expect(opts.allowCredentials?.map((c) => c.id)).toEqual([a.id])
    expect(await passkeyVerify(e.db, cfg, kim, 'stepup', 'approval:1:abc:sess1', a.assert(opts))).toBeGreaterThan(0)
    await expect(passkeyVerify(e.db, cfg, kim, 'stepup', 'approval:1:abc:sess1', a.assert(opts))).rejects.toThrow(/already used/)
    // bound to another approval / purpose
    const o2 = (await passkeyAssertionOptions(e.db, cfg, kim, 'stepup', 'approval:1:abc:sess1'))!
    await expect(passkeyVerify(e.db, cfg, kim, 'stepup', 'approval:2:abc:sess1', a.assert(o2))).rejects.toThrow(MfaError)
    const o3 = (await passkeyAssertionOptions(e.db, cfg, kim, 'stepup', 'b'))!
    await expect(passkeyVerify(e.db, cfg, kim, 'stepup', 'b', a.assert(o3, { origin: 'https://evil.example' }))).rejects.toThrow(/not accepted/)
    const o4 = (await passkeyAssertionOptions(e.db, cfg, kim, 'stepup', 'b'))!
    await expect(passkeyVerify(e.db, cfg, kim, 'stepup', 'b', a.assert(o4, { rpId: 'evil.example' }))).rejects.toThrow(/not accepted/)
    const o5 = (await passkeyAssertionOptions(e.db, cfg, kim, 'stepup', 'b'))!
    await expect(passkeyVerify(e.db, cfg, kim, 'stepup', 'b', a.assert(o5, { tamper: true }))).rejects.toThrow(/not accepted/)
    a.uv = false
    const o6 = (await passkeyAssertionOptions(e.db, cfg, kim, 'stepup', 'b'))!
    await expect(passkeyVerify(e.db, cfg, kim, 'stepup', 'b', a.assert(o6))).rejects.toThrow(/not accepted/)
    a.uv = true
    // someone else's passkey is not kim's
    const boss = pid('boss')
    const b = new SoftAuthenticator(cfg.origin)
    const rb = await passkeyRegistrationOptions(e.db, cfg, { id: boss, name: 'boss' }, 's')
    await passkeyRegister(e.db, cfg, boss, 's', b.register(rb), 'boss key')
    const o7 = (await passkeyAssertionOptions(e.db, cfg, kim, 'stepup', 'b'))!
    await expect(passkeyVerify(e.db, cfg, kim, 'stepup', 'b', b.assert(o7))).rejects.toThrow(/not registered for you/)
    // removal
    const row = e.db.query<{ id: number }, [number]>('SELECT id FROM mfa_passkeys WHERE person_id = ?').get(kim)!
    expect(passkeyRemove(e.db, boss, row.id)).toBe(false)
    expect(passkeyRemove(e.db, kim, row.id)).toBe(true)
    expect(has2FA(e.db, kim)).toBe(false)
    expect(await passkeyAssertionOptions(e.db, cfg, kim, 'stepup', 'b')).toBeNull()
  })
})

describe('step-up assertions', () => {
  test('single use, bound to session + person + approval + hash, 2-minute life', () => {
    e = setup()
    const b = { sessionHash: 's1', personId: 1, approvalId: 7, sha256: 'aa' }
    const one = issueStepUp(e.db, b, 'passkey')
    expect(one.expires_at - Date.now()).toBeLessThanOrEqual(STEPUP_TTL_MS)
    for (const other of [{ ...b, sessionHash: 's2' }, { ...b, personId: 2 }, { ...b, approvalId: 8 }, { ...b, sha256: 'bb' }]) expect(consumeStepUp(e.db, one.assertion, other)).toBe(false)
    expect(consumeStepUp(e.db, one.assertion, b)).toBe(true)
    expect(consumeStepUp(e.db, one.assertion, b)).toBe(false)
    const two = issueStepUp(e.db, b, 'totp')
    e.db.query('UPDATE mfa_stepups SET expires_at = ? WHERE used_at IS NULL').run(Date.now() - 1)
    expect(consumeStepUp(e.db, two.assertion, b)).toBe(false)
    expect(consumeStepUp(e.db, 'x'.repeat(500), b)).toBe(false)
  })
})

describe('admin 2FA gate', () => {
  test('allAdminsHave2FA / adminHas2FA / requireAdmin2FA', () => {
    e = setup()
    const dion = pid('dion')
    expect(adminHas2FA(e.db, dion)).toBe(false)
    expect(allAdminsHave2FA(e.db)).toBe(false)
    expect(() => requireAdmin2FA(e.db)).toThrow(/1 admin without a second factor/)
    const { secret } = totpBegin(e.db, dion, 'dion')
    totpConfirm(e.db, dion, totpAt(secret, Date.now()), Date.now())
    expect(adminHas2FA(e.db, dion)).toBe(true)
    expect(allAdminsHave2FA(e.db)).toBe(true)
    expect(() => requireAdmin2FA(e.db)).not.toThrow()
    e.db.query("UPDATE people SET admin = 1 WHERE name = 'kim'").run()
    expect(adminsWithout2FA(e.db)).toEqual([pid('kim')])
    expect(allAdminsHave2FA(e.db)).toBe(false)
    e.db.query("UPDATE people SET active = 0 WHERE name = 'kim'").run() // inactive admins do not count
    expect(allAdminsHave2FA(e.db)).toBe(true)
    e.db.query('UPDATE people SET admin = 0').run()
    expect(allAdminsHave2FA(e.db)).toBe(false) // no admin at all is not "all admins have it"
  })
})

describe('operator CLI', () => {
  test('mfa reset removes every factor and ends sessions; folder promote refuses personal folders', async () => {
    const { mfaCommand } = await import('../src/web/mfa-cli')
    const { promoteFolderIds } = await import('../src/promote')
    const { createSession, lookupSession } = await import('../src/web/auth')
    e = setup()
    const kim = pid('kim')
    const { secret } = totpBegin(e.db, kim, 'kim')
    totpConfirm(e.db, kim, totpAt(secret, Date.now()), Date.now())
    makeRecoveryCodes(e.db, kim)
    const s = createSession(e.db, kim)
    const log = console.log
    console.log = () => {}
    try {
      expect(mfaCommand(e.db, 'mfa reset', ['kim'])).toBe(true)
      expect(has2FA(e.db, kim)).toBe(false)
      expect(recoveryRemaining(e.db, kim)).toBe(0)
      expect(lookupSession(e.db, s.cookie)).toBeNull()
      expect(mfaCommand(e.db, 'folder promote', [`${e.root}/프로젝트`])).toBe(true)
      expect(promoteFolderIds(e.db).has(e.folderId('프로젝트'))).toBe(true)
      expect(() => mfaCommand(e.db, 'folder promote', [`${e.root}/개인_kim`])).toThrow(/personal/)
      expect(mfaCommand(e.db, 'folder promote', [`${e.root}/프로젝트`, '--off'])).toBe(true)
      expect(promoteFolderIds(e.db).size).toBe(0)
      expect(mfaCommand(e.db, 'nope nope', [])).toBe(false)
    } finally { console.log = log }
  })
})
