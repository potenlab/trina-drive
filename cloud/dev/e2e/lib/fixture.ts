// The scenarios' team: one Team-plan team (`h1` locally, E2E_TEAM on AWS) with an admin, four people and the seeded
// folders of plan §5 (cloud/dev/seed-team.ts). Made once and kept in <stateDir>/<slug>.json (mode 600: passwords,
// the admin's authenticator secret, session cookies, tokens), so every scenario can run alone and sign-ins stay few
// (the drive allows 50 sign-ins per address per 15 minutes).
//
// Two ways to make it, chosen by what the stack can do (lib/features.ts):
//   password  today's main: operator `teams create` (complimentary Team, as S02 plans for the dogfood team) → the
//             emailed setup link makes the admin → the admin invites people on the drive → each sets a password
//   sso       B1+D1 merged (the drive serves /api/sso/start): console accounts for everybody, the owner invites them
//             in the console, each accepts and opens the drive once (JIT) — the Trina Cloud way
// AWS never makes a team: E2E_TEAM and E2E_PEOPLE describe an existing test team (lib/target.ts).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { seedTeam, type Seeded } from '../../seed-team'
import { Console } from './console'
import { Drive, type PersonCreds } from './drive'
import type { Features } from './features'
import { Http, Jar, type Res } from './http'
import { SoftPasskey } from './passkey'
import { freshTotp, useTotpStore } from './totp'
import type { Target } from './target'

export const PEOPLE = ['boss', 'mina', 'sam', 'kim'] as const
export type Who = 'admin' | (typeof PEOPLE)[number]

export interface FxState {
  slug: string
  mode: 'password' | 'sso'
  admin: PersonCreds & { consoleTotp?: string }
  people: Record<string, PersonCreds & { consoleTotp?: string }>
  seeded?: Seeded
  /** browser cookies per person (host → name → value), CSRF */
  sessions: Record<string, { cookies: Record<string, string>; csrf: string; at: number }>
  tokens: Record<string, { token: string; at: number }>
  appPasswords: Record<string, { password: string; at: number }>
  passkeys?: Record<string, ReturnType<SoftPasskey['toJSON']>>
  /** console browser sessions per person (the console allows 30 sign-ins per address per 15 minutes) */
  consoleSessions?: Record<string, { cookies: Record<string, string>; csrf: string }>
  log: string[]
}

const DAY = 86_400_000

export class Fixture {
  s!: FxState
  private file: string
  private drives = new Map<string, Drive>()
  constructor(public t: Target, public http: Http, public features: Features, private say: (s: string) => void = () => {}) {
    // the slug the last run moved to (makeLocal), unless E2E_TEAM names one
    const cur = path.join(t.stateDir, 'current')
    if (t.kind === 'local' && !process.env.E2E_TEAM && fs.existsSync(cur)) t.team = fs.readFileSync(cur, 'utf8').trim() || t.team
    this.file = path.join(t.stateDir, `${t.team}.json`)
    useTotpStore(path.join(t.stateDir, 'totp-steps.json'))
  }
  get slug() { return this.t.team }
  get url() { return this.t.teamUrl(this.slug) }

  save() { fs.writeFileSync(this.file, JSON.stringify(this.s, null, 2), { mode: 0o600 }) }

  /** the team, made or reused; throws with a clear message when it cannot be made */
  async ready(): Promise<this> {
    if (this.s?.seeded) return this
    if (fs.existsSync(this.file)) this.s = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    if (this.t.kind === 'aws') return this.readyAws()
    const alive = this.s && (await this.http.req('GET', `${this.url}/api/state`)).status === 200 && (await this.adminWorks())
    if (!alive) await this.makeLocal()
    if (!this.s.seeded) {
      this.say(`  (fixture) seeding ${this.slug}`)
      this.s.seeded = await seedTeam(await this.drive('admin'), this)
      this.save()
    }
    return this
  }

  private async adminWorks(): Promise<boolean> {
    try { await this.drive('admin'); return true } catch { return false }
  }

