// /api routes for sharing (Trina Cloud v1, workstream A1): the share dialog, its step-up, Shared with me and the people
// directory (docs/SHARING-API.md; types in ./api-types.ts). A path that is a file goes to file-level sharing (A2,
// ./file-grants.ts); Recent (A2, ./recent.ts). Registered through src/web/routes.ts. All need a web
// session: /api never reads a Bearer token, so an agent (PAT, OAuth grant) can never reach them (401), and no MCP tool
// or WebDAV method changes sharing. The older folder-page routes (PUT /api/folders/:id/rules, PATCH /api/folders/:id,
// managers) stay in src/web/api.ts and call ./rules.ts, which runs the same R6 re-check.
import { R, type Route } from '../web/route'
import { recent } from './recent'
import { changeShare, directory, sharedWithMe, shareStepUp, shareStepUpOptions, shareView } from './service'

export const shareRoutes: Route[] = [
  R('GET', '/share', true, ({ w, actor, url }) => shareView(w, actor, url.searchParams.get('path'))),
  R('POST', '/share', true, (c) => changeShare(c.op, c.s!.idHash, c.body)),
  R('POST', '/share/step-up/options', true, (c) => shareStepUpOptions(c.op, c.s!.idHash, c.body)),
  R('POST', '/share/step-up', true, (c) => shareStepUp(c.op, c.s!.idHash, c.body)),
  R('GET', '/shared-with-me', true, ({ w, actor }) => sharedWithMe(w, actor)),
  R('GET', '/directory', true, ({ w, actor }) => directory(w, actor)),
  // A2: the files this person opened or changed themselves (web, mounted drive), as they can see them now
  R('GET', '/recent', true, ({ w, actor, url }) => recent(w, actor, url)),
]
