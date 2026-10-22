// R0/R1 through the shell and the read tool: hidden == nonexistent, scopes, links, system folders, NFC.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { nfcCollisions } from '../src/names'
import { setFlag, setRule } from '../src/store'
import { MSG } from '../src/vfs'
import { CREATES_P, HIDDEN_PROBES, setup, SHELL_MODES, textOf, withShellMode, type Env } from './helpers'


let e: Env
beforeAll(() => { e = setup() })
afterAll(() => e.cleanup())

describe('kim (not in 경영)', () => {
  test('grep -r 매출 / finds nothing in 경영', async () => {
    const r = await e.sh('kim', 'grep -r 매출 /')
    expect(r.stdout).not.toContain('경영')
    expect(r.exitCode).toBe(1)
    expect((await e.sh('kim', 'rg -l 매출 /')).stdout).toBe('')
  })

  test('ls / has no 경영 (and no other hidden folder)', async () => {
    const r = await e.sh('kim', 'ls -a /')
    expect(r.stdout.split('\n')).toEqual(expect.arrayContaining(['drafts', '개인_kim', '공용', '프로젝트']))
    for (const hidden of ['경영', '인사', '영업']) expect(r.stdout).not.toContain(hidden)
  })

  // the same suite in both shell modes: the isolated worker must not open a difference the in-process shell does not have
  for (const mode of SHELL_MODES) test(`a hidden path answers exactly like a nonexistent one (${mode})`, () => withShellMode(mode, async () => {
    // creating P answers from P's parent, so those probes only compare pairs whose parents are alike (both not there)
    const pairs: [string, string, boolean][] = [['/경영/손익.csv', '/does-not-exist.csv', false], ['/경영', '/없는폴더', true], ['/인사/급여.csv', '/프로젝트/없음.csv', false],
      ['/경영/손익.csv', '/없는폴더/손익.csv', true], ['/인사/급여.csv', '/없는폴더/급여.csv', true]]
    for (const [hidden, missing, sameParent] of pairs) {
      for (const c of HIDDEN_PROBES) {
        if (!sameParent && CREATES_P.includes(c)) continue
        const a = await e.sh('kim', c.replaceAll('P', hidden))
        const b = await e.sh('kim', c.replaceAll('P', missing))
        expect({ c, out: a.stdout.replaceAll(hidden, 'P'), err: a.stderr.replaceAll(hidden, 'P'), code: a.exitCode })
          .toEqual({ c, out: b.stdout.replaceAll(missing, 'P'), err: b.stderr.replaceAll(missing, 'P'), code: b.exitCode })
      }
      const ra = await e.tool('kim', 'read', { path: hidden }), rb = await e.tool('kim', 'read', { path: missing })
      expect(textOf(ra).replaceAll(hidden, 'P')).toBe(textOf(rb).replaceAll(missing, 'P'))
      expect(ra.isError).toBe(true)
    }
  }))

  test('cat /경영/손익.csv and cat /does-not-exist.csv: same stderr and exit code', async () => {
    const a = await e.sh('kim', 'cat /경영/손익.csv')
    const b = await e.sh('kim', 'cat /does-not-exist.csv')
    expect(a.exitCode).toBe(b.exitCode)
    expect(a.stderr.replace('/경영/손익.csv', 'X')).toBe(b.stderr.replace('/does-not-exist.csv', 'X'))
  })

  test('the personal folder is the owner\'s only', async () => {
    expect((await e.sh('kim', 'cat /개인_kim/메모.md')).stdout).toContain('kim 메모')
    expect((await e.sh('boss', 'ls /')).stdout).not.toContain('개인_kim')
  })
})

