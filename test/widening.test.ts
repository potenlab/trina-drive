// R5 readers and R6 widening (the function only; no NAS watcher yet).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { isWidening, readersSource, readersTarget } from '../src/policy'
import { person, registerFolder, setFlag, setRule } from '../src/store'
import { setup, type Env } from './helpers'

let e: Env
beforeAll(() => { e = setup() })
afterAll(() => e.cleanup())

const reg = (name: string, nas: 'all' | 'unknown' | string[], rule: string) => {
  const d = path.join(e.root, name)
  fs.mkdirSync(d, { recursive: true })
  const f = registerFolder(e.db, d, { nasReaders: nas })
  setRule(e.db, d, rule, 'read')
  return f.id
}

describe('widening', () => {
  test('경영 -> 프로젝트 widens (kim can read 프로젝트 but not 경영)', () => {
    expect(readersTarget(e.db, e.folderId('프로젝트')).has(person(e.db, 'kim').id)).toBe(true)
    expect(readersSource(e.db, e.folderId('경영')).has(person(e.db, 'kim').id)).toBe(false)
    expect(isWidening(e.db, [e.folderId('경영')], e.folderId('프로젝트'))).toBe(true)
  })

  test('프로젝트 -> 프로젝트 does not (S == F is skipped); 프로젝트 -> 경영 narrows', () => {
    expect(isWidening(e.db, [e.folderId('프로젝트')], e.folderId('프로젝트'))).toBe(false)
    expect(isWidening(e.db, [e.folderId('프로젝트')], e.folderId('경영'))).toBe(false)
  })

  test('same grade, different readers: 인사 -> 영업 widens', () => {
    expect(isWidening(e.db, [e.folderId('인사')], e.folderId('영업'))).toBe(true)
  })

  test('unknown NAS readers: everyone as a target, nobody (beyond the AI rule) as a source', () => {
    const openA = reg('알수없음A', 'unknown', '@전체')
    const openB = reg('알수없음B', 'unknown', '@전체')
    const closed = reg('알수없음C', 'unknown', '@경영')
    expect(readersTarget(e.db, openB).size).toBe(5)
    expect(readersSource(e.db, closed)).toEqual(new Set([person(e.db, 'boss').id]))
    expect(isWidening(e.db, [openA], openB)).toBe(false) // everyone already reads the source by rule
    expect(isWidening(e.db, [closed], openB)).toBe(true)
    // into a folder whose NAS readers are unknown, even a source with known NAS readers widens if they are fewer
    expect(isWidening(e.db, [e.folderId('경영')], closed)).toBe(true)
    // a known small target is fine
    expect(isWidening(e.db, [closed], e.folderId('경영'))).toBe(false)
  })

  test('a no-AI source has no AI readers; a missing folder is everyone as target, nobody as source', () => {
    setFlag(e.db, path.join(e.root, '공용'), 'no_ai', true)
    expect(isWidening(e.db, [e.folderId('공용')], e.folderId('프로젝트'))).toBe(false) // NAS readers of 공용 = all
    setFlag(e.db, path.join(e.root, '공용'), 'no_ai', false)
    expect(isWidening(e.db, [999999], e.folderId('경영'))).toBe(true)
    expect(readersTarget(e.db, 999999).size).toBe(5)
  })

  test('multiple sources: widening if any source is narrower than the target', () => {
    expect(isWidening(e.db, [e.folderId('프로젝트'), e.folderId('경영')], e.folderId('프로젝트'))).toBe(true)
  })
})
