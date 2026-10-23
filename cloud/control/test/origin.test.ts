import { describe, expect, test } from 'bun:test'
import { originRefused, sameOrigin } from '../src/routes/console-http'

const ORIGIN = 'https://cloud.trina.app'
const req = (h: Record<string, string>, method = 'POST') => new Request(`${ORIGIN}/api/login`, { method, headers: h })

describe('console Origin check (review #10)', () => {
  test('own origin passes, another origin is refused', () => {
    expect(sameOrigin(req({ origin: ORIGIN }), ORIGIN)).toBe(true)
    expect(sameOrigin(req({ origin: 'https://evil.example' }), ORIGIN)).toBe(false)
  })
  test('Origin: null (Chromium form post) passes only with Sec-Fetch-Site: same-origin', () => {
    expect(sameOrigin(req({ origin: 'null', 'sec-fetch-site': 'same-origin' }), ORIGIN)).toBe(true)
    expect(sameOrigin(req({ origin: 'null', 'sec-fetch-site': 'cross-site' }), ORIGIN)).toBe(false)
    // a sandboxed frame on an older browser: null origin and no Fetch Metadata
    expect(sameOrigin(req({ origin: 'null' }), ORIGIN)).toBe(false)
  })
  test('no browser headers (curl) still passes; GET is never refused', () => {
    expect(sameOrigin(req({}), ORIGIN)).toBe(true)
    expect(originRefused(req({ origin: 'https://evil.example' }, 'GET'), '/', ORIGIN)).toBe(false)
  })
})
