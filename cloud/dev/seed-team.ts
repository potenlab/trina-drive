#!/usr/bin/env bun
// The scenarios' team contents (plan §5 "시드"), made through the drive's own web API as its admin — the same calls the
// web app makes, so the seed works on the local stack and on an AWS test team alike:
//
//   /공용          Anyone in the team · Editor · boss Manager       notice.md   CANARY-PUB-1104
//   /경영          Restricted · group 경영 Editor · No AI      board.md    CANARY-MGT-2208
//   /재무          Restricted · group 재무 Viewer      결산.md     CANARY-FIN-7731
//   /프로젝트      Anyone · Viewer; kim Editor + Manager; promote on   plan.md   CANARY-PRJ-3315
//   /프로젝트/비밀 Restrict here: kim Editor, boss + sam Viewer       secret.md CANARY-SEC-9046
//   /인사          Restricted · group 경영 Editor · boss Manager · No AI     hr.md   CANARY-HR-5527
//   groups: 경영 = boss, 재무 = sam + kim. mina has only what everyone has.
//
// The team admin (alex) is in no group: an admin does not read files by being admin (plan §3.1).
// Run alone: bun cloud/dev/seed-team.ts [slug]   (makes the fixture team first if needed: cloud/dev/e2e/run.ts --seed)
import type { Drive } from './e2e/lib/drive'
import type { Fixture } from './e2e/lib/fixture'

export const CANARY = {
  공용: 'CANARY-PUB-1104', 경영: 'CANARY-MGT-2208', 재무: 'CANARY-FIN-7731', 프로젝트: 'CANARY-PRJ-3315', 비밀: 'CANARY-SEC-9046', 인사: 'CANARY-HR-5527',
} as const

/** the seeded files, vpath → canary */
export const FILES: Record<string, string> = {
  '/공용/notice.md': CANARY.공용, '/경영/board.md': CANARY.경영, '/재무/결산.md': CANARY.재무,
  '/프로젝트/plan.md': CANARY.프로젝트, '/프로젝트/비밀/secret.md': CANARY.비밀, '/인사/hr.md': CANARY.인사,
}

export interface Seeded {
  folders: Record<string, number>   // 공용, 경영, 재무, 프로젝트, 프로젝트/비밀, 인사 → folder id
  groups: Record<string, number>    // 경영, 재무, everyone
  people: Record<string, number>    // alex/boss/mina/sam/kim → person id
  at: number
}

const ok = async (what: string, p: Promise<{ status: number; text: string }>) => {
  const r = await p
  if (r.status !== 200 && r.status !== 201) throw new Error(`seed: ${what}: ${r.status} ${r.text.slice(0, 300)}`)
  return r as { status: number; text: string; json: () => any }
}

