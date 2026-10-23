// /api routes for Trina Cloud mode (workstream B1): GET /api/sso/start, POST /api/sso/callback (form_post from the
// console: R(..., { raw: true, crossOrigin: true }) — the state cookie and the signed assertion prove it, see
// docs/SSO-CONTRACT.md), POST /api/cloud/invite. Registered through src/web/routes.ts. Only active when the
// TDRIVE_CLOUD_* environment is set; a self-hosted install answers 404 as for any unknown path.
import type { Route } from '../web/route'

export const cloudRoutes: Route[] = []
