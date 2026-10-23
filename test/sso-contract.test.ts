// The drive side of the SSO contract (docs/SSO-CONTRACT.md): every vector of test/fixtures/sso-v1.json through the
// real verifier (src/tdcloud/assertion.ts) AND through the real callback (POST /api/sso/callback), every member-sync
// vector through the real receiver (`cloud sync-members`), and the fixture's payload end to end.
import { describe, expect, test } from 'bun:test'
import { verifyAssertion } from '../src/tdcloud/assertion'
import { cloudCommands } from '../src/tdcloud/cli'
import { rememberState } from '../src/tdcloud/sso'
import { applySync } from '../src/tdcloud/sync'
import { OutboxMailer } from '../src/web/mail'
import { metaSet } from '../src/web/schema'
import fx from './fixtures/sso-v1.json'
import { claimsFor, cloudSetup, fixtureConfig, payload, sign, TEAM, USERS, type CloudEnv } from './sso-helpers'

const cfg = fixtureConfig({ t: 0 })

describe('assertion vectors: the verifier', () => {
  for (const v of fx.vectors) {
    test(`${v.name}: ${v.why}`, () => {
      const seen = new Set<string>(v.seen_jti ?? [])
      const got = verifyAssertion(cfg, { assertion: v.assertion, state: v.state, cookieState: v.cookie_state, now: v.now, seen: (j) => seen.has(j) })
      expect(got).toEqual(v.expect as typeof got)
    })
  }
})

describe('assertion vectors: POST /api/sso/callback', async () => {
  const e = await cloudSetup()
  for (const v of fx.vectors) {
    test(`${v.name} → ${v.expect.ok ? 'signed in' : (v.expect as { error: string }).error}`, async () => {
      e.clock.t = v.now * 1000
      e.db.query('DELETE FROM sso_used').run()
      for (const j of v.seen_jti ?? []) e.db.query('INSERT INTO sso_used (jti, expires_at) VALUES (?, ?)').run(j, v.now + 3600)
      rememberState(e.db, v.state, '/#/files', false, e.clock.t)
      const b = new e.SsoBrowser()
      if (v.cookie_state !== null) b.jar.tdrive_sso = v.cookie_state
      const r = await b.post({ assertion: v.assertion, state: v.state })
      expect(r.status).toBe(303)
      if (v.expect.ok) {
        expect(r.location).toBe('/#/files')
        expect(b.cookie).toBeTruthy()
        const me = await b.call('GET', '/api/session')
        expect(me.status).toBe(200)
        expect(me.data.me.cloud).toMatchObject({ managed: true, sso_only: true })
        expect(e.db.query('SELECT 1 FROM sso_used WHERE jti = ?').get((v.expect as { claims: { jti: string } }).claims.jti)).not.toBeNull()
      } else {
        expect(r.location).toBe(`/#/sso-error/${(v.expect as { error: string }).error}`)
        expect(b.cookie).toBeUndefined()
      }
    })
  }

  test('the same valid assertion posted twice: the second is replayed (single use)', async () => {
    const v = fx.vectors.find((x) => x.name === 'valid_member')!
    e.clock.t = v.now * 1000
    e.db.query('DELETE FROM sso_used').run()
    const once = async () => {
      rememberState(e.db, v.state, '/#/files', false, e.clock.t)
      const b = new e.SsoBrowser()
      b.jar.tdrive_sso = v.state
      return b.post({ assertion: v.assertion, state: v.state })
    }
    expect((await once()).location).toBe('/#/files')
    expect((await once()).location).toBe('/#/sso-error/replayed')
  })

  test('a valid assertion whose state the drive never made (or is over 10 minutes old) is bad_state', async () => {
    const v = fx.vectors.find((x) => x.name === 'valid_reauth')!
    e.clock.t = v.now * 1000
    e.db.query('DELETE FROM sso_used').run()
    e.db.query('DELETE FROM sso_states').run()
    rememberState(e.db, v.state, '/#/files', false, e.clock.t - 11 * 60_000)
    const b = new e.SsoBrowser()
    b.jar.tdrive_sso = v.state
    expect((await b.post({ assertion: v.assertion, state: v.state })).location).toBe('/#/sso-error/bad_state')
  })
})