export async function seedTeam(admin: Drive, fx: Pick<Fixture, 's' | 'slug'>): Promise<Seeded> {
  const view = async () => (await ok('people', admin.get('/people'))).json() as { people: { id: number; name: string; email?: string }[]; groups: { id: number; name: string; members: number[] }[] }
  let pv = await view()
  const pid = (name: string) => pv.people.find((p) => p.name === name)?.id ?? 0
  const people: Record<string, number> = { alex: pid(fx.s.admin.name) }
  for (const n of ['boss', 'mina', 'sam', 'kim']) people[n] = pid(fx.s.people[n]!.name)
  if (Object.values(people).some((x) => !x)) throw new Error(`seed: people missing on the drive: ${JSON.stringify(people)}`)

  // groups (the Everyone group exists once a public folder is made; its id comes from the people view afterwards)
  const groups: Record<string, number> = {}
  for (const [g, members] of [['경영', ['boss']], ['재무', ['sam', 'kim']]] as const) {
    let id = pv.groups.find((x) => x.name === g)?.id
    if (!id) id = (await ok(`group ${g}`, admin.api('POST', '/groups', { name: g }))).json().id as number
    for (const m of members) await ok(`${m} in ${g}`, admin.api('PUT', `/groups/${id}/members/${people[m]}`))
    groups[g] = id
  }

  // top folders (managed storage: the server makes them)
  const existing = (await ok('folders', admin.get('/folders'))).json().folders as { id: number; name?: string; mount_name?: string; vpath?: string }[]
  const findTop = (n: string) => existing.find((f) => (f.vpath ?? `/${f.name ?? f.mount_name}`) === `/${n}`)?.id
  const top = async (name: string, body: Record<string, unknown>) => findTop(name) ?? (await ok(`folder ${name}`, admin.api('POST', '/folders', { name, managed: true, ...body }))).json().id as number
  const folders: Record<string, number> = {}
  folders.공용 = await top('공용', { template: 'public' })
  folders.경영 = await top('경영', { template: 'custom' })
  folders.재무 = await top('재무', { template: 'custom' })
  folders.프로젝트 = await top('프로젝트', { template: 'public', read_only: true })
  folders.인사 = await top('인사', { template: 'custom' })
  pv = await view()
  groups.everyone = pv.groups.find((g) => ['everyone', '전체', '전원'].includes(g.name))?.id ?? 0

  const rule = (f: string, type: 'person' | 'group', id: number, level: 'none' | 'read' | 'write') =>
    ok(`rule ${f} ${type}:${id} ${level}`, admin.api('PUT', `/folders/${folders[f]}/rules`, { subject_type: type, subject_id: id, level }))
  await rule('공용', 'group', groups.everyone, 'write')
  await rule('경영', 'group', groups.경영!, 'write')
  await rule('재무', 'group', groups.재무!, 'read')
  await rule('프로젝트', 'group', groups.everyone, 'read')
  await rule('프로젝트', 'person', people.kim!, 'write')
  await rule('인사', 'group', groups.경영!, 'write')
  await ok('kim manages 프로젝트', admin.api('PUT', `/folders/${folders.프로젝트}/managers/${people.kim}`))
  await ok('boss manages 인사', admin.api('PUT', `/folders/${folders.인사}/managers/${people.boss}`))
  // boss approves AI promotions into /공용 of drafts made from what he reads (/프로젝트/비밀: S24)
  await ok('boss manages 공용', admin.api('PUT', `/folders/${folders.공용}/managers/${people.boss}`))
  for (const f of ['공용', '프로젝트', '재무']) await ok(`promote on ${f}`, admin.api('PUT', `/folders/${folders[f]}/promote`, { enabled: true }))

  // files: written by people who may write there (the admin reads none of the restricted folders)
  const as = async (who: string) => (fx as Fixture).drive(who as never)
  // a session made a moment ago can be gone (the member sync that follows a console change signs people out once):
  // sign in again and retry once
  const put = async (who: string, folder: string, name: string, canary: string) => {
    const body = `# ${name}\n${canary} — seeded for the end-to-end scenarios (${fx.slug}).\n매출 결산 1,234\n`
    let r = await (await as(who)).upload(folder, name, body)
    if (r.status === 401) { (fx as Fixture).forget(who as never); r = await (await as(who)).upload(folder, name, body) }
    return ok(`upload ${folder}/${name}`, Promise.resolve(r))
  }
  // the restricted folders get a temporary rule for the uploader where nobody of theirs writes (재무 is Viewer-only)
  await put('admin', '/공용', 'notice.md', CANARY.공용)
  await put('boss', '/경영', 'board.md', CANARY.경영)
  await put('boss', '/인사', 'hr.md', CANARY.인사)
  await rule('재무', 'person', people.sam!, 'write')
  await put('sam', '/재무', '결산.md', CANARY.재무)
  await rule('재무', 'person', people.sam!, 'none')
  await put('kim', '/프로젝트', 'plan.md', CANARY.프로젝트)
  await ok('mkdir 프로젝트/비밀', (await as('kim')).mkdir('/프로젝트', '비밀'))
  await put('kim', '/프로젝트/비밀', 'secret.md', CANARY.비밀)

  // 프로젝트/비밀: Restrict here, keeping kim (Editor) and boss + sam (Viewer)
  folders['프로젝트/비밀'] = (await ok('subfolder 비밀', admin.api('POST', `/folders/${folders.프로젝트}/subfolders`, { rel: '비밀' }))).json().id
  const sub = folders['프로젝트/비밀']!
  await ok('비밀 kim', admin.api('PUT', `/folders/${sub}/rules`, { subject_type: 'person', subject_id: people.kim, level: 'write' }))
  for (const n of ['boss', 'sam']) await ok(`비밀 ${n}`, admin.api('PUT', `/folders/${sub}/rules`, { subject_type: 'person', subject_id: people[n], level: 'read' }))
  await ok('비밀 restrict here', admin.api('PATCH', `/folders/${sub}`, { inherit_break: true }))

  // No AI last (the uploads above are people's own, not agents')
  for (const f of ['경영', '인사']) await ok(`No AI ${f}`, admin.api('PATCH', `/folders/${folders[f]}`, { no_ai: true }))
  return { folders, groups, people, at: Date.now() }
}

if (import.meta.main) {
  const { setup } = await import('./e2e/run')
  const { fx } = await setup({ target: process.env.E2E_TARGET === 'aws' ? 'aws' : 'local', verbose: true })
  console.log(JSON.stringify(fx.s.seeded, null, 2))
}
