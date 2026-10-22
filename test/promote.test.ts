// Draft promote through the MCP tool (plan 5.2, R2 v0.2, R6): new files only, written at once when not widening (temp
// dir as the NAS), a pending approval when widening, refusals that leave the NAS untouched, provenance passed on.
import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { approvalById, promoteHooks, setPromote } from '../src/promote'
import { grantManage } from '../src/store'
import { TOOL_DEFS } from '../src/tools'
import { setup, textOf, type Env } from './helpers'

let e: Env
afterEach(() => { promoteHooks.beforePlace = undefined; e?.cleanup() })

function env() {
  e = setup()
  setPromote(e.db, e.folderId('프로젝트'), true, null)
  // approvers are people with a web sign-in; boss manages 경영 (as in the web demo)
  for (const p of e.db.query<{ id: number; name: string }, []>('SELECT id, name FROM people').all())
    e.db.query('INSERT INTO accounts (person_id, email, created_at) VALUES (?, ?, ?)').run(p.id, `${p.name}@example.com`, Date.now())
  grantManage(e.db, path.join(e.root, '경영'), 'boss')
  return e
}
/** a draft written by `who` after reading `from` (its sources = the folders read) */
async function draftFrom(who: string, from: string[], rel: string, content = `# ${rel}\n\nsome text that is long enough to count\n`) {
  for (const f of from) expect((await e.tool(who, 'read', { path: f })).isError).toBeFalsy()
  const w = await e.tool(who, 'write', { path: `/drafts/${rel}`, content })
  expect(w.isError).toBeFalsy()
  return content
}
const promote = (who: string, args: Record<string, unknown>) => e.tool(who, 'promote', args)
const nasFiles = (rel: string) => fs.readdirSync(path.join(e.root, rel)).sort()

