// S34 — isolation between teams: this team's session cookie, tokens, app passwords and SSO assertions mean nothing on
// another team; its container reaches neither the other team nor the control plane nor the cloud metadata service.
import type { Scenario } from '../lib/ctx'
import { bash, dav, davAuth, propfindBody } from '../lib/drive'
import { postCallback } from '../lib/console'

export default {
  id: 'S34', title: 'isolation: another team refuses this team\'s session, tokens, app passwords and assertions; no network path', phase: 1, targets: ['local', 'aws'], uses: 'H1 MCP DAV OPS',
  async run(t) {
    const fx = t.fx
    let other = t.target.otherTeam
    if (!other && t.target.ops) {
      const list = t.target.ops('teams', 'list').out.split('\n').map((l) => l.split(/\s+/)).filter((c) => c[1] === 'active' && c[0] !== fx.slug).map((c) => c[0]!)
      other = ['acme', 'globex'].find((s) => list.includes(s)) ?? list[0]
    }
    if (!other) t.skip('no second running team (local: run cloud/dev/up.sh; AWS: E2E_OTHER_TEAM)')
    t.step(`${fx.slug} → ${other}`)
    const tok = await fx.token('kim')
    const r = await bash(t.http, other, tok, 'ls /')
    t.check(`kim's token on ${other}/mcp → 401`, r.status === 401, r.raw.slice(0, 200))
    const d = await fx.drive('admin')
    const host = new URL(fx.url).host
    const cookie = d.jar.header(host)
    const s = await t.http.req('GET', `${t.target.teamUrl(other)}/api/session`, { headers: { cookie } })
    t.check(`the admin's session cookie on ${other} → 401`, s.status === 401, s.status)
    const ap = await fx.appPassword('mina')
    const dv = await dav(t.http, other, davAuth(fx.login('mina'), ap), 'PROPFIND', '/', { body: propfindBody, headers: { depth: '0' } })
    t.check(`mina's app password on ${other}/dav → 401`, dv.status === 401, dv.status)
    if (t.target.inTeam) {
      const net = t.target.inTeam(fx.slug, ['/usr/local/bin/bun', '-e',
        `const f=async(u)=>{try{await fetch(u,{signal:AbortSignal.timeout(3000)});return 'reached'}catch{return 'blocked'}};console.log(await f('http://tdc-${other}:8787/health'), await f('http://tdc-control:8790/healthz'), await f('http://169.254.169.254/latest/meta-data/'), await f('http://10.250.250.11:8790/healthz'))`])
      t.check('the container reaches neither the other team, the control plane (by name or address) nor 169.254.169.254', net.out.trim() === 'blocked blocked blocked blocked', net.out + net.err)
    }
    if (await t.has('sso', `an SSO assertion for ${fx.slug} posted to ${other} → bad_audience`)) {
      // a real assertion for this team (from the console), posted to the other team under the other team's own state
      const c = await fx.consoleAs('mina')
      const start = await t.http.follow(`${t.target.teamUrl(other)}/api/sso/start?return=%2F`, { jar: c.jar, stopAt: (u) => u.pathname === '/sso/authorize' })
      const otherState = new URL(start.hops.at(-1)!).searchParams.get('state') ?? ''
      const mine = await t.http.follow(`${fx.url}/api/sso/start?return=%2F`, { jar: c.jar })
      const { parseFormPost } = await import('../lib/http')
      const form = parseFormPost(mine.last.text)
      const cb = await postCallback(t.http, c.jar, `${t.target.teamUrl(other)}/api/sso/callback`, { assertion: form?.fields.assertion ?? '', state: otherState })
      t.check(`${other} refuses it: #/sso-error/bad_audience (or bad_state)`, /sso-error\/(bad_audience|bad_state)/.test(cb.location), cb.location)
    }
  },
} satisfies Scenario
