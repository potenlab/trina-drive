// The approval inbox (plan 5.2, R8). Everything a file holds is shown as plain text (React text nodes inside <pre>),
// never HTML. The agent's stated reason is folded away and labelled as its claim. Every approve click asks for a
// fresh passkey (or, on a LAN-only server, an authenticator code) bound to that request and version.
import { useState } from 'react'
import { api, get } from '../api'
import { go, useSession } from '../App'
import { fmtDate } from '../i18n'
import { getPasskey } from '../webauthn'
import { Badge, ErrorLine, Loading, Page, useAction, useLoad } from '../ui'
import { at, type ApKey } from './approve-i18n'
import './approve.css'
import { st } from '../drive/SkillsText'

interface StepUp { method: 'passkey' | 'totp' | null; missing: 'passkey' | 'totp' | null; lan_only: boolean; public_url: string | null }
interface Item { id: number; status: string; created_at: number; expires_at: number; decided_at: number | null; target: string; name: string; size: number; gain: number; can_decide: boolean; mine: boolean; requester: string; via: 'agent' | 'web'; overwrite?: boolean }
interface Detail extends Item {
  sha256: string; draft_version: number; draft_path: string; decided_by: string | null; decision_reason: string | null; approvers_exist: boolean | null
  sources: ({ folder: string; strong: boolean } | string)[]; hidden_sources: number; gainers: { count: number; names: string[] } | null
  requester_token?: string | null; agent_claim: string | null; preview: { text: string; truncated: boolean; binary: boolean } | null; diff: string | null
  step_up: StepUp
}

const statusKind = (s: string) => s === 'pending' ? 'accent' : s === 'approved' ? 'ok' : s === 'closed' || s === 'failed' || s === 'stale' ? 'danger' : 'neutral'
export const StatusBadge = ({ s }: { s: string }) => <Badge kind={statusKind(s)}>{at(`ap_status_${s}` as ApKey)}</Badge>

export function Approvals({ id }: { id?: number }) {
  if (id) return <ApprovalPage id={id} />
  return <ApprovalList />
}

function StepUpNote({ s }: { s: StepUp }) {
  if (s.missing) return <p className="warn">{at(s.missing === 'passkey' ? 'ap_need_passkey' : 'ap_need_totp')} <a href="#/settings">→</a></p>
  if (s.lan_only) return <p className="muted small">{at('ap_lan_only')}</p>
  // passkeys belong to the public address: on another address (a LAN one) the browser refuses them
  if (s.public_url && s.public_url !== window.location.origin) return <p className="warn">{at('ap_other_origin', { url: s.public_url })} <a href={s.public_url + window.location.hash}>→</a></p>
  return null
}

function ApprovalList() {
  const { data, error } = useLoad(() => get<{ items: Item[]; others_pending: number; step_up: StepUp }>('/approvals'))
  return (
    <Page title={at('ap_title')}>
      <p className="muted">{at('ap_intro')}</p>
      <ErrorLine error={error} />
      {!data ? <Loading /> : <>
        <StepUpNote s={data.step_up} />
        {data.items.length === 0 && <p className="muted">{at('ap_empty')}</p>}
        <ul className="rows">
          {data.items.map((x) => (
            <li key={x.id}>
              <div className="row-main">
                <a href={`#/approvals/${x.id}`}><strong className="mono">{x.target}/{x.name}</strong></a> <StatusBadge s={x.status} />{x.overwrite && <> <Badge kind="warn">{at('ap_overwrite')}</Badge></>}
                {x.mine && <> <Badge>{at('ap_mine')}</Badge></>}
                <div className="muted small">
                  {at('ap_by', { name: x.requester })} {at(x.via === 'agent' ? 'ap_via_agent_short' : 'ap_via_web')} · {fmtDate(x.created_at)}
                  {x.status === 'pending' && <> · {at('ap_expires', { when: fmtDate(x.expires_at) })}</>}
                  {x.gain > 0 && <> · {at('ap_gain_n', { n: x.gain })}</>}
                </div>
              </div>
            </li>
          ))}
        </ul>
        {data.others_pending > 0 && <p className="card muted">{at('ap_others', { n: data.others_pending })}</p>}
      </>}
      <SkillChanges />
    </Page>
  )
}

/** Pending team-skill versions this person may decide (GET /api/skills, workstream I1); each opens #/skills/v/<id>. */
function SkillChanges() {
  const { data } = useLoad(() => get<{ skills: SkillItem[] }>('/skills').catch(() => ({ skills: [] })))
  const mine = (data?.skills ?? []).filter((s) => s.pending?.can_decide)
  if (!mine.length) return null
  return (
    <section className="ap-skills">
      <h2>{at('ap_skills')}</h2>
      <p className="muted small">{at('ap_skills_help')}</p>
      <ul className="rows">
        {mine.map((s) => (
          <li key={s.qname}>
            <div className="row-main">
              <a href={`#/skills/v/${s.pending!.id}`}><strong className="mono">{s.qname}</strong></a> <Badge kind="accent">{st(s.status === 'new' ? 'sk_status_new' : 'sk_status_changed')}</Badge>
              {s.pending!.has_scripts && <> <Badge kind="warn" title={st('sk_scripts')}>{'</>'}</Badge></>}
              <div className="muted small">{st('sk_editors', { names: [...new Set(s.pending!.editors.map((e) => e ?? st('sk_editor_unknown')))].join(', ') })} · {fmtDate(s.pending!.proposed_at)}</div>
            </div>
            <div className="row-actions"><a className="btn small primary" href={`#/skills/v/${s.pending!.id}`}>{st('sk_review')}</a></div>
          </li>
        ))}
      </ul>
    </section>
  )
}
interface SkillItem { qname: string; status: string; pending: { id: number; can_decide: boolean; editors: (string | null)[]; proposed_at: number; has_scripts: boolean } | null }

