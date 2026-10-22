// Audit anchors: a rewritten history is caught even when every hash was recomputed.
import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { verifyAudit } from '../src/audit'
import { main } from '../src/cli'
import { anchorKey, listAnchors, parseAnchor, verifyAgainst } from '../src/notify/anchor'
import { sha256 } from '../src/store'
import { setup, type Env } from './helpers'
import { readOutbox, withNotify } from './notify-helpers'

const cleanups: (() => void)[] = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })
const env = () => { const e = setup(); cleanups.push(e.cleanup); return e }

/** What an operator with the database would do: change rows, then recompute the whole chain so it verifies. */
function rewriteChain(e: Env, change: () => void) {
  change()
  let prev = '0'.repeat(64)
  for (const r of e.db.query<{ id: number; at: number; person_id: number | null; token_id: number | null; tool: string; command: string; command_sha256: string; files: string; outcome: string }, []>('SELECT * FROM audit ORDER BY id').all()) {
    const hash = sha256(prev + '\n' + JSON.stringify([r.at, r.person_id, r.token_id, r.tool, r.command, r.command_sha256, r.files, r.outcome]))
    e.db.query('UPDATE audit SET prev_hash = ?, hash = ? WHERE id = ?').run(prev, hash, r.id)
    prev = hash
  }
  expect(verifyAudit(e.db).ok).toBe(true)
}

async function anchored() {
  const e = env()
  const outside = path.join(e.dir, '..', path.basename(e.dir) + '-anchors')
  cleanups.push(() => fs.rmSync(outside, { recursive: true, force: true }))
  const n = withNotify(e, { anchor: { intervalMs: 0, email: true, dir: outside } })
  n.rt.notifier.setContact(n.pid('dion'), { email: 'admin@example.test' })
  for (const c of ['ls /', 'cat /프로젝트/README.md', 'grep -r 견적 /']) await e.sh('kim', c)
  const r = (await n.rt.anchorNow())!
  expect(r.file).toBeDefined()
  return { e, n, r, file: r.file! }
}

describe('audit anchor', () => {
  test('signed, written outside, mailed to admins; unchanged chain is not re-anchored', async () => {
    const { e, n, r, file } = await anchored()
    expect(r.anchor.anchor.count).toBe(3)
    expect(parseAnchor(fs.readFileSync(file, 'utf8'))).toEqual(r.anchor)
    expect(listAnchors(e.db).map((a) => [a.count, a.head, a.file])).toEqual([[3, r.anchor.anchor.head, file]])
    expect(fs.statSync(path.join(e.dir, 'anchor', 'ed25519.key')).mode & 0o777).toBe(0o600)
    expect(await n.rt.anchorNow()).toBeNull()
    const mail = readOutbox(n.outbox)
    expect(mail.length).toBe(1)
    expect(mail[0]!.subject).toBe('[Trina Drive] Audit anchor: 3 rows')
    // the emailed copy is just as good as the file
    expect(parseAnchor(mail[0]!.raw)).toEqual(r.anchor)
    expect(verifyAgainst(e.db, e.dir, parseAnchor(mail[0]!.raw)).ok).toBe(true)
  })

  test('appending after the anchor is fine', async () => {
    const { e, file } = await anchored()
    await e.sh('kim', 'ls /공용')
    expect(verifyAgainst(e.db, e.dir, parseAnchor(fs.readFileSync(file, 'utf8')))).toMatchObject({ ok: true, problems: [] })
  })

  test('a rewritten row before the anchor, with the chain recomputed, is detected', async () => {
    const { e, file } = await anchored()
    rewriteChain(e, () => e.db.query("UPDATE audit SET command = 'ls /', files = '[]' WHERE id = 2").run())
    const c = verifyAgainst(e.db, e.dir, parseAnchor(fs.readFileSync(file, 'utf8')))
    expect(c.ok).toBe(false)
    expect(c.problems).toEqual(['row 3 no longer has the anchored hash (history before the anchor was rewritten)'])
  })

  test('deleted rows (chain recomputed) are detected, whether or not new rows were added after', async () => {
    const { e, file } = await anchored()
    const a = parseAnchor(fs.readFileSync(file, 'utf8'))
    rewriteChain(e, () => e.db.query('DELETE FROM audit WHERE id = 2').run())
    expect(verifyAgainst(e.db, e.dir, a).problems).toEqual(['audit log has 2 rows but the anchor covers 3 (rows were removed)'])
    await e.sh('kim', 'ls /')
    expect(verifyAgainst(e.db, e.dir, a).problems).toEqual(['row 3 no longer has the anchored hash (history before the anchor was rewritten)'])
  })

  test('an edited anchor file or a replaced key is detected', async () => {
    const { e, file } = await anchored()
    const a = parseAnchor(fs.readFileSync(file, 'utf8'))
    const forged = { ...a, anchor: { ...a.anchor, count: 2 } }
    expect(verifyAgainst(e.db, e.dir, forged).problems).toContain('anchor signature does not verify (the anchor file was altered)')
    fs.rmSync(path.join(e.dir, 'anchor'), { recursive: true })
    anchorKey(e.dir)
    expect(verifyAgainst(e.db, e.dir, a).problems).toEqual(['anchor was signed by a different key than this install has now (key replaced?)'])
  })

  test('CLI: audit verify --against exits 0 when it matches, 1 after a rewrite; audit anchors lists', async () => {
    const { e, file } = await anchored()
    const logs: string[] = []
    const orig = console.log
    console.log = (...a: unknown[]) => { logs.push(a.join(' ')) }
    try {
      process.exitCode = 0
      await main(['--data', e.dir, 'audit', 'verify', '--against', file])
      expect(process.exitCode).toBe(0)
      expect(logs.at(-1)).toContain('audit log matches the anchor')
      rewriteChain(e, () => e.db.query("UPDATE audit SET outcome = 'exit 9' WHERE id = 3").run())
      await main(['--data', e.dir, 'audit', 'verify', '--against', file])
      expect(process.exitCode).toBe(1)
      expect(logs.join('\n')).toContain('AUDIT LOG DOES NOT MATCH')
      await main(['--data', e.dir, 'audit', 'anchors'])
      expect(logs.at(-1)).toContain('3 rows')
    } finally {
      console.log = orig
      process.exitCode = 0
    }
  })
})
