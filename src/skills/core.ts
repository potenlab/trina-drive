// Team skills (plan 4.2, finding 14; design: research/trina-drive/team-skills-research.md), the deciding part.
//
// A skill library is a folder an Admin designated (never a Manager: finding 14). Each direct subfolder <name>/ holding
// a SKILL.md is a skill; its files are the skill's resources. The server reads a library through the same walk as
// everything else (policy.ts: identities checked, links closed, system names hidden) and keeps every version it sees
// as an immutable snapshot: the files' bytes content-addressed under <data>/skills/, a manifest, and a digest of the
// manifest. Agents only ever get an *approved* snapshot (catalog, body, files, SEP-2640 digests alike); an edit on
// disk becomes a 'pending' version that serves nobody until someone other than its editors approves it, and until then
// the previously approved snapshot keeps serving (none, for a new skill).
//
// Who sees a skill: exactly who could read its folder (policy.ts Access.canRead for that token: rules ∩ token scope,
// "No AI" / quarantine / widened-pending closed). A skill the caller cannot read gives the same answer as one that does
// not exist, everywhere (hidden = nonexistent).
import fs from 'node:fs'
import path from 'node:path'
import type { DB } from '../db'
import { Blobs } from '../drafts'
import { detectLayout } from '../layout'
import { fileRowOf } from '../managed/core'
import { nfc } from '../names'
import { Access, Closed, type DirEntry, type FileEntry, type Node } from '../policy'
import { Rights } from '../rights'
import { ensureFolder, sha256, type FolderRow } from '../store'
import { checkSkillMd, FrontmatterError, LIMITS, type Json } from './frontmatter'
import { SKILLS_SCHEMA } from './schema'

export class SkillError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message) }
}

const ensured = new WeakSet<DB>()
/** The tables (normally made by the 'core' migration in openDb; also here for databases opened another way). */
export function ensureSkillsSchema(db: DB) {
  if (ensured.has(db)) return
  db.exec(SKILLS_SCHEMA)
  ensured.add(db)
}

export const skillBlobs = (dataDir: string) => new Blobs(path.join(detectLayout(dataDir).dataDir, 'skills'))

// ---------- libraries ----------
export interface Library { folder_id: number; slug: string; by_person: number | null; at: number }
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function libraries(db: DB): Library[] {
  ensureSkillsSchema(db)
  return db.query<Library, []>('SELECT * FROM skill_libraries ORDER BY slug').all()
}
export const libraryOf = (db: DB, folderId: number) => { ensureSkillsSchema(db); return db.query<Library, [number]>('SELECT * FROM skill_libraries WHERE folder_id = ?').get(folderId) }
/** For other modules (sharing): is this folder a skill library? (its "Editors can share" stays off) */
export const isSkillLibrary = (db: DB, folderId: number) => !!libraryOf(db, folderId)

/** A slug from a folder name when it is plain ASCII (else the caller must give one). */
export function slugFrom(name: string): string | null {
  const s = nfc(name).toLowerCase().replace(/[\s_.]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '')
  return s && s.length <= 63 && SLUG_RE.test(s) ? s : null
}

/**
 * Make `folder` a skill library (Admin only: the caller checks). Not inside a personal folder. Where sharing knows
 * "Editors can change permissions and share" (folders.editors_can_share), it is turned off for the library: whoever
 * can widen a library's readers decides whose AI gets its instructions.
 */
export function designate(db: DB, folder: FolderRow, slugIn: unknown, byPerson: number | null, now = Date.now()): Library {
  ensureSkillsSchema(db)
  const r = new Rights(db)
  if (!r.top(folder)) throw new SkillError('not_registered', 'the folder is not inside a registered team folder')
  if (r.personal(folder)) throw new SkillError('personal', 'a personal folder cannot be a skill library')
  const name = path.basename(r.vpath(folder) ?? folder.path)
  const slug = slugIn === undefined || slugIn === null || slugIn === '' ? slugFrom(name) : typeof slugIn === 'string' ? slugIn.trim() : null
  if (!slug || slug.length > 63 || !SLUG_RE.test(slug)) throw new SkillError('bad_slug', `give the library a short name for skill names (lowercase letters, digits, hyphens), e.g. "${slugFrom(name) ?? 'sales'}"`)
  const had = libraryOf(db, folder.id)
  const clash = db.query<{ folder_id: number }, [string]>('SELECT folder_id FROM skill_libraries WHERE slug = ?').get(slug)
  if (clash && clash.folder_id !== folder.id) throw new SkillError('slug_taken', `another skill library is already called "${slug}"`, 409)
  if (had) db.query('UPDATE skill_libraries SET slug = ? WHERE folder_id = ?').run(slug, folder.id)
  else db.query('INSERT INTO skill_libraries (folder_id, slug, by_person, at) VALUES (?, ?, ?, ?)').run(folder.id, slug, byPerson, now)
  if (db.query<{ name: string }, []>('PRAGMA table_info(folders)').all().some((c) => c.name === 'editors_can_share'))
    db.query('UPDATE folders SET editors_can_share = 0 WHERE id = ?').run(folder.id)
  return libraryOf(db, folder.id)!
}

