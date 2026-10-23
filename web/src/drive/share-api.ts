// The sharing API the share dialog and "Shared with me" use (plan 3.7 + 10.2-8 "O1": Editors can share), behind one
// small adapter so the screens do not care which server they talk to:
//   - `remote`: the sharing API (/api/share, /api/shared-with-me, /api/directory; workstream A1, src/share/http.ts)
//   - `legacy`: a server without it (before A1 is merged, or an older install): the same answers built from the folder
//     rules API that exists today (GET /folders/:id, PUT /folders/:id/rules, managers, PATCH flags). It cannot do what
//     only the new API knows (Editors can share, widening checks, the Editor step-up, Shared with me): those fields are
//     left out and the dialog hides what they drive.
// Which one: GET /api/directory exists only with the sharing API (a route that is missing answers 404; the directory
// is never hidden from a signed-in person). The screens use the view below; `fromApi` maps the sharing API's answer
// (src/share/api-types.ts, docs/SHARING-API.md) onto it.
import type * as A from '../../../src/share/api-types'
import { api, ApiError, get, type FolderDetail, type FolderSummary, type Person } from '../api'

export type Role = 'viewer' | 'editor' | 'manager'
export type Level = 'viewer' | 'editor'
export interface SubjectRef { type: 'person' | 'group'; id: number }
export interface Subject extends SubjectRef { name: string; email?: string | null; members?: number; everyone?: boolean }
export interface ShareEntry {
  subject: Subject; role: Role; source: 'direct' | 'inherited'; from_path?: string | null
  /** an old "manage without edit" grant (plan 3.8): shown as "Manager (can't open files)" */
  cannot_open?: boolean
  /** may the caller change or remove it (the sharing API says; else worked out from the role) */
  editable?: boolean
  /** files: a direct entry whose subject also has this role from the folder */
  inherited_role?: Role
}
export interface ShareView {
  item: { path: string; kind: 'folder' | 'file'; name: string }
  /** NAS (in-place) folders keep the expert folder page; 'personal': My files is never shared (move it to a team folder) */
  mode?: 'inplace' | 'personal'
  folder_id?: number
  /** admins, where the team invites by mail: a non-member's address may be added (S16: the share waits until they join) */
  can_invite?: boolean
  /** files: managers and admins confirm a widening; an Editor asks a manager instead */
  can_confirm_widening?: boolean
  /** files: 'hidden' = the caller reads only this file, so the folder's readers are not listed */
  inherited?: 'shown' | 'hidden'
  /** may change everything here (Manager or Admin) */
  can_manage: boolean
  /** may share here at all: Managers, and Editors while "Editors can change permissions and share" is on (O1) */
  can_share?: boolean
  can_grant_manager: boolean
  can_ai_off: boolean
  can_restrict_here?: boolean
  my_role?: Role | 'admin' | null
  /** O1 toggle; absent on a server without it. off_above: a folder above turned it off */
  editors_can_share?: { value: boolean; off_above?: boolean; inherited_from?: string | null; can_change: boolean }
  /** "Anyone in <team>" */
  team_name?: string
  general: { effective: { level: Level; from_path: string | null } | null; own: Level | null; restricted_here: boolean
    /** an Editor confirms with a passkey (step-up) before opening the folder to the whole team */
    editor_step_up?: boolean
    /** files: false = General access comes from the folder (a file cannot be narrower than its folder) */
    can_restrict?: boolean }
  entries: ShareEntry[]
  ai: { no_ai: boolean; inherited_no_ai_from?: string | null }
  /** folders: true; files: the folder path whose names the people you add will see */
  path_names_visible?: boolean | string
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
  /** managers: go ahead; Editors: ask a source manager (202 approval_pending) */
  confirm_widening?: boolean
  /** the assertion from POST /api/share/step-up */
  step_up?: string
  /** files: remove my own share on this file */
  leave?: true
}
export interface ShareResult extends ShareView { widens?: number; invited?: { email: string; status: string; granted: boolean }[]; approval_id?: number }
export interface Directory { people: { id: number; name: string; display_name?: string | null; email?: string | null }[]; groups: { id: number; name: string; size: number; everyone?: boolean }[] }
export interface SharedItem { path: string; kind: 'folder' | 'file'; name: string; role: Role | null; shared_by: { id: number; name: string } | null; shared_at: number | null; size?: number; mtime?: number }
export type RecentItem = A.RecentItem

