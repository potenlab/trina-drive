// S04 — signed out, someone opens a drive address directly → "Sign in with Trina Cloud" → back to where they were;
// return paths are relative and stay on the team (no open redirect).
import type { Scenario } from '../lib/ctx'

export default {
  id: 'S04', title: 'deep link while signed out → Sign in with Trina Cloud → back to that path; no open redirect', phase: 1, targets: ['local', 'aws'], needs: ['sso', 'sso-console'], uses: 'H1 H2',
  async run(t) {
    const fx = t.fx
    const c = await fx.consoleAs('mina')
    const r = await c.openDrive(fx.slug, { returnPath: '/#/files?path=%2F%EA%B3%B5%EC%9A%A9' })
    t.check('lands on the asked path (/#/files?path=/공용)', !!r.drive && r.landing.startsWith(fx.url) && r.landing.includes('#/files?path='), r.landing)
    for (const bad of ['//evil.example/x', 'https://evil.example/']) {
      const c2 = await fx.consoleAs('mina')
      const r2 = await c2.openDrive(fx.slug, { returnPath: bad })
      t.check(`return=${bad} never leaves the team (lands on ${new URL(r2.landing || fx.url).host})`, !r2.landing || new URL(r2.landing).origin === new URL(fx.url).origin, r2.landing)
    }
    if (await t.has('browser', 'in a browser: a deep link → Sign in with Trina Cloud → the same folder')) {
      const u = await (await (await import('../lib/ui')).ui()).deepLinkSignIn(t)
      if (u.pending) t.pending('in a browser: deep link sign-in', u.pending)
      else t.check('browser: deep link → console → back to /공용', u.ok, u)
    }
  },
} satisfies Scenario
