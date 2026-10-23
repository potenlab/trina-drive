// The console's page frames and stylesheet (workstream D1). One design with the landing and the drive: the brand
// tokens are ./tokens.css (a copy of brand/tokens.css made by `bun run brand:sync` — never edit it here), Geist from
// ./brand/fonts, the Star Pillar mark from ./brand/mark.svg drawn with --logo-ink / --logo-top.
//   page()   a centered card (sign in, sign up, invites, the Free and wake pages web.ts renders)
//   shell()  the signed-in console: top bar (mark, team switcher, theme, account menu), left rail (Teams, the team's
//            Overview · Members · Plan & usage · Settings · Audit), the page head with its one Signal Orange action
// Server-rendered HTML; the little JavaScript (theme, copy buttons, the SSO auto-post, the address check) is
// /static/console.js under the CSP's script-src 'self'.
import fs from 'node:fs'
import path from 'node:path'

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

const read = (p: string) => { try { return fs.readFileSync(path.join(import.meta.dir, p), 'utf8') } catch { return '' } }
export const TOKENS_CSS = read('tokens.css')

/** The Star Pillar mark, inline, coloured by the tokens (light and dark). */
export const MARK = read('brand/mark.svg')
  .replace('<svg ', '<svg aria-hidden="true" focusable="false" class="mark" ')
  .replace(/#14110f/gi, 'var(--logo-ink)').replace(/#ff5b1f/gi, 'var(--logo-top)')
  .replace('id="m"', 'id="tcm"').replace('url(#m)', 'url(#tcm)')

const ICONS: Record<string, string> = {
  grid: '<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  home: '<path d="M4 11l8-7 8 7v9H4z"/><path d="M10 20v-6h4v6"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.6-3.2 3-5 5.5-5s4.9 1.8 5.5 5"/><circle cx="17" cy="9" r="2.4"/><path d="M15.8 14.2c2.3.2 4.1 1.8 4.7 4.8"/>',
  gauge: '<path d="M4 18a8 8 0 1 1 16 0"/><path d="M12 18l4-5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  chevron: '<path d="M8 10l4 4 4-4"/>',
  shield: '<path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
}
export const icon = (name: keyof typeof ICONS | string) => `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ''}</svg>`

const HEAD = (title: string, extra = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Trina Cloud</title><meta name="color-scheme" content="light dark"><link rel="icon" href="/static/mark.svg" type="image/svg+xml">
<link rel="preload" href="/static/fonts/Geist-Variable.woff2" as="font" type="font/woff2" crossorigin>
<script src="/static/theme.js"></script><link rel="stylesheet" href="/static/app.css"><script src="/static/console.js" defer></script>${extra}</head>`

const html = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers } })

const themeButton = `<button type="button" class="icon-btn" data-theme-toggle aria-label="Switch light or dark">${icon('sun').replace('class="ic"', 'class="ic theme-light"')}${icon('moon').replace('class="ic"', 'class="ic theme-dark"')}</button>`

/** The centered frame (sign in, sign up, invites; web.ts's Free and wake pages). */
export function page(title: string, body: string, opts: { paddle?: boolean; turnstile?: boolean; wake?: boolean; status?: number; headers?: Record<string, string>; wide?: boolean } = {}) {
  const extra = `${opts.paddle ? '<script src="https://cdn.paddle.com/paddle/v2/paddle.js"></script><script src="/static/checkout.js" defer></script>' : ''}${opts.turnstile ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' : ''}${opts.wake ? '<script src="/static/wake.js" defer></script>' : ''}`
  return html(`${HEAD(title, extra)}
<body class="auth"><header class="auth-top"><a class="logo" href="/">${MARK}<span>Trina Cloud</span></a><span class="grow"></span>${themeButton}</header>
<main class="auth-main${opts.wide ? ' wide' : ''}"><div class="panel">${body}</div>
<p class="foot">Trina Cloud · <a href="https://drive.trina.app">drive.trina.app</a></p></main></body></html>`, opts.status, opts.headers)
}

export interface ShellTeam { slug: string; name: string; role: string }
export interface ShellOpts {
  title: string
  user: { email: string; name: string | null }
  csrf: string
  teams: ShellTeam[]
  /** the team this page is about (its menu shows) */
  team?: ShellTeam & { status: string }
  /** which rail entry is current */
  section?: 'teams' | 'new' | 'overview' | 'members' | 'usage' | 'settings' | 'audit' | 'account'
  /** the page head: h1, an optional line under it, and the actions on the right */
  heading: string
  sub?: string
  actions?: string
  body: string
  flash?: { kind: 'ok' | 'err' | 'warn'; text: string } | null
  banner?: string
  status?: number
}

const initials = (s: string) => (s.trim()[0] ?? '?').toUpperCase()

/** The signed-in console frame. */
export function shell(o: ShellOpts) {
  const nav = (href: string, label: string, ic: string, key: ShellOpts['section']) =>
    `<a href="${href}" class="nav-item"${o.section === key ? ' aria-current="page"' : ''}>${icon(ic)}<span>${esc(label)}</span></a>`
  const team = o.team
  const teamMenu = team ? `<div class="rail-group"><p class="rail-label">${esc(team.name)}</p>
${nav(`/t/${team.slug}`, 'Overview', 'home', 'overview')}${nav(`/t/${team.slug}/members`, 'Members', 'users', 'members')}${nav(`/t/${team.slug}/usage`, 'Plan & usage', 'gauge', 'usage')}${nav(`/t/${team.slug}/settings`, 'Settings', 'gear', 'settings')}${['owner', 'admin'].includes(team.role) ? nav(`/t/${team.slug}/audit`, 'Audit', 'list', 'audit') : ''}</div>` : ''
  const switcher = `<details class="switcher"><summary><span class="avatar sq">${esc(initials(team?.name ?? 'T'))}</span><span class="sw-name">${esc(team?.name ?? 'All teams')}</span>${icon('chevron')}</summary>
<div class="menu"><p class="menu-label">Teams</p>${o.teams.map((t) => `<a href="/t/${esc(t.slug)}"${team?.slug === t.slug ? ' aria-current="true"' : ''}><span class="avatar sq sm">${esc(initials(t.name))}</span><span>${esc(t.name)}</span><span class="menu-role">${esc(t.role)}</span></a>`).join('') || '<p class="menu-empty">No team yet</p>'}
<hr><a href="/">${icon('grid')}<span>All teams</span></a><a href="/new">${icon('plus')}<span>New team</span></a></div></details>`
  const account = `<details class="account"><summary aria-label="Account"><span class="avatar">${esc(initials(o.user.name || o.user.email))}</span></summary>
<div class="menu right"><p class="menu-who"><b>${esc(o.user.name || o.user.email.split('@')[0])}</b><span>${esc(o.user.email)}</span></p><hr>
<a href="/account">${icon('shield')}<span>Account &amp; security</span></a><a href="https://drive.trina.app" rel="noopener">${icon('ext')}<span>drive.trina.app</span></a><hr>
<form method="post" action="/logout"><input type="hidden" name="csrf" value="${esc(o.csrf)}"><button class="menu-btn">Sign out</button></form></div></details>`
  const flash = o.flash ? `<div class="flash flash-${o.flash.kind}" role="status">${esc(o.flash.text)}</div>` : ''
  return html(`${HEAD(o.title)}
<body class="app"><input type="checkbox" id="nav-open" class="nav-open" aria-hidden="true" tabindex="-1">
<header class="top"><label for="nav-open" class="icon-btn menu-toggle" aria-label="Menu">${icon('menu')}</label>
<a class="logo" href="/">${MARK}<span>Trina Cloud</span></a><span class="slash">/</span>${switcher}<span class="grow"></span>${themeButton}${account}</header>
<div class="frame"><nav class="rail" aria-label="Console"><div class="rail-group">${nav('/', 'Teams', 'grid', 'teams')}${nav('/new', 'New team', 'plus', 'new')}</div>${teamMenu}
<div class="rail-foot">${nav('/account', 'Account & security', 'shield', 'account')}</div></nav>
<label for="nav-open" class="scrim" aria-hidden="true"></label>
<main class="main" id="main">${o.banner ?? ''}<div class="head"><div class="head-text"><h1>${esc(o.heading)}</h1>${o.sub ? `<p class="sub">${o.sub}</p>` : ''}</div>${o.actions ? `<div class="head-actions">${o.actions}</div>` : ''}</div>
${flash}${o.body}</main></div></body></html>`, o.status ?? 200)
}

// ---------------------------------------------------------------- the stylesheet
const FONTS = `@font-face{font-family:"Geist";src:url(/static/fonts/Geist-Variable.woff2) format("woff2");font-weight:100 900;font-style:normal;font-display:swap}
@font-face{font-family:"Geist Mono";src:url(/static/fonts/GeistMono-Variable.woff2) format("woff2");font-weight:100 900;font-style:normal;font-display:swap}`

const BASE = `*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 var(--font-sans);-webkit-font-smoothing:antialiased;font-feature-settings:"ss01","cv11"}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
h1,h2,h3{margin:0;letter-spacing:-.02em;line-height:1.2;font-weight:600}
p{margin:0}code,kbd,.mono{font-family:var(--font-mono);font-size:.92em}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:6px}
::selection{background:color-mix(in srgb,var(--accent) 28%,transparent)}
.ic{width:18px;height:18px;flex:none}
.grow{flex:1}
.muted{color:var(--fg-muted)}.faint{color:var(--fg-faint)}.small{font-size:13px}
.mark{width:24px;height:24px;flex:none;display:block}
.logo{display:inline-flex;align-items:center;gap:9px;color:var(--fg);font-weight:650;letter-spacing:-.03em;font-size:16px;text-decoration:none;white-space:nowrap}
.logo:hover{text-decoration:none}
.icon-btn{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:9px;border:1px solid transparent;background:none;color:var(--fg-muted);cursor:pointer;font:inherit}
.icon-btn:hover{color:var(--fg);background:var(--bg-soft)}
.theme-dark{display:none}:root[data-theme="dark"] .theme-dark{display:block}:root[data-theme="dark"] .theme-light{display:none}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .theme-dark{display:block}:root:not([data-theme="light"]) .theme-light{display:none}}
/* buttons */
.btn,button.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:38px;padding:0 14px;border-radius:var(--radius-sm);border:1px solid var(--border-strong);background:var(--bg-elev);color:var(--fg);font:inherit;font-size:14px;font-weight:550;line-height:1;cursor:pointer;text-decoration:none;white-space:nowrap;box-shadow:var(--shadow-sm);transition:background-color .15s,border-color .15s}
.btn:hover{border-color:var(--fg-faint);text-decoration:none}
.btn-primary,button.btn-primary{background:var(--cta);color:var(--cta-fg);border-color:transparent;box-shadow:inset 0 1px 0 rgba(255,255,255,.14),0 1px 2px rgba(0,0,0,.18)}
.btn-primary:hover{background:var(--cta-hover);border-color:transparent}
.btn-primary:focus-visible{outline-color:var(--fg)}
.btn-dark,button.btn-dark{background:var(--btn);color:var(--btn-fg);border-color:transparent}
.btn-dark:hover{background:var(--btn-hover)}
.btn-danger,button.btn-danger{background:var(--danger);color:#fff;border-color:transparent}
:root[data-theme="dark"] .btn-danger{color:#14110f}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .btn-danger{color:#14110f}}
.btn-ghost,button.btn-ghost{background:none;border-color:transparent;box-shadow:none;color:var(--fg-muted)}
.btn-ghost:hover{background:var(--bg-soft);color:var(--fg)}
.btn-sm{min-height:32px;padding:0 11px;font-size:13px}
.btn-block{width:100%}
.btn .ic{width:16px;height:16px}
button[disabled],.btn[aria-disabled="true"]{opacity:.5;cursor:not-allowed}
.link-btn{background:none;border:0;padding:0;font:inherit;color:var(--accent);cursor:pointer}
.link-btn:hover{text-decoration:underline}
.danger-link{color:var(--danger)}
/* forms */
form{margin:0}
label.field{display:block;margin:0 0 14px;font-size:13.5px;font-weight:550;color:var(--fg)}
label.field>span.hint,.hint{display:block;margin-top:5px;font-weight:400;color:var(--fg-faint);font-size:12.5px}
input[type=text],input[type=email],input[type=password],input:not([type]),input[type=search],select,textarea{display:block;width:100%;margin-top:6px;padding:9px 11px;border:1px solid var(--border-strong);border-radius:var(--radius-sm);background:var(--bg-elev);color:var(--fg);font:inherit;font-size:14.5px;font-weight:400;transition:border-color .15s,box-shadow .15s}
select{min-height:41px}
.copied-tip{font-size:12px;color:var(--ok);margin-left:4px}.ok-text{color:var(--ok);font-size:13px;margin-top:6px}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 18%,transparent)}
input[readonly]{background:var(--inset);color:var(--fg-muted)}
input.code{font-family:var(--font-mono);letter-spacing:.2em;font-size:18px;text-align:center}
.inline{display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap}.inline>*{margin:0}
.inline input,.inline select{margin-top:0}
.addon{display:flex;align-items:stretch;margin-top:6px}.addon input{margin:0;border-radius:var(--radius-sm) 0 0 var(--radius-sm)}
.addon span{display:flex;align-items:center;padding:0 11px;border:1px solid var(--border-strong);border-left:0;border-radius:0 var(--radius-sm) var(--radius-sm) 0;background:var(--inset);color:var(--fg-muted);font-size:13.5px;white-space:nowrap}
.check{display:flex;gap:8px;align-items:center;font-size:14px;margin:0 0 12px}
.err-text{color:var(--danger);font-size:13px;margin-top:6px}
/* badges */
.badge{display:inline-flex;align-items:center;gap:6px;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:550;white-space:nowrap;border:1px solid transparent;line-height:1.6}
.badge::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.badge.nodot::before{display:none}
.b-ok{color:var(--ok);background:color-mix(in srgb,var(--ok) 10%,transparent);border-color:color-mix(in srgb,var(--ok) 22%,transparent)}
.b-warn{color:var(--warn);background:var(--warn-soft);border-color:color-mix(in srgb,var(--warn) 25%,transparent)}
.b-danger{color:var(--danger);background:var(--danger-soft);border-color:color-mix(in srgb,var(--danger) 25%,transparent)}
.b-muted{color:var(--fg-muted);background:var(--bg-soft);border-color:var(--border)}
.b-accent{color:var(--accent);background:var(--accent-soft);border-color:color-mix(in srgb,var(--accent) 25%,transparent)}
.b-starting::before{animation:pulse 1.2s ease-in-out infinite}
@keyframes pulse{50%{opacity:.25}}
@media (prefers-reduced-motion:reduce){.b-starting::before{animation:none}}
/* flash */
.flash{padding:11px 14px;border-radius:var(--radius-sm);margin:0 0 20px;font-size:14px;border:1px solid}
.flash-ok{color:var(--ok);background:color-mix(in srgb,var(--ok) 8%,transparent);border-color:color-mix(in srgb,var(--ok) 25%,transparent)}
.flash-err{color:var(--danger);background:var(--danger-soft);border-color:color-mix(in srgb,var(--danger) 25%,transparent)}
.flash-warn{color:var(--warn);background:var(--warn-soft);border-color:color-mix(in srgb,var(--warn) 25%,transparent)}
.banner{display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:12px 16px;margin:0 0 22px;border-radius:var(--radius);background:var(--warn-soft);border:1px solid color-mix(in srgb,var(--warn) 25%,transparent);color:var(--fg)}
.banner .ic{color:var(--warn)}.banner p{flex:1;min-width:200px;font-size:14px}
/* cards, sections */
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow-sm)}
.card-pad{padding:20px}
.section{margin:0 0 22px}
.section>.card{overflow:hidden}
.sec-head{display:flex;align-items:center;gap:12px;padding:16px 20px;border-bottom:1px solid var(--border)}
.sec-head h2{font-size:15px}.sec-head p{font-size:13px;color:var(--fg-muted)}
.sec-body{padding:18px 20px}
.sec-foot{display:flex;justify-content:flex-end;gap:8px;align-items:center;padding:12px 20px;border-top:1px solid var(--border);background:var(--bg-tint)}
.sec-foot .muted{margin-right:auto;font-size:13px}
.danger-zone{border-color:color-mix(in srgb,var(--danger) 35%,var(--border))}
.danger-zone .sec-head h2{color:var(--danger)}
.kv{display:grid;grid-template-columns:minmax(110px,170px) minmax(0,1fr);gap:10px 18px;font-size:14px}
.kv dt{color:var(--fg-muted)}.kv dd{margin:0;min-width:0;overflow-wrap:anywhere}
.copy{display:flex;align-items:center;gap:6px;min-width:0}
.copy code{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:5px 9px;border-radius:7px;background:var(--inset);border:1px solid var(--border)}
.copy .icon-btn{width:30px;height:30px}
.grid-2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}
.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin:0 0 22px}
.stat{padding:16px 18px}.stat p{font-size:12.5px;color:var(--fg-muted)}.stat b{display:block;margin-top:6px;font-size:22px;font-weight:600;letter-spacing:-.02em}
.stat span{font-size:12.5px;color:var(--fg-faint)}
.meter{height:8px;border-radius:999px;background:var(--inset);overflow:hidden;display:flex;margin:10px 0 8px}
.meter i{display:block;height:100%}
.m-files{background:var(--accent)}.m-versions{background:color-mix(in srgb,var(--accent) 55%,var(--bg))}.m-trash{background:var(--border-strong)}
.legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12.5px;color:var(--fg-muted)}.legend i{display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:6px;vertical-align:-1px}
/* tables */
.table{width:100%;border-collapse:collapse;font-size:14px}
.table th{text-align:left;font-weight:500;font-size:12.5px;color:var(--fg-faint);padding:10px 20px;background:var(--bg-tint);border-bottom:1px solid var(--border);white-space:nowrap}
.table td{padding:12px 20px;border-bottom:1px solid var(--border);vertical-align:middle}
.table tr:last-child td{border-bottom:0}
.table .actions{text-align:right;white-space:nowrap}
.who{display:flex;align-items:center;gap:10px;min-width:0}.who b{font-weight:550;display:block}.who span{color:var(--fg-muted);font-size:13px;overflow-wrap:anywhere}
.who>div{min-width:0}
.row-menu{position:relative;display:inline-block}
.row-menu>summary{list-style:none;cursor:pointer}.row-menu>summary::-webkit-details-marker{display:none}
.row-menu .menu{min-width:230px}
.row-menu .menu form{padding:4px 6px}
.empty{padding:28px 20px;text-align:center;color:var(--fg-muted);font-size:14px}
/* avatars, menus */
.avatar{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:50%;background:var(--accent-soft);color:var(--accent);font-weight:650;font-size:13px;flex:none}
.avatar.sq{border-radius:8px;background:var(--btn);color:var(--btn-fg)}.avatar.sm{width:22px;height:22px;font-size:11px;border-radius:6px}
details>summary{list-style:none}details>summary::-webkit-details-marker{display:none}
.switcher,.account{position:relative}
.switcher>summary,.account>summary{display:flex;align-items:center;gap:8px;cursor:pointer;padding:5px 8px;border-radius:9px;font-weight:550;font-size:14px;color:var(--fg)}
.switcher>summary:hover,.account>summary:hover{background:var(--bg-soft)}
.switcher .ic{width:15px;height:15px;color:var(--fg-faint)}
.sw-name{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.menu{position:absolute;top:calc(100% + 6px);left:0;z-index:40;min-width:260px;padding:6px;background:var(--bg-elev);border:1px solid var(--border);border-radius:12px;box-shadow:var(--shadow-lg)}
.menu.right{left:auto;right:0}
.menu a,.menu .menu-btn{display:flex;align-items:center;gap:10px;width:100%;padding:8px 10px;border-radius:8px;color:var(--fg);font:inherit;font-size:14px;text-decoration:none;background:none;border:0;cursor:pointer;text-align:left}
.menu a:hover,.menu .menu-btn:hover{background:var(--bg-soft);text-decoration:none}
.menu a[aria-current]{background:var(--accent-soft)}
.menu hr{border:0;border-top:1px solid var(--border);margin:6px 0}
.menu-label{font-size:12px;color:var(--fg-faint);padding:6px 10px 4px}.menu-empty{font-size:13px;color:var(--fg-muted);padding:6px 10px}
.menu-role{margin-left:auto;font-size:12px;color:var(--fg-faint)}
.menu-who{padding:8px 10px;font-size:14px}.menu-who span{display:block;color:var(--fg-muted);font-size:12.5px}
.menu .ic{color:var(--fg-muted)}
/* the signed-in frame */
.top{position:sticky;top:0;z-index:30;display:flex;align-items:center;gap:8px;height:56px;padding:0 16px;background:color-mix(in srgb,var(--bg) 82%,transparent);backdrop-filter:saturate(180%) blur(14px);-webkit-backdrop-filter:saturate(180%) blur(14px);border-bottom:1px solid var(--border)}
.top .slash{color:var(--border-strong);font-size:20px;margin:0 2px}
.menu-toggle{display:none}.nav-open{position:absolute;opacity:0;pointer-events:none}
.frame{display:grid;grid-template-columns:232px minmax(0,1fr);min-height:calc(100vh - 56px)}
.rail{position:sticky;top:56px;align-self:start;height:calc(100vh - 56px);overflow:auto;display:flex;flex-direction:column;gap:18px;padding:16px 12px;border-right:1px solid var(--border);background:var(--bg-tint)}
.rail-label{font-size:12px;color:var(--fg-faint);padding:0 10px 6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nav-item{display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:8px;color:var(--fg-muted);font-size:14px;font-weight:450;text-decoration:none;border:1px solid transparent}
.nav-item:hover{background:var(--bg-soft);color:var(--fg);text-decoration:none}
.nav-item[aria-current]{background:var(--card);color:var(--fg);font-weight:550;border-color:var(--border);box-shadow:var(--shadow-sm)}
.nav-item[aria-current] .ic{color:var(--accent)}
.rail-foot{margin-top:auto}
.scrim{display:none}
.main{min-width:0;width:100%;max-width:1120px;padding:32px 40px 64px}
.head{display:flex;align-items:flex-end;gap:16px;flex-wrap:wrap;margin:0 0 24px}
.head-text{flex:1;min-width:0}.head h1{font-size:26px;letter-spacing:-.03em}.head .sub{margin-top:6px;color:var(--fg-muted);font-size:14.5px;overflow-wrap:anywhere}
.head-actions{display:flex;gap:8px;flex-wrap:wrap}
/* team cards */
.teams{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}
.team-card{display:flex;flex-direction:column;gap:14px;padding:18px;transition:border-color .15s,box-shadow .15s}
.team-card:hover{border-color:var(--border-strong);box-shadow:var(--shadow)}
.tc-top{display:flex;align-items:flex-start;gap:12px}.tc-top h2{font-size:16px}.tc-top a{color:var(--fg)}
.tc-top p{font-size:13px;color:var(--fg-muted);overflow-wrap:anywhere}
.tc-meta{display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:13px;color:var(--fg-muted)}
.tc-actions{display:flex;gap:8px;margin-top:auto}
.tc-new{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;min-height:176px;border:1.5px dashed var(--border-strong);border-radius:var(--radius);color:var(--fg-muted);font-weight:550}
.tc-new:hover{border-color:var(--accent);color:var(--accent);text-decoration:none}
/* plan picker */
.plans{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:6px 0 16px}
.plan{position:relative;display:block;padding:14px;border:1px solid var(--border-strong);border-radius:12px;cursor:pointer;background:var(--bg-elev)}
.plan input{position:absolute;opacity:0}
.plan b{display:block;font-size:15px}.plan span{display:block;font-size:12.5px;color:var(--fg-muted);margin-top:4px}
.plan:has(input:checked){border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 16%,transparent)}
.plan:has(input:focus-visible){outline:2px solid var(--accent);outline-offset:2px}
.plan .soon{display:inline-block;margin-top:8px;font-size:11.5px;color:var(--warn)}
/* audit */
.audit td{font-size:13px}.audit code{font-size:12px;color:var(--fg-muted)}
/* the centered frame */
body.auth{min-height:100vh;display:flex;flex-direction:column;background:radial-gradient(1200px 500px at 50% -10%,var(--accent-soft),transparent 70%),var(--bg)}
.auth-top{display:flex;align-items:center;gap:8px;padding:16px 20px}
.auth-main{flex:1;width:100%;max-width:440px;margin:0 auto;padding:24px 16px 40px}
.auth-main.wide{max-width:620px}
.panel{background:var(--card);border:1px solid var(--border);border-radius:var(--radius-lg);box-shadow:var(--shadow);padding:30px}
.panel h1{font-size:24px;letter-spacing:-.03em;margin:0 0 8px}
.panel>p,.panel .lead{color:var(--fg-muted);margin:0 0 18px;font-size:14.5px}
.panel .alt{margin-top:18px;font-size:14px;color:var(--fg-muted);text-align:center}
.panel .divider{display:flex;align-items:center;gap:12px;margin:20px 0;color:var(--fg-faint);font-size:12.5px}
.panel .divider::before,.panel .divider::after{content:"";flex:1;border-top:1px solid var(--border)}
.panel .err{color:var(--danger)}
.panel label{display:block;margin:0 0 14px;font-size:13.5px;font-weight:550}
.panel button:not(.link-btn):not(.icon-btn){display:inline-flex;align-items:center;justify-content:center;min-height:42px;padding:0 16px;border-radius:var(--radius-sm);border:1px solid transparent;background:var(--btn);color:var(--btn-fg);font:inherit;font-weight:550;cursor:pointer;width:100%}
.panel button.btn-primary:not(.link-btn):not(.icon-btn){background:var(--cta);color:var(--cta-fg)}
.panel button.btn-primary:not(.link-btn):not(.icon-btn):hover{background:var(--cta-hover)}
.panel button.plain:not(.link-btn):not(.icon-btn),.panel button.btn-secondary:not(.link-btn):not(.icon-btn){background:var(--bg-elev);color:var(--fg);border-color:var(--border-strong)}
.panel .card{padding:16px;margin:16px 0;box-shadow:none}
.panel .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.panel .btn{width:auto}
.foot{margin-top:18px;text-align:center;font-size:12.5px;color:var(--fg-faint)}
.foot a{color:var(--fg-muted)}
.secret{font-family:var(--font-mono);font-size:15px;letter-spacing:.06em;padding:10px 12px;border-radius:9px;background:var(--inset);border:1px solid var(--border);overflow-wrap:anywhere}
.codes{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 14px;font-family:var(--font-mono);font-size:14px;padding:12px 14px;border-radius:9px;background:var(--inset);border:1px solid var(--border)}
/* responsive */
@media (max-width:900px){
  .menu-toggle{display:inline-flex}
  .frame{grid-template-columns:minmax(0,1fr)}
  .rail{position:fixed;top:56px;left:0;bottom:0;height:auto;width:264px;z-index:35;transform:translateX(-100%);transition:transform .2s;box-shadow:var(--shadow-lg)}
  .nav-open:checked~.frame .rail{transform:none}
  .nav-open:checked~.frame .scrim{display:block;position:fixed;inset:56px 0 0;z-index:34;background:rgba(0,0,0,.28)}
  .main{padding:22px 16px 48px}
  .stats{grid-template-columns:repeat(2,minmax(0,1fr))}
  .grid-2{grid-template-columns:minmax(0,1fr)}
}
@media (max-width:640px){
  .top{padding:0 10px;gap:4px}.top .logo span{display:none}.sw-name{max-width:150px}
  .head h1{font-size:22px}.head-actions{width:100%}.head-actions .btn{flex:1}
  .plans{grid-template-columns:minmax(0,1fr)}
  .kv{grid-template-columns:minmax(0,1fr);gap:2px 0}.kv dd{margin-bottom:10px}
  .table.stack thead{display:none}
  .table.stack tr{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 10px;padding:12px 16px;border-bottom:1px solid var(--border)}
  .table.stack tr:last-child{border-bottom:0}
  .table.stack td{padding:0;border:0}.table.stack td.wide{grid-column:1}
  .table.stack td.actions{grid-row:1;grid-column:2}
  .sec-head,.sec-body{padding-left:16px;padding-right:16px}.sec-foot{padding:12px 16px;flex-wrap:wrap}
  .panel{padding:22px}
  .stats{gap:10px}.stat{padding:14px}
  .teams{grid-template-columns:minmax(0,1fr)}
}
@media (prefers-reduced-motion:reduce){.rail{transition:none}}`

export const CSS = `${TOKENS_CSS}\n${FONTS}\n${BASE}`
