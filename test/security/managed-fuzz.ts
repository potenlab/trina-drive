// Managed-storage security fuzz for file-level sharing (workstream A2; memo §11.3). Each run builds a fresh world, does
// 20–40 random operations (uploads, versions, moves incl. into a personal folder and across mounts, copy, trash,
// restore, purge, expiry, rescan, file shares for people / a group / Everyone, leave, folder rules, restrict-here,
// No AI, quarantine, membership, group delete + id reuse, and an older image's writes: rows without a uid, purges that
// keep grant rows, file moves that leave locations stale, a stale row forced onto another file's identity) and checks
// the real code against a pure model after EVERY operation, then the real surfaces at the end of the run.
//
//   FUZZ_RUNS=10000 FUZZ_SEED=1 bun run test:managed-fuzz      (the A2 gate: 0 violations)
//   FUZZ_WORKERS=8 …                                          (runs split over processes; seeds per run are printed)
//   FUZZ_ONE=<seed> bun run test:managed-fuzz                  (replay one run exactly, with its operation log)
//
// Oracle (memo §11.1):
//   after every op   I1 exact R0′/R1′ (persons, full tokens, a scoped token, No AI), I2 bare paths list only what they
//                    lead to, I4/I7 no orphan or location ever opens anything, I6 lifecycle, I8 agent ≤ person, I10 file
//                    Editors change nothing but versions (disk and rows unchanged on refusal), I11 personal: no effect,
//                    I12 deletes never fail because of grants, and the sharing API's yes/no matches O1.
//   end of each run  through the real surfaces: web list/stat/download/text/search/who/versions/shared-with-me/recent,
//                    WebDAV PROPFIND Depth:infinity + GET, the MCP shell per token (ls -R, find, du -a, grep -r, cat):
//                    I3 hidden == missing, I5 nothing revoked shows, I9 provenance (via_file touches), I13 no canary
//                    from an unreadable file, I14 Bearer → 401 on /api/share; finally the audit chain verifies.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { verifyAudit } from '../../src/audit'
import { openDb, type DB } from '../../src/db'
import { createManagedFolder } from '../../src/managed/folders'
import { ManagedError, relocateShared, stageBytes } from '../../src/managed/core'
import { Managed, managedIdle, purgeExpired, rescan } from '../../src/managed/ops'
import { metaSet } from '../../src/managed/settings'
import * as mweb from '../../src/managed/web'
import { nfc } from '../../src/names'
import { Access, type Entry } from '../../src/policy'
import { makeCtx, Session, type Ctx } from '../../src/session'
import { runShell } from '../../src/shell'
import { addGroup, addMember, addPerson, createToken, ensureFolder, verifyToken, type TokenRow } from '../../src/store'
import { changeShare, sharedWithMe, shareView } from '../../src/share/service'
import { APP_PASSWORD_PREFIX } from '../../src/dav/apppw'
import { recent } from '../../src/share/recent'
import * as files from '../../src/web/files'
import { ApiError, type WebCtx } from '../../src/web/http'
import { OutboxMailer } from '../../src/web/mail'
import { handleWeb, makeWebCtx } from '../../src/web/server'
import { sha256 } from '../../src/store'
import { rng } from './fuzz'

type R = ReturnType<typeof rng>
export interface Violation { run: number; seed: number; op: number; kind: string; detail: string; log: string[] }
export interface MFuzzStats { runs: number; ops: number; checks: number; violations: Violation[]; ms: number; deepRuns: number }

// ---------------------------------------------------------------- the model ----------------------------------------
interface MMount { kind: 'mount'; id: number; name: string; real: string; personal: number | null; row: number }
interface MDir { kind: 'dir'; id: number; name: string; parent: MDir | MMount; trash: number | null; rules: Map<string, number>; brk: boolean; noai: boolean; quar: boolean }
type MNode = MMount | MDir
interface Grant { level: number; gen: number }
interface MFile { kind: 'file'; id: number; name: string; parent: MNode; trash: number | null; canary: string; closed: boolean; grants: Map<string, Grant>; located: boolean; stale: boolean; inert: boolean; versions: number }
type Item = MDir | MFile
interface MGroup { id: number; gen: number; members: Set<number>; alive: boolean }
type Aud = { person: number; agent: boolean; scope: MMount | null; token?: TokenRow; label: string }

class Model {
  mounts: MMount[] = []
  dirs: MDir[] = []
  files: MFile[] = []
  groups = new Map<number, MGroup>()
  nextId = 1
  /** rules on mounts (mount rows): key 'p:<id>' | 'g:<id>' */
  mountRules = new Map<number, Map<string, number>>()
  mountFlags = new Map<number, { noai: boolean; quar: boolean }>()
  everyone = 0

  groupsOf(pid: number) { return [...this.groups.values()].filter((g) => g.alive && g.members.has(pid)).map((g) => g.id) }
  chain(n: MNode): MNode[] { const out: MNode[] = []; for (let x: MNode | null = n; x; x = x.kind === 'dir' ? x.parent : null) out.unshift(x); return out }
  mountOf(n: MNode | MFile): MMount { let x: MNode = n.kind === 'file' ? n.parent : n; while (x.kind === 'dir') x = x.parent; return x }
  rulesOf(n: MNode) { return n.kind === 'mount' ? (this.mountRules.get(n.id) ?? new Map()) : n.rules }
  trashed(n: MNode | MFile): boolean {
    let x: MNode | MFile | null = n
    while (x) { if (x.kind !== 'mount' && x.trash != null) return true; x = x.kind === 'mount' ? null : x.parent }
    return false
  }
  flagged(n: MNode, agent: boolean) {
    return this.chain(n).some((x) => x.kind === 'mount' ? (this.mountFlags.get(x.id)?.quar || (agent && this.mountFlags.get(x.id)?.noai)) : (x.quar || (agent && x.noai)))
  }
  level(pid: number, n: MNode): number {
    const ch = this.chain(n)
    const m = ch[0] as MMount
    if (m.personal != null) return m.personal === pid ? 2 : 0
    const gs = new Set(this.groupsOf(pid))
    let best = 0
    for (let i = ch.length - 1; i >= 0; i--) {
      const x = ch[i]!
      for (const [k, lv] of this.rulesOf(x)) if (k === `p:${pid}` || (k.startsWith('g:') && gs.has(Number(k.slice(2))))) best = Math.max(best, lv)
      if (x.kind === 'mount' || x.brk) break
    }
    return best
  }
  /** one subject alone (no groups expanded), as rights.subjectLevel */
  subjectLevel(key: string, n: MNode): number {
    const ch = this.chain(n)
    const m = ch[0] as MMount
    if (m.personal != null) return key === `p:${m.personal}` ? 2 : 0
    let best = 0
    for (let i = ch.length - 1; i >= 0; i--) {
      const x = ch[i]!
      best = Math.max(best, this.rulesOf(x).get(key) ?? 0)
      if (x.kind === 'mount' || x.brk) break
    }
    return best
  }
  fileLevel(pid: number, f: MFile): number {
    if (f.inert || f.closed || this.mountOf(f).personal != null) return 0
    let best = 0
    for (const [k, g] of f.grants) {
      if (k === `p:${pid}`) best = Math.max(best, g.level)
      else if (k.startsWith('g:')) {
        const gr = this.groups.get(Number(k.slice(2)))
        if (gr && gr.alive && gr.gen === g.gen && gr.members.has(pid)) best = Math.max(best, g.level)
      }
    }
    return best
  }
  inScope(a: Aud, n: MNode) { return !a.scope || this.mountOf(n) === a.scope }
  canReadDir(a: Aud, n: MNode) { return !this.trashed(n) && !this.flagged(n, a.agent) && this.inScope(a, n) && this.level(a.person, n) >= 1 }
  canReadFile(a: Aud, f: MFile) {
    if (this.trashed(f) || f.closed) return false
    return !this.flagged(f.parent, a.agent) && this.inScope(a, f.parent) && Math.max(this.level(a.person, f.parent), this.fileLevel(a.person, f)) >= 1
  }
  under(n: MNode | MFile, top: MNode): boolean { let x: MNode | MFile | null = n; while (x) { if (x === top) return true; x = x.kind === 'mount' ? null : x.parent } return false }
  /**
   * Files the walk can reach through a grant's remembered location: wherever a location of one of this person's grants
   * points (read from the database: where it points is data, not a decision), the file THERE must be readable by the
   * model on its own (identity: its own grant or its folder) for the folders above it to show.
   */
  anchorsFn: ((a: Aud) => MFile[]) | null = null
  visible(a: Aud, d: MNode, anchors: MFile[]): boolean {
    if (this.trashed(d)) return false
    if (this.canReadDir(a, d)) return true
    if (this.dirs.some((x) => x !== d && this.under(x, d) && this.canReadDir(a, x))) return true
    return anchors.some((f) => this.under(f.parent, d) && this.canReadFile(a, f))
  }
  /** what the walk must find: visible folders and reachable readable files, by virtual path */
  expected(a: Aud): { dirs: Set<string>; files: Map<string, MFile> } {
    const dirs = new Set<string>(), out = new Map<string, MFile>()
    const vis = new Map<MNode, boolean>()
    const anchors = this.anchorsFn ? this.anchorsFn(a) : []
    const v = (n: MNode) => { let x = vis.get(n); if (x === undefined) { x = this.visible(a, n, anchors); vis.set(n, x) } return x }
    const allVisible = (n: MNode) => this.chain(n).every(v)
    for (const m of this.mounts) if (v(m)) dirs.add(this.vpath(m))
    for (const d of this.dirs) if (!this.trashed(d) && allVisible(d)) dirs.add(this.vpath(d))
    for (const f of this.files) if (this.canReadFile(a, f) && allVisible(f.parent)) out.set(this.vpath(f), f)
    return { dirs, files: out }
  }
  vpath(n: MNode | MFile): string { return n.kind === 'mount' ? '/' + nfc(n.name) : this.vpath(n.parent) + '/' + nfc(n.name) }
  real(n: MNode | MFile): string { return n.kind === 'mount' ? n.real : path.join(this.real(n.parent), n.name) }
  live<T extends Item>(xs: T[]) { return xs.filter((x) => !this.trashed(x)) }
}