export interface ShareBackend {
  kind: 'remote' | 'legacy'
  get(path: string): Promise<ShareView>
  change(path: string, c: ShareChange): Promise<ShareResult>
  stepUpOptions(path: string, general: ShareChange['general']): Promise<{ method: 'passkey' | 'totp'; options?: unknown }>
  /** proves the step-up; answers the assertion to send as `step_up` */
  stepUp(path: string, general: ShareChange['general'], proof: { response: unknown } | { code: string }): Promise<string>
  directory(): Promise<Directory>
  sharedWithMe(): Promise<SharedItem[] | null>
}

const enc = encodeURIComponent

// ---------- the sharing API ----------
/** A file's answer (workstream A2, docs/SHARING-API.md "Files") as the screens' view. */
export function fromFileApi(v: A.FileShareView): ShareView {
  const item = { path: v.item.path, kind: 'file' as const, name: v.item.name }
  const g = v.general
  const base: ShareView = {
    item, can_manage: false, can_share: false, can_grant_manager: false, can_ai_off: false, can_restrict_here: false,
    my_role: v.my_role ?? null, general: { effective: null, own: null, restricted_here: false }, entries: [], ai: { no_ai: false },
  }
  if (v.mode === 'inplace' || v.mode === 'personal') return { ...base, mode: v.mode }
  return {
    ...base,
    can_manage: !!v.can_manage && v.manage_as !== 'editor', can_share: !!v.can_manage,
    can_invite: !!v.can_invite, can_confirm_widening: !!v.can_confirm_widening,
    // a file has no toggle of its own: shown only when a folder above turned it off (it explains a read-only dialog)
    editors_can_share: v.editors_can_share && !v.editors_can_share.effective
      ? { value: false, off_above: true, inherited_from: v.editors_can_share.from_path, can_change: false } : undefined,
    general: g ? {
      effective: g.effective ? { level: g.effective.role, from_path: g.effective.from_path === item.path ? null : g.effective.from_path } : null,
      own: g.own, restricted_here: false, editor_step_up: g.editor_step_up, can_restrict: g.can_restrict,
    } : base.general,
    entries: v.entries.map((e) => ({
      subject: { type: e.subject.type, id: e.subject.id, name: e.subject.name, email: e.subject.email ?? null, members: e.subject.members },
      role: e.role, source: e.source, from_path: e.from_path ?? null, editable: e.editable, inherited_role: e.inherited_role,
    })),
    inherited: v.inherited,
    ai: { no_ai: !!v.ai?.no_ai, inherited_no_ai_from: v.ai?.inherited_no_ai_from ?? null },
    path_names_visible: v.path_names_visible,
    warnings: (v.warnings ?? []).map((w) => ({ code: w.code })),
  }
}

