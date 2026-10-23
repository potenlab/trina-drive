// Workstream G1 scripts and config: the AWS smoke check's parsing helpers (cloud/scripts/aws-smoke.ts), Resend's
// current record style in cloud/scripts/resend-domain.ts, and the Caddy / Terraform text the rollout depends on.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { anchors, metric, parseArgs, postForm, redact, shq } from '../../scripts/aws-smoke'
import { bounceHostOk, checkDns, spfOk } from '../../scripts/resend-domain'

const CLOUD = path.resolve(import.meta.dir, '../..')
const read = (p: string) => fs.readFileSync(path.join(CLOUD, p), 'utf8')

describe('aws-smoke helpers', () => {
  test('options: AWS by default, --local for the dev stack; secrets are not options', () => {
    expect(parseArgs([])).toMatchObject({ base: 'https://cloud.trina.app', team: 'trina', local: false, website: 'https://drive.trina.app', profile: 'tdcloud' })
    expect(parseArgs(['--local'])).toMatchObject({ base: 'https://cloud.localhost:8443', team: 'acme', local: true, website: null })
    expect(parseArgs(['--skip', '9,mail', '--only', '2']).skip).toEqual(new Set(['9', 'mail']))
    expect(() => parseArgs(['--password', 'x'])).toThrow(/unknown arguments/)
    expect(() => parseArgs(['--base', 'http://x'])).toThrow(/https/)
  })
  test('links, form_post hand-over, metrics, quoting, redaction', () => {
    const html = '<nav><a class="x" href="https://cloud.trina.app/login">Sign in</a> <a href="https://cloud.trina.app/free"><span>Start</span> free</a></nav>'
    expect(anchors(html)).toEqual([{ href: 'https://cloud.trina.app/login', text: 'Sign in' }, { href: 'https://cloud.trina.app/free', text: 'Start free' }])
    const f = postForm('<body><form method="post" action="https://trina.cloud.trina.app/api/sso/callback"><input type="hidden" name="assertion" value="a.b&amp;c"><input type="hidden" name="state" value="s1"></form><script>document.forms[0].submit()</script>', 'https://cloud.trina.app/sso/authorize')
    expect(f).toEqual({ action: 'https://trina.cloud.trina.app/api/sso/callback', fields: { assertion: 'a.b&c', state: 's1' } })
    const m = '# HELP x\ntdcloud_last_backup_age_seconds{team="trina"} 120\ntdcloud_teams_waiting_for_host 0\n'
    expect(metric(m, 'tdcloud_last_backup_age_seconds', '{team="trina"}')).toBe(120)
    expect(metric(m, 'tdcloud_teams_waiting_for_host')).toBe(0)
    expect(metric(m, 'tdcloud_nothing')).toBeNull()
    expect(shq("it's")).toBe(`'it'\\''s'`)
    expect(redact('plain')).toBe('plain')
  })
})

describe('resend-domain: the records Resend shows today', () => {
  test('Resend MTA style (forge.rmta.net, ip4 SPF) and the earlier SES style both pass', async () => {
    expect(bounceHostOk('feedback.forge.rmta.net.', 'ap-northeast-1')).toBe(true)
    expect(bounceHostOk('feedback-smtp.ap-northeast-1.amazonses.com', 'ap-northeast-1')).toBe(true)
    expect(bounceHostOk('mx.example.com', 'ap-northeast-1')).toBe(false)
    expect(spfOk('v=spf1 ip4:52.3.252.119 ip4:44.222.39.36 ip4:199.249.231.0/24 ~all')).toBe(true)
    expect(spfOk('v=spf1 include:amazonses.com ~all')).toBe(true)
    expect(spfOk('v=spf1 -all')).toBe(false)
    const c = await checkDns({ domain: 'drive.trina.app', region: 'ap-northeast-1' }, {
      resolveTxt: async (n) => n.startsWith('resend._domainkey.') ? [[`p=${'A'.repeat(200)}`]] : n.startsWith('send.') ? [['v=spf1 ip4:52.3.252.119 ip4:44.222.39.36 ip4:199.249.231.0/24 ~all']] : [],
      resolveMx: async (n) => n.startsWith('send.') ? [{ exchange: 'feedback.forge.rmta.net', priority: 10 }] : [],
    })
    expect(c.slice(0, 3).map((x) => x.ok)).toEqual([true, true, true])
  })
})

describe('the rollout config', () => {
  test('Caddy: /dav/* has its own body cap and timeout, SSO its own zone (120/min), office zones exist', () => {
    const t = read('caddy/team_routes.caddy')
    expect(t).toMatch(/request_body @dav \{\s+max_size \{\$TDCLOUD_DAV_MAX_BODY:4GiB\}/)
    expect(t).toMatch(/request_body @notdav \{\s+max_size 25MB/)
    expect(t).toContain('/api/sso/*')
    for (const z of ['signin_office', 'mcp_office', 'all_office']) expect(t).toContain(`zone ${z} {`)
    // SSO hops (2–3 per Open drive, no password) have their own zone, not the 30/min password sign-in one
    expect(/zone signin \{[^}]*\/api\/sso/.test(t)).toBe(false)
    expect(t).toMatch(/zone sso \{\s*match \{\s*path \/api\/sso\/\*/)
    expect(t).toMatch(/reverse_proxy @dav [\s\S]*?response_header_timeout 10m/)
    expect(read('host/bootstrap.sh')).toContain('TDCLOUD_TRUSTED_OFFICE_CIDRS=${OFFICE_CIDRS:-192.0.2.0/32}')
  })
  test('Terraform: rollback-* never expires, v1 env values', () => {
    const ecr = read('infra/terraform/ecr.tf')
    expect(ecr).toMatch(/tagPrefixList = \["rollback-"\], countType = "imageCountMoreThan", countNumber = 9999/)
    expect(ecr).toMatch(/rulePriority = 1[\s\S]*rollback-[\s\S]*rulePriority = 2[\s\S]*rulePriority = 3/)
    const out = read('infra/terraform/outputs.tf')
    expect(out).toContain('TDCLOUD_MAX_FREE_TEAMS=0')
    expect(out).toContain('TDCLOUD_MAX_TEAMS_PER_HOST=${local.host_slots}')
    expect(out).toContain('PADDLE_ENV=sandbox')
    expect(read('infra/terraform/main.tf')).toContain('"m7g.large" = 10')
  })
})
