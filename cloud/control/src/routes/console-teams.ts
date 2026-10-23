// The console's team pages and JSON API (plan 2.3): Teams (cards with status, plan, usage, Open drive), New team,
// and per team Overview · Members · Plan & usage · Settings · Audit, plus invites (/invite/<token>).
// Access: "not yours = not found" (console-guard teamFor). Changes by owners and admins need two-step verification
// (enrolled), and the sensitive ones a code from the last 5 minutes (finding 3): inviting an admin, changing a role,
// removing someone, transferring ownership, deleting the team.
import { audit, listAudit, verifyAudit } from '../audit'
import { CloudError, type ConsoleSession } from '../cloud'
import { teamBySlug, type TeamRow } from '../db'
import { invitePublicId } from '../invites'
import { planOf } from '../plans'
import { slugProblem, suggestSlug } from '../slug'
import type { Role } from '../sso'
import { atLeast, userPublicId } from '../team-members'
import { badge, bytes, copyField, csrfField, dateTime, meter, planName, roleBadge, stateBadge, storageOf, teamState, totpField, when } from '../ui/components'
import { esc, icon, page, shell } from '../ui/layout'
import { verifyPassword } from '../keys'
import { act, apiBody, flashOf, needTotp, rerender, stepUpFresh, teamFor } from './console-guard'
import { sessionCookie } from './console-http'
import type { ControlRoute, RouteCtx } from './types'

const teamsNav = (c: RouteCtx, s: ConsoleSession) => c.cloud.members.teamsOf(s.userId).map((t) => ({ slug: t.slug, name: t.name, role: t.role }))

/** the drive is reachable through "Open drive" */
const openable = (t: TeamRow) => ['active', 'past_due'].includes(t.status)

function openButton(c: RouteCtx, t: TeamRow, primary = true) {
  if (openable(t)) return `<a class="btn ${primary ? 'btn-primary' : ''}" href="/open/${esc(t.slug)}">Open drive ${icon('arrow')}</a>`
  if (c.cloud.free.isPaused(t)) return `<a class="btn ${primary ? 'btn-primary' : ''}" href="/wake/${esc(t.slug)}">Wake up</a>`
  return `<span class="btn" aria-disabled="true">Open drive</span>`
}

function totpBanner(c: RouteCtx, s: ConsoleSession, role: Role, next: string) {
  if (!atLeast(role, 'admin') || c.cloud.mfa.enabled(s.userId)) return ''
  return `<div class="banner" role="alert">${icon('shield')}<p><b>Set up two-step verification.</b> As ${role === 'owner' ? 'the owner' : 'an admin'} you need an authenticator app before you open the drive or change members and settings.</p><a class="btn btn-dark btn-sm" href="/account?required=1&next=${encodeURIComponent(next)}#two-step">Set it up</a></div>`
}

function teamShell(c: RouteCtx, s: ConsoleSession, t: TeamRow, role: Role, section: 'overview' | 'members' | 'usage' | 'settings' | 'audit', heading: string, body: string, o: { sub?: string; actions?: string } = {}) {
  return shell({
    title: `${heading} · ${t.name}`, user: s, csrf: s.csrf, teams: teamsNav(c, s), team: { slug: t.slug, name: t.name, role, status: t.status }, section,
    heading, sub: o.sub ?? `${esc(c.cloud.url(t).replace(/^https:\/\//, ''))} · ${stateBadge(c.cloud, t)}`, actions: o.actions ?? openButton(c, t), body,
    flash: flashOf(c), banner: totpBanner(c, s, role, c.url.pathname),
  })
}

// ---------------------------------------------------------------- Teams
function teamsPage(c: RouteCtx) {
  const s = c.session
  if (!s) return c.redirect('/login')
  const teams = c.cloud.members.teamsOf(s.userId)
  const cards = teams.map((t) => {
    const st = storageOf(c.cloud, t), seats = c.cloud.members.seats(t)
    return `<article class="card team-card"><div class="tc-top"><span class="avatar sq">${esc((t.name[0] ?? 'T').toUpperCase())}</span><div style="min-width:0;flex:1"><h2><a href="/t/${esc(t.slug)}">${esc(t.name)}</a></h2><p>${esc(c.cloud.url(t).replace(/^https:\/\//, ''))}</p></div>${stateBadge(c.cloud, t)}</div>
<div class="tc-meta"><span>${esc(planName(t))}</span><span aria-hidden="true">·</span><span>${seats.used}${seats.max ? ` of ${seats.max}` : ''} ${seats.used === 1 ? 'person' : 'people'}</span><span aria-hidden="true">·</span><span>${esc(bytes(st.used))} of ${esc(bytes(st.quota))}</span><span class="grow"></span>${roleBadge(t.role)}</div>
${meter(c.cloud, t)}<div class="tc-actions">${openButton(c, t, teams.length === 1)}<a class="btn btn-ghost" href="/t/${esc(t.slug)}">Manage</a></div></article>`
  }).join('')
  const empty = teams.length ? '' : `<div class="card card-pad" style="margin-bottom:16px"><h2 style="font-size:16px;margin-bottom:6px">No team yet</h2><p class="muted">Create one, or ask a teammate to invite ${esc(s.email)}.</p></div>`
  return shell({
    title: 'Teams', user: s, csrf: s.csrf, teams: teams.map((t) => ({ slug: t.slug, name: t.name, role: t.role })), section: 'teams',
    heading: 'Your teams', sub: 'Each team has its own isolated Trina Drive.', actions: `<a class="btn btn-dark" href="/new">${icon('plus')} New team</a>`,
    body: `${s.verified ? '' : '<div class="flash flash-warn">Confirm your email address to create a team (check your inbox).</div>'}${empty}<div class="teams">${cards}<a class="tc-new" href="/new">${icon('plus')}<span>New team</span></a></div>`,
    flash: flashOf(c),
  })
}