export function undesignate(db: DB, folderId: number): boolean {
  ensureSkillsSchema(db)
  return db.query('DELETE FROM skill_libraries WHERE folder_id = ?').run(folderId).changes === 1
}

/** The folder row of a library given as a server path (CLI) */
export function folderRowAt(db: DB, real: string): FolderRow {
  let st: fs.BigIntStats
  try { st = fs.lstatSync(real, { bigint: true }) } catch { throw new SkillError('no_folder', `no folder at ${real}`, 404) }
  if (!st.isDirectory() || st.isSymbolicLink()) throw new SkillError('no_folder', `not a folder: ${real}`, 404)
  return db.query<FolderRow, [number]>('SELECT * FROM folders WHERE id = ?').get(ensureFolder(db, real, st.dev, st.ino, st.birthtimeNs))!
}

// ---------- reading a skill folder ----------
export interface ManifestEntry { path: string; sha256: string; size: number }
export interface ReadSkill { name: string; files: (ManifestEntry & { entry: FileEntry })[]; frontmatter: Record<string, Json>; description: string; warnings: string[] }

/** file identity + size + mtime + ctime → sha256 of bytes already kept (a later scan does not read unchanged files again) */
const hashCache = new Map<string, string>()
const cacheKey = (e: FileEntry) => `${e.dev}:${e.ino}:${e.size}:${e.mtimeNs}:${e.ctimeNs}`

/** Names in a folder of the walk (Access.child re-checks each against its own listing). */
function namesIn(node: Node): string[] {
  try { return fs.readdirSync(node.real).sort() } catch { return [] }
}

/**
 * Every file of the skill folder at `dir` (relative paths, sorted), checked: SKILL.md with valid frontmatter whose name
 * is the folder's, sizes and counts within LIMITS. Hidden (dot) names and anything the walk closes are left out. Each
 * file's bytes are kept in `blobs` (content-addressed) as they are read, so a version can be approved byte for byte.
 */
export function readSkillDir(access: Access, dir: Node, name: string, blobs: Blobs): ReadSkill {
  const files: ReadSkill['files'] = []
  let total = 0
  let mdBytes: Uint8Array | null = null
  const walk = (node: Node, prefix: string, depth: number) => {
    if (depth > LIMITS.depth) throw new FrontmatterError(`folders nest deeper than ${LIMITS.depth} levels`)
    for (const n of namesIn(node)) {
      if (n.startsWith('.')) continue
      const e = access.child(node, n)
      if (!e) continue
      const rel = prefix + nfc(n)
      if (e.kind === 'dir') { walk(e.node, rel + '/', depth + 1); continue }
      if (files.length >= LIMITS.files) throw new FrontmatterError(`more than ${LIMITS.files} files`)
      const max = rel === 'SKILL.md' ? LIMITS.skillMdBytes : LIMITS.fileBytes
      if (e.size > max) throw new FrontmatterError(`${rel} is larger than ${Math.round(max / 1024)} KB`)
      const key = cacheKey(e)
      let sha = hashCache.get(key)
      let size = e.size
      if (!sha || !fs.existsSync(blobs.path(sha)) || rel === 'SKILL.md') {
        let bytes: Uint8Array
        try { bytes = access.readBytes(e, max) } catch (err) {
          if (err instanceof Closed) throw new FrontmatterError(`${rel} could not be read safely (it changed while reading, or it is a link)`)
          throw err
        }
        sha = blobs.put(bytes)
        size = bytes.length
        hashCache.set(key, sha)
        if (rel === 'SKILL.md') mdBytes = bytes
      }
      total += size
      if (total > LIMITS.totalBytes) throw new FrontmatterError(`the skill's files add up to more than ${LIMITS.totalBytes / 1024 / 1024} MB`)
      files.push({ path: rel, sha256: sha, size, entry: e })
    }
  }
  walk(dir, '', 0)
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  if (!mdBytes || !files.some((f) => f.path === 'SKILL.md')) throw new FrontmatterError('no SKILL.md')
  const p = checkSkillMd(mdBytes, name)
  return { name, files, frontmatter: p.frontmatter, description: p.description, warnings: p.warnings }
}

