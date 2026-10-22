// R1 ⑤ link-shaped entries that are not OS symlinks: XSym (Minshall-French) files written by macOS smbfs.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { setup, textOf, type Env } from '../helpers'
import { xsym } from './fixture'

let e: Env
beforeAll(() => { e = setup() })
afterAll(() => e.cleanup())

describe('XSym link files (R1 ⑤)', () => {
  test('an XSym file is closed for every entrance, like a nonexistent file', async () => {
    const p = path.join(e.root, '프로젝트/참고.xlsx')
    fs.writeFileSync(p, xsym('../인사/급여.csv'))
    try {
      expect((await e.sh('kim', 'ls -a /프로젝트')).stdout).not.toContain('참고')
      for (const c of ['cat P', 'cat /.rawP', 'wc -c P', 'grep -c . P', 'stat P']) {
        const a = await e.sh('kim', c.replace('P', '/프로젝트/참고.xlsx')), b = await e.sh('kim', c.replace('P', '/프로젝트/없음.xlsx'))
        expect({ c, out: a.stdout, err: a.stderr.replace('참고', 'X'), code: a.exitCode }).toEqual({ c, out: b.stdout, err: b.stderr.replace('없음', 'X'), code: b.exitCode })
      }
      expect((await e.sh('kim', 'grep -r XSym /; rg -l . /프로젝트')).stdout).not.toContain('참고')
      expect(textOf(await e.tool('kim', 'read', { path: '/프로젝트/참고.xlsx' }))).toBe('No such file or directory: /프로젝트/참고.xlsx')
    } finally { fs.unlinkSync(p) }
  })

  test('a file rewritten in place into an XSym file is closed', async () => {
    const p = path.join(e.root, '프로젝트/later.md')
    fs.writeFileSync(p, Buffer.alloc(1067, 'a'))
    try {
      expect((await e.sh('kim', 'wc -c /프로젝트/later.md')).stdout).toBe('1067 /프로젝트/later.md\n')
      // same inode, same size: rewritten in place between the listing and the read
      const r = await e.sh('kim', `cat /프로젝트/later.md > /dev/null && echo before; ls /프로젝트 > /dev/null`)
      expect(r.stdout).toBe('before\n')
      const fd = fs.openSync(p, 'r+')
      fs.writeSync(fd, xsym('../인사/급여.csv'), 0, 1067, 0)
      fs.closeSync(fd)
      expect((await e.sh('kim', 'cat /프로젝트/later.md')).exitCode).toBe(1)
    } finally { fs.unlinkSync(p) }
  })

  test('ordinary files of the same size, or that merely start with "XSym", stay readable', async () => {
    const a = path.join(e.root, '프로젝트/same-size.md'), b = path.join(e.root, '프로젝트/xsym-notes.md')
    fs.writeFileSync(a, Buffer.alloc(1067, 'b'))
    fs.writeFileSync(b, 'XSym\n0012\nnot a link, just notes\n')
    try {
      expect((await e.sh('kim', 'wc -c /프로젝트/same-size.md')).stdout).toBe('1067 /프로젝트/same-size.md\n')
      expect((await e.sh('kim', 'head -1 /프로젝트/xsym-notes.md')).stdout).toBe('XSym\n')
    } finally { fs.unlinkSync(a); fs.unlinkSync(b) }
  })
})
