// MCP tool edge cases found by the fuzzer: every bad argument is a tool error, never an internal error.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { textOf } from '../helpers'
import { securitySetup, type SecEnv } from './fixture'

let e: SecEnv
beforeAll(() => { e = securitySetup() })
afterAll(() => e.cleanup())

describe('read on just-bash pseudo folders', () => {
  test.each([['/bin'], ['/proc/self'], ['/dev'], ['/proc/nope'], ['/dev/nul?'], ['/usr/bin'], ['/bin/../proc/self/x']])('read %s is a tool error', async (p) => {
    const r = await e.tool('kim', 'read', { path: p })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toMatch(/^(No such file or directory|Is a directory): /)
  })
  test('read /proc/version still works (it is just-bash\'s fake text)', async () => {
    expect(textOf(await e.tool('kim', 'read', { path: '/proc/version' }))).toContain('just-bash')
  })
})

describe('shell on just-bash pseudo folders', () => {
  test.each([['[ -d "/dev/null." ] && echo d; echo $?'], ['test -f /dev/nul{d,v}; echo $?'], ['stat /proc/nope'], ['ls /bin/nope'], ['ls -la /dev/../proc/x'], ['cat /proc/self/nope'],
    ['find /proc/none'], ['du /dev/x']])('%s runs like bash (no exception)', async (c) => {
    const r = await e.sh('kim', c)
    expect(typeof r.exitCode).toBe('number')
  })
})

describe('command set (plan 5.1: no real processes, network, ln, python, sqlite3, curl)', () => {
  test.each([['sqlite3 :memory: "select 1"'], ['python3 -c 1'], ['python -c 1'], ['node -e 1'], ['js-exec 1'], ['curl http://127.0.0.1/'], ['wget http://127.0.0.1/']])('%s is not available', async (c) => {
    const r = await e.sh('kim', c)
    expect(r.exitCode).toBe(127)
    expect(r.stdout).toBe('')
  })
  test('ln is refused', async () => {
    expect((await e.sh('kim', 'ln -s /공용/c.md /drafts/l; ln /공용/c.md /drafts/h')).stderr).toContain('Links are not supported')
  })
  test('sqlite3 is not listed in /bin', async () => {
    expect((await e.sh('kim', 'ls /bin')).stdout.split('\n')).not.toContain('sqlite3')
  })
})
