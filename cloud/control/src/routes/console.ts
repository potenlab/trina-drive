// The Trina Cloud console's pages and JSON API (workstream D1): Teams, New team, a team's Overview, Members,
// Plan & usage, Settings, Audit; Account & security; invites; /open/<slug>, /sso/authorize; the team callback
// /api/team-callback/invites. Registered through ./index.ts; routes here are asked before web.ts's own pages, so they
// take over /, /dashboard, /login, /signup, /api/login… (web.ts keeps the Paddle webhook, Free sign-up and wake pages).
// The SSO and member-sync wire formats are fixed by docs/SSO-CONTRACT.md (test/fixtures/sso-v1.json).
import { authRoutes } from './console-auth'
import { ssoRoutes } from './console-sso'
import { staticRoutes } from './console-static'
import { teamRoutes } from './console-teams'
import type { ControlRoute } from './types'

export const consoleRoutes: ControlRoute[] = [...staticRoutes, ...authRoutes, ...ssoRoutes, ...teamRoutes]
