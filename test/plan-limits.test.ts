// Trina Cloud plan settings the product enforces itself: TDRIVE_MAX_PEOPLE (Free: 3 active people) on the web, the
// CLI and reactivation; and `tdrive activity`, the last-use signal the control plane reads to pause idle Free teams.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { lastActivity } from '../src/activity'
import { addPerson, maxPeople, PeopleLimitError, verifyToken } from '../src/store'
import { webSetup, type WebEnv } from './web-helpers'

let e: WebEnv
const KEY = 'TDRIVE_MAX_PEOPLE'
beforeEach(async () => { e = await webSetup() })
afterEach(() => { delete process.env[KEY]; e.cleanup() })

describe('TDRIVE_MAX_PEOPLE', () => {
  test('unset, empty or 0 means no limit', () => {
    expect(maxPeople({})).toBeNull()
    expect(maxPeople({ [KEY]: '' })).toBeNull()
    expect(maxPeople({ [KEY]: '0' })).toBeNull()
    expect(maxPeople({ [KEY]: 'x' })).toBeNull()
    expect(maxPeople({ [KEY]: '3' })).toBe(3)
    addPerson(e.db, 'no-limit-here')
  })

  test('the web refuses a person past the limit with a clear message; deactivated people do not count; reactivation counts', async () => {
    // the demo team has 5 active people
    process.env[KEY] = '5'
    const admin = await e.as('dion')
    const view = await admin.call('GET', '/api/people')
    expect(view.data.max_people).toBe(5)
    const r = await admin.call('POST', '/api/people', { name: 'sixth', email: 'sixth@example.com' })
    expect(r.status).toBe(403)
    expect(r.data.error).toBe('people_limit')
    expect(r.data.max_people).toBe(5)
    expect(r.data.message).toContain('at most 5 people')
    expect(e.db.query("SELECT 1 FROM people WHERE name = 'sixth'").get()).toBeNull()
    expect(e.db.query("SELECT 1 FROM accounts WHERE email = 'sixth@example.com'").get()).toBeNull()
    // room after deactivating someone
    expect((await admin.call('PATCH', `/api/people/${e.pid('park')}`, { active: false })).status).toBe(200)
    expect((await admin.call('POST', '/api/people', { name: 'sixth', email: 'sixth@example.com' })).status).toBe(200)
    // turning park back on would make 6
    const back = await admin.call('PATCH', `/api/people/${e.pid('park')}`, { active: true })
    expect(back.status).toBe(403)
    expect(back.data.error).toBe('people_limit')
    expect(e.db.query<{ active: number }, [number]>('SELECT active FROM people WHERE id = ?').get(e.pid('park'))!.active).toBe(0)
  })

  test('the CLI path (store) refuses too', () => {
    process.env[KEY] = '5'
    expect(() => addPerson(e.db, 'seventh')).toThrow(PeopleLimitError)
    process.env[KEY] = '6'
    expect(addPerson(e.db, 'seventh').name).toBe('seventh')
  })
})

describe('activity', () => {
  test('newest of web sessions, token use and app passwords; reading it writes nothing', async () => {
    const before = lastActivity(e.db)
    // the demo seeds tokens but nobody has used anything on the web yet
    expect(before.web).toBeNull()
    const t0 = Date.now()
    await e.as('kim')
    const a = lastActivity(e.db)
    expect(a.web).toBeGreaterThanOrEqual(t0)
    expect(a.last_activity_at).toBe(Math.max(a.web!, a.mcp ?? 0, a.dav ?? 0))
    e.db.query('UPDATE web_sessions SET last_seen_at = 1000').run()
    e.db.query('UPDATE tokens SET last_used_at = NULL').run()
    expect(lastActivity(e.db).last_activity_at).toBe(1000)
    // an MCP call verifies its token: that is activity
    verifyToken(e.db, e.secrets.kim!)
    expect(lastActivity(e.db).mcp).toBeGreaterThanOrEqual(t0)
    expect(lastActivity(e.db).last_activity_at).toBe(lastActivity(e.db).mcp)
  })
})
