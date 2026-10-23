// S32 — a product image upgrade (operator `teams upgrade`): the team comes back on the same data with the same
// people, rules, tokens, app passwords and sessions (and, with SSO, the same sign-in). Local only by default: on AWS it
// runs only with E2E_OPS and E2E_UPGRADE=1 (it restarts the test team).
import { CANARY } from '../../seed-team'
import type { Scenario } from '../lib/ctx'
import { bash, dav, davAuth } from '../lib/drive'

export default {
  id: 'S32', title: 'teams upgrade: data, people, rules, tokens, app passwords and sessions survive', phase: 1, targets: ['local', 'aws'], needs: ['ops'], uses: 'OPS H1 MCP DAV',
  async run(t) {
    const fx = t.fx
    if (t.target.kind === 'aws' && process.env.E2E_UPGRADE !== '1') t.skip('restarts the test team: set E2E_UPGRADE=1 to run it on AWS')
    const kim = await fx.token('kim'), ap = await fx.appPassword('mina')
    const mina = await fx.drive('mina')
    const before = { kim: (await bash(t.http, fx.slug, kim, "cat '/재무/결산.md'")).stdout, mina: (await mina.list('/')).text }
    t.check('before: kim\'s AI reads /재무, mina\'s list works', before.kim.includes(CANARY.재무) && before.mina.includes('공용'), before)
    t.step('upgrade')
    const up = t.target.ops!('teams', 'upgrade', fx.slug)
    t.check(`teams upgrade ${fx.slug}`, up.code === 0, (up.out + up.err).slice(-400))
    let ok = false
    for (let i = 0; i < 60 && !ok; i++) { ok = (await t.http.req('GET', `${fx.url}/api/state`)).status === 200; if (!ok) await Bun.sleep(2000) }
    t.check('the team answers again', ok)
    const k2 = await bash(t.http, fx.slug, kim, "cat '/재무/결산.md'; ls /")
    t.check('kim\'s token still works and still reads /재무 (rules kept)', k2.stdout.includes(CANARY.재무), k2)
    const m2 = await mina.list('/')
    t.check('mina\'s web session survived', m2.status === 200 && m2.text.includes('공용') && !m2.text.includes('재무'), m2.text.slice(0, 200))
    const d2 = await dav(t.http, fx.slug, davAuth(fx.login('mina'), ap), 'GET', '/공용/notice.md')
    t.check('mina\'s app password still mounts', d2.status === 200 && d2.text.includes(CANARY.공용), d2.status)
    const hidden = await bash(t.http, fx.slug, await fx.token('mina'), "cat '/재무/결산.md'")
    t.check('…and hidden is still hidden', !hidden.stdout.includes(CANARY.재무), hidden)
    if (t.target.inTeam) {
      const cols = t.target.inTeam(fx.slug, ['/usr/local/bin/bun', '-e', "const { Database } = require('bun:sqlite'); const d = new Database('/data/db/store.db', { readonly: true }); console.log(d.query(\"SELECT name FROM sqlite_master WHERE type='table'\").all().map((x) => x.name).join(','))"])
      t.check('the database opened with every table (migrations ran)', cols.code === 0 && /rules/.test(cols.out) && /audit/.test(cols.out), cols.out.slice(0, 300) + cols.err.slice(0, 200))
    }
    if (await t.has('sso', 'SSO sign-in after the upgrade')) {
      const c = await fx.consoleAs('mina')
      const r = await c.openDrive(fx.slug)
      t.check('mina opens the drive from the console after the upgrade', !!r.drive, r.error)
    }
    t.skipPart('upgrade from the previous release\'s data (0.2)', 'run with the rollback image first: TDCLOUD_IMAGE=<rollback tag> cloud/dev/up.sh --no-teams, make the fixture, then rebuild and run S32')
  },
} satisfies Scenario
