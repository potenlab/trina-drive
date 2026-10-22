// What the web shows. Folder visibility and editing rights come from rights.ts; drafts from policy.ts + drafts.ts
// (R4, with the person's session judged as a token whose scope is everything); audit filtered per R7/R9.
import { verifyAudit } from '../audit'
import { canSeeDraft, liveDrafts, sourcesFor, type Draft } from '../drafts'
import { Access } from '../policy'
import { Rights, type Actor } from '../rights'
import type { FolderRow, TokenRow } from '../store'
import { decidableCount, promoteFolderIds, promoteOn } from '../promote'
import { accountOf } from './auth'
import { has2FA } from './mfa'
import { forbidden, notFound, type WebCtx } from './http'
import { visibleFolder, type Op } from './ops'
import { ensureWebSchema } from './schema'

const people = (w: WebCtx) => w.db.query<{ id: number; name: string; admin: number; active: number }, []>('SELECT id, name, admin, active FROM people ORDER BY name').all()
const groups = (w: WebCtx) => w.db.query<{ id: number; name: string }, []>('SELECT id, name FROM groups ORDER BY name').all()

export function me(w: WebCtx, a: Actor) {
  const p = w.db.query<{ id: number; name: string; admin: number }, [number]>('SELECT id, name, admin FROM people WHERE id = ?').get(a.personId)!
  const unread = w.db.query<{ n: number }, [number]>('SELECT count(*) AS n FROM notices WHERE person_id = ? AND read_at IS NULL').get(a.personId)!.n
  return { id: p.id, name: p.name, admin: !!p.admin, email: accountOf(w.db, a.personId)?.email ?? null, unread_notices: unread,
    approvals: decidableCount(w.db, a.personId), second_factor: has2FA(w.db, a.personId) }
}

/** Names are not secret inside the team; addresses and sign-in state are for admins (and yourself). */
export function peopleView(w: WebCtx, a: Actor) {
  ensureWebSchema(w.db)
  const ms = w.db.query<{ group_id: number; person_id: number }, []>('SELECT * FROM memberships').all()
  const acc = new Map(w.db.query<{ person_id: number; email: string; password_hash: string | null }, []>('SELECT person_id, email, password_hash FROM accounts').all().map((x) => [x.person_id, x]))
  return {
    people: people(w).map((p) => ({
      id: p.id, name: p.name, admin: !!p.admin, active: !!p.active,
      groups: ms.filter((m) => m.person_id === p.id).map((m) => m.group_id),
      ...(a.admin || p.id === a.personId ? { email: acc.get(p.id)?.email ?? null, signed_up: !!acc.get(p.id)?.password_hash } : {}),
    })),
    groups: groups(w).map((g) => ({ id: g.id, name: g.name, members: ms.filter((m) => m.group_id === g.id).map((m) => m.person_id) })),
  }
}

function folderStatus(w: WebCtx, f: FolderRow): 'ok' | 'missing' {
  return new Access(w.db, { personId: -1 }).nodeForFolder(f.id) ? 'ok' : 'missing'
}

function folderSummary(w: WebCtx, r: Rights, a: Actor, f: FolderRow) {
  const nas = f.registered ? (f.nas_readers === 'all' || f.nas_readers === 'unknown' ? f.nas_readers : f.nas_readers ? 'chosen' : 'unknown') : null
  return {
    id: f.id, name: f.registered ? f.mount_name : f.path.slice(f.path.lastIndexOf('/') + 1), vpath: r.vpath(f), registered: !!f.registered,
    ...(a.admin ? { path: f.path } : {}),
    personal_owner: r.personal(f)?.personal_owner ?? null,
    no_ai: !!f.no_ai, quarantine: !!f.quarantine, widened_pending: !!f.widened_pending, inherit_break: !!f.inherit_break || !!f.registered,
    blocked: r.flagged(f), nas_mode: nas, status: folderStatus(w, f),
    promote: promoteOn(promoteFolderIds(w.db), r.chain(f)), promote_here: promoteFolderIds(w.db).has(f.id),
    mine: { ai: r.aiLevel(a.personId, f) >= 1 && !r.flagged(f), nas: r.nasReader(a.personId, f), manage: r.manages(a.personId, f) },
    can: {
      edit_rules: r.canEditRules(a, f), no_ai_on: r.canSetNoAi(a, f, true), no_ai_off: r.canSetNoAi(a, f, false),
      edit_nas: r.canEditNas(a, f), admin: r.canAdmin(a),
    },
  }
}

/** Registered folders and known subfolders the caller can see. */
export function foldersView(w: WebCtx, a: Actor) {
  const r = new Rights(w.db)
  const out = [...r.folders.values()]
    .filter((f) => (f.registered || (r.rules.get(f.id)?.length ?? 0) > 0 || f.no_ai || f.quarantine || f.inherit_break || r.directManagers(f).length > 0) && r.canSee(a, f))
    .map((f) => folderSummary(w, r, a, f))
  return out.sort((x, y) => (x.vpath ?? '').localeCompare(y.vpath ?? ''))
}

