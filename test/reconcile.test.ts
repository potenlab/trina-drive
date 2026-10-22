// In-place reconciler: R1 ⑤–⑦ closures, R10 moves, lost folders, outside-change audit, R6 widened copies.
// Temp dirs stand in for NAS shares (the demo company tree).
import { afterAll, describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { listEvents, listQuarantine, releaseQuarantine } from '../src/inplace/events'
import { reconcile } from '../src/inplace/reconcile'
import { realFs, type FsOps } from '../src/inplace/walk'
import { listWidened, rejudgeWidened } from '../src/inplace/widened'
import { sampleDocx } from '../src/samples'
import { person, registerFolder, setRule } from '../src/store'
import { setup, type Env } from './helpers'

const envs: Env[] = []
const fresh = () => { const e = setup(); envs.push(e); return e }
afterAll(() => envs.forEach((e) => e.cleanup()))

const rec = (e: Env, ops?: FsOps) => reconcile(e.db, { dataDir: e.dir, ops })
const p = (e: Env, rel: string) => path.join(e.root, rel)
const write = (e: Env, rel: string, content: string | Uint8Array) => { fs.mkdirSync(path.dirname(p(e, rel)), { recursive: true }); fs.writeFileSync(p(e, rel), content) }
const outside = (e: Env) => e.db.query<{ command: string; outcome: string }, []>("SELECT command, outcome FROM audit WHERE tool = 'outside-change' ORDER BY id").all()
const kinds = (e: Env) => listEvents(e.db).map((x) => x.kind).reverse()
const id = (e: Env, name: string) => person(e.db, name).id

describe('renames and moves (R10)', () => {
  test('a renamed folder keeps its rules (closed in between); a renamed registered folder too', async () => {
    const e = fresh()
    write(e, '인사/평가/결과.md', '평가 결과\n')
    setRule(e.db, p(e, '인사/평가'), 'kim', 'read')
    await rec(e)
    expect((await e.sh('kim', 'cat /인사/평가/결과.md')).stdout).toBe('평가 결과\n')

    fs.renameSync(p(e, '인사/평가'), p(e, '인사/평가2026'))
    expect((await e.sh('kim', 'cat /인사/평가2026/결과.md')).exitCode).toBe(1) // not judged yet: closed
    const r = await rec(e)
    expect(r.renamed).toBe(1)
    expect((await e.sh('kim', 'cat /인사/평가2026/결과.md')).stdout).toBe('평가 결과\n')
    expect(kinds(e)).toContain('renamed')

    fs.renameSync(p(e, '공용'), p(e, '공용_2026'))
    await rec(e)
    expect((await e.sh('kim', 'cat /공용/공지.md')).stdout).toContain('대청소') // the mount keeps its name
    expect(outside(e).map((a) => a.command.replaceAll(e.root, ''))).toEqual([
      'renamed: /인사/평가 -> /인사/평가2026',
      'renamed: /공용 -> /공용_2026',
    ])
  })

  test('moving a no-rule folder from 인사 to 프로젝트 quarantines it; a moved file too; the admin releases', async () => {
    const e = fresh()
    write(e, '인사/면담/김민수.md', '면담 기록\n')
    await rec(e)
    fs.renameSync(p(e, '인사/면담'), p(e, '프로젝트/면담'))
    fs.renameSync(p(e, '인사/급여.csv'), p(e, '프로젝트/급여.csv'))
    expect((await e.sh('kim', 'cat /프로젝트/면담/김민수.md')).exitCode).toBe(1) // moved since the last walk: closed
    const r = await rec(e)
    expect(r.moved).toBe(2)
    expect(r.quarantined).toBe(2)
    expect((await e.sh('kim', 'ls /프로젝트')).stdout).not.toMatch(/면담|급여/)
    expect((await e.sh('kim', 'cat /프로젝트/면담/김민수.md')).exitCode).toBe(1)
    const q = listQuarantine(e.db)
    expect(q.map((x) => [x.kind, x.item, path.basename(x.path)])).toEqual([['moved', 'dir', '면담'], ['moved', 'file', '급여.csv']])
    const ev = listEvents(e.db, { kind: 'quarantined' })
    expect(JSON.parse(ev[0]!.notify).admins).toEqual([id(e, 'dion')])

    expect(() => releaseQuarantine(e.db, q[0]!.id, id(e, 'kim'))).toThrow('only the admin')
    releaseQuarantine(e.db, q[0]!.id, id(e, 'dion'))
    expect((await e.sh('kim', 'cat /프로젝트/면담/김민수.md')).stdout).toBe('면담 기록\n')
    expect((await e.sh('kim', 'cat /프로젝트/급여.csv')).exitCode).toBe(1)
    expect(outside(e).map((a) => a.outcome)).toEqual(['quarantined', 'quarantined'])
  })

  test('a move that does not widen keeps the rules (공용 -> 프로젝트)', async () => {
    const e = fresh()
    await rec(e)
    fs.renameSync(p(e, '공용/공지.md'), p(e, '프로젝트/공지.md'))
    const r = await rec(e)
    expect([r.moved, r.quarantined]).toEqual([1, 0])
    expect((await e.sh('kim', 'cat /프로젝트/공지.md')).stdout).toContain('공지')
  })
})

describe('lost folders fail closed', () => {
  test('a registered folder deleted is closed; recreated under the same name it stays closed (new identity)', async () => {
    const e = fresh()
    e.addToken('park', 'park')
    await rec(e)
    expect((await e.sh('park', 'cat /영업/고객목록.csv')).exitCode).toBe(0)
    fs.rmSync(p(e, '영업'), { recursive: true })
    const r = await rec(e)
    expect(r.lost).toBe(1)
    expect((await e.sh('park', 'ls /')).stdout).not.toContain('영업')
    write(e, '영업/고객목록.csv', '고객,담당\n새고객,park\n')
    await rec(e)
    expect((await e.sh('park', 'cat /영업/고객목록.csv')).exitCode).toBe(1)
    expect(listEvents(e.db, { kind: 'lost' }).length).toBe(1) // reported once
    expect(listQuarantine(e.db).map((q) => [q.kind, q.folder_id])).toEqual([['lost', e.folderId('영업')]])
  })

  test('a narrowed sub-folder deleted and recreated does not silently inherit the wider parent rule', async () => {
    const e = fresh()
    write(e, '프로젝트/비공개/계약.md', '비공개 계약\n')
    setRule(e.db, p(e, '프로젝트/비공개'), 'boss', 'read', { breakInherit: true })
    await rec(e)
    expect((await e.sh('kim', 'ls /프로젝트')).stdout).not.toContain('비공개')
    fs.rmSync(p(e, '프로젝트/비공개'), { recursive: true })
    await rec(e)
    write(e, '프로젝트/비공개/계약.md', '새 계약\n') // same name, new identity, no rules of its own
    expect((await e.sh('kim', 'cat /프로젝트/비공개/계약.md')).exitCode).toBe(1)
    await rec(e)
    expect((await e.sh('kim', 'cat /프로젝트/비공개/계약.md')).exitCode).toBe(1)
    const q = listQuarantine(e.db)
    expect(q.map((x) => x.kind)).toEqual(['lost'])
    releaseQuarantine(e.db, q[0]!.id, id(e, 'dion')) // the admin accepts the new folder: it inherits 프로젝트
    expect((await e.sh('kim', 'cat /프로젝트/비공개/계약.md')).stdout).toBe('새 계약\n')
  })
})

describe('links and names (R1 ⑤ ⑥)', () => {
  const xsym = (target: string) => {
    const head = `XSym\n${String(target.length).padStart(4, '0')}\n${crypto.createHash('md5').update(target).digest('hex')}\n${target}\n`
    return head.padEnd(1067, ' ')
  }
  const alias = Buffer.concat([Buffer.from('book\0\0\0\0mark\0\0\0\0'), Buffer.alloc(300, 7)])
  const appleDouble = () => { // header, one entry (9 = Finder info) at 38, type 'alis' creator 'MACS' flags kIsAlias
    const b = Buffer.alloc(70)
    b.writeUInt32BE(0x00051607, 0); b.writeUInt32BE(0x00020000, 4); b.writeUInt16BE(1, 24)
    b.writeUInt32BE(9, 26); b.writeUInt32BE(38, 30); b.writeUInt32BE(32, 34)
    b.write('alisMACS', 38, 'latin1'); b.writeUInt16BE(0x8000, 46)
    return b
  }

  test('hard link, symlink, XSym file, alias file and AppleDouble-marked alias are closed and reported', async () => {
    const e = fresh()
    await rec(e)
    fs.linkSync(p(e, '인사/급여.csv'), p(e, '프로젝트/급여사본.csv'))
    fs.symlinkSync('../인사/급여.csv', p(e, '프로젝트/급여링크.csv'))
    write(e, '프로젝트/급여.xsym', xsym('../hr/pay.csv'))
    write(e, '프로젝트/바로가기', alias)
    write(e, '프로젝트/별칭.pdf', 'plain bytes, alias only per its Finder info')
    write(e, '프로젝트/._별칭.pdf', appleDouble())
    // before the reconcile: XSym and alias bytes are refused at read time already (sniffed right before returning)
    expect((await e.sh('kim', 'cat /프로젝트/급여.xsym')).exitCode).toBe(1)
    expect((await e.sh('kim', 'cat /.raw/프로젝트/바로가기')).exitCode).toBe(1)
    await rec(e)
    const closed = new Map(listEvents(e.db, { kind: 'closed' }).map((x) => { const d = JSON.parse(x.detail); return [d.reason, d.paths.map((q: string) => path.basename(q))] }))
    expect([...closed.keys()].sort()).toEqual(['alias', 'hardlink', 'symlink', 'xsym'])
    expect(closed.get('hardlink').sort()).toEqual(['급여.csv', '급여사본.csv'].sort())
    expect(closed.get('symlink')).toEqual(['급여링크.csv'])
    expect(closed.get('xsym')).toEqual(['급여.xsym'])
    expect(closed.get('alias').sort()).toEqual(['바로가기', '별칭.pdf'].sort())
    const ls = (await e.sh('kim', 'ls /프로젝트')).stdout
    for (const n of ['급여사본', '급여링크', '급여.xsym', '바로가기', '별칭']) expect(ls).not.toContain(n)
    // nothing new: no new events on the next pass
    const before = listEvents(e.db).length
    await rec(e)
    expect(listEvents(e.db).length).toBe(before)
  })

  test('#recycle and other NAS system folders are not indexed; a move into #recycle is a delete', async () => {
    const e = fresh()
    await rec(e)
    expect(e.db.query("SELECT count(*) AS n FROM fs_index WHERE path LIKE '%#recycle%' OR path LIKE '%.DS_Store'").get()).toEqual({ n: 0 })
    fs.renameSync(p(e, '공용/공지.md'), p(e, '공용/#recycle/공지.md'))
    await rec(e)
    expect(outside(e).map((a) => a.command.replaceAll(e.root, ''))).toEqual(['deleted: /공용/공지.md'])
  })

  test('two names equal after NFC in one folder: both closed and reported (simulated listing; APFS holds one)', async () => {
    const e = fresh()
    const dir = p(e, '공용')
    const ops: FsOps = { ...realFs, readdir: async (d) => d === dir ? [...await fs.promises.readdir(d), '공지.md'.normalize('NFD')] : fs.promises.readdir(d) }
    await rec(e, ops)
    const ev = listEvents(e.db, { kind: 'closed' })
    expect(JSON.parse(ev[0]!.detail)).toMatchObject({ reason: 'nfc_collision', count: 2 })
    expect((await e.sh('kim', 'cat /공용/공지.md')).exitCode).toBe(1) // closed by identity even with a normal listing
  })

  test('Office lock files, .DS_Store and ._ files make no outside-change records', async () => {
    const e = fresh()
    await rec(e)
    for (const n of ['~$보고서.docx', '.~lock.보고서.docx#', '.DS_Store', '._보고서.docx', '~WRL0001.tmp']) write(e, `프로젝트/${n}`, 'x')
    await rec(e)
    for (const n of ['~$보고서.docx', '.~lock.보고서.docx#', '~WRL0001.tmp']) fs.rmSync(p(e, `프로젝트/${n}`))
    await rec(e)
    expect(outside(e)).toEqual([])
    write(e, '프로젝트/보고서.md', '# 보고서\n')
    await rec(e)
    expect(outside(e).map((a) => a.command.replaceAll(e.root, ''))).toEqual(['created: /프로젝트/보고서.md'])
  })
})

describe('widened drafts (R6)', () => {
  const paras = Array.from({ length: 10 }, (_, i) =>
    `${i + 1}번 항목: 2026년 3분기 손익 검토 결과 영업이익률은 ${10 + i}.${i}%로 집계되었고 원가 절감 계획 ${i}안을 함께 보고한다.`)
  const others = Array.from({ length: 10 }, (_, i) => `다른 문단 ${i}: 고객 미팅 일정과 납품 준비 상황을 정리했고 담당자 ${i * 7}번이 다음 주까지 확인한다.`)

  async function bossDraft(e: Env, rel: string, content: string) {
    await e.sh('boss', 'cat /경영/손익.csv > /dev/null')
    const r = await e.tool('boss', 'write', { path: `/drafts/${rel}`, content })
    expect(r.isError).toBeUndefined()
  }

  test('a draft copied verbatim into 프로젝트 is widened_pending: no agent reads it until confirmed; then readers inherit its sources', async () => {
    const e = fresh()
    await rec(e)
    const content = '# 견적 메모\n\n' + paras.slice(0, 3).join('\n\n') + '\n'
    await bossDraft(e, '견적메모.md', content)
    write(e, '프로젝트/견적메모.md', content)
    const r = await rec(e)
    expect(r.widened).toBe(1)
    const [w] = listWidened(e.db)
    expect(w).toMatchObject({ status: 'pending', match: 'sha256', widening: 1, writer_person_id: id(e, 'boss'), target_folder_id: e.folderId('프로젝트') })
    expect((await e.sh('kim', 'cat /프로젝트/견적메모.md')).exitCode).toBe(1)
    expect((await e.sh('boss', 'cat /프로젝트/견적메모.md')).exitCode).toBe(1) // closed to agents, whoever they are
    expect((await e.sh('kim', 'grep -r 영업이익률 /')).stdout).toBe('')
    const ev = listEvents(e.db, { kind: 'widened' })[0]!
    expect(JSON.parse(ev.detail)).toMatchObject({ draft: w!.draft_id, writer: id(e, 'boss'), target: e.folderId('프로젝트'), sources: [e.folderId('경영')] })

    const q = listQuarantine(e.db).find((x) => x.kind === 'widened')!
    expect(() => releaseQuarantine(e.db, q.id, id(e, 'kim'))).toThrow()
    releaseQuarantine(e.db, q.id, id(e, 'dion'))
    expect(listWidened(e.db)[0]!.status).toBe('confirmed')
    expect((await e.sh('kim', 'cat /프로젝트/견적메모.md')).stdout).toBe(content)
    await e.tool('kim', 'write', { path: '/drafts/요약.md', content: '요약\n' })
    expect(e.draftSrc('kim', '요약.md').get(e.folderId('경영'))).toBe(true) // inherited provenance
    expect(listWidened(e.db).length).toBe(1) // records are never deleted
  })

  test('pasted with edits into a Word file: 40% of the paragraphs is detected, 20% is not', async () => {
    const e = fresh()
    await rec(e)
    await bossDraft(e, '손익검토.md', '# 손익 검토\n\n' + paras.join('\n\n') + '\n')
    const edited = paras.slice(0, 4).map((x, i) => i === 1 ? x.replace('보고한다', '보고함') : x)
    write(e, '프로젝트/편집본.docx', sampleDocx([...edited, ...others.slice(0, 6)]))
    write(e, '프로젝트/조금.docx', sampleDocx([...paras.slice(5, 7), ...others.slice(0, 8)]))
    await rec(e)
    const w = listWidened(e.db)
    expect(w.map((x) => [path.basename(x.path), x.status, x.match])).toEqual([['편집본.docx', 'pending', 'paragraphs']])
    expect(w[0]!.overlap).toBeGreaterThanOrEqual(0.4)
    expect(w[0]!.overlap).toBeLessThan(0.5)
    expect((await e.sh('kim', 'cat /프로젝트/편집본.docx')).exitCode).toBe(1)
    expect((await e.sh('kim', 'cat /프로젝트/조금.docx')).exitCode).toBe(0)
  })

  test('re-judging after a rule change flips a tracked copy to pending', async () => {
    const e = fresh()
    const d = p(e, '영업2')
    fs.mkdirSync(d)
    registerFolder(e.db, d, { nasReaders: ['park'] })
    setRule(e.db, d, '@영업', 'read')
    await rec(e)
    e.addToken('park', 'park')
    await e.sh('park', 'cat /영업/고객목록.csv > /dev/null')
    const content = '# 고객 요약\n\n' + others.slice(0, 2).join('\n\n') + '\n'
    await e.tool('park', 'write', { path: '/drafts/고객요약.md', content })
    write(e, '영업2/고객요약.md', content)
    await rec(e)
    expect(listWidened(e.db).map((x) => [x.status, x.widening])).toEqual([['tracked', 0]]) // 영업2 readers = 영업 readers
    expect((await e.sh('park', 'cat /영업2/고객요약.md')).stdout).toBe(content)

    setRule(e.db, d, 'kim', 'read') // 영업2 now has a reader 영업 does not
    const r = rejudgeWidened(e.db)
    expect(r.flipped.length).toBe(1)
    expect(listWidened(e.db).map((x) => [x.status, x.widening, x.ever_widening])).toEqual([['pending', 1, 1]])
    expect((await e.sh('kim', 'cat /영업2/고객요약.md')).exitCode).toBe(1)
    expect(JSON.parse(listEvents(e.db, { kind: 'widened' })[0]!.detail).rejudged).toBe(true)
  })
})

describe('the loop', () => {
  test('watch mode: an fs.watch hint triggers a pass soon after a local change', async () => {
    const e = fresh()
    const { startReconciler } = await import('../src/inplace/reconcile')
    const logs: string[] = []
    const r = startReconciler(e.db, { dataDir: e.dir, intervalMs: 3600_000, debounceMs: 50, log: (s) => logs.push(s) })
    try {
      await r.idle()
      fs.renameSync(p(e, '인사/급여.csv'), p(e, '공용/급여.csv'))
      const t0 = Date.now()
      while (!listQuarantine(e.db).length && Date.now() - t0 < 5000) await new Promise((res) => setTimeout(res, 50))
      expect(listQuarantine(e.db).map((q) => path.basename(q.path))).toEqual(['급여.csv'])
      await r.idle()
      expect(logs.some((l) => l.includes('1 quarantined'))).toBe(true)
    } finally { r.stop() }
  })
})
