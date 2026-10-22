// Security fixture: the demo company plus every shape the permission review (review-permissions §7) asks about.
// Each file holds a unique canary string; `FILES` says, from plan §4.1 (R0, R1), which roles may read it.
// Expected values are written out by hand here, never computed by the code under test.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { sampleDocx } from '../../src/samples'
import { createToken, registerFolder, revokeToken, setFlag, setRule } from '../../src/store'
import { setup } from '../helpers'

/** Tokens the matrix runs as. `expired` and `revoked` exist only to be refused at the entrances. */
export const ROLES = ['dion', 'kim', 'boss', 'bossNarrow', 'lee', 'park', 'kimRO', 'kimScoped'] as const
export type Role = (typeof ROLES)[number]

/** Full-scope tokens of people in group 전체 (everyone). */
const ALL: Role[] = ['dion', 'kim', 'boss', 'lee', 'park', 'kimRO']

/** The NAS / OS system folders of R1 ⑥ (plus the OS litter names.ts also hides). */
export const SYSTEM_DIRS = ['#recycle', '#snapshot', '@Recycle', '@Recently-Snapshot', '.snapshot', '~snapshot', '@eaDir', '.@__thumb', '.Trashes', '$RECYCLE.BIN', '.TemporaryItems']

export interface FileCase { key: string; vpath: string; readers: Role[]; why: string }

/** vpath -> who may read it (R1). Files are created by `securitySetup`, each with its own canary. */
export const FILES: FileCase[] = [
  { key: 'mgmt', vpath: '/경영/c.md', readers: ['boss'], why: 'R0 group rule @경영 read' },
  { key: 'mgmtDocx', vpath: '/경영/보고.docx', readers: ['boss'], why: 'R0; office text comes from the mirror' },
  { key: 'mgmtPub', vpath: '/경영/공개/c.md', readers: ALL, why: 'rule below a hidden folder: shown as a bare path' },
  { key: 'proj', vpath: '/프로젝트/c.md', readers: [...ALL, 'bossNarrow'], why: '@전체 write ≥ read' },
  { key: 'projPrivate', vpath: '/프로젝트/비공개/c.md', readers: ['boss', 'bossNarrow'], why: 'inherit break: only boss read' },
  { key: 'projSub', vpath: '/프로젝트/하위/c.md', readers: [...ALL, 'bossNarrow'], why: 'child without break inherits' },
  { key: 'projNested', vpath: '/프로젝트/외주/c.md', readers: ['park'], why: 'nested registration is a break (R0): parent @전체 does not reach in' },
  { key: 'hr', vpath: '/인사/c.csv', readers: ['lee'], why: 'R0 @인사' },
  { key: 'hrHardlinked', vpath: '/인사/평가.csv', readers: [], why: 'R1 ⑤ link count must be 1 (both names closed)' },
  { key: 'projHardlink', vpath: '/프로젝트/평가사본.csv', readers: [], why: 'R1 ⑤ hard link of 인사/평가.csv' },
  { key: 'pub', vpath: '/공용/c.md', readers: ALL, why: '@전체 read' },
  { key: 'maxNone', vpath: '/공용/회계/c.md', readers: [...ALL, 'kimScoped'], why: 'R0 max(person none, inherited group read) = read' },
  { key: 'maxBreak', vpath: '/공용/회계2/c.md', readers: ALL, why: 'R0 break: max(kim none, @전체 read) = read' },
  { key: 'kimOnly', vpath: '/공용/kim만/c.md', readers: ['kim', 'kimRO'], why: 'break + person rule' },
  { key: 'noAi', vpath: '/공용/잠금/c.md', readers: [], why: 'R0 no-AI flag' },
  { key: 'noAiBelow', vpath: '/공용/잠금/아래/c.md', readers: [], why: 'flags come down from every ancestor; a break + rule below cannot reopen' },
  { key: 'quarantine', vpath: '/공용/격리/c.md', readers: [], why: 'R1 ② quarantine' },
  { key: 'widened', vpath: '/공용/대기/c.md', readers: [], why: 'R1 ② widened-pending' },
  { key: 'noAiMount', vpath: '/대외비/c.md', readers: [], why: 'no-AI on a registered folder' },
  { key: 'personal', vpath: '/개인_kim/c.md', readers: ['kim', 'kimRO'], why: 'personal folder: owner only (admin too is out)' },
  { key: 'personalSub', vpath: '/개인_kim/sub/c.md', readers: ['kim', 'kimRO'], why: 'personal folder below' },
  { key: 'sales', vpath: '/영업/c.md', readers: ['park'], why: 'R0 @영업' },
  ...SYSTEM_DIRS.map((d, i): FileCase => ({ key: `sys${i}`, vpath: `/공용/${d}/c.md`, readers: [], why: `R1 ⑥ NAS system folder ${d}` })),
  { key: 'sysUpper', vpath: '/공용/sub/#RECYCLE/c.md', readers: [], why: 'R1 ⑥ compared case-insensitively' },
  { key: 'dsStore', vpath: '/공용/.DS_Store', readers: [], why: 'OS litter' },
  { key: 'appleDouble', vpath: '/공용/._c.md', readers: [], why: 'AppleDouble' },
  { key: 'officeLock', vpath: '/공용/~$문서.docx', readers: [], why: 'office lock file' },
]