/** The sharing API's answer as the screens' view. */
export function fromApi(answer: A.ShareView | A.InplaceView | A.FileShareView): ShareView {
  if (answer.item.kind === 'file') return fromFileApi(answer as A.FileShareView)
  const v = answer as A.ShareView | A.InplaceView
  if (v.mode === 'inplace') return { mode: 'inplace', folder_id: v.item.id, item: v.item, can_manage: false, can_grant_manager: false, can_ai_off: false, general: { effective: null, own: null, restricted_here: false }, entries: [], ai: { no_ai: false } }
  const g = v.general
  return {
    item: { path: v.item.path, kind: v.item.kind, name: v.item.name }, folder_id: v.item.id,
    can_manage: v.can_manage, can_share: v.can_share, can_grant_manager: v.can_grant_manager, can_ai_off: v.can_ai_off, can_restrict_here: v.can_restrict_here,
    my_role: v.my_role,
    editors_can_share: { value: v.editors_can_share.effective, off_above: v.editors_can_share.off_above, inherited_from: null, can_change: v.can_toggle_editors },
    general: {
      // set here, or the folder it comes from (null = here)
      effective: g.effective ? { level: g.effective.role, from_path: g.own || g.effective.from_path === v.item.path ? null : g.effective.from_path } : null,
      own: g.own, restricted_here: g.restricted_here, editor_step_up: g.editor_step_up,
    },
    entries: v.entries.map((e) => ({ subject: e.subject, role: e.role, source: e.source, from_path: e.from_path ?? null, cannot_open: e.note === 'cannot_open', editable: e.editable })),
    ai: { no_ai: v.ai.no_ai, inherited_no_ai_from: v.ai.inherited_no_ai_from ?? null },
    path_names_visible: v.path_names_visible,
    warnings: v.warnings.map((w) => ({ code: w.code, count: 'count' in w ? w.count : undefined })),
  }
}

export const remote: ShareBackend = {
  kind: 'remote',
  get: (path) => get<A.ShareView | A.InplaceView | A.FileShareView>('/share?path=' + enc(path)).then(fromApi),
  async change(path, c) {
    const r = await api<A.ShareResult | A.ApprovalPending | (A.FileShareView & { widens: number; invited: A.ShareResult['invited'] })>('POST', '/share', { path, ...c })
    // an Editor's widening change waits for a source manager: the folder is as it was
    if ('status' in r && r.status === 'approval_pending') return { ...(await remote.get(path)), approval_id: r.approval_id, widens: r.widens }
    const v = r as A.ShareResult
    return { ...fromApi(v), widens: v.widens, invited: v.invited }
  },
  stepUpOptions: (path, general) => api('POST', '/share/step-up/options', { path, general }),
  stepUp: (path, general, proof) => api<{ assertion: string }>('POST', '/share/step-up', { path, general, ...proof }).then((r) => r.assertion),
  directory: () => get<Directory>('/directory'),
  sharedWithMe: () => get<{ items: SharedItem[] }>('/shared-with-me').then((r) => r.items),
}

/** GET /api/recent (workstream A2): this person's own opens and changes, newest first; null on a server without it. */
export async function recentFiles(limit = 50): Promise<{ items: RecentItem[]; partial: boolean } | null> {
  try { return await get<{ items: RecentItem[]; partial: boolean }>('/recent?limit=' + limit) } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null
    throw e
  }
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
    // (files are shared one by one only with the sharing API: load() finds no folder for a file path → 404)
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
    stepUp: () => Promise.reject(new ApiError(404, 'not_found', 'not found')),
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

/** The address to send someone: the drive's own page for a folder, or a file picked in its folder (they still need access). */
export function linkTo(origin: string, path: string, kind: 'folder' | 'file' = 'folder') {
  if (kind === 'file') return `${origin}/#/files?p=${enc(path.slice(0, path.lastIndexOf('/')) || '/')}&s=${enc(path)}`
  return `${origin}/#/files?p=${enc(path)}`
}

export interface Widening {
  /** people who would gain the content */
  count: number
  sourcesHidden: number
  /** source folders the caller can read */
  sources: string[]
  /** managers / admins: send again with confirm_widening */
  canConfirm: boolean
  /** folders: an Editor sends it again with confirm_widening, which asks a source manager (202) */
  canRequest: boolean
}
/** "widening" answer of a change (plan 10.2-1): how many more people, and what this person may do about it. */
export function wideningOf(e: unknown, kind: 'folder' | 'file' = 'folder'): Widening | null {
  if (!(e instanceof ApiError) || e.status !== 409 || (e.code !== 'widening' && e.data?.code !== 'widening')) return null
  const d = e.data ?? {}
  const canConfirm = d.can_confirm !== false && d.needs_approval !== true
  return {
    count: Number(d.people ?? d.count ?? 0), sourcesHidden: Number(d.sources_hidden ?? 0),
    sources: Array.isArray(d.sources) ? d.sources.filter((x): x is string => typeof x === 'string') : [],
    canConfirm,
    // a file's widening is confirmed by a manager of its folder; an Editor's confirm would be refused (editors_cannot_confirm)
    canRequest: !canConfirm && d.needs_approval === true && kind === 'folder',
  }
}
/** My files (and anything in it) is never shared: 403/409 `personal`. */
export const isPersonal = (e: unknown) => e instanceof ApiError && e.code === 'personal'
/** A path as the person reads it: inside My files it starts with `label` ("My files"), not the folder's real name. */
export const shownPath = (path: string, myFiles: string | null | undefined, label: string) =>
  inMyFiles(path, myFiles) ? label + path.slice(myFiles!.length) : path
