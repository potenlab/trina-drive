// Invite from the drive (docs/SSO-CONTRACT.md "Invite from the drive"): an admin here asks the console to invite an
// address. The console is the one that decides: the role is always "member" (admins are invited in the console only,
// review finding 7), and the console checks that by_cloud_user is an admin of this team right now. The drive never
// makes the person itself; the next member sync brings the invited row.
import { appendAudit } from '../audit'
import { ApiError, forbidden, notFound } from '../web/http'
import { checkEmail, requireAdmin, type Op } from '../web/op-common'
import { cloudConfig } from './config'
import { cloudUserOf } from './people'

type Fetch = (url: string, init: RequestInit) => Promise<Response>
let fetchImpl: Fetch = (url, init) => fetch(url, init)
/** Tests: answer for the console. */
export function setConsoleFetch(f: Fetch | null) { fetchImpl = f ?? ((url, init) => fetch(url, init)) }

export async function inviteToTeam(op: Op, body: { email?: unknown }) {
  const cfg = cloudConfig(op.w.db)
  if (!cfg) throw notFound()
  requireAdmin(op)
  const email = checkEmail(body.email)
  const by = cloudUserOf(op.w.db, op.actor.personId)
  if (!by) throw forbidden('only an admin signed in with Trina Cloud can invite')
  if (!cfg.callbackToken) throw new ApiError(503, 'not_configured', 'this drive cannot reach the console (no callback token)')
  let res: Response
  try {
    res = await fetchImpl(`${cfg.consoleUrl}/api/team-callback/invites`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${cfg.callbackToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ email, role: 'member', by_cloud_user: by }),
    })
  } catch {
    throw new ApiError(502, 'console_unreachable', 'the Trina Cloud console could not be reached; try again, or invite from the console')
  }
  const out = await res.json().catch(() => ({})) as { status?: string; invite?: string; error?: string; message?: string }
  if (res.status === 201 || res.status === 200) {
    appendAudit(op.w.db, { personId: op.actor.personId, tokenId: null, tool: 'web', command: `cloud invite ${email} (member, ${out.invite ?? '?'})`, files: [], outcome: 'ok' })
    return { status: out.status ?? 'invited', invite: out.invite ?? null }
  }
  const code = typeof out.error === 'string' && /^[a-z_]{1,40}$/.test(out.error) ? out.error : 'console_error'
  if (res.status === 429) throw new ApiError(429, 'rate_limited', 'too many invites today; try tomorrow or invite from the console')
  if (res.status === 403) throw new ApiError(403, code, 'the console says you are not an admin of this team')
  if (res.status === 400) throw new ApiError(400, code, out.message ?? 'the console refused this invite')
  throw new ApiError(502, 'console_error', `the console answered ${res.status}`)
}