export const manifestText = (m: ManifestEntry[]) => JSON.stringify(m.map((f) => ({ path: f.path, sha256: f.sha256, size: f.size })))
export const digestOf = (m: ManifestEntry[]) => sha256(manifestText(m))

// ---------- versions ----------
export interface VersionRow {
  id: number; library_id: number; name: string; digest: string; manifest: string; frontmatter: string; description: string
  editors: string; warnings: string | null; status: 'pending' | 'approved' | 'rejected' | 'superseded'
  proposed_at: number; decided_by: number | null; decided_at: number | null; reason: string | null
}
export const versionById = (db: DB, id: number) => { ensureSkillsSchema(db); return db.query<VersionRow, [number]>('SELECT * FROM skill_versions WHERE id = ?').get(id) }
export const approvedOf = (db: DB, lib: number, name: string) =>
  db.query<VersionRow, [number, string]>("SELECT * FROM skill_versions WHERE library_id = ? AND name = ? AND status = 'approved' ORDER BY decided_at DESC, id DESC LIMIT 1").get(lib, name)
export const pendingOf = (db: DB, lib: number, name: string) =>
  db.query<VersionRow, [number, string]>("SELECT * FROM skill_versions WHERE library_id = ? AND name = ? AND status = 'pending' ORDER BY id DESC LIMIT 1").get(lib, name)
export const manifestOf = (v: VersionRow) => JSON.parse(v.manifest) as ManifestEntry[]
export const editorsOf = (v: VersionRow) => JSON.parse(v.editors) as (number | null)[]

/**
 * Who wrote a file the server can tell: managed storage keeps the last writer of every file; a file a promote put on
 * a NAS share is in `promotions`. Anything else (written over SMB, put there by hand) is unknown: null.
 */
function writerOf(db: DB, f: FileEntry): number | null {
  const row = fileRowOf(db, { dev: f.dev, ino: f.ino, size: f.size, mtimeNs: f.mtimeNs })
  if (row) return row.updated_by ?? row.created_by ?? null
  const hasPromotions = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'promotions'").get()
  if (hasPromotions) {
    const p = db.query<{ by_person: number; token_id: number | null }, [string, string]>('SELECT by_person, token_id FROM promotions WHERE dev = ? AND ino = ? ORDER BY id DESC LIMIT 1').get(String(f.dev), String(f.ino))
    if (p) return p.by_person
  }
  return null
}

/** Who removed a file in managed storage (its trash row), else unknown. */
function removerOf(db: DB, vpath: string): number | null {
  return db.query<{ deleted_by: number }, [string]>('SELECT deleted_by FROM mtrash WHERE orig_vpath = ? ORDER BY deleted_at DESC LIMIT 1').get(vpath)?.deleted_by ?? null
}

export interface ScanResult { libraries: number; skills: number; proposed: { versionId: number; libraryId: number; name: string }[]; problems: { libraryId: number; name: string; error: string }[] }

/**
 * Look at every library on disk and record what changed: a skill whose files differ from every version known becomes
 * a new 'pending' version (its bytes kept, its editors noted), older pending ones of that skill are superseded. Files on
 * disk going back to the approved version clears the pending one. Nothing here changes what agents get.
 */
