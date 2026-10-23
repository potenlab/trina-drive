// The setup link (web/src/setup-link.ts): the token rides in the URL fragment, which no server log or Referer sees;
// the app pre-fills it and removes it from the address bar without leaving a history entry.
import { expect, test } from 'bun:test'
import { setupTokenFromHash, takeSetupToken } from '../web/src/setup-link'

const TOKEN = 'tdrive_setup_AbCdEfGhIjKlMnOpQrStUvWx-_09'

test('#token=… and the older #/setup/… both carry it', () => {
  expect(setupTokenFromHash(`#token=${TOKEN}`)).toBe(TOKEN)
  expect(setupTokenFromHash(`#/setup/${TOKEN}`)).toBe(TOKEN)
  expect(setupTokenFromHash(`#token=${encodeURIComponent(TOKEN)}&x=1`)).toBe(TOKEN)
})

test.each(['', '#/setup', '#/setup/folders', '#/folders', '#token=', '#token=short', '#token=%E0%A4%A', `#/invite/${TOKEN}`, `#token=${'a'.repeat(201)}`])('%p is not a setup token', (h) => {
  expect(setupTokenFromHash(h)).toBe('')
})

test('taken out of the address bar (replaceState: no history entry keeps it)', () => {
  const calls: string[] = []
  const history = { replaceState: (_d: unknown, _t: string, url: string) => { calls.push(url) } }
  expect(takeSetupToken({ hash: `#token=${TOKEN}`, pathname: '/', search: '' }, history)).toBe(TOKEN)
  expect(calls).toEqual(['/#/setup'])
  expect(takeSetupToken({ hash: '#/setup/folders', pathname: '/', search: '' }, history)).toBe('')
  expect(calls).toHaveLength(1)
})
