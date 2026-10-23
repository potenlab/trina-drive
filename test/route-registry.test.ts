// The /api route table is assembled from modules (src/web/routes.ts, auth-routes.ts, api.ts's core routes): two
// routes with the same method and path pattern would make one of them unreachable.
import { describe, expect, test } from 'bun:test'
import { routes } from '../src/web/api'
import { authRoutes } from '../src/web/auth-routes'
import { MODULE_ROUTES } from '../src/web/routes'
import { R } from '../src/web/route'

describe('route registry', () => {
  test('no two routes share a method and a path pattern', () => {
    const keys = routes.map((r) => `${r.method} ${r.re.source}`)
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([])
  })

  test('sign-in routes come first, module routes last', () => {
    expect(routes.slice(0, authRoutes.length)).toEqual(authRoutes)
    expect(routes.slice(routes.length - MODULE_ROUTES.length)).toEqual(MODULE_ROUTES)
    expect(authRoutes.some((r) => r.method === 'POST' && r.re.test('/api/login'))).toBe(true)
  })

  test('only the SSO callback skips the Origin check (the console form_posts to it); R() keeps the old raw flag', () => {
    const open = routes.filter((r) => r.crossOrigin)
    expect(open.map((r) => [r.method, r.re.test('/api/sso/callback')])).toEqual([['POST', true]])
    expect(R('POST', '/x', true, () => 1, true).raw).toBe(true)
    const cb = R('POST', '/sso/callback', false, () => 1, { raw: true, crossOrigin: true })
    expect([cb.raw, cb.crossOrigin, cb.re.test('/api/sso/callback')]).toEqual([true, true, true])
  })
})
