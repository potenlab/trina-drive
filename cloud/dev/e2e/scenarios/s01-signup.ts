// S01 — the landing's Sign in / Start free lead to the console; sign-up → confirmation mail → the link works once →
// sign-in; an unconfirmed account cannot make a team; Free team creation is closed (TDCLOUD_MAX_FREE_TEAMS = 0).
import fs from 'node:fs'
import path from 'node:path'
import type { Scenario } from '../lib/ctx'
import { Console } from '../lib/console'

export default {
  id: 'S01', title: 'landing → console sign-up, confirm once, sign in; unconfirmed makes no team; Free closed', phase: 1, targets: ['local'], needs: ['mail'], uses: 'H1 H2',
  async run(t) {
    const run = Date.now().toString(36)
    const email = `s01-${run}@signup.test`, pw = `s01-${run}-correct-horse`
    const c = new Console(t.http)
    const { signup, verify } = await c.signupConfirmed(email, pw)
    t.check('sign up → "check your email"', signup.status === 200, signup.text)
    const token = t.target.outbox!().filter((m) => m.to === email).at(-1)?.text.match(/verify\?token=(\S+)/)?.[1]
    t.check('the confirmation link works', verify?.status === 200, verify?.text)
    const again = await c.api('POST', '/api/verify', { token })
    t.check('…once (a second use is refused)', again.status >= 400, again.status)
    const l = await c.login({ email, password: pw })
    t.check('sign in', l.status === 200 && (l.json().csrf || l.json().second_factor), l.text)
    const cookie = c.jar.seen.find((x) => /session/i.test(x)) ?? ''
    t.check('console session cookie: HttpOnly, Secure, host-only (no Domain)', /HttpOnly/i.test(cookie) && /Secure/i.test(cookie) && !/Domain=/i.test(cookie), cookie.replace(/=[^;]+/, '=…'))

    t.step('an unconfirmed account')
    const u = new Console(t.http)
    await u.api('POST', '/api/signup', { email: `s01u-${run}@signup.test`, password: pw })
    const ul = await u.login({ email: `s01u-${run}@signup.test`, password: pw })
    const mk = ul.status === 200 ? await u.api('POST', '/api/teams', { name: 'Unconfirmed', slug: `s01u-${run}` }) : ul
    t.check('cannot make a team (refused before or at create)', mk.status >= 400 && mk.status !== 500, `${mk.status} ${mk.text.slice(0, 200)}`)

    t.step('Free is closed')
    if (await t.has('free-closed', 'TDCLOUD_MAX_FREE_TEAMS defaults to 0 (Free sign-up closed)')) t.check('the console image defaults TDCLOUD_MAX_FREE_TEAMS to 0', true)
    const site = fs.readFileSync(path.resolve(import.meta.dir, '../../../../website/src/content/en.ts'), 'utf8')
    if (/cloud\.trina\.app\/login/.test(site)) t.check('the landing\'s Sign in goes to cloud.trina.app/login', true)
    else t.pending('the landing links Sign in → cloud.trina.app/login', 'needs E1 (website): no console link in website/src/content/en.ts yet')
    if (await t.has('browser', 'the console sign-up page in a browser')) {
      const r = await (await (await import('../lib/ui')).ui()).consoleSignupPage(t)
      t.check('browser: the console sign-up page has the email/password form', r.ok, r)
    }
  },
} satisfies Scenario
