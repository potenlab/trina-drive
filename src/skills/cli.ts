// CLI of team skills (workstream I1), registered through src/cli-registry.ts. The server operator's commands: the CLI
// runs on the server with the data directory, like `folder flag` and `rule set`.
//   tdrive folder flag <path> skills [--slug S] [--off] [--by ADMIN]   (src/cli.ts hands this one to skillsLibrary)
//   tdrive skills library <path> …                                      (the same)
//   tdrive skills list [--as PERSON] [--json]
//   tdrive skills validate <dir>
//   tdrive skills approve <library/name> <digest> --by ADMIN
import fs from 'node:fs'
import path from 'node:path'
import { appendAudit } from '../audit'
import type { CliCommand, CliContext } from '../cli-registry'
import { nfc } from '../names'
import { Access } from '../policy'
import { Rights } from '../rights'
import {
  approveVersion, approverStatus, designate, editorsOf, folderRowAt, libraries, libraryOf, manifestOf, pendingOf, approvedOf, scan, SkillError,
  undesignate, usageCount, visibleSkills, type VersionRow,
} from './core'
import { checkSkillMd, FrontmatterError, LIMITS } from './frontmatter'

function take(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  if (i < 0) return undefined
  const v = args[i + 1]
  if (v === undefined || v.startsWith('--')) throw new SkillError('bad_args', `${flag} needs a value`)
  args.splice(i, 2)
  return v
}
function has(args: string[], flag: string) { const i = args.indexOf(flag); if (i >= 0) args.splice(i, 1); return i >= 0 }

const personId = (c: CliContext, name: string) => {
  const p = c.db.query<{ id: number; admin: number; active: number }, [string]>('SELECT id, admin, active FROM people WHERE name = ?').get(name)
  if (!p) throw new SkillError('no_person', `no person ${name}`)
  return p
}

const guarded = (fn: (c: CliContext) => number | void) => (c: CliContext) => {
  try { return fn(c) } catch (e) {
    if (e instanceof SkillError || e instanceof FrontmatterError) { c.err(`error: ${e.message}`); return 1 }
    throw e
  }
}

/** `folder flag <path> skills [--slug S] [--off] [--by ADMIN]`: make a folder a skill library (or stop). Args after "folder flag". */
export const skillsLibrary = guarded((c) => {
  const args = [...c.args]
  const off = has(args, '--off')
  const slug = take(args, '--slug')
  const by = take(args, '--by')
  const dir = args[0]
  if (!dir || (args[1] !== undefined && args[1] !== 'skills')) { c.err('usage: folder flag <path> skills [--slug NAME] [--off] [--by ADMIN]'); return 2 }
  let real: string
  try { real = fs.realpathSync(dir) } catch { throw new SkillError('no_folder', `no folder at ${dir}`) }
  const byId = by ? personId(c, by) : null
  if (byId && !byId.admin) throw new SkillError('not_admin', `${by} is not an admin: only admins make skill libraries`)
  const f = folderRowAt(c.db, real)
  if (off) {
    const lib = libraryOf(c.db, f.id)
    if (!lib) { c.out(`${dir} is not a skill library`); return }
    c.db.transaction(() => {
      undesignate(c.db, f.id)
      appendAudit(c.db, { personId: byId?.id ?? null, tokenId: null, tool: 'cli', command: `skills library off ${lib.slug}`, files: [], outcome: 'ok' })
    })()
    c.out(`${dir} is no longer a skill library`)
    return
  }
  let slugOut = ''
  c.db.transaction(() => {
    const lib = designate(c.db, f, slug, byId?.id ?? null)
    slugOut = lib.slug
    appendAudit(c.db, { personId: byId?.id ?? null, tokenId: null, tool: 'cli', command: `skills library ${new Rights(c.db).vpath(f) ?? real} as "${lib.slug}"`, files: [], outcome: 'ok' })
  })()
  const r = scan(c.db, c.dataDir)
  c.out(`${dir} is a skill library: skills are "${slugOut}/<name>" (${r.skills} found, ${r.proposed.length} waiting for approval${r.problems.length ? `, ${r.problems.length} with problems` : ''})`)
})

const status = (v: VersionRow | undefined | null) => v ? `${v.status} sha256:${v.digest.slice(0, 12)}` : '—'

const list = guarded((c) => {
  const args = [...c.args]
  const as = take(args, '--as')
  const json = has(args, '--json')
  const r = scan(c.db, c.dataDir)
  if (as) {
    // what that person's AI is served (a full-scope token of theirs)
    const p = personId(c, as)
    const skills = visibleSkills(c.db, new Access(c.db, { personId: p.id })).map((s) => ({ name: s.qname, description: s.description, folder: s.vpath, sha256: s.digest }))
    if (json) c.out(JSON.stringify({ person: as, skills }, null, 2))
    else c.out(skills.length ? skills.map((s) => `${s.name}\t${s.folder}\tsha256:${s.sha256.slice(0, 12)}\t${s.description.replace(/\s+/g, ' ').slice(0, 80)}`).join('\n') : `${as}'s AI is served no skills`)
    return
  }
  const rows: Record<string, unknown>[] = []
  for (const lib of libraries(c.db)) {
    const names = new Set([...c.db.query<{ name: string }, [number]>('SELECT DISTINCT name FROM skill_versions WHERE library_id = ?').all(lib.folder_id).map((x) => x.name),
      ...c.db.query<{ name: string }, [number]>('SELECT name FROM skill_problems WHERE library_id = ?').all(lib.folder_id).map((x) => x.name)])
    for (const name of [...names].sort()) {
      const a = approvedOf(c.db, lib.folder_id, name), p = pendingOf(c.db, lib.folder_id, name)
      const problem = c.db.query<{ error: string }, [number, string]>('SELECT error FROM skill_problems WHERE library_id = ? AND name = ?').get(lib.folder_id, name)?.error ?? null
      rows.push({ name: `${lib.slug}/${name}`, approved: a ? { digest: a.digest, at: a.decided_at } : null, pending: p ? { digest: p.digest, editors: editorsOf(p) } : null, problem, uses_7d: a ? usageCount(c.db, `${lib.slug}/${name}`) : 0 })
    }
  }
  if (json) { c.out(JSON.stringify({ libraries: libraries(c.db), skills: rows, scan: r }, null, 2)); return }
  if (!libraries(c.db).length) { c.out('no skill libraries (make one: folder flag <path> skills)'); return }
  for (const x of rows) {
    const lib = libraries(c.db).find((l) => (x.name as string).startsWith(l.slug + '/'))!
    const n = (x.name as string).slice(lib.slug.length + 1)
    c.out(`${x.name}\tserving: ${status(approvedOf(c.db, lib.folder_id, n))}\twaiting: ${status(pendingOf(c.db, lib.folder_id, n))}${x.problem ? `\tproblem: ${x.problem}` : ''}`)
  }
})

