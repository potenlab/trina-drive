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
