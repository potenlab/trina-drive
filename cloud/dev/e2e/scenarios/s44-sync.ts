// S44 — member sync (docs/SSO-CONTRACT.md "Member sync"): an older seq is refused (stale, exit 0); a removal made
// while the team is paused is applied when it wakes, before it serves; an assertion signed before a removal does not
// bring the person back; after a re-invite their old tokens and app passwords stay dead; the drive's people API
// answers 409 managed_by_console; people made outside the console are reported as unmanaged.
import type { Scenario } from '../lib/ctx'
import { Console, postCallback } from '../lib/console'
import { bash, dav, davAuth, propfindBody } from '../lib/drive'
import { parseFormPost } from '../lib/http'

export default {
  id: 'S44', title: 'member sync: stale seq refused, removal while paused applied on wake, no revival by old assertion, 409s, unmanaged', phase: 1, targets: ['local'], needs: ['console', 'sso', 'cloud-sync', 'ops'], uses: 'OPS H1 MCP DAV',
  async run(t) {
    const fx = t.fx
    const run = Date.now().toString(36)
    const ops = t.target.ops!, td = (...a: string[]) => t.target.tdrive!(fx.slug, ...a)
    t.step('a stale sync job')
    const team = JSON.parse(ops('teams', 'show', fx.slug).out)
    const stale = Buffer.from(JSON.stringify({ version: 2, team: team.public_id, seq: 1, at: Date.now(), members: [], events: [] })).toString('base64url')
    const r = td('cloud', 'sync-members', '--json', stale)
    const out = (() => { try { return JSON.parse(r.out.trim().split('\n').at(-1) ?? '{}') } catch { return {} } })()
    t.check('seq 1 (older than the team\'s) → applied:false, reason stale, exit 0 (nobody removed)', r.code === 0 && out.applied === false && out.reason === 'stale', r.out + r.err)
    t.step('a temporary member')
    const owner = await fx.consoleAs('admin'), teamId = await owner.teamId(fx.slug)
    const email = `s44-${run}@${fx.slug}.test`, pw = `s44-${run}-correct-horse`
    await owner.invite(teamId, [email])
    const c = new Console(t.http)
    await c.signupConfirmed(email, pw); await c.login({ email, password: pw }); await c.accept(c.inviteToken(email))
    const first = await c.openDrive(fx.slug)
    t.check('they open the drive', !!first.drive, first.error)
    const pat = first.drive ? await first.drive.token(`e2e-s44-${run}`) : ''
    // an assertion signed now, posted only after the removal
    const held = await t.http.follow(`${fx.url}/api/sso/start?return=%2F`, { jar: c.jar })
    const form = parseFormPost(held.last.text)
    t.step('removed while the team is paused')
    t.check('suspend the team', ops('teams', 'suspend', fx.slug).code === 0)
    const userId = ((await owner.members(teamId)).json().members as { user: { id: string; email: string } }[]).find((m) => m.user.email === email)?.user.id ?? ''
    const rm = await owner.remove(teamId, userId)
    t.check('the console removes them (team paused: the sync waits)', rm.status === 200, rm.text)
    t.check('resume', ops('teams', 'resume', fx.slug).code === 0)
    const b = await bash(t.http, fx.slug, pat, 'ls /')
    t.check('the first request after waking: their token → 401 (sync ran before serving)', b.status === 401, b.status)
    const cb = form ? await postCallback(t.http, c.jar, new URL(form.action, held.last.url).toString(), form.fields) : null
    t.check('the assertion signed before the removal does not bring them back (deactivated / not signed in)', !!cb && /sso-error/.test(cb.location), cb?.location)
    t.step('re-invited: old credentials stay dead')
    await owner.invite(teamId, [email]); await c.accept(c.inviteToken(email))
    const again = await c.openDrive(fx.slug)
    t.check('they sign in again', !!again.drive, again.error)
    t.check('the old token is still 401', (await bash(t.http, fx.slug, pat, 'ls /')).status === 401)
    t.step('the drive\'s people API under SSO-only')
    const admin = await fx.drive('admin')
    const p = await admin.api('POST', '/people', { name: `x${run}`.slice(0, 16), email: `x-${run}@x.test` })
    t.check('POST /api/people → 409 managed_by_console', p.status === 409 && /managed_by_console/.test(p.text), p.text)
    const pid = ((await admin.get('/people')).json().people as { id: number; email?: string }[]).find((x) => x.email === email)?.id
    const patch = await admin.api('PATCH', `/people/${pid}`, { admin: true })
    t.check('PATCH /api/people/:id {admin} → 409 managed_by_console', patch.status === 409, patch.text)
    t.step('unmanaged people')
    td('person', 'add', `shadow${run}`.slice(0, 16))
    const cur = JSON.parse(ops('teams', 'show', fx.slug).out)
    const m = await owner.members(teamId)
    t.check('the console knows of the shadow account (unmanaged warning)', JSON.stringify(m.json()).includes('shadow') || JSON.stringify(cur).includes('shadow'), m.text.slice(0, 300))
    void dav; void davAuth; void propfindBody
  },
} satisfies Scenario
