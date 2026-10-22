// `demo seed`: a small Korean/English company tree, people, groups, rules, NAS readers and tokens.
import fs from 'node:fs'
import path from 'node:path'
import type { DB } from './db'
import { sampleDocx, sampleHwp, sampleHwpx, samplePdf, sampleXlsx } from './samples'
import { addGroup, addMember, addPerson, createToken, registerFolder, setRule, StoreError } from './store'

export const SAMPLE_FILES: Record<string, string | Uint8Array> = {
  '경영/손익.csv': '항목,2026Q3\n매출,1240000000\n영업이익,182000000\n순이익,131000000\n',
  '경영/손익_요약.xlsx': sampleXlsx('손익', [['항목', '금액'], ['매출', 1240000000], ['영업이익', 182000000]]),
  '경영/이사회_메모.pdf': samplePdf(['Board memo - 2026 Q3', 'Revenue target: 12.4B KRW', 'Confidential: management only']),
  '프로젝트/README.md': '# Projects\n\nQuotes, specs and schedules for client work. Everyone can read this folder.\n',
  '프로젝트/견적_2026.md': '# 견적 2026\n\n- 고객: 한빛물산\n- 금액: 48,000,000원\n- 납기: 2026-12-15\n- 담당: kim\n',
  '프로젝트/사양서.docx': sampleDocx(['한빛물산 재고 관리 시스템 사양서', '1. 범위: 입출고, 재고 조회, 월말 정산', '2. 납기: 2026-12-15']),
  '프로젝트/일정.hwpx': sampleHwpx(['프로젝트 일정표', '1단계 설계 2026-10-01 ~ 2026-10-31', '2단계 개발 2026-11-01 ~ 2026-12-10']),
  '프로젝트/회의록.hwp': sampleHwp(['킥오프 회의록', '참석: kim, park', '결정: 2주 단위 중간 보고']),
  '인사/급여.csv': '이름,기본급,상여\n김민수,4200000,0\n이서연,3900000,500000\n박준호,4600000,0\n',
  '영업/고객목록.csv': '고객,담당,연락처\n한빛물산,park,02-555-0101\n푸른식품,park,031-555-0199\n',
  '공용/공지.md': '# 공지\n\n10월 31일 사무실 대청소. Office cleanup on Oct 31.\n',
  '공용/#recycle/옛_공지.md': '# 지난 공지 (deleted)\n',
  '공용/.DS_Store': 'not a document',
  '개인_kim/메모.md': '# kim 메모\n\n- 견적서 금액 다시 확인\n',
}

export function writeSampleTree(root: string) {
  for (const [rel, content] of Object.entries(SAMPLE_FILES)) {
    const p = path.join(root, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
  }
}

export function seedDemo(db: DB, dataDir: string) {
  if (db.query('SELECT 1 FROM people LIMIT 1').get()) throw new StoreError('this data directory already has people; use a fresh --data directory for the demo')
  const root = path.join(dataDir, 'sample')
  writeSampleTree(root)
  const people = { dion: true, kim: false, boss: false, lee: false, park: false }
  for (const [n, admin] of Object.entries(people)) addPerson(db, n, admin)
  for (const g of ['전체', '경영', '인사', '영업']) addGroup(db, g)
  for (const n of Object.keys(people)) addMember(db, '전체', n)
  addMember(db, '경영', 'boss'); addMember(db, '인사', 'lee'); addMember(db, '영업', 'park')
  const dir = (d: string) => path.join(root, d)
  registerFolder(db, dir('경영'), { nasReaders: ['boss'] })
  registerFolder(db, dir('프로젝트'), { nasReaders: 'all' })
  registerFolder(db, dir('인사'), { nasReaders: ['lee'] })
  registerFolder(db, dir('영업'), { nasReaders: ['park'] })
  registerFolder(db, dir('공용'), { nasReaders: 'all' })
  registerFolder(db, dir('개인_kim'), { personalOwner: 'kim' })
  setRule(db, dir('경영'), '@경영', 'read')
  setRule(db, dir('프로젝트'), '@전체', 'write')
  setRule(db, dir('인사'), '@인사', 'read')
  setRule(db, dir('영업'), '@영업', 'read')
  setRule(db, dir('공용'), '@전체', 'read')
  const tokens = {
    kim: createToken(db, 'kim', { name: 'kim-laptop' }),
    boss: createToken(db, 'boss', { name: 'boss-laptop' }),
    bossNarrow: createToken(db, 'boss', { name: 'boss-projects', scope: [dir('프로젝트')] }),
  }
  return { root, tokens }
}
