// "Who sees what", asked every way a person or their AI can ask: the web (list of the parent, stat, download, search),
// WebDAV (PROPFIND of the parent and the file, GET) and MCP (ls, cat, grep -r, find). A hidden item must answer exactly
// like one that does not exist (principle 2: hidden == nonexistent): same status, same body, the path aside.
import { bash, dav, davAuth, davHrefs, propfindBody } from './drive'
import type { T } from './ctx'
import type { Who } from './fixture'

export type Route = 'web' | 'search' | 'dav' | 'mcp'
const parentOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/'
const nameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1)
/** the same path with its folder renamed to one that never exists: /재무/결산.md → /재무-nx41/결산.md,
 * /프로젝트/비밀/secret.md → /프로젝트/비밀-nx41/secret.md (its parent is visible, like the hidden one's) */
export const missingTwin = (p: string) => { const s = p.split('/'); s[s.length - 2] = `${s[s.length - 2]}-nx41`; return s.join('/') }

export interface Sight { web: boolean; list: boolean; search: boolean; dav: boolean; davList: boolean; mcp: boolean; mcpLs: boolean; mcpGrep: boolean }

/** what `who` sees of `file` (whose content has `canary`) on each route; `ai` = their token (MCP), dav = app password */
export async function sight(t: T, who: Who, file: string, canary: string, routes: Route[] = ['web', 'search', 'dav', 'mcp']): Promise<Sight> {
  const fx = t.fx
  const s: Sight = { web: false, list: false, search: false, dav: false, davList: false, mcp: false, mcpLs: false, mcpGrep: false }
  if (routes.includes('web')) {
    const d = await fx.drive(who)
    const dl = await d.download(file)
    s.web = dl.status === 200 && dl.text.includes(canary)
    const ls = await d.list(parentOf(file))
    s.list = ls.status === 200 && (ls.json().entries as { name: string }[]).some((e) => e.name === nameOf(file))
  }
  if (routes.includes('search')) {
    const r = await (await fx.drive(who)).search(canary)
    s.search = r.status === 200 && JSON.stringify(r.json().results ?? []).includes(canary)
  }
  if (routes.includes('dav')) {
    const auth = davAuth(fx.login(who), await fx.appPassword(who))
    const g = await dav(t.http, fx.slug, auth, 'GET', file)
    s.dav = g.status === 200 && g.text.includes(canary)
    const pf = await dav(t.http, fx.slug, auth, 'PROPFIND', `${parentOf(file)}/`, { body: propfindBody, headers: { depth: '1', 'content-type': 'application/xml' } })
    s.davList = pf.status === 207 && davHrefs(pf.text).some((h) => h.replace(/\/$/, '').endsWith(`/${nameOf(file)}`))
  }
  if (routes.includes('mcp')) {
    const tok = await fx.token(who)
    const cat = await bash(t.http, fx.slug, tok, `cat '${file}'`)
    s.mcp = cat.stdout.includes(canary)
    const ls = await bash(t.http, fx.slug, tok, `ls '${parentOf(file)}'`)
    s.mcpLs = ls.stdout.split('\n').includes(nameOf(file))
    const g = await bash(t.http, fx.slug, tok, `grep -rl '${canary}' / ; true`)
    s.mcpGrep = g.stdout.includes(canary) || g.stdout.split('\n').some((l) => l.endsWith(nameOf(file)))
  }
  return s
}

