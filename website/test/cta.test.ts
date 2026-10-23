// The landing's calls to action, checked in the built pages: Sign in and every "start" button go to the Trina Cloud
// console (cloud.trina.app), never to an early-access mailto, while CLOUD_LIVE is false; /security stays linked.
// Builds the site once into a temp directory (about a second).
import { beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLOUD_LIVE } from '../src/site'

const root = join(import.meta.dir, '..')
const out = mkdtempSync(join(tmpdir(), 'trina-site-'))
const pages: Record<string, string> = {}

beforeAll(async () => {
  const r = Bun.spawnSync(['bun', 'x', 'astro', 'build', '--outDir', out, '--silent'], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`astro build failed: ${r.stderr.toString()}`)
  for (const [k, f] of [['home', 'index.html'], ['a', 'a.html'], ['security', 'security.html']]) pages[k] = readFileSync(join(out, f!), 'utf8')
}, 120_000)

const tagsWith = (html: string, cta: string) => [...html.matchAll(new RegExp(`<(a|button)[^>]*data-cta="${cta}"[^>]*>`, 'g'))].map((m) => m[0])
const hrefs = (html: string, cta: string) => tagsWith(html, cta).map((t) => /href="([^"]*)"/.exec(t)?.[1] ?? '(no href)')
const SIGNUP = 'https://cloud.trina.app/signup'

describe('landing calls to action', () => {
  test.each(['home', 'a', 'security'])('%s: nav Sign in → console login, Request access → console sign-up', (p) => {
    const html = pages[p]!
    expect(hrefs(html, 'sign-in')).toEqual(['https://cloud.trina.app/login'])
    expect(html).toMatch(/data-cta="sign-in"[^>]*>Sign in<\/a>/)
    expect(hrefs(html, 'get-started')).toEqual([SIGNUP, SIGNUP]) // header + mobile menu
    expect(html).toMatch(/data-cta="get-started"[^>]*>Request access<\/a>/)
  })

  test.each(['home', 'a'])('%s: every "Start your team drive" opens the console sign-up while the cloud is not live', (p) => {
    if (CLOUD_LIVE) return
    const html = pages[p]!
    const starts = hrefs(html, 'early-access')
    expect(starts.length).toBeGreaterThanOrEqual(2) // hero and final call to action (at least)
    for (const h of starts) expect(h).toBe(SIGNUP)
    expect(html).not.toContain('Trina%20Cloud%20early%20access') // the old mailto
    expect(html).not.toContain('data-cta="start-trial"')
  })

  test.each(['home', 'a'])('%s: pricing — Free/Team/Business request access through the console, Enterprise emails, no Paddle button', (p) => {
    if (CLOUD_LIVE) return
    const html = pages[p]!
    expect(hrefs(html, 'early-access-free')).toEqual([SIGNUP])
    expect(hrefs(html, 'early-access-team')).toEqual([`${SIGNUP}?plan=team`])
    expect(hrefs(html, 'early-access-business')).toEqual([`${SIGNUP}?plan=business`])
    expect(html).toContain('data-plan="setup"')
    expect(html).not.toMatch(/data-plan="(team|business)"/)
    expect(html).not.toContain('Join early access')
  })

  test.each(['home', 'a', 'security'])('%s: footer has a small Status & trust link to /security', (p) => {
    expect(pages[p]!).toMatch(/<a class="footer-trust"[^>]*href="\/security"[^>]*>.*?Status &amp; trust<\/a>/s)
  })
})
