// S45 — SSO re-authentication: a session older than 5 minutes cannot make an app password or enrol a second factor
// until the person proves themselves again (?reauth=1 → the console asks the password again, max_age=0); /api/setup
// is gone under SSO-only; someone made admin mid-session is noticed by every admin.
import type { Scenario } from '../lib/ctx'

export default {
  id: 'S45', title: 'SSO re-auth: old session → reauth_required; ?reauth=1 → app password/2FA; /api/setup 404; admin promotion noticed', phase: 1, targets: ['local', 'aws'], needs: ['sso', 'sso-console'], uses: 'H1',
  async run(t) {
    const fx = t.fx
    if (await t.has('sso-only', '/api/setup → 404 under TDRIVE_SSO_ONLY')) {
      const s = await t.http.req('POST', `${fx.url}/api/setup`, { body: { setup_token: 'tdrive_setup_x', name: 'x', email: 'x@x.test', password: 'some-password-1' } })
      t.check('POST /api/setup → 404', s.status === 404, s.status)
      const l = await t.http.req('POST', `${fx.url}/api/login`, { body: { login: fx.creds('mina').email, password: fx.creds('mina').password } })
      t.check('password sign-in for a console person → 409 use_sso', l.status === 409 && /use_sso/.test(l.text), l.text)
    }
    const old = await fx.drive('mina') // the kept session: older than 5 minutes after the first run
    const kept = fx.s.sessions.mina?.at ?? Date.now()
    if (Date.now() - kept < 6 * 60_000) t.skipPart('the "older than 5 minutes" case', 'the kept session is younger than 6 minutes; run again later')
    else {
      const ap = await old.api('POST', '/me/app-passwords', { name: 's45-old' })
      t.check('old session: app password → 403 reauth_required', ap.status === 403 && /reauth/.test(ap.text), ap.text)
      const tf = await old.api('POST', '/me/totp/setup', {})
      t.check('old session: 2FA enrolment → 403 reauth_required', tf.status === 403 && /reauth/.test(tf.text), tf.text)
    }
    const c = await fx.consoleAs('mina')
    const r = await c.openDrive(fx.slug, { returnPath: '/#/settings', reauth: true })
    const auth = r.authorize?.url ?? ''
    t.check('?reauth=1 → the console is asked for max_age=0', r.hops.some((h) => /max_age=0/.test(h)), r.hops)
    const fresh = r.drive ?? (r.secondFactor ? (await fx.completeSecond('mina', c.jar, r.secondFactor)).drive : null)
    t.check('the console asked for the password again (max_age=0) before signing', !!r.reauthAsked, r.hops)
    if (fresh) {
      const ap = await fresh.api('POST', '/me/app-passwords', { name: `s45-${Date.now().toString(36)}` })
      t.check('after re-authenticating: an app password can be made', ap.status === 200, ap.text)
    } else t.check('the console asked for the password again (a login page, not a silent pass)', /\/login/.test(auth) || /password/i.test(r.authorize?.text ?? ''), { error: r.error, auth })
    if (await t.has('console', 'mina made admin mid-session: every admin and mina are told')) {
      const owner = await fx.consoleAs('admin'), teamId = await owner.teamId(fx.slug)
      const uid = ((await owner.members(teamId)).json().members as { user: { id: string; email: string } }[]).find((m) => m.user.email === fx.creds('mina').email)?.user.id ?? ''
      await owner.setRole(teamId, uid, 'admin')
      let told = false
      for (let i = 0; i < 30 && !told; i++) { told = /admin/i.test((await (await fx.drive('admin')).get('/notices')).text); if (!told) await Bun.sleep(2000) }
      t.check('the admins hear that mina became an admin', told)
      await owner.setRole(teamId, uid, 'member')
    }
  },
} satisfies Scenario