/** check that `who` sees `file` on every asked route (expect=true) or on none, with hidden == nonexistent */
export async function expectSight(t: T, who: Who, file: string, canary: string, expect: { human: boolean; ai: boolean }, label = '', routes: Route[] = ['web', 'search', 'dav', 'mcp']) {
  const s = await sight(t, who, file, canary, routes)
  const tag = `${who} ${file}${label ? ` (${label})` : ''}`
  if (routes.includes('web')) {
    t.check(`${tag}: web download ${expect.human ? 'works' : 'is not there'}`, s.web === expect.human, s)
    t.check(`${tag}: web folder list ${expect.human ? 'shows' : 'lacks'} it`, s.list === expect.human, s)
  }
  if (routes.includes('search')) t.check(`${tag}: web search ${expect.human ? 'finds' : 'does not find'} it`, s.search === expect.human, s)
  // WebDAV is a person's own access (a mounted drive is the person, not their AI: No AI does not apply — S47)
  if (routes.includes('dav')) t.check(`${tag}: WebDAV GET/PROPFIND ${expect.human ? 'see' : 'do not see'} it`, s.dav === expect.human && s.davList === expect.human, s)
  if (routes.includes('mcp')) t.check(`${tag}: their AI (MCP cat/ls/grep -r) ${expect.ai ? 'reads' : 'does not see'} it`, s.mcp === expect.ai && s.mcpLs === expect.ai && s.mcpGrep === expect.ai, s)
  if (!expect.human) await hiddenLikeMissing(t, who, file, routes)
  else if (!expect.ai && routes.includes('mcp')) await hiddenLikeMissing(t, who, file, ['mcp'])
}

/** the hidden path answers byte for byte like a path that does not exist (the path itself aside) */
export async function hiddenLikeMissing(t: T, who: Who, file: string, routes: Route[] = ['web', 'dav', 'mcp']) {
  const fx = t.fx
  const twin = missingTwin(file)
  const norm = (s: string, p: string) => s.split(p).join('<P>').split(encodeURI(p)).join('<P>')
  if (routes.includes('web')) {
    const d = await fx.drive(who)
    for (const [what, f] of [['stat', (p: string) => d.stat(p)], ['download', (p: string) => d.download(p)], ['list', (p: string) => d.list(parentOf(p))]] as const) {
      const a = await f(file), b = await f(twin)
      t.check(`${who} ${file}: web ${what} hidden == nonexistent (${a.status})`, a.status === b.status && a.status === 404 && norm(a.text, file) === norm(b.text, twin), { hidden: [a.status, a.text], missing: [b.status, b.text] })
    }
  }
  if (routes.includes('dav')) {
    const auth = davAuth(fx.login(who), await fx.appPassword(who))
    for (const m of ['GET', 'PROPFIND'] as const) {
      const o = m === 'PROPFIND' ? { body: propfindBody, headers: { depth: '0', 'content-type': 'application/xml' } } : {}
      const a = await dav(t.http, fx.slug, auth, m, file, o), b = await dav(t.http, fx.slug, auth, m, twin, o)
      t.check(`${who} ${file}: WebDAV ${m} hidden == nonexistent (${a.status})`, a.status === b.status && a.status === 404 && norm(a.text, file) === norm(b.text, twin), { hidden: [a.status, a.text], missing: [b.status, b.text] })
    }
  }
  if (routes.includes('mcp')) {
    const tok = await fx.token(who)
    for (const cmd of ['cat', 'ls', 'stat', 'wc -c']) {
      // no tool result at all (exit null: the call itself failed, e.g. a busy worker) says nothing about hidden vs
      // missing: ask once more, and show the raw answer if it fails again
      const run = async (p: string) => { const r = await bash(t.http, fx.slug, tok, `${cmd} '${p}'`); return r.exit === null ? bash(t.http, fx.slug, tok, `${cmd} '${p}'`) : r }
      const a = await run(file), b = await run(twin)
      t.check(`${who} ${file}: MCP \`${cmd}\` hidden == nonexistent (exit ${a.exit})`, a.exit === b.exit && a.exit !== 0 && norm(a.stderr, file) === norm(b.stderr, twin) && a.stdout === b.stdout,
        { hidden: [a.exit, a.stderr, ...(a.exit === null ? [a.status, a.raw.slice(0, 300)] : [])], missing: [b.exit, b.stderr, ...(b.exit === null ? [b.status, b.raw.slice(0, 300)] : [])] })
    }
  }
}
