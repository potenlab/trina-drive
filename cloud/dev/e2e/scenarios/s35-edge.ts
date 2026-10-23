// S35 — the edge: a certificate for every team name and none for names that are not teams; HSTS; a Host that does
// not match the TLS name → 421.
import type { Scenario } from '../lib/ctx'

export default {
  id: 'S35', title: 'edge: team certificate, none for unknown names, HSTS, Host/SNI mismatch → 421', phase: 1, targets: ['local', 'aws'], uses: 'H1',
  async run(t) {
    const fx = t.fx
    t.check(`TLS for ${fx.slug}`, await t.http.tlsOk(`${fx.url}/api/state`))
    const nope = `zz-not-a-team-${Date.now().toString(36)}`
    t.check(`no certificate for ${nope} (not a team)`, !(await t.http.tlsOk(`${t.target.teamUrl(nope)}/`)))
    const st = await t.http.req('GET', `${fx.url}/api/state`)
    t.check('HSTS on the team', /max-age=\d{7,}/.test(st.headers.get('strict-transport-security') ?? ''), st.headers.get('strict-transport-security'))
    const other = t.target.otherTeam ?? 'acme'
    const swap = await fetch(`${fx.url}/api/state`, { headers: { host: new URL(t.target.teamUrl(other)).host }, tls: t.target.tls } as RequestInit).then((r) => r.status, () => 0)
    t.check('a Host header naming another team over this team\'s TLS → 421', swap === 421, swap)
    const ctl = await t.http.req('GET', `${t.target.control}/healthz`)
    t.check('the console answers over TLS with HSTS', ctl.status === 200 && !!ctl.headers.get('strict-transport-security'), [ctl.status, ctl.headers.get('strict-transport-security')])
  },
} satisfies Scenario
