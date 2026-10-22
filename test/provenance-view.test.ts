// 원칙 2 for provenance: a token that read a confirmed NAS copy of someone else's draft inherits that draft's sources
// (R3/R6), folders it may not even know exist. Wherever sources are shown to a caller (tool outputs after write / edit
// / history restore, the shell, the web drafts page, the Files view), folders the caller cannot read are only counted,
// never named, and the answer is the same whether such a folder exists or not. The stored Src is unchanged.
import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { sourcesFor, sourcesLine } from '../src/drafts'
import { listQuarantine, releaseQuarantine } from '../src/inplace/events'
import { reconcile } from '../src/inplace/reconcile'
import { listWidened } from '../src/inplace/widened'
import { Access } from '../src/policy'
import { person } from '../src/store'
import { textOf } from './helpers'
import { webSetup, type WebEnv } from './web-helpers'

const envs: WebEnv[] = []
afterAll(() => envs.forEach((e) => e.cleanup()))

const CONTENT = '# 견적 메모\n\n2026년 3분기 손익 검토 결과 영업이익률은 12.3%로 집계되었다.\n'
const HIDDEN = '1 folder this token cannot see'

/** boss drafts from 경영, the draft is copied into 프로젝트, the admin confirms it: kim may now read the copy. */
async function confirmedCopy(): Promise<WebEnv> {
  const e = await webSetup()
  envs.push(e)
  const rec = () => reconcile(e.db, { dataDir: e.dir })
  await rec()
  await e.sh('boss', 'cat /경영/손익.csv > /dev/null')
  expect((await e.tool('boss', 'write', { path: '/drafts/견적메모.md', content: CONTENT })).isError).toBeUndefined()
  fs.writeFileSync(path.join(e.root, '프로젝트/견적메모.md'), CONTENT)
  await rec()
  const q = listQuarantine(e.db).find((x) => x.kind === 'widened')!
  releaseQuarantine(e.db, q.id, person(e.db, 'dion').id)
  expect(listWidened(e.db)[0]!.status).toBe('confirmed')
  return e
}

