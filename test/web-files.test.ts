// People's file view on the web (plan 5.2 "웹 파일 보기", 4.1 R1): per-role reads, hidden == missing byte for byte on
// every endpoint, links / NAS system folders / quarantine closed, "No AI" closes agents but not people, attachment-only
// downloads, search that never shows text from an unreadable file (canaries), audit without provenance.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { setFlag, setRule } from '../src/store'
import { FILES_LIMITS } from '../src/web/files'
import { webSetup, type WebEnv } from './web-helpers'

let e: WebEnv
beforeEach(async () => { e = await webSetup() })
afterEach(() => e.cleanup())

const q = (p: string) => encodeURIComponent(p)
const ENDPOINTS = ['/api/files?path=', '/api/files/stat?path=', '/api/files/download?path=', '/api/files/text?path=', '/api/files/who?path=']
const CANARY = 'CANARY-7731-zq'

/** status, body and the headers a client could tell apart */
async function shape(b: InstanceType<WebEnv['Browser']>, url: string) {
  const r = await b.raw('GET', url)
  const h = [...r.headers].filter(([k]) => k !== 'date').sort()
  return JSON.stringify({ status: r.status, body: await r.text(), h })
}

function plantCanaries() {
  const w = (rel: string, s: string) => { fs.mkdirSync(path.dirname(path.join(e.root, rel)), { recursive: true }); fs.writeFileSync(path.join(e.root, rel), s) }
  w('경영/비밀_canary.md', `top secret ${CANARY} 경영\n`)
  w('인사/canary.csv', `name,${CANARY}\n`)
  w('공용/#recycle/canary.md', `${CANARY} in the recycle bin\n`)
  w('공용/@eaDir/canary.md', `${CANARY} in a NAS thumbnail folder\n`)
  w('영업/canary.txt', `${CANARY} sales\n`)
  // a link inside a readable folder to an unreadable file and folder
  fs.symlinkSync(path.join(e.root, '경영/비밀_canary.md'), path.join(e.root, '프로젝트/link_canary.md'))
  fs.symlinkSync(path.join(e.root, '경영'), path.join(e.root, '프로젝트/경영_link'))
  // a hard link of an unreadable file inside a readable folder (link count 2: closed)
  fs.linkSync(path.join(e.root, '인사/canary.csv'), path.join(e.root, '공용/hard_canary.csv'))
}

describe('session required; GET needs no CSRF token', () => {
  test('401 without a session on every endpoint; with a session, plain GETs work without CSRF or Origin', async () => {
    const anon = new e.Browser()
    for (const u of [...ENDPOINTS.map((x) => x + q('/프로젝트')), '/api/search?q=x']) {
      const r = await anon.call('GET', u)
      expect(r.status).toBe(401)
      expect(r.data.error).toBe('signed_out')
    }
    const kim = await e.as('kim')
    kim.csrf = undefined
    expect((await kim.call('GET', '/api/files?path=' + q('/프로젝트'))).status).toBe(200)
    // nothing here changes state: other methods are refused
    expect((await kim.call('POST', '/api/files?path=/', {})).status).toBe(405)
    expect((await kim.call('DELETE', '/api/files/download?path=' + q('/프로젝트/README.md'))).status).toBe(405)
  })
})