// ---------------------------------------------------------------- New team
function newTeamPage(c: RouteCtx) {
  const s = c.session
  if (!s) return c.redirect('/login?next=/new')
  const full = c.cloud.free.full()
  const plan = c.url.searchParams.get('plan')
  const opt = (id: string, title: string, line: string, note: string) => `<label class="plan"><input type="radio" name="plan" value="${id}"${(plan ?? 'free') === id ? ' checked' : ''}><b>${title}</b><span>${line}</span><span class="soon">${note}</span></label>`
  const body = `<div class="card" style="max-width:720px"><form method="post" action="/new">${csrfField(s.csrf)}<div class="sec-body">
${s.verified ? '' : '<div class="flash flash-warn">Confirm your email address first (check your inbox).</div>'}
<label class="field">Team or company name<input name="name" required maxlength="80" autocomplete="organization" data-slug-source placeholder="Acme Inc."></label>
<label class="field">Address<span class="addon"><input name="slug" required pattern="[a-z0-9](?:[a-z0-9\\-]{1,30})[a-z0-9]" data-slug-check placeholder="acme" autocapitalize="off" spellcheck="false"><span>.${esc(c.cfg.domain)}</span></span><span class="hint" data-slug-status></span></label>
<p style="font-size:13.5px;font-weight:550;margin:4px 0 0">Plan</p><div class="plans">
${opt('free', 'Free', '1 GB · up to 3 people · pauses after 7 idle days', full ? 'By invitation — joins the waitlist' : 'Starts right away')}
${opt('team', 'Team', '100 GB · unlimited people', 'Payment coming soon')}
${opt('business', 'Business', '1 TB · priority support', 'Payment coming soon')}</div>
<p class="hint">Team and Business: write to <a href="mailto:${esc(c.cfg.opsEmail)}?subject=Trina%20Cloud%20team">${esc(c.cfg.opsEmail)}</a> and we set your team up while payment is being built.</p></div>
<div class="sec-foot"><a class="btn btn-ghost" href="/">Cancel</a><button class="btn btn-dark">Create team</button></div></form></div>`
  return shell({ title: 'New team', user: s, csrf: s.csrf, teams: teamsNav(c, s), section: 'new', heading: 'New team', sub: 'An isolated Trina Drive at its own address, with HTTPS.', body, flash: flashOf(c) })
}

async function createTeam(c: RouteCtx, s: ConsoleSession, b: Record<string, string>): Promise<{ status: string; team?: TeamRow; contact?: boolean }> {
  if (b.plan === 'team' || b.plan === 'business') {
    // plan 10.1: no Paddle now — paid teams are set up by operations (teams create … complimentary)
    audit(c.cloud.db, { actor: `user:${s.userId}`, action: 'team.paid_interest', detail: { plan: b.plan } })
    return { status: 'contact', contact: true }
  }
  c.limited('free-signup', c.cfg.free.signupsPerIpHour, 3600_000)
  const r = await c.cloud.free.requestForUser(s.userId, b.name, b.slug || suggestSlug(b.name ?? ''), c.ip)
  return { status: r.status, team: r.team }
}

// ---------------------------------------------------------------- Overview
function overviewPage(c: RouteCtx) {
  const { t, role, s } = teamFor(c, c.match[1]!)
  const st = teamState(c.cloud, t), seats = c.cloud.members.seats(t), sto = storageOf(c.cloud, t)
  const url = c.cloud.url(t)
  const stats = `<div class="stats"><div class="card stat"><p>Status</p><b>${badge(st.label, st.tone, { starting: st.starting })}</b><span>${esc(st.note ?? 'Healthy')}</span></div>
<div class="card stat"><p>Plan</p><b>${esc(planName(t).split(' · ')[0])}</b><span>${t.sub_status === 'complimentary' ? 'Complimentary' : t.plan === 'free' ? 'Free forever' : 'Paid'}</span></div>
<div class="card stat"><p>People</p><b>${seats.used}${seats.max ? `<span style="font-size:15px;color:var(--fg-faint)"> / ${seats.max}</span>` : ''}</b><span>members and open invites</span></div>
<div class="card stat"><p>Storage</p><b>${esc(bytes(sto.used))}</b><span>of ${esc(bytes(sto.quota))}</span></div></div>`
  const paused = c.cloud.free.isPaused(t)
  const connect = `<section class="section"><div class="card"><div class="sec-head"><div><h2>Drive</h2><p>Where your team and your AI tools connect.</p></div></div><div class="sec-body"><dl class="kv">
<dt>Web</dt><dd>${copyField(url)}</dd><dt>MCP (Claude, ChatGPT)</dt><dd>${copyField(`${url}/mcp`)}</dd><dt>Mount as a drive</dt><dd>${copyField(`${url}/dav/`)}</dd></dl></div>
<div class="sec-foot"><span class="muted">Each person's AI sees only what that person may see. Set up connectors in the drive: Connect AI.</span>${openable(t) ? `<a class="btn btn-sm" href="/open/${esc(t.slug)}">Connect AI</a>` : ''}</div></div></section>`
  const activity = `<section class="section"><div class="card"><div class="sec-head"><div><h2>Activity</h2></div></div><div class="sec-body"><dl class="kv">
<dt>Last used</dt><dd>${esc(when(sto.usage?.last_activity_at ?? t.last_activity_at))}</dd><dt>Last backup</dt><dd>${esc(when(t.last_backup_at))}</dd>
<dt>Created</dt><dd>${esc(dateTime(t.created_at))}</dd><dt>Your role</dt><dd>${roleBadge(role)}</dd></dl></div></div></section>`
  const wake = paused ? `<div class="banner"><p><b>This drive is paused</b> after a week without activity. Nothing is deleted.</p><form method="post" action="/t/${esc(t.slug)}/wake">${csrfField(s.csrf)}<button class="btn btn-dark btn-sm">Wake up</button></form></div>` : ''
  return teamShell(c, s, t, role, 'overview', t.name, `${wake}${stats}<div class="grid-2">${connect}${activity}</div>`)
}