const noLeak = (s: string) => { expect(s).not.toContain('경영'); expect(s).not.toMatch(/#\d+|unregistered|unknown folder/) }

describe('inherited sources are not named to a caller who cannot see them', () => {
  test('write: the new draft keeps 경영 in Src, the output only counts it', async () => {
    const e = await confirmedCopy()
    expect((await e.sh('kim', 'ls /')).stdout).not.toContain('경영') // kim does not know 경영 exists
    expect((await e.sh('kim', 'cat /프로젝트/견적메모.md')).stdout).toBe(CONTENT)
    const r = await e.tool('kim', 'write', { path: '/drafts/요약.md', content: '요약\n' })
    const out = textOf(r)
    noLeak(out)
    expect(out).toContain(`Draft sources: 프로젝트, ${HIDDEN}.`)
    expect(out).toContain('this token cannot open it until it can read every source')
    expect(e.draftSrc('kim', '요약.md').get(e.folderId('경영'))).toBe(true) // provenance itself unchanged
    // R4: the draft is not there for kim's token now; nothing about it names 경영 either
    for (const c of ['ls -la /drafts', 'cat /drafts/요약.md', 'find /drafts']) {
      const s = await e.sh('kim', c)
      noLeak(s.stdout + s.stderr)
    }
  })

  test('edit: an own draft that picks up the inherited sources', async () => {
    const e = await confirmedCopy()
    await e.tool('kim', 'write', { path: '/drafts/메모.md', content: 'a\n' })
    expect(textOf(await e.tool('kim', 'read', { path: '/프로젝트/견적메모.md' }))).toContain('영업이익률')
    const out = textOf(await e.tool('kim', 'edit', { path: '/drafts/메모.md', old_string: 'a', new_string: 'b' }))
    expect(out).toContain('Edited /drafts/메모.md')
    noLeak(out)
    expect(out).toContain(`Draft sources: 프로젝트, ${HIDDEN}.`)
  })

  test('history: list shows no sources; restore after reading the copy only counts the hidden one', async () => {
    const e = await confirmedCopy()
    await e.tool('kim', 'write', { path: '/drafts/이력.md', content: 'v1\n' })
    await e.tool('kim', 'write', { path: '/drafts/이력.md', content: 'v2\n' })
    await e.sh('kim', 'cat /프로젝트/견적메모.md > /dev/null')
    noLeak(textOf(await e.tool('kim', 'history', { path: '/drafts/이력.md', action: 'list' })))
    const out = textOf(await e.tool('kim', 'history', { path: '/drafts/이력.md', action: 'restore', version: 1 }))
    expect(out).toContain('Restored /drafts/이력.md to v1')
    noLeak(out)
    expect(out).toContain(`Draft sources: 프로젝트, ${HIDDEN}.`)
  })

  test('bash writing a draft: output and notes name no hidden folder', async () => {
    const e = await confirmedCopy()
    const r = await e.sh('kim', 'cat /프로젝트/견적메모.md > /drafts/사본.md; ls /drafts; cat /drafts/사본.md')
    noLeak(r.stdout + r.stderr)
    expect(e.draftSrc('kim', '사본.md').has(e.folderId('경영'))).toBe(true)
  })

  test('the same answer whether the hidden folder exists, is unregistered or is gone', async () => {
    const e = await confirmedCopy()
    const access = Access.forToken(e.db, e.tok('kim'))
    const proj = e.folderId('프로젝트')
    const unregistered = Number(e.db.query("INSERT INTO folders (path, dev, ino, registered) VALUES (?, '1', '424242', 0)").run(path.join(e.root, '없는폴더')).lastInsertRowid)
    const lines = [e.folderId('경영'), unregistered, 987654].map((hidden) => sourcesLine(sourcesFor(access, new Map([[proj, true], [hidden, true]]))))
    expect(new Set(lines).size).toBe(1)
    expect(lines[0]).toBe(`Draft sources: 프로젝트, ${HIDDEN}. The draft is kept, but this token cannot open it until it can read every source.`)
    // strong or weak, the hidden one reads the same; two are counted
    expect(sourcesLine(sourcesFor(access, new Map([[proj, true], [e.folderId('경영'), false]])))).toBe(lines[0]!)
    expect(sourcesLine(sourcesFor(access, new Map([[e.folderId('경영'), true], [987654, false]])))).toBe(
      'Draft sources: 2 folders this token cannot see. The draft is kept, but this token cannot open it until it can read every source.')
    // the owner of the source still sees it named
    expect(sourcesLine(sourcesFor(Access.forToken(e.db, e.tok('boss')), new Map([[e.folderId('경영'), false]])))).toBe('Draft sources: 경영 (weak)')
  })

  test('web: the drafts page and the Files view of the copy name no hidden folder', async () => {
    const e = await confirmedCopy()
    await e.sh('kim', 'cat /프로젝트/견적메모.md > /dev/null')
    await e.tool('kim', 'write', { path: '/drafts/요약.md', content: '요약\n' })
    const kim = await e.as('kim')
    const d = await kim.call('GET', '/api/drafts')
    expect(d.status).toBe(200)
    noLeak(JSON.stringify(d.data))
    expect(d.data.drafts).toEqual([])
    expect(d.data.locked.count).toBe(1) // R4: kim cannot read 경영, so only a count and a date
    for (const u of ['/api/files/who?path=' + encodeURIComponent('/프로젝트/견적메모.md'), '/api/files/stat?path=' + encodeURIComponent('/프로젝트/견적메모.md'),
      '/api/files?path=' + encodeURIComponent('/프로젝트'), '/api/files?path=/']) {
      const r = await kim.call('GET', u)
      expect(r.status).toBe(200)
      noLeak(JSON.stringify(r.data))
    }
    // the source's owner sees the copy's draft named as usual, with nothing hidden
    const boss = await e.as('boss')
    const b = (await boss.call('GET', '/api/drafts')).data
    expect(b.drafts[0]).toMatchObject({ path: '견적메모.md', sources: [{ folder: '/경영', strong: true }], hidden_sources: 0 })
  })
})
