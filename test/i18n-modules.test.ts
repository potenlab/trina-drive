// The web app's text is split by feature (web/src/i18n/{core,share,sso,console}.ts, merged by index.ts): a key must
// live in exactly one file (a later file would silently replace an earlier one's text) and Korean must have every key.
import { describe, expect, test } from 'bun:test'
import * as consoleText from '../web/src/i18n/console'
import * as core from '../web/src/i18n/core'
import * as share from '../web/src/i18n/share'
import * as sso from '../web/src/i18n/sso'

const files = { core, share, sso, console: consoleText } as Record<string, { en: Record<string, string>; ko: Record<string, string> }>

describe('i18n modules', () => {
  test('no key is defined in two files', () => {
    const seen = new Map<string, string>()
    const dup: string[] = []
    for (const [file, d] of Object.entries(files)) for (const k of Object.keys(d.en)) { if (seen.has(k)) dup.push(`${k} (${seen.get(k)}, ${file})`); seen.set(k, file) }
    expect(dup).toEqual([])
  })

  test('Korean has exactly the English keys in every file', () => {
    for (const d of Object.values(files)) expect(Object.keys(d.ko).sort()).toEqual(Object.keys(d.en).sort())
  })
})
