// Reconcile time for 10k files on local disk (plan 11-9 ①, local stand-in for the SMB measurement). Prints timings.
import { afterAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db'
import { reconcile, summary } from '../src/inplace/reconcile'
import { addPerson, registerFolder } from '../src/store'

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-bench-')))
afterAll(() => fs.rmSync(base, { recursive: true, force: true }))

test('10k files: baseline, unchanged pass, pass with changes', async () => {
  const share = path.join(base, 'share', '프로젝트')
  for (let d = 0; d < 100; d++) {
    const dir = path.join(share, `폴더${d}`)
    fs.mkdirSync(dir, { recursive: true })
    for (let f = 0; f < 100; f++) fs.writeFileSync(path.join(dir, `문서${f}.md`), `# 문서 ${d}-${f}\n\n${'내용 '.repeat(50 + (f % 30))}\n`)
  }
  const db = openDb(path.join(base, 'data'))
  addPerson(db, 'admin', true)
  registerFolder(db, share, { nasReaders: 'all' })
  const ms = (r: { ms: Record<string, number> }) => Object.entries(r.ms).map(([k, v]) => `${k} ${Math.round(v)} ms`).join(', ')

  const walkOnly = await reconcile(db, {}) // no data dir: identity + hash only, no mirror
  console.log(`10k baseline, identity + sha256:  ${ms(walkOnly)}\n  ${summary(walkOnly)}`)
  expect(walkOnly.files).toBe(10_000)
  db.exec('DELETE FROM fs_index')
  const first = await reconcile(db, { dataDir: path.join(base, 'data') })
  console.log(`10k baseline + text mirror:       ${ms(first)}`)
  const same = await reconcile(db, { dataDir: path.join(base, 'data') })
  console.log(`10k unchanged pass:               ${ms(same)}`)
  expect(same.hashed).toBe(0)
  expect(same.audit).toBe(0)

  for (let f = 0; f < 100; f++) fs.appendFileSync(path.join(share, '폴더1', `문서${f}.md`), '추가\n')
  fs.renameSync(path.join(share, '폴더2'), path.join(share, '폴더2_이름바꿈'))
  fs.renameSync(path.join(share, '폴더3'), path.join(share, '폴더4', '폴더3'))
  const changed = await reconcile(db, { dataDir: path.join(base, 'data') })
  console.log(`10k pass with 100 edits + 2 moves: ${ms(changed)}\n  ${summary(changed)}`)
  expect([changed.modified, changed.renamed, changed.moved, changed.hashed]).toEqual([100, 1, 1, 100])
  db.close()
}, 120_000)