// ---------------------------------------------------------------- Members
function membersPage(c: RouteCtx) {
  const { t, role, s } = teamFor(c, c.match[1]!)
  const admin = atLeast(role, 'admin')
  const enrolled = c.cloud.mfa.enabled(s.userId)
  const fresh = stepUpFresh(s)
  const members = c.cloud.members.list(t.id)
  const invites = c.cloud.invites.open(t.id)
  const seats = c.cloud.members.seats(t)
  const pending = new Set(c.cloud.sync.pendingRemovals(t.id))
  const failing = t.sync_failing_since && c.cfg.sso
  const syncLine = !c.cfg.sso ? '' : failing
    ? `<div class="flash flash-err" role="alert"><b>The drive has not taken the latest changes yet</b>${pending.size ? ` — ${pending.size} removal${pending.size > 1 ? 's' : ''} not applied` : ''}. Retrying automatically${admin ? `; <form method="post" action="/t/${esc(t.slug)}/sync" style="display:inline">${csrfField(s.csrf)}<button class="link-btn">retry now</button></form>` : ''}.</div>`
    : c.cloud.sync.behind(t) && openable(t) ? '<p class="hint" style="margin:-8px 0 16px">Syncing changes to the drive…</p>' : ''
  const canAct = (m: { role: Role; user_id: number }) => admin && m.user_id !== s.userId && m.role !== 'owner' && (m.role !== 'admin' || role === 'owner')
  const rowMenu = (m: { role: Role; user_id: number; public_id: string; email: string }) => !canAct(m) ? '' : `<details class="row-menu"><summary class="icon-btn" aria-label="Actions for ${esc(m.email)}">⋯</summary><div class="menu right">
<form method="post" action="/t/${esc(t.slug)}/members/${esc(m.public_id)}/role">${csrfField(s.csrf)}<input type="hidden" name="role" value="${m.role === 'admin' ? 'member' : 'admin'}">${fresh ? '' : '<input name="totp" inputmode="numeric" autocomplete="one-time-code" placeholder="Authenticator code" required style="margin:0 0 6px">'}<button class="menu-btn">${m.role === 'admin' ? 'Make member' : 'Make admin'}</button></form><hr>
<form method="post" action="/t/${esc(t.slug)}/members/${esc(m.public_id)}/remove" data-confirm="Remove ${esc(m.email)} from ${esc(t.name)}? Their sessions, tokens and app passwords stop working.">${csrfField(s.csrf)}${fresh ? '' : '<input name="totp" inputmode="numeric" autocomplete="one-time-code" placeholder="Authenticator code" required style="margin:0 0 6px">'}<button class="menu-btn danger-link">Remove from team</button></form></div></details>`
  const rows = members.map((m) => `<tr><td class="wide"><div class="who"><span class="avatar">${esc((m.name || m.email)[0]!.toUpperCase())}</span><div><b>${esc(m.name || m.email.split('@')[0])}${m.user_id === s.userId ? ' <span class="faint" style="font-weight:400">(you)</span>' : ''}</b><span>${esc(m.email)}</span></div></div></td>
<td>${roleBadge(m.role)}</td><td>${pending.has(m.public_id) ? badge('Removal pending', 'danger') : badge('Active', 'ok')}${atLeast(m.role, 'admin') && !m.totp ? ' <span class="badge b-warn nodot" title="Two-step verification not set up">No 2FA</span>' : ''}</td><td class="faint">${esc(when(m.created_at))}</td><td class="actions">${rowMenu(m)}</td></tr>`).join('')
  const inviteRows = invites.map((i) => `<tr><td class="wide"><div class="who"><span class="avatar" style="background:var(--bg-soft);color:var(--fg-faint)">@</span><div><b>${esc(i.email)}</b><span>Invited ${esc(when(i.last_sent_at ?? i.created_at))}${i.via === 'drive' ? ' from the drive' : ''} · expires ${esc(new Date(i.expires_at).toISOString().slice(0, 10))}</span></div></div></td>
<td>${roleBadge(i.role)}</td><td>${badge('Invited', 'warn')}</td><td></td><td class="actions">${admin ? `<details class="row-menu"><summary class="icon-btn" aria-label="Actions for the invite to ${esc(i.email)}">⋯</summary><div class="menu right">
<form method="post" action="/t/${esc(t.slug)}/invites/${esc(invitePublicId(i.id))}/resend">${csrfField(s.csrf)}<button class="menu-btn">Send again</button></form>
<form method="post" action="/t/${esc(t.slug)}/invites/${esc(invitePublicId(i.id))}/revoke">${csrfField(s.csrf)}<button class="menu-btn danger-link">Revoke invite</button></form></div></details>` : ''}</td></tr>`).join('')
  const full = seats.max != null && seats.used >= seats.max
  const inviteCard = !admin ? '' : `<section class="section"><div class="card"><div class="sec-head"><div><h2>Invite people</h2><p>They get an email link that works only for that address.</p></div></div>
<form method="post" action="/t/${esc(t.slug)}/invite">${csrfField(s.csrf)}<div class="sec-body"><div class="inline"><label class="field" style="flex:3;min-width:220px">Email addresses<input name="emails" required placeholder="mina@company.com, sam@company.com" autocomplete="off"${full || !enrolled ? ' disabled' : ''}></label>
<label class="field" style="flex:1;min-width:130px">Role<select name="role"${full || !enrolled ? ' disabled' : ''}><option value="member">Member</option><option value="admin">Admin</option></select></label></div>
${fresh ? '' : `<label class="field">Authenticator code <span class="faint" style="font-weight:400">(only for admins)</span><input name="totp" inputmode="numeric" autocomplete="one-time-code" placeholder="123 456" style="max-width:200px"${!enrolled ? ' disabled' : ''}></label>`}</div>
<div class="sec-foot"><span class="muted">${seats.max != null ? `${seats.used} of ${seats.max} people on ${planName(t)}` : 'Members can open the drive; admins also manage people and settings.'}</span><button class="btn btn-dark"${full || !enrolled ? ' disabled' : ''}>Send invites</button></div></form></div></section>`
  const leave = role !== 'owner' ? `<form method="post" action="/t/${esc(t.slug)}/leave" data-confirm="Leave ${esc(t.name)}? You lose access to its drive.">${csrfField(s.csrf)}<button class="btn btn-sm btn-ghost danger-link">Leave team</button></form>` : ''
  const body = `${syncLine}${inviteCard}<section class="section"><div class="card"><div class="sec-head"><div><h2>Members</h2><p>${members.length} ${members.length === 1 ? 'person' : 'people'}${invites.length ? ` · ${invites.length} invited` : ''}</p></div><span class="grow"></span>${leave}</div>
<table class="table stack"><thead><tr><th>Person</th><th>Role</th><th>Status</th><th>Added</th><th></th></tr></thead><tbody>${rows}${inviteRows}</tbody></table></div></section>
<p class="hint">Owner and admins manage members and settings and are admins in the drive. Removing someone ends their sessions, tokens, AI connections and app passwords on the drive.</p>`
  return teamShell(c, s, t, role, 'members', 'Members', body)
}