describe('reads per role (R1 for a person = a full-scope token of their own)', () => {
  test('roots: each person sees the folders their rules open; the admin gets no extra reads', async () => {
    const names = async (who: string) => (await (await e.as(who)).call('GET', '/api/files')).data.entries.map((x: { name: string }) => x.name).sort()
    expect(await names('kim')).toEqual(['개인_kim', '공용', '프로젝트'].sort())
    expect(await names('boss')).toEqual(['경영', '공용', '프로젝트'].sort())
    expect(await names('dion')).toEqual(['공용', '프로젝트'].sort())
    expect(await names('lee')).toEqual(['공용', '인사', '프로젝트'].sort())
  })

  test('kim cannot list, stat, download, read text, ask who, or search in 경영; boss can', async () => {
    const kim = await e.as('kim'), boss = await e.as('boss')
    for (const p of ['/경영', '/경영/손익.csv', '/경영/이사회_메모.pdf']) for (const ep of ENDPOINTS) expect((await kim.call('GET', ep + q(p))).status).toBe(404)
    expect((await kim.call('GET', '/api/search?q=매출&path=' + q('/경영'))).status).toBe(404)

    const list = await boss.call('GET', '/api/files?path=' + q('/경영'))
    expect(list.status).toBe(200)
    expect(list.data.entries.map((x: { name: string }) => x.name).sort()).toEqual(['손익.csv', '손익_요약.xlsx', '이사회_메모.pdf'].sort())
    const csv = list.data.entries.find((x: { name: string }) => x.name === '손익.csv')
    expect(csv).toMatchObject({ kind: 'file', path: '/경영/손익.csv', ext: 'csv', has_text: true, size: fs.statSync(path.join(e.root, '경영/손익.csv')).size })
    expect(typeof csv.mtime).toBe('number')
    const dl = await boss.raw('GET', '/api/files/download?path=' + q('/경영/손익.csv'))
    expect(dl.status).toBe(200)
    expect(Buffer.from(await dl.arrayBuffer()).equals(fs.readFileSync(path.join(e.root, '경영/손익.csv')))).toBe(true)
    const pdf = await boss.call('GET', '/api/files/text?path=' + q('/경영/이사회_메모.pdf'))
    expect(pdf.status).toBe(200)
    expect(pdf.data).toMatchObject({ extracted: true, truncated: false })
    expect(pdf.data.text).toContain('Revenue target')
    const s = await boss.call('GET', '/api/search?q=매출')
    expect(s.data.results.map((r: { path: string }) => r.path)).toContain('/경영/손익.csv')
  })

  test('personal folder: its owner only; folders show no size or time', async () => {
    const kim = await e.as('kim'), boss = await e.as('boss')
    const mine = await kim.call('GET', '/api/files?path=' + q('/개인_kim'))
    expect(mine.data.entries.map((x: { name: string }) => x.name)).toEqual(['메모.md'])
    expect((await boss.call('GET', '/api/files?path=' + q('/개인_kim'))).status).toBe(404)
    const root = (await kim.call('GET', '/api/files')).data.entries
    for (const f of root) expect(f).toMatchObject({ kind: 'folder', size: null, mtime: null })
  })

  test('a folder seen only as a path to a readable subfolder: lists that child only, who is restricted', async () => {
    fs.mkdirSync(path.join(e.root, '경영/공개'))
    fs.writeFileSync(path.join(e.root, '경영/공개/안내.md'), 'open to kim\n')
    setRule(e.db, path.join(e.root, '경영/공개'), 'kim', 'read')
    const kim = await e.as('kim')
    const l = await kim.call('GET', '/api/files?path=' + q('/경영'))
    expect(l.status).toBe(200)
    expect(l.data.readable).toBe(false)
    expect(l.data.entries.map((x: { name: string }) => x.name)).toEqual(['공개'])
    expect((await kim.call('GET', '/api/files/download?path=' + q('/경영/공개/안내.md'))).status).toBe(200)
    expect((await kim.call('GET', '/api/files/download?path=' + q('/경영/손익.csv'))).status).toBe(404)
    const w = await kim.call('GET', '/api/files/who?path=' + q('/경영'))
    expect(w.data).toEqual({ path: '/경영', folder: '/경영', restricted: true })
    expect(JSON.stringify(w.data)).not.toContain('boss')
  })
})