/**
 * One folder's two-column table (4.1 "관리자 화면"): a row per group and per person, "NAS opens" and "AI reads".
 * The union is what R5 uses; "AI ✓ · NAS ✗" is flagged right in the row.
 */
export function folderView(op: Op, id: unknown) {
  const { w, actor: a } = op
  const r = new Rights(w.db)
  const f = visibleFolder(op, r, id)
  const nas = r.nas(f)
  const groupRows = groups(w).map((g) => {
    const direct = r.rules.get(f.id)?.find((x) => x.subject_type === 'group' && x.subject_id === g.id)?.level ?? 0
    const eff = r.subjectLevel('group', g.id, f)
    const members = w.db.query<{ person_id: number }, [number]>('SELECT person_id FROM memberships m JOIN people p ON p.id = m.person_id WHERE group_id = ? AND p.active = 1').all(g.id).map((m) => m.person_id)
    const nasMembers = nas === 'unknown' ? null : nas === 'all' ? members.length : members.filter((m) => nas.has(m)).length
    return {
      type: 'group' as const, id: g.id, name: g.name, members: members.length,
      ai: { direct: direct >= 1, level: eff.level, inherited_from: eff.from !== null && eff.from !== f.id ? r.vpath(r.folders.get(eff.from)!) : null },
      nas: nasMembers === null ? null : nasMembers === members.length ? true : nasMembers === 0 ? false : 'some' as const,
      warn: eff.level >= 1 && nasMembers !== null && nasMembers < members.length,
    }
  })
  const personRows = people(w).filter((p) => p.active).map((p) => {
    const direct = r.rules.get(f.id)?.find((x) => x.subject_type === 'person' && x.subject_id === p.id)?.level ?? 0
    const own = r.subjectLevel('person', p.id, f)
    const level = r.aiLevel(p.id, f)
    const via = level < 1 ? null : own.level >= 1 ? (own.from === f.id ? 'direct' : 'inherited') : 'group'
    const nasR = r.nasReader(p.id, f)
    return {
      type: 'person' as const, id: p.id, name: p.name,
      ai: { direct: direct >= 1, level, via, inherited_from: via === 'inherited' && own.from !== null ? r.vpath(r.folders.get(own.from)!) : null },
      nas: nasR, warn: level >= 1 && nasR === false,
    }
  })
  const showHistory = a.admin || r.manages(a.personId, f) || r.personal(f)?.personal_owner === a.personId
  return {
    folder: folderSummary(w, r, a, f),
    managers: r.managersOf(f).map((id) => ({ id, name: w.db.query<{ name: string }, [number]>('SELECT name FROM people WHERE id = ?').get(id)?.name ?? '?', direct: r.directManagers(f).includes(id) })),
    subfolders: r.below(f).filter((s) => r.canSee(a, s)).map((s) => ({ id: s.id, vpath: r.vpath(s) })),
    parent: (() => { const c = r.chain(f); const p = c[c.length - 2]; return p && r.canSee(a, p) ? { id: p.id, vpath: r.vpath(p) } : null })(),
    rows: [...groupRows, ...personRows],
    nas_history: showHistory ? w.db.query<{ at: number; old_value: string | null; new_value: string | null }, [number]>(
      `SELECT at, old_value, new_value FROM folder_history WHERE folder_id = ? AND field = 'nas_readers' ORDER BY id DESC LIMIT 20`).all(f.id) : [],
  }
}

// ---------- drafts (R4: the session is a token with full scope) ----------
function sessionToken(a: Actor): TokenRow {
  return { id: -1, person_id: a.personId, name: 'web', hint: '', scope: null, read_only: 1, created_at: 0, expires_at: null, revoked_at: null, last_used_at: null }
}
function visibleDrafts(w: WebCtx, a: Actor): { shown: Draft[]; locked: Draft[]; access: Access } {
  const access = new Access(w.db, { personId: a.personId })
  const t = sessionToken(a)
  const all = liveDrafts(w.db, a.personId)
  return { shown: all.filter((d) => canSeeDraft(access, t, d)), locked: all.filter((d) => !canSeeDraft(access, t, d)), access }
}

export function draftsView(w: WebCtx, a: Actor) {
  const { shown, locked, access } = visibleDrafts(w, a)
  return {
    drafts: shown.map((d) => {
      // 원칙 2: only folders this person can read now are named (R4 lists no other draft today; this keeps it so)
      const src = sourcesFor(access, d.src)
      return {
        id: d.id, path: d.path, token: d.token_name, version: d.version, size: d.size, updated_at: d.updated_at, sha256: d.sha256,
        sources: src.shown, hidden_sources: src.hidden,
      }
    }),
    // R4: locked drafts appear on your own web only as a count and dates
    locked: { count: locked.length, dates: locked.map((d) => d.updated_at).sort((x, y) => y - x) },
  }
}

export function draftForDownload(w: WebCtx, a: Actor, id: unknown): Draft {
  const d = visibleDrafts(w, a).shown.find((x) => x.id === Number(id))
  if (!d) throw notFound()
  return d
}

