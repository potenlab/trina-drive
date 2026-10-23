// Rollback safety of file-level sharing (A2; memo §10, §11.4; scenario S49 at source level — H2 repeats it with the
// Phase 1 product image). The new code makes a world with file shares; an OLDER checkout's own code then works on the
// same data directory (upload, replace, rename + move a shared file, trash + purge, rescan, delete a group and reuse
// its id, purge + upload for inode reuse) and every step must succeed; then the new code opens it again and nothing
// opens that should not, while what should comes back (after the boot relocate).
//
// Refs: ROLLBACK_REFS (comma-separated) or the defaults below: main before A2 (Phase 1 with A1 folder sharing) and
// ea57553 (before the W0 seams). A ref missing from a shallow clone is fetched; if that fails the ref is skipped loudly.
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'bun:test'
import { openDb, type DB } from '../src/db'
import { relocateShared, stageBytes } from '../src/managed/core'
import { createManagedFolder } from '../src/managed/folders'
import { Managed, managedIdle, rescan } from '../src/managed/ops'
import { metaSet } from '../src/managed/settings'
import { splitVirtual } from '../src/names'
import { Access, type FileEntry } from '../src/policy'
import { makeCtx, Session } from '../src/session'
import { runShell } from '../src/shell'
import { addGroup, addMember, addPerson, createToken, verifyToken } from '../src/store'
import { canSeeDraft, liveDrafts } from '../src/drafts'
import { changeShare } from '../src/share/service'
import { OutboxMailer } from '../src/web/mail'
import { makeWebCtx } from '../src/web/server'

const REPO = path.resolve(import.meta.dir, '..')
const REFS = (process.env.ROLLBACK_REFS ?? '3c2fd9d5a3786ba2360aea5e97b4d363ab642149,ea57553ac8e9ae5f35c9570afc42ad8e15b75f13').split(',').map((s) => s.trim()).filter(Boolean)

const git = (...args: string[]) => execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
function haveRef(ref: string): boolean {
  try { git('cat-file', '-e', `${ref}^{commit}`); return true } catch {}
  try { git('fetch', '--quiet', '--depth=1', 'origin', ref); git('cat-file', '-e', `${ref}^{commit}`); return true } catch { return false }
}
function oldCheckout(ref: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdrive-old-'))
  git('worktree', 'add', '--detach', '--force', dir, ref)
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'))
  return dir
}
const dropCheckout = (dir: string) => { try { git('worktree', 'remove', '--force', dir) } catch { fs.rmSync(dir, { recursive: true, force: true }); try { git('worktree', 'prune') } catch {} } }

/** The new code's world: files f1–f6 in /T/d1 and /T/d2; f1 → P1, f2 → G (P2), f3 → P1; P1's AI drafts from f1 (via file). */
async function newWorld(dir: string) {
  const db = openDb(dir)
  metaSet(db, 'storage_mode', 'managed')
  const ctx = makeCtx(db, dir)
  const w = makeWebCtx(ctx, { mailer: new OutboxMailer(dir, true), webDir: '/nonexistent' })
  const O = addPerson(db, 'O', true).id, P1 = addPerson(db, 'P1').id, P2 = addPerson(db, 'P2').id, P3 = addPerson(db, 'P3').id
  const G = addGroup(db, 'G'); addMember(db, 'G', 'P2')
  const T = createManagedFolder(db, dir, { name: 'T' })
  db.query("INSERT INTO rules (folder_id, subject_type, subject_id, level) VALUES (?, 'person', ?, 2)").run(T.id, O)
  const m = new Managed(ctx, O)
  m.mkdir('/T', 'd1'); m.mkdir('/T', 'd2')
  const put = (d: string, n: string, t: string) => m.put(d, n, stageBytes(m.s.root, Buffer.from(t)), 'fail')
  for (const i of [1, 2, 3]) put('/T/d1', `f${i}.md`, `F${i} CANARY-F${i}`)
  for (const i of [4, 5, 6]) put('/T/d2', `f${i}.md`, `F${i} CANARY-F${i}`)
  const share = async (p: string, subject: { type: 'person' | 'group'; id: number }) => {
    const r = await changeShare({ w, actor: { personId: O, admin: true }, base: '' }, 's', { path: p, add: [{ subject, role: 'viewer' }], notify: false })
    if (r instanceof Response) throw new Error(`share ${p}: ${r.status}`)
  }
  await share('/T/d1/f1.md', { type: 'person', id: P1 })
  await share('/T/d1/f2.md', { type: 'group', id: G })
  await share('/T/d1/f3.md', { type: 'person', id: P1 })
  const tok = verifyToken(db, createToken(db, 'P1', { name: 'p1-ai' }).token)!
  const s = new Session(ctx, tok)
  const r = await runShell(s, "cat /T/d1/f1.md > /drafts/digest.md")
  s.commit('bash', 'draft', `exit ${r.exitCode}`)
  // the draft's bytes uploaded into /T: a tracked AI-draft copy (R6)
  const draftBytes = fs.readFileSync(path.join(ctx.blobs.dir, liveDrafts(db, P1)[0]!.sha256.slice(0, 2), liveDrafts(db, P1)[0]!.sha256))
  m.put('/T/d2', 'copy.md', stageBytes(m.s.root, draftBytes), 'fail')
  await managedIdle(db)
  db.close()
  return { O, P1, P2, P3, G, tokId: tok.id }
}

