// Fields Trina Cloud mode adds to `me` (workstream B1), merged by src/web/me-extras.ts. {} outside cloud mode.
//   cloud.sso_only      password sign-in is off for console people (the app shows "Sign in with Trina Cloud")
//   cloud.console_url   where Members, billing and the account live
//   cloud.managed       this person comes from the console (people pages are read-only for them)
//   cloud.has_password  false: re-authenticate with a passkey, an authenticator code or the console (reauth_url)
//   myFilesPath         "/<mount name>" of the person's My files (B2, docs/MY-FILES.md), or null; absent when self-hosted
import type { MeExtra } from '../web/me-extras'
import { cloudConfig } from './config'
import { myFilesPath } from './my-files'

export const cloudMeExtras: MeExtra[] = [
  (w, a) => {
    const c = cloudConfig(w.db)
    if (!c) return {}
    const r = w.db.query<{ cloud_user: string | null; cloud_invite: string | null; password_hash: string | null; display_name: string | null }, [number]>(
      'SELECT a.cloud_user, a.cloud_invite, a.password_hash, p.display_name FROM people p LEFT JOIN accounts a ON a.person_id = p.id WHERE p.id = ?').get(a.personId)
    return { cloud: {
      sso_only: c.ssoOnly, console_url: c.consoleUrl, managed: !!(r?.cloud_user || r?.cloud_invite), has_password: !!r?.password_hash,
      display_name: r?.display_name ?? null, reauth_url: r?.cloud_user ? '/api/sso/start?reauth=1' : null,
    } }
  },
  (w, a) => cloudConfig(w.db) ? { myFilesPath: myFilesPath(w.db, a.personId) } : {},
]