  // ---------- local: make the team ----------
  private async makeLocal() {
    const ops = this.t.ops!
    const show = (slug: string) => { const r = ops('teams', 'show', slug); return r.code === 0 ? JSON.parse(r.out) as { status?: string; host?: string; waiting_since?: number | null } : null }
    // a slug is never handed out again after a delete (cloud/control/src/slug.ts): a stale team (its fixture file is
    // gone, or the admin no longer signs in) is deleted and the fixture moves on to <base>-2, -3, …
    const base = (process.env.E2E_TEAM || 'e2e-h1').replace(/-\d+$/, '')
    let slug = this.s?.slug ?? this.t.team
    const stale = show(slug)
    if (stale && stale.status !== 'deleted') {
      this.say(`  (fixture) deleting the stale team ${slug} (no usable fixture for it)`)
      ops('teams', 'delete', slug, '--yes')
    }
    for (let n = 1; show(slug); n++) slug = n === 1 ? base : `${base}-${n}`
    this.t.team = slug
    this.file = path.join(this.t.stateDir, `${slug}.json`)
    fs.writeFileSync(path.join(this.t.stateDir, 'current'), slug)
    const owner = `owner@${slug}.test`
    this.s = { slug, mode: (await this.features.get('sso-console')).ok ? 'sso' : 'password',
      admin: { name: 'alex', email: owner, password: `admin-${slug}-password-1` }, people: {}, sessions: {}, tokens: {}, appPasswords: {}, log: [] }
    for (const p of PEOPLE) this.s.people[p] = { name: p, email: `${p}@${slug}.test`, password: `${p}-${slug}-password-1` }
    if (this.s.mode === 'sso') {
      // the owner's console account first (with a password), so `teams create --owner` makes them the owner
      const c = new Console(this.http)
      const su = await c.signupConfirmed(owner, this.s.admin.password)
      if (su.verify?.status !== 200) throw new Error(`fixture: owner sign-up ${su.signup.status} ${su.signup.text} / verify ${su.verify?.status}`)
    }

    this.say(`  (fixture) creating team ${slug} (operator teams create, complimentary Team)`)
    const proc = Bun.spawn(['docker', 'exec', 'tdc-control', 'bun', '/app/src/main.ts', 'teams', 'create', slug, '--owner', owner, '--name', 'H1 E2E', '--plan', 'team'], { stdout: 'pipe', stderr: 'pipe' })
    let exited: number | null = null
    void proc.exited.then((c) => { exited = c })
    let roomMade = false
    const end = Date.now() + 360_000
    while (Date.now() < end) {
      const r = show(slug)
      if (r?.status === 'active') break
      if (!r && exited !== null) throw new Error(`fixture: teams create ${slug} failed: ${(await new Response(proc.stderr).text()).slice(0, 400)}`)
      if (r?.status === 'failed') throw new Error(`fixture: ${slug} failed to provision: ${ops('jobs', 'list').out.slice(-800)}`)
      // waiting_since is set during any scale-out too (a host booting): only a long wait means the pool is full
      if (r?.waiting_since && Date.now() - r.waiting_since > 45_000 && !roomMade) {
        // the local stack has 3 one-team hosts (compose.yml); after the legacy suite they are taken. Its free-plan team
        // is disposable once that suite ran: make room with it (never acme/globex: other checks may use them)
        roomMade = true
        if (process.env.E2E_MAKE_ROOM !== '0' && show(slug) && show2(ops, 'freeco')) {
          this.say('  (fixture) no host free: deleting the legacy suite\'s disposable team freeco to make room (E2E_MAKE_ROOM=0 to stop this)')
          ops('teams', 'delete', 'freeco', '--yes')
        } else throw new Error(`fixture: ${slug} waits for a host (all local hosts taken): run on a fresh stack (cloud/dev/up.sh --no-teams) or delete a team`)
      }
      await Bun.sleep(2000)
    }
    await proc.exited.catch(() => {})
    if (show(slug)?.status !== 'active') throw new Error(`fixture: ${slug} not active after 6 minutes: ${JSON.stringify(show(slug))}`)
    this.features.reset()
    this.s.mode = (await this.features.get('sso')).ok ? 'sso' : 'password'
    this.save()
    if (this.s.mode === 'password') await this.adminByLink()
    else await this.adminBySso()
    await this.makePeople()
    this.save()
  }