export function scan(db: DB, dataDir: string, now = Date.now()): ScanResult {
  ensureSkillsSchema(db)
  const server = new Access(db, { personId: -1 })
  const blobs = skillBlobs(dataDir)
  const out: ScanResult = { libraries: 0, skills: 0, proposed: [], problems: [] }
  for (const lib of libraries(db)) {
    const node = server.nodeForFolder(lib.folder_id)
    if (!node) continue
    out.libraries++
    const seen = new Set<string>()
    for (const n of namesIn(node)) {
      if (n.startsWith('.')) continue
      const e = server.child(node, n)
      if (!e || e.kind !== 'dir') continue
      const md = namesIn(e.node).includes('SKILL.md') ? server.child(e.node, 'SKILL.md') : null
      if (!md || md.kind !== 'file') continue
      const name = nfc(n)
      seen.add(name)
      out.skills++
      let read: ReadSkill
      try { read = readSkillDir(server, e.node, name, blobs) } catch (err) {
        if (!(err instanceof FrontmatterError)) throw err
        db.query('INSERT INTO skill_problems (library_id, name, error, at) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET error = excluded.error, at = excluded.at')
          .run(lib.folder_id, name, err.message, now)
        out.problems.push({ libraryId: lib.folder_id, name, error: err.message })
        continue
      }
      db.query('DELETE FROM skill_problems WHERE library_id = ? AND name = ?').run(lib.folder_id, name)
      const manifest: ManifestEntry[] = read.files.map((f) => ({ path: f.path, sha256: f.sha256, size: f.size }))
      const digest = digestOf(manifest)
      const known = db.query<VersionRow, [number, string, string]>('SELECT * FROM skill_versions WHERE library_id = ? AND name = ? AND digest = ?').get(lib.folder_id, name, digest)
      const supersedePending = (except?: number) => db.query("UPDATE skill_versions SET status = 'superseded' WHERE library_id = ? AND name = ? AND status = 'pending' AND id != ?").run(lib.folder_id, name, except ?? -1)
      if (known && (known.status === 'approved' || known.status === 'pending' || known.status === 'rejected')) {
        if (known.status !== 'pending') supersedePending()
        continue
      }
      // a new version (or an old one seen again): keep the bytes, note who changed what since the approved version
      const approved = approvedOf(db, lib.folder_id, name)
      const before = new Map((approved ? manifestOf(approved) : []).map((f) => [f.path, f.sha256]))
      const editors = new Set<number | null>()
      for (const f of read.files) if (before.get(f.path) !== f.sha256) editors.add(writerOf(db, f.entry))
      for (const p of before.keys()) if (!manifest.some((f) => f.path === p)) editors.add(removerOf(db, `${e.node.vpath}/${p}`))
      const row = [manifestText(manifest), JSON.stringify(read.frontmatter), read.description, JSON.stringify([...editors]), read.warnings.length ? JSON.stringify(read.warnings) : null] as const
      db.transaction(() => {
        let id: number
        if (known) {
          db.query("UPDATE skill_versions SET status = 'pending', editors = ?, warnings = ?, proposed_at = ?, decided_by = NULL, decided_at = NULL, reason = NULL WHERE id = ?").run(row[3], row[4], now, known.id)
          id = known.id
        } else {
          id = Number(db.query("INSERT INTO skill_versions (library_id, name, digest, manifest, frontmatter, description, editors, warnings, status, proposed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)")
            .run(lib.folder_id, name, digest, ...row, now).lastInsertRowid)
        }
        supersedePending(id)
        out.proposed.push({ versionId: id, libraryId: lib.folder_id, name })
      })()
    }
    // a skill folder that is gone (or no longer a skill) stops being a problem; its versions stay (history), unserved
    for (const p of db.query<{ name: string }, [number]>('SELECT name FROM skill_problems WHERE library_id = ?').all(lib.folder_id))
      if (!seen.has(p.name)) db.query('DELETE FROM skill_problems WHERE library_id = ? AND name = ?').run(lib.folder_id, p.name)
  }
  return out
}

// ---------- what a principal can see ----------
export interface Skill {
  qname: string; slug: string; name: string; libraryId: number
  /** the approved version served */
  version: VersionRow
  description: string; frontmatter: Record<string, Json>; manifest: ManifestEntry[]; digest: string
  /** the skill folder as this principal sees it (/<team folder>/…/<name>) */
  vpath: string
  node: Node
}

/** The skill folder on disk, by the walk (links closed, identities checked), whoever may read it. */
function skillDir(access: Access, libraryId: number, name: string): Node | null {
  const lib = access.nodeForFolder(libraryId)
  if (!lib) return null
  const real = namesIn(lib).filter((n) => nfc(n) === name)
  if (real.length !== 1) return null
  const e = access.child(lib, real[0]!)
  return e && e.kind === 'dir' ? (e as DirEntry).node : null
}

/** The skill folder node, if this principal may read it right now (else null: hidden = nonexistent). */
export function skillNode(access: Access, libraryId: number, name: string): Node | null {
  const n = skillDir(access, libraryId, name)
  return n && access.canRead(n) ? n : null
}

/** Is the skill folder still there (for the web's status; says nothing about who may read it)? */
export const skillPresent = (db: DB, libraryId: number, name: string) => !!skillDir(new Access(db, { personId: -1 }), libraryId, name)

