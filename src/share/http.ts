// /api routes for sharing (Trina Cloud v1, workstream A1): the share dialog API, Shared with me, the people directory.
// Registered through src/web/routes.ts; define routes with R() from src/web/route.ts, e.g.
//   R('GET', '/share/:id', true, (c) => shareView(c.op, id(c)))
// Rules, managers, flags and the Everyone group are in ./rules.ts (moved from src/web/ops.ts).
import type { Route } from '../web/route'

export const shareRoutes: Route[] = []
