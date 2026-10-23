// The Free plan (src/free.ts) with a fake driver and a movable clock: sign-up → confirmation → provisioning; abuse
// limits (disposable mail, per-address rate, one per mailbox, Turnstile); the cap and its waitlist; inactivity →
// warning → pause → wake → pause again or active again; 60/83/90 days paused → final backup → deleted → backups
// removed 30 days later; upgrade through Paddle on the same team; and free teams' quarter slots in the scaler.
import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { verifyAudit } from '../src/audit'
import { teamBySlug, updateTeam, type HostRow } from '../src/db'
import { emailKey, isDisposable } from '../src/free'
import { PLANS } from '../src/plans'
import { PROBE_EVERY_MS } from '../src/scaler'
import { event, setup, webhook, type Env } from './helpers'

let env: Env
afterEach(() => env?.cleanup())

const DAY = 86400_000, HOUR = 3600_000, MIN = 60_000
let at = Date.now()
const clock = () => at
const later = (ms: number) => { at += ms }
function start(e: Record<string, string> = {}, pool = false) {
  at = Date.now()
  env = setup(e, { clock, pool })
  return env
}
const team = (slug: string) => teamBySlug(env.cloud.db, slug)!
const mails = (to: string, re: RegExp = /./) => env.mailer.sent.filter((m) => m.to === to && re.test(m.subject))
const ops = (re: RegExp) => mails(env.cfg.opsEmail, re)
async function jobs() { env.cloud.db.query('UPDATE jobs SET run_at = 0 WHERE done_at IS NULL').run(); await env.cloud.runDueJobs() }
const sweep = () => env.cloud.free.sweep()
const audits = (action: string) => env.cloud.db.query<{ n: number }, [string]>('SELECT count(*) AS n FROM audit WHERE action = ?').get(action)!.n

async function signup(email: string, name: string, slug?: string, ip = '203.0.113.9') {
  return env.call('POST', '/api/free/signup', { body: { email, name, ...(slug ? { slug } : {}) }, ip })
}
const linkOf = (to: string) => env.mailer.sent.filter((m) => m.to === to).at(-1)?.text.match(/\/free\/verify\?token=(\S+)/)?.[1]
async function verify(token: string | undefined) {
  const r = await env.call('POST', '/api/free/verify', { body: { token } })
  return { status: r.status, body: await r.json() as { status?: string; url?: string; error?: string } }
}
/** sign-up → link → verify → provisioned */
async function freeTeam(slug: string, email = `owner@${slug}.test`) {
  expect((await signup(email, `${slug} Inc`, slug)).status).toBe(200)
  expect((await verify(linkOf(email))).body.status).toBe('provisioning')
  await jobs()
  expect(team(slug).status).toBe('active')
  return team(slug)
}

