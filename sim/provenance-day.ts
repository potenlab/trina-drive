// Phase-0 experiment ★8 (plan §11): replay one office day through the real shell and draft box, then ask for each
// draft "if a person filed this where it belongs, would it widen?" (R6), with NAS readers as seeded and all "unknown",
// counting all sources (strong + weak, as the plan decides) and strong only (for comparison).
//   bun run sim/provenance-day.ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db'
import { seedDemo } from '../src/demo'
import { isWidening } from '../src/policy'
import { makeCtx, Session } from '../src/session'
import { runShell } from '../src/shell'
import { createToken, verifyToken } from '../src/store'

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tdrive-sim-')))
const db = openDb(dir)
const { root, tokens } = seedDemo(db, dir)
const secrets: Record<string, string> = { boss: tokens.boss.token, kim: tokens.kim.token, park: createToken(db, 'park', { name: 'park-laptop' }).token, dion: createToken(db, 'dion', { name: 'dion-desk' }).token }
let clock = new Date('2026-10-22T09:00:00+09:00').getTime()
const ctx = { ...makeCtx(db, dir), now: () => clock }
const at = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); clock = new Date(`2026-10-22T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+09:00`).getTime() }

/** [time, who, command, (draft written, folder a person would file it into)] */
type Step = [string, string, string, [string, string]?]
const DAY: Step[] = [
  ['09:05', 'boss', 'grep -r 매출 / | head'],
  ['09:20', 'boss', 'cat /경영/손익.csv; head -3 /경영/이사회_메모.pdf'],
  ['09:40', 'boss', 'printf "# 10월 경영 메모\\n매출 점검\\n" > /drafts/경영메모.md', ['경영메모.md', '경영']],
  ['09:10', 'kim', 'grep -rn 납기 /'],
  ['09:30', 'kim', 'cat /프로젝트/견적_2026.md'],
  ['09:45', 'kim', 'sed "s/48,000,000/52,000,000/" /프로젝트/견적_2026.md > /drafts/견적_v2.md', ['견적_v2.md', '프로젝트']],
  ['10:00', 'park', 'grep -c , /영업/고객목록.csv; cat /영업/고객목록.csv'],
  ['10:20', 'park', 'echo "# 주간 영업 보고" > /drafts/영업보고.md', ['영업보고.md', '영업']],
  ['10:30', 'dion', 'ls /; cat /공용/공지.md'],
  ['10:40', 'dion', 'echo "# 11월 공지 초안" > /drafts/공지_초안.md', ['공지_초안.md', '공용']],
  ['11:00', 'boss', 'ls /프로젝트; cat /프로젝트/견적_2026.md'],
  ['11:15', 'boss', 'printf "# 견적 검토 의견\\n- 단가 유지\\n" > /drafts/견적_검토.md', ['견적_검토.md', '프로젝트']],
  ['13:30', 'park', 'cat /프로젝트/사양서.docx | head -5'],
  ['13:50', 'park', 'echo "# 한빛물산 제안서" > /drafts/제안서.md', ['제안서.md', '프로젝트']],
  ['14:00', 'kim', 'cat /drafts/견적_v2.md; cat /공용/공지.md'],
  ['14:10', 'kim', 'echo "- 할인 조건 추가" >> /drafts/견적_v2.md', ['견적_v2.md', '프로젝트']],
  ['15:00', 'kim', 'cat /개인_kim/메모.md'],
  ['15:10', 'kim', 'echo "# 회의 메모 정리" > /drafts/회의정리.md', ['회의정리.md', '프로젝트']],
  ['16:00', 'boss', 'grep -rl 한빛 /'],
  ['16:30', 'boss', 'echo "# 고객 현황 요약" > /drafts/고객요약.md', ['고객요약.md', '공용']],
  ['17:30', 'park', 'echo "# 내일 할 일" > /drafts/todo.md', ['todo.md', '영업']],
]

const filed = new Map<string, { who: string; draft: string; target: string }>()
for (const [t, who, cmd, d] of [...DAY].sort((a, b) => a[0].localeCompare(b[0]))) {
  at(t)
  const s = new Session(ctx, verifyToken(db, secrets[who]!)!)
  const r = await runShell(s, cmd)
  s.commit('bash', cmd, `exit ${r.exitCode}`)
  if (r.exitCode !== 0) console.error(`  ! ${who} ${cmd}: ${r.stderr.trim()}`)
  if (d) filed.set(`${who}/${d[0]}`, { who, draft: d[0], target: d[1] })
}

const folderId = (name: string) => db.query<{ id: number }, [string]>('SELECT id FROM folders WHERE path = ?').get(path.join(root, name))!.id
const label = (id: number) => path.relative(root, db.query<{ path: string }, [number]>('SELECT path FROM folders WHERE id = ?').get(id)!.path)
const srcOf = (who: string, draft: string) => db.query<{ folder_id: number; strong: number }, [number, string]>(
  'SELECT s.folder_id, s.strong FROM draft_src s JOIN drafts d ON d.id = s.draft_id WHERE d.token_id = ? AND d.path = ? AND d.deleted_at IS NULL')
  .all(verifyToken(db, secrets[who]!)!.id, draft)

const seeded = db.query<{ id: number; nas_readers: string }, []>('SELECT id, nas_readers FROM folders WHERE registered = 1').all()
const withNas = <T>(mode: 'seeded' | 'unknown', f: () => T): T => {
  if (mode === 'unknown') db.exec(`UPDATE folders SET nas_readers = 'unknown' WHERE registered = 1 AND personal_owner IS NULL`)
  try { return f() } finally { for (const r of seeded) db.query('UPDATE folders SET nas_readers = ? WHERE id = ?').run(r.nas_readers, r.id) }
}

console.log('draft (token)               | filed into | sources (weak marked ~)                | widen: all/strong (seeded NAS) | all/strong (NAS unknown)')
const perToken = new Map<string, number[]>()
for (const { who, draft, target } of filed.values()) {
  const src = srcOf(who, draft)
  const all = src.map((s) => s.folder_id), strong = src.filter((s) => s.strong).map((s) => s.folder_id)
  const tid = folderId(target)
  const res = (['seeded', 'unknown'] as const).flatMap((m) => withNas(m, () => [isWidening(db, all, tid), isWidening(db, strong, tid)]))
  const yn = (b: boolean) => (b ? 'YES' : 'no ')
  console.log(`${(draft + ` (${who})`).padEnd(28)}| ${target.padEnd(10)} | ${src.map((s) => (s.strong ? '' : '~') + label(s.folder_id)).join(', ').padEnd(38)} | ${yn(res[0]!)} / ${yn(res[1]!)}                     | ${yn(res[2]!)} / ${yn(res[3]!)}`)
  const c = perToken.get(who) ?? [0, 0, 0, 0]
  res.forEach((b, i) => (c[i]! += b ? 1 : 0))
  perToken.set(who, c)
}
console.log('\nwidening drafts per token per day (all / strong-only; seeded NAS | unknown NAS):')
for (const [who, c] of perToken) console.log(`  ${who.padEnd(5)} ${c[0]} / ${c[1]}  |  ${c[2]} / ${c[3]}`)
console.log('plan gate: more than 5 per token per day means the rule needs redesign')
db.close()
fs.rmSync(dir, { recursive: true, force: true })
