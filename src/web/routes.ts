// The route registry: every feature module's /api routes, imported once by api.ts (after the sign-in and core routes).
// A module adds a route by editing its own list, never api.ts or this file:
//   src/share/http.ts    shareRoutes    sharing: share dialog, Shared with me, directory (workstream A1)
//   src/tdcloud/http.ts  cloudRoutes    Trina Cloud: SSO start/callback, cloud invite (workstream B1)
// A new module list is added here by the integrator (one line). test/route-registry.test.ts checks that no two routes
// share a method and path pattern.
import { shareRoutes } from '../share/http'
import { cloudRoutes } from '../tdcloud/http'
import type { Route } from './route'

export const MODULE_ROUTES: Route[] = [...shareRoutes, ...cloudRoutes]