  /** the setup link the ready mail carries (today's main) → admin with an authenticator app */
  private async adminByLink() {
    const owner = this.s.admin.email
    const ready = this.t.outbox!().filter((m) => m.to === owner && m.subject.startsWith('Your Trina Drive is ready')).at(-1)
    const token = ready?.text.match(/\/#token=(\S+)/)?.[1]
    if (!token) throw new Error('fixture: no setup link in the ready mail and the drive has no SSO: neither way to make an admin works')
    const d = new Drive(this.http, this.slug, 'admin')
    const setup = await d.api('POST', '/setup', { setup_token: token, name: this.s.admin.name, email: owner, password: this.s.admin.password })
    if (setup.status !== 200) throw new Error(`fixture: setup ${setup.status} ${setup.text}`)
    d.csrf = setup.json().csrf
    const ts = await d.api('POST', '/me/totp/setup', {})
    const secret = String(ts.json().secret ?? '')
    const conf = await d.api('POST', '/me/totp/confirm', { code: await freshTotp(secret) })
    if (conf.status !== 200) throw new Error(`fixture: TOTP enrol ${conf.status} ${conf.text}`)
    this.s.admin.totp = secret
    await d.session()
    this.keep('admin', d)
  }

  /** SSO world: the owner's console account (sign-up, confirm, authenticator), then Open drive */
  /** SSO: the owner signs in to the console, sets up its authenticator (owners must), opens the drive (a drive admin
   * by SSO), and sets up the drive's own second factor (hosted admins must) */
  private async adminBySso() {
    const c = new Console(this.http)
    const l = await c.login({ email: this.s.admin.email, password: this.s.admin.password })
    if (l.status !== 200) throw new Error(`fixture: console sign-in of the owner ${l.status} ${l.text}`)
    if (!l.json().totp_required) {
      const e = await c.enrollTotp()
      if (!e.secret) throw new Error(`fixture: console TOTP for the owner ${e.res.status} ${e.res.text}`)
      this.s.admin.consoleTotp = e.secret
    }
    this.save()
    const r = await c.openDrive(this.slug)
    if (!r.drive) throw new Error(`fixture: the owner opens the drive: ${r.error} after ${r.hops.join(' → ')}`)
    r.drive.who = 'admin'
    const me = await r.drive.session()
    this.s.admin.name = me.me?.name ?? this.s.admin.name // under SSO the drive names people from their address
    if (me.me?.second_factor_required || !me.me?.second_factor) {
      const ts = await r.drive.api('POST', '/me/totp/setup', {})
      const secret = String(ts.json().secret ?? '')
      const conf = secret ? await r.drive.api('POST', '/me/totp/confirm', { code: await freshTotp(secret) }) : ts
      if (conf.status !== 200) throw new Error(`fixture: the owner's drive authenticator ${conf.status} ${conf.text}`)
      this.s.admin.totp = secret
    }
    this.keep('admin', r.drive)
  }

  private async makePeople() {
    if (this.s.mode === 'password') {
      const admin = await this.drive('admin')
      for (const p of PEOPLE) {
        const c = this.s.people[p]!
        const before = this.t.teamMail!().length
        const r = await admin.api('POST', '/people', { name: c.name, email: c.email })
        if (r.status !== 200) throw new Error(`fixture: add ${p}: ${r.status} ${r.text}`)
        const link = this.t.teamMail!().slice(before).find((m) => m.to === c.email)?.text.match(/\/#\/invite\/(\S+)/)?.[1]
        const acc = await this.http.req('POST', `${this.url}/api/links/accept`, { body: { kind: 'invite', token: link, password: c.password } })
        if (acc.status !== 200) throw new Error(`fixture: ${p} accepts the invite: ${acc.status} ${acc.text}`)
      }
      return
    }
    // SSO: console accounts, invited by the owner, accepted, opened once
    const owner = await this.consoleAs('admin')
    const teamId = await owner.teamId(this.slug)
    for (const p of PEOPLE) {
      const c = this.s.people[p]!
      const inv = await owner.invite(teamId, [c.email])
      if (inv.status !== 201 && inv.status !== 200) throw new Error(`fixture: console invite ${p}: ${inv.status} ${inv.text}`)
      const cc = new Console(this.http)
      await cc.signupConfirmed(c.email, c.password)
      const li = await cc.login({ email: c.email, password: c.password })
      if (li.status !== 200) throw new Error(`fixture: console sign-in of ${p}: ${li.status} ${li.text}`)
      const acc = await cc.accept(owner.inviteToken(c.email))
      if (acc.status !== 200) throw new Error(`fixture: ${p} accepts the console invite: ${acc.status} ${acc.text}`)
      const d = await this.ssoDrive(p, cc)
      c.name = (await d.session()).me?.name ?? c.name
      this.keep(p, d)
    }
    // let the console's member sync catch up, then check every kept session again before seeding
    for (let i = 0; i < 30; i++) {
      const m = await owner.members(teamId)
      if (m.status === 200 && m.json().sync?.in_sync) break
      await Bun.sleep(2000)
    }
    this.drives.clear()
  }

  // ---------- AWS: an existing test team ----------
  private async readyAws(): Promise<this> {
    const p = JSON.parse(awsPeople()) as Record<string, { email: string; password: string; totp?: string; name?: string }> // shape: cloud/dev/e2e/aws-people.example.json
    if (!this.s) {
      this.s = { slug: this.slug, mode: 'sso', admin: { name: p.admin?.name ?? 'admin', email: p.admin!.email, password: p.admin!.password, consoleTotp: p.admin!.totp },
        people: {}, sessions: {}, tokens: {}, appPasswords: {}, log: [] }
      for (const n of PEOPLE) { const x = p[n]; if (!x) throw new Error(`E2E_PEOPLE: ${n} missing`); this.s.people[n] = { name: x.name ?? n, email: x.email, password: x.password, consoleTotp: x.totp } }
      this.save()
    }
    if (!this.s.seeded) { this.s.seeded = await seedTeam(await this.drive('admin'), this); this.save() }
    return this
  }

  // ---------- people's sessions ----------
  creds(who: Who): PersonCreds & { consoleTotp?: string } { return who === 'admin' ? this.s.admin : this.s.people[who]! }

  /** a signed-in drive session for this person (kept cookie when it still works; else a new sign-in) */
  async drive(who: Who): Promise<Drive> {
    const cached = this.drives.get(who)
    if (cached) return cached
    const kept = this.s?.sessions?.[who]
    if (kept) {
      const jar = new Jar()
      for (const [k, v] of Object.entries(kept.cookies)) { const [host, name] = k.split('\t'); jar.set(host!, name!, v) }
      const d = new Drive(this.http, this.slug, who, jar)
      try { await d.session(); this.drives.set(who, d); return d } catch { /* expired: sign in again */ }
    }
    const d = this.s.mode === 'sso' ? await this.ssoDrive(who, await this.consoleAs(who)) : await new Drive(this.http, this.slug, who).login(this.creds(who))
    this.keep(who, d)
    return d
  }

  /** drop a person's kept session (it was signed out): the next drive(who) signs in again */
  forget(who: Who) { this.drives.delete(who); delete this.s.sessions[who]; this.save() }

  /** a fresh browser for this person (no kept cookies): what a scenario uses when it signs in itself */
  async freshDrive(who: Who): Promise<Drive> {
    return this.s.mode === 'sso' ? this.ssoDrive(who, await this.consoleAs(who)) : new Drive(this.http, this.slug, who).login(this.creds(who))
  }

  /** a console browser signed in as `who` (kept between scenarios and runs; `fresh` = a new sign-in, a new browser) */
  async consoleAs(who: Who, o: { fresh?: boolean } = {}): Promise<Console> {
    const cr = this.creds(who)
    const creds = { email: cr.email, password: cr.password, totp: cr.consoleTotp }
    const host = new URL(this.t.control).host
    const kept = !o.fresh ? this.s.consoleSessions?.[who] : undefined
    if (kept) {
      const c = new Console(this.http)
      for (const [name, v] of Object.entries(kept.cookies)) c.jar.set(host, name, v)
      c.csrf = kept.csrf
      c.creds = creds
      if ((await c.me()).status === 200) return c
    }
    const c = new Console(this.http)
    const r = await c.login(creds)
    if (r.status !== 200 || r.json().totp_required) throw new Error(`console sign-in of ${who}: ${r.status} ${r.text.slice(0, 200)}`)
    const cookies: Record<string, string> = {}
    for (const name of ['__Host-tdcloud_session', 'tdcloud_session']) { const v = c.jar.get(host, name); if (v) cookies[name] = v }
    if (!o.fresh) { this.s.consoleSessions = { ...this.s.consoleSessions, [who]: { cookies, csrf: c.csrf } }; this.save() }
    return c
  }

  private async ssoDrive(who: Who, c: Console, o: { reauth?: boolean } = {}): Promise<Drive> {
    const r = await c.openDrive(this.slug, o.reauth ? { reauth: true, returnPath: '/' } : {})
    if (r.secondFactor) return (await this.completeSecond(who, c.jar, r.secondFactor)).drive
    if (!r.drive && r.error === 'reauth_asked') throw new Error(`${who}: the console asks for the password again and no credentials were given`)
    if (!r.drive) throw new Error(`${who}: Open drive (SSO) ended with ${r.error} after ${r.hops.join(' → ')}`)
    r.drive.who = who
    return r.drive
  }

  /** the drive's own second factor after an SSO pass (#/sso-second/<ticket>): authenticator code or kept passkey */
  async completeSecond(who: Who, jar: Jar, ticket: string): Promise<{ drive: Drive; returnTo: string }> {
    const cr = this.creds(who)
    const d = new Drive(this.http, this.slug, who, jar)
    let s: Res
    if (cr.totp) s = await d.api('POST', '/login/second', { ticket, method: 'totp', code: await freshTotp(cr.totp) })
    else if (this.s.passkeys?.[who]) {
      const pk = SoftPasskey.fromJSON(this.s.passkeys[who]!)
      const ch = await d.api('POST', '/sso/second', { ticket })
      const opts = ch.status === 200 ? ch.json().second_factor?.passkey : null
      s = opts ? await d.api('POST', '/login/second', { ticket, method: 'passkey', response: pk.assert(opts) }) : ch
      this.keepPasskey(who, pk)
    } else throw new Error(`${who}: the drive asks for its own second factor after SSO and the fixture has none`)
    if (s.status !== 200) throw new Error(`${who}: second factor after SSO ${s.status} ${s.text}`)
    await d.session()
    return { drive: d, returnTo: s.json().return_to ?? '' }
  }

  private keep(who: string, d: Drive) {
    const host = new URL(this.url).host
    const cookies: Record<string, string> = {}
    for (const name of ['tdrive_session', '__Host-tdrive_session']) { const v = d.jar.get(host, name); if (v) cookies[`${host}\t${name}`] = v }
    this.s.sessions[who] = { cookies, csrf: d.csrf, at: Date.now() }
    this.drives.set(who, d)
    this.save()
  }

  /** a session that counts as a fresh sign-in (made app passwords, second factors): the password again on the drive,
   * or under SSO a ?reauth=1 round trip through the console (max_age=0: password and code again) */
  async freshSession(who: Who): Promise<Drive> {
    if (this.s.mode === 'sso') { const d = await this.ssoDrive(who, await this.consoleAs(who), { reauth: true }); this.keep(who, d); return d }
    const d = await this.drive(who)
    await d.api('POST', '/me/reauth', { password: this.creds(who).password })
    return d
  }

  /** a personal access token for this person (full scope, 1 day), kept between runs while it works */
  async token(who: Who): Promise<string> {
    const k = this.s.tokens[who]
    if (k && Date.now() - k.at < DAY - 3_600_000) return k.token
    const d = await this.drive(who)
    const token = await d.token(`e2e-${who}-${Date.now().toString(36)}`, this.s.mode === 'sso' ? {} : { password: this.creds(who).password })
    this.s.tokens[who] = { token, at: Date.now() }
    this.save()
    return token
  }
  forgetToken(who: Who) { delete this.s.tokens[who]; this.save() }

  /** an app password (WebDAV) for this person, kept between runs */
  async appPassword(who: Who): Promise<string> {
    const k = this.s.appPasswords[who]
    if (k) return k.password
    const d = await this.freshSession(who)
    const password = await d.appPassword(`e2e-${who}`)
    this.s.appPasswords[who] = { password, at: Date.now() }
    this.save()
    return password
  }
  forgetAppPassword(who: Who) { delete this.s.appPasswords[who]; this.save() }
  /** sign-in name for WebDAV */
  login(who: Who) { return this.creds(who).name }

  /** this person enrols an authenticator app on the drive (once; kept): for approvals and step-up */
  async ensureTotp(who: Who): Promise<string> {
    const c = this.creds(who)
    if (c.totp) return c.totp
    const d = await this.freshSession(who)
    const ts = await d.api('POST', '/me/totp/setup', {})
    const secret = String(ts.json().secret ?? '')
    if (!secret) throw new Error(`${who}: TOTP setup ${ts.status} ${ts.text}`)
    const conf = await d.api('POST', '/me/totp/confirm', { code: await freshTotp(secret) })
    if (conf.status !== 200) throw new Error(`${who}: TOTP enrol ${conf.status} ${conf.text}`)
    c.totp = secret
    this.save()
    return secret
  }

  /** this person's passkey on the drive (a software authenticator, registered once and kept): approvals and step-up */
  async ensurePasskey(who: Who): Promise<SoftPasskey> {
    const kept = this.s.passkeys?.[who]
    if (kept) return SoftPasskey.fromJSON(kept)
    const d = await this.freshSession(who)
    const o = await d.api('POST', '/me/passkeys/options', {})
    if (o.status !== 200) throw new Error(`${who}: passkey options ${o.status} ${o.text}`)
    const pk = new SoftPasskey(this.url)
    const add = await d.api('POST', '/me/passkeys', { name: 'e2e software passkey', response: pk.register(o.json()) })
    if (add.status !== 200) throw new Error(`${who}: passkey register ${add.status} ${add.text}`)
    this.s.passkeys = { ...this.s.passkeys, [who]: pk.toJSON() }
    this.save()
    return pk
  }
  /** after using a kept passkey (its signature counter moved) */
  keepPasskey(who: Who, pk: SoftPasskey) { this.s.passkeys = { ...this.s.passkeys, [who]: pk.toJSON() }; this.save() }

  /** approve a pending promotion as `who`, with the step-up the drive asks for (passkey on a public https drive) */
  async approve(who: Who, id: number): Promise<{ step: Res; approve: Res }> {
    const d = await this.drive(who)
    const v = await d.get(`/approvals/${id}`)
    const sha = v.json().sha256 ?? v.json().approval?.sha256
    const method = v.json().step_up?.method ?? v.json().step_up?.missing
    let step: Res
    if (method === 'totp') step = await d.api('POST', `/approvals/${id}/step-up`, { sha256: sha, code: await freshTotp(await this.ensureTotp(who)) })
    else {
      const pk = await this.ensurePasskey(who)
      const o = await d.api('POST', `/approvals/${id}/step-up/options`, { sha256: sha })
      step = o.status === 200 ? await d.api('POST', `/approvals/${id}/step-up`, { sha256: sha, response: pk.assert(o.json().options) }) : o
      this.keepPasskey(who, pk)
    }
    const approve = await d.api('POST', `/approvals/${id}/approve`, { sha256: sha, assertion: step.status === 200 ? step.json().assertion : undefined })
    return { step, approve }
  }

  /** a person's id on the drive */
  async personId(who: Who): Promise<number> {
    const ppl = (await (await this.drive('admin')).get('/people')).json().people as { id: number; name: string }[]
    return ppl.find((p) => p.name === this.creds(who).name)?.id ?? 0
  }
}

/** the AWS test team's people (secrets: a 0600 file or SSM, never argv/env values — cloud/scripts/aws-smoke.ts) */
function awsPeople(): string {
  const file = process.env.E2E_PEOPLE || path.join(os.homedir(), '.config/trina-drive/e2e/people.json')
  if (fs.existsSync(file)) {
    const mode = fs.statSync(file).mode & 0o777
    if (mode & 0o077) throw new Error(`${file} must be 0600 (it is ${mode.toString(8)})`)
    return fs.readFileSync(file, 'utf8')
  }
  const profile = process.env.E2E_AWS_PROFILE || 'tdcloud', region = process.env.E2E_AWS_REGION || 'ap-northeast-2'
  const r = Bun.spawnSync(['aws', 'ssm', 'get-parameter', '--with-decryption', '--name', '/tdcloud/e2e/people', '--query', 'Parameter.Value', '--output', 'text', '--profile', profile, '--region', region], { stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode === 0 && r.stdout.toString().trim()) return r.stdout.toString()
  throw new Error(`AWS target: no people for the test team: ${file} (0600) or the SSM SecureString /tdcloud/e2e/people (shape: cloud/dev/e2e/aws-people.example.json)`)
}

function show2(ops: NonNullable<Target['ops']>, slug: string) { const r = ops('teams', 'show', slug); return r.code === 0 && !/"status":"deleted"/.test(r.out) }
async function until(f: () => boolean, ms: number) { const end = Date.now() + ms; while (Date.now() < end) { if (f()) return true; await Bun.sleep(1500) } return f() }
