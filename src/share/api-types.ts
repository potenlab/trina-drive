// The sharing REST API as types (Trina Cloud v1, workstream A1) — for the share dialog, Shared with me and the people
// picker in the web app (workstream C1). Documented in docs/SHARING-API.md. Types only plus one tiny typed client, no
// runtime dependency on the server: the web app may import this file directly.
//
// Roles: Viewer = rule level read, Editor = level write, Manager = level write + manage (R7). Admins (team role
// owner/admin) can change sharing everywhere but do not read files by that alone.
// Hidden == nonexistent: every path you cannot see answers 404 with the same body as a path that does not exist.

export type Role = 'viewer' | 'editor' | 'manager'
export type SubjectRef = { type: 'person' | 'group'; id: number }

export interface Subject extends SubjectRef {
  name: string
  /** only for admins (finding 11: addresses are for the admin and the person) */
  email?: string
  /** groups: active members */
  members?: number
  /** the Everyone group ("Anyone in Trina"); it never appears in `entries`, see `general` */
  everyone?: boolean
}

export interface ShareEntry {
  subject: Subject
  role: Role
  /** direct = given on this folder; inherited = from a folder above (change it there, or "Restrict access here") */
  source: 'direct' | 'inherited'
  /** inherited: the folder it comes from */
  from_path?: string
  /** a Manager whose own level is below Editor: 'cannot_open' (no read) or 'viewer' (read only) — shown, never raised silently */
  note?: 'cannot_open' | 'viewer'
  /** may the caller change or remove this entry here */
  editable: boolean
}

export interface ShareView {
  mode: 'managed'
  item: { path: string; kind: 'folder'; name: string; id: number }
  /** the caller's role here (null: sees only a path to something below; 'admin': a team admin without a role) */
  my_role: Role | 'admin' | null
  can_share: boolean
  can_manage: boolean
  can_grant_manager: boolean
  can_ai_off: boolean
  can_restrict_here: boolean
  can_toggle_editors: boolean
  can_invite: boolean
  /** the caller sees the whole list (else only their own entries: a bare path, finding 11) */
  full_list: boolean
  general: {
    /** what "Anyone in Trina" gets here, and from where */
    effective: { role: 'viewer' | 'editor'; from_path: string } | null
    /** set on this folder itself */
    own: 'viewer' | 'editor' | null
    /** "Restrict access here" is on (nothing comes from above except managers) */
    restricted_here: boolean
    /** an Editor needs a passkey (step-up) to open this folder to the whole team */
    editor_step_up: boolean
  }
  editors_can_share: { effective: boolean; own: boolean | null; off_above: boolean }
  entries: ShareEntry[]
  ai: { no_ai: boolean; inherited_no_ai_from?: string }
  /** people given access see the names of the folders on the path to it (not their contents) */
  path_names_visible: true
  warnings: ShareWarning[]
}

export type ShareWarning =
  /** AI-draft copies here: opening the folder wider may need a source manager's approval */
  | { code: 'draft_copies'; count: number }
  | { code: 'editors_off_above' }
  | { code: 'manager_cannot_open'; count: number }

export interface InplaceView { mode: 'inplace'; item: { path: string; kind: 'folder'; name: string; id: number } }

export interface ShareChange {
  path: string
  /** new people or groups (a member by id; a non-member by email: admins only, through the invite flow) */
  add?: { subject: SubjectRef | { email: string }; role: Role }[]
  /** change or remove entries given on this folder */
  set?: { subject: SubjectRef; role: Role | 'remove' }[]
  /** General access: Restricted, or Anyone in Trina as Viewer / Editor */
  general?: { mode: 'restricted' } | { mode: 'team'; role: 'viewer' | 'editor' }
  /** Restrict access here (managers and admins): keep = inherited entries that keep their current level here */
  restrict_here?: { on: boolean; keep?: SubjectRef[] }
  /** false = "No AI" on (anyone who may share); true = off (admin only) */
  ai_access?: boolean
  /** O1 toggle (managers and admins) */
  editors_can_share?: boolean
  /** tell people who were given access (kind + count + link only, O7); default true */
  notify?: boolean
  /** go ahead although AI-draft copies here would reach more people (managers / admins; an Editor's request waits for approval) */
  confirm_widening?: boolean
  /** the assertion from POST /api/share/step-up (an Editor opening the folder to the whole team) */
  step_up?: string
}

export interface ShareResult extends ShareView {
  /** people who now read some AI draft's content without reading its sources (copies closed until confirmed) */
  widens: number
  invited: { email: string; status: 'invited' | 'member'; granted: boolean }[]
}

/** 409 when the change would widen AI-draft copies and was not confirmed */
export interface WideningRefusal {
  error: 'widening'; code: 'widening'; message: string
  /** copies that would widen */
  count: number
  /** people who would gain the content */
  people: number
  /** source folders the caller can read (by path) and how many they cannot */
  sources: string[]
  sources_hidden: number
  /** managers / admins: send again with confirm_widening */
  can_confirm: boolean
  /** Editors: send again with confirm_widening to ask a source manager (202 approval_pending) */
  needs_approval: boolean
}

/** 202: an Editor's widening change waits for a source manager's approval (the approval inbox, passkey step-up) */
export interface ApprovalPending { status: 'approval_pending'; approval_id: number; widens: number }