describe('boss (경영 group)', () => {
  test('sees 경영 through every path', async () => {
    expect((await e.sh('boss', 'ls /')).stdout).toContain('경영')
    expect((await e.sh('boss', 'cat /경영/손익.csv')).stdout).toContain('매출,1240000000')
    const g = await e.sh('boss', 'grep -r 매출 /')
    expect(g.stdout).toContain('/경영/손익.csv:매출,1240000000')
    expect(g.stdout).toContain('/경영/손익_요약.xlsx:매출\t1240000000')
    expect(textOf(await e.tool('boss', 'read', { path: '/경영/손익.csv' }))).toContain('매출')
  })

  test('a token scoped to 프로젝트 is narrower than the person', async () => {
    const ls = await e.sh('bossNarrow', 'ls /')
    expect(ls.stdout.trim().split('\n').sort()).toEqual(['drafts', '프로젝트'])
    expect((await e.sh('bossNarrow', 'cat /경영/손익.csv')).exitCode).toBe(1)
    expect((await e.sh('bossNarrow', 'grep -r 매출 /')).stdout).toBe('')
    expect((await e.tool('bossNarrow', 'read', { path: '/경영/손익.csv' })).isError).toBe(true)
  })

  test('office files: extracted text for cat/grep, original bytes for ls -l / wc -c / .raw', async () => {
    const t = await e.sh('boss', 'head -1 /경영/이사회_메모.pdf')
    expect(t.stdout).toBe('Board memo - 2026 Q3\n')
    expect(t.stderr).toContain('(extracted text')
    const size = fs.statSync(path.join(e.root, '경영/이사회_메모.pdf')).size
    expect((await e.sh('boss', 'wc -c /경영/이사회_메모.pdf')).stdout.trim()).toBe(`${size} /경영/이사회_메모.pdf`)
    expect((await e.sh('boss', 'ls -l /경영/이사회_메모.pdf')).stdout).toContain(` ${size} `)
    expect((await e.sh('boss', 'head -c 8 /.raw/경영/이사회_메모.pdf')).stdout).toBe('%PDF-1.4')
    expect((await e.sh('boss', 'wc -l /경영/손익_요약.xlsx')).stdout.trim()).toBe('4 /경영/손익_요약.xlsx')
  })
})

describe('links, system folders, names', () => {
  test('a symlink inside 프로젝트 pointing at 인사/급여.csv is closed (shell and read tool)', async () => {
    fs.symlinkSync('../인사/급여.csv', path.join(e.root, '프로젝트/급여링크.csv'))
    fs.symlinkSync('../인사', path.join(e.root, '프로젝트/hr'))
    try {
      expect((await e.sh('kim', 'ls -a /프로젝트')).stdout).not.toMatch(/급여링크|hr/)
      expect((await e.sh('kim', 'cat /프로젝트/급여링크.csv')).exitCode).toBe(1)
      expect((await e.sh('kim', 'cat /프로젝트/hr/급여.csv')).exitCode).toBe(1)
      expect((await e.sh('kim', 'grep -r 기본급 /')).stdout).toBe('')
      expect((await e.tool('kim', 'read', { path: '/프로젝트/급여링크.csv' })).isError).toBe(true)
      // even someone who may read 인사 does not get it through the link
      e.addToken('lee', 'lee')
      expect((await e.sh('lee', 'cat /프로젝트/급여링크.csv')).exitCode).toBe(1)
      expect((await e.sh('lee', 'cat /인사/급여.csv')).stdout).toContain('기본급')
    } finally {
      fs.unlinkSync(path.join(e.root, '프로젝트/급여링크.csv'))
      fs.unlinkSync(path.join(e.root, '프로젝트/hr'))
    }
  })

  test('a hard link (nlink > 1) is closed on both sides', async () => {
    fs.linkSync(path.join(e.root, '인사/급여.csv'), path.join(e.root, '프로젝트/급여사본.csv'))
    try {
      expect((await e.sh('kim', 'ls /프로젝트')).stdout).not.toContain('급여사본')
      expect((await e.sh('kim', 'cat /프로젝트/급여사본.csv')).exitCode).toBe(1)
      expect((await e.tool('kim', 'read', { path: '/프로젝트/급여사본.csv' })).isError).toBe(true)
      e.addToken('lee2', 'lee')
      expect((await e.sh('lee2', 'cat /인사/급여.csv')).exitCode).toBe(1)
    } finally { fs.unlinkSync(path.join(e.root, '프로젝트/급여사본.csv')) }
  })

  test('#recycle, .DS_Store and other NAS/OS system entries are invisible', async () => {
    const ls = await e.sh('kim', 'ls -a /공용')
    expect(ls.stdout).not.toContain('#recycle')
    expect(ls.stdout).not.toContain('.DS_Store')
    expect((await e.sh('kim', 'cat "/공용/#recycle/옛_공지.md"')).exitCode).toBe(1)
    expect((await e.sh('kim', 'grep -r deleted /')).stdout).toBe('')
  })

  test('two names equal after NFC in one folder are both closed', async () => {
    expect([...nfcCollisions(['회의.md', '회의.md'.normalize('NFD'), 'b.md'])].length).toBe(2)
    // APFS will not hold both spellings at once, so the listing is simulated; files are opened by the listed name
    const dir = path.join(e.root, '공용')
    const readdir = (p: string) => p === dir ? [...fs.readdirSync(p), '공지.md'.normalize('NFD')] : fs.readdirSync(p)
    const ls = await e.sh('kim', 'ls /공용', readdir)
    expect(ls.stdout).not.toContain('공지')
    expect((await e.sh('kim', 'cat /공용/공지.md', readdir)).exitCode).toBe(1)
    expect((await e.sh('kim', 'cat /공용/공지.md')).exitCode).toBe(0)
  })

  test('names typed in NFD find NFC files (compare on NFC)', async () => {
    expect((await e.sh('kim', `cat /${'프로젝트'.normalize('NFD')}/${'견적_2026.md'.normalize('NFD')}`)).stdout).toContain('한빛물산')
  })
})

