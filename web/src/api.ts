// The one API client: same origin, the session cookie (HttpOnly, the page never sees it), and the session's CSRF
// token on every change.
let csrf = ''
let onSignedOut: () => void = () => {}

export const setCsrf = (v: string) => { csrf = v }
export const whenSignedOut = (f: () => void) => { onSignedOut = f }

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (method !== 'GET') headers['x-csrf-token'] = csrf
  const res = await fetch('/api' + path, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) })
  const data = await res.json().catch(() => null)
  if (res.status === 401 && path !== '/login' && path !== '/session') onSignedOut()
  if (!res.ok) throw new ApiError(res.status, data?.error ?? 'error', data?.message ?? res.statusText)
  if (data && typeof data.csrf === 'string') csrf = data.csrf
  return data as T
}

export const get = <T = any>(path: string) => api<T>('GET', path)

// shapes the server returns (src/web/views.ts)
export interface Me { id: number; name: string; admin: boolean; email: string | null; unread_notices: number; approvals?: number; second_factor?: boolean }
export interface FolderSummary {
  id: number; name: string; vpath: string | null; registered: boolean; path?: string; personal_owner: number | null
  no_ai: boolean; quarantine: boolean; widened_pending: boolean; inherit_break: boolean; blocked: boolean
  nas_mode: 'all' | 'unknown' | 'chosen' | null; status: 'ok' | 'missing'; promote?: boolean; promote_here?: boolean
  mine: { ai: boolean; nas: boolean | null; manage: boolean }
  can: { edit_rules: boolean; no_ai_on: boolean; no_ai_off: boolean; edit_nas: boolean; admin: boolean }
}
export interface TableRow {
  type: 'group' | 'person'; id: number; name: string; members?: number
  ai: { direct: boolean; level: number; via?: 'direct' | 'inherited' | 'group' | null; inherited_from: string | null }
  nas: boolean | null | 'some'; warn: boolean
}
export interface FolderDetail {
  folder: FolderSummary; managers: { id: number; name: string; direct: boolean }[]
  subfolders: { id: number; vpath: string | null }[]; parent: { id: number; vpath: string | null } | null
  rows: TableRow[]; nas_history: { at: number; old_value: string | null; new_value: string | null }[]
}
export interface Person { id: number; name: string; admin: boolean; active: boolean; groups: number[]; email?: string | null; signed_up?: boolean }
export interface Group { id: number; name: string; members: number[] }
