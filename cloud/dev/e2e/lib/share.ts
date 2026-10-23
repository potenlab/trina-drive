// Sharing a folder, the way the stack can: the share dialog's API (plan §3.7, A1) when it is served, else the folder
// rules API it replaces (PUT /api/folders/:id/rules, which A1 keeps). Scenarios that are about the dialog itself
// (O1, widening, restrict here) use POST /api/share directly and are pending until A1 merges.
import type { Drive } from './drive'
import type { Res } from './http'
import type { T } from './ctx'

export type Role = 'viewer' | 'editor' | 'manager' | 'remove'
export interface Subject { type: 'person' | 'group'; id: number }
const LEVEL: Record<Role, string> = { viewer: 'read', editor: 'write', manager: 'write', remove: 'none' }

/** give/change/remove one subject's role on a folder; `via` says which API did it */
export async function setRole(t: T, by: Drive, path: string, folderId: number, subject: Subject, role: Role, extra: Record<string, unknown> = {}): Promise<{ res: Res; via: 'share' | 'rules' }> {
  if ((await t.features.get('share')).ok) {
    const res = await by.api('POST', '/share', { path, set: [{ subject, role }], notify: false, ...extra })
    return { res, via: 'share' }
  }
  return { res: await by.api('PUT', `/folders/${folderId}/rules`, { subject_type: subject.type, subject_id: subject.id, level: LEVEL[role] }), via: 'rules' }
}

/** POST /api/share as plan §3.7 writes it (A1 only) */
export const share = (by: Drive, body: Record<string, unknown>) => by.api('POST', '/share', { notify: false, ...body })
export const shareView = (by: Drive, path: string) => by.get(`/share?path=${encodeURIComponent(path)}`)