/** True when `path` is the person's My files or inside it. */
export const inMyFiles = (path: string, myFiles: string | null | undefined) => !!myFiles && (path === myFiles || path.startsWith(myFiles + '/'))
export const needsStepUp = (e: unknown) => e instanceof ApiError && (e.code === 'step_up_required' || e.code === 'reauth_required')

// ---------- Recent and the approval inbox: pure helpers (tested without a browser) ----------
const DAY = 86_400_000
/** Recent's day groups, from the viewer's own clock: today, yesterday, the rest of this week, older. */
export function recentBucket(at: number, now = Date.now()): 'rc_today' | 'rc_yesterday' | 'rc_week' | 'rc_older' {
  const d = new Date(now); d.setHours(0, 0, 0, 0)
  const today = d.getTime()
  if (at >= today) return 'rc_today'
  if (at >= today - DAY) return 'rc_yesterday'
  if (at >= today - 6 * DAY) return 'rc_week'
  return 'rc_older'
}

/** The change a share request asked for (an approval of kind 'share'), as it is stored. */
export interface ShareChangeAsked {
  add?: { subject: { type?: string; id?: number; email?: string }; role: string }[]
  set?: { subject: { type: string; id: number }; role: string }[]
  general?: { mode: 'restricted' | 'team'; role?: string }
  restrict_here?: { on: boolean }
  [k: string]: unknown
}
export type ChangeLine =
  | { key: 'ap_share_add' | 'ap_share_invite'; n: number; role: string }
  | { key: 'ap_share_set' | 'ap_share_remove'; n: number }
  | { key: 'ap_share_general_team'; role: string }
  | { key: 'ap_share_general_restricted' | 'ap_share_restrict' | 'ap_share_other' }
/** A share request in lines of counts and roles: the request names nobody (the approver sees who gains, counted). */
export function shareChangeLines(c: ShareChangeAsked | undefined): ChangeLine[] {
  if (!c) return []
  const out: ChangeLine[] = []
  const byRole = (xs: { role: string }[]) => [...new Set(xs.map((x) => x.role))].map((r) => [r, xs.filter((x) => x.role === r).length] as const)
  const adds = c.add ?? []
  for (const [role, n] of byRole(adds.filter((a) => !a.subject.email))) out.push({ key: 'ap_share_add', n, role })
  for (const [role, n] of byRole(adds.filter((a) => !!a.subject.email))) out.push({ key: 'ap_share_invite', n, role })
  const sets = c.set ?? []
  const removes = sets.filter((x) => x.role === 'remove').length
  if (sets.length - removes) out.push({ key: 'ap_share_set', n: sets.length - removes })
  if (removes) out.push({ key: 'ap_share_remove', n: removes })
  if (c.general) out.push(c.general.mode === 'team' ? { key: 'ap_share_general_team', role: c.general.role ?? 'viewer' } : { key: 'ap_share_general_restricted' })
  if (c.restrict_here?.on) out.push({ key: 'ap_share_restrict' })
  const known = new Set(['path', 'add', 'set', 'general', 'restrict_here', 'notify', 'confirm_widening', 'step_up'])
  if (Object.keys(c).some((k) => !known.has(k))) out.push({ key: 'ap_share_other' })
  return out
}
