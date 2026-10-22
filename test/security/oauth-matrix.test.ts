// The permission matrix (fixture.ts, plan §4.1) once more, entering through /mcp with OAuth access tokens instead of
// personal access tokens (plan 10 "v0.2 보안 관문: OAuth·터널까지 넓힌 권한 시험 행렬"). Each role gets an OAuth grant
// with the same person, folder scope and read-only as its PAT; the expected readers are the fixture's hand-written ones.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { handleRequest } from '../../src/mcp'
import { makeOAuthRuntime, mcpOAuth, type OAuthRuntime } from '../../src/oauth'
import type { Client } from '../../src/oauth/clients'
import { exchangeCode, issueCode } from '../../src/oauth/tokens'
import { pkce } from '../oauth-helpers'
import { ALL_CASES, ROLES, securitySetup, type Role, type SecEnv } from './fixture'

let e: SecEnv
let rt: OAuthRuntime
const access = new Map<Role, string>()
const CLIENT: Client = { client_id: 'https://claude.ai/oauth/test-client', kind: 'cimd', name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], domain: 'claude.ai', verified: true }

beforeAll(() => {
  e = securitySetup()
  rt = makeOAuthRuntime({ issuer: 'https://files.example.test' }, e.db)
  for (const role of ROLES) {
    const pat = e.tok(role)
    const p = pkce()
    const code = issueCode(rt, e.db, {
      client: CLIENT, redirectUri: CLIENT.redirect_uris[0]!, codeChallenge: p.challenge, resource: rt.resource, personId: pat.person_id,
      scopeFolders: pat.scope ? JSON.parse(pat.scope) as number[] : null, readOnly: !!pat.read_only, grantedScope: 'files:read', grantTtlMs: 86400_000,
    })
    access.set(role, exchangeCode(rt, e.db, { code, clientId: CLIENT.client_id, redirectUri: CLIENT.redirect_uris[0], verifier: p.verifier, resource: rt.resource }).access_token)
  }
})
afterAll(() => e.cleanup())

async function bash(role: Role, command: string): Promise<string> {
  const res = await handleRequest(e.ctx, new Request('http://x/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${access.get(role)}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bash', arguments: { command } } }),
  }), { oauth: mcpOAuth(rt, e.db) }, '10.0.0.1')
  expect(res.status).toBe(200)
  const data = await res.json() as { result: { content: { text: string }[] } }
  return data.result.content.map((c) => c.text).join('\n')
}
const q = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`

describe.each(ROLES.map((r) => [r]))('OAuth grant of %s', (role) => {
  test('reads exactly the fixture\'s readers (cat of every case, and grep -r of every canary)', async () => {
    const script = ALL_CASES.map((c) => `echo "@@${c.key}"; cat ${q(c.vpath)} 2>/dev/null`).join('; ')
    const out = await bash(role, script)
    const parts = new Map(out.split('@@').slice(1).map((s) => { const i = s.indexOf('\n'); return [s.slice(0, i < 0 ? undefined : i), i < 0 ? '' : s.slice(i + 1)] as const }))
    for (const c of ALL_CASES) {
      const canary = e.canary.get(c.key)!
      expect({ role, case: c.key, read: (parts.get(c.key) ?? '').includes(canary) }).toEqual({ role, case: c.key, read: c.readers.includes(role) })
    }
    const forbidden = e.forbidden(role)
    if (forbidden.length) {
      // every canary line this role can grep for, across the whole tree: none of the forbidden ones may show up
      const g = await bash(role, 'grep -r -h CANARY_ /; grep -r -h XSym /; rg -h CANARY_ /')
      for (const c of forbidden) expect({ role, leaked: g.includes(c) ? c : null }).toEqual({ role, leaked: null })
    }
  })
})

test('hidden == missing through an OAuth grant (kim: /경영/c.md answers like a name that does not exist)', async () => {
  const a = await bash('kim', `cat /경영/c.md`)
  const b = await bash('kim', `cat /경영/nx_c.md`)
  const c = await bash('kim', `cat /없음/c.md`)
  expect(a.replace('/경영/c.md', 'P')).toBe(c.replace('/없음/c.md', 'P'))
  expect(b.replace('/경영/nx_c.md', 'P')).toBe(c.replace('/없음/c.md', 'P'))
})

test('read-only grants cannot write drafts; full ones can', async () => {
  expect(await bash('kimRO', 'echo x > /drafts/a.md')).toMatch(/read-only[\s\S]*exit code 1/i)
  expect(await bash('kim', 'echo x > /drafts/a.md; cat /drafts/a.md')).toContain('x')
})
