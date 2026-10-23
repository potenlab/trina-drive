import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import { verifyAudit } from '../src/audit'
import { teamBySlug, updateTeam } from '../src/db'
import { event, setup, signedUpTeam, webhook, type Env } from './helpers'

let env: Env
afterEach(() => env?.cleanup())

const sub = (team: string, status: string, extra: Record<string, unknown> = {}) =>
  ({ id: 'sub_01', status, customer_id: 'ctm_01', items: [{ price: { id: 'pri_team_m' }, quantity: 1 }], custom_data: { tdcloud_team: team }, ...extra })

async function provisioned(slug = 'acme') {
  const s = await signedUpTeam(env, 'buyer@acme.test', slug)
  expect((await webhook(env, event('subscription.created', sub(s.team.id, 'active')))).status).toBe(200)
  await env.cloud.runDueJobs()
  return s
}

describe('signup and teams', () => {
  test('signup needs a verified email before a team can be created; duplicate signups do not enumerate', async () => {
    env = setup()
    expect((await env.call('POST', '/api/signup', { body: { email: 'x@acme.test', password: 'short' } })).status).toBe(400)
    expect((await env.call('POST', '/api/signup', { body: { email: 'x@acme.test', password: 'long enough pw' } })).status).toBe(200)
    expect((await env.call('POST', '/api/signup', { body: { email: 'X@acme.test', password: 'other long pw' } })).status).toBe(200)
    const l = await env.call('POST', '/api/login', { body: { email: 'x@acme.test', password: 'long enough pw' } })
    const cookie = l.headers.get('set-cookie')!.split(';')[0]!
    const { csrf } = await l.json() as { csrf: string }
    const r = await env.call('POST', '/api/teams', { body: { name: 'X', slug: 'xco' }, headers: { cookie, 'x-csrf-token': csrf } })
    expect(r.status).toBe(403)
    expect((await r.json() as { error: string }).error).toBe('unverified')
    // the second signup re-sent a verify link (the first is replaced)
    const links = env.mailer.sent.filter((m) => m.to === 'x@acme.test').map((m) => m.text.match(/token=(\S+)/)?.[1])
    expect(links.length).toBe(2)
    expect((await env.call('POST', '/api/verify', { body: { token: links[0] } })).status).toBe(404)
    expect((await env.call('POST', '/api/verify', { body: { token: links[1] } })).status).toBe(200)
    expect((await env.call('POST', '/api/verify', { body: { token: links[1] } })).status).toBe(404)
  })

  test('slugs: reserved, malformed and taken names are refused; CSRF and origin are checked', async () => {
    env = setup()
    const { cookie, csrf } = await signedUpTeam(env)
    const mk = (slug: string, h: Record<string, string> = {}) => env.call('POST', '/api/teams', { body: { name: 'T', slug }, headers: { cookie, 'x-csrf-token': csrf, ...h } })
    for (const bad of ['www', 'a', 'Acme', 'ac--me', '-acme', 'xn--abc', 'a.b', 'acme']) expect((await mk(bad)).status).toBeGreaterThanOrEqual(400)
    expect((await mk('beta-co')).status).toBe(201)
    expect((await env.call('POST', '/api/teams', { body: { name: 'T', slug: 'gamma' }, headers: { cookie } })).status).toBe(403)
    expect((await mk('gamma', { origin: 'https://evil.example' })).status).toBe(403)
  })

  test('login is rate limited per address', async () => {
    env = setup()
    let last = 0
    for (let i = 0; i < 31; i++) last = (await env.call('POST', '/api/login', { body: { email: `n${i}@a.test`, password: 'wrong password' }, ip: '198.51.100.1' })).status
    expect(last).toBe(429)
    expect((await env.call('POST', '/api/login', { body: { email: 'n@a.test', password: 'wrong password' }, ip: '198.51.100.2' })).status).toBe(401)
  })
})