const read = (db: DB, pid: number, vp: string): string | null => {
  const a = Access.forPerson(db, pid)
  const e = a.lookup(splitVirtual(vp))
  if (!e || e.kind !== 'file') return null
  return Buffer.from(a.readBytes(e as FileEntry, 1 << 20)).toString('utf8')
}
const walk = (db: DB, pid: number) => {
  const a = Access.forPerson(db, pid)
  const out: string[] = []
  const q = a.rootEntries()
  while (q.length) { const e = q.shift()!; if (e.kind === 'file') out.push(e.vpath); else { out.push(e.node.vpath + '/'); q.push(...a.list(e.node)) } }
  return out.sort()
}

describe('rollback to an older image and forward again (memo §11.4, S49)', () => {
  for (const ref of REFS) {
    test(`old code ${ref.slice(0, 7)} works on the new database; the new code reopens it safely`, async () => {
      if (!haveRef(ref)) { console.warn(`[rollback] SKIPPED ${ref}: not in this clone and could not be fetched`); return }
      const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tdrive-rb-')))
      const old = oldCheckout(ref)
      try {
        const ids = await newWorld(dir)
        const namesFile = path.join(dir, 'names.json')
        fs.writeFileSync(namesFile, JSON.stringify({ O: ids.O, P1: ids.P1, P3: ids.P3, G: ids.G, mount: 'T' }))
        const r = spawnSync('bun', [path.join(import.meta.dir, 'fixtures', 'rollback-old-steps.ts'), old, dir, namesFile], { encoding: 'utf8', env: { ...process.env, TDRIVE_SHELL: 'inprocess' } })
        if (r.status !== 0) console.error(r.stdout, r.stderr)
        expect(r.status).toBe(0)

        // ---- forward again: the new code opens the same directory (migrations run) ----
        const db = openDb(dir)
        try {
          // orphans of the old purge and of the deleted group are gone; nobody gains through them
          const f2Grants = db.query<{ n: number }, []>("SELECT count(*) AS n FROM file_grants WHERE subject_type = 'group'").get()!.n
          expect(f2Grants).toBe(0)
          expect(db.query<{ n: number }, []>('SELECT count(*) AS n FROM file_grants WHERE file_uid NOT IN (SELECT uid FROM mfiles WHERE uid IS NOT NULL)').get()!.n).toBe(0)
          expect(walk(db, ids.P3)).toEqual([]) // H's member reads nothing through G's old grant
          expect(walk(db, ids.P2)).toEqual([])
          // every row has a uid (old inserts were filled); f7 and f8 have no grants
          expect(db.query<{ n: number }, []>('SELECT count(*) AS n FROM mfiles WHERE uid IS NULL').get()!.n).toBe(0)
          // P1 reads f1 with the old image's new bytes (same uid kept through the replace)
          expect(read(db, ids.P1, '/T/d1/f1.md')).toContain('CANARY-F1-NEW')
          // f3 moved by the old image: its location is stale → closed (inert) until relocate, then it follows
          expect(read(db, ids.P1, '/T/d2/f3-renamed.md')).toBeNull()
          expect(read(db, ids.P1, '/T/d1/f3.md')).toBeNull()
          expect(relocateShared(db)).toMatchObject({ moved: 1, partial: false })
          expect(read(db, ids.P1, '/T/d2/f3-renamed.md')).toContain('CANARY-F3')
          expect(walk(db, ids.P1)).toEqual(['/T/', '/T/d1/', '/T/d1/f1.md', '/T/d2/', '/T/d2/f3-renamed.md'])
          for (const n of ['f7.md', 'f8.md', 'f5.md', 'f6.md']) for (const pid of [ids.P1, ids.P2, ids.P3]) expect(read(db, pid, `/T/${n === 'f7.md' ? 'd1' : 'd2'}/${n}`)).toBeNull()
          // the via-file draft is visible to P1's AI again (sealed on the old image: fail closed)
          const tok = db.query<any, [number]>('SELECT * FROM tokens WHERE id = ?').get(ids.tokId)
          const d = liveDrafts(db, ids.P1)
          expect(d.length).toBe(1)
          expect(canSeeDraft(Access.forToken(db, tok), tok, d[0]!)).toBe(true)
          // the new code uploads, purges and rescans with orphan grant rows present (no foreign key anywhere)
          db.query("INSERT INTO file_grants (file_uid, subject_type, subject_id, level, granted_at) VALUES ('deadbeef', 'person', ?, 2, 0)").run(ids.P1)
          const ctx = makeCtx(db, dir)
          const m = new Managed(ctx, ids.O)
          expect(m.put('/T/d1', 'f9.md', stageBytes(m.s.root, Buffer.from('F9')), 'fail').path).toBe('/T/d1/f9.md')
          const tid = m.removeOne('/T/d1/f1.md')
          expect(m.purge(tid)).toEqual({ ok: true })
          expect(db.query<{ n: number }, []>('SELECT count(*) AS n FROM file_grants WHERE subject_id = ? AND file_uid != ?').get(ids.P1, 'deadbeef')!.n).toBe(1) // f3's only
          expect(rescan(ctx).partial).toBeUndefined()
          expect(read(db, ids.P1, '/T/d1/f9.md')).toBeNull()
          await managedIdle(db)
        } finally { db.close() }
      } finally {
        dropCheckout(old)
        fs.rmSync(dir, { recursive: true, force: true })
      }
    }, 120_000)
  }
})
