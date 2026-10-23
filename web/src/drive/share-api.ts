// The sharing API the share dialog and "Shared with me" use (plan 3.7 + 10.2-8 "O1": Editors can share), behind one
// small adapter so the screens do not care which server they talk to:
//   - `remote`: the sharing API (/api/share, /api/shared-with-me, /api/directory; workstream A1, src/share/http.ts)
//   - `legacy`: a server without it (before A1 is merged, or an older install): the same answers built from the folder
//     rules API that exists today (GET /folders/:id, PUT /folders/:id/rules, managers, PATCH flags). It cannot do what
//     only the new API knows (Editors can share, widening checks, the Editor step-up, Shared with me): those fields are
//     left out and the dialog hides what they drive.
// Which one: GET /api/directory exists only with the sharing API (a route that is missing answers 404; the directory
// is never hidden from a signed-in person). The shapes below are the contract; keep them in step with
// src/share/api-types.ts (A1) once it lands.
import { api, ApiError, get, type FolderDetail, type FolderSummary, type Person } from '../api'

export type Role = 'viewer' | 'editor' | 'manager'
export type Level = 'viewer' | 'editor'
export interface SubjectRef { type: 'person' | 'group'; id: number }
export interface Subject extends SubjectRef { name: string; email?: string | null; members?: number; everyone?: boolean }
export interface ShareEntry {
  subject: Subject; role: Role; source: 'direct' | 'inherited'; from_path?: string | null
  /** an old "manage without edit" grant (plan 3.8): shown as "Manager (can't open files)" */
  cannot_open?: boolean
}
export interface ShareView {
  item: { path: string; kind: 'folder' | 'file'; name: string }
  /** NAS (in-place) folders keep the expert folder page */
  mode?: 'inplace'
  folder_id?: number
  /** may change everything here (Manager or Admin) */
  can_manage: boolean
  /** may share here at all: Managers, and Editors while "Editors can change permissions and share" is on (O1) */
  can_share?: boolean
  can_grant_manager: boolean
  can_ai_off: boolean
  can_restrict_here?: boolean
  my_role?: Role | null
  /** O1 toggle; absent on a server without it */
  editors_can_share?: { value: boolean; inherited_from?: string | null; can_change: boolean }
  /** "Anyone in <team>" */
  team_name?: string
  general: { effective: { level: Level; from_path: string | null } | null; own: Level | null; restricted_here: boolean }
  entries: ShareEntry[]
  ai: { no_ai: boolean; inherited_no_ai_from?: string | null }
  path_names_visible?: boolean
  warnings?: { code: string; count?: number }[]
}
export interface ShareChange {
  add?: { subject: SubjectRef | { email: string }; role: Role }[]
  set?: { subject: SubjectRef; role: Role | 'remove' }[]
  general?: { mode: 'restricted' | 'team'; role?: Level }
  restrict_here?: { on: boolean; keep: SubjectRef[] }
  ai_access?: boolean
  editors_can_share?: boolean
  notify?: boolean
  confirm_widening?: boolean
  request_approval?: boolean
  step_up?: { response: unknown } | { code: string }
}
export interface ShareResult extends ShareView { widens?: number; invited?: string[]; approval_id?: number }
export interface Directory { people: { id: number; name: string; display_name?: string | null; email?: string | null }[]; groups: { id: number; name: string; size: number; everyone?: boolean }[] }
export interface SharedItem { path: string; kind: 'folder' | 'file'; name: string; role: Role | null; shared_by: { id: number; name: string } | null; shared_at: number | null }

export interface ShareBackend {
  kind: 'remote' | 'legacy'
  get(path: string): Promise<ShareView>
  change(path: string, c: ShareChange): Promise<ShareResult>
  stepUpOptions(path: string): Promise<{ method: 'passkey' | 'totp'; options?: unknown }>
  directory(): Promise<Directory>
  sharedWithMe(): Promise<SharedItem[] | null>
}

const enc = encodeURIComponent

// ---------- the sharing API ----------
export const remote: ShareBackend = {
  kind: 'remote',
  get: (path) => get<ShareView>('/share?path=' + enc(path)),
  change: (path, c) => api<ShareResult>('POST', '/share', { path, ...c }),
  stepUpOptions: (path) => api('POST', '/share/step-up/options', { path }),
  directory: () => get<Directory>('/directory'),
  sharedWithMe: () => get<{ items: SharedItem[] }>('/shared-with-me').then((r) => r.items),
}

