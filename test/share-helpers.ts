// Sharing tests (workstream A1) on managed storage: the demo people (dion = admin, kim, boss, lee, park; groups 전체 =
// everyone = "Anyone in Trina", 경영 = boss, 인사 = lee, 영업 = park) plus the plan's seed folders as managed team folders:
//   재무      (Restricted: group 재무 = park, Viewer; canary CANARY-FIN-7731)
//   Projects  (Anyone in Trina: Viewer, boss manages it, kim is an Editor; canary CANARY-PRJ-1001; Projects/비밀 below)
//   인사관리  (group 인사 = lee, Editor; No AI; canary CANARY-HR-5150)
import fs from 'node:fs'
import path from 'node:path'
import { expect } from 'bun:test'
import { createManagedFolder } from '../src/managed/folders'
import { managedIdle } from '../src/managed/ops'
import { setPromote } from '../src/promote'
import { addGroup, addMember, grantManage, setRule } from '../src/store'
import { totpAt } from '../src/web/totp'
import { totpSecretOf } from '../src/web/mfa'
import { managedSetup } from './managed-helpers'

export async function shareSetup() {
  const e = await managedSetup()
  const mk = (name: string) => createManagedFolder(e.db, e.dir, { name })
  addGroup(e.db, '재무'); addMember(e.db, '재무', 'park')
  const fin = mk('재무'), proj = mk('Projects'), hr = mk('인사관리')
  setRule(e.db, fin.path, '@재무', 'read')
  setRule(e.db, proj.path, '@전체', 'read')
  setRule(e.db, proj.path, 'kim', 'write')
  grantManage(e.db, proj.path, 'boss')
  setRule(e.db, proj.path, 'boss', 'write')
  setRule(e.db, hr.path, '@인사', 'write')
  e.db.query('UPDATE folders SET no_ai = 1 WHERE id = ?').run(hr.id)
  fs.writeFileSync(path.join(fin.path, '결산.md'), '# 결산\n\nCANARY-FIN-7731 매출 1,240,000,000\n')
  fs.writeFileSync(path.join(proj.path, 'readme.md'), '# Projects\n\nCANARY-PRJ-1001\n')
  fs.mkdirSync(path.join(proj.path, '비밀'))
  fs.writeFileSync(path.join(proj.path, '비밀', 'plan.md'), '# secret plan\n\nCANARY-SEC-4242\n')
  fs.writeFileSync(path.join(hr.path, '급여.md'), '# 급여\n\nCANARY-HR-5150\n')
  for (const n of ['kim', 'boss', 'lee', 'park', 'dion']) e.addToken(`${n}-ai`, n, { name: `${n}-agent` })
  type B = InstanceType<typeof e.Browser>
  const gid = (name: string) => e.db.query<{ id: number }, [string]>('SELECT id FROM groups WHERE name = ?').get(name)!.id
  const view = (b: B, p: string) => b.call('GET', '/api/share?path=' + encodeURIComponent(p))
  const share = (b: B, body: Record<string, unknown>) => b.call('POST', '/api/share', body)
  const person = (name: string) => ({ type: 'person' as const, id: e.pid(name) })
  const group = (name: string) => ({ type: 'group' as const, id: gid(name) })
  /** what an agent with this person's token finds (bash) */
  const agent = async (who: string, cmd: string) => { const r = await e.tool(`${who}-ai`, 'bash', { command: cmd }); return r.content.map((c: { text: string }) => c.text).join('\n') }
  const search = async (b: B, q: string) => ((await b.call('GET', `/api/search?q=${encodeURIComponent(q)}`)).data.results ?? []).map((r: { path: string }) => r.path)
  const sharedWithMe = async (b: B) => ((await b.call('GET', '/api/shared-with-me')).data.items as { path: string }[]).map((x) => x.path)
  /** an authenticator app for this browser's person; returns a function giving the next valid code */
  async function addTotp(b: B, name: string) {
    const s = await b.call('POST', '/api/me/totp/setup')
    expect(s.status).toBe(200)
    expect((await b.call('POST', '/api/me/totp/confirm', { code: totpAt(s.data.secret, Date.now() - 30_000) })).status).toBe(200)
    const secret = totpSecretOf(e.db, e.pid(name))!
    let step = 0
    return () => totpAt(secret, Date.now() + 30_000 * step++)
  }
  /** an agent of `who` reads `from`, writes a draft from it and promotes it into `folder` (promote is turned on there) */
  async function promoteFrom(who: string, from: string, folder: string, name: string, content: string) {
    const folderRow = e.db.query<{ id: number }, [string]>('SELECT id FROM folders WHERE registered = 1 AND mount_name = ?').get(folder.split('/')[1]!)!
    setPromote(e.db, folderRow.id, true, null)
    expect((await e.tool(`${who}-ai`, 'read', { path: from })).isError).toBeFalsy()
    expect((await e.tool(`${who}-ai`, 'write', { path: `/drafts/${name}`, content })).isError).toBeFalsy()
    const r = await e.tool(`${who}-ai`, 'promote', { draft: `/drafts/${name}`, folder, name })
    await managedIdle(e.db)
    return r.structuredContent as { status: string; path?: string; approval_id?: number }
  }
  const widened = () => e.db.query<{ id: number; status: string; path: string }, []>('SELECT id, status, path FROM widened ORDER BY id').all()
  return { ...e, fin, proj, hr, gid, view, share, person, group, agent, search, sharedWithMe, addTotp, promoteFrom, widened }
}
export type ShareEnv = Awaited<ReturnType<typeof shareSetup>>
