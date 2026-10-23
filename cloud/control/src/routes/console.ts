// The Trina Cloud console's pages and JSON API (workstream D1): Teams, Overview, Members, Plan & usage, Settings,
// Account, invites, /open/<slug>, /sso/authorize, /api/teams/:id/members…, /api/team-callback/invites. Registered
// through ./index.ts; a route here is asked before web.ts's own pages, so it may take over / or /dashboard.
// The SSO and member-sync wire formats are fixed by docs/SSO-CONTRACT.md (test/fixtures/sso-v1.json).
import type { ControlRoute } from './types'

export const consoleRoutes: ControlRoute[] = []