/** A folder by the path agents see (/<team folder>/…), walked as the server (an Admin choosing a library sees every folder). */
export function folderByVpath(db: DB, vpath: string): FolderRow | null {
  const server = new Access(db, { personId: -1 })
  const parts = vpath.split('/').filter(Boolean).map(nfc)
  const row = parts.length ? server.mounts().get(parts[0]!) : undefined
  let node = row ? server.mountNode(row) : null
  for (let i = 1; node && i < parts.length; i++) {
    const real = namesIn(node).filter((n) => nfc(n) === parts[i])
    const e = real.length === 1 ? server.child(node, real[0]!) : null
    node = e && e.kind === 'dir' ? e.node : null
  }
  if (!node) return null
  const id = ensureFolder(db, node.real, node.dev, node.ino, node.birth)
  return db.query<FolderRow, [number]>('SELECT * FROM folders WHERE id = ?').get(id)!
}

/**
 * Approved skills this principal (a token's view, or a person's on the web) may read, sorted by qualified name. Only
 * approved snapshots appear: a pending edit changes nothing here, a new skill appears only once approved.
 */
export function visibleSkills(db: DB, access: Access): Skill[] {
  ensureSkillsSchema(db)
  const out: Skill[] = []
  const libs = new Map(libraries(db).map((l) => [l.folder_id, l]))
  const rows = db.query<VersionRow, []>("SELECT * FROM skill_versions WHERE status = 'approved' ORDER BY library_id, name, decided_at DESC, id DESC").all()
  const done = new Set<string>()
  for (const v of rows) {
    const lib = libs.get(v.library_id)
    const key = `${v.library_id}/${v.name}`
    if (!lib || done.has(key)) continue
    done.add(key)
    const node = skillNode(access, v.library_id, v.name)
    if (!node) continue
    out.push({ qname: `${lib.slug}/${v.name}`, slug: lib.slug, name: v.name, libraryId: v.library_id, version: v, description: v.description,
      frontmatter: JSON.parse(v.frontmatter), manifest: manifestOf(v), digest: v.digest, vpath: node.vpath, node })
  }
  return out.sort((a, b) => a.qname < b.qname ? -1 : a.qname > b.qname ? 1 : 0)
}

