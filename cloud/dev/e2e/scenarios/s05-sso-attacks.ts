// S05 — SSO attacks against the real console and drive (docs/SSO-CONTRACT.md order of checks): a non-member gets the
// same 404 as a team that does not exist; a wrong state, a tampered or foreign-key signature, an unknown kid, a
// malformed assertion, a replay and an expired assertion are refused with their codes, and none of them signs in.
// The expiry check waits ~2 minutes (E2E_FAST=1 skips it).
import crypto from 'node:crypto'
import type { Scenario } from '../lib/ctx'
import { Console, postCallback } from '../lib/console'
import { parseFormPost, type Jar } from '../lib/http'

export default {
  id: 'S05', title: 'SSO attacks: non-member = no team (404); bad state/signature/kid/format, replay, expiry refused', phase: 1, targets: ['local', 'aws'], needs: ['sso', 'sso-console'], uses: 'H1',
  async run(t) {
    const fx = t.fx
    /** start on the drive and stop at the console's form_post page: the assertion, the state and the browser jar */
    const fresh = async (c: Console) => {
      const { last } = await t.http.follow(`${fx.url}/api/sso/start?return=%2F`, { jar: c.jar })
      const f = parseFormPost(last.text)
      return { jar: c.jar as Jar, assertion: f?.fields.assertion ?? '', state: f?.fields.state ?? '', action: f ? new URL(f.action, last.url).toString() : `${fx.url}/api/sso/callback` }
    }
    const err = (loc: string) => /#\/sso-error\/([a-z_]+)/.exec(loc)?.[1] ?? `(no error: ${loc})`
    const post = (x: { jar: Jar; action: string }, assertion: string, state: string) => postCallback(t.http, x.jar, x.action, { assertion, state })

    t.step('a console account that is not a member')
    const run = Date.now().toString(36)
    const outsider = new Console(t.http)
    if (t.target.outbox) await outsider.signupConfirmed(`s05-${run}@outsider.test`, `s05-${run}-correct-horse`)
    else t.skip('needs a non-member console account: local only')
    await outsider.login({ email: `s05-${run}@outsider.test`, password: `s05-${run}-correct-horse` })
    const start = await t.http.follow(`${fx.url}/api/sso/start?return=%2F`, { jar: outsider.jar })
    const nx = await t.http.req('GET', `${t.target.control}/sso/authorize?team=team_00000000000000000000&state=${'A'.repeat(43)}`, { jar: outsider.jar })
    t.check('non-member → 404, the same answer as a team that does not exist', start.last.status === 404 && nx.status === 404 && start.last.text === nx.text, [start.last.status, nx.status])

    // a refused callback clears the state cookie (and the drive forgets the state): every attempt starts afresh
    const c = await fx.consoleAs('mina')
    const a = await fresh(c)
    t.check('a member gets the form_post page with an assertion', /^v1\.[\w-]+\.[\w-]+$/.test(a.assertion) && !!a.state, a.assertion.slice(0, 20))
    t.check('wrong state → bad_state', err((await post(a, a.assertion, 'B'.repeat(43))).location) === 'bad_state')
    const forge = (c2: Record<string, unknown>, key = crypto.generateKeyPairSync('ed25519').privateKey) => {
      const p = Buffer.from(JSON.stringify(c2)).toString('base64url')
      return `v1.${p}.${crypto.sign(null, Buffer.from(`tdcloud-sso-v1.${p}`), key).toString('base64url')}`
    }
    const attempt = async (what: string, want: string, make: (x: { assertion: string; claims: Record<string, unknown>; v: string; payload: string; sig: string }) => string) => {
      const x = await fresh(c)
      const [v, payload, sig] = x.assertion.split('.') as [string, string, string]
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString())
      const got = err((await post(x, make({ assertion: x.assertion, claims, v, payload, sig }), x.state)).location)
      t.check(`${what} → ${want}`, got === want, got)
    }
    await attempt('tampered signature', 'bad_signature', ({ v, payload, sig }) => `${v}.${payload}.${sig.slice(0, -2)}${sig.endsWith('AA') ? 'AB' : 'AA'}`)
    await attempt('signed with a key the console does not hold (kid k1)', 'bad_signature', ({ claims }) => forge({ ...claims, role: 'owner' }))
    await attempt('an unknown kid', 'unknown_kid', ({ claims }) => forge({ ...claims, kid: 'k9' }))
    await attempt('malformed', 'malformed', () => 'v1.not-json.x')
    await attempt('payload edited (role: owner) under the real signature', 'bad_signature', ({ v, claims, sig }) => `${v}.${Buffer.from(JSON.stringify({ ...claims, role: 'owner' })).toString('base64url')}.${sig}`)
    const g = await fresh(c)
    const ok = await post(g, g.assertion, g.state)
    t.check('the untouched assertion signs in', !/sso-error/.test(ok.location) && ok.status === 303, ok.location)
    const replay = await post(g, g.assertion, g.state)
    t.check(`replayed → refused (${err(replay.location)})`, ['replayed', 'bad_state'].includes(err(replay.location)), replay.location)

    if (process.env.E2E_FAST === '1') t.skipPart('expired assertion', 'E2E_FAST=1')
    else {
      const c3 = await fx.consoleAs('mina')
      const b = await fresh(c3)
      t.step('waiting 125 s for the assertion to expire (exp + 60 s skew)')
      await Bun.sleep(125_000)
      t.check('expired → expired', err((await post(b, b.assertion, b.state)).location) === 'expired')
    }
  },
} satisfies Scenario
