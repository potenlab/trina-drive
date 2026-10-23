// S08 — member → admin (the drive follows within 60 s), then removal: from the next request the person's web session,
// tokens, OAuth grants and app passwords are refused, and the next SSO attempt is the non-member 404. Today (no
// console) the drive's own deactivation is checked — the path member sync uses to remove someone.
import type { Scenario } from '../lib/ctx'
import { Console } from '../lib/console'
import { Drive, bash, dav, davAuth, propfindBody } from '../lib/drive'

export default {
  id: 'S08', title: 'promote to admin, then remove: session, PAT, OAuth, app password 401 at once; next SSO 404', phase: 1, targets: ['local'], uses: 'H1 MCP DAV',
  async run(t) {
    const fx = t.fx
    const run = Date.now().toString(36)
    const admin = await fx.drive('admin')
    const name = `tmp${run}`.slice(0, 20), email = `${name}@${fx.slug}.test`, pw = `${name}-correct-horse-1`
    let d: Drive
    let consoleUser: { c: Console; teamId: string; userId: string } | null = null
    if ((await t.features.get('console')).ok && (await t.features.get('sso')).ok) {
      const owner = await fx.consoleAs('admin')
      const teamId = await owner.teamId(fx.slug)
      await owner.invite(teamId, [email])
      const c = new Console(t.http)
      await c.signupConfirmed(email, pw)
      await c.login({ email, password: pw })
      await c.accept(c.inviteToken(email))
      const r = await c.openDrive(fx.slug)
      if (!r.drive) { t.check('the new member opens the drive', false, r.error); return }
      d = r.drive
      const m = (await owner.members(teamId)).json().members as { user: { id: string; email: string } }[]
      consoleUser = { c, teamId, userId: m.find((x) => x.user.email === email)?.user.id ?? '' }
      t.step('console: member → admin')
      const pr = await owner.setRole(teamId, consoleUser.userId, 'admin')
      t.check('promote → 200', pr.status === 200, pr.text)
      let isAdmin = false
      for (let i = 0; i < 30 && !isAdmin; i++) { isAdmin = ((await admin.get('/people')).json().people as { email?: string; admin: boolean }[]).some((p) => p.email === email && p.admin); if (!isAdmin) await Bun.sleep(2000) }
      t.check('the drive has them as an admin within 60 s', isAdmin)
      const notices = await admin.get('/notices')
      t.check('the other admins are told someone became admin', /admin/i.test(notices.text), notices.text.slice(0, 300))
    } else {
      t.pending('console promote → drive admin within 60 s; console removal; next SSO 404', 'needs D1+B1 (console members API, SSO): the drive\'s own deactivation is checked instead')
      const add = await admin.api('POST', '/people', { name, email })
      const link = t.target.teamMail?.().filter((m) => m.to === email).at(-1)?.text.match(/\/#\/invite\/(\S+)/)?.[1]
      const acc = await t.http.req('POST', `${fx.url}/api/links/accept`, { body: { kind: 'invite', token: link, password: pw } })
      t.check('a temporary person joins', add.status === 200 && acc.status === 200, acc.text)
      d = await new Drive(t.http, fx.slug, name).login({ name, email, password: pw })
    }
    const pat = await d.token(`e2e-s08-${run}`, { password: pw })
    const ap = await d.appPassword('s08', pw).catch(() => '')
    t.check('they have a session, a token and an app password', !!pat && !!ap)
    t.step('remove')
    const pid = ((await admin.get('/people')).json().people as { id: number; email?: string }[]).find((p) => p.email === email)?.id
    const rm = consoleUser ? await (await fx.consoleAs('admin')).remove(consoleUser.teamId, consoleUser.userId) : await admin.api('PATCH', `/people/${pid}`, { active: false })
    t.check(`removed (${consoleUser ? 'console' : 'drive admin'})`, rm.status === 200, rm.text)
    let cut = false
    for (let i = 0; i < 30 && !cut; i++) { cut = (await d.get('/session')).status === 401; if (!cut) await Bun.sleep(2000) }
    t.check('their web session → 401', cut)
    t.check('their token → 401 on /mcp', (await bash(t.http, fx.slug, pat, 'ls /')).status === 401)
    t.check('their app password → 401 on /dav', (await dav(t.http, fx.slug, davAuth(name, ap), 'PROPFIND', '/', { body: propfindBody, headers: { depth: '0' } })).status === 401)
    if (consoleUser) {
      const again = await consoleUser.c.openDrive(fx.slug)
      t.check('the next Open drive → 404 (no longer a member)', again.error === 'not_found', again.error)
    } else t.pending('OAuth grants revoked on removal', 'needs B1 (revokeTokensOf + OAuth grants on deactivation through sync)')
  },
} satisfies Scenario
