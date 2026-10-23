// Extra fields on the signed-in person's `me` (GET /api/session, sign-in answers): views.ts me() merges what each
// module's hooks return. A module adds a hook to its own list, never views.ts:
//   src/tdcloud/me.ts  cloudMeExtras  e.g. { cloud: { sso_only, console_url } }   (workstream B1)
//   src/share/me.ts    shareMeExtras  e.g. { share: { … } }                        (workstream A1)
// Each hook returns its own top-level key; the base fields of me() always win over a hook's.
import type { Actor } from '../rights'
import type { WebCtx } from './http'
import { cloudMeExtras } from '../tdcloud/me'
import { shareMeExtras } from '../share/me'

export type MeExtra = (w: WebCtx, a: Actor) => Record<string, unknown>

export const ME_EXTRAS: MeExtra[] = [...cloudMeExtras, ...shareMeExtras]

export function meExtras(w: WebCtx, a: Actor): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of ME_EXTRAS) Object.assign(out, f(w, a))
  return out
}
