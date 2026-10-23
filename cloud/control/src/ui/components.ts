// Small pieces of console HTML: status badges, plan names, sizes, dates, copy fields, form bits.
import type { Cloud } from '../cloud'
import type { TeamRow } from '../db'
import { planOf } from '../plans'
import { esc, icon } from './layout'

export type Tone = 'ok' | 'warn' | 'danger' | 'muted' | 'accent'

/** The team's state as people say it (plan 2.5: Running ok, Paused / Payment needed warn, Failed danger). */
export function teamState(cloud: Cloud, t: TeamRow): { label: string; tone: Tone; starting?: boolean; note?: string } {
  if (cloud.free.isPaused(t)) return { label: 'Paused', tone: 'warn', note: 'Paused after a week without activity. Nothing is deleted; wake it to use it.' }
  switch (t.status) {
    case 'active': return { label: 'Running', tone: 'ok' }
    case 'provisioning': return { label: 'Starting', tone: 'warn', starting: true, note: t.waiting_since ? 'A server is being prepared for it (a few minutes).' : 'Usually a minute or two.' }
    case 'pending_payment': return { label: 'Payment needed', tone: 'warn', note: 'Payment for Team and Business is coming soon — write to us and we set it up.' }
    case 'past_due': return { label: 'Payment needed', tone: 'warn', note: 'The last payment failed; it keeps running for now.' }
    case 'suspended': return { label: 'Paused', tone: 'warn', note: t.suspend_reason === 'deletion requested by the owner' ? `Deletion requested; deleted on ${t.delete_after ? new Date(t.delete_after).toISOString().slice(0, 10) : 'schedule'}.` : 'Paused. Nothing is deleted.' }
    case 'failed': return { label: 'Failed', tone: 'danger', note: 'It did not start; we have been alerted.' }
    case 'deleting': return { label: 'Deleting', tone: 'muted' }
    default: return { label: t.status, tone: 'muted' }
  }
}

export const badge = (label: string, tone: Tone, o: { starting?: boolean; dot?: boolean } = {}) =>
  `<span class="badge b-${tone}${o.starting ? ' b-starting' : ''}${o.dot === false ? ' nodot' : ''}">${esc(label)}</span>`

export const stateBadge = (cloud: Cloud, t: TeamRow) => { const s = teamState(cloud, t); return badge(s.label, s.tone, { starting: s.starting }) }

export function planName(t: Pick<TeamRow, 'plan' | 'sub_status'>): string {
  const name = t.plan === 'free' ? 'Free' : t.plan === 'business' ? 'Business' : 'Team'
  return t.sub_status === 'complimentary' ? `${name} · complimentary` : name
}

export const roleBadge = (role: string) => badge(role === 'owner' ? 'Owner' : role === 'admin' ? 'Admin' : 'Member', role === 'owner' ? 'accent' : 'muted', { dot: false })

export function bytes(n: number | null | undefined): string {
  if (n == null) return '—'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0, v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`
}

export function when(ms: number | null | undefined): string {
  if (!ms) return '—'
  const d = Date.now() - ms
  if (d < 60_000 && d > -60_000) return 'just now'
  if (d > 0 && d < 3600_000) return `${Math.round(d / 60_000)} min ago`
  if (d > 0 && d < 86400_000) return `${Math.round(d / 3600_000)} h ago`
  if (d > 0 && d < 30 * 86400_000) return `${Math.round(d / 86400_000)} days ago`
  return new Date(ms).toISOString().slice(0, 10)
}

export const dateTime = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—')

export const copyField = (value: string, label = 'Copy') =>
  `<span class="copy"><code>${esc(value)}</code><button type="button" class="icon-btn" data-copy="${esc(value)}" aria-label="${esc(label)}">${icon('copy')}</button></span>`

export const csrfField = (csrf: string) => `<input type="hidden" name="csrf" value="${esc(csrf)}">`

/** The authenticator-code input the sensitive forms carry (empty = the code typed in the last 5 minutes counts). */
export const totpField = (fresh: boolean) => fresh
  ? '<p class="hint" style="margin:0 0 12px">Two-step verification confirmed a moment ago.</p>'
  : '<label class="field">Authenticator code<input name="totp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9a-zA-Z -]{6,12}" required placeholder="123 456"><span class="hint">From your authenticator app (or a recovery code). Asked again after 5 minutes.</span></label>'

export function storageOf(cloud: Cloud, t: TeamRow) {
  const u = cloud.db.query<{ at: number; people: number | null; ai_people_30d: number | null; files_bytes: number | null; trash_bytes: number | null; versions_bytes: number | null; quota_bytes: number | null; last_activity_at: number | null }, [number]>('SELECT * FROM team_usage WHERE team_id = ?').get(t.id)
  const plan = planOf(t.plan)
  const quota = u?.quota_bytes ?? plan.storageGb * 1024 ** 3
  const used = u ? (u.files_bytes ?? 0) + (u.trash_bytes ?? 0) + (u.versions_bytes ?? 0) : t.disk_bytes
  return { usage: u ?? null, quota, used, plan }
}

export function meter(cloud: Cloud, t: TeamRow): string {
  const s = storageOf(cloud, t)
  const pct = (n: number | null | undefined) => `${Math.min(100, Math.max(0, ((n ?? 0) / Math.max(1, s.quota)) * 100)).toFixed(2)}%`
  const bars = s.usage
    ? `<i class="m-files" style="width:${pct(s.usage.files_bytes)}"></i><i class="m-versions" style="width:${pct(s.usage.versions_bytes)}"></i><i class="m-trash" style="width:${pct(s.usage.trash_bytes)}"></i>`
    : `<i class="m-files" style="width:${pct(s.used)}"></i>`
  return `<div class="meter" role="img" aria-label="${esc(`${bytes(s.used)} of ${bytes(s.quota)}`)}">${bars}</div>`
}
