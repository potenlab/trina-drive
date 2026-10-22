import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { truncateUtf8, verifyAudit } from '../src/audit'
import { AuditFailure } from '../src/tools'
import { setup, type Env } from './helpers'

let e: Env
beforeAll(() => { e = setup() })
afterAll(() => e.cleanup())

describe('audit', () => {
  test('every call is recorded with files touched; long commands are cut at 4 KB with a hash of the whole', async () => {
    await e.sh('kim', 'cat /프로젝트/README.md')
    await e.tool('kim', 'read', { path: '/공용/공지.md' })
    const long = `echo ${'가'.repeat(3000)} | wc -c`
    await e.sh('kim', long)
    const rows = e.db.query<{ tool: string; command: string; command_sha256: string; files: string; outcome: string }, []>('SELECT * FROM audit ORDER BY id').all()
    expect(rows.length).toBe(3)
    expect(JSON.parse(rows[0]!.files)).toEqual(['/프로젝트/README.md'])
    expect(rows[1]!.tool).toBe('read')
    expect(Buffer.byteLength(rows[2]!.command)).toBeLessThanOrEqual(4096 + 3)
    expect(rows[2]!.command_sha256).toBe(new Bun.CryptoHasher('sha256').update(long).digest('hex'))
    expect(truncateUtf8('가나다', 4)).toBe('가…')
  })

  test('verify passes, then detects an edited row and a deleted row', async () => {
    expect(verifyAudit(e.db).ok).toBe(true)
    const id = e.db.query<{ id: number }, []>('SELECT min(id) AS id FROM audit').get()!.id
    const orig = e.db.query<{ command: string }, [number]>('SELECT command FROM audit WHERE id = ?').get(id)!.command
    e.db.query('UPDATE audit SET command = ? WHERE id = ?').run('ls /', id)
    expect(verifyAudit(e.db)).toMatchObject({ ok: false, brokenAt: id })
    e.db.query('UPDATE audit SET command = ? WHERE id = ?').run(orig, id)
    expect(verifyAudit(e.db).ok).toBe(true)
    e.db.query('DELETE FROM audit WHERE id = ?').run(id + 1)
    expect(verifyAudit(e.db)).toMatchObject({ ok: false, brokenAt: id + 2 })
  })

  test('if the audit row cannot be written the call fails and its draft write is not kept', async () => {
    e.db.exec(`CREATE TRIGGER audit_down BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT, 'disk full'); END`)
    try {
      await expect(e.tool('kim', 'write', { path: '/drafts/lost.md', content: 'x' })).rejects.toBeInstanceOf(AuditFailure)
      await expect(e.tool('kim', 'bash', { command: 'echo y > /drafts/lost2.md' })).rejects.toBeInstanceOf(AuditFailure)
    } finally { e.db.exec('DROP TRIGGER audit_down') }
    expect(e.db.query('SELECT count(*) AS n FROM drafts').get()).toEqual({ n: 0 })
    expect((await e.sh('kim', 'ls /drafts')).stdout).toBe('')
  })
})