describe('sign-up without Paddle', () => {
  test('email + team name → one-time confirmation link → provisioned free team → setup mail with #token=', async () => {
    start()
    const page = await env.call('GET', '/free')
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('action="/free"')
    expect((await signup('Founder@FreeCo.test', 'Free Co', 'freeco')).status).toBe(200)
    const token = linkOf('founder@freeco.test')!
    expect(token).toBeString()
    expect(env.cloud.db.query("SELECT status FROM free_signups").get()).toEqual({ status: 'pending' })
    // the link page only shows a button (mail scanners)
    expect(await (await env.call('GET', `/free/verify?token=${token}`)).text()).toContain('Confirm and start')
    const v = await verify(token)
    expect(v.status).toBe(200)
    expect(v.body.status).toBe('provisioning')
    expect(v.body.url).toBe('https://freeco.cloud.example.com')
    expect((await verify(token)).status).toBe(404) // once
    const t = team('freeco')
    expect([t.plan, t.status, t.sub_status, t.subscription_id]).toEqual(['free', 'provisioning', 'free', null])
    await jobs()
    expect(team('freeco').status).toBe('active')
    expect(team('freeco').last_activity_at).toBe(at) // the idle clock starts when it runs
    const ready = mails('founder@freeco.test', /^Your Trina Drive is ready/)[0]!
    expect(ready.text).toMatch(/https:\/\/freeco\.cloud\.example\.com\/#token=tdrive_setup_/)
    expect(ready.text).toContain('Free plan: 1 GB of files and up to 3 people')
    // the plan's limits and settings reach the container
    const spec = env.driver.instances.get('freeco')!.spec
    expect([spec.plan.cpus, spec.plan.memoryMb, spec.plan.pids, spec.plan.slots, spec.plan.diskGb]).toEqual([0.5, 768, 256, 0.25, 6])
    expect(spec.env.TDRIVE_STORAGE_QUOTA).toBe('1GB')
    expect(spec.env.TDRIVE_MAX_PEOPLE).toBe('3')
    expect(PLANS.team.maxPeople).toBeNull()
    expect(verifyAudit(env.cloud.db).ok).toBe(true)
    for (const a of ['free.signup', 'user.created_free', 'team.create', 'team.provisioned']) expect(audits(a)).toBe(1)
  })

  test('the confirmation link expires after 24 hours; a newer request replaces an older link', async () => {
    start()
    await signup('a@late.test', 'Late')
    const old = linkOf('a@late.test')
    await signup('a+again@late.test', 'Late')
    expect((await verify(old)).status).toBe(404) // replaced (same mailbox)
    const fresh = linkOf('a+again@late.test')
    later(24 * HOUR + MIN)
    expect((await verify(fresh)).status).toBe(404)
    expect(env.cloud.db.query("SELECT count(*) AS n FROM teams").get()).toEqual({ n: 0 })
  })

  test('an address taken by a team (or a pending sign-up) is refused at once; an empty one comes from the name', async () => {
    start()
    await freeTeam('taken')
    const r = await signup('x@y.test', 'X', 'taken')
    expect(r.status).toBe(409)
    expect((await signup('z@y.test', 'Bad', 'www')).status).toBe(400)
    await signup('n@named.test', 'Named Co.')
    await verify(linkOf('n@named.test'))
    expect(team('named-co').plan).toBe('free')
  })
})

describe('abuse limits', () => {
  test('mailbox keys and disposable domains', () => {
    expect(emailKey('J.Doe+news@GoogleMail.com')).toBe('jdoe@gmail.com')
    expect(emailKey('j.doe+x@acme.test')).toBe('j.doe@acme.test')
    expect(isDisposable('a@mailinator.com')).toBe(true)
    expect(isDisposable('a@eu.yopmail.com')).toBe(true)
    expect(isDisposable('a@acme.test')).toBe(false)
    expect(isDisposable('a@acme.test', ['acme.test'])).toBe(true)
  })

  test('disposable mail is refused; TDCLOUD_FREE_BLOCKED_DOMAINS adds domains', async () => {
    start({ TDCLOUD_FREE_BLOCKED_DOMAINS: 'spam.example' })
    for (const e of ['x@mailinator.com', 'x@sub.guerrillamail.com', 'x@spam.example']) {
      const r = await signup(e, 'X')
      expect(r.status).toBe(400)
      expect((await r.json() as { error: string }).error).toBe('disposable_email')
    }
    expect(env.mailer.sent).toHaveLength(0)
  })

  test('per client address: 5 sign-ups an hour, then 429; another address is not affected', async () => {
    start()
    for (let i = 0; i < 5; i++) expect((await signup(`p${i}@rate.test`, 'R', undefined, '198.51.100.7')).status).toBe(200)
    expect((await signup('p5@rate.test', 'R', undefined, '198.51.100.7')).status).toBe(429)
    expect((await signup('p6@rate.test', 'R', undefined, '198.51.100.8')).status).toBe(200)
  })

  test('one free team per mailbox: a second request gets a reminder (no link), a link raced past it is refused', async () => {
    start()
    const t = await freeTeam('first', 'jane.doe@gmail.com')
    const r = await signup('JaneDoe+second@googlemail.com', 'Second')
    expect(r.status).toBe(200) // same answer: nothing to enumerate
    const m = env.mailer.sent.at(-1)!
    expect(m.subject).toBe('You already have a free Trina Drive')
    expect(m.text).toContain(env.cloud.url(t))
    expect(m.text).not.toContain('/free/verify')
    // a link made before the address had a team
    start()
    await signup('dup@race.test', 'Race')
    const link = linkOf('dup@race.test')
    await env.cloud.adminCreateTeam({ email: 'dup@race.test', slug: 'race-one', plan: 'free', actor: 'admin:test' })
    const v = await verify(link)
    expect(v.body.status).toBe('exists')
    expect(v.body.url).toBe('https://race-one.cloud.example.com')
    expect(env.cloud.db.query("SELECT count(*) AS n FROM teams WHERE plan = 'free'").get()).toEqual({ n: 1 })
    // paid teams of the same person do not count
    expect(env.cloud.free.count()).toBe(1)
  })

  test('Cloudflare Turnstile when configured: no token or a failed check is refused; the widget is on the page', async () => {
    start({ TDCLOUD_TURNSTILE_SECRET: 'ts-secret', TDCLOUD_TURNSTILE_SITE_KEY: 'ts-site' })
    const seen: string[] = []
    let ok = true
    env.cloud.free.fetchFn = (async (_u: string, init: RequestInit) => { seen.push(String(init.body)); if (!ok) throw new Error('down'); return Response.json({ success: init.body!.toString().includes('response=good') }) }) as unknown as typeof fetch
    const page = await env.call('GET', '/free')
    expect(await page.text()).toContain('data-sitekey="ts-site"')
    expect(page.headers.get('content-security-policy')).toContain('https://challenges.cloudflare.com')
    expect((await signup('a@ts.test', 'T')).status).toBe(400) // no token
    expect((await env.call('POST', '/api/free/signup', { body: { email: 'a@ts.test', name: 'T', 'cf-turnstile-response': 'bad' } })).status).toBe(400)
    expect((await env.call('POST', '/api/free/signup', { body: { email: 'a@ts.test', name: 'T', 'cf-turnstile-response': 'good' } })).status).toBe(200)
    expect(seen.at(-1)).toContain('secret=ts-secret')
    expect(seen.at(-1)).toContain('remoteip=203.0.113.9')
    ok = false
    expect((await env.call('POST', '/api/free/signup', { body: { email: 'b@ts.test', name: 'T', 'cf-turnstile-response': 'good' } })).status).toBe(400)
  })
})

describe('the cap and the waitlist', () => {
  test('past TDCLOUD_MAX_FREE_TEAMS a confirmed sign-up waits (owner of the service told); free admit lets it in', async () => {
    start({ TDCLOUD_MAX_FREE_TEAMS: '1' })
    const first = await freeTeam('one')
    expect(await (await env.call('GET', '/free')).text()).toContain('Free is full')
    await signup('two@two.test', 'Two', 'two')
    expect(env.mailer.sent.at(-1)!.text).toContain('waitlist')
    const v = await verify(linkOf('two@two.test'))
    expect(v.body.status).toBe('waitlisted')
    expect(teamBySlug(env.cloud.db, 'two')).toBeNull()
    expect(mails('two@two.test', /waitlist/)).toHaveLength(1)
    expect(ops(/free waitlist: two@two\.test \(1 waiting\)/)).toHaveLength(1)
    expect(env.cloud.free.waitlist().map((s) => s.email)).toEqual(['two@two.test'])
    // asking again while waiting: told, no new link
    await signup('two@two.test', 'Two')
    expect(env.mailer.sent.at(-1)!.subject).toContain('waitlist')
    await expect(env.cloud.free.admit('two@two.test', 'admin:test')).rejects.toThrow(/TDCLOUD_MAX_FREE_TEAMS/)
    await env.cloud.deleteTeam(first, 'admin:test')
    const t = await env.cloud.free.admit('two@two.test', 'admin:test')
    expect([t.slug, t.plan, t.status]).toEqual(['two', 'free', 'provisioning'])
    await jobs()
    expect(mails('two@two.test', /^Your Trina Drive is ready/)).toHaveLength(1)
    expect(env.cloud.free.waitlist()).toHaveLength(0)
    expect(env.cloud.free.stats()).toMatchObject({ cap: 1, total: 1, active: 1, waitlist: 0, deleted: 1 })
  })
})

describe('inactivity', () => {
  test('6 days: warned once; 7 days: paused (data kept); Wake up starts it; unused it pauses again; used it is a normal team', async () => {
    start()
    const t = await freeTeam('idle')
    const owner = 'owner@idle.test'
    later(5 * DAY)
    env.driver.activity.set('idle', at) // someone used it on day 5
    expect((await sweep()).checked).toBe(1)
    expect(team('idle').last_activity_at).toBe(at)
    later(6 * DAY - HOUR) // 6 days minus an hour after that: nothing yet
    expect((await sweep()).warned).toEqual([])
    later(HOUR)
    expect((await sweep()).warned).toEqual(['idle'])
    expect(mails(owner, /^Your free Trina Drive pauses/)).toHaveLength(1)
    later(2 * HOUR)
    expect((await sweep()).warned).toEqual([]) // once per idle period
    later(DAY)
    const r = await sweep()
    expect(r.paused).toEqual(['idle'])
    let row = team('idle')
    expect([row.status, row.suspend_reason, row.paused_at]).toEqual(['suspended', 'inactive', at])
    expect(env.driver.calls).toContain('stop idle')
    expect(env.driver.instances.get('idle')!.state).toBe('stopped') // stopped, not destroyed
    expect(mails(owner, /^Your free Trina Drive is paused/)).toHaveLength(1)
    expect(mails(owner, /^Your Trina Drive is paused/)).toHaveLength(0) // not the billing mail
    expect(env.cloud.hostAllowed('idle.cloud.example.com')).toBe(true) // the paused page keeps its certificate
    const pausedAt = row.paused_at!

    // the paused page's Wake up: control plane page, button, job, polling API
    expect((await (await env.call('GET', '/api/wake/idle')).json() as { state: string }).state).toBe('paused')
    expect(await (await env.call('GET', '/wake/idle')).text()).toContain('Wake up')
    const w = await env.call('POST', '/wake/idle', { headers: { origin: 'https://cloud.example.com' } })
    expect(await w.text()).toContain('/static/wake.js')
    expect((await (await env.call('GET', '/api/wake/idle')).json() as { state: string }).state).toBe('starting')
    await jobs()
    const st = await (await env.call('GET', '/api/wake/idle')).json() as { state: string; url: string }
    expect(st).toEqual({ state: 'running', url: 'https://idle.cloud.example.com' })
    row = team('idle')
    expect([row.status, row.woke_at, row.paused_at]).toEqual(['active', at, pausedAt])
    expect(env.driver.calls.filter((c) => c === 'create idle')).toHaveLength(1) // the same container and data

    // nobody uses it: paused again after the wake grace (1 h), quietly; the deletion clock keeps the first pause
    later(30 * MIN)
    expect((await sweep()).repaused).toEqual([])
    later(31 * MIN)
    expect((await sweep()).repaused).toEqual(['idle'])
    row = team('idle')
    expect([row.status, row.paused_at]).toEqual(['suspended', pausedAt])
    expect(mails(owner, /^Your free Trina Drive is paused/)).toHaveLength(1)

    // the owner signs in to the control plane with an email link: that wakes it too
    await env.call('POST', '/api/login/link', { body: { email: owner } })
    const lt = env.mailer.sent.at(-1)!.text.match(/login\/link\?token=(\S+)/)![1]
    const l = await env.call('POST', '/api/login/link/confirm', { body: { token: lt } })
    expect(l.status).toBe(200)
    expect((await env.call('POST', '/api/login/link/confirm', { body: { token: lt } })).status).toBe(404) // once
    await jobs()
    expect(team('idle').status).toBe('active')
    // and this time someone uses it: a normal running team again
    later(MIN)
    env.driver.activity.set('idle', at)
    expect((await sweep()).active_again).toEqual(['idle'])
    row = team('idle')
    expect([row.woke_at, row.paused_at, row.delete_warnings]).toEqual([null, null, 0])
    for (const a of ['free.idle_warned', 'free.paused', 'free.wake_requested', 'free.woke', 'free.repaused', 'free.active_again']) expect(audits(a)).toBeGreaterThan(0)
    void t
  })

  test('nothing is decided on activity that could not be read; paid teams are never asked and never pause', async () => {
    start()
    await freeTeam('blind')
    await env.cloud.adminCreateTeam({ email: 'p@paid.test', slug: 'paid', actor: 'admin:test' })
    await jobs()
    env.driver.activityFails = true
    later(30 * DAY)
    const r = await sweep()
    expect([r.warned, r.paused]).toEqual([[], []])
    expect(team('blind').status).toBe('active')
    env.driver.activityFails = false
    later(MIN) // near a step it is asked again at most every minute
    expect((await sweep()).paused).toEqual(['blind'])
    later(60 * DAY)
    await sweep()
    expect(team('paid').status).toBe('active')
    expect(env.driver.calls.some((c) => c.startsWith('exec paid activity'))).toBe(false)
  })

  test('paused 60 and 83 days: warnings; 90 days: final backup, deleted; its backups go 30 days later', async () => {
    start()
    await freeTeam('gone')
    const owner = 'owner@gone.test'
    later(7 * DAY)
    await sweep()
    expect(team('gone').status).toBe('suspended')
    later(59 * DAY)
    expect((await sweep()).delete_warned).toEqual([])
    later(DAY)
    expect((await sweep()).delete_warned).toEqual(['gone'])
    expect(mails(owner, /^Your paused Trina Drive is deleted on/)).toHaveLength(1)
    expect(mails(owner, /deleted on/)[0]!.text).toContain('30 days from now')
    expect((await sweep()).delete_warned).toEqual([])
    later(23 * DAY)
    expect((await sweep()).delete_warned).toEqual(['gone'])
    expect(mails(owner, /^Your paused Trina Drive is deleted on/)).toHaveLength(2)
    later(7 * DAY - MIN)
    expect((await sweep()).deleted).toEqual([])
    later(MIN)
    expect((await sweep()).deleted).toEqual(['gone'])
    const t = team('gone')
    expect(t.status).toBe('deleted')
    expect(env.driver.calls.slice(-3)).toEqual(['start gone', 'backup gone', 'destroy gone'])
    expect(env.driver.calls).toContain('backup gone')
    expect(env.driver.calls.indexOf('backup gone')).toBeLessThan(env.driver.calls.indexOf('destroy gone'))
    const finals = env.cloud.db.query<{ object_key: string }, [number]>("SELECT object_key FROM backups WHERE team_id = ? AND kind = 'final'").all(t.id)
    expect(finals).toHaveLength(2)
    expect(mails(owner, /^Your free Trina Drive was deleted/)).toHaveLength(1)
    const file = path.join(env.dir, 'backups', finals[0]!.object_key)
    expect(fs.existsSync(file)).toBe(true)
    later(29 * DAY)
    expect((await sweep()).pruned).toBe(0)
    later(2 * DAY)
    expect((await sweep()).pruned).toBe(2)
    expect(fs.existsSync(file)).toBe(false)
    expect(env.cloud.db.query('SELECT count(*) AS n FROM backups WHERE team_id = ?').get(t.id)).toEqual({ n: 0 })
    expect(teamBySlug(env.cloud.db, 'gone')!.slug).toBe('gone') // the address is never handed to someone else
    expect(verifyAudit(env.cloud.db).ok).toBe(true)
  })
})

describe('upgrade', () => {
  const sub = (team: string, status = 'active', price = 'pri_team_m') =>
    ({ id: 'sub_up', status, customer_id: 'ctm_up', items: [{ price: { id: price }, quantity: 1 }], custom_data: { tdcloud_team: team } })

  test('a paused free team bought from the dashboard: the same team, data and address on Team; never paused again', async () => {
    start({ PADDLE_CLIENT_TOKEN: 'test_tok' })
    const t0 = await freeTeam('grow')
    later(7 * DAY)
    await sweep()
    expect(env.cloud.free.isPaused(team('grow'))).toBe(true)
    // the owner signs in with a link and sees the upgrade buttons for this team
    await env.call('POST', '/api/login/link', { body: { email: 'owner@grow.test' } })
    const lt = env.mailer.sent.at(-1)!.text.match(/login\/link\?token=(\S+)/)![1]
    const l = await env.call('POST', '/login/link/confirm', { body: { token: lt }, headers: { origin: 'https://cloud.example.com' } })
    expect(l.status).toBe(303)
    const dash = await (await env.call('GET', '/dashboard', { headers: { cookie: l.headers.get('set-cookie')!.split(';')[0]! } })).text()
    expect(dash).toContain(`data-team="${t0.public_id}"`)
    expect(dash).toContain('Upgrade to Team (monthly)')
    expect(dash).toContain('Upgrade to Business (monthly)')
    env.cloud.db.query("UPDATE jobs SET done_at = 1 WHERE kind = 'wake'").run() // the sign-in's wake: not needed here

    expect((await webhook(env, event('subscription.created', sub(t0.public_id)))).status).toBe(200)
    await jobs()
    const t = team('grow')
    expect([t.plan, t.status, t.host, t.number, t.public_id, t.subscription_id]).toEqual(['team', 'active', t0.host, t0.number, t0.public_id, 'sub_up'])
    expect([t.paused_at, t.woke_at, t.idle_warned_at]).toEqual([null, null, null])
    expect(env.driver.calls.filter((c) => c === 'create grow')).toHaveLength(1) // never made again from scratch
    const spec = env.driver.instances.get('grow')!
    expect([spec.state, spec.spec.plan.id, spec.spec.env.TDRIVE_STORAGE_QUOTA, spec.spec.env.TDRIVE_MAX_PEOPLE]).toEqual(['running', 'team', '100GB', undefined])
    expect(audits('free.upgraded')).toBe(1)
    later(60 * DAY)
    await sweep()
    expect(team('grow').status).toBe('active')
  })

  test('a running free team to Business; events that are not a paying subscription leave it free', async () => {
    start()
    const t0 = await freeTeam('biz')
    expect(await (await webhook(env, event('subscription.created', sub(t0.public_id, 'past_due', 'pri_biz_m')))).text()).toBe('ok')
    expect(team('biz').plan).toBe('free')
    expect(ops(/not applied/)).toHaveLength(1)
    await webhook(env, event('subscription.activated', sub(t0.public_id, 'active', 'pri_biz_m')))
    await jobs()
    expect(team('biz').plan).toBe('business')
    expect(env.driver.calls).toContain('limits biz business')
  })
})

describe('free teams on hosts (scaler)', () => {
  const scaler = () => env.cloud.scaler!
  const host = (id: string) => env.cloud.db.query<HostRow, [string]>('SELECT * FROM hosts WHERE id = ?').get(id)
  async function bootAll() { env.pool.boot(); later(PROBE_EVERY_MS); await scaler().tick() }
  async function free(...slugs: string[]) { for (const s of slugs) await env.cloud.adminCreateTeam({ email: `o@${s}.test`, slug: s, plan: 'free', actor: 'admin:test' }) }
  async function settle() { for (let i = 0; i < 4; i++) { await jobs(); await scaler().tick(); await bootAll(); await jobs() } }

  test('a quarter slot each, at most the free share of a host, never the reserved last host; paid teams can still launch it', async () => {
    // 2 slots per host → free share 1 slot = 4 free teams; 2 hosts at most, 1 kept for paid teams
    start({ TDCLOUD_MAX_TEAMS_PER_HOST: '2', TDCLOUD_MAX_HOSTS: '2' }, true)
    await free('fr1', 'fr2', 'fr3', 'fr4', 'fr5')
    await settle()
    expect(env.pool.desired).toBe(1)
    const h1 = team('fr1').host!
    expect(['fr1', 'fr2', 'fr3', 'fr4'].map((s) => [team(s).status, team(s).host])).toEqual(Array(4).fill(['active', h1]))
    expect(team('fr5').status).toBe('provisioning') // 1 of 2 slots used, but the free share is full
    expect(scaler().view().find((h) => h.id === h1)).toMatchObject({ used: 1, freeUsed: 1, free: 1 })
    expect(ops(/host limit reached/)).toHaveLength(0) // a free team waiting is not the paid limit
    // a paid team fits on the same host (free teams leave the other half)
    await env.cloud.adminCreateTeam({ email: 'o@pd1.test', slug: 'pd1', actor: 'admin:test' })
    await settle()
    expect(team('pd1').host).toBe(h1)
    // a second paid team launches the reserved host; the waiting free team goes into its spare
    await env.cloud.adminCreateTeam({ email: 'o@pd2.test', slug: 'pd2', actor: 'admin:test' })
    await settle()
    expect(env.pool.desired).toBe(2)
    const h2 = team('pd2').host!
    expect(h2).not.toBe(h1)
    expect([team('fr5').status, team('fr5').host]).toEqual(['active', h2])
    // a free team that waits long no longer keeps the scaler in fast passes
    await free('fr6', 'fr7', 'fr8', 'fr9')
    await settle()
    expect(team('fr9').status).toBe('provisioning')
    later(16 * MIN)
    await jobs()
    expect(scaler().urgent()).toBe(false)
  })

  test('free teams prefer a host with paid teams; paused free teams keep their host from scale-in', async () => {
    start({ TDCLOUD_MAX_TEAMS_PER_HOST: '4', TDCLOUD_MAX_HOSTS: '3', TDCLOUD_FREE_RESERVE_HOSTS: '0', TDCLOUD_EMPTY_HOST_GRACE: '1h' }, true)
    await env.pool.setDesired(2)
    await scaler().tick()
    await bootAll()
    const [a, b] = scaler().view().map((h) => h.id) as [string, string]
    expect([host(a)!.state, host(b)!.state]).toEqual(['ready', 'ready'])
    // a free team on a, a paid team on b (placed by hand), then a new free team: b, the paid host, though a is fuller
    await free('fra')
    updateTeam(env.cloud.db, team('fra').id, { host: a })
    await env.cloud.adminCreateTeam({ email: 'o@pdb.test', slug: 'pdb', actor: 'admin:test' })
    updateTeam(env.cloud.db, team('pdb').id, { host: b })
    await jobs()
    await free('frb')
    await jobs()
    expect(team('frb').host).toBe(b)
    // fa pauses; a holds only a paused free team: it is not scaled in (its data is there)
    later(7 * DAY)
    await env.cloud.free.sweep()
    expect(env.cloud.free.isPaused(team('fra'))).toBe(true)
    later(2 * HOUR)
    await scaler().tick()
    await scaler().tick()
    expect(host(a)!.state).toBe('ready')
    expect(scaler().view().find((h) => h.id === a)).toMatchObject({ used: 0.25, teams: ['fra'] })
  })
})

describe('settings', () => {
  test('defaults and refused combinations', async () => {
    const { loadConfig } = await import('../src/config')
    const f = loadConfig({}).free
    expect([f.maxTeams, f.hostShare, f.reserveHosts, f.idleWarnMs, f.idlePauseMs, f.deleteAfterMs, f.deleteWarnMs, f.finalBackupKeepMs, f.verifyTtlMs]).toEqual([50, 0.5, 1, 6 * DAY, 7 * DAY, 90 * DAY, [60 * DAY, 83 * DAY], 30 * DAY, 24 * HOUR])
    expect(loadConfig({ TDCLOUD_FREE_IDLE_PAUSE: '40s', TDCLOUD_FREE_IDLE_WARN: '25s' }).free.idlePauseMs).toBe(40_000)
    expect(() => loadConfig({ TDCLOUD_FREE_IDLE_WARN: '8d' })).toThrow(/shorter/)
    expect(() => loadConfig({ TDCLOUD_FREE_HOST_SHARE: '0' })).toThrow(/SHARE/)
    expect(() => loadConfig({ TDCLOUD_FREE_DELETE_WARNINGS: '95d' })).toThrow(/before/)
    expect(() => loadConfig({ TDCLOUD_TURNSTILE_SECRET: 'x' })).toThrow(/both/)
  })
})