describe('member_sync vectors', async () => {
  const mailer = (e: CloudEnv) => new OutboxMailer(e.dir, true)
  for (const v of fx.member_sync.vectors) {
    test(v.name, async () => {
      const e = await cloudSetup()
      metaSet(e.db, 'cloud_sync_seq', String(v.applied_before))
      if ('payload_seq' in v) {
        const r = await applySync({ db: e.db, cfg: e.cfg, mailer: mailer(e), baseUrl: 'https://trina.cloud.trina.app' }, payload(v.payload_seq!, [{ cloud_user: USERS.mina, email: 'mina@trina.app' }]))
        const ex = v.expect as { applied: boolean; applied_after: number; reason?: string }
        expect(r.ok && r.applied).toBe(ex.applied)
        if (ex.reason) expect(r).toMatchObject({ reason: ex.reason, current_seq: v.applied_before })
        expect(e.syncSeq()).toBe(ex.applied_after)
        return
      }
      // the sign-in rule: an assertion is newer when its sync_seq > applied
      const mina = { sub: USERS.mina, email: 'mina@trina.app', name: 'Mina Kim', role: (v.assertion_role ?? 'member') as 'admin' | 'member' }
      if (v.person !== 'none') {
        e.db.query("INSERT INTO people (name, admin, active, created_at) VALUES ('mina', 0, ?, 0)").run(v.person === 'inactive' ? 0 : 1)
        e.db.query('INSERT INTO accounts (person_id, email, created_at, cloud_user) VALUES (?, ?, 0, ?)').run(e.pid('mina'), 'mina@trina.app', USERS.mina)
      }
      const b = new e.SsoBrowser()
      const r = await b.sso(mina, { syncSeq: v.assertion_sync_seq })
      const ex = v.expect as { sign_in: boolean; error?: string; admin?: boolean; created?: boolean; reactivated?: boolean }
      if (!ex.sign_in) { expect(r.location).toBe(`/#/sso-error/${ex.error}`); expect(b.cookie).toBeUndefined(); return }
      expect(r.location).toBe('/#/files')
      const me = (await b.call('GET', '/api/session')).data.me
      expect(me.name).toBe('mina')
      if (ex.admin !== undefined) expect(me.admin).toBe(ex.admin)
      if (ex.created) expect(e.db.query<{ n: number }, []>("SELECT count(*) AS n FROM people WHERE name = 'mina'").get()!.n).toBe(1)
      if (ex.reactivated) expect(e.db.query<{ active: number }, []>("SELECT active FROM people WHERE name = 'mina'").get()!.active).toBe(1)
    })
  }
})

describe('the fixture payload through `cloud sync-members --json`', () => {
  test('applies like output_applied: one invite created, the removed member deactivated, unmanaged reported', async () => {
    const e = await cloudSetup()
    const run = async (args: string[]) => {
      const out: string[] = []
      const cmd = cloudCommands.find((c) => c.name === 'cloud sync-members')!
      const code = await cmd.run({ db: e.db, dataDir: e.dir, args, out: (s) => out.push(s), err: () => {} })
      return { code: code ?? 0, out: JSON.parse(out.join('\n')) }
    }
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
    // seq 7: the owner, Mina and Sam (who the fixture removes)
    const before = await run(['--json', b64(payload(7, [
      { cloud_user: USERS.dion, email: 'dion@trina.app', name: 'Dion Nam', role: 'owner' }, { cloud_user: USERS.mina, email: 'mina@trina.app', name: 'Mina Kim' },
      { cloud_user: 'usr_7e2d0c4a9b1f5e3d2c18', email: 'sam@trina.app', name: 'Sam' }]))])
    expect(before).toMatchObject({ code: 0, out: { ok: true, applied: true, seq: 7, created: 3 } })
    const r = await run(['--json', b64(fx.member_sync.payload)])
    const { unmanaged, ...rest } = fx.member_sync.output_applied
    expect(r.code).toBe(0)
    expect(r.out).toMatchObject(rest)
    expect(r.out.unmanaged.map((u: { name: string }) => u.name).sort()).toEqual(['boss', 'dion', 'kim', 'lee', 'park'])
    expect(Object.keys(unmanaged[0]!).sort()).toEqual(Object.keys(r.out.unmanaged[0]).sort())
    // the invited row exists (shareable), is not in Everyone and does not count as a person on the plan
    const jae = e.db.query<{ active: number; cloud_invite: string }, []>("SELECT p.active, a.cloud_invite FROM people p JOIN accounts a ON a.person_id = p.id WHERE a.email = 'jae@partner.example'").get()!
    expect(jae).toEqual({ active: 1, cloud_invite: 'inv_000000000017' })
    // the same payload again: stale, exit 0
    expect(await run(['--json', b64(fx.member_sync.payload)])).toEqual({ code: 0, out: { ...fx.member_sync.output_stale, current_seq: 8 } })
    // errors: exit 1 with the contract's codes
    expect(await run(['--json', b64({ ...fx.member_sync.payload, seq: 9, version: 1 })])).toMatchObject({ code: 1, out: { ok: false, error: 'bad_version' } })
    expect(await run(['--json', b64({ ...fx.member_sync.payload, seq: 9, team: 'team_00000000000000000000' })])).toMatchObject({ code: 1, out: { ok: false, error: 'wrong_team' } })
    expect(await run(['--json', 'not base64 json'])).toMatchObject({ code: 1, out: { ok: false, error: 'bad_json' } })
    expect(TEAM).toBe(fx.member_sync.payload.team)
  })
})

test('the test keys sign exactly the fixture assertions (Ed25519 is deterministic)', () => {
  const v = fx.vectors.find((x) => x.name === 'valid_member')!
  expect(sign((v.expect as { claims: Record<string, unknown> }).claims)).toBe(v.assertion)
  const c = claimsFor({ sub: USERS.mina, email: 'm@x.io' }, { nowS: 1, state: 's', syncSeq: 0 })
  expect(Object.keys(c)).toEqual(fx.assertion.required)
})