describe('hidden == missing, byte for byte', () => {
  test('every endpoint answers a hidden path exactly like a nonexistent one', async () => {
    plantCanaries()
    const kim = await e.as('kim')
    const pairs: [string, string][] = [
      ['/경영', '/없는폴더'],
      ['/경영/손익.csv', '/없는폴더/손익.csv'],
      ['/경영/손익.csv', '/프로젝트/없는파일.csv'],
      ['/인사/급여.csv', '/공용/없음.csv'],
      ['/공용/#recycle/옛_공지.md', '/공용/없음/옛_공지.md'],
      ['/공용/#recycle', '/공용/없음'],
      ['/공용/@eaDir/canary.md', '/공용/nope.md'],
      ['/공용/.DS_Store', '/공용/nope2'],
      ['/프로젝트/link_canary.md', '/프로젝트/nope.md'],
      ['/프로젝트/경영_link', '/프로젝트/nope'],
      ['/프로젝트/경영_link/손익.csv', '/프로젝트/nope/손익.csv'],
      ['/공용/hard_canary.csv', '/공용/nope.csv'],
      ['/프로젝트/../경영/손익.csv', '/프로젝트/../없음/손익.csv'],
    ]
    for (const [hidden, missing] of pairs) {
      for (const ep of ENDPOINTS) {
        const a = await shape(kim, ep + q(hidden)), b = await shape(kim, ep + q(missing))
        expect({ ep, hidden, a }).toEqual({ ep, hidden, a: b })
        expect(JSON.parse(a).status).toBe(404)
      }
      const a = await shape(kim, `/api/search?q=x&path=${q(hidden)}`), b = await shape(kim, `/api/search?q=x&path=${q(missing)}`)
      expect(a).toBe(b)
    }
    const boss = await e.as('boss')
    // boss: kim's personal folder is as missing as a folder that never was
    for (const ep of ENDPOINTS) expect(await shape(boss, ep + q('/개인_kim/메모.md'))).toBe(await shape(boss, ep + q('/개인_lee/메모.md')))
  })

  test('NAS system entries, links and hard links are not listed', async () => {
    plantCanaries()
    const kim = await e.as('kim')
    const names = async (p: string) => (await kim.call('GET', '/api/files?path=' + q(p))).data.entries.map((x: { name: string }) => x.name)
    expect(await names('/공용')).toEqual(['공지.md'])
    const proj = await names('/프로젝트')
    expect(proj).not.toContain('link_canary.md')
    expect(proj).not.toContain('경영_link')
  })
})

describe('"No AI" closes agents, not people; other flags close both', () => {
  test('a No-AI folder: people with rules see it on the web, their agents do not', async () => {
    setFlag(e.db, path.join(e.root, '프로젝트'), 'no_ai', true)
    const kim = await e.as('kim')
    expect((await kim.call('GET', '/api/files')).data.entries.map((x: { name: string }) => x.name)).toContain('프로젝트')
    const dl = await kim.raw('GET', '/api/files/download?path=' + q('/프로젝트/견적_2026.md'))
    expect(dl.status).toBe(200)
    expect(await dl.text()).toContain('한빛물산')
    expect((await kim.call('GET', '/api/files/text?path=' + q('/프로젝트/사양서.docx'))).data.text).toContain('한빛물산')
    expect((await kim.call('GET', '/api/search?q=한빛물산')).data.results.map((r: { path: string }) => r.path)).toContain('/프로젝트/견적_2026.md')
    const who = (await kim.call('GET', '/api/files/who?path=' + q('/프로젝트/견적_2026.md'))).data
    expect(who.flags.no_ai).toBe(true)
    expect(who.ai).toEqual({ blocked: true, people: [], groups: [] })
    expect(who.web).toContain('kim')
    // the agent side, same person: nothing
    const ls = await e.sh('kim', 'ls /; cat /프로젝트/견적_2026.md')
    expect(ls.stdout).not.toContain('프로젝트')
    expect(ls.stdout).not.toContain('한빛물산')
    // a person without rules still does not see it (No AI opens nothing)
    setFlag(e.db, path.join(e.root, '경영'), 'no_ai', true)
    expect((await kim.call('GET', '/api/files?path=' + q('/경영'))).status).toBe(404)
    expect((await (await e.as('boss')).call('GET', '/api/files?path=' + q('/경영'))).status).toBe(200)
  })

  test('quarantined and widened-pending folders are closed on the web too (hidden == missing)', async () => {
    const kim = await e.as('kim')
    for (const flag of ['quarantine', 'widened_pending'] as const) {
      setFlag(e.db, path.join(e.root, '프로젝트'), flag, true)
      expect((await kim.call('GET', '/api/files')).data.entries.map((x: { name: string }) => x.name)).not.toContain('프로젝트')
      for (const ep of ENDPOINTS) expect(await shape(kim, ep + q('/프로젝트/README.md'))).toBe(await shape(kim, ep + q('/없음/README.md')))
      setFlag(e.db, path.join(e.root, '프로젝트'), flag, false)
    }
    expect((await kim.call('GET', '/api/files?path=' + q('/프로젝트'))).status).toBe(200)
  })
})

