// /api routes for team skills (workstream I1), registered through src/web/routes.ts. Sessions only (Bearer tokens are
// never read under /api): an agent cannot designate libraries, approve or reject skills.
import { id, R, type Route } from '../web/route'
import * as web from './web'

export const skillsRoutes: Route[] = [
  R('GET', '/skills', true, ({ w, actor }) => web.skillsView(w, actor)),
  R('GET', '/skills/download', true, ({ w, actor, url }) => web.download(w, actor, url)),
  R('PUT', '/skills/libraries', true, ({ op, body }) => web.designateFromWeb(op, body)),
  R('DELETE', '/skills/libraries/:id', true, (c) => web.undesignateFromWeb(c.op, id(c))),
  R('GET', '/skills/versions/:id', true, (c) => web.versionView(c.w, c.actor, id(c))),
  R('POST', '/skills/versions/:id/step-up/options', true, (c) => web.stepUpOptions(c.op, c.s!.idHash, id(c), c.body)),
  R('POST', '/skills/versions/:id/step-up', true, (c) => web.stepUp(c.op, c.s!.idHash, id(c), c.body)),
  R('POST', '/skills/versions/:id/approve', true, (c) => web.approve(c.op, c.s!.idHash, id(c), c.body)),
  R('POST', '/skills/versions/:id/reject', true, (c) => web.reject(c.op, id(c), c.body)),
]
