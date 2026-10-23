// What the stack under test can do, found by asking it (never by reading branch names): a route that exists answers
// 401 to a request without a session, a route that does not answers 404 before any sign-in check (src/web/api.ts,
// cloud/control/src/web.ts). As A1/B1/C1/D1 merge and the images are rebuilt, their scenarios stop being pending by
// themselves. The reasons name the workstream that brings the feature (plan §10.3).
import fs from 'node:fs'
import path from 'node:path'
import type { Http } from './http'
import { sh, type Target } from './target'

export type Feature =
  | 'team'            // the fixture team answers over HTTPS
  | 'sso'             // B1: GET /api/sso/start → 303 to the console's /sso/authorize
  | 'sso-console'     // D1: /sso/authorize exists on the console (no session → /login?next=)
  | 'console'         // D1: console JSON API (/api/me) — members, invites, TOTP
  | 'sso-only'        // B1 + D1 teamEnv: TDRIVE_SSO_ONLY=1 in the team's env
  | 'cloud-sync'      // B1: `tdrive cloud sync-members` in the team image
  | 'share'           // A1: GET/POST /api/share
  | 'shared-with-me'  // A1: GET /api/shared-with-me
  | 'directory'       // A1: GET /api/directory
  | 'drive-ui'        // C1: the new drive shell (sidebar with Shared with me)
  | 'free-closed'     // D1: TDCLOUD_MAX_FREE_TEAMS defaults to 0
  | 'browser'         // H2: playwright-core installed (bun install --cwd e2e/ui) and a Chromium for it
  | 'webkit'          // H2: a WebKit for playwright-core (S48)
  | 'ops'             // the operator CLI is reachable (local: docker exec; AWS: E2E_OPS)
  | 'mail'            // mail can be read (local sinks; AWS: no — H4 reads Gmail)

export interface FeatureResult { ok: boolean; reason: string }

const WHO: Record<Feature, string> = {
  team: 'the fixture team is not running',
  sso: 'needs B1 (feat/b1-sso): the drive does not serve GET /api/sso/start yet',
  'sso-console': 'needs D1 (feat/d1-console): the console does not serve /sso/authorize yet',
  console: 'needs D1 (feat/d1-console): the console JSON API (/api/me, members, invites, TOTP) is not served yet',
  'sso-only': 'needs B1+D1: the team env has no TDRIVE_SSO_ONLY=1 yet (teamEnv)',
  'cloud-sync': 'needs B1 (feat/b1-sso): `tdrive cloud sync-members` is not in the team image yet',
  share: 'needs A1 (feat/a1-share): GET/POST /api/share is not served yet',
  'shared-with-me': 'needs A1 (feat/a1-share): GET /api/shared-with-me is not served yet',
  directory: 'needs A1 (feat/a1-share): GET /api/directory is not served yet',
  'drive-ui': 'needs C1 (feat/c1-drive-ui): the drive web app has no new shell (Shared with me) yet',
  'free-closed': 'needs D1 (feat/d1-console): TDCLOUD_MAX_FREE_TEAMS still defaults above 0',
  browser: 'playwright-core is not installed for the browser flows: bun install --cwd e2e/ui',
  webkit: 'no WebKit for playwright-core 1.64.1 here (bunx playwright@1.64.1 install webkit)',
  ops: 'no operator CLI on this target (AWS: set E2E_OPS)',
  mail: 'mail cannot be read on this target (AWS mail is checked by H4 through Gmail)',
}

export const UI_DIR = path.resolve(import.meta.dir, '../../../../e2e/ui')

export class Features {
  private cache = new Map<Feature, Promise<FeatureResult>>()
  constructor(private t: Target, private http: Http, private forced: Partial<Record<Feature, boolean>> = {}) {}

