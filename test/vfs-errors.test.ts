// Unexpected errors inside the VFS (a database error, a bug in policy or provenance code) in both shell modes:
//   - while deciding what a path is: fail closed, the same answer as a nonexistent path (no existence leak);
//   - after that: a fixed EIO, never the error's own text (it may hold real paths); the command goes on.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { onPolicyError } from '../src/policy'
import { Session } from '../src/session'
import { setRule } from '../src/store'
import { onInternalError } from '../src/vfs'
import { HIDDEN_PROBES, setup, SHELL_MODES, textOf, withShellMode, type Env } from './helpers'

let e: Env
const reported: string[] = []
beforeAll(() => {
  e = setup()
  // a sub-folder of 프로젝트 that only boss may read: hidden from kim inside a folder kim can list
  fs.mkdirSync(path.join(e.root, '프로젝트/비공개'))
  fs.writeFileSync(path.join(e.root, '프로젝트/비공개/계약.md'), '비공개 계약\n')
  setRule(e.db, path.join(e.root, '프로젝트/비공개'), 'boss', 'read', { breakInherit: true })
})
afterAll(() => {
  onPolicyError((real, err) => console.error(`[policy] closed after an error at ${real}:`, err))
  onInternalError((where, p, err) => console.error(`[vfs] ${where} '${p}':`, err))
  e.cleanup()
})
afterEach(() => { reported.length = 0 })
onPolicyError((real, err) => reported.push(`policy ${real}: ${(err as Error).message}`))
onInternalError((where, p, err) => reported.push(`vfs ${where} ${p}: ${(err as Error).message}`))

/** The policy code throws while looking at the hidden folder only (as a database error on that row would). */
const breakPolicyAtHidden = (s: Session) => {
  const closures = (s.access as unknown as { closures: { lostPaths: Map<string, string> } }).closures
  const real = closures.lostPaths
  closures.lostPaths = { get: (k: string) => { if (k.includes('비공개')) throw new Error(`db exploded at ${k}`); return real.get(k) } } as Map<string, string>
}

describe('an error while deciding about a hidden path', () => {
  for (const mode of SHELL_MODES) test(`answers exactly like a nonexistent path (${mode})`, () => withShellMode(mode, async () => {
    const pairs: [string, string][] = [['/프로젝트/비공개/계약.md', '/프로젝트/없음/계약.md'], ['/프로젝트/비공개', '/프로젝트/없음']]
    for (const [hidden, missing] of pairs) {
      for (const c of HIDDEN_PROBES) {
        const a = await e.sh('kim', c.replaceAll('P', hidden), undefined, breakPolicyAtHidden)
        const b = await e.sh('kim', c.replaceAll('P', missing), undefined, breakPolicyAtHidden)
        expect({ c, out: a.stdout.replaceAll(hidden, 'P'), err: a.stderr.replaceAll(hidden, 'P'), code: a.exitCode })
          .toEqual({ c, out: b.stdout.replaceAll(missing, 'P'), err: b.stderr.replaceAll(missing, 'P'), code: b.exitCode })
        expect(a.stderr + a.stdout).not.toContain('exploded')
      }
    }
    // the listing of the visible parent is unchanged, and the error did happen (and was reported)
    expect((await e.sh('kim', 'ls /프로젝트', undefined, breakPolicyAtHidden)).stdout).not.toContain('비공개')
    expect(reported.some((r) => r.includes('db exploded'))).toBe(true)
    // boss reads it when nothing breaks
    expect((await e.sh('boss', 'cat /프로젝트/비공개/계약.md')).stdout).toBe('비공개 계약\n')
  }))
})

describe('an unexpected error after a path was resolved', () => {
  const breakProvenance = (s: Session) => { s.touchFile = () => { throw new Error('provenance exploded at /srv/team/프로젝트/README.md') } }
  const cmds = ['cat /프로젝트/README.md; echo "exit=$?"', 'cp /프로젝트/README.md /drafts/r.md; echo "exit=$?"', 'grep -r 한빛 /프로젝트; echo "exit=$?"',
    'ls -l /프로젝트/README.md; echo "exit=$?"', 'echo still running']

  test('is a fixed I/O error, the same in both modes, and never shows its text', async () => {
    const out: Record<string, { stdout: string; stderr: string; exitCode: number }[]> = {}
    for (const mode of SHELL_MODES) {
      out[mode] = []
      await withShellMode(mode, async () => {
        for (const c of cmds) out[mode]!.push(await e.sh('kim', c, undefined, breakProvenance))
      })
    }
    expect(out.isolated).toEqual(out.inprocess!)
    for (const r of out.isolated!) expect(r.stderr + r.stdout).not.toMatch(/exploded|\/srv\//)
    const [cat, cp, grep, , echo] = out.isolated!
    expect(cat!.stdout).toBe('exit=1\n')
    expect(cp!.stdout).toBe('exit=1\n')
    expect(grep!.stderr).toBe('grep: input/output error\n')
    expect(grep!.stdout).toBe('exit=2\n')
    expect(echo!.stdout).toBe('still running\n')
    expect(reported.filter((r) => r.includes('provenance exploded')).length).toBeGreaterThan(0)
  })

  test('the read tool shows the same fixed I/O error', async () => {
    const orig = Session.prototype.touchFile
    Session.prototype.touchFile = () => { throw new Error('provenance exploded at /srv/team/프로젝트/README.md') }
    try {
      const r = await e.tool('kim', 'read', { path: '/프로젝트/README.md' })
      expect(r.isError).toBe(true)
      expect(textOf(r)).toBe("EIO: input/output error, open '/프로젝트/README.md'")
    } finally { Session.prototype.touchFile = orig }
  })
})