/** Check a skill folder on disk (any path; nothing is recorded). */
const validate = guarded((c) => {
  const dir = c.args[0]
  if (!dir) { c.err('usage: skills validate <skill folder>'); return 2 }
  let st: fs.Stats
  try { st = fs.statSync(dir) } catch { throw new SkillError('no_folder', `no folder at ${dir}`) }
  if (!st.isDirectory()) throw new SkillError('no_folder', `not a folder: ${dir}`)
  const md = path.join(dir, 'SKILL.md')
  if (!fs.existsSync(md)) throw new FrontmatterError('no SKILL.md')
  const p = checkSkillMd(fs.readFileSync(md), nfc(path.basename(path.resolve(dir))))
  let files = 0, total = 0
  const walk = (d: string, depth: number) => {
    if (depth > LIMITS.depth) throw new FrontmatterError(`folders nest deeper than ${LIMITS.depth} levels`)
    for (const n of fs.readdirSync(d)) {
      if (n.startsWith('.')) continue
      const full = path.join(d, n)
      const s = fs.lstatSync(full)
      if (s.isSymbolicLink()) throw new FrontmatterError(`${path.relative(dir, full)} is a link (links are never followed)`)
      if (s.isDirectory()) { walk(full, depth + 1); continue }
      files++
      total += s.size
      if (s.size > (n === 'SKILL.md' && d === dir ? LIMITS.skillMdBytes : LIMITS.fileBytes)) throw new FrontmatterError(`${path.relative(dir, full)} is too large`)
    }
  }
  walk(dir, 0)
  if (files > LIMITS.files) throw new FrontmatterError(`more than ${LIMITS.files} files`)
  if (total > LIMITS.totalBytes) throw new FrontmatterError('the files add up to more than 16 MB')
  c.out(`ok: ${p.name} — ${p.description.replace(/\s+/g, ' ').slice(0, 120)} (${files} files, ${total} bytes)`)
  for (const w of p.warnings) c.out(`warning: ${w}`)
})

/** Approve from the server: an Admin named with --by, who is not one of the version's editors (two-person rule). */
const approveCmd = guarded((c) => {
  const args = [...c.args]
  const by = take(args, '--by')
  const [qname, digest] = args
  if (!qname || !digest || !by) { c.err('usage: skills approve <library/name> <sha256 or its first 12+ characters> --by ADMIN'); return 2 }
  const p = personId(c, by)
  if (!p.admin || !p.active) throw new SkillError('not_admin', 'approving from the CLI needs an active admin (--by); everyone else approves on the web with a passkey')
  scan(c.db, c.dataDir)
  const [slug, name] = qname.split('/')
  const lib = libraries(c.db).find((l) => l.slug === slug)
  const v = lib && name ? pendingOf(c.db, lib.folder_id, name) : null
  if (!v) throw new SkillError('not_found', `no version of ${qname} is waiting for approval`)
  if (digest.length < 12 || !v.digest.startsWith(digest.replace(/^sha256:/, ''))) throw new SkillError('digest_mismatch', `${qname} waiting for approval is sha256:${v.digest}; give that digest`)
  const el = approverStatus(c.db, v, p.id)
  if (!el.eligible) throw new SkillError('not_eligible', `${by} cannot approve it: ${el.why}`)
  c.db.transaction(() => {
    approveVersion(c.db, c.dataDir, v.id, p.id, v.digest)
    appendAudit(c.db, { personId: p.id, tokenId: null, tool: 'cli', command: `approve skill ${qname} sha256:${v.digest}`, files: [], outcome: 'ok' })
  })()
  c.out(`approved ${qname} sha256:${v.digest} (${manifestOf(v).length} files)`)
})

export const skillsCommands: CliCommand[] = [
  { name: 'skills library', help: '  skills library <path> [--slug S] [--off] [--by ADMIN]   make a folder a team skill library (same as: folder flag <path> skills)', run: skillsLibrary },
  { name: 'skills list', help: '  skills list [--as PERSON] [--json]     team skills: what is served, what waits for approval (--as: what that person\'s AI gets)', run: list },
  { name: 'skills validate', help: '  skills validate <dir>                  check a skill folder (SKILL.md frontmatter, sizes) before putting it in a library', run: validate },
  { name: 'skills approve', help: '  skills approve <library/name> <sha256> --by ADMIN   approve a waiting skill version (not one you edited)', run: approveCmd },
]