describe('rules and flags', () => {
  test('inherit break narrows a sub-folder; a rule below a hidden folder makes only that path visible', async () => {
    fs.mkdirSync(path.join(e.root, '프로젝트/비공개'))
    fs.writeFileSync(path.join(e.root, '프로젝트/비공개/계약.md'), '비공개 계약\n')
    fs.mkdirSync(path.join(e.root, '경영/공개'))
    fs.writeFileSync(path.join(e.root, '경영/공개/요약.md'), '공개 요약\n')
    setRule(e.db, path.join(e.root, '프로젝트/비공개'), 'boss', 'read', { breakInherit: true })
    setRule(e.db, path.join(e.root, '경영/공개'), '@전체', 'read')
    expect((await e.sh('kim', 'ls /프로젝트')).stdout).not.toContain('비공개')
    expect((await e.sh('boss', 'cat /프로젝트/비공개/계약.md')).stdout).toBe('비공개 계약\n')
    expect((await e.sh('kim', 'ls /')).stdout).toContain('경영')
    expect((await e.sh('kim', 'ls /경영')).stdout.trim()).toBe('공개')
    expect((await e.sh('kim', 'cat /경영/공개/요약.md')).stdout).toBe('공개 요약\n')
    expect((await e.sh('kim', 'cat /경영/손익.csv')).exitCode).toBe(1)
    expect((await e.sh('kim', 'grep -r 매출 /')).stdout).toBe('')
  })

  test('a no-AI flag on an ancestor cannot be undone below and closes everything under it', async () => {
    setFlag(e.db, path.join(e.root, '공용'), 'no_ai', true)
    try {
      expect((await e.sh('kim', 'ls /')).stdout).not.toContain('공용')
      expect((await e.sh('kim', 'cat /공용/공지.md')).exitCode).toBe(1)
    } finally { setFlag(e.db, path.join(e.root, '공용'), 'no_ai', false) }
  })
})

describe('writes', () => {
  test('writes outside /drafts/ are refused with the read-only message', async () => {
    const r = await e.sh('kim', 'echo x > /프로젝트/new.md')
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr).toContain(MSG.readOnly)
    for (const c of ['cp /프로젝트/README.md /프로젝트/copy.md', 'rm /프로젝트/README.md', 'mv /프로젝트/README.md /drafts/r.md', 'touch /프로젝트/t', 'mkdir /프로젝트/d', 'sed -i s/a/b/ /프로젝트/README.md']) {
      const x = await e.sh('kim', c)
      expect({ c, failed: x.exitCode !== 0 }).toEqual({ c, failed: true })
    }
    expect(fs.readdirSync(path.join(e.root, '프로젝트')).sort()).toEqual(['README.md', '견적_2026.md', '비공개', '사양서.docx', '일정.hwpx', '회의록.hwp'])
    const w = await e.tool('kim', 'write', { path: '/프로젝트/new.md', content: 'x' })
    expect(w.isError).toBe(true)
    expect(textOf(w)).toBe(MSG.readOnly)
  })

  test('office extensions cannot be written, read-only tokens write nothing', async () => {
    expect((await e.sh('kim', 'echo x > /drafts/a.docx')).stderr).toContain(MSG.office)
    expect(textOf(await e.tool('kim', 'write', { path: '/drafts/a.hwp', content: 'x' }))).toBe(MSG.office)
    e.addToken('kimRO', 'kim', { readOnly: true })
    expect((await e.sh('kimRO', 'echo x > /drafts/a.md')).stderr).toContain(MSG.tokenReadOnly)
    expect((await e.tool('kimRO', 'write', { path: '/drafts/a.md', content: 'x' })).isError).toBe(true)
    expect((await e.sh('kimRO', 'cat /프로젝트/README.md')).exitCode).toBe(0)
  })
})
