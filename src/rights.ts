// Who may see and change what on the admin side (plan 4.1 R5, R7, R9). The REST API asks only this module; reads of
// files and drafts stay in policy.ts (R0's effective rule is policy.effectiveLevel, used here unchanged).
//
// A snapshot of folders, rules, grants and memberships is taken once per request (new Rights(db)).
import type { DB } from './db'
import { effectiveLevel } from './policy'
import type { FolderRow, RuleRow } from './store'

export interface Actor { personId: number; admin: boolean }
export type NasSet = 'all' | 'unknown' | Set<number>

const under = (p: string, top: string) => p === top || p.startsWith(top + '/')

export class Rights {
  readonly folders = new Map<number, FolderRow>()
  readonly rules = new Map<number, RuleRow[]>()
  private readonly grants = new Map<number, Set<number>>()
  private readonly memberOf = new Map<number, Set<number>>()
  private readonly activePeople: number[]

  constructor(readonly db: DB) {
    for (const f of db.query<FolderRow, []>('SELECT * FROM folders').all()) this.folders.set(f.id, f)
    for (const r of db.query<RuleRow, []>('SELECT * FROM rules').all()) this.rules.set(r.folder_id, [...(this.rules.get(r.folder_id) ?? []), r])
    for (const g of db.query<{ folder_id: number; person_id: number }, []>('SELECT * FROM manage_grants').all()) {
      if (!this.grants.has(g.folder_id)) this.grants.set(g.folder_id, new Set())
      this.grants.get(g.folder_id)!.add(g.person_id)
    }
    for (const m of db.query<{ group_id: number; person_id: number }, []>('SELECT * FROM memberships').all()) {
      if (!this.memberOf.has(m.person_id)) this.memberOf.set(m.person_id, new Set())
      this.memberOf.get(m.person_id)!.add(m.group_id)
    }
    this.activePeople = db.query<{ id: number }, []>('SELECT id FROM people WHERE active = 1').all().map((p) => p.id)
  }

  groupsOf(personId: number) { return this.memberOf.get(personId) ?? new Set<number>() }

  // ---------- the tree (by stored path; the agent side walks the disk, this side only decides who may edit) ----------
  /** The top registered folder (a mount) that holds f, if f is inside one. */
  top(f: FolderRow): FolderRow | undefined {
    return [...this.folders.values()].filter((r) => r.registered && under(f.path, r.path)).sort((a, b) => a.path.length - b.path.length)[0]
  }
  /** Known folder rows from the mount down to f (inclusive), the same rows policy's walk collects. */
  chain(f: FolderRow): FolderRow[] {
    const top = this.top(f)
    if (!top) return []
    return [...this.folders.values()].filter((r) => under(r.path, top.path) && under(f.path, r.path)).sort((a, b) => a.path.length - b.path.length)
  }
  /** The nearest registered folder at or above f. */
  registered(f: FolderRow): FolderRow | undefined { return [...this.chain(f)].reverse().find((r) => r.registered) }
  /** The personal folder at or above f, if any. */
  personal(f: FolderRow): FolderRow | undefined { return this.chain(f).find((r) => r.personal_owner != null) }
  /** Virtual path as agents see it (/<mount name>/<rest>). */
  vpath(f: FolderRow): string | null {
    const top = this.top(f)
    if (!top) return null
    return ('/' + top.mount_name + f.path.slice(top.path.length)).normalize('NFC')
  }
  /** Known folder rows strictly below f inside the same mount. */
  below(f: FolderRow): FolderRow[] { return [...this.folders.values()].filter((r) => r.id !== f.id && r.path.startsWith(f.path + '/') && !!this.top(r)) }

  // ---------- R0 / R5 facts ----------
  aiLevel(personId: number, f: FolderRow) { return effectiveLevel(this.chain(f), personId, this.groupsOf(personId), this.rules) }
  /** The level one subject (a person alone, or a group) gets on f from rules up to the nearest break. */
  subjectLevel(type: 'person' | 'group', id: number, f: FolderRow): { level: number; from: number | null } {
    const rows = this.chain(f)
    let best = 0, from: number | null = null
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i]!
      if (r.personal_owner != null) return type === 'person' && r.personal_owner === id ? { level: 2, from: r.id } : { level: 0, from: null }
      for (const rule of this.rules.get(r.id) ?? []) if (rule.subject_type === type && rule.subject_id === id && rule.level > best) { best = rule.level; from = r.id }
      if (r.registered || r.inherit_break) break
    }
    return { level: best, from }
  }
  flagged(f: FolderRow) { return this.chain(f).some((r) => r.no_ai || r.quarantine || r.widened_pending) }
  nas(f: FolderRow): NasSet {
    const reg = this.registered(f)
    if (!reg || reg.nas_readers == null || reg.nas_readers === 'unknown') return 'unknown'
    if (reg.nas_readers === 'all') return 'all'
    const active = new Set(this.activePeople)
    return new Set((JSON.parse(reg.nas_readers) as number[]).filter((id) => active.has(id)))
  }
  /** true/false, or null when the NAS readers are not known */
  nasReader(personId: number, f: FolderRow): boolean | null {
    const n = this.nas(f)
    return n === 'unknown' ? null : n === 'all' ? true : n.has(personId)
  }

  // ---------- R7 manage ----------
  /** manage is given by the admin on a folder and holds below it; never inside a personal folder. */
  manages(personId: number, f: FolderRow): boolean {
    const chain = this.chain(f)
    if (chain.some((r) => r.personal_owner != null)) return false
    return chain.some((r) => this.grants.get(r.id)?.has(personId))
  }
  /** Everyone holding manage on f (directly or from above). */
  managersOf(f: FolderRow): number[] {
    const out = new Set<number>()
    if (this.personal(f)) return []
    for (const r of this.chain(f)) for (const p of this.grants.get(r.id) ?? []) out.add(p)
    return [...out]
  }
  directManagers(f: FolderRow): number[] { return [...this.grants.get(f.id) ?? []] }

  // ---------- decisions ----------
  /**
   * Can the actor see this folder at all on the web (anything else is 404)? Admins: every folder. Others: folders they
   * read by rule, are a NAS reader or the owner of, or manage (plan 5.1 "누가 볼 수 있나").
   */
  canSee(a: Actor, f: FolderRow): boolean {
    if (!this.top(f)) return false
    if (a.admin) return true
    const own = this.personal(f)
    if (own) return own.personal_owner === a.personId
    return this.manages(a.personId, f) || this.aiLevel(a.personId, f) >= 1 || this.nasReader(a.personId, f) === true
  }
  /** Change AI readers (rules) and "start fresh here" on f: admin or manage (R7). Never inside a personal folder. */
  canEditRules(a: Actor, f: FolderRow) { return !this.personal(f) && (a.admin || this.manages(a.personId, f)) }
  /** no-AI on: admin, manage, or the owner of a personal folder. off: admin, or that owner (R7: manage cannot). */
  canSetNoAi(a: Actor, f: FolderRow, on: boolean) {
    const own = this.personal(f)
    if (own && own.personal_owner === a.personId) return true
    return a.admin || (on && this.manages(a.personId, f))
  }
  /** NAS readers: the admin only; for a personal folder, its owner only (R5). Registered folders only. */
  canEditNas(a: Actor, f: FolderRow) {
    if (!f.registered) return false
    if (f.personal_owner != null) return f.personal_owner === a.personId
    return a.admin
  }
  /** Register / unregister, quarantine off, grant manage, change a personal folder's owner, people and groups: admin (R9). */
  canAdmin(a: Actor) { return a.admin }
}
