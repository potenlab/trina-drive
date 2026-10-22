// The product's names live in src/brand.ts; package.json and the macOS installer must agree with it.
import { expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import pkg from '../package.json'
import { CLI, ENV_PREFIX, LAUNCHD_LABEL, NAME, PRODUCT, SECRET_TAG, TOKEN_PREFIX } from '../src/brand'
import { SESSION_COOKIE, SETUP_PREFIX } from '../src/web/auth'
import { ACCESS_PREFIX, CODE_PREFIX, REFRESH_PREFIX } from '../src/oauth/tokens'

test('package.json: name and the one command come from src/brand.ts', () => {
  expect(pkg.name).toBe(NAME)
  expect(Object.keys(pkg.bin)).toEqual([CLI])
})

test('scripts/macos/common.sh: NAME, CLI and LABEL equal src/brand.ts (scripts/build.ts refuses otherwise)', () => {
  const sh = fs.readFileSync(path.join(import.meta.dir, '..', 'scripts', 'macos', 'common.sh'), 'utf8')
  const v = (k: string) => new RegExp(`^${k}=(\\S*)`, 'm').exec(sh)?.[1]
  expect([v('NAME'), v('CLI'), v('LABEL')]).toEqual([NAME, CLI, LAUNCHD_LABEL])
  expect([v('SRV_USER'), v('WRK_USER')]).toEqual([`_${CLI}`, `_${CLI}work`])
})

test('names: Trina Drive, trina-drive, tdrive, TDRIVE_*, tdrive_*_ secrets', () => {
  expect([PRODUCT, NAME, CLI, ENV_PREFIX]).toEqual(['Trina Drive', 'trina-drive', 'tdrive', 'TDRIVE'])
  expect(TOKEN_PREFIX).toBe('tdrive_pat_')
  expect(SETUP_PREFIX).toBe('tdrive_setup_')
  expect([CODE_PREFIX, ACCESS_PREFIX, REFRESH_PREFIX, SESSION_COOKIE]).toEqual(['tdrive_oac_', 'tdrive_oat_', 'tdrive_ort_', 'tdrive_session'])
  // secret scanners match on a fixed, distinctive tag: lowercase letters and digits only
  expect(SECRET_TAG).toMatch(/^[a-z][a-z0-9]{3,}$/)
})
