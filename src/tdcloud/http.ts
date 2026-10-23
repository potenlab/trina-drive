// /api routes for Trina Cloud mode (workstream B1), registered through src/web/routes.ts. Each answers 404 on a
// self-hosted install (no TDRIVE_CLOUD_* environment), except POST /api/me/reauth/options, which every install has
// (passkey / authenticator re-authentication, review finding 4).
//   GET  /api/sso/start?return=/…[&reauth=1]   → 303 to the console with a fresh state (sso.ts)
//   POST /api/sso/callback                     the console's form_post: { raw, crossOrigin } — no Origin check; the
//                                              state cookie and the signed assertion prove the request
//   POST /api/sso/second {ticket}              the drive's second factor after an SSO pass (then POST /api/login/second)
//   POST /api/cloud/invite {email}             ask the console to invite someone (member only)
//   POST /api/me/reauth/options                how to prove it is you again (password, passkey, TOTP, console)
import * as people from '../web/people-ops'
import { R, type Route } from '../web/route'
import { inviteToTeam } from './invite'
import * as sso from './sso'

export const cloudRoutes: Route[] = [
  R('GET', '/sso/start', false, ({ w, req, url, addr }) => sso.start(w, req, url, addr)),
  R('POST', '/sso/callback', false, ({ w, req, addr }) => sso.callback(w, req, addr, (w.opts.publicUrl ?? new URL(req.url).origin).replace(/\/$/, '')), { raw: true, crossOrigin: true }),
  R('POST', '/sso/second', false, ({ w, body, addr }) => sso.secondChallenge(w, body, addr)),
  R('POST', '/cloud/invite', true, ({ op, body }) => inviteToTeam(op, body)),
  R('POST', '/me/reauth/options', true, ({ op, s }) => people.reauthOptions(op, s!.idHash)),
]
