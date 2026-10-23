// Fields sharing adds to `me` (workstream A1), merged by src/web/me-extras.ts: what the web app needs before it opens
// the share dialog (the dialog itself asks GET /api/share for each folder).
import type { MeExtra } from '../web/me-extras'
import { inviteHandler } from './invite'

export const shareMeExtras: MeExtra[] = [
  (w, a) => ({ share: { api: 1, can_invite: a.admin && !!inviteHandler(w.db) } }),
]