describe('downloads are attachments only', () => {
  test('attachment, generic type, nosniff, sandbox CSP — also for an HTML file; Korean names in filename*', async () => {
    fs.writeFileSync(path.join(e.root, '프로젝트/evil.html'), '<script>alert(document.cookie)</script>')
    fs.writeFileSync(path.join(e.root, '프로젝트/그림.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    const kim = await e.as('kim')
    for (const [p, name] of [['/프로젝트/evil.html', 'evil.html'], ['/프로젝트/그림.svg', '그림.svg'], ['/프로젝트/견적_2026.md', '견적_2026.md']]) {
      const r = await kim.raw('GET', '/api/files/download?path=' + q(p!))
      expect(r.status).toBe(200)
      expect(r.headers.get('content-type')).toBe('application/octet-stream')
      expect(r.headers.get('x-content-type-options')).toBe('nosniff')
      const cd = r.headers.get('content-disposition')!
      expect(cd.startsWith('attachment;')).toBe(true)
      expect(cd).toContain(`filename*=UTF-8''${encodeURIComponent(name!)}`)
      expect(cd).not.toMatch(/[^\x20-\x7e]/)
      expect(r.headers.get('content-security-policy')).toContain('sandbox')
      expect(r.headers.get('cache-control')).toBe('no-store')
    }
    expect((await kim.call('GET', '/api/files/download?path=' + q('/프로젝트'))).status).toBe(400)
  })

  test('an NFD file name is shown, found and downloaded as NFC', async () => {
    const nfd = '회의_정리.md'.normalize('NFD')
    fs.writeFileSync(path.join(e.root, '프로젝트', nfd), 'NFD body\n')
    const kim = await e.as('kim')
    const names: string[] = (await kim.call('GET', '/api/files?path=' + q('/프로젝트'))).data.entries.map((x: { name: string }) => x.name)
    expect(names).toContain('회의_정리.md'.normalize('NFC'))
    expect(names.every((n) => n === n.normalize('NFC'))).toBe(true)
    for (const p of ['/프로젝트/회의_정리.md'.normalize('NFC'), '/프로젝트/회의_정리.md'.normalize('NFD')]) {
      const r = await kim.raw('GET', '/api/files/download?path=' + q(p))
      expect(r.status).toBe(200)
      expect(await r.text()).toBe('NFD body\n')
      expect(r.headers.get('content-disposition')).toContain(encodeURIComponent('회의_정리.md'.normalize('NFC')))
    }
    const s = await kim.call('GET', '/api/search?q=' + q('회의_정리'))
    expect(s.data.results.map((r: { path: string }) => r.path)).toContain('/프로젝트/회의_정리.md'.normalize('NFC'))
  })
})

describe('text', () => {
  test('extracted text of office files as a JSON string; plain files as they are; capped; no text for others', async () => {
    const kim = await e.as('kim')
    for (const [p, want] of [['/프로젝트/사양서.docx', '재고 관리'], ['/프로젝트/일정.hwpx', '1단계 설계'], ['/프로젝트/회의록.hwp', '킥오프'], ['/프로젝트/README.md', '# Projects']]) {
      const r = await kim.call('GET', '/api/files/text?path=' + q(p!))
      expect(r.status).toBe(200)
      expect(r.headers.get('content-type')).toContain('application/json')
      expect(r.data.text).toContain(want)
    }
    fs.writeFileSync(path.join(e.root, '프로젝트/큰.txt'), '가'.repeat(FILES_LIMITS.textBytes)) // 3 bytes each
    const big = await kim.call('GET', '/api/files/text?path=' + q('/프로젝트/큰.txt'))
    expect(big.data.truncated).toBe(true)
    expect(Buffer.byteLength(big.data.text)).toBeLessThanOrEqual(FILES_LIMITS.textBytes)
    expect(big.data.text).not.toContain('�')
    fs.writeFileSync(path.join(e.root, '프로젝트/사진.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const png = await kim.call('GET', '/api/files/text?path=' + q('/프로젝트/사진.png'))
    expect(png.status).toBe(422)
    expect((await kim.call('GET', '/api/files?path=' + q('/프로젝트'))).data.entries.find((x: { name: string }) => x.name === '사진.png').has_text).toBe(false)
  })
})

describe('search', () => {
  test('never returns names or snippets from unreadable files (canaries in hidden folders, links, recycle bins)', async () => {
    plantCanaries()
    const kim = await e.as('kim')
    for (const query of [CANARY, 'canary', '매출', '급여', '비밀']) {
      const r = await kim.call('GET', '/api/search?q=' + q(query))
      expect(r.status).toBe(200)
      const s = JSON.stringify(r.data)
      expect(s).not.toContain(CANARY + ' ')
      expect(s).not.toContain('경영')
      expect(s).not.toContain('인사')
      expect(s).not.toContain('영업')
      expect(s).not.toContain('recycle')
      expect(s).not.toContain('eaDir')
      expect(s).not.toContain('link_canary')
      expect(s).not.toContain('hard_canary')
    }
    const boss = await e.as('boss')
    const b = await boss.call('GET', '/api/search?q=' + q(CANARY))
    expect(b.data.results.map((r: { path: string }) => r.path)).toEqual(['/경영/비밀_canary.md'])
    expect(b.data.results[0].snippets[0].text).toContain(CANARY)
  })

  test('file names and full text, with snippets; scoped to a folder', async () => {
    const kim = await e.as('kim')
    const byName = await kim.call('GET', '/api/search?q=' + q('견적'))
    const hit = byName.data.results.find((r: { path: string }) => r.path === '/프로젝트/견적_2026.md')
    expect(hit).toMatchObject({ name_match: true, kind: 'file' })
    expect(hit.snippets[0].text).toContain('견적')
    const full = await kim.call('GET', '/api/search?q=' + q('한빛물산'))
    const paths = full.data.results.map((r: { path: string }) => r.path)
    expect(paths).toEqual(expect.arrayContaining(['/프로젝트/견적_2026.md', '/프로젝트/사양서.docx']))
    expect(paths).not.toContain('/영업/고객목록.csv')
    const docx = full.data.results.find((r: { path: string }) => r.path === '/프로젝트/사양서.docx')
    expect(docx).toMatchObject({ name_match: false })
    expect(docx.snippets[0].text).toContain('한빛물산')
    // case-insensitive, folders by name, scoped
    expect((await kim.call('GET', '/api/search?q=readme')).data.results[0].path).toBe('/프로젝트/README.md')
    expect((await kim.call('GET', '/api/search?q=' + q('프로젝트'))).data.results.map((r: { kind: string }) => r.kind)).toContain('folder')
    const scoped = await kim.call('GET', `/api/search?q=${q('공지')}&path=${q('/프로젝트')}`)
    expect(scoped.data.results).toEqual([])
    expect((await kim.call('GET', '/api/search?q=')).status).toBe(400)
    expect((await kim.call('GET', '/api/search?q=' + 'x'.repeat(FILES_LIMITS.queryChars + 1))).status).toBe(400)
  })
})

describe('who can see', () => {
  test('AI readers, people on the web and NAS readers of the folder', async () => {
    const kim = await e.as('kim'), boss = await e.as('boss')
    const p = (await kim.call('GET', '/api/files/who?path=' + q('/프로젝트/견적_2026.md'))).data
    expect(p).toMatchObject({ path: '/프로젝트/견적_2026.md', folder: '/프로젝트', restricted: false, personal_owner: null, nas: { mode: 'all', people: null } })
    expect(p.ai.blocked).toBe(false)
    expect(p.ai.groups).toEqual(['전체'])
    expect(p.ai.people.sort()).toEqual(['boss', 'dion', 'kim', 'lee', 'park'])
    const m = (await boss.call('GET', '/api/files/who?path=' + q('/경영'))).data
    expect(m).toMatchObject({ nas: { mode: 'chosen', people: ['boss'] }, ai: { blocked: false, people: ['boss'], groups: ['경영'] } })
    const own = (await kim.call('GET', '/api/files/who?path=' + q('/개인_kim'))).data
    expect(own).toMatchObject({ personal_owner: 'kim', ai: { people: ['kim'], groups: [] }, web: ['kim'] })
  })
})

describe('audit, without provenance', () => {
  test('web reads are audited per person and action; failures too; no provenance window is opened', async () => {
    const kim = await e.as('kim')
    const touches = () => e.db.query<{ n: number }, []>('SELECT count(*) AS n FROM touches').get()!.n
    const before = touches()
    await kim.call('GET', '/api/files?path=' + q('/프로젝트'))
    await kim.raw('GET', '/api/files/download?path=' + q('/프로젝트/견적_2026.md'))
    await kim.call('GET', '/api/files/text?path=' + q('/프로젝트/사양서.docx'))
    await kim.call('GET', '/api/search?q=' + q('한빛물산'))
    await kim.call('GET', '/api/files/download?path=' + q('/경영/손익.csv'))
    expect(touches()).toBe(before)
    const rows = e.db.query<{ person_id: number; token_id: number | null; tool: string; command: string; files: string; outcome: string }, [number]>(
      "SELECT person_id, token_id, tool, command, files, outcome FROM audit WHERE person_id = ? AND command LIKE 'files %' ORDER BY id").all(e.pid('kim'))
    expect(rows.map((r) => [r.command, r.outcome])).toEqual([
      ['files list /프로젝트', 'ok'],
      ['files download /프로젝트/견적_2026.md', 'ok'],
      ['files text /프로젝트/사양서.docx', 'ok'],
      ['files search "한빛물산" in /', 'ok'],
      ['files download /경영/손익.csv', 'not_found'],
    ])
    expect(rows.every((r) => r.tool === 'web' && r.token_id === null)).toBe(true)
    expect(JSON.parse(rows[1]!.files)).toEqual(['/프로젝트/견적_2026.md'])
    expect(JSON.parse(rows[3]!.files)).toEqual(expect.arrayContaining(['/프로젝트/견적_2026.md', '/프로젝트/사양서.docx']))
    expect(JSON.parse(rows[4]!.files)).toEqual([])
    // the person's own audit page shows them
    const mine = (await kim.call('GET', '/api/audit?view=mine')).data.entries
    expect(mine.some((x: { command: string; connection: string }) => x.command === 'files download /프로젝트/견적_2026.md' && x.connection === 'web')).toBe(true)
  })

  test('if the audit row cannot be written, nothing is returned', async () => {
    const kim = await e.as('kim')
    e.db.run('CREATE TRIGGER no_audit BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT, \'audit down\'); END')
    const log = console.error
    console.error = () => {}
    const r = await kim.raw('GET', '/api/files/download?path=' + q('/프로젝트/견적_2026.md')).finally(() => { console.error = log })
    expect(r.status).toBe(500)
    expect(await r.text()).not.toContain('한빛물산')
    e.db.run('DROP TRIGGER no_audit')
  })
})