/** One visible skill by qualified name ("slug/name"), else null — the same for hidden and nonexistent. */
export function findSkill(db: DB, access: Access, qname: unknown): Skill | null {
  if (typeof qname !== 'string' || qname.length > 200) return null
  const q = qname.trim().replace(/^skill:\/\//, '').replace(/\/SKILL\.md$/, '')
  return visibleSkills(db, access).find((s) => s.qname === q) ?? null
}

// ---------- approval (finding 14) ----------
export interface Eligibility { eligible: boolean; why: string | null }

/**
 * Can this person approve this pending version now? An active person with a web sign-in (never a token: approval
 * happens only in a web session with a step-up) who is an Admin or manages the library folder and can read the skill
 * there; and who is not one of its editors (two-person rule). When the server cannot tell who edited a file (a NAS
 * written over SMB), only an Admin approves.
 */
export function approverStatus(db: DB, v: VersionRow, personId: number, rights = new Rights(db)): Eligibility {
  if (v.status !== 'pending') return { eligible: false, why: `this version is ${v.status}` }
  if (!libraryOf(db, v.library_id)) return { eligible: false, why: 'the folder is no longer a skill library' }
  const hasAccounts = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'accounts'").get()
  const p = db.query<{ active: number; admin: number }, [number]>(hasAccounts ? 'SELECT p.active, p.admin FROM people p JOIN accounts a ON a.person_id = p.id WHERE p.id = ?' : 'SELECT active, admin FROM people WHERE id = ?').get(personId)
  if (!p || !p.active) return { eligible: false, why: 'not an active person with a sign-in' }
  const editors = editorsOf(v)
  if (editors.includes(personId)) return { eligible: false, why: 'you changed this version: someone else approves it' }
  if (p.admin) return { eligible: true, why: null }
  if (editors.includes(null)) return { eligible: false, why: 'who changed these files is not known (edited outside the web): an Admin approves it' }
  const f = rights.folders.get(v.library_id)
  if (!f || !rights.manages(personId, f)) return { eligible: false, why: 'only a Manager of the library folder (or an Admin) approves skills' }
  if (!skillNode(Access.forPerson(db, personId), v.library_id, v.name)) return { eligible: false, why: 'you cannot read this skill folder' }
  return { eligible: true, why: null }
}

export function eligibleApprovers(db: DB, v: VersionRow): number[] {
  const rights = new Rights(db)
  return db.query<{ id: number }, []>('SELECT id FROM people WHERE active = 1').all().map((p) => p.id).filter((id) => approverStatus(db, v, id, rights).eligible)
}

/**
 * Approve exactly `digest` (the caller has proved the person in a web session with a step-up bound to this version and
 * digest, or is the server operator on the CLI). The bytes are already kept; the version becomes the one served and
 * the previously approved one is superseded.
 */
export function approveVersion(db: DB, dataDir: string, versionId: number, personId: number, digest: unknown, now = Date.now()): VersionRow {
  const v = versionById(db, versionId)
  if (!v) throw new SkillError('not_found', 'not found', 404)
  if (digest !== v.digest) throw new SkillError('digest_mismatch', 'this approval is for another version of the skill; reload the page', 409)
  const el = approverStatus(db, v, personId)
  if (!el.eligible) throw new SkillError('not_eligible', `you cannot approve this version (${el.why})`, 403)
  const blobs = skillBlobs(dataDir)
  for (const f of manifestOf(v)) {
    let ok = false
    try { ok = sha256(blobs.get(f.sha256)) === f.sha256 } catch { ok = false }
    if (!ok) throw new SkillError('blob', `the kept copy of ${f.path} is missing or damaged; it was not approved`, 500)
  }
  db.transaction(() => {
    const r = db.query("UPDATE skill_versions SET status = 'approved', decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'").run(personId, now, v.id)
    if (r.changes !== 1) throw new SkillError('not_pending', 'this version was decided meanwhile', 409)
    db.query("UPDATE skill_versions SET status = 'superseded' WHERE library_id = ? AND name = ? AND status = 'approved' AND id != ?").run(v.library_id, v.name, v.id)
  })()
  return versionById(db, v.id)!
}

export function rejectVersion(db: DB, versionId: number, personId: number, reason: unknown, now = Date.now()): VersionRow {
  const v = versionById(db, versionId)
  if (!v) throw new SkillError('not_found', 'not found', 404)
  if (!approverStatus(db, v, personId).eligible) throw new SkillError('not_eligible', 'you cannot decide this version', 403)
  const why = typeof reason === 'string' ? reason.trim().slice(0, 2000) : ''
  if (!why) throw new SkillError('reason_required', 'say why you reject it (the editors see this)')
  db.query("UPDATE skill_versions SET status = 'rejected', decided_by = ?, decided_at = ?, reason = ? WHERE id = ? AND status = 'pending'").run(personId, now, why, v.id)
  return versionById(db, v.id)!
}

// ---------- reading a snapshot ----------
export function snapshotFile(dataDir: string, v: VersionRow, rel: string): { entry: ManifestEntry; bytes: Uint8Array } | null {
  const entry = manifestOf(v).find((f) => f.path === rel)
  if (!entry) return null
  const bytes = skillBlobs(dataDir).get(entry.sha256)
  if (sha256(bytes) !== entry.sha256) throw new SkillError('blob', 'the kept copy of this file is damaged', 500)
  return { entry, bytes }
}

/** SKILL.md of an approved version as text */
export const skillMdText = (dataDir: string, v: VersionRow) => new TextDecoder().decode(snapshotFile(dataDir, v, 'SKILL.md')!.bytes)

const EXEC_EXT = /\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|php|ps1|bat|cmd|exe|bin|jar|applescript)$/i
/** "Contains executable files" badge: scripts/ or a script extension (never run by this server; shown as text). */
export const hasScripts = (m: ManifestEntry[]) => m.some((f) => f.path.startsWith('scripts/') || EXEC_EXT.test(f.path))
/** Text the agent can be given directly (not an office file or binary). */
export const isTextFile = (rel: string, bytes: Uint8Array) => !/\.(pdf|docx|xlsx|pptx|hwp|hwpx|zip|png|jpe?g|gif|webp)$/i.test(rel) && !bytes.subarray(0, 8000).includes(0)

/** AI uses of a skill in the last `days` days (audit rows "skills get <qname> …"). */
export function usageCount(db: DB, qname: string, days = 7, now = Date.now()): number {
  return db.query<{ n: number }, [number, string]>("SELECT count(*) AS n FROM audit WHERE at >= ? AND tool = 'skills' AND command LIKE ? ESCAPE '\\'")
    .get(now - days * 86400_000, `skills get ${qname.replace(/[\\%_]/g, (c) => '\\' + c)} %`)!.n
}