// ---------- tokens ----------
export function tokensView(w: WebCtx, a: Actor) {
  const r = new Rights(w.db)
  const rows = w.db.query<TokenRow & { last_client: string | null; client_name: string | null; client_domain: string | null; client_kind: string | null }, [number]>(
    `SELECT t.*, c.name AS client_name, c.domain AS client_domain, c.kind AS client_kind FROM tokens t LEFT JOIN oauth_clients c ON c.client_id = t.client_id
     WHERE t.person_id = ? ORDER BY t.created_at DESC`).all(a.personId)
  const t = Date.now()
  return rows.map((x) => ({
    id: x.id, name: x.name, hint: x.hint, read_only: !!x.read_only, created_at: x.created_at, expires_at: x.expires_at,
    // 'oauth': a connection approved on the consent page (claude.ai, ChatGPT …); revoking it cuts its access and refresh tokens
    kind: x.kind ?? 'pat', client: x.kind === 'oauth' ? { name: x.client_name, domain: x.client_domain, verified: x.client_kind === 'cimd' } : null,
    revoked_at: x.revoked_at, last_used_at: x.last_used_at, last_client: x.last_client,
    status: x.revoked_at != null ? 'revoked' : x.expires_at != null && x.expires_at <= t ? 'expired' : 'active',
    scope: x.scope ? (JSON.parse(x.scope) as number[]).map((id) => { const f = r.folders.get(id); return { id, vpath: f ? r.vpath(f) : null } }) : null,
  }))
}

// ---------- audit (R7: managers see their folders; R9: the admin sees who, which connection, how many) ----------
interface AuditRow { id: number; at: number; person_id: number | null; token_id: number | null; tool: string; command: string; files: string; outcome: string }

const auditNames = (w: WebCtx) => ({
  person: new Map(w.db.query<{ id: number; name: string }, []>('SELECT id, name FROM people').all().map((p) => [p.id, p.name])),
  token: new Map(w.db.query<{ id: number; name: string }, []>('SELECT id, name FROM tokens').all().map((t) => [t.id, t.name])),
})

export function auditView(w: WebCtx, a: Actor, view: string, before?: number) {
  const n = auditNames(w)
  const limit = 200
  const cursor = before && Number.isFinite(before) ? before : Number.MAX_SAFE_INTEGER
  if (view === 'mine') {
    const rows = w.db.query<AuditRow, [number, number, number]>('SELECT * FROM audit WHERE person_id = ? AND id < ? ORDER BY id DESC LIMIT ?').all(a.personId, cursor, limit)
    return { entries: rows.map((x) => ({ id: x.id, at: x.at, connection: x.token_id != null ? n.token.get(x.token_id) ?? '?' : 'web', tool: x.tool, command: x.command, files: JSON.parse(x.files) as string[], outcome: x.outcome })) }
  }
  if (view === 'folders') {
    const r = new Rights(w.db)
    const mine = [...r.folders.values()].filter((f) => r.manages(a.personId, f) && r.directManagers(f).includes(a.personId)).map((f) => r.vpath(f)).filter((v): v is string => !!v)
    if (!mine.length) return { entries: [], folders: [] }
    const inMine = (file: string) => { const p = file.startsWith('/.raw/') ? file.slice(5) : file; return mine.some((m) => p === m || p.startsWith(m + '/')) }
    const out: unknown[] = []
    let scanned = 0
    for (const x of w.db.query<AuditRow, [number]>('SELECT * FROM audit WHERE id < ? ORDER BY id DESC').iterate(cursor)) {
      if (++scanned > 20_000 || out.length >= limit) break
      const files = (JSON.parse(x.files) as string[]).filter(inMine)
      if (!files.length) continue
      const own = x.person_id === a.personId
      // other people's command lines may carry text from folders you do not manage: only the files in yours are shown
      out.push({ id: x.id, at: x.at, person: x.person_id != null ? n.person.get(x.person_id) ?? '?' : null, connection: x.token_id != null ? n.token.get(x.token_id) ?? '?' : 'web',
        tool: x.tool, command: own ? x.command : null, files, outcome: x.outcome })
    }
    return { entries: out, folders: mine }
  }
  if (view === 'summary') {
    if (!a.admin) throw forbidden('only an admin sees the summary')
    const rows = w.db.query<{ person_id: number | null; token_id: number | null; n: number; last_at: number }, []>(
      'SELECT person_id, token_id, count(*) AS n, max(at) AS last_at FROM audit GROUP BY person_id, token_id ORDER BY last_at DESC').all()
    const v = verifyAudit(w.db)
    return {
      rows: rows.map((x) => ({ person: x.person_id != null ? n.person.get(x.person_id) ?? '?' : null, connection: x.token_id != null ? n.token.get(x.token_id) ?? '?' : 'web', count: x.n, last_at: x.last_at })),
      chain: { ok: v.ok, rows: v.rows, broken_at: v.brokenAt ?? null },
    }
  }
  throw notFound()
}
