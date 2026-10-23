// S46 — console security: an owner without an authenticator cannot change members; an admin invite forwarded to
// another account cannot be accepted by it; changing requests from another origin are refused (also PATCH/DELETE);
// the session cookie is __Host- (host-only, Secure, Path=/); a same-named cookie planted for the parent domain is ignored.
import type { Scenario } from '../lib/ctx'
import { Console } from '../lib/console'

export default {
  id: 'S46', title: 'console security: TOTP required for owners, invites bound to email, Origin on every change, __Host- cookie', phase: 1, targets: ['local'], needs: ['console', 'mail'], uses: 'H1',
  async run(t) {
    const fx = t.fx
    const run = Date.now().toString(36)
    const owner = await fx.consoleAs('admin')
    const cookie = owner.jar.seen.find((x) => /session/i.test(x)) ?? ''
    t.check('session cookie is __Host-…; Secure; Path=/; no Domain', /^__Host-/.test(cookie) && /Secure/i.test(cookie) && /Path=\//i.test(cookie) && !/Domain=/i.test(cookie), cookie.replace(/=[^;]+/, '=…'))
    const teamId = await owner.teamId(fx.slug)
    t.step('changing requests from elsewhere')
    for (const [m, p, body] of [['POST', `/api/teams/${teamId}/invites`, { emails: ['x@x.test'] }], ['PATCH', `/api/teams/${teamId}`, { name: 'x' }], ['DELETE', `/api/teams/${teamId}/invites/1`, {}]] as const) {
      const r = await t.http.req(m, `${t.target.control}${p}`, { jar: owner.jar, csrf: owner.csrf, body, origin: t.target.teamUrl(fx.slug) })
      t.check(`${m} ${p} with Origin = a team's address → 403`, r.status === 403, r.status)
    }
    t.step('an owner without an authenticator')
    const email = `s46-${run}@owner.test`, pw = `s46-${run}-correct-horse`
    const c = new Console(t.http)
    await c.signupConfirmed(email, pw); await c.login({ email, password: pw })
    const mk = await c.api('POST', '/api/teams', { name: 'S46', slug: `s46-${run}`, plan: 'team' })
    const tid = mk.status === 201 ? mk.json().team.id : ''
    const inv = tid ? await c.invite(tid, [`s46i-${run}@x.test`]) : mk
    t.check('changing members without TOTP → refused (totp_required)', inv.status === 403 || inv.status === 409 || /totp/.test(inv.text), `${inv.status} ${inv.text.slice(0, 160)}`)
    t.step('a forwarded admin invite')
    const invited = `s46a-${run}@x.test`
    await owner.invite(teamId, [invited], 'admin')
    const token = owner.inviteToken(invited)
    const other = new Console(t.http)
    await other.signupConfirmed(`s46b-${run}@x.test`, pw); await other.login({ email: `s46b-${run}@x.test`, password: pw })
    const acc = await other.accept(token)
    t.check('another account cannot accept it (403/404)', acc.status === 403 || acc.status === 404, acc.text)
    t.step('a planted cookie')
    const planted = await t.http.req('GET', `${t.target.control}/api/me`, { headers: { cookie: `tdcloud_session=${owner.jar.get(new URL(t.target.control).host, cookie.split('=')[0]!) ?? 'x'}` } })
    t.check('the old cookie name (a parent-domain cookie a team could plant) signs nobody in', planted.status === 401, planted.status)
    if (tid) c.api('DELETE', `/api/teams/${tid}`, { confirm_slug: `s46-${run}` }).catch(() => {})
  },
} satisfies Scenario
