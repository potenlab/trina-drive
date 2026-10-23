// The control plane's seams (W0): modules register routes (src/routes/index.ts), CLI commands (src/cli/index.ts) and
// database migrations (src/migrations/index.ts) without editing web.ts, main.ts or db.ts.
import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { CONTROL_COMMANDS, findCommand, registeredHelp } from '../src/cli'
import { addColumns, CONTROL_MIGRATIONS, runControlMigrations } from '../src/migrations'
import { CONTROL_ROUTES, findRoute } from '../src/routes'
import type { ControlRoute } from '../src/routes/types'
import { openDb } from '../src/db'
import { setup, type Env } from './helpers'

let env: Env | null = null
const added: ControlRoute[] = []
afterEach(() => {
  for (const r of added.splice(0)) CONTROL_ROUTES.splice(CONTROL_ROUTES.indexOf(r), 1)
  env?.cleanup(); env = null
})
const register = (r: ControlRoute) => { CONTROL_ROUTES.unshift(r); added.push(r) }

describe('control route registry', () => {
  test('findRoute: exact paths, anchored RegExps, GET answers HEAD, * any method', () => {
    const list: ControlRoute[] = [
      { method: 'GET', path: '/t/x', fn: () => new Response('a') },
      { method: 'POST', path: /^\/t\/([a-z]+)\/members$/, fn: () => new Response('b') },
      { method: '*', path: '/any', fn: () => new Response('c') },
    ]
    expect(findRoute('HEAD', '/t/x', list)?.route).toBe(list[0]!)
    expect(findRoute('POST', '/t/acme/members', list)?.match[1]).toBe('acme')
    expect(findRoute('GET', '/t/acme/members', list)).toBeNull()
    expect(findRoute('DELETE', '/any', list)?.route).toBe(list[2]!)
  })

  test('a registered route is asked before the built-in pages, with the session and helpers', async () => {
    env = setup()
    register({ method: 'GET', path: '/dashboard', fn: (c) => c.json({ mine: true, signed_in: !!c.session }) })
    const r = await env.call('GET', '/dashboard')
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ mine: true, signed_in: false })
    // and the security headers are still added
    expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
  })

  test('changing methods must come from the console\'s own pages unless the route opts out', async () => {
    env = setup()
    register({ method: 'DELETE', path: '/api/x', fn: (c) => c.json({ ok: true }) })
    register({ method: 'POST', path: '/api/team-callback/x', crossOrigin: true, fn: (c) => c.json({ ok: true }) })
    expect((await env.call('DELETE', '/api/x', { headers: { origin: 'https://evil.example' } })).status).toBe(403)
    expect((await env.call('DELETE', '/api/x', { headers: { origin: 'https://cloud.example.com' } })).status).toBe(200)
    expect((await env.call('POST', '/api/team-callback/x', { headers: { origin: 'https://acme.cloud.example.com' } })).status).toBe(200)
  })

  test('the console registers its pages (D1); web.ts keeps the ones nobody took over', async () => {
    env = setup()
    expect(CONTROL_ROUTES.length).toBeGreaterThan(0)
    // the console's Teams page: signed out → its sign-in page
    const r = await env.call('GET', '/')
    expect(r.status).toBe(303)
    expect(r.headers.get('location')).toBe('/login')
    expect(await (await env.call('GET', '/login')).text()).toContain('Trina Cloud')
    // web.ts's own Free page still answers
    expect((await env.call('GET', '/free')).status).toBe(200)
  })
})

describe('control CLI registry', () => {
  const builtins = [...fs.readFileSync(path.join(import.meta.dir, '..', 'src', 'main.ts'), 'utf8').matchAll(/case '([^']+)'/g)].map((m) => m[1]!)
  test('names are unique; a registered name takes over a built-in only on purpose (replaces: true)', () => {
    const names = CONTROL_COMMANDS.map((c) => c.name)
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([])
    expect(CONTROL_COMMANDS.filter((c) => builtins.includes(c.name) && !c.replaces).map((c) => c.name)).toEqual([])
  })
  test('two words before one; help lists them', () => {
    const list = [{ name: 'teams', help: '  teams', run: () => 0 }, { name: 'teams restore', help: '  teams restore <slug>', run: () => 0 }]
    expect(findCommand('teams', 'restore', list)).toBe(list[1]!)
    expect(findCommand('teams', 'list', list)).toBe(list[0]!)
    expect(findCommand('hosts', 'list', list)).toBeNull()
    expect(registeredHelp([])).toBe('')
    expect(registeredHelp(list)).toContain('teams restore <slug>')
  })
})

describe('control migrations registry', () => {
  test('ids are unique; addColumns is idempotent; openDb runs the registry', () => {
    const ids = CONTROL_MIGRATIONS.map((m) => m.id)
    expect(ids.filter((x, i) => ids.indexOf(x) !== i)).toEqual([])
    const db = openDb(':memory:')
    const list = [{ id: 'x', up: (d: typeof db) => addColumns(d, 'teams', [['sync_seq_test', 'INTEGER NOT NULL DEFAULT 0']]) }]
    runControlMigrations(db, list)
    runControlMigrations(db, list)
    expect(db.query<{ name: string }, []>('PRAGMA table_info(teams)').all().filter((c) => c.name === 'sync_seq_test').length).toBe(1)
  })
})