describe('promote: not widening → written at once', () => {
  test('kim promotes a draft made from 프로젝트 into 프로젝트: a new file, audited, tracked as a copy of the draft', async () => {
    env()
    const content = await draftFrom('kim', ['/프로젝트/견적_2026.md'], 'quote-v2.md')
    const before = nasFiles('프로젝트')
    const r = await promote('kim', { draft: '/drafts/quote-v2.md', folder: '/프로젝트', name: '견적_2026_v2.md' })
    expect(r.isError).toBeFalsy()
    expect(textOf(r)).toContain('Promoted /drafts/quote-v2.md')
    expect(r.structuredContent).toMatchObject({ status: 'written', path: '/프로젝트/견적_2026_v2.md' })
    const file = path.join(e.root, '프로젝트', '견적_2026_v2.md')
    expect(fs.readFileSync(file, 'utf8')).toBe(content)
    expect(fs.lstatSync(file).nlink).toBe(1)
    expect(nasFiles('프로젝트')).toEqual([...before, '견적_2026_v2.md'].sort()) // no temp file left behind
    const st = fs.statSync(file, { bigint: true })
    const w = e.db.query<{ status: string; match: string; draft_id: number }, [string, string]>('SELECT status, match, draft_id FROM widened WHERE dev = ? AND ino = ?').get(String(st.dev), String(st.ino))!
    expect(w).toMatchObject({ status: 'tracked', match: 'promote' })
    const p = e.db.query<{ vpath: string; widening: number; token_id: number }, []>('SELECT vpath, widening, token_id FROM promotions').get()!
    expect(p).toEqual({ vpath: '/프로젝트/견적_2026_v2.md', widening: 0, token_id: e.tok('kim').id })
    const audit = e.db.query<{ tool: string; command: string; files: string; outcome: string }, []>("SELECT tool, command, files, outcome FROM audit WHERE tool = 'promote'").get()!
    expect(audit.command).toBe('promote /drafts/quote-v2.md -> /프로젝트/견적_2026_v2.md')
    expect(JSON.parse(audit.files)).toContain('/프로젝트/견적_2026_v2.md')
    expect(audit.outcome).toBe('written /프로젝트/견적_2026_v2.md')
    // agents can read it right away
    expect(textOf(await e.tool('kim', 'read', { path: '/프로젝트/견적_2026_v2.md' }))).toContain('some text')
  })

  test('new files only: an existing name (any case / NFC spelling, or its Mac sidecar) is refused, the NAS unchanged', async () => {
    env()
    await draftFrom('kim', ['/프로젝트/README.md'], 'r.md')
    const before = nasFiles('프로젝트')
    for (const name of ['README.md', 'readme.md', '견적_2026.md'.normalize('NFD')]) {
      const r = await promote('kim', { draft: '/drafts/r.md', folder: '/프로젝트', name })
      expect(r.isError).toBe(true)
      expect(textOf(r)).toContain('already exists')
    }
    fs.writeFileSync(path.join(e.root, '프로젝트', '._side.md'), 'x')
    expect(textOf(await promote('kim', { draft: '/drafts/r.md', folder: '/프로젝트', name: 'side.md' }))).toContain('already exists')
    fs.rmSync(path.join(e.root, '프로젝트', '._side.md'))
    expect(nasFiles('프로젝트')).toEqual(before)
    expect(fs.readFileSync(path.join(e.root, '프로젝트', 'README.md'), 'utf8')).toContain('# Projects')
  })

  test('race: a file appearing under the name between the check and the write is never replaced', async () => {
    env()
    await draftFrom('kim', ['/프로젝트/README.md'], 'r.md')
    promoteHooks.beforePlace = (final) => fs.writeFileSync(final, 'someone else was first')
    const r = await promote('kim', { draft: '/drafts/r.md', folder: '/프로젝트', name: 'race.md' })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('already exists')
    expect(fs.readFileSync(path.join(e.root, '프로젝트', 'race.md'), 'utf8')).toBe('someone else was first')
    expect(nasFiles('프로젝트').filter((n) => n.includes('promote'))).toEqual([]) // temp removed
    expect(e.db.query('SELECT 1 FROM promotions').get()).toBeNull()
  })

  test('bad names, link-looking content, other tokens\' drafts, read-only tokens, a stale expected_sha256', async () => {
    env()
    await draftFrom('kim', ['/프로젝트/README.md'], 'r.md')
    for (const name of ['../x.md', 'a/b.md', '.hidden.md', 'run.sh', 'x.exe', 'memo.docx', '~$x.md', ' x.md', 'x.md.', '@eaDir', 'a:b.md', '']) {
      const r = await promote('kim', { draft: '/drafts/r.md', folder: '/프로젝트', name })
      expect(r.isError).toBe(true)
      expect(textOf(r)).toMatch(/bad file name|give the new file a name/)
    }
    const xsym = 'XSym\n0011\n0123456789abcdef0123456789abcdef\n/etc/passwd\n'.padEnd(1067, ' ')
    await e.tool('kim', 'write', { path: '/drafts/link.md', content: xsym })
    expect(textOf(await promote('kim', { draft: '/drafts/link.md', folder: '/프로젝트', name: 'link.md' }))).toContain('looks like a link')
    expect(textOf(await promote('kim', { draft: '/drafts/r.md', folder: '/프로젝트', name: 'x.md', expected_sha256: 'f'.repeat(64) }))).toContain('changed since you read it')
    expect(textOf(await promote('kim', { draft: '/drafts/none.md', folder: '/프로젝트', name: 'x.md' }))).toBe('No such draft: /drafts/none.md')
    e.addToken('kimRO', 'kim', { name: 'ro', readOnly: true })
    expect(textOf(await promote('kimRO', { draft: '/drafts/r.md', folder: '/프로젝트', name: 'x.md' }))).toContain('read-only')
    e.addToken('kim2', 'kim', { name: 'kim-2' })
    const other = await promote('kim2', { draft: '/drafts/@kim-laptop/r.md', folder: '/프로젝트', name: 'x.md' })
    expect(textOf(other)).toContain('Only drafts this token wrote')
    expect(fs.existsSync(path.join(e.root, '프로젝트', 'x.md'))).toBe(false)
  })

  test('targets: hidden = missing, promote off, rule below write, token scope', async () => {
    env()
    await draftFrom('kim', ['/프로젝트/README.md'], 'r.md')
    const hidden = textOf(await promote('kim', { draft: '/drafts/r.md', folder: '/경영', name: 'x.md' }))
    const missing = textOf(await promote('kim', { draft: '/drafts/r.md', folder: '/없는폴더', name: 'x.md' }))
    expect(hidden.replace('/경영', 'P')).toBe(missing.replace('/없는폴더', 'P'))
    expect(textOf(await promote('kim', { draft: '/drafts/r.md', folder: '/공용', name: 'x.md' }))).toContain('Promote is not turned on')
    setPromote(e.db, e.folderId('공용'), true, null)
    expect(textOf(await promote('kim', { draft: '/drafts/r.md', folder: '/공용', name: 'x.md' }))).toContain('not "write"')
    // a token scoped to 공용 does not see 프로젝트 at all
    e.addToken('kimScoped', 'kim', { name: 'scoped', scope: [path.join(e.root, '공용')] })
    await draftFrom('kimScoped', ['/공용/공지.md'], 's.md')
    expect(textOf(await promote('kimScoped', { draft: '/drafts/s.md', folder: '/프로젝트', name: 'x.md' }))).toBe('No such folder: /프로젝트')
  })

  test('a promoted copy passes the draft\'s sources on to whoever reads it (R3/R6)', async () => {
    env()
    await draftFrom('kim', ['/공용/공지.md', '/프로젝트/README.md'], 'mix.md')
    expect((await promote('kim', { draft: '/drafts/mix.md', folder: '/프로젝트', name: 'mix.md' })).isError).toBeFalsy()
    e.addToken('park', 'park', { name: 'park-laptop' })
    await e.tool('park', 'read', { path: '/프로젝트/mix.md' })
    const touched = e.db.query<{ folder_id: number }, [number]>('SELECT folder_id FROM touches WHERE token_id = ?').all(e.tok('park').id).map((r) => r.folder_id)
    expect(touched).toContain(e.folderId('공용'))
  })

  test('if the audit row cannot be written, the promoted file is removed again', async () => {
    env()
    await draftFrom('kim', ['/프로젝트/README.md'], 'r.md')
    e.db.exec("CREATE TRIGGER no_audit BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT, 'audit down'); END;")
    await expect(promote('kim', { draft: '/drafts/r.md', folder: '/프로젝트', name: 'gone.md' })).rejects.toThrow(/audit log/)
    e.db.exec('DROP TRIGGER no_audit')
    expect(fs.existsSync(path.join(e.root, '프로젝트', 'gone.md'))).toBe(false)
    expect(e.db.query('SELECT 1 FROM promotions').get()).toBeNull()
    expect(e.db.query('SELECT 1 FROM widened').get()).toBeNull()
  })
})

