// File-level sharing tests (workstream A2) on the sharing fixture (test/share-helpers.ts) plus a finance folder
// boss manages: /재무팀/결산/2026-Q3.md (CANARY-Q3-7781) next to sibling.md (CANARY-SIB-1180), uploaded by boss so
// the server tracks them. kim, lee and park cannot read /재무팀 by any rule.
import fs from 'node:fs'
import path from 'node:path'
import { expect } from 'bun:test'
import { createManagedFolder } from '../src/managed/folders'
import { managedIdle } from '../src/managed/ops'
import { grantManage, setRule } from '../src/store'
import { shareSetup } from './share-helpers'

export const Q3 = '/재무팀/결산/2026-Q3.md'
export const SIB = '/재무팀/결산/sibling.md'

export async function fileShareSetup() {
  const e = await shareSetup()
  const team = createManagedFolder(e.db, e.dir, { name: '재무팀' })
  grantManage(e.db, team.path, 'boss')
  setRule(e.db, team.path, 'boss', 'write')
  const boss = await e.as('boss')
  expect((await boss.call('POST', '/api/files/folder', { path: '/재무팀', name: '결산' })).status).toBe(200)
  expect((await e.upload(boss, '/재무팀/결산', '2026-Q3.md', '# Q3\nCANARY-Q3-7781 매출\n')).status).toBe(200)
  expect((await e.upload(boss, '/재무팀/결산', 'sibling.md', '# sibling\nCANARY-SIB-1180\n')).status).toBe(200)
  expect((await e.upload(boss, '/재무팀', 'top.md', '# top\nCANARY-TOP-5521\n')).status).toBe(200)
  await managedIdle(e.db)
  type B = InstanceType<typeof e.Browser>
  const grantRows = () => e.db.query<{ file_uid: string; subject_type: string; subject_id: number; level: number }, []>('SELECT file_uid, subject_type, subject_id, level FROM file_grants ORDER BY rowid').all()
  const uidOf = (real: string) => {
    const st = fs.lstatSync(real, { bigint: true })
    return e.db.query<{ uid: string }, [string, string]>('SELECT uid FROM mfiles WHERE dev = ? AND ino = ?').get(String(st.dev), String(st.ino))?.uid ?? null
  }
  const real = (vp: string) => path.join(team.path, ...vp.split('/').slice(2))
  const shareFile = (b: B, p: string, body: Record<string, unknown>) => b.call('POST', '/api/share', { path: p, ...body })
  const give = (b: B, p: string, who: string, role: 'viewer' | 'editor' = 'viewer') => shareFile(b, p, { add: [{ subject: e.person(who), role }] })
  const ls = async (b: B, p: string) => {
    const r = await e.list(b, p)
    return r.status === 200 ? (r.data.entries as { name: string }[]).map((x) => x.name).sort() : r.status
  }
  const dl = async (b: B, p: string) => {
    const r = await b.call('GET', '/api/files/download?path=' + encodeURIComponent(p))
    return { status: r.status, body: typeof r.data === 'string' ? r.data : JSON.stringify(r.data) }
  }
  return { ...e, team, boss, grantRows, uidOf, real, shareFile, give, ls, dl }
}
export type FileShareEnv = Awaited<ReturnType<typeof fileShareSetup>>