// ---------------------------------------------------------------- Plan & usage
function usagePage(c: RouteCtx) {
  const { t, role, s } = teamFor(c, c.match[1]!)
  const sto = storageOf(c.cloud, t), seats = c.cloud.members.seats(t), plan = planOf(t.plan)
  const u = sto.usage
  const legend = u ? `<div class="legend"><span><i class="m-files"></i>Files ${esc(bytes(u.files_bytes))}</span><span><i class="m-versions"></i>Earlier versions ${esc(bytes(u.versions_bytes))}</span><span><i class="m-trash"></i>Trash ${esc(bytes(u.trash_bytes))}</span></div>` : '<p class="hint">The drive reports details hourly.</p>'
  const body = `<div class="grid-2"><section class="section"><div class="card"><div class="sec-head"><div><h2>Plan</h2><p>${esc(planName(t))}</p></div><span class="grow"></span>${badge(planName(t).split(' · ')[0]!, 'accent', { dot: false })}</div>
<div class="sec-body"><dl class="kv"><dt>Storage</dt><dd>${plan.storageGb >= 1000 ? `${plan.storageGb / 1000} TB` : `${plan.storageGb} GB`}</dd><dt>People</dt><dd>${plan.maxPeople ? `up to ${plan.maxPeople}` : 'no limit'}</dd>
<dt>Backups</dt><dd>daily, encrypted${t.plan === 'free' ? `, ${c.cfg.free.backupKeep} kept` : `, ${c.cfg.backupKeep} kept`}</dd>${t.plan === 'free' ? `<dt>Idle pause</dt><dd>after ${Math.round(c.cfg.free.idlePauseMs / 86400_000)} days without activity</dd>` : ''}</dl></div>
<div class="sec-foot"><span class="muted">Upgrades: payment is coming soon.</span><a class="btn btn-sm" href="mailto:${esc(c.cfg.opsEmail)}?subject=${encodeURIComponent(`Upgrade ${t.slug}`)}">Contact us</a></div></div></section>
<section class="section"><div class="card"><div class="sec-head"><div><h2>Storage</h2><p>${esc(bytes(sto.used))} of ${esc(bytes(sto.quota))}</p></div></div><div class="sec-body">${meter(c.cloud, t)}${legend}</div>
<div class="sec-foot"><span class="muted">Checked ${esc(when(u?.at ?? t.disk_checked_at))}</span></div></div></section></div>
<div class="stats"><div class="card stat"><p>People</p><b>${seats.used}${seats.max ? ` / ${seats.max}` : ''}</b><span>members and open invites</span></div>
<div class="card stat"><p>AI connected (30 days)</p><b>${u?.ai_people_30d ?? '—'}</b><span>people whose AI used the drive</span></div>
<div class="card stat"><p>Last backup</p><b style="font-size:17px">${esc(when(t.last_backup_at))}</b><span>${esc(dateTime(t.last_backup_at))}</span></div>
<div class="card stat"><p>Last activity</p><b style="font-size:17px">${esc(when(u?.last_activity_at ?? t.last_activity_at))}</b><span>web, AI or mounted drive</span></div></div>`
  return teamShell(c, s, t, role, 'usage', 'Plan & usage', body)
}

// ---------------------------------------------------------------- Settings
function settingsPage(c: RouteCtx) {
  const { t, role, s } = teamFor(c, c.match[1]!)
  const admin = atLeast(role, 'admin'), owner = role === 'owner'
  const fresh = stepUpFresh(s), enrolled = c.cloud.mfa.enabled(s.userId)
  const admins = c.cloud.members.list(t.id).filter((m) => m.role === 'admin')
  const general = `<section class="section"><div class="card"><div class="sec-head"><div><h2>General</h2></div></div><form method="post" action="/t/${esc(t.slug)}/rename">${csrfField(s.csrf)}<div class="sec-body">
<label class="field">Team name<input name="name" required maxlength="80" value="${esc(t.name)}"${admin && enrolled ? '' : ' readonly'}></label>
<label class="field">Address<input value="${esc(c.cloud.url(t))}" readonly><span class="hint">The address never changes (links, connectors and bookmarks keep working).</span></label>
<label class="field">Team ID<input value="${esc(t.public_id)}" readonly></label></div>${admin ? `<div class="sec-foot"><button class="btn btn-dark btn-sm"${enrolled ? '' : ' disabled'}>Save</button></div>` : ''}</form></div></section>`
  const transfer = !owner ? '' : `<section class="section"><div class="card"><div class="sec-head"><div><h2>Transfer ownership</h2><p>To an admin of this team. You stay on as an admin.</p></div></div>
<form method="post" action="/t/${esc(t.slug)}/transfer" data-confirm="Transfer the ownership of ${esc(t.name)}?">${csrfField(s.csrf)}<div class="sec-body">
${admins.length ? `<label class="field">New owner<select name="to">${admins.map((a) => `<option value="${esc(a.public_id)}">${esc(a.name ? `${a.name} — ${a.email}` : a.email)}</option>`).join('')}</select></label>
<label class="field">Your password<input type="password" name="password" required autocomplete="current-password"></label>${totpField(fresh)}` : '<p class="muted">Make someone an admin first (Members).</p>'}</div>
${admins.length ? `<div class="sec-foot"><button class="btn btn-dark btn-sm"${enrolled ? '' : ' disabled'}>Transfer</button></div>` : ''}</form></div></section>`
  const danger = owner ? `<section class="section"><div class="card danger-zone"><div class="sec-head"><div><h2>Delete this team</h2><p>The drive is paused now; after a final encrypted backup it is deleted in ${c.cfg.deleteAfterDays} days. The address is never reused.</p></div></div>
<form method="post" action="/t/${esc(t.slug)}/delete">${csrfField(s.csrf)}<div class="sec-body"><label class="field">Type <b>${esc(t.slug)}</b> to confirm<input name="confirm_slug" required autocomplete="off" data-match="${esc(t.slug)}"></label>${totpField(fresh)}</div>
<div class="sec-foot"><button class="btn btn-danger btn-sm" disabled>Delete team</button></div></form></div></section>`
    : `<section class="section"><div class="card danger-zone"><div class="sec-head"><div><h2>Leave this team</h2><p>You lose access to its drive. An admin can invite you again.</p></div><span class="grow"></span>
<form method="post" action="/t/${esc(t.slug)}/leave" data-confirm="Leave ${esc(t.name)}?">${csrfField(s.csrf)}<button class="btn btn-sm btn-danger">Leave</button></form></div></div></section>`
  return teamShell(c, s, t, role, 'settings', 'Settings', `${general}${transfer}${danger}`)
}

