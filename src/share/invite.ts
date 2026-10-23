// Sharing with someone who is not a member yet (plan 3.7 `add: [{ email, role }]`). Only an admin may, and only through
// the team's invite flow, which Trina Cloud owns (workstreams B1 product side, D1 console): this module never creates
// people. B1 registers the handler at start-up:
//
//   import { setInviteHandler } from '../share/invite'
//   setInviteHandler(async (w, { email, by }) => { …console callback, invited person row… ; return { status: 'invited', personId } })
//
// The share API calls it after its own change committed; when the handler returns the invited person's id, the share
// is given to that person right away (in its own transaction, with the R6 re-check), so it is there when they join.
// Without a handler (self-hosted installs) such a request answers 409 `invites_unavailable`.
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

/** Trina Cloud mode registers the console invite flow here (null removes it, for tests). */
export function setInviteHandler(h: InviteHandler | null) { handler = h }
export const inviteHandler = () => handler