// ---------------------------------------------------------------- the world -----------------------------------------
const DIR_NAMES = ['a', 'b', '결산', '자료', 'x y']
const FILE_NAMES = ['f.md', 'q3.md', '보고서.md', 'n.txt', 'z.csv']

interface World {
  dir: string; db: DB; ctx: Ctx; w: WebCtx; m: Model; r: R; log: string[]
  people: { O: number; P: number[] }; G: number; E: number
  tokens: Map<string, Aud>; persons: Aud[]; auds: Aud[]
  canaryN: number; run: number
}

function person(w: World, pid: number) { return { personId: pid, admin: pid === w.people.O } }
const mgd = (w: World, pid: number) => new Managed(w.ctx, pid)

function freshWorld(run: number, seed: number): World {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tdrive-mfuzz-')))
  const db = openDb(dir)
  metaSet(db, 'storage_mode', 'managed')
  const ctx = makeCtx(db, dir)
  const w = makeWebCtx(ctx, { mailer: new OutboxMailer(dir, true), webDir: '/nonexistent' })
  const r = rng(seed)
  const m = new Model()
  const O = addPerson(db, 'O', true).id
  const P = ['P1', 'P2', 'P3'].map((n) => addPerson(db, n).id)
  const G = addGroup(db, 'G'); addMember(db, 'G', 'P2')
  const E = addGroup(db, 'everyone')
  for (const n of ['O', 'P1', 'P2', 'P3']) addMember(db, 'everyone', n)
  db.query("INSERT INTO meta (key, value) VALUES ('everyone_group', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(String(E))
  m.groups.set(G, { id: G, gen: 0, members: new Set([P[1]!]), alive: true })
  m.groups.set(E, { id: E, gen: 0, members: new Set([O, ...P]), alive: true })
  m.everyone = E
  const mk = (name: string, personal?: string) => {
    const f = createManagedFolder(db, dir, { name, personalOwner: personal })
    const mm: MMount = { kind: 'mount', id: m.nextId++, name, real: f.path, personal: personal ? db.query<{ id: number }, [string]>('SELECT id FROM people WHERE name = ?').get(personal)!.id : null, row: f.id }
    m.mounts.push(mm)
    m.mountRules.set(mm.id, new Map())
    m.mountFlags.set(mm.id, { noai: false, quar: false })
    return mm
  }
  const T1 = mk('T1')
  const mounts = [T1]
  if (r.chance(0.2)) mounts.push(mk('T2'))
  mk('PM', 'P1')
  for (const t of mounts) {
    db.query("INSERT INTO rules (folder_id, subject_type, subject_id, level) VALUES (?, 'person', ?, 2)").run(t.row, O)
    m.mountRules.get(t.id)!.set(`p:${O}`, 2)
  }
  const tokens = new Map<string, Aud>()
  const tok = (name: string, pid: number, scope: MMount | null) => {
    const t = createToken(db, name, { name: `${name}-${scope ? 'scoped' : 'full'}`, scope: scope ? [scope.real] : undefined })
    const row = verifyToken(db, t.token)!
    const a: Aud = { person: pid, agent: true, scope, token: row, label: `${name}-${scope ? 'scoped' : 'token'}` }
    tokens.set(a.label, a)
    return a
  }
  const persons: Aud[] = [O, ...P].map((pid, i) => ({ person: pid, agent: false, scope: null, label: ['O', 'P1', 'P2', 'P3'][i]! }))
  const auds = [...persons, tok('P1', P[0]!, null), tok('P2', P[1]!, null), tok('P3', P[2]!, null), tok('P1', P[0]!, T1)]
  const world: World = { dir, db, ctx, w, m, r, log: [], people: { O, P }, G, E, tokens, persons, auds, canaryN: 0, run }
  m.anchorsFn = (a) => {
    if (a.person <= 0) return []
    const rows = db.query<{ subject_type: string; subject_id: number; subject_uid: string | null; dir: string; name: string; guid: string | null }, []>(`
      SELECT g.subject_type, g.subject_id, g.subject_uid, f.path AS dir, m.name, x.uid AS guid FROM file_grants g JOIN mfiles m ON m.uid = g.file_uid
      JOIN folders f ON f.id = m.folder_id LEFT JOIN groups x ON g.subject_type = 'group' AND x.id = g.subject_id WHERE m.name IS NOT NULL`).all()
    const out: MFile[] = []
    for (const r of rows) {
      const mine = r.subject_type === 'person' ? r.subject_id === a.person
        : r.guid != null && r.guid === r.subject_uid && !!m.groups.get(r.subject_id)?.alive && m.groups.get(r.subject_id)!.members.has(a.person)
      if (!mine) continue
      const node = [...m.mounts, ...m.dirs].find((x) => !m.trashed(x) && m.real(x) === r.dir)
      const f = node && m.files.find((x) => !m.trashed(x) && !x.closed && x.parent === node && x.name === r.name)
      if (f) out.push(f)
    }
    return out
  }
  // a random tree, made by O through the real API
  for (const t of mounts) {
    const nDirs = 1 + r.int(4)
    for (let i = 0; i < nDirs; i++) opMkdir(world, t)
    const nFiles = 3 + r.int(6)
    for (let i = 0; i < nFiles; i++) opUploadNew(world)
  }
  // P1's own files
  for (let i = 0; i < 2; i++) uploadInto(world, m.mounts.find((x) => x.personal != null)!, P[0]!, r.pick(FILE_NAMES))
  return world
}

// ---------------------------------------------------------------- operations ----------------------------------------
class Skip extends Error {}
/** Pick one, or skip the operation when there is nothing to pick from. */
function pk<T>(w: World, xs: readonly T[]): T { if (!xs.length) throw new Skip(); return w.r.pick(xs) }
const canary = (w: World) => `CANARY-${w.run}-${++w.canaryN}-${sha256(String(Math.random())).slice(0, 6)}`

function fileByReal(w: World, real: string) { return w.m.files.find((f) => !w.m.trashed(f) && w.m.real(f) === real) }
function syncCanary(w: World, f: MFile) { try { f.canary = fs.readFileSync(w.m.real(f), 'utf8') } catch {} }
function liveDirs(w: World, opts: { team?: boolean } = {}): MNode[] {
  return [...w.m.mounts.filter((x) => !opts.team || x.personal == null), ...w.m.live(w.m.dirs).filter((d) => !opts.team || w.m.mountOf(d).personal == null)]
}
function liveFiles(w: World) { return w.m.live(w.m.files).filter((f) => !f.closed) }
/** The file is readable AND the walk reaches it (its folders are visible) for this person. */
function reachable(w: World, pid: number, f: MFile) { const a = w.persons.find((x) => x.person === pid)!; return w.m.expected(a).files.get(w.m.vpath(f)) === f }

function managedCall<T>(f: () => T): T | null {
  try { return f() } catch (e) { if (e instanceof ManagedError || e instanceof ApiError) return null; throw e }
}

function opMkdir(w: World, mount?: MMount) {
  const parents = liveDirs(w, { team: true }).filter((d) => !mount || w.m.mountOf(d) === mount).filter((d) => w.m.chain(d).length < 3)
  if (!parents.length) throw new Skip()
  const p = pk(w, parents)
  const name = pk(w, DIR_NAMES)
  const res = managedCall(() => mgd(w, w.people.O).mkdir(w.m.vpath(p), name))
  if (res?.created) w.m.dirs.push({ kind: 'dir', id: w.m.nextId++, name, parent: p, trash: null, rules: new Map(), brk: false, noai: false, quar: false })
  return `mkdir ${w.m.vpath(p)}/${name} -> ${res ? 'ok' : 'refused'}`
}
function uploadInto(w: World, p: MNode, by: number, name: string) {
  const c = canary(w)
  const mg = mgd(w, by)
  const res = managedCall(() => mg.put(w.m.vpath(p), name, stageBytes(mg.s.root, Buffer.from(c)), 'rename'))
  if (res) w.m.files.push({ kind: 'file', id: w.m.nextId++, name: res.name, parent: p, trash: null, canary: c, closed: false, grants: new Map(), located: false, stale: false, inert: false, versions: 1 })
  return res
}
function opUploadNew(w: World) {
  const p = pk(w, liveDirs(w, { team: true }))
  const res = uploadInto(w, p, w.people.O, pk(w, FILE_NAMES))
  return `upload ${w.m.vpath(p)} -> ${res ? res.path : 'refused'}`
}
/** A new version, by O or by a person the model says may write this file (a folder writer or a file Editor). */
function opReplace(w: World) {
  const f = pk(w, liveFiles(w))
  const by = w.r.chance(0.5) ? w.people.O : pk(w, w.people.P)
  const a = w.persons.find((x) => x.person === by)!
  const may = reachable(w, by, f) && w.m.mountOf(f).personal == null && Math.max(w.m.level(by, f.parent), w.m.fileLevel(by, f)) >= 2
  const pMay = w.m.mountOf(f).personal === by && reachable(w, by, f)
  void a
  const c = canary(w)
  const mg = mgd(w, by)
  const before = fs.readdirSync(w.m.real(f.parent)).sort().join('|')
  const res = managedCall(() => mg.put(w.m.vpath(f.parent), f.name, stageBytes(mg.s.root, Buffer.from(c)), 'replace'))
  if (!!res !== (may || pMay)) throw violation('I10', `replace ${w.m.vpath(f)} by ${by}: model ${may || pMay}, real ${!!res}`)
  if (res) { f.versions++; syncCanary(w, f) } else if (fs.readdirSync(w.m.real(f.parent)).sort().join('|') !== before) throw violation('I10', `refused replace changed the folder ${w.m.vpath(f.parent)}`)
  return `replace ${w.m.vpath(f)} by ${by} -> ${res ? 'ok' : 'refused'}`
}
function opRestoreVersion(w: World) {
  const f = pk(w, liveFiles(w).filter((x) => x.versions > 1).concat(liveFiles(w)).slice(0, 50))
  const by = w.r.chance(0.6) ? w.people.O : pk(w, w.people.P)
  const a = w.persons.find((x) => x.person === by)!
  const res = managedCall(() => mgd(w, by).restoreVersion(w.m.vpath(f), 1 + w.r.int(Math.max(1, f.versions - 1))))
  void a
  const may = reachable(w, by, f) && (w.m.mountOf(f).personal === by || (w.m.mountOf(f).personal == null && Math.max(w.m.level(by, f.parent), w.m.fileLevel(by, f)) >= 2))
  if (res && !may) throw violation('I10', `restore-version ${w.m.vpath(f)} by ${by} allowed, model says no`)
  if (res) { f.versions++; syncCanary(w, f) }
  return `restore-version ${w.m.vpath(f)} by ${by} -> ${res ? 'ok' : 'refused'}`
}
/** A file-only Editor (or Viewer) tries what only a folder writer may do: every one must be refused and change nothing. */
function opFileEditorOverreach(w: World) {
  const cands: [MFile, number][] = []
  for (const f of liveFiles(w)) for (const p of w.people.P) if (w.m.fileLevel(p, f) >= 1 && w.m.level(p, f.parent) < 2 && w.m.mountOf(f).personal == null) cands.push([f, p])
  if (!cands.length) throw new Skip()
  const [f, p] = pk(w, cands)
  const mg = mgd(w, p)
  const dirReal = w.m.real(f.parent)
  const before = fs.readdirSync(dirReal).sort().join('|')
  const tries: [string, () => unknown][] = [
    ['rename', () => mg.rename(w.m.vpath(f), 'renamed.md')],
    ['delete', () => mg.removeOne(w.m.vpath(f))],
    ['upload-new', () => mg.put(w.m.vpath(f.parent), 'new-by-editor.md', stageBytes(mg.s.root, Buffer.from('x')), 'fail')],
    ['mkdir', () => mg.mkdir(w.m.vpath(f.parent), 'sub-by-editor')],
  ]
  const [what, fn] = pk(w, tries)
  const res = managedCall(fn)
  if (res !== null) throw violation('I10', `file-only ${w.m.fileLevel(p, f) >= 2 ? 'Editor' : 'Viewer'} ${p} could ${what} ${w.m.vpath(f)}`)
  if (fs.readdirSync(dirReal).sort().join('|') !== before) throw violation('I10', `refused ${what} changed ${w.m.vpath(f.parent)}`)
  return `overreach ${what} ${w.m.vpath(f)} by ${p} -> refused`
}
function opRename(w: World) {
  const it: Item = w.r.chance(0.7) ? pk(w, liveFiles(w)) : pk<Item>(w, w.m.live(w.m.dirs).length ? w.m.live(w.m.dirs) : liveFiles(w))
  const name = it.kind === 'file' ? pk(w, FILE_NAMES) : pk(w, DIR_NAMES)
  const by = w.m.mountOf(it).personal ?? w.people.O
  const res = managedCall(() => mgd(w, by).rename(w.m.vpath(it), name))
  if (res && res.path !== w.m.vpath(it)) { it.name = name; if (it.kind === 'file') it.stale = false }
  return `rename ${it.kind} -> ${name}: ${res ? 'ok' : 'refused'}`
}
function opMove(w: World) {
  const it: Item = w.r.chance(0.65) ? pk(w, liveFiles(w)) : pk<Item>(w, w.m.live(w.m.dirs).length ? w.m.live(w.m.dirs) : liveFiles(w))
  const targets = liveDirs(w).filter((d) => !(it.kind === 'dir' && w.m.under(d, it)))
  const to = pk(w, targets)
  const from = w.m.vpath(it)
  // O moves within team folders; P1 (the owner) moves between PM and team folders where they may write
  const by = w.m.mountOf(it).personal != null || w.m.mountOf(to).personal != null ? w.people.P[0]! : w.people.O
  const res = managedCall(() => mgd(w, by).move([from], w.m.vpath(to), 'rename'))
  const r0 = res?.results[0]
  if (r0?.to && !r0.error && to !== it.parent) { // into its own folder: nothing moves (and nothing is relocated)
    const intoPersonal = w.m.mountOf(to).personal != null
    it.parent = to
    it.name = r0.to.slice(r0.to.lastIndexOf('/') + 1)
    const moved = it.kind === 'file' ? [it] : w.m.files.filter((f) => w.m.under(f, it))
    if (it.kind === 'file') it.stale = false
    if (intoPersonal) for (const f of moved) { f.grants.clear() }
  }
  return `move ${from} -> ${w.m.vpath(to)} by ${by}: ${r0?.to ?? r0?.error ?? 'refused'}`
}
function opCopy(w: World) {
  const f = pk(w, liveFiles(w).filter((x) => w.m.mountOf(x).personal == null))
  const to = pk(w, liveDirs(w, { team: true }))
  const res = managedCall(() => mgd(w, w.people.O).copy([w.m.vpath(f)], w.m.vpath(to)))
  const r0 = res?.results[0]
  if (r0?.to && !r0.error) w.m.files.push({ kind: 'file', id: w.m.nextId++, name: r0.to.slice(r0.to.lastIndexOf('/') + 1), parent: to, trash: null, canary: f.canary, closed: false, grants: new Map(), located: false, stale: false, inert: false, versions: 1 })
  return `copy ${w.m.vpath(f)} -> ${w.m.vpath(to)}: ${r0?.to ?? r0?.error ?? 'refused'}`
}
const trashItems = new WeakMap<World, Map<number, Item>>()
function opTrash(w: World) {
  const it: Item = w.r.chance(0.7) ? pk(w, liveFiles(w)) : pk<Item>(w, w.m.live(w.m.dirs).length ? w.m.live(w.m.dirs) : liveFiles(w))
  const by = w.m.mountOf(it).personal ?? w.people.O
  const id = managedCall(() => mgd(w, by).removeOne(w.m.vpath(it)))
  if (id) { it.trash = id; trashItems.get(w)!.set(id, it) }
  return `trash ${w.m.vpath(it)}: ${id ?? 'refused'}`
}
function opRestore(w: World) {
  const items = [...trashItems.get(w)!].filter(([id, it]) => it.trash === id)
  if (!items.length) throw new Skip()
  const [id, it] = pk(w, items)
  const by = w.m.mountOf(it).personal ?? w.people.O
  const res = managedCall(() => mgd(w, by).restore(id))
  if (res) { it.trash = null; it.name = res.path.slice(res.path.lastIndexOf('/') + 1); if (it.kind === 'file') it.stale = false }
  return `restore #${id}: ${res?.path ?? 'refused'}`
}
function forget(w: World, it: Item) {
  const gone = (x: MFile | MDir) => x === it || w.m.under(x, it as MNode)
  w.m.files = w.m.files.filter((f) => !gone(f))
  w.m.dirs = w.m.dirs.filter((d) => !gone(d))
}
function opPurge(w: World) {
  const items = [...trashItems.get(w)!].filter(([id, it]) => it.trash === id)
  if (!items.length) throw new Skip()
  const [id, it] = pk(w, items)
  const by = w.m.mountOf(it).personal ?? w.people.O
  const res = managedCall(() => mgd(w, by).purge(id))
  // refused only when the purger cannot reach the folder it came from (a crash — e.g. a foreign key — fails the run)
  if (res) { forget(w, it); trashItems.get(w)!.delete(id) }
  return `purge #${id}: ${res ? 'ok' : 'refused'}`
}
function opExpire(w: World) {
  purgeExpired(w.ctx, Date.now() + 400 * 86400_000)
  for (const [id, it] of trashItems.get(w)!) if (it.trash === id) { forget(w, it); trashItems.get(w)!.delete(id) }
  return 'expire all'
}
function opRescan(w: World) {
  const r = rescan(w.ctx)
  if (r.partial) throw violation('rescan', 'partial walk in a tiny world')
  for (const f of w.m.files) if (!w.m.trashed(f)) f.stale = false
  return `rescan ${JSON.stringify(r)}`
}
function opRelocate(w: World) { relocateShared(w.db); for (const f of w.m.files) if (!w.m.trashed(f)) f.stale = false; return 'relocate (boot)' }

// ---- sharing through the real API (POST /api/share), with O1's yes/no predicted ----
const LEVEL = { viewer: 1, editor: 2 } as const
async function opShare(w: World) {
  const f = pk(w, liveFiles(w))
  const actor = w.r.chance(0.6) ? w.people.O : pk(w, w.people.P)
  const a = w.persons.find((x) => x.person === actor)!
  const subjects = [`p:${pk(w, w.people.P)}`, `p:${w.people.O}`, `g:${w.G}`]
  const kindPick = w.r.int(10)
  let body: Record<string, unknown>
  let key: string, want: number | 'remove' | 'leave'
  const role = pk(w, ['viewer', 'editor'] as const)
  if (kindPick < 5) { key = pk(w, subjects); want = LEVEL[role]; body = { add: [{ subject: { type: key[0] === 'p' ? 'person' : 'group', id: Number(key.slice(2)) }, role }] } }
  else if (kindPick < 7) { key = pk(w, [...f.grants.keys(), ...subjects].filter((k) => k !== `g:${w.E}`)); want = 'remove'; body = { set: [{ subject: { type: key[0] === 'p' ? 'person' : 'group', id: Number(key.slice(2)) }, role: 'remove' }] } }
  else if (kindPick < 9) {
    key = `g:${w.E}`
    const team = w.r.chance(0.6)
    want = team ? LEVEL[role] : 'remove'
    body = { general: team ? { mode: 'team', role } : { mode: 'restricted' } }
  } else { key = `p:${actor}`; want = 'leave'; body = { leave: true } }
  body.path = w.m.vpath(f)
  body.notify = false
  // ---- the model's answer ----
  const sees = w.m.canReadFile(a, f) && w.m.expected(a).files.has(w.m.vpath(f))
  const mount = w.m.mountOf(f)
  const isGeneral = 'general' in body
  const cur = f.grants.get(key)
  const grp = key.startsWith('g:') ? w.m.groups.get(Number(key.slice(2))) : null
  const prev = cur && (!grp || cur.gen === grp.gen) ? cur.level : 0
  let expect: { status: number; apply?: () => void }
  const toggleOn = true
  const kind = !sees ? 'hidden' : mount.personal != null ? 'personal' : actor === w.people.O ? 'admin'
    : toggleOn && w.m.level(actor, f.parent) >= 2 ? 'editor' : toggleOn && w.m.fileLevel(actor, f) >= 2 ? 'file_editor' : 'none'
  if (kind === 'hidden') expect = { status: 404 }
  else if (kind === 'personal') expect = { status: 409 }
  else if (want === 'leave') {
    const own = f.grants.get(`p:${actor}`)
    expect = own ? { status: 200, apply: () => { f.grants.delete(`p:${actor}`) } } : { status: 400 }
  } else if (kind === 'none') expect = { status: 403 }
  else if (want === 'remove') {
    if (isGeneral) {
      const above = w.m.subjectLevel(key, f.parent)
      if (above > 0) expect = { status: 400 }
      else expect = { status: 200, apply: () => { f.grants.delete(key) } }
    } else expect = prev ? { status: 200, apply: () => { f.grants.delete(key) } } : { status: 400 }
  } else {
    const inh = w.m.subjectLevel(key, f.parent)
    if (want < inh) expect = { status: 400 }
    else if (isGeneral) {
      const lv = want <= inh ? 0 : want
      if (lv === prev) expect = { status: 200 }
      else if ((kind === 'editor' || kind === 'file_editor') && lv > prev) expect = { status: 403 }
      else expect = { status: 200, apply: () => { if (lv) { f.grants.set(key, { level: lv, gen: w.m.groups.get(w.E)!.gen }); f.located = true; f.stale = false } else f.grants.delete(key) } }
    } else if (want === prev || (want <= inh && !prev)) expect = { status: 200 }
    else expect = { status: 200, apply: () => { f.grants.set(key, { level: want as number, gen: grp?.gen ?? 0 }); f.located = true; f.stale = false } }
  }
  // the API also gives the row a location whenever it writes a grant (any level > 0 in the request)
  let status = 200
  try {
    const res = await changeShare({ w: w.w, actor: person(w, actor), base: '' }, 'fuzz-session', body)
    if (res instanceof Response) status = res.status
  } catch (e) {
    if (!(e instanceof ApiError)) throw e
    status = e.status
  }
  if (status !== expect.status) throw violation('O1', `share ${JSON.stringify(body)} by ${actor} (${kind}): model ${expect.status}, real ${status}`)
  if (status === 200) expect.apply?.()
  return `share ${JSON.stringify({ ...body, path: undefined })} ${w.m.vpath(f)} by ${actor} (${kind}) -> ${status}`
}

// ---- folder rules and flags (the folder side, A1; direct writes like the folder page) ----
function folderRow(w: World, n: MNode): number {
  if (n.kind === 'mount') return n.row
  const real = w.m.real(n)
  const st = fs.lstatSync(real, { bigint: true })
  return ensureFolder(w.db, real, st.dev, st.ino, st.birthtimeNs)
}
function opRule(w: World) {
  const d = pk(w, liveDirs(w, { team: true }))
  const subj = pk(w, [...w.people.P.map((p) => `p:${p}`), `g:${w.G}`, `g:${w.E}`])
  const lv = pk(w, [0, 1, 1, 2])
  const id = folderRow(w, d)
  if (lv === 0) w.db.query('DELETE FROM rules WHERE folder_id = ? AND subject_type = ? AND subject_id = ?').run(id, subj[0] === 'p' ? 'person' : 'group', Number(subj.slice(2)))
  else w.db.query('INSERT INTO rules (folder_id, subject_type, subject_id, level) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET level = excluded.level').run(id, subj[0] === 'p' ? 'person' : 'group', Number(subj.slice(2)), lv)
  const rules = w.m.rulesOf(d)
  if (d.kind === 'mount') { if (lv) w.m.mountRules.get(d.id)!.set(subj, lv); else w.m.mountRules.get(d.id)!.delete(subj) } else if (lv) rules.set(subj, lv); else rules.delete(subj)
  return `rule ${w.m.vpath(d)} ${subj}=${lv}`
}
function opFlag(w: World) {
  const d = pk(w, liveDirs(w, { team: true }))
  const flag = pk(w, ['inherit_break', 'no_ai', 'no_ai', 'quarantine'] as const)
  if (flag === 'inherit_break' && d.kind === 'mount') throw new Skip()
  const id = folderRow(w, d)
  const cur = d.kind === 'mount' ? (flag === 'no_ai' ? w.m.mountFlags.get(d.id)!.noai : w.m.mountFlags.get(d.id)!.quar) : flag === 'inherit_break' ? d.brk : flag === 'no_ai' ? d.noai : d.quar
  const v = !cur
  w.db.query(`UPDATE folders SET ${flag} = ? WHERE id = ?`).run(v ? 1 : 0, id)
  if (d.kind === 'mount') { const fl = w.m.mountFlags.get(d.id)!; if (flag === 'no_ai') fl.noai = v; else fl.quar = v }
  else if (flag === 'inherit_break') d.brk = v; else if (flag === 'no_ai') d.noai = v; else d.quar = v
  return `flag ${w.m.vpath(d)} ${flag}=${v}`
}
function opMembership(w: World) {
  const g = w.m.groups.get(w.G)!
  const p = pk(w, w.people.P)
  if (g.members.has(p)) { w.db.query('DELETE FROM memberships WHERE group_id = ? AND person_id = ?').run(w.G, p); g.members.delete(p) }
  else { w.db.query('INSERT OR IGNORE INTO memberships (group_id, person_id) VALUES (?, ?)').run(w.G, p); g.members.add(p) }
  return `membership G ${p} -> ${g.members.has(p)}`
}
/** An older image deletes group G (it knows nothing of file grants) and another group takes the same id. */
function opGroupReuse(w: World) {
  const g = w.m.groups.get(w.G)!
  w.db.query('DELETE FROM memberships WHERE group_id = ?').run(w.G)
  w.db.query('DELETE FROM groups WHERE id = ?').run(w.G)
  w.db.query('INSERT INTO groups (id, name) VALUES (?, ?)').run(w.G, `G${g.gen + 1}`)
  const p = pk(w, w.people.P)
  w.db.query('INSERT INTO memberships (group_id, person_id) VALUES (?, ?)').run(w.G, p)
  g.gen++; g.members = new Set([p])
  return `group G deleted and remade (id ${w.G}) with ${p}`
}

// ---- an older image's writes ----
/** Old upload: the file and a row without uid (the trigger gives one), no location, no grants. */
function opOldUpload(w: World) {
  const p = pk(w, liveDirs(w, { team: true }))
  const name = `old-${w.r.int(1000)}.md`
  const real = path.join(w.m.real(p), name)
  if (fs.existsSync(real) || fs.readdirSync(w.m.real(p)).some((n) => nfc(n).toLowerCase() === name)) throw new Skip()
  const c = canary(w)
  fs.writeFileSync(real, c)
  const st = fs.lstatSync(real, { bigint: true })
  w.db.query('DELETE FROM mfiles WHERE dev = ? AND ino = ?').run(String(st.dev), String(st.ino)) // old trackNew: dropRow (no grant delete)
  w.db.query('INSERT INTO mfiles (dev, ino, size, mtime_ns, sha256, version, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, 1, ?, NULL, ?, NULL)')
    .run(String(st.dev), String(st.ino), Number(st.size), String(st.mtimeNs), sha256(c), Date.now(), Date.now())
  // whatever file had this identity before (a reused inode) is gone from the model already; the new one has no grants
  w.m.files.push({ kind: 'file', id: w.m.nextId++, name, parent: p, trash: null, canary: c, closed: false, grants: new Map(), located: false, stale: false, inert: false, versions: 1 })
  return `old upload ${w.m.vpath(p)}/${name}`
}
/** Old purge: rows (and versions) deleted without their grants; the trash item's bytes removed. */
function opOldPurge(w: World) {
  const items = [...trashItems.get(w)!].filter(([id, it]) => it.trash === id)
  if (!items.length) throw new Skip()
  const [id, it] = pk(w, items)
  const t = w.db.query<{ trash_path: string }, [number]>('SELECT trash_path FROM mtrash WHERE id = ?').get(id)!
  const walk: string[] = []
  const visit = (p: string) => { const st = fs.lstatSync(p); if (st.isDirectory()) for (const c of fs.readdirSync(p)) visit(path.join(p, c)); else walk.push(p) }
  try { visit(t.trash_path) } catch {}
  for (const p of walk) {
    const st = fs.lstatSync(p, { bigint: true })
    const row = w.db.query<{ id: number }, [string, string]>('SELECT id FROM mfiles WHERE dev = ? AND ino = ?').get(String(st.dev), String(st.ino))
    if (row) { w.db.query('DELETE FROM mversions WHERE file_id = ?').run(row.id); w.db.query('DELETE FROM mfiles WHERE id = ?').run(row.id) }
  }
  w.db.query('UPDATE mtrash SET purged_at = ? WHERE id = ?').run(Date.now(), id)
  fs.rmSync(path.dirname(t.trash_path), { recursive: true, force: true })
  forget(w, it); trashItems.get(w)!.delete(id)
  return `old purge #${id} (grant rows left)`
}
/** Old move: a file renamed on disk into another team folder; its location is not updated (stale until relocate). */
function opOldMove(w: World) {
  const f = pk(w, liveFiles(w).filter((x) => w.m.mountOf(x).personal == null))
  const to = pk(w, liveDirs(w, { team: true }).filter((d) => d !== f.parent))
  if (!to) throw new Skip()
  const name = `moved-${w.r.int(1000)}.md`
  const dest = path.join(w.m.real(to), name)
  if (fs.existsSync(dest)) throw new Skip()
  fs.renameSync(w.m.real(f), dest)
  f.parent = to; f.name = name
  if (f.located) f.stale = true
  return `old move ${w.m.vpath(f)}`
}
/** A shared file's row is forced onto another tracked file's identity (inode reuse as an older image could leave it). */
function opForceIdentity(w: World) {
  const shared = liveFiles(w).filter((f) => f.grants.size)
  if (!shared.length) throw new Skip()
  const a = pk(w, shared)
  const others = liveFiles(w).filter((f) => f !== a)
  if (!others.length) throw new Skip()
  const b = pk(w, others)
  const sa = fs.lstatSync(w.m.real(a), { bigint: true }), sb = fs.lstatSync(w.m.real(b), { bigint: true })
  const ra = w.db.query<{ id: number }, [string, string]>('SELECT id FROM mfiles WHERE dev = ? AND ino = ?').get(String(sa.dev), String(sa.ino))
  if (!ra) throw new Skip()
  w.db.query('DELETE FROM mfiles WHERE dev = ? AND ino = ?').run(String(sb.dev), String(sb.ino)) // old dropRow: B's grants left as orphans
  w.db.query('UPDATE mfiles SET dev = ?, ino = ? WHERE id = ?').run(String(sb.dev), String(sb.ino), ra.id)
  a.grants.clear(); b.grants.clear(); a.located = false; b.located = false
  return `force row of ${w.m.vpath(a)} onto ${w.m.vpath(b)}`
}
/** The operator edits a file by hand: its row no longer matches (size/mtime), so its grants open nothing (then rescan drops them). */
function opHandEdit(w: World) {
  const f = pk(w, liveFiles(w))
  const c = canary(w) + '-hand-edited'
  fs.writeFileSync(w.m.real(f), c)
  f.canary = c; f.grants.clear()
  return `hand edit ${w.m.vpath(f)}`
}
/** Hand-made names the policy closes: a system name and an NFC twin (both twins close). */
function opHandNames(w: World) {
  const d = pk(w, liveDirs(w, { team: true }))
  const real = w.m.real(d)
  if (w.r.chance(0.5)) {
    const name = '._' + pk(w, FILE_NAMES)
    if (fs.existsSync(path.join(real, name))) throw new Skip()
    fs.writeFileSync(path.join(real, name), canary(w))
    w.m.files.push({ kind: 'file', id: w.m.nextId++, name, parent: d, trash: null, canary: fs.readFileSync(path.join(real, name), 'utf8'), closed: true, grants: new Map(), located: false, stale: false, inert: false, versions: 1 })
    return `hand system name ${w.m.vpath(d)}/${name}`
  }
  const nfcName = pk(w, liveFiles(w).filter((f) => f.parent === d && nfc(f.name) !== f.name.normalize('NFD')))
  if (!nfcName) throw new Skip()
  const twin = nfcName.name.normalize('NFD')
  if (fs.readdirSync(real).includes(twin)) throw new Skip()
  fs.writeFileSync(path.join(real, twin), canary(w))
  if (!fs.readdirSync(real).includes(twin)) {
    // a normalization-insensitive file system (APFS): the same name — the operator overwrote the file by hand
    syncCanary(w, nfcName); nfcName.grants.clear()
    return `hand NFD write over ${w.m.vpath(nfcName)} (same name here)`
  }
  nfcName.closed = true
  w.m.files.push({ kind: 'file', id: w.m.nextId++, name: twin, parent: d, trash: null, canary: fs.readFileSync(path.join(real, twin), 'utf8'), closed: true, grants: new Map(), located: false, stale: false, inert: false, versions: 1 })
  return `hand NFD twin ${w.m.vpath(d)}/${twin}`
}
/** I7: a shared file's location forged to point at another file in its folder (or elsewhere): it must open nothing. */
function opForgeLocation(w: World) {
  const shared = liveFiles(w).filter((f) => f.located && f.grants.size)
  if (!shared.length) throw new Skip()
  const f = pk(w, shared)
  const st = fs.lstatSync(w.m.real(f), { bigint: true })
  const other = pk(w, liveFiles(w))
  w.db.query('UPDATE mfiles SET folder_id = ?, name = ? WHERE dev = ? AND ino = ?').run(folderRow(w, other.parent), other.name, String(st.dev), String(st.ino))
  f.stale = other !== f
  return `forge location of ${w.m.vpath(f)} -> ${w.m.vpath(other)}`
}
/** I11: a grant row forged for a file in a personal folder gives nothing. */
function opForgePersonal(w: World) {
  const pf = liveFiles(w).filter((f) => w.m.mountOf(f).personal != null)
  if (!pf.length) throw new Skip()
  const f = pk(w, pf)
  const st = fs.lstatSync(w.m.real(f), { bigint: true })
  const row = w.db.query<{ uid: string }, [string, string]>('SELECT uid FROM mfiles WHERE dev = ? AND ino = ?').get(String(st.dev), String(st.ino))
  if (!row) throw new Skip()
  const p = pk(w, w.people.P.slice(1))
  w.db.query("INSERT OR REPLACE INTO file_grants (file_uid, subject_type, subject_id, level, granted_at) VALUES (?, 'person', ?, 2, 0)").run(row.uid, p)
  w.db.query("UPDATE mfiles SET folder_id = ?, name = ? WHERE uid = ?").run(folderRow(w, f.parent), f.name, row.uid)
  f.grants.set(`p:${p}`, { level: 2, gen: 0 }) // the model ignores grants in personal folders (fileLevel → 0)
  return `forge personal grant ${w.m.vpath(f)} -> ${p}`
}

const OPS: [number, string, (w: World) => string | Promise<string>][] = [
  [8, 'upload', opUploadNew], [7, 'replace', opReplace], [3, 'restore-version', opRestoreVersion], [4, 'overreach', opFileEditorOverreach],
  [5, 'rename', opRename], [7, 'move', opMove], [3, 'copy', opCopy], [5, 'trash', opTrash], [4, 'restore', opRestore], [3, 'purge', opPurge],
  [1, 'expire', opExpire], [2, 'rescan', opRescan], [2, 'relocate', opRelocate], [3, 'mkdir', (w) => opMkdir(w)],
  [24, 'share', opShare], [7, 'rule', opRule], [5, 'flag', opFlag], [3, 'membership', opMembership], [1, 'group-reuse', opGroupReuse],
  [2, 'old-upload', opOldUpload], [2, 'old-purge', opOldPurge], [3, 'old-move', opOldMove], [1, 'force-identity', opForceIdentity],
  [1, 'hand-edit', opHandEdit], [1, 'hand-names', opHandNames], [2, 'forge-location', opForgeLocation], [1, 'forge-personal', opForgePersonal],
]
const TOTAL = OPS.reduce((n, o) => n + o[0], 0)
function pickOp(r: R) { let x = r.int(TOTAL); for (const o of OPS) { if (x < o[0]) return o; x -= o[0] } return OPS[0]! }

class ViolationError extends Error { constructor(readonly kind: string, readonly detail: string) { super(`${kind}: ${detail}`) } }
const violation = (kind: string, detail: string) => new ViolationError(kind, detail)

// ---------------------------------------------------------------- checks ---------------------------------------------
function accessOf(w: World, a: Aud) { return a.token ? Access.forToken(w.db, a.token) : Access.forPerson(w.db, a.person) }
function walk(acc: Access): { dirs: Set<string>; files: Set<string>; listed: Map<string, string[]> } {
  const dirs = new Set<string>(), files = new Set<string>(), listed = new Map<string, string[]>()
  const q: Entry[] = acc.rootEntries()
  while (q.length) {
    const e = q.shift()!
    if (e.kind === 'file') { files.add(e.vpath); continue }
    dirs.add(e.node.vpath)
    const kids = acc.list(e.node)
    listed.set(e.node.vpath, kids.map((k) => k.kind === 'dir' ? k.node.vpath : k.vpath))
    q.push(...kids)
  }
  return { dirs, files, listed }
}
const diff = (a: Set<string>, b: Set<string> | Map<string, unknown>) => [...a].filter((x) => !b.has(x))

/** I1, I2, I4, I6, I7, I8, I11 after every operation (Access level). */
function checkAccess(w: World): number {
  let n = 0
  const personView = new Map<number, Set<string>>()
  for (const a of w.auds) {
    const exp = w.m.expected(a)
    const got = walk(accessOf(w, a))
    n++
    const extraF = diff(got.files, exp.files), missF = diff(new Set(exp.files.keys()), got.files)
    const extraD = diff(got.dirs, exp.dirs), missD = diff(exp.dirs, got.dirs)
    if (extraF.length || missF.length || extraD.length || missD.length)
      throw violation('I1', `${a.label}: files +${JSON.stringify(extraF)} -${JSON.stringify(missF)} dirs +${JSON.stringify(extraD)} -${JSON.stringify(missD)}`)
    if (!a.agent) personView.set(a.person, got.files)
    else {
      const pv = personView.get(a.person)
      if (pv) { const more = diff(got.files, pv); if (more.length) throw violation('I8', `${a.label} sees ${JSON.stringify(more)} its person does not`) }
    }
  }
  return n
}

// ---- end of run: the real surfaces ----
const actorOf = (w: World, a: Aud) => person(w, a.person)
async function webJson(f: () => unknown | Promise<unknown>): Promise<{ status: number; body: string; data: any }> {
  try {
    const v = await f()
    if (v instanceof Response) { const t = await v.text(); return { status: v.status, body: t, data: null } }
    return { status: 200, body: JSON.stringify(v), data: v }
  } catch (e) {
    if (e instanceof ApiError) return { status: e.status, body: JSON.stringify({ error: e.code, message: e.message }), data: null }
    throw e
  }
}
const U = (p: string) => new URL('http://drive.test/x?path=' + encodeURIComponent(p))

async function checkSurfaces(w: World): Promise<number> {
  let n = 0
  await managedIdle(w.db)
  const allCanaries = new Map<string, MFile[]>()
  for (const f of w.m.files) allCanaries.set(f.canary, [...allCanaries.get(f.canary) ?? [], f])
  const allowedFor = (exp: Map<string, MFile>) => new Set([...exp.values()].map((f) => f.canary))
  const leaks = (out: string, allowed: Set<string>) => [...out.matchAll(/CANARY-[0-9]+-[0-9]+-[0-9a-f]{6}(-hand-edited)?/g)].map((m) => m[0]).filter((c) => !allowed.has(c))
  const missingBody = new Map<string, string>()
  for (const a of w.persons) {
    const act = actorOf(w, a)
    const exp = w.m.expected(a)
    const allowed = allowedFor(exp.files)
    // web list of every visible folder: exactly the expected children
    for (const d of exp.dirs) {
      const r = await webJson(() => files.list(w.w, act, U(d)))
      n++
      if (r.status !== 200) throw violation('I2', `${a.label} list ${d}: ${r.status}`)
      const names = (r.data.entries as { path: string; size: number | null }[]).map((x) => x.path)
      const want = [...exp.dirs, ...exp.files.keys()].filter((p) => p.slice(0, p.lastIndexOf('/')) === d)
      if (names.sort().join('|') !== want.sort().join('|')) throw violation('I2', `${a.label} list ${d}: ${JSON.stringify(names)} vs ${JSON.stringify(want)}`)
      if (!r.data.readable && (r.data.entries as { kind: string; size: number | null; mtime: number | null }[]).some((x) => x.kind === 'folder' && (x.size !== null || x.mtime !== null))) throw violation('I2', `bare folder sizes shown in ${d}`)
    }
    // every model file: readable → 200 with its canary; else → 404 byte-identical to a path that does not exist
    for (const f of w.m.files) {
      if (w.m.trashed(f)) continue // its old path may hold another file now
      const vp = w.m.vpath(f)
      if (exp.files.has(vp) && exp.files.get(vp) !== f) continue // a closed twin on the same NFC path
      const r = await webJson(() => files.download(w.w, act, U(vp)))
      n++
      if (exp.files.has(vp)) {
        if (r.status !== 200 || !r.body.includes(f.canary)) throw violation('I1', `${a.label} download ${vp}: ${r.status} ${r.body.slice(0, 80)} (model: ${f.canary}${process.env.FUZZ_DEBUG ? ' ' + JSON.stringify(w.m.files.map((x) => [w.m.vpath(x), x.canary, w.m.trashed(x), x.closed])) : ''})`)
        const v = await webJson(() => mweb.versions(w.w, act, U(vp)))
        const fileOnly = !w.m.canReadDir(a, f.parent) && w.m.mountOf(f).personal == null
        const editor = Math.max(w.m.level(a.person, f.parent), w.m.fileLevel(a.person, f)) >= 2
        if (v.status !== 200 || v.data.history !== (fileOnly && !editor ? 'editors_only' : 'all')) throw violation('F7', `${a.label} versions ${vp}: ${v.body.slice(0, 200)}`)
        if (fileOnly && !a.agent) {
          const who = await webJson(() => files.who(w.w, act, U(vp)))
          if (a.person !== w.people.O && !who.data?.restricted) throw violation('I2', `${a.label} who ${vp} shows the folder's readers`)
        }
      } else {
        const probe = vp.slice(0, vp.lastIndexOf('/') + 1) + 'zz-missing-' + vp.slice(vp.lastIndexOf('/') + 1)
        let miss = missingBody.get(probe)
        if (miss === undefined) { miss = (await webJson(() => files.download(w.w, act, U(probe)))).body; missingBody.set(probe, miss) }
        if (r.status !== 404 || r.body !== miss) throw violation('I3', `${a.label} download hidden ${vp}: ${r.status} ${r.body.slice(0, 80)}`)
        const s = await webJson(() => sharedOr404(w, act, vp))
        if (s.status !== 404) throw violation('I3', `${a.label} /api/share on hidden ${vp}: ${s.status}`)
      }
    }
    // search: hits only readable files or visible folders, no foreign canary
    const sr = await webJson(() => files.search(w.w, act, new URL('http://drive.test/x?q=CANARY')))
    n++
    for (const h of (sr.data?.results ?? []) as { path: string; kind: string; snippets: { text: string }[] }[]) {
      if (h.kind === 'file' && !exp.files.has(h.path)) throw violation('I13', `${a.label} search hit ${h.path}`)
      if (h.kind === 'folder' && !exp.dirs.has(h.path)) throw violation('I13', `${a.label} search folder ${h.path}`)
      const lk = leaks(h.snippets.map((s) => s.text).join('\n'), allowed)
      if (lk.length) throw violation('I13', `${a.label} search leaks ${lk}`)
    }
    // Shared with me: exactly the reachable files shared with P directly or through G (not Everyone), not by P
    const sw = await webJson(() => sharedWithMe(w.w, act))
    const gotFiles = new Set((sw.data.items as { kind: string; path: string }[]).filter((x) => x.kind === 'file').map((x) => x.path))
    for (const p of gotFiles) if (!exp.files.has(p)) throw violation('I5', `${a.label} shared-with-me lists ${p}`)
    // Recent: only what is visible now
    const rc = await webJson(() => recent(w.w, act, new URL('http://drive.test/x?limit=100')))
    for (const x of rc.data.items as { path: string }[]) if (!exp.files.has(x.path)) throw violation('I5', `${a.label} recent lists ${x.path}`)
    n += 2
  }
  // WebDAV: PROPFIND Depth: infinity and GET, for one person per run
  n += await checkDav(w, pk(w, w.persons.filter((a) => a.person !== w.people.O)))
  // MCP shell per token
  for (const a of w.auds.filter((x) => x.token)) {
    const exp = w.m.expected(a)
    const allowed = allowedFor(exp.files)
    const s = new Session(w.ctx, a.token!)
    const out = await runShell(s, 'ls -R / ; find / ; du -a / ; grep -r CANARY / ; wc -c /*/* 2>/dev/null')
    s.commit('bash', 'fuzz', 'ok')
    n++
    const text = out.stdout + out.stderr
    const lk = leaks(text, allowed)
    if (lk.length) throw violation('I13', `${a.label} shell leaks ${lk.slice(0, 3)}`)
    // cat every model file: readable ones show their canary; hidden ones answer like a missing name
    const vps = w.m.files.filter((f) => !w.m.trashed(f)).map((f) => w.m.vpath(f))
    if (vps.length) {
      const s2 = new Session(w.ctx, a.token!)
      const cats = await runShell(s2, vps.map((p) => `cat '${p.replace(/'/g, `'\\''`)}'`).join(' ; '))
      s2.commit('bash', 'fuzz cat', 'ok')
      n++
      const lk2 = leaks(cats.stdout + cats.stderr, allowed)
      if (lk2.length) throw violation('I13', `${a.label} cat leaks ${lk2.slice(0, 3)}`)
      for (const [vp, f] of exp.files) if (!cats.stdout.includes(f.canary)) throw violation('I1', `${a.label} cat ${vp} missing its content`)
      // I9: a file read only through a share records its folder as a strong via_file source
      const viaOnly = [...exp.files.values()].filter((f) => !w.m.canReadDir(a, f.parent))
      for (const f of viaOnly) {
        const st = fs.lstatSync(w.m.real(f.parent), { bigint: true })
        const row = w.db.query<{ via_file: number | null; strong_at: number | null }, [number, string, string]>(
          'SELECT t.via_file, t.strong_at FROM touches t JOIN folders f ON f.id = t.folder_id WHERE t.token_id = ? AND f.dev = ? AND f.ino = ?').get(a.token!.id, String(st.dev), String(st.ino))
        if (!row || row.strong_at == null) throw violation('I9', `${a.label} read ${w.m.vpath(f)} through a share but no source recorded`)
      }
      // I3 on the shell: a hidden path and a missing one give the same message (one sample)
      const hidden = w.m.files.filter((f) => !w.m.trashed(f) && !exp.files.has(w.m.vpath(f)))
      if (hidden.length) {
        const h = pk(w, hidden)
        const hp = w.m.vpath(h)
        const mp = hp.slice(0, hp.lastIndexOf('/') + 1) + 'x'.repeat(Math.max(1, [...h.name].length))
        const s3 = new Session(w.ctx, a.token!)
        const r1 = await runShell(s3, `cat '${hp}'; ls '${hp}'; stat '${hp}'`)
        const r2 = await runShell(s3, `cat '${mp}'; ls '${mp}'; stat '${mp}'`)
        s3.commit('bash', 'fuzz probe', 'ok')
        if (r1.stdout !== r2.stdout || r1.stderr.split(hp).join('P') !== r2.stderr.split(mp).join('P') || r1.exitCode !== r2.exitCode) throw violation('I3', `${a.label} shell: hidden ${hp} differs from missing`)
        n++
      }
    }
  }
  // I14: a Bearer token never reaches the share API
  const tok = createToken(w.db, 'P1', { name: `bearer-${w.r.int(1e9)}` }).token
  const res = await handleWeb(w.w, new Request('http://drive.test/api/share?path=' + encodeURIComponent('/T1'), { headers: { authorization: `Bearer ${tok}` } }), '10.0.0.1')
  if (res.status !== 401) throw violation('I14', `Bearer on /api/share: ${res.status}`)
  const v = verifyAudit(w.db)
  if (!v.ok) throw violation('audit', `audit chain broken at ${v.brokenAt}`)
  return n + 2
}
/** GET /api/share for a path: hidden == missing. */
function sharedOr404(w: World, act: { personId: number; admin: boolean }, vp: string) { return shareView(w.w, act, vp) }

async function checkDav(w: World, a: Aud): Promise<number> {
  const secret = 'tdrive_app_' + sha256(String(Math.random())).slice(0, 32)
  w.db.exec(`CREATE TABLE IF NOT EXISTS app_passwords (id INTEGER PRIMARY KEY, person_id INTEGER NOT NULL REFERENCES people(id), name TEXT NOT NULL, secret_hash TEXT NOT NULL UNIQUE,
    hint TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER, last_used_addr TEXT, revoked_at INTEGER)`)
  const pw = APP_PASSWORD_PREFIX + secret.slice(-32)
  w.db.query('INSERT INTO app_passwords (person_id, name, secret_hash, hint, created_at) VALUES (?, ?, ?, ?, ?)').run(a.person, 'fuzz', sha256(pw), 'x', Date.now())
  const name = w.db.query<{ name: string }, [number]>('SELECT name FROM people WHERE id = ?').get(a.person)!.name
  const auth = 'Basic ' + Buffer.from(`${name}:${pw}`).toString('base64')
  const dav = async (method: string, p: string, headers: Record<string, string> = {}) => {
    const url = 'https://drive.test/dav' + p.split('/').map(encodeURIComponent).join('/')
    const r = await handleWeb(w.w, new Request(url, { method, headers: { authorization: auth, ...headers } }), '10.0.0.1')
    return { status: r.status, text: await r.text() }
  }
  const exp = w.m.expected(a)
  // the whole tree, folder by folder (Depth: 1; this server refuses infinity with propfind-finite-depth, RFC 4918)
  const hrefs = new Set<string>()
  const queue = ['/']
  while (queue.length) {
    const at = queue.shift()!
    const pf = await dav('PROPFIND', at, { depth: '1' })
    if (pf.status !== 207) throw violation('dav', `PROPFIND ${at} ${pf.status} ${pf.text.slice(0, 120)}`)
    for (const m of pf.text.matchAll(/<d:href>([^<]*)<\/d:href>/g)) {
      const raw = decodeURIComponent(m[1]!).replace(/^\/dav/, '')
      const p = raw.replace(/\/$/, '')
      if (!p || p === at.replace(/\/$/, '') || hrefs.has(p)) continue
      hrefs.add(p)
      if (raw.endsWith('/')) queue.push(p)
    }
  }
  const want = new Set([...exp.dirs, ...exp.files.keys()])
  const extra = diff(hrefs, want), miss = diff(want, hrefs)
  if (extra.length || miss.length) throw violation('I1', `${a.label} PROPFIND +${JSON.stringify(extra)} -${JSON.stringify(miss)}`)
  // bare folders: one synthetic date for all of them (never their own birth time)
  const bare = [...exp.dirs].filter((d) => { const node = [...w.m.mounts, ...w.m.dirs].find((x) => !w.m.trashed(x) && w.m.vpath(x) === d); return node && !w.m.canReadDir(a, node) })
  if (bare.length) {
    const dates = new Set<string>()
    for (const d of bare) {
      const r = await dav('PROPFIND', d, { depth: '0' })
      dates.add(/<d:getlastmodified>([^<]*)</.exec(r.text)?.[1] ?? '?')
    }
    if (dates.size !== 1) throw violation('I2', `${a.label} bare folders show their own dates: ${[...dates]}`)
  }
  for (const f of w.m.files.filter((x) => !w.m.trashed(x))) {
    const vp = w.m.vpath(f)
    const r = await dav('GET', vp)
    if (exp.files.has(vp) ? r.status !== 200 || !r.text.includes(f.canary) : r.status !== 404) throw violation(exp.files.has(vp) ? 'I1' : 'I3', `${a.label} DAV GET ${vp}: ${r.status}`)
  }
  return 2
}

// ---------------------------------------------------------------- driver ---------------------------------------------
export async function oneRun(run: number, seed: number, opts: { ops?: [number, number]; surfaces?: boolean } = {}): Promise<{ ops: number; checks: number; violation?: Violation }> {
  const prev = process.env.TDRIVE_SHELL
  process.env.TDRIVE_SHELL = 'inprocess'
  let w: World | null = null
  let opN = 0, checks = 0
  const log: string[] = []
  try {
    w = freshWorld(run, seed)
    trashItems.set(w, new Map())
    checks += checkAccess(w)
    const [lo, hi] = opts.ops ?? [20, 40]
    const count = lo + w.r.int(hi - lo + 1)
    for (opN = 1; opN <= count; opN++) {
      const op = pickOp(w.r)
      let line: string
      try { line = await op[2](w) } catch (e) {
        if (e instanceof Skip) { log.push(`${opN} ${op[1]}: skip`); continue }
        throw e
      }
      log.push(`${opN} ${line}`)
      checks += checkAccess(w)
    }
    if (opts.surfaces !== false) checks += await checkSurfaces(w)
    return { ops: opN - 1, checks }
  } catch (e) {
    if (e instanceof ViolationError) return { ops: opN, checks, violation: { run, seed, op: opN, kind: e.kind, detail: e.detail, log } }
    return { ops: opN, checks, violation: { run, seed, op: opN, kind: 'crash', detail: String((e as Error)?.stack ?? e).slice(0, 2000), log } }
  } finally {
    if (prev === undefined) delete process.env.TDRIVE_SHELL; else process.env.TDRIVE_SHELL = prev
    if (w) { try { await managedIdle(w.db) } catch {} try { w.db.close() } catch {} fs.rmSync(w.dir, { recursive: true, force: true }) }
  }
}

/** Seeds per run: seed + run (so any failing run replays alone with FUZZ_ONE). */
export async function runManagedFuzz(o: { runs: number; seed: number; from?: number; log?: (s: string) => void; maxViolations?: number; surfaces?: boolean }): Promise<MFuzzStats> {
  const t0 = Date.now()
  const stats: MFuzzStats = { runs: 0, ops: 0, checks: 0, violations: [], ms: 0, deepRuns: 0 }
  for (let i = o.from ?? 0; i < (o.from ?? 0) + o.runs; i++) {
    const r = await oneRun(i, o.seed + i, { surfaces: o.surfaces })
    stats.runs++; stats.ops += r.ops; stats.checks += r.checks
    if (o.surfaces !== false) stats.deepRuns++
    if (r.violation) {
      stats.violations.push(r.violation)
      o.log?.(`VIOLATION run ${i} seed ${r.violation.seed} op ${r.violation.op} ${r.violation.kind}: ${r.violation.detail}\n  ${r.violation.log.slice(-8).join('\n  ')}`)
      if (stats.violations.length >= (o.maxViolations ?? 5)) break
    }
    if (o.log && (i + 1) % 250 === 0) o.log(`[managed-fuzz] ${i + 1 - (o.from ?? 0)}/${o.runs} runs, ${stats.violations.length} violations, ${Math.round((Date.now() - t0) / 1000)} s`)
  }
  stats.ms = Date.now() - t0
  return stats
}

// ---------------------------------------------------------------- CLI ------------------------------------------------
if (import.meta.main) {
  const seed = Number(process.env.FUZZ_SEED ?? 20261023)
  const one = process.env.FUZZ_ONE
  if (one) {
    const r = await oneRun(0, Number(one))
    console.log(r.violation ? `VIOLATION ${r.violation.kind}: ${r.violation.detail}\n${r.violation.log.join('\n')}` : `ok: ${r.ops} ops, ${r.checks} checks`)
    process.exit(r.violation ? 1 : 0)
  }
  const runs = Number(process.env.FUZZ_RUNS ?? 300)
  const workers = Number(process.env.FUZZ_WORKERS ?? 1)
  const from = Number(process.env.FUZZ_FROM ?? 0)
  if (workers > 1 && !process.env.FUZZ_CHILD) {
    const per = Math.ceil(runs / workers)
    const t0 = Date.now()
    const kids = Array.from({ length: workers }, (_, k) => Bun.spawn(['bun', 'run', import.meta.path], {
      env: { ...process.env, FUZZ_CHILD: '1', FUZZ_FROM: String(from + k * per), FUZZ_RUNS: String(Math.max(0, Math.min(per, runs - k * per))) }, stdout: 'pipe', stderr: 'inherit',
    }))
    const outs = await Promise.all(kids.map(async (k) => { const t = await new Response(k.stdout).text(); await k.exited; return t }))
    let total = 0, ops = 0, checks = 0, viol = 0
    for (const t of outs) {
      const m = /RESULT (\{.*\})/.exec(t)
      process.stdout.write(t.replace(/RESULT \{.*\}\n?/, ''))
      if (m) { const s = JSON.parse(m[1]!); total += s.runs; ops += s.ops; checks += s.checks; viol += s.violations } else viol++
    }
    console.log(`[managed-fuzz] seed ${seed}: ${total} runs, ${ops} operations, ${checks} checks, ${viol} violations, ${Math.round((Date.now() - t0) / 1000)} s (${workers} workers)`)
    process.exit(viol ? 1 : 0)
  }
  const stats = await runManagedFuzz({ runs, seed, from, log: (s) => console.log(s) })
  if (process.env.FUZZ_CHILD) console.log(`RESULT ${JSON.stringify({ runs: stats.runs, ops: stats.ops, checks: stats.checks, violations: stats.violations.length })}`)
  else console.log(`[managed-fuzz] seed ${seed}: ${stats.runs} runs, ${stats.ops} operations, ${stats.checks} checks, ${stats.violations.length} violations, ${Math.round(stats.ms / 1000)} s`)
  process.exit(stats.violations.length ? 1 : 0)
}