// ---------------------------------------------------------------- Audit
const ACTIONS: Record<string, string> = {
  'team.create': 'Team created', 'team.provisioned': 'Drive started', 'member.invited': 'Invited', 'member.joined': 'Joined', 'member.role_changed': 'Role changed',
  'member.removed': 'Removed', 'member.left': 'Left', 'member.invite_revoked': 'Invite revoked', 'member.invite_resent': 'Invite sent again', 'team.transfer': 'Ownership transferred',
  'team.renamed': 'Renamed', 'team.delete_requested': 'Deletion requested', 'sso.issued': 'Opened the drive', 'team.suspend': 'Paused', 'team.resume': 'Resumed', 'free.woke': 'Woken',
}
function auditPage(c: RouteCtx) {
  const { t, role, s } = teamFor(c, c.match[1]!, 'admin')
  const rows = listAudit(c.cloud.db, { teamId: t.id, limit: 200 })
  const ids = [...new Set(rows.map((r) => /^user:(\d+)$/.exec(r.actor)?.[1]).filter(Boolean).map(Number))]
  const emails = new Map(ids.length ? c.cloud.db.query<{ id: number; email: string }, number[]>(`SELECT id, email FROM users WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids).map((u) => [u.id, u.email]) : [])
  const who = (a: string) => { const m = /^user:(\d+)$/.exec(a); return m ? emails.get(Number(m[1])) ?? a : a.startsWith('admin:') ? 'Trina operations' : a }
  const chain = verifyAudit(c.cloud.db)
  const body = `<section class="section"><div class="card"><div class="sec-head"><div><h2>Console audit log</h2><p>Hash-chained: an edited or deleted entry breaks the chain.</p></div><span class="grow"></span>${chain.ok ? badge(`Chain verified · ${chain.rows} entries`, 'ok') : badge(`Chain broken at ${chain.brokenAt}`, 'danger')}</div>
<table class="table stack audit"><thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th></tr></thead><tbody>${rows.map((r) => `<tr><td class="faint">${esc(dateTime(r.at))}</td><td>${esc(who(r.actor))}</td><td>${esc(ACTIONS[r.action] ?? r.action)}</td><td class="wide"><code>${esc(r.detail === '{}' ? '' : r.detail)}</code></td></tr>`).join('') || '<tr><td colspan="4" class="empty">Nothing yet.</td></tr>'}</tbody></table></div></section>
<p class="hint">What happens inside the drive (files, sharing, AI reads) is in the drive's own audit (Admin → Audit).</p>`
  return teamShell(c, s, t, role, 'audit', 'Audit', body)
}

// ---------------------------------------------------------------- invites (the link in the mail)
function invitePage(c: RouteCtx, token: string, err?: string, status?: number) {
  const inv = c.cloud.invites.peek(token)
  if (!inv) return page('Invite', `<h1>This invite link doesn't work</h1><p>It was used, revoked or has expired. Ask the person who invited you to send it again.</p><p class="alt"><a href="/login">Sign in</a></p>`, { status: 404 })
  const s = c.session
  const head = `<h1>Join ${esc(inv.team.name)}</h1><p>${esc(inv.inviter)} invited <b>${esc(inv.email)}</b> to ${esc(inv.team.name)}'s Trina Drive${inv.role === 'admin' ? ' as an admin' : ''}.</p>${err ? `<div class="flash flash-err" role="alert">${esc(err)}</div>` : ''}`
  if (s) {
    if (s.email.toLowerCase() !== inv.email.toLowerCase()) return page('Invite', `${head}<div class="flash flash-warn">You are signed in as <b>${esc(s.email)}</b>. This invite works only for ${esc(inv.email)}.</div>
<form method="post" action="/logout">${csrfField(s.csrf)}<button class="btn-secondary">Sign out and continue as ${esc(inv.email)}</button></form>`, { status: status ?? 403 })
    return page('Invite', `${head}<form method="post" action="/invite/${esc(token)}/accept">${csrfField(s.csrf)}<button class="btn-primary">Join ${esc(inv.team.name)}</button></form>`, { status })
  }
  const hasAccount = !!c.cloud.db.query('SELECT 1 FROM users WHERE email = ?').get(inv.email)
  if (hasAccount) return page('Invite', `${head}<p>Sign in as ${esc(inv.email)} to join.</p><a class="btn btn-primary btn-block" href="/login?next=${encodeURIComponent(`/invite/${token}`)}&email=${encodeURIComponent(inv.email)}">Sign in to join</a>`, { status })
  return page('Invite', `${head}<form method="post" action="/invite/${esc(token)}/signup"><label>Email<input value="${esc(inv.email)}" readonly></label>
<label>Your name<input name="name" maxlength="80" autocomplete="name" required></label><label>Password<input type="password" name="password" minlength="10" required autocomplete="new-password"><span class="hint">At least 10 characters.</span></label>
<button class="btn-primary">Create account and join</button></form><p class="alt">Already have an account with another address? This invite is for ${esc(inv.email)} only.</p>`, { status })
}

// ---------------------------------------------------------------- JSON shapes
const teamJson = (c: RouteCtx, t: TeamRow, role?: Role) => ({
  id: t.public_id, slug: t.slug, name: t.name, plan: t.plan, status: t.status, state: teamState(c.cloud, t).label, url: c.cloud.url(t), mcp: `${c.cloud.url(t)}/mcp`,
  ...(role ? { role } : {}), grace_until: t.grace_until ? new Date(t.grace_until).toISOString() : null,
  ...(t.plan === 'free' ? { paused: c.cloud.free.isPaused(t), last_activity: t.last_activity_at ? new Date(t.last_activity_at).toISOString() : null } : {}),
})

const memberJson = (m: { public_id: string; email: string; name: string | null; role: Role; created_at: number }, pending: Set<string>) =>
  ({ user: { id: m.public_id, email: m.email, name: m.name ?? '' }, role: m.role, status: pending.has(m.public_id) ? 'removal_pending' : 'active', added_at: m.created_at })

const userIdOf = (c: RouteCtx, pid: string) => {
  const u = /^usr_[0-9a-f]{20}$/.test(pid) ? c.cloud.db.query<{ id: number }, [string]>('SELECT id FROM users WHERE public_id = ?').get(pid) : null
  if (!u) throw new CloudError('not_found', 'not found', 404)
  return u.id
}

// ---------------------------------------------------------------- the operations (pages and API share them)
async function opInvite(c: RouteCtx, t: TeamRow, s: ConsoleSession, b: Record<string, unknown>) {
  const role = b.role === 'admin' ? 'admin' : 'member'
  await needTotp(c, s, b, role === 'admin' ? 'fresh' : 'enrolled')
  return c.cloud.invites.create(t, s.userId, b.emails ?? b.email, role)
}
async function opRole(c: RouteCtx, t: TeamRow, s: ConsoleSession, pid: string, b: Record<string, unknown>) { await needTotp(c, s, b, 'fresh'); return c.cloud.members.setRole(t, s.userId, userIdOf(c, pid), b.role) }
async function opRemove(c: RouteCtx, t: TeamRow, s: ConsoleSession, pid: string, b: Record<string, unknown>) {
  const target = userIdOf(c, pid)
  if (target !== s.userId) await needTotp(c, s, b, 'fresh')
  c.cloud.members.remove(t, s.userId, target)
}
async function opRename(c: RouteCtx, t: TeamRow, s: ConsoleSession, b: Record<string, unknown>) {
  await needTotp(c, s, b, 'enrolled')
  const name = typeof b.name === 'string' ? b.name.trim().replace(/\s+/g, ' ') : ''
  if (!name || name.length > 80 || /[\p{Cc}]/u.test(name)) throw new CloudError('bad_name', 'a team name of 1–80 characters')
  c.cloud.db.query('UPDATE teams SET name = ?, updated_at = ? WHERE id = ?').run(name, Date.now(), t.id)
  audit(c.cloud.db, { actor: `user:${s.userId}`, action: 'team.renamed', teamId: t.id, detail: { from: t.name, to: name } })
}
async function opTransfer(c: RouteCtx, t: TeamRow, s: ConsoleSession, b: Record<string, unknown>) {
  await needTotp(c, s, b, 'fresh')
  const h = c.cloud.db.query<{ password_hash: string }, [number]>('SELECT password_hash FROM users WHERE id = ?').get(s.userId)
  if (!(await verifyPassword(typeof b.password === 'string' ? b.password : '', h?.password_hash))) throw new CloudError('bad_password', 'that password is not right', 401)
  c.cloud.members.transfer(t, s.userId, userIdOf(c, String(b.to ?? b.to_user ?? '')))
}
async function opDelete(c: RouteCtx, t: TeamRow, s: ConsoleSession, b: Record<string, unknown>) {
  if (b.confirm_slug !== t.slug) throw new CloudError('confirm', `type ${t.slug} to confirm`)
  await needTotp(c, s, b, 'fresh')
  await c.cloud.requestDeletion(t, `user:${s.userId}`)
}

/** a page that needs a session: signed out → the sign-in page, then back here */
const signedInPage = (fn: (c: RouteCtx) => Response) => (c: RouteCtx) => c.session ? fn(c) : c.redirect(`/login?next=${encodeURIComponent(c.url.pathname)}`)

const T = '([a-z0-9-]{1,40})'
const P = (s: string) => new RegExp(`^${s}$`)
const ID = '(team_[0-9a-f]{20})'

export const teamRoutes: ControlRoute[] = [
  { method: 'GET', path: '/', fn: teamsPage },
  { method: 'GET', path: '/dashboard', fn: (c) => c.redirect('/') },
  { method: 'GET', path: '/new', fn: newTeamPage },
  { method: 'POST', path: '/new', async fn(c) {
    const s = c.signedIn(); const b = await c.form(); c.csrfOk(b)
    try {
      const r = await createTeam(c, s, b)
      if (r.contact) return shell({ title: 'New team', user: s, csrf: s.csrf, teams: teamsNav(c, s), section: 'new', heading: 'Payment is coming soon', sub: `${b.plan === 'business' ? 'Business' : 'Team'} plan`,
        body: `<div class="card card-pad" style="max-width:640px"><p style="margin-bottom:12px">We are building payment for Team and Business. Until then we set up teams by hand — complimentary during the pilot.</p><p style="margin-bottom:16px">Write to us with the team name and address you want, and how many people will use it.</p>
<a class="btn btn-dark" href="mailto:${esc(c.cfg.opsEmail)}?subject=${encodeURIComponent(`Trina Cloud ${b.plan} team: ${b.name ?? ''}`)}">Email ${esc(c.cfg.opsEmail)}</a></div>` })
      if (r.status === 'provisioning' && r.team) return c.redirect(`/t/${r.team.slug}?ok=created`)
      if (r.status === 'exists') throw new CloudError('exists', 'you already have a free team (one per person); upgrade it for more people or storage', 409)
      return shell({ title: 'New team', user: s, csrf: s.csrf, teams: teamsNav(c, s), section: 'new', heading: 'You are on the waitlist', sub: 'Trina Drive Free',
        body: `<div class="card card-pad" style="max-width:640px"><p>Free teams are by invitation right now. You are on the list for <b>${esc(b.name ?? '')}</b>; we write to ${esc(s.email)} as soon as there is room.</p><p class="muted" style="margin-top:10px">Need it sooner? Write to <a href="mailto:${esc(c.cfg.opsEmail)}">${esc(c.cfg.opsEmail)}</a>.</p></div>` })
    } catch (e) { return rerender(c, '/new', e) }
  } },
  // the old dashboard form and the setup-link button are gone (finding 6: no setup token in SSO mode)
  { method: 'POST', path: '/teams', fn: (c) => c.redirect('/new') },
  { method: 'POST', path: /^\/teams\/(team_[0-9a-f]{20})\/resend-setup$/, fn: () => { throw new CloudError('not_found', 'not found', 404) } },
  { method: 'GET', path: '/api/slug', fn: (c) => {
    c.signedIn()
    c.limited('slug-check', 600, 3600_000)
    const slug = (c.url.searchParams.get('slug') ?? '').trim().toLowerCase()
    const problem = slugProblem(slug) ?? (teamBySlug(c.cloud.db, slug) ? 'that address is taken' : null)
    return c.json({ ok: !problem, slug, problem })
  } },
  // pages of one team
  { method: 'GET', path: P(`/t/${T}`), fn: signedInPage(overviewPage) },
  { method: 'GET', path: P(`/t/${T}/members`), fn: signedInPage(membersPage) },
  { method: 'GET', path: P(`/t/${T}/usage`), fn: signedInPage(usagePage) },
  { method: 'GET', path: P(`/t/${T}/settings`), fn: signedInPage(settingsPage) },
  { method: 'GET', path: P(`/t/${T}/audit`), fn: signedInPage(auditPage) },
  { method: 'POST', path: P(`/t/${T}/invite`), fn: (c) => { const back = `/t/${c.match[1]}/members`; return act(c, back, async (b, s) => { const { t } = teamFor(c, c.match[1]!, 'admin'); await opInvite(c, t, s, b); return 'invited' }) } },
  { method: 'POST', path: P(`/t/${T}/invites/(inv_\\d{12})/resend`), fn: (c) => act(c, `/t/${c.match[1]}/members`, async (_b, s) => { const { t } = teamFor(c, c.match[1]!, 'admin'); await needTotp(c, s, {}, 'enrolled'); await c.cloud.invites.resend(t, s.userId, c.match[2]!); return 'resent' }) },
  { method: 'POST', path: P(`/t/${T}/invites/(inv_\\d{12})/revoke`), fn: (c) => act(c, `/t/${c.match[1]}/members`, async (_b, s) => { const { t } = teamFor(c, c.match[1]!, 'admin'); await needTotp(c, s, {}, 'enrolled'); c.cloud.invites.revoke(t, s.userId, c.match[2]!); return 'revoked' }) },
  { method: 'POST', path: P(`/t/${T}/members/(usr_[0-9a-f]{20})/role`), fn: (c) => act(c, `/t/${c.match[1]}/members`, async (b, s) => { const { t } = teamFor(c, c.match[1]!, 'admin'); await opRole(c, t, s, c.match[2]!, b); return 'role' }) },
  { method: 'POST', path: P(`/t/${T}/members/(usr_[0-9a-f]{20})/remove`), fn: (c) => act(c, `/t/${c.match[1]}/members`, async (b, s) => { const { t } = teamFor(c, c.match[1]!, 'admin'); await opRemove(c, t, s, c.match[2]!, b); return 'removed' }) },
  { method: 'POST', path: P(`/t/${T}/leave`), fn: (c) => act(c, '/', (_b, s) => { const { t } = teamFor(c, c.match[1]!); c.cloud.members.remove(t, s.userId, s.userId); return '/?ok=left' }) },
  { method: 'POST', path: P(`/t/${T}/rename`), fn: (c) => act(c, `/t/${c.match[1]}/settings`, async (b, s) => { const { t } = teamFor(c, c.match[1]!, 'admin'); await opRename(c, t, s, b); return 'renamed' }) },
  { method: 'POST', path: P(`/t/${T}/transfer`), fn: (c) => act(c, `/t/${c.match[1]}/settings`, async (b, s) => { const { t } = teamFor(c, c.match[1]!, 'owner'); await opTransfer(c, t, s, b); return 'transferred' }) },
  { method: 'POST', path: P(`/t/${T}/delete`), fn: (c) => act(c, `/t/${c.match[1]}/settings`, async (b, s) => { const { t } = teamFor(c, c.match[1]!, 'owner'); await opDelete(c, t, s, b); return '/?ok=delete_requested' }) },
  { method: 'POST', path: P(`/t/${T}/wake`), fn: (c) => act(c, `/t/${c.match[1]}`, (_b, s) => { const { t } = teamFor(c, c.match[1]!); c.cloud.free.requestWake(t, `user:${s.userId}`); return `/wake/${t.slug}` }) },
  { method: 'POST', path: P(`/t/${T}/sync`), fn: (c) => act(c, `/t/${c.match[1]}/members`, (_b, s) => { const { t } = teamFor(c, c.match[1]!, 'admin'); c.cloud.enqueue('sync_members', t.id); audit(c.cloud.db, { actor: `user:${s.userId}`, action: 'sync.retry_requested', teamId: t.id }); return 'synced' }) },
  // invites (the mailed link)
  { method: 'GET', path: /^\/invite\/([A-Za-z0-9_-]{20,100})$/, fn: (c) => invitePage(c, c.match[1]!) },
  { method: 'POST', path: /^\/invite\/([A-Za-z0-9_-]{20,100})\/accept$/, async fn(c) {
    const s = c.signedIn(); const b = await c.form(); c.csrfOk(b)
    try { const t = c.cloud.invites.accept(c.match[1], s.userId); return c.redirect(`/t/${t.slug}?ok=joined`) } catch (e) {
      if (e instanceof CloudError && e.status !== 404) return invitePage(c, c.match[1]!, e.message, e.status)
      throw e
    }
  } },
  { method: 'POST', path: /^\/invite\/([A-Za-z0-9_-]{20,100})\/signup$/, async fn(c) {
    c.limited('signup', 10, 3600_000)
    const b = await c.form()
    try {
      const r = await c.cloud.invites.signupAndAccept(c.match[1], b.name, b.password)
      const l = c.cloud.startSession(r.userId, ['pwd'], c.ip)
      return c.redirect(`/t/${r.team.slug}?ok=joined`, { 'set-cookie': sessionCookie(l.cookie, 7 * 86400, c.cfg.controlUrl.startsWith('https://')) })
    } catch (e) { if (e instanceof CloudError && e.status !== 404) return invitePage(c, c.match[1]!, e.message, e.status); throw e }
  } },

  // ---- JSON API (plan 2.3; session + CSRF + Origin on every change)
  { method: 'GET', path: '/api/teams', fn: (c) => { const s = c.signedIn(); return c.json({ teams: c.cloud.members.teamsOf(s.userId).map((t) => teamJson(c, t, t.role)) }) } },
  { method: 'POST', path: '/api/teams', async fn(c) {
    const { s, body } = await apiBody(c)
    if (body.plan === 'free') {
      const r = await createTeam(c, s, body)
      return c.json({ status: r.status, team: r.team ? teamJson(c, r.team, 'owner') : undefined }, r.status === 'provisioning' ? 201 : 200)
    }
    // Team/Business without payment: a team waiting for payment (operations make complimentary ones; plan 10.1)
    const t = await c.cloud.createTeam(s.userId, body.name, body.slug || suggestSlug(body.name ?? ''), body.plan)
    return c.json({ team: teamJson(c, t, 'owner') }, 201)
  } },
  { method: 'GET', path: P(`/api/teams/${ID}`), fn: (c) => {
    const { t, role } = teamFor(c, c.match[1]!)
    const sto = storageOf(c.cloud, t)
    return c.json({ ...teamJson(c, t, role), usage: sto.usage, storage: { used_bytes: sto.used, quota_bytes: sto.quota }, people: c.cloud.members.seats(t), last_backup_at: t.last_backup_at })
  } },
  { method: 'PATCH', path: P(`/api/teams/${ID}`), async fn(c) { const { s, body } = await apiBody(c); const { t } = teamFor(c, c.match[1]!, 'admin'); await opRename(c, t, s, body); return c.json({ ok: true }) } },
  { method: 'DELETE', path: P(`/api/teams/${ID}`), async fn(c) { const { s, body } = await apiBody(c); const { t } = teamFor(c, c.match[1]!, 'owner'); await opDelete(c, t, s, body); return c.json({ ok: true, status: 'deletion_requested' }) } },
  { method: 'GET', path: P(`/api/teams/${ID}/members`), fn: (c) => {
    const { t, role } = teamFor(c, c.match[1]!)
    const pending = new Set(c.cloud.sync.pendingRemovals(t.id))
    return c.json({
      members: c.cloud.members.list(t.id).map((m) => memberJson(m, pending)),
      invites: atLeast(role, 'admin') ? c.cloud.invites.open(t.id).map((i) => ({ id: invitePublicId(i.id), email: i.email, role: i.role, expires_at: i.expires_at, via: i.via })) : [],
      limit: c.cloud.members.seats(t), sync: { in_sync: !c.cloud.sync.behind(t), failing_since: t.sync_failing_since, error: atLeast(role, 'admin') ? t.sync_error : undefined },
    })
  } },
  { method: 'POST', path: P(`/api/teams/${ID}/invites`), async fn(c) { const { s, body } = await apiBody(c); const { t } = teamFor(c, c.match[1]!, 'admin'); return c.json({ invites: await opInvite(c, t, s, body) }, 201) } },
  { method: 'DELETE', path: P(`/api/teams/${ID}/invites/(inv_\\d{12})`), async fn(c) { const { s } = await apiBody(c); const { t } = teamFor(c, c.match[1]!, 'admin'); await needTotp(c, s, {}, 'enrolled'); c.cloud.invites.revoke(t, s.userId, c.match[2]!); return c.json({ ok: true }) } },
  { method: 'POST', path: P(`/api/teams/${ID}/invites/(inv_\\d{12})/resend`), async fn(c) { const { s } = await apiBody(c); const { t } = teamFor(c, c.match[1]!, 'admin'); await needTotp(c, s, {}, 'enrolled'); await c.cloud.invites.resend(t, s.userId, c.match[2]!); return c.json({ ok: true }) } },
  { method: 'PATCH', path: P(`/api/teams/${ID}/members/(usr_[0-9a-f]{20})`), async fn(c) { const { s, body } = await apiBody(c); const { t } = teamFor(c, c.match[1]!, 'admin'); await opRole(c, t, s, c.match[2]!, body); return c.json({ ok: true }) } },
  { method: 'DELETE', path: P(`/api/teams/${ID}/members/(usr_[0-9a-f]{20})`), async fn(c) {
    const { s, body } = await apiBody(c)
    const self = c.match[2] === (s.publicId ?? userPublicId(c.cloud, s.userId))
    const { t } = teamFor(c, c.match[1]!, self ? 'member' : 'admin')
    await opRemove(c, t, s, c.match[2]!, body)
    return c.json({ ok: true })
  } },
  { method: 'POST', path: P(`/api/teams/${ID}/transfer`), async fn(c) { const { s, body } = await apiBody(c); const { t } = teamFor(c, c.match[1]!, 'owner'); await opTransfer(c, t, s, body); return c.json({ ok: true }) } },
  { method: 'GET', path: P(`/api/teams/${ID}/audit`), fn: (c) => {
    const { t } = teamFor(c, c.match[1]!, 'admin')
    return c.json({ chain: verifyAudit(c.cloud.db), entries: listAudit(c.cloud.db, { teamId: t.id, limit: Math.min(1000, Number(c.url.searchParams.get('limit') ?? 100) || 100) }).map((r) => ({ at: r.at, actor: r.actor, action: r.action, detail: JSON.parse(r.detail) })) })
  } },
  { method: 'POST', path: '/api/invites/accept', async fn(c) { const { s, body } = await apiBody(c); const t = c.cloud.invites.accept(body.token, s.userId); return c.json({ ok: true, team: teamJson(c, t, c.cloud.members.role(t.id, s.userId) ?? 'member') }) } },
]

