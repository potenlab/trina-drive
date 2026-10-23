// Hosted mode (`serve --hosted`, TDRIVE_HOSTED=1): an admin without a second factor reaches only the enrolment calls,
// enforced on the server for every /api route; enrolling (authenticator app here) opens everything; people who are
// not admins and servers that are not hosted are unaffected.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { issueSetupToken } from '../src/web/auth'
import { ENROLL_ALLOWED, hostedFlag } from '../src/web/hosted'
import { totpAt } from '../src/web/totp'
import { webSetup, type WebEnv } from './web-helpers'

let e: WebEnv
beforeEach(async () => { e = await webSetup(); e.w.opts.hosted = true })
afterEach(() => e.cleanup())

// always three entries: a test function with more parameters than values gets bun's `done` callback
const ADMIN_CALLS: [string, string, unknown][] = [
  ['GET', '/api/folders', null], ['GET', '/api/people', null], ['POST', '/api/people', { name: 'x', email: 'x@ex.test' }], ['GET', '/api/tokens', null],
  ['POST', '/api/tokens', { name: 't', ttl: '1d' }], ['GET', '/api/audit', null], ['GET', '/api/files', null], ['GET', '/api/drafts', null], ['GET', '/api/approvals', null],
  ['POST', '/api/me/password', { current: 'x', password: 'y' }], ['GET', '/api/notices', null], ['POST', '/api/oauth/requests/abcdefghijklmnopqrstu/approve', {}],
  ['DELETE', '/api/me/totp', null], ['GET', '/api/nope', null],
]

describe('an admin without a second factor', () => {
  test.each(ADMIN_CALLS)('%s %s is refused (403 second_factor_required)', async (method, p, body) => {
    const dion = await e.as('dion')
    const r = await dion.call(method, p, body ?? undefined)
    expect(r.status).toBe(403)
    expect(r.data.error).toBe('second_factor_required')
  })

  test('the session says so; enrolment calls work; after enrolling everything opens', async () => {
    const dion = await e.as('dion')
    const s = await dion.call('GET', '/api/session')
    expect(s.status).toBe(200)
    expect(s.data.me).toMatchObject({ admin: true, second_factor: false, second_factor_required: true })
    expect((await dion.call('GET', '/api/state')).status).toBe(200)
    expect((await dion.call('GET', '/api/me/2fa')).data.enrolled).toBe(false)
    const setup = await dion.call('POST', '/api/me/totp/setup')
    expect(setup.status).toBe(200)
    const ok = await dion.call('POST', '/api/me/totp/confirm', { code: totpAt(setup.data.secret, Date.now()) })
    expect(ok.status).toBe(200)
    expect(ok.data.recovery_codes).toHaveLength(10)
    expect((await dion.call('GET', '/api/session')).data.me).toMatchObject({ second_factor: true, second_factor_required: false })
    expect((await dion.call('GET', '/api/folders')).status).toBe(200)
    expect((await dion.call('POST', '/api/tokens', { name: 'after 2fa', ttl: '1d' })).status).toBe(200)
  })

  test('the first admin, right after setup: enrolment before anything else', async () => {
    e.db.query('DELETE FROM accounts').run()
    const token = issueSetupToken(e.db)!
    const b = new e.Browser()
    const r = await b.call('POST', '/api/setup', { setup_token: token, name: 'alex', email: 'alex@ex.test', password: 'a long admin password' })
    expect(r.status).toBe(200)
    expect(r.data.me.second_factor_required).toBe(true)
    expect((await b.call('GET', '/api/folders')).status).toBe(403)
    // fresh from setup: no password prompt before adding the factor
    expect((await b.call('POST', '/api/me/totp/setup')).status).toBe(200)
  })

  test('removing the last factor closes the admin features again', async () => {
    const dion = await e.as('dion')
    const setup = await dion.call('POST', '/api/me/totp/setup')
    await dion.call('POST', '/api/me/totp/confirm', { code: totpAt(setup.data.secret, Date.now()) })
    expect((await dion.call('GET', '/api/people')).status).toBe(200)
    // the factor disappears (e.g. `mfa reset` on the server)
    e.db.query('DELETE FROM mfa_totp').run()
    expect((await dion.call('GET', '/api/people')).status).toBe(403)
  })

  test('signed out: the usual 401, not the gate', async () => {
    expect((await new e.Browser().call('GET', '/api/folders')).status).toBe(401)
  })
})

test('people who are not admins are not affected', async () => {
  const kim = await e.as('kim')
  expect((await kim.call('GET', '/api/session')).data.me.second_factor_required).toBe(false)
  expect((await kim.call('GET', '/api/files')).status).toBe(200)
  expect((await kim.call('POST', '/api/tokens', { name: 'k', ttl: '1d' })).status).toBe(200)
})

test('not hosted: nothing changes', async () => {
  e.w.opts.hosted = false
  const dion = await e.as('dion')
  expect((await dion.call('GET', '/api/folders')).status).toBe(200)
  expect((await dion.call('GET', '/api/session')).data.me.second_factor_required).toBe(false)
})

test('the allowlist is only session, sign-out and enrolment', () => {
  // Trina Cloud: re-authenticating through the console (or with a passkey / code) to be able to enrol
  for (const k of ENROLL_ALLOWED) expect(k).toMatch(/^(GET \/api\/(state|session|me\/2fa|sso\/start)|POST \/api\/(logout|sso\/(callback|second)|me\/(reauth|reauth\/options|passkeys|passkeys\/options|totp\/setup|totp\/confirm|recovery-codes)))$/)
})

test('--hosted or TDRIVE_HOSTED', () => {
  expect(hostedFlag(true, {}, 'TDRIVE')).toBe(true)
  expect(hostedFlag(false, { TDRIVE_HOSTED: '1' }, 'TDRIVE')).toBe(true)
  expect(hostedFlag(false, { TDRIVE_HOSTED: 'true' }, 'TDRIVE')).toBe(true)
  expect(hostedFlag(false, { TDRIVE_HOSTED: '0' }, 'TDRIVE')).toBe(false)
  expect(hostedFlag(false, {}, 'TDRIVE')).toBe(false)
})
