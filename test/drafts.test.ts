// R3 provenance and R4 draft visibility.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import path from 'node:path'
import fs from 'node:fs'
import { setFlag, setRule } from '../src/store'
import { setup, textOf, type Env } from './helpers'

let e: Env
beforeAll(() => { e = setup() })
afterAll(() => e.cleanup())

describe('provenance (R3)', () => {
  test('a quiet grep over 경영 still puts 경영 into the next draft (weak)', async () => {
    const r = await e.sh('boss', 'grep -q 매출 /경영/손익.csv && echo found')
    expect(r.stdout).toBe('found\n')
    await e.tool('boss', 'write', { path: '/drafts/견적_초안.md', content: '# 견적 초안\n' })
    const src = e.draftSrc('boss', '견적_초안.md')
    expect(src.get(e.folderId('경영'))).toBe(false) // weak: nothing from 경영 was printed
  })

  test('non-matching grep targets, ls, wc and sha256sum are weak touches; printed content is strong', async () => {
    e.addToken('boss2', 'boss', { name: 'boss-desk' })
    await e.sh('boss2', 'grep -r 없는단어 /인사 /영업 2>/dev/null; ls /공용; wc -l /프로젝트/README.md; cat /경영/손익.csv')
    await e.sh('boss2', 'echo note > /drafts/n.md')
    const src = e.draftSrc('boss2', 'n.md')
    expect(src.get(e.folderId('공용'))).toBe(false)
    expect(src.get(e.folderId('프로젝트'))).toBe(false)
    expect(src.get(e.folderId('경영'))).toBe(true)
    // boss cannot read 인사/영업: nothing there was touched
    expect(src.has(e.folderId('인사'))).toBe(false)
  })

  test('sources never shrink: an edit after the window expired keeps them', async () => {
    e.db.query('UPDATE touches SET strong_at = 1, weak_at = 1 WHERE token_id = ?').run(e.tok('boss').id)
    const before = e.draftSrc('boss', '견적_초안.md')
    const r = await e.tool('boss', 'edit', { path: '/drafts/견적_초안.md', old_string: '초안', new_string: '수정본' })
    expect(r.isError).toBeUndefined()
    const after = e.draftSrc('boss', '견적_초안.md')
    for (const [f, strong] of before) expect(after.get(f)).toBe(strong)
    expect(textOf(r)).toContain('Draft sources: 경영 (weak)')
  })

  test('reading a draft adds its sources to the reader\'s window', async () => {
    e.addToken('boss3', 'boss', { name: 'boss-tablet' })
    const ls = await e.sh('boss3', 'ls /drafts')
    expect(ls.stdout).toContain('@boss-laptop')
    await e.sh('boss3', 'cat /drafts/@boss-desk/n.md > /drafts/from-desk.md')
    expect(e.draftSrc('boss3', 'from-desk.md').get(e.folderId('경영'))).toBe(true)
  })

  test('history: versions, read, restore (restore is a new version, sources kept)', async () => {
    const list = await e.tool('boss', 'history', { path: '/drafts/견적_초안.md', action: 'list' })
    expect(textOf(list).split('\n').filter((l) => l.startsWith('v')).length).toBe(2)
    expect(textOf(await e.tool('boss', 'history', { path: '/drafts/견적_초안.md', action: 'read', version: 1 }))).toBe('# 견적 초안\n')
    await e.tool('boss', 'history', { path: '/drafts/견적_초안.md', action: 'restore', version: 1 })
    expect((await e.sh('boss', 'cat /drafts/견적_초안.md')).stdout).toBe('# 견적 초안\n')
    expect(e.draftSrc('boss', '견적_초안.md').has(e.folderId('경영'))).toBe(true)
  })

  test('edit refuses when expected_sha256 does not match', async () => {
    const r = await e.tool('boss', 'edit', { path: '/drafts/견적_초안.md', old_string: '견적', new_string: 'x', expected_sha256: '0'.repeat(64) })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('changed since you read it')
  })
})

describe('draft visibility (R4)', () => {
  test('boss\'s narrow token (프로젝트 only) cannot see a draft whose sources include 경영', async () => {
    const all = await e.sh('bossNarrow', 'ls -R /drafts; grep -r 견적 /drafts')
    expect(all.stdout).not.toContain('견적_초안')
    expect((await e.sh('bossNarrow', 'cat /drafts/@boss-laptop/견적_초안.md')).exitCode).toBe(1)
    expect((await e.tool('bossNarrow', 'history', { path: '/drafts/@boss-laptop/견적_초안.md', action: 'list' })).isError).toBe(true)
  })

  test('a draft with no sources is visible only to the token that wrote it', async () => {
    await e.tool('bossNarrow', 'write', { path: '/drafts/empty-src.md', content: 'hello\n' })
    expect(e.draftSrc('bossNarrow', 'empty-src.md').size).toBe(0)
    expect((await e.sh('bossNarrow', 'cat /drafts/empty-src.md')).stdout).toBe('hello\n')
    expect((await e.sh('boss', 'ls -R /drafts')).stdout).not.toContain('empty-src')
  })

  test('kim never sees boss\'s drafts', async () => {
    const r = await e.sh('kim', 'ls -aR /drafts; grep -r 견적 /drafts; find /drafts')
    expect(r.stdout).not.toContain('@')
    expect(r.stdout).not.toContain('견적_초안')
  })

  test('a no-AI flag on a source folder closes its drafts too', async () => {
    setFlag(e.db, path.join(e.root, '경영'), 'no_ai', true)
    try { expect((await e.sh('boss', 'ls /drafts')).stdout).not.toContain('견적_초안') }
    finally { setFlag(e.db, path.join(e.root, '경영'), 'no_ai', false) }
    expect((await e.sh('boss', 'ls /drafts')).stdout).toContain('견적_초안')
  })

  test('other tokens\' drafts are read-only; deleting your own draft hides it', async () => {
    expect((await e.sh('boss3', 'echo x >> /drafts/@boss-desk/n.md')).exitCode).not.toBe(0)
    await e.sh('boss3', 'rm /drafts/from-desk.md')
    expect((await e.sh('boss3', 'ls /drafts')).stdout).not.toContain('from-desk')
  })

  test('passing through a folder shown only as a path does not put it into the window', async () => {
    fs.mkdirSync(path.join(e.root, '경영/공개'))
    fs.writeFileSync(path.join(e.root, '경영/공개/요약.md'), '공개 요약\n')
    setRule(e.db, path.join(e.root, '경영/공개'), '@전체', 'read')
    expect((await e.sh('kim', 'ls /경영; grep -r 요약 /경영')).stdout).toContain('공개')
    await e.sh('kim', 'echo memo > /drafts/after-bare.md')
    expect(e.draftSrc('kim', 'after-bare.md').has(e.folderId('경영'))).toBe(false)
    expect(e.draftSrc('kim', 'after-bare.md').get(e.folderId('경영/공개'))).toBe(true)
    expect((await e.sh('kim', 'cat /drafts/after-bare.md')).stdout).toBe('memo\n')
  })
})
