// What every web change module shares (ops.ts: folders and tokens, people-ops.ts: people and groups, src/share/rules.ts:
// rules, manage and the Everyone group): the caller (Op), the audit row, notices, and the lookups that turn an id into
// a row or a 404. Moved here unchanged from ops.ts so those modules can be owned and changed separately.
import { appendAudit } from '../audit'
import { nfc } from '../names'
import type { Actor, Rights } from '../rights'
import type { FolderRow } from '../store'
import { bad, forbidden, notFound, type WebCtx } from './http'
import { notify, type NoticeKind } from './notices'

export interface Op { w: WebCtx; actor: Actor; base: string }

export const PERSON_NAME = /^[^\s/\\@#][^/\\\p{Cc}]{0,63}$/u
export const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/

export const now = () => Date.now()
export const isUnique = (e: unknown) => /UNIQUE/.test(String((e as Error)?.message)) || (e as { code?: string })?.code === 'SQLITE_CONSTRAINT_UNIQUE'

export function record(op: Op, command: string, files: string[] = []) {
  appendAudit(op.w.db, { personId: op.actor.personId, tokenId: null, tool: 'web', command, files, outcome: 'ok' })
}
export const tell = (op: Op, ids: Iterable<number>, kind: NoticeKind, link: string, opts?: Parameters<typeof notify>[4]) =>
  notify({ db: op.w.db, mailer: op.w.mailer, baseUrl: op.base }, ids, kind, link, opts)

export function requireAdmin(op: Op) { if (!op.actor.admin) throw forbidden('only an admin can do this') }
export function personRow(op: Op, id: unknown) {
  const p = op.w.db.query<{ id: number; name: string; admin: number; active: number }, [number]>('SELECT id, name, admin, active FROM people WHERE id = ?').get(Number(id))
  if (!p) throw notFound()
  return p
}
export function groupRow(op: Op, id: unknown) {
  const g = op.w.db.query<{ id: number; name: string }, [number]>('SELECT id, name FROM groups WHERE id = ?').get(Number(id))
  if (!g) throw notFound()
  return g
}
export function checkName(name: unknown): string {
  if (typeof name !== 'string' || !PERSON_NAME.test(nfc(name.trim()))) throw bad('bad_name', 'names are 1–64 characters, without / \\ and not starting with @ or #')
  return nfc(name.trim())
}
export function checkEmail(email: unknown): string {
  if (typeof email !== 'string' || email.length > 254 || !EMAIL.test(email.trim())) throw bad('bad_email', 'a valid mail address is required')
  return email.trim()
}
/** A folder the caller can see (else 404). */
export function visibleFolder(op: Op, r: Rights, id: unknown): FolderRow {
  const f = r.folders.get(Number(id))
  if (!f || !r.canSee(op.actor, f)) throw notFound()
  return f
}
export const folderLink = (f: FolderRow) => `/#/folders/${f.id}`
export const label = (r: Rights, f: FolderRow) => r.vpath(f) ?? f.path

export function activeAdmins(op: Op) { return op.w.db.query<{ id: number }, []>('SELECT id FROM people WHERE admin = 1 AND active = 1').all().map((p) => p.id) }
