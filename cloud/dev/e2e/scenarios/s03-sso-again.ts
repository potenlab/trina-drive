// S03 — signing in again: console password (+ authenticator for owners/admins) → Open drive without a drive password;
// the assertion records how (amr); without a console session the drive's sign-in goes to the console's /login?next=.
import type { Scenario } from '../lib/ctx'
import { Console } from '../lib/console'
import { Jar } from '../lib/http'

export default {
  id: 'S03', title: 'sign in again: console → Open drive passwordless; amr recorded; no console session → /login?next', phase: 1, targets: ['local', 'aws'], needs: ['sso', 'sso-console'], uses: 'H1',
  async run(t) {
    const fx = t.fx
    const c = await fx.consoleAs('mina')
    const r = await c.openDrive(fx.slug)
    t.check('mina: Open drive → signed in, no drive password asked', !!r.drive && !r.secondFactor, { error: r.error, hops: r.hops })
    const claims = r.assertion ? JSON.parse(Buffer.from(r.assertion.split('.')[1]!, 'base64url').toString()) : {}
    t.check(`the assertion says how she signed in (amr ${JSON.stringify(claims.amr)})`, Array.isArray(claims.amr) && claims.amr.includes('pwd'), claims)
    t.check('aud = this team, lifetime ≤ 120 s, a jti', /^team_[0-9a-f]{20}$/.test(claims.aud) && claims.exp - claims.iat <= 120 && !!claims.jti, claims)
    const a = await fx.consoleAs('admin')
    const ar = await a.openDrive(fx.slug)
    const ac = ar.assertion ? JSON.parse(Buffer.from(ar.assertion.split('.')[1]!, 'base64url').toString()) : {}
    t.check('the owner signs in to the console with the authenticator (amr has totp)', Array.isArray(ac.amr) && ac.amr.includes('totp'), ac)
    t.check('the owner: drive admin, at most the drive\'s second factor (no password)', !!ar.drive || !!ar.secondFactor, ar.error)
    const fresh = new Jar()
    const { hops, last } = await t.http.follow(`${fx.url}/api/sso/start?return=%2F%23%2Ffiles`, { jar: fresh })
    const login = hops.find((h) => new URL(h).pathname === '/login') ?? last.url
    t.check('no console session: the console answers /login?next=<relative /sso/authorize…>', /\/login\?next=%2Fsso%2Fauthorize|\/login\?next=\/sso\/authorize/.test(login), hops)
    void Console
  },
} satisfies Scenario
