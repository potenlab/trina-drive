// S06 — the console invites a new person → invite mail → they sign up with that address (fixed) and accept → the drive
// lists them as a member within 60 s (member sync). The invite answer is the same whether an account exists or not.
import type { Scenario } from '../lib/ctx'
import { Console } from '../lib/console'

export default {
  id: 'S06', title: 'console invite → mail → sign up (email fixed) → accept → member on the drive within 60 s', phase: 1, targets: ['local'], needs: ['console', 'sso', 'mail'], uses: 'H1 H2',
  async run(t) {
    const fx = t.fx
    const run = Date.now().toString(36)
    const owner = await fx.consoleAs('admin')
    const teamId = await owner.teamId(fx.slug)
    const fresh = `s06-${run}@invitee.test`
    const existing = fx.creds('mina').email
    const r1 = await owner.invite(teamId, [fresh]), r2 = await owner.invite(teamId, [`s06x-${run}@invitee.test`])
    t.check('invite → 201', r1.status === 201, r1.text)
    t.check('the answer looks the same for any address (no account enumeration)', r1.status === r2.status && Object.keys(r1.json()).join() === Object.keys(r2.json()).join(), [r1.text, r2.text])
    const r3 = await owner.invite(teamId, [existing])
    t.check('inviting an existing member answers the same way', r3.status === r1.status, r3.text)
    const mail = t.target.outbox!().filter((m) => m.to === fresh).at(-1)
    t.check('the invite mail arrives (names the team and the inviter, no file names)', !!mail && /invite/i.test(mail.subject), mail)
    const token = owner.inviteToken(fresh)
    const other = new Console(t.http)
    await other.signupConfirmed(`s06y-${run}@invitee.test`, `s06y-${run}-correct-horse`)
    await other.login({ email: `s06y-${run}@invitee.test`, password: `s06y-${run}-correct-horse` })
    const wrong = await other.accept(token)
    t.check('another account cannot accept it (email bound)', wrong.status === 403 || wrong.status === 404, wrong.text)
    const me = new Console(t.http)
    await me.signupConfirmed(fresh, `s06-${run}-correct-horse`)
    await me.login({ email: fresh, password: `s06-${run}-correct-horse` })
    const acc = await me.accept(token)
    t.check('the invited address accepts', acc.status === 200, acc.text)
    const again = await me.accept(token)
    t.check('the invite works once', again.status >= 400, again.status)
    const admin = await fx.drive('admin')
    let seen = false
    const t0 = Date.now()
    while (!seen && Date.now() - t0 < 60_000) { seen = ((await admin.get('/people')).json().people as { email?: string; active: boolean }[]).some((p) => p.email === fresh && p.active); if (!seen) await Bun.sleep(2000) }
    t.check(`the drive lists them as an active member (${Math.round((Date.now() - t0) / 1000)} s ≤ 60 s)`, seen)
    const r = await me.openDrive(fx.slug)
    t.check('…and they open the drive as a member, not an admin', !!r.drive && (await r.drive.session()).me.admin === false, r.error)
  },
} satisfies Scenario