// ---------- the same answers from the folder rules API ----------
const EVERYONE_NAMES = ['everyone', '전체', '전원']
const LEVEL_OF: Record<number, Level | null> = { 0: null, 1: 'viewer', 2: 'editor' }
const RULE_LEVEL: Record<Role | 'remove', 'read' | 'write' | 'none'> = { viewer: 'read', editor: 'write', manager: 'write', remove: 'none' }
const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1) || p

/** The folder row for a path: its own when there is one, else (for a manager) made now, else the nearest above. */
async function folderFor(path: string): Promise<{ id: number; exact: boolean }> {
  try {
    const r = await api<{ folder_id: number }>('POST', '/files/share', { path })
    return { id: r.folder_id, exact: true }
  } catch (e) {
    // 403: not a manager here; 404: a folder the person cannot open (an admin sharing it from Folder access)
    if (!(e instanceof ApiError) || (e.status !== 403 && e.status !== 404)) throw e
  }
  const { folders } = await get<{ folders: FolderSummary[] }>('/folders')
  const best = folders.filter((f) => f.vpath && (path === f.vpath || path.startsWith(f.vpath + '/'))).sort((a, b) => b.vpath!.length - a.vpath!.length)[0]
  if (!best) throw new ApiError(404, 'not_found', 'not found')
  return { id: best.id, exact: best.vpath === path }
}

/** Builds a ShareView out of the folder page's answer (exported for the tests). */
export function viewFromFolder(path: string, d: FolderDetail, me: { id: number }, exact = true): ShareView {
  const f = d.folder
  const everyone = d.rows.find((r) => r.type === 'group' && EVERYONE_NAMES.includes(r.name.toLowerCase()))
  const managers = new Map(d.managers.map((m) => [m.id, m]))
  const entries: ShareEntry[] = []
  for (const r of d.rows) {
    if (r === everyone) continue
    const lvl = r.ai.level
    if (r.type === 'group') {
      if (lvl < 1) continue
      entries.push({ subject: { type: 'group', id: r.id, name: r.name, members: r.members }, role: lvl >= 2 ? 'editor' : 'viewer', source: r.ai.direct ? 'direct' : 'inherited', from_path: r.ai.direct ? null : r.ai.inherited_from })
      continue
    }
    const mgr = managers.get(r.id)
    const own = r.ai.via === 'direct' || r.ai.via === 'inherited'
    if (!mgr && !own) continue // through a group only: the group's row says it
    if (mgr) {
      entries.push({ subject: { type: 'person', id: r.id, name: r.name }, role: 'manager', source: mgr.direct ? 'direct' : 'inherited', from_path: null, cannot_open: lvl < 2 })
      managers.delete(r.id)
    } else entries.push({ subject: { type: 'person', id: r.id, name: r.name }, role: lvl >= 2 ? 'editor' : 'viewer', source: r.ai.via === 'direct' ? 'direct' : 'inherited', from_path: r.ai.via === 'inherited' ? r.ai.inherited_from : null })
  }
  for (const m of managers.values()) entries.push({ subject: { type: 'person', id: m.id, name: m.name }, role: 'manager', source: m.direct ? 'direct' : 'inherited', from_path: null })
  const myRow = d.rows.find((r) => r.type === 'person' && r.id === me.id)
  const my_role: Role | null = f.mine.manage ? 'manager' : myRow && myRow.ai.level >= 2 ? 'editor' : myRow && myRow.ai.level >= 1 ? 'viewer' : null
  const evLevel = everyone ? LEVEL_OF[Math.min(2, everyone.ai.level)] ?? null : null
  const canManage = f.can.edit_rules && exact
  return {
    item: { path, kind: 'folder', name: f.vpath === path ? f.name : baseName(path) },
    folder_id: f.id,
    can_manage: canManage, can_share: canManage, can_grant_manager: f.can.admin && exact && f.personal_owner == null, can_ai_off: f.can.no_ai_off,
    can_restrict_here: canManage && !f.registered,
    my_role,
    general: {
      effective: evLevel ? { level: evLevel, from_path: everyone!.ai.direct ? null : everyone!.ai.inherited_from } : null,
      own: everyone?.ai.direct ? evLevel : null,
      restricted_here: f.inherit_break && !f.registered, // a top folder always starts fresh: nothing to restrict
    },
    entries,
    ai: { no_ai: f.no_ai },
    path_names_visible: false,
    warnings: [],
  }
}

let legacyEveryone: number | null = null