export interface SharedItem {
  path: string; kind: 'folder'; name: string; role: Role
  shared_by: { id: number; name: string } | null
  shared_at: number | null
}

export interface Directory {
  people: { id: number; name: string; display_name?: string; email?: string }[]
  groups: { id: number; name: string; size: number; everyone?: boolean }[]
}

export type StepUpOptions = { method: 'passkey'; options: unknown } | { method: 'totp' }

/** Error bodies: { error, message } (403 not_manager / editors_cannot_share / manager_only / admin_only, 400 …, 404 not_found). */
export interface ApiErrorBody { error: string; message: string }

type Fetcher = (method: string, path: string, body?: unknown) => Promise<{ status: number; data: any }>

/** A typed client over the app's own fetch helper (which adds the CSRF header and the session cookie). */
export function shareClient(call: Fetcher) {
  const q = (p: string) => encodeURIComponent(p)
  return {
    get: (path: string) => call('GET', `/api/share?path=${q(path)}`) as Promise<{ status: number; data: ShareView | InplaceView | ApiErrorBody }>,
    change: (c: ShareChange) => call('POST', '/api/share', c) as Promise<{ status: number; data: ShareResult | WideningRefusal | ApprovalPending | ApiErrorBody }>,
    stepUpOptions: (path: string, general: ShareChange['general']) => call('POST', '/api/share/step-up/options', { path, general }) as Promise<{ status: number; data: StepUpOptions | ApiErrorBody }>,
    stepUp: (path: string, general: ShareChange['general'], proof: { response?: unknown; code?: string }) =>
      call('POST', '/api/share/step-up', { path, general, ...proof }) as Promise<{ status: number; data: { assertion: string; expires_at: number } | ApiErrorBody }>,
    sharedWithMe: () => call('GET', '/api/shared-with-me') as Promise<{ status: number; data: { items: SharedItem[] } }>,
    directory: () => call('GET', '/api/directory') as Promise<{ status: number; data: Directory }>,
  }
}

// ---------- files (workstream A2: file-level sharing in managed storage; docs/SHARING-API.md "Files") ----------
/** One person or group on a file's share list. */
export interface FileShareEntry {
  subject: { type: 'person' | 'group'; id: number; name: string; email?: string | null; members?: number }
  /** a file has Viewers and Editors; 'manager' only appears on inherited entries (the folder's managers) */
  role: 'viewer' | 'editor' | 'manager'
  /** direct = shared on this file; inherited = from its folder (shown only to people who read the folder, and admins) */
  source: 'direct' | 'inherited'
  from_path?: string
  /** a direct entry whose subject also has this role from the folder */
  inherited_role?: 'viewer' | 'editor' | 'manager'
  granted_by?: { id: number; name: string } | null
  granted_at?: number
  editable: boolean
}

export interface FileShareView {
  /** 'inplace': NAS files are not shared one by one; 'personal': move it to a team folder to share it */
  mode: 'managed' | 'inplace' | 'personal'
  item: { path: string; kind: 'file'; name: string }
  my_role?: 'viewer' | 'editor' | 'manager' | 'admin' | null
  /** false: the caller cannot share this file (entries and general are empty) */
  can_manage?: boolean
  manage_as?: 'admin' | 'manager' | 'editor'
  can_grant_manager?: false
  can_invite?: boolean
  can_confirm_widening?: boolean
  can_ai_off?: false
  editors_can_share?: { effective: boolean; from_path: string | null }
  general?: {
    /** what "Anyone in Trina" gets on this file, and from where (the file's own path, or the folder it comes from) */
    effective: { role: 'viewer' | 'editor'; from_path: string } | null
    own: 'viewer' | 'editor' | null
    /** false: General access comes from the folder; a file cannot be narrower than its folder */
    can_restrict: boolean
    /** an Editor needs a step-up (POST /api/share/step-up with this file's path) to open the file to the whole team */
    editor_step_up: boolean
  } | null
  entries: FileShareEntry[]
  /** hidden: the caller reads only this file (a file-only Editor), so the folder's readers are not listed */
  inherited?: 'shown' | 'hidden'
  /** a file follows its folder's "No AI" (no per-file switch) */
  ai?: { no_ai: boolean; inherited_no_ai_from: string | null }
  /** the dialog says: "People you add will see the folder names <path_names_visible>" */
  path_names_visible?: string
  /** draft_copy: this file is a copy of an AI draft (sharing it wider may need a manager's confirm) */
  warnings?: { code: 'draft_copy' }[]
}

export interface FileShareChange {
  path: string
  add?: { subject: SubjectRef | { email: string }; role: 'viewer' | 'editor' }[]
  set?: { subject: SubjectRef; role: 'viewer' | 'editor' | 'remove' }[]
  general?: { mode: 'restricted' } | { mode: 'team'; role: 'viewer' | 'editor' }
  /** remove my own share on this file */
  leave?: true
  notify?: boolean
  confirm_widening?: boolean
  step_up?: string
}

export interface FileSharedItem {
  kind: 'file'; path: string; name: string; role: 'viewer' | 'editor'
  shared_by: { id: number; name: string } | null
  shared_at: number
  size: number; mtime: number
}

/** GET /api/recent: files this person opened or changed on the web or a mounted drive, newest first. */
export interface RecentItem { path: string; name: string; kind: 'file'; at: number; action: 'opened' | 'edited'; size: number; mtime: number }