  get(f: Feature): Promise<FeatureResult> {
    let p = this.cache.get(f)
    if (!p) { p = this.probe(f).then((ok) => ({ ok, reason: ok ? '' : WHO[f] }), (e) => ({ ok: false, reason: `${WHO[f]} (probe: ${(e as Error).message})` })); this.cache.set(f, p) }
    return p
  }
  /** forget probes (after the fixture made the team) */
  reset(...fs: Feature[]) { for (const f of fs.length ? fs : [...this.cache.keys()]) this.cache.delete(f) }

  private async status(method: string, url: string) { return (await this.http.req(method, url, { origin: false, timeoutMs: 15_000 })).status }

  private async probe(f: Feature): Promise<boolean> {
    if (f in this.forced) return !!this.forced[f]
    const team = this.t.teamUrl(this.t.team)
    switch (f) {
      case 'team': return (await this.status('GET', `${team}/api/state`)) === 200
      case 'sso': {
        if (!(await this.get('team')).ok) return false
        const r = await this.http.req('GET', `${team}/api/sso/start?return=%2F`, { timeoutMs: 15_000 })
        return r.status >= 300 && r.status < 400 && r.location.startsWith(`${this.t.control}/sso/authorize`)
      }
      case 'sso-console': {
        const r = await this.http.req('GET', `${this.t.control}/sso/authorize?team=team_00000000000000000000&state=x`, { timeoutMs: 15_000 })
        return r.status >= 300 && r.status < 400 && /\/login\b/.test(r.location)
      }
      case 'console': return (await this.status('GET', `${this.t.control}/api/me`)) === 401
      case 'share': return (await this.get('team')).ok && (await this.status('GET', `${team}/api/share?path=%2F`)) === 401
      case 'shared-with-me': return (await this.get('team')).ok && (await this.status('GET', `${team}/api/shared-with-me`)) === 401
      case 'directory': return (await this.get('team')).ok && (await this.status('GET', `${team}/api/directory`)) === 401
      case 'sso-only': {
        if (this.t.kind === 'aws') return (await this.get('sso')).ok
        const i = sh(['docker', 'inspect', '-f', '{{json .Config.Env}}', `tdc-${this.t.team}`])
        return i.code === 0 && (JSON.parse(i.out) as string[]).includes('TDRIVE_SSO_ONLY=1')
      }
      case 'cloud-sync': {
        if (!this.t.tdrive) return (await this.get('sso')).ok
        const h = this.t.tdrive(this.t.team, 'help')
        return /cloud sync-members/.test(h.out + h.err)
      }
      case 'drive-ui': {
        if (!(await this.get('team')).ok) return false
        const html = (await this.http.req('GET', `${team}/`)).text
        const js = [...html.matchAll(/src="(\/assets\/[^"]+\.js)"/g)].map((m) => m[1]!)
        for (const src of js) if (/#\/shared\b|"shared-with-me"|shared_with_me/.test((await this.http.req('GET', `${team}${src}`)).text)) return true
        return false
      }
      case 'free-closed': {
        if (!this.t.ops || this.t.kind !== 'local') return false
        const r = sh(['docker', 'exec', '-e', 'TDCLOUD_MAX_FREE_TEAMS=', 'tdc-control', 'bun', '-e',
          "const { loadConfig } = await import('/app/src/config.ts'); const e = { ...process.env }; delete e.TDCLOUD_MAX_FREE_TEAMS; console.log(loadConfig(e).free.maxTeams)"])
        return r.code === 0 && r.out.trim() === '0'
      }
      case 'browser': {
        if (!fs.existsSync(path.join(UI_DIR, 'node_modules/playwright-core/package.json'))) return false
        const { chromiumPath } = await import(path.join(UI_DIR, 'browser.ts'))
        return !!(await chromiumPath())
      }
      case 'webkit': {
        if (!(await this.get('browser')).ok) return false
        const { webkitAvailable } = await import(path.join(UI_DIR, 'browser.ts'))
        return await webkitAvailable()
      }
      case 'ops': return !!this.t.ops && this.t.ops('teams', 'list').code === 0
      case 'mail': return !!this.t.outbox
    }
  }
}