export function legacy(me: () => { id: number }): ShareBackend {
  const load = async (path: string) => {
    const { id, exact } = await folderFor(path)
    const d = await get<FolderDetail>(`/folders/${id}`)
    const everyone = d.rows.find((r) => r.type === 'group' && EVERYONE_NAMES.includes(r.name.toLowerCase()))
    if (everyone) legacyEveryone = everyone.id
    return { id, view: viewFromFolder(path, d, me(), exact) }
  }
  return {
    kind: 'legacy',
    get: async (path) => (await load(path)).view,
    async change(path, c) {
      const { id, view } = await load(path)
      const rule = (s: SubjectRef, level: string) => api('PUT', `/folders/${id}/rules`, { subject_type: s.type, subject_id: s.id, level })
      const wasManager = (s: SubjectRef) => view.entries.some((e) => e.subject.type === s.type && e.subject.id === s.id && e.role === 'manager' && e.source === 'direct')
      const one = async (s: SubjectRef, role: Role | 'remove') => {
        if (role === 'manager' && s.type === 'group') throw new ApiError(400, 'group_manager', 'a group cannot be a manager')
        await rule(s, RULE_LEVEL[role])
        if (s.type === 'person' && role === 'manager') await api('PUT', `/folders/${id}/managers/${s.id}`)
        else if (s.type === 'person' && wasManager(s)) await api('DELETE', `/folders/${id}/managers/${s.id}`)
      }
      for (const a of c.add ?? []) {
        if (!('type' in a.subject)) throw new ApiError(400, 'invite_unsupported', 'this server cannot invite by mail address from here')
        await one(a.subject, a.role)
      }
      for (const s of c.set ?? []) await one(s.subject, s.role)
      if (c.general) {
        if (legacyEveryone == null) throw new ApiError(409, 'no_everyone_group', 'this server has no "everyone" group')
        await rule({ type: 'group', id: legacyEveryone }, c.general.mode === 'team' ? RULE_LEVEL[c.general.role ?? 'viewer'] : 'none')
      }
      if (c.restrict_here) {
        if (c.restrict_here.on) {
          for (const k of c.restrict_here.keep) {
            const e = view.entries.find((x) => x.subject.type === k.type && x.subject.id === k.id)
            if (e) await rule(k, RULE_LEVEL[e.role])
            else if (k.type === 'group' && k.id === legacyEveryone && view.general.effective) await rule(k, RULE_LEVEL[view.general.effective.level])
          }
        }
        await api('PATCH', `/folders/${id}`, { inherit_break: c.restrict_here.on })
      }
      if (typeof c.ai_access === 'boolean') await api('PATCH', `/folders/${id}`, { no_ai: !c.ai_access })
      return (await load(path)).view
    },
    stepUpOptions: () => Promise.reject(new ApiError(404, 'not_found', 'not found')),
    async directory() {
      const r = await get<{ people: Person[]; groups: { id: number; name: string; members: number[] }[] }>('/people')
      return {
        people: r.people.filter((p) => p.active).map((p) => ({ id: p.id, name: p.name, email: p.email ?? null })),
        groups: r.groups.map((g) => ({ id: g.id, name: g.name, size: g.members.length, everyone: EVERYONE_NAMES.includes(g.name.toLowerCase()) })),
      }
    },
    sharedWithMe: () => Promise.resolve(null),
  }
}

// ---------- which one ----------
let chosen: Promise<ShareBackend> | null = null
export function shareBackend(me: () => { id: number }): Promise<ShareBackend> {
  chosen ??= fetch('/api/directory', { credentials: 'same-origin' }).then((r) => r.status === 404 ? legacy(me) : remote, () => legacy(me))
  return chosen
}
/** Forget the choice (sign-out, tests). */
export function resetShareBackend() { chosen = null; legacyEveryone = null }

/** The address to send someone for a folder: the drive's own page for it (they still need access). */
export function linkTo(origin: string, path: string) {
  return `${origin}/#/files?p=${enc(path)}`
}

/** "widening" answer of a change (plan 10.2-1): how many more people, and whether this person may confirm it. */
export function wideningOf(e: unknown): { count: number; sourcesHidden: number; canConfirm: boolean } | null {
  if (!(e instanceof ApiError) || e.status !== 409 || e.code !== 'widening') return null
  const d = e.data ?? {}
  return { count: Number(d.count ?? 0), sourcesHidden: Number(d.sources_hidden ?? 0), canConfirm: d.can_confirm !== false }
}
export const needsStepUp = (e: unknown) => e instanceof ApiError && (e.code === 'step_up_required' || e.code === 'reauth_required')