function ApprovalPage({ id }: { id: number }) {
  const { refresh } = useSession()
  const { data, error, reload } = useLoad(() => get<Detail>(`/approvals/${id}`), [id])
  const a = useAction()
  const [code, setCode] = useState('')
  const [reason, setReason] = useState('')
  const [rejecting, setRejecting] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  if (error) return <Page title={at('ap_title')}><ErrorLine error={error} /><a href="#/approvals">← {at('ap_back')}</a></Page>
  if (!data) return <Loading />
  const d = data
  const pending = d.status === 'pending'

  // one click = one step-up for this request and this version, then the approval that uses it up
  const approve = () => a.run(async () => {
    const o = await api<{ method: 'passkey' | 'totp'; options?: unknown }>('POST', `/approvals/${id}/step-up/options`, { sha256: d.sha256 })
    const proof = o.method === 'passkey' ? { response: await getPasskey(o.options) } : { code }
    const s = await api<{ assertion: string }>('POST', `/approvals/${id}/step-up`, { sha256: d.sha256, ...proof })
    const r = await api<{ path: string }>('POST', `/approvals/${id}/approve`, { sha256: d.sha256, assertion: s.assertion })
    setCode(''); setDone(at('ap_done', { path: r.path })); reload(); refresh()
  })
  const reject = () => a.run(async () => {
    await api('POST', `/approvals/${id}/reject`, { reason })
    setRejecting(false); reload(); refresh()
  })

  return (
    <Page title={`${d.target}/${d.name}`} actions={<><StatusBadge s={d.status} />{d.overwrite && <Badge kind="warn">{at('ap_overwrite')}</Badge>}</>}>
      <p className="crumbs"><a href="#/approvals">← {at('ap_back')}</a></p>
      <section className="card">
        <p>{at('ap_by', { name: d.requester })} {d.via === 'agent' ? at('ap_via_agent', { token: d.requester_token ?? '…' }) : at('ap_via_web')} · {fmtDate(d.created_at)}
          {pending && <> · {at('ap_expires', { when: fmtDate(d.expires_at) })}</>}</p>
        <p className="muted small mono">/drafts/{d.draft_path} · v{d.draft_version} · {d.size} B · {at('ap_hash')} {d.sha256.slice(0, 16)}…</p>
        {d.decided_by && <p className="small">{at('ap_decided_by', { name: d.decided_by })}{d.decided_at ? ` · ${fmtDate(d.decided_at)}` : ''}{d.decision_reason ? ` — ${d.decision_reason}` : ''}</p>}
        {pending && d.approvers_exist === false && <p className="warn">{at('ap_no_approver')}</p>}
        {done && <p className="ok">{done}</p>}
      </section>

      <section className="card">
        <h2>{at('ap_gain')}</h2>
        <p>{at('ap_gain_n', { n: d.gainers?.count ?? d.gain })}</p>
        {d.gainers && d.gainers.names.length > 0 && <p className="small">{d.gainers.names.join(', ')}</p>}
        <h2>{at('ap_sources')}</h2>
        <p className="small">{d.sources.map((s) => typeof s === 'string' ? s : s.folder).join(', ') || '—'}{d.hidden_sources > 0 && <span className="muted"> {at('ap_hidden_sources', { n: d.hidden_sources })}</span>}</p>
      </section>

      {d.agent_claim && (
        <details className="card">
          <summary>{at(d.via === 'agent' ? 'ap_claim_agent' : 'ap_claim_web')}</summary>
          <pre className="plain-text">{d.agent_claim}</pre>
        </details>
      )}

      {d.preview && (
        <section className="card">
          <h2>{at('ap_diff')}</h2>
          {d.preview.binary ? <p className="muted">{at('ap_binary')}</p> : <pre className="plain-text diff">{d.diff}</pre>}
          {d.preview.truncated && <p className="muted small">{at('ap_truncated')}</p>}
        </section>
      )}

      {pending && d.can_decide && (
        <section className="card highlight">
          <StepUpNote s={d.step_up} />
          <p className="muted small">{at('ap_step_up_each')}</p>
          <ErrorLine error={a.error} />
          <div className="row-actions" style={{ justifyContent: 'flex-start' }}>
            {d.step_up.method === 'totp' && (
              <label>{at('ap_code')}<input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" value={code} onChange={(e) => setCode(e.target.value)} /></label>
            )}
            {d.step_up.method && <button className="btn primary" disabled={a.busy || (d.step_up.method === 'totp' && code.replace(/\s/g, '').length !== 6)} onClick={approve}>
              {at(d.step_up.method === 'passkey' ? 'ap_approve' : 'ap_approve_code')}</button>}
            <button className="btn danger" disabled={a.busy} onClick={() => setRejecting(!rejecting)}>{at('ap_reject')}</button>
          </div>
          {rejecting && (
            <form onSubmit={(e) => { e.preventDefault(); reject() }}>
              <label>{at('ap_reject_reason')}<input value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={2000} /></label>
              <button className="btn small danger" disabled={a.busy || !reason.trim()}>{at('ap_reject')}</button>
            </form>
          )}
        </section>
      )}
      {pending && !d.can_decide && d.mine && (
        <section className="card">
          <ErrorLine error={a.error} />
          <button className="btn small" disabled={a.busy} onClick={() => a.run(async () => { await api('POST', `/approvals/${id}/reject`, {}); reload() })}>{at('ap_cancel')}</button>
        </section>
      )}
      {!d.can_decide && !d.mine && pending && <p className="muted">{at('ap_cannot_decide')}</p>}
      <p><button className="btn small ghost" onClick={() => go('/approvals')}>← {at('ap_back')}</button></p>
    </Page>
  )
}