describe('Paddle → provisioning', () => {
  test('a signed subscription.created provisions the team and mails a one-time setup link that is never stored', async () => {
    env = setup()
    const s = await provisioned()
    const t = teamBySlug(env.cloud.db, 'acme')!
    expect(t.status).toBe('active')
    expect(t.subscription_id).toBe('sub_01')
    expect(env.driver.calls).toContain('create acme')
    const mail = env.mailer.sent.find((m) => m.subject.startsWith('Your Trina Drive is ready'))!
    expect(mail.to).toBe('buyer@acme.test')
    const token = mail.text.match(/#\/setup\/(\S+)/)![1]!
    expect(token).toStartWith('tdrive_setup_')
    expect(mail.text).toContain(`${s.team.url}/mcp`)
    // never in the control plane's database (any table, any column)
    const dump = env.cloud.db.query<{ sql: string }, []>("SELECT name AS sql FROM sqlite_master WHERE type = 'table'").all()
      .flatMap((tb) => env.cloud.db.query(`SELECT * FROM ${tb.sql}`).all().map((r) => JSON.stringify(r))).join('\n')
    expect(dump).not.toContain(token)
    expect(fs.readFileSync(env.cfg.dbFile).includes(Buffer.from(token))).toBe(false)
    // the backup keys are stored wrapped, and unwrap to the product's key
    expect(t.backup_key_enc).toStartWith('l1.')
    expect((await env.cloud.backupSecrets(t)).product).toBe('tdrive_bksec1_acme')
    expect(verifyAudit(env.cloud.db).ok).toBe(true)
  })

  test('bad signatures, stale timestamps and replays are refused or ignored', async () => {
    env = setup()
    const s = await signedUpTeam(env)
    const ev = event('subscription.created', sub(s.team.id, 'active'))
    expect((await webhook(env, ev, 'wrong secret')).status).toBe(401)
    const raw = JSON.stringify(ev)
    expect((await env.call('POST', '/paddle/webhook', { raw, headers: { 'paddle-signature': `ts=${Math.floor(Date.now() / 1000) - 60};h1=00` } })).status).toBe(401)
    expect((await webhook(env, ev)).status).toBe(200)
    expect(await (await webhook(env, ev)).text()).toBe('duplicate')
    await env.cloud.runDueJobs()
    expect(env.driver.calls.filter((c) => c === 'create acme').length).toBe(1)
  })

  test('an unlinked subscription alerts the operator; an older event does not undo a newer one', async () => {
    env = setup()
    await webhook(env, event('subscription.created', { id: 'sub_x', status: 'active', items: [] }))
    expect(env.mailer.sent.some((m) => m.to === env.cfg.opsEmail && m.subject.includes('matches no team'))).toBe(true)
    await provisioned()
    const t0 = teamBySlug(env.cloud.db, 'acme')!
    const id = t0.public_id
    await webhook(env, event('subscription.past_due', sub(id, 'past_due'), new Date(Date.now() - 3600_000).toISOString()))
    expect(teamBySlug(env.cloud.db, 'acme')!.status).toBe('active')
  })

  test('plan change from the price applies new limits', async () => {
    env = setup()
    const s = await provisioned()
    await webhook(env, event('subscription.updated', sub(s.team.id, 'active', { items: [{ price: { id: 'pri_biz_m' }, quantity: 1 }] })))
    await env.cloud.runDueJobs()
    expect(teamBySlug(env.cloud.db, 'acme')!.plan).toBe('business')
    expect(env.driver.calls).toContain('limits acme business')
  })

  test('a failed provisioning retries, then marks the team failed and alerts', async () => {
    env = setup()
    env.driver.failCreate = true
    const s = await signedUpTeam(env)
    await webhook(env, event('subscription.created', sub(s.team.id, 'active')))
    for (let i = 0; i < 5; i++) { env.cloud.db.query('UPDATE jobs SET run_at = 0 WHERE done_at IS NULL').run(); await env.cloud.runDueJobs() }
    expect(teamBySlug(env.cloud.db, 'acme')!.status).toBe('failed')
    expect(env.mailer.sent.some((m) => m.to === env.cfg.opsEmail && m.subject.includes('provision'))).toBe(true)
  })
})

describe('grace, suspend, resume, delete', () => {
  const expire = () => { env.cloud.db.query('UPDATE teams SET grace_until = 1').run(); env.cloud.db.query('UPDATE jobs SET run_at = 0 WHERE done_at IS NULL').run() }

  test('past_due → grace → suspended; paid again → running', async () => {
    env = setup()
    const s = await provisioned()
    await webhook(env, event('subscription.past_due', sub(s.team.id, 'past_due')))
    expect(teamBySlug(env.cloud.db, 'acme')!.status).toBe('past_due')
    await env.cloud.runDueJobs()
    expect(teamBySlug(env.cloud.db, 'acme')!.status).toBe('past_due') // grace not over yet
    expire(); await env.cloud.runDueJobs()
    expect(teamBySlug(env.cloud.db, 'acme')!.status).toBe('suspended')
    expect(env.driver.instances.get('acme')!.state).toBe('stopped')
    expect(env.cloud.hostAllowed('acme.cloud.example.com')).toBe(true) // the paused page still has a certificate
    await webhook(env, event('subscription.updated', sub(s.team.id, 'active')))
    await env.cloud.runDueJobs()
    expect(teamBySlug(env.cloud.db, 'acme')!.status).toBe('active')
    expect(env.driver.instances.get('acme')!.state).toBe('running')
  })

  test('canceled → grace → suspended → after 30 days a final backup, then deletion; the slug stays taken', async () => {
    env = setup()
    const s = await provisioned()
    await webhook(env, event('subscription.canceled', sub(s.team.id, 'canceled')))
    expire(); await env.cloud.runDueJobs()
    let t = teamBySlug(env.cloud.db, 'acme')!
    expect(t.status).toBe('suspended')
    expect(t.delete_after! - Date.now()).toBeGreaterThan(29 * 86400_000)
    await env.cloud.runDueJobs()
    expect(teamBySlug(env.cloud.db, 'acme')!.status).toBe('suspended') // not yet
    updateTeam(env.cloud.db, t.id, { delete_after: 1 }); env.cloud.db.query('UPDATE jobs SET run_at = 0 WHERE done_at IS NULL').run()
    await env.cloud.runDueJobs()
    t = teamBySlug(env.cloud.db, 'acme')!
    expect(t.status).toBe('deleted')
    expect(env.driver.instances.has('acme')).toBe(false)
    const final = env.cloud.db.query<{ kind: string; object_key: string }, [number]>("SELECT kind, object_key FROM backups WHERE team_id = ? AND kind = 'final'").all(t.id)
    expect(final.map((b) => b.kind)).toEqual(['final', 'final'])
    for (const b of final) expect(fs.existsSync(`${env.dir}/backups/${b.object_key}`)).toBe(true)
    expect(env.cloud.hostAllowed('acme.cloud.example.com')).toBe(false)
    const { cookie, csrf } = await signedUpTeam(env, 'other@b.test', 'bco')
    expect((await env.call('POST', '/api/teams', { body: { name: 'A', slug: 'acme' }, headers: { cookie, 'x-csrf-token': csrf } })).status).toBe(409)
  })

  test('resubscribing during the deletion window cancels the deletion', async () => {
    env = setup()
    const s = await provisioned()
    await webhook(env, event('subscription.canceled', sub(s.team.id, 'canceled')))
    expire(); await env.cloud.runDueJobs()
    await webhook(env, event('subscription.created', sub(s.team.id, 'active', { id: 'sub_02' })))
    await env.cloud.runDueJobs()
    const t = teamBySlug(env.cloud.db, 'acme')!
    expect([t.status, t.subscription_id, t.delete_after]).toEqual(['active', 'sub_02', null])
    // a late event of the old subscription changes nothing
    await webhook(env, event('subscription.updated', sub(s.team.id, 'canceled')))
    expect(teamBySlug(env.cloud.db, 'acme')!.status).toBe('active')
    expect(env.cloud.db.query("SELECT 1 FROM jobs WHERE kind = 'delete' AND done_at IS NULL").get()).toBeNull()
  })

  test('scheduled backups go to the target and old ones are pruned', async () => {
    env = setup({ TDCLOUD_BACKUP_KEEP: '2' })
    await provisioned()
    const t = teamBySlug(env.cloud.db, 'acme')!
    for (let i = 0; i < 4; i++) { await env.cloud.backup(teamBySlug(env.cloud.db, 'acme')!, 'scheduled', 'test'); await Bun.sleep(1100) }
    const rows = env.cloud.db.query<{ object_key: string }, [number]>("SELECT object_key FROM backups WHERE team_id = ? AND kind = 'scheduled'").all(t.id)
    expect(rows.length).toBe(4) // two sets of two objects
    for (const r of rows) expect(fs.existsSync(`${env.dir}/backups/${r.object_key}`)).toBe(true)
  }, 20_000)
})

describe('upgrade', () => {
  test('backs up first, then recreates on the configured image; a suspended team stays stopped', async () => {
    env = setup({ TDCLOUD_IMAGE: 'trina-drive:2' })
    await provisioned()
    await env.cloud.upgrade(teamBySlug(env.cloud.db, 'acme')!, 'test')
    const i = env.driver.calls.indexOf('backup acme'), j = env.driver.calls.indexOf('recreate acme trina-drive:2')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(j).toBeGreaterThan(i)
    await env.cloud.suspend(teamBySlug(env.cloud.db, 'acme')!, 'admin', 'test')
    await env.cloud.upgrade(teamBySlug(env.cloud.db, 'acme')!, 'test')
    expect(env.driver.instances.get('acme')!.state).toBe('stopped')
  })
})

describe('internal endpoints', () => {
  test('Caddy ask: only live team names under the domain, and only with the key when one is set', async () => {
    env = setup({ TDCLOUD_CADDY_ASK_KEY: 'k3y' })
    await provisioned()
    const ask = (d: string, key = 'k3y') => env.call('GET', `/internal/caddy/ask?domain=${d}&key=${key}`).then((r) => r.status)
    expect(await ask('acme.cloud.example.com')).toBe(200)
    expect(await ask('cloud.example.com')).toBe(200)
    expect(await ask('nope.cloud.example.com')).toBe(404)
    expect(await ask('x.acme.cloud.example.com')).toBe(404)
    expect(await ask('acme.cloud.example.com.evil.test')).toBe(404)
    expect(await ask('acme.cloud.example.com', 'wrong')).toBe(403)
    const m = await (await env.call('GET', '/internal/metrics?key=k3y')).text()
    expect(m).toContain('tdcloud_teams{status="active"} 1')
  })

  test('security headers on every page', async () => {
    env = setup()
    const r = await env.call('GET', '/signup')
    expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(r.headers.get('strict-transport-security')).toContain('max-age=')
  })
})
