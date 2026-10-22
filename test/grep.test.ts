// grep/rg semantics on ripgrep, option allowlist, ReDoS-ish patterns.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { _test } from '../src/grep'
import { setup, type Env } from './helpers'

let e: Env
beforeAll(() => { e = setup() })
afterAll(() => e.cleanup())

describe('grep', () => {
  test('common flags', async () => {
    expect((await e.sh('kim', 'grep -rn 납기 /프로젝트')).stdout).toBe('/프로젝트/견적_2026.md:5:- 납기: 2026-12-15\n/프로젝트/사양서.docx:3:2. 납기: 2026-12-15\n')
    expect((await e.sh('kim', 'grep -rl 한빛물산 /')).stdout).toBe('/프로젝트/견적_2026.md\n/프로젝트/사양서.docx\n')
    expect((await e.sh('kim', 'grep -c - /프로젝트/견적_2026.md')).stdout).toBe('4\n')
    expect((await e.sh('kim', 'grep -i projects /프로젝트/README.md')).stdout).toBe('# Projects\n')
    expect((await e.sh('kim', 'grep -E "고객|담당" /프로젝트/견적_2026.md')).stdout).toBe('- 고객: 한빛물산\n- 담당: kim\n')
    expect((await e.sh('kim', 'grep "고객\\|담당" /프로젝트/견적_2026.md')).stdout).toBe('- 고객: 한빛물산\n- 담당: kim\n')
    expect((await e.sh('kim', 'grep -F "(a|b)" /프로젝트/README.md')).exitCode).toBe(1)
    expect((await e.sh('kim', 'grep -q 한빛 /프로젝트/견적_2026.md; echo $?')).stdout).toBe('0\n')
    expect((await e.sh('kim', 'grep -q 없음 /프로젝트/견적_2026.md; echo $?')).stdout).toBe('1\n')
    expect((await e.sh('kim', 'grep -o "[0-9]*,000,000원" /프로젝트/견적_2026.md')).stdout).toBe('48,000,000원\n')
    expect((await e.sh('kim', 'grep -v "^-" /프로젝트/견적_2026.md | grep -c .')).stdout).toBe('1\n')
    expect((await e.sh('kim', 'grep -A1 고객 /프로젝트/견적_2026.md')).stdout).toBe('- 고객: 한빛물산\n- 금액: 48,000,000원\n')
    expect((await e.sh('kim', 'grep -r --include="*.md" 한빛 /')).stdout).toBe('/프로젝트/견적_2026.md:- 고객: 한빛물산\n')
    expect((await e.sh('kim', 'cd /프로젝트 && grep -rl 납기 .')).stdout).toBe('견적_2026.md\n사양서.docx\n')
    expect((await e.sh('kim', 'cat /프로젝트/견적_2026.md | grep 납기')).stdout).toBe('- 납기: 2026-12-15\n')
    expect((await e.sh('kim', 'grep 납기 /프로젝트')).stderr).toBe('grep: /프로젝트: Is a directory\n')
  })

  test('rg', async () => {
    expect((await e.sh('kim', 'rg -n 납기 /프로젝트')).stdout).toBe('/프로젝트/견적_2026.md:5:- 납기: 2026-12-15\n/프로젝트/사양서.docx:3:2. 납기: 2026-12-15\n')
    expect((await e.sh('kim', 'rg -l 착수 /; rg -c 단계 /프로젝트')).stdout).toBe('/프로젝트/일정.hwpx:2\n')
    expect((await e.sh('kim', 'rg --files /프로젝트')).stdout.split('\n').filter(Boolean).length).toBe(5)
    expect((await e.sh('kim', 'rg -g "*.hwp" 회의 /')).stdout).toBe('/프로젝트/회의록.hwp:킥오프 회의록\n')
  })

  test('unsupported options are refused with a message (no slow fallback)', async () => {
    for (const c of ['grep -P x /', 'grep -f /프로젝트/README.md /', 'grep -z x /', 'rg --pre cat x /', 'rg -L x /', 'rg --follow x /', 'rg -z x /', 'rg --ignore-file /x x /', 'rg -P x /']) {
      const r = await e.sh('kim', c)
      expect({ c, code: r.exitCode, unsupported: r.stderr.includes('unsupported option') }).toEqual({ c, code: 2, unsupported: true })
    }
  })

  test('ReDoS-shaped patterns finish quickly (linear-time engine)', async () => {
    await e.tool('kim', 'write', { path: '/drafts/aaaa.txt', content: 'a'.repeat(200_000) + '!\n' })
    const t0 = performance.now()
    const r = await e.sh('kim', `grep -E '(a|aa)*$' /drafts/aaaa.txt | wc -c; rg '(a*)*b' /drafts/aaaa.txt; grep -E '(x+x+)+y' /drafts/aaaa.txt; echo done`)
    expect(r.stdout).toContain('done')
    expect(performance.now() - t0).toBeLessThan(3000)
  })

  test('BRE to ERE', () => {
    expect(_test.breToEre('a\\|b')).toBe('a|b')
    expect(_test.breToEre('x(1)+')).toBe('x\\(1\\)\\+')
    expect(_test.breToEre('a\\{2\\}')).toBe('a{2}')
    expect(_test.breToEre('\\<word\\>')).toBe('\\bword\\b')
  })
})