describe('promote: widening → pending approval', () => {
  test('boss promotes a draft made from 경영 into 프로젝트: nothing written, a request with a link, informational only', async () => {
    env()
    e.ctx.publicUrl = 'https://files.example.com/'
    await draftFrom('boss', ['/경영/손익.csv'], 'pl.md')
    const before = nasFiles('프로젝트')
    const r = await promote('boss', { draft: '/drafts/pl.md', folder: '/프로젝트', name: 'pl.md', reason: 'the team needs the numbers' })
    expect(r.isError).toBeFalsy()
    expect(textOf(r)).toContain('Pending approval')
    expect(textOf(r)).toContain('You cannot approve it')
    const s = r.structuredContent as { status: string; approval_id: number; url: string }
    expect(s.status).toBe('input_required')
    expect(s.url).toBe(`https://files.example.com/#/approvals/${s.approval_id}`)
    expect(nasFiles('프로젝트')).toEqual(before)
    const a = approvalById(e.db, s.approval_id)!
    expect(a).toMatchObject({ status: 'pending', name: 'pl.md', target_vpath: '/프로젝트', reason: 'the team needs the numbers', requester_token_id: e.tok('boss').id })
    expect(a.gain).toBe(4) // dion, kim, lee, park read 프로젝트 but not 경영
    // the same request again is the same request
    const again = await promote('boss', { draft: '/drafts/pl.md', folder: '/프로젝트', name: 'pl.md' })
    expect((again.structuredContent as { approval_id: number }).approval_id).toBe(s.approval_id)
    expect(textOf(again)).toContain('already requested')
    expect(e.db.query<{ outcome: string }, []>("SELECT outcome FROM audit WHERE tool = 'promote' ORDER BY id DESC").get()!.outcome).toBe('pending approval')
  })

  test('no eligible approver → closed at once ("no one can approve")', async () => {
    env()
    // lee reads 인사; nobody manages 인사 or 프로젝트; lee has write on 프로젝트 (everyone has)
    e.addToken('lee', 'lee', { name: 'lee-laptop' })
    await draftFrom('lee', ['/인사/급여.csv'], 'pay.md')
    const r = await promote('lee', { draft: '/drafts/pay.md', folder: '/프로젝트', name: 'pay.md' })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('no one can approve')
    const id = (r.structuredContent as { approval_id: number }).approval_id
    expect(approvalById(e.db, id)!.status).toBe('closed')
    expect(fs.existsSync(path.join(e.root, '프로젝트', 'pay.md'))).toBe(false)
  })

  test('agents get no way to approve: the tool list has promote and no approve', () => {
    expect(TOOL_DEFS.map((t) => t.name)).toEqual(['bash', 'read', 'write', 'edit', 'history', 'promote'])
  })
})