/** Paths that are links of some kind; nobody reads through them (R1 ⑤). */
export const LINKS: FileCase[] = [
  { key: 'symlinkFile', vpath: '/프로젝트/급여링크.csv', readers: [], why: 'R1 ⑤ symbolic link to 인사/c.csv' },
  { key: 'symlinkDir', vpath: '/프로젝트/hr/c.csv', readers: [], why: 'R1 ⑤ linked folder step' },
  { key: 'symlinkDirDeep', vpath: '/공용/회계/hr2/c.csv', readers: [], why: 'R1 ⑤ linked folder step below a readable folder' },
  { key: 'xsym', vpath: '/프로젝트/참고.xlsx', readers: [], why: 'R1 ⑤ XSym (Minshall-French) link file written by a Mac over SMB' },
]

export const ALL_CASES = [...FILES, ...LINKS]

/** A Minshall-French symlink file as macOS smbfs writes it: exactly 1067 bytes. */
export function xsym(target: string): Buffer {
  const t = Buffer.from(target)
  const head = Buffer.from(`XSym\n${String(t.length).padStart(4, '0')}\n${crypto.createHash('md5').update(t).digest('hex')}\n`)
  return Buffer.concat([head, t, Buffer.from('\n'), Buffer.alloc(1067 - head.length - t.length - 1, ' ')])
}

export function securitySetup() {
  const e = setup()
  const salt = crypto.randomBytes(3).toString('hex')
  const canary = new Map<string, string>()
  const R = (rel: string) => path.join(e.root, rel)
  const put = (vpath: string, key: string) => {
    const c = `CANARY_${key}_${salt}`
    canary.set(key, c)
    const p = R(vpath.slice(1))
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, vpath.endsWith('.docx') ? sampleDocx(['보고서', c]) : `secret line ${c}\n매출 ${key}\n`)
  }
  for (const f of FILES) if (f.key !== 'projHardlink') put(f.vpath, f.key)
  // the hard link shares 평가.csv's bytes and canary
  fs.linkSync(R('인사/평가.csv'), R('프로젝트/평가사본.csv'))
  canary.set('projHardlink', canary.get('hrHardlinked')!)
  // links
  fs.symlinkSync('../인사/c.csv', R('프로젝트/급여링크.csv'))
  fs.symlinkSync('../인사', R('프로젝트/hr'))
  fs.symlinkSync('../../인사', R('공용/회계/hr2'))
  fs.writeFileSync(R('프로젝트/참고.xlsx'), xsym('../인사/c.csv'))
  canary.set('symlinkFile', canary.get('hr')!)
  canary.set('symlinkDir', canary.get('hr')!)
  canary.set('symlinkDirDeep', canary.get('hr')!)
  canary.set('xsym', 'XSym\n')

  // rules (R0)
  setRule(e.db, R('프로젝트/비공개'), 'boss', 'read', { breakInherit: true })
  setRule(e.db, R('경영/공개'), '@전체', 'read')
  registerFolder(e.db, R('프로젝트/외주'), { nasReaders: ['park'] })
  setRule(e.db, R('프로젝트/외주'), '@영업', 'read')
  setRule(e.db, R('공용/회계'), 'kim', 'none')
  setRule(e.db, R('공용/회계2'), 'kim', 'none', { breakInherit: true })
  setRule(e.db, R('공용/회계2'), '@전체', 'read')
  setRule(e.db, R('공용/kim만'), 'kim', 'read', { breakInherit: true })
  setFlag(e.db, R('공용/잠금'), 'no_ai', true)
  setRule(e.db, R('공용/잠금/아래'), '@전체', 'read', { breakInherit: true })
  setFlag(e.db, R('공용/격리'), 'quarantine', true)
  setFlag(e.db, R('공용/대기'), 'widened_pending', true)
  registerFolder(e.db, R('대외비'), { nasReaders: 'all' })
  setRule(e.db, R('대외비'), '@전체', 'read')
  setFlag(e.db, R('대외비'), 'no_ai', true)

  // tokens
  e.addToken('dion', 'dion', { name: 'dion-admin' })
  e.addToken('lee', 'lee', { name: 'lee-laptop' })
  e.addToken('park', 'park', { name: 'park-laptop' })
  e.addToken('kimRO', 'kim', { name: 'kim-ro', readOnly: true })
  e.addToken('kimScoped', 'kim', { name: 'kim-acct', scope: [R('공용/회계')] })
  const expired = createToken(e.db, 'kim', { name: 'kim-expired', ttlMs: 1 })
  const revoked = createToken(e.db, 'kim', { name: 'kim-revoked' })
  revokeToken(e.db, revoked.id)

  /** Canaries of everything this role must never see. */
  const forbidden = (role: Role) => [...new Set(ALL_CASES.filter((c) => !c.readers.includes(role)).map((c) => canary.get(c.key)!))]
    .filter((c) => !ALL_CASES.some((x) => x.readers.includes(role) && canary.get(x.key) === c))
  const allowed = (role: Role) => ALL_CASES.filter((c) => c.readers.includes(role)).map((c) => canary.get(c.key)!)

  /** Every regular file under the sample root with its sha256 (to prove originals were never written). */
  const snapshot = () => {
    const out: Record<string, string> = {}
    const walk = (d: string) => {
      for (const n of fs.readdirSync(d)) {
        const p = path.join(d, n)
        const st = fs.lstatSync(p)
        if (st.isSymbolicLink()) out[p] = 'link:' + fs.readlinkSync(p)
        else if (st.isDirectory()) { out[p] = 'dir'; walk(p) }
        else out[p] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
      }
    }
    walk(e.root)
    return out
  }

  return { ...e, salt, canary, forbidden, allowed, snapshot, expiredSecret: expired.token, revokedSecret: revoked.token, R }
}
export type SecEnv = ReturnType<typeof securitySetup>
