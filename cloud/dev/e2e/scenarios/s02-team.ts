// S02 — the team the operator made (`teams create … --plan team`: complimentary Team, as for the dogfood team) runs on a
// host the scaler launched; the owner's "ready" mail carries no setup token (SSO: Open drive) — today it still does;
// with SSO the owner opens the drive from the console, enrols the drive's second factor and lands in Files.
import type { Scenario } from '../lib/ctx'

export default {
  id: 'S02', title: 'operator team (complimentary Team) → running → ready mail → Open drive (SSO) → owner 2FA → Files', phase: 1, targets: ['local', 'aws'], uses: 'OPS H1 H2',
  async run(t) {
    const fx = t.fx
    if (t.target.ops) {
      const show = JSON.parse(t.target.ops('teams', 'show', fx.slug).out || '{}')
      t.check('active, plan team, complimentary, on a host', show.status === 'active' && show.plan === 'team' && show.sub_status === 'complimentary' && !!show.host, show)
    }
    const st = await t.http.req('GET', `${fx.url}/api/state`)
    t.check('the drive answers; setup is not pending (an admin exists)', st.status === 200 && st.json().setup_pending === false, st.text)
    if (t.target.outbox) {
      const ready = t.target.outbox().filter((m) => m.to === fx.creds('admin').email && /ready/i.test(m.subject)).at(-1)
      t.check('the owner got the ready mail', !!ready, t.target.outbox().filter((m) => m.to === fx.creds('admin').email).map((m) => m.subject))
      if (await t.has('sso-console', 'the ready mail has no setup token (Open drive instead)')) t.check('no #token= in the ready mail', !!ready && !/#token=/.test(ready.text), ready?.text.slice(0, 300))
    }
    if (await t.has('sso', 'Open drive from the console → SSO → the owner is a drive admin')) {
      const c = await fx.consoleAs('admin')
      const r = await c.openDrive(fx.slug)
      const me = r.drive ? (await r.drive.session()).me : null
      t.check('Open drive lands signed in as an admin (or at the second factor first)', (!!me && me.admin === true) || !!r.secondFactor, { error: r.error, hops: r.hops })
      t.check('…on the drive\'s own origin, at #/files', r.landing.startsWith(fx.url), r.landing)
    }
    if (await t.has('browser', 'the owner\'s path in a browser: console sign-in (TOTP) → Open drive → Files')) {
      const r = await (await (await import('../lib/ui')).ui()).ownerOpensDrive(t)
      if (r.pending) t.pending('the owner\'s path in a browser', r.pending)
      else t.check('browser: console → Open drive → Files', r.ok, r)
    }
  },
} satisfies Scenario
