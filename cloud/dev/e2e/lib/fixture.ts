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
import path from 'node:path'
import { seedTeam, type Seeded } from '../../seed-team'
import { Console } from './console'
import { Drive, type PersonCreds } from './drive'
import type { Features } from './features'
import { Http, Jar, type Res } from './http'
import { SoftPasskey } from './passkey'
import { freshTotp } from './totp'
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
      if (r?.waiting_since && !roomMade) {
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
  private async adminBySso() {
    const c = new Console(this.http)
    await c.signupConfirmed(this.s.admin.email, this.s.admin.password)
    const l = await c.login({ email: this.s.admin.email, password: this.s.admin.password })
    if (l.status !== 200) throw new Error(`fixture: console sign-in of the owner ${l.status} ${l.text}`)
    if (!l.json().second_factor) {
      const e = await c.enrollTotp()
      if (e.secret) this.s.admin.consoleTotp = e.secret
    }
    this.save()
    const d = await this.ssoDrive('admin', c)
    this.keep('admin', d)
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
      await cc.login({ email: c.email, password: c.password })
      const acc = await cc.accept(cc.inviteToken(c.email))
      if (acc.status !== 200) throw new Error(`fixture: ${p} accepts the console invite: ${acc.status} ${acc.text}`)
      this.keep(p, await this.ssoDrive(p, cc))
    }
  }

  // ---------- AWS: an existing test team ----------
  private async readyAws(): Promise<this> {
    const file = process.env.E2E_PEOPLE
    if (!file || !fs.existsSync(file)) throw new Error('AWS target: E2E_PEOPLE must name a JSON file with admin/boss/mina/sam/kim console accounts of the test team')
    const p = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, { email: string; password: string; totp?: string; name?: string }>
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

  /** a fresh browser for this person (no kept cookies): what a scenario uses when it signs in itself */
  async freshDrive(who: Who): Promise<Drive> {
    return this.s.mode === 'sso' ? this.ssoDrive(who, await this.consoleAs(who)) : new Drive(this.http, this.slug, who).login(this.creds(who))
  }

  async consoleAs(who: Who): Promise<Console> {
    const c = new Console(this.http)
    const cr = this.creds(who)
    const r = await c.login({ email: cr.email, password: cr.password, totp: cr.consoleTotp })
    if (r.status !== 200 || r.json().second_factor) throw new Error(`console sign-in of ${who}: ${r.status} ${r.text.slice(0, 200)}`)
    return c
  }

  private async ssoDrive(who: Who, c: Console): Promise<Drive> {
    const r = await c.openDrive(this.slug)
    if (r.secondFactor) {
      const cr = this.creds(who)
      if (!cr.totp) throw new Error(`${who}: the drive asks for its own second factor after SSO and the fixture has none`)
      const d = new Drive(this.http, this.slug, who, c.jar)
      const s = await d.api('POST', '/login/second', { ticket: r.secondFactor, method: 'totp', code: await freshTotp(cr.totp) })
      if (s.status !== 200) throw new Error(`${who}: second factor after SSO ${s.status} ${s.text}`)
      await d.session()
      return d
    }
    if (!r.drive) throw new Error(`${who}: Open drive (SSO) ended with ${r.error} after ${r.hops.join(' → ')}`)
    r.drive.who = who
    return r.drive
  }

  private keep(who: string, d: Drive) {
    const host = new URL(this.url).host
    const cookies: Record<string, string> = {}
    for (const name of ['tdrive_session', '__Host-tdrive_session']) { const v = d.jar.get(host, name); if (v) cookies[`${host}\t${name}`] = v }
    this.s.sessions[who] = { cookies, csrf: d.csrf, at: Date.now() }
    this.drives.set(who, d)
    this.save()
  }

  /** a personal access token for this person (full scope, 1 day), kept between runs while it works */
  async token(who: Who): Promise<string> {
    const k = this.s.tokens[who]
    if (k && Date.now() - k.at < DAY - 3_600_000) return k.token
    const d = await this.drive(who)
    const token = await d.token(`e2e-${who}-${Date.now().toString(36)}`, { password: this.creds(who).password })
    this.s.tokens[who] = { token, at: Date.now() }
    this.save()
    return token
  }
  forgetToken(who: Who) { delete this.s.tokens[who]; this.save() }

  /** an app password (WebDAV) for this person, kept between runs */
  async appPassword(who: Who): Promise<string> {
    const k = this.s.appPasswords[who]
    if (k) return k.password
    const d = await this.drive(who)
    const password = await d.appPassword(`e2e-${who}`, this.creds(who).password)
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
    const d = await this.drive(who)
    let ts = await d.api('POST', '/me/totp/setup', {})
    if (ts.status === 403 && /reauth/.test(ts.text)) { await d.api('POST', '/me/reauth', { password: c.password }); ts = await d.api('POST', '/me/totp/setup', {}) }
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
    const d = await this.drive(who)
    let o = await d.api('POST', '/me/passkeys/options', {})
    if (o.status === 403 && /reauth/.test(o.text)) { await d.api('POST', '/me/reauth', { password: this.creds(who).password }); o = await d.api('POST', '/me/passkeys/options', {}) }
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

function show2(ops: NonNullable<Target['ops']>, slug: string) { const r = ops('teams', 'show', slug); return r.code === 0 && !/"status":"deleted"/.test(r.out) }
async function until(f: () => boolean, ms: number) { const end = Date.now() + ms; while (Date.now() < end) { if (f()) return true; await Bun.sleep(1500) } return f() }
