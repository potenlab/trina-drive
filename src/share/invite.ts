// Sharing with someone who is not a member yet (plan 3.7 `add: [{ email, role }]`). Only an admin may, and only through
// the team's invite flow, which Trina Cloud owns (src/tdcloud/invite.ts, the console): this module never creates
// people. The share API calls the handler after its own change committed; when it returns the invited person's id, the
// share is given to that person right away (in its own transaction, with the R6 re-check). Without a handler (self-
// hosted installs) such a request answers 409 `invites_unavailable`.
import type { DB } from '../db'
import { cloudConfig } from '../tdcloud/config'
import { inviteToTeam } from '../tdcloud/invite'
import type { WebCtx } from '../web/http'

export interface InviteRequest {
  /** the address as typed (trimmed) */
  email: string
  /** the role in the team: sharing only ever invites members (admins are made in the console) */
  role: 'member'
  /** the admin inviting */
  by: number
}
export interface InviteResult {
  status: 'invited' | 'member'
  /** the person row the product now has for this address (an invited person), if any */
  personId?: number
}
export type InviteHandler = (w: WebCtx, req: InviteRequest) => Promise<InviteResult>

let handler: InviteHandler | null = null

/** Another invite flow (tests, or a future one); null = the default below. */
export function setInviteHandler(h: InviteHandler | null) { handler = h }

/**
 * Trina Cloud mode by default: the console's invite flow (src/tdcloud/invite.ts — member role only; the console checks
 * the inviting admin). The invited person's row arrives with the next member sync, so the share itself is given once
 * they are a member (the API answers `granted: false` for them now). Elsewhere: none.
 */
const consoleInvite: InviteHandler = async (w, req) => {
  const r = await inviteToTeam({ w, actor: { personId: req.by, admin: true }, base: '' }, { email: req.email })
  return { status: r.status === 'member' ? 'member' : 'invited' }
}
export const inviteHandler = (db: DB): InviteHandler | null => handler ?? (cloudConfig(db) ? consoleInvite : null)
