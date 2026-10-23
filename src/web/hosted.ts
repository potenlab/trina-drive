// Hosted mode (`serve --hosted`, TDRIVE_HOSTED=1; Trina Cloud): every team address is on the internet, so an admin
// must enrol a second factor (passkey or authenticator app) before using anything else. Enforced here, in front of
// every /api route (and the OAuth consent API): a signed-in admin without one reaches only the calls the enrolment
// screen makes. People who are not admins are not affected; the public listener's gate (public.ts) is unchanged.
import { lookupSession, SESSION_COOKIE } from './auth'
import { readCookie } from './api'
import { json, type WebCtx } from './http'
import { has2FA } from './mfa'

/** What an admin without a second factor may still call: session, sign-out, and enrolment (passkey, TOTP, codes). */
export const ENROLL_ALLOWED = new Set([
  'GET /api/state', 'GET /api/session', 'POST /api/logout',
  'GET /api/me/2fa', 'POST /api/me/reauth', 'POST /api/me/passkeys/options', 'POST /api/me/passkeys',
  'POST /api/me/totp/setup', 'POST /api/me/totp/confirm', 'POST /api/me/recovery-codes',
  // Trina Cloud: a console admin re-authenticates through the console to enrol (src/tdcloud), or with the options here
  'GET /api/sso/start', 'POST /api/sso/callback', 'POST /api/sso/second', 'POST /api/me/reauth/options',
])

export const hostedFlag = (flag: boolean, env: Record<string, string | undefined>, prefix: string) =>
  flag || ['1', 'true', 'yes', 'on'].includes((env[`${prefix}_HOSTED`] ?? '').trim().toLowerCase())

/** True when this signed-in person is an admin who still has to enrol (hosted mode only). */
export function mustEnroll(w: WebCtx, personId: number, admin: boolean): boolean {
  return !!w.opts.hosted && admin && !has2FA(w.db, personId)
}

/** null = go on; else the 403 an admin without a second factor gets. */
export function hostedGate(w: WebCtx, req: Request, pathname: string): Response | null {
  if (!w.opts.hosted || ENROLL_ALLOWED.has(`${req.method} ${pathname}`)) return null
  const s = lookupSession(w.db, readCookie(req, SESSION_COOKIE))
  if (!s || !mustEnroll(w, s.personId, s.admin)) return null
  return json({ error: 'second_factor_required', message: 'admins on a hosted server must add a passkey or an authenticator app first (Settings → Second factor)' }, 403)
}
