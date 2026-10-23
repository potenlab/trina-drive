// Team skills (workstream I1): the skills this person may see — status, who approved which version, how often AI used
// it this week, a zip for claude.ai / ChatGPT — and the review of a pending version: the diff against the approved
// one, then approve (a fresh passkey, or an authenticator code on a LAN-only server, bound to that version and digest)
// or reject. Admins make folders skill libraries here. Every file's text is shown as React text inside <pre>.
// Routes: #/skills and #/skills/v/<version id> (App.tsx mounts <Skills route={route} />).
import { useState } from 'react'
import { api, get } from '../api'
import { useSession } from '../App'
import { fmtDate, useLocale } from '../i18n'
import { Badge, ErrorLine, Loading, Page, useAction, useLoad } from '../ui'
import { getPasskey } from '../webauthn'
import '../pages/approve.css'
import { st, type SkKey } from './SkillsText'

interface StepUp { method: 'passkey' | 'totp' | null; missing: 'passkey' | 'totp' | null; lan_only: boolean; public_url: string | null }
interface Version { id: number; digest: string; status: string; proposed_at: number; decided_at: number | null; decided_by: string | null; reason: string | null; editors: (string | null)[]; files: number; has_scripts: boolean }
interface Item {
  qname: string; name: string; library: { id: number; slug: string; vpath: string | null }; description: string | null
  status: 'active' | 'changed' | 'new' | 'error' | 'rejected' | 'missing'; problem: string | null
  approved: Version | null; pending: (Version & { can_decide: boolean }) | null; served_to_ai: boolean; uses_7d: number
}
interface Library { id: number; slug: string; vpath: string | null; by: string | null; at: number; no_ai: boolean }
interface View { skills: Item[]; libraries: Library[]; can_designate: boolean; step_up: StepUp }
interface FileChange { path: string; change: 'added' | 'removed' | 'changed' | 'same'; size: number; diff: string | null; binary: boolean }
interface Detail extends Omit<Version, 'files'> {
  qname: string; name: string; description: string; frontmatter: Record<string, unknown>; warnings: string[]; approved: Version | null
  files: FileChange[]; can_decide: boolean; why_not: string | null; approvers_exist: boolean | null; step_up: StepUp
}

const STATUS_KIND: Record<Item['status'], 'ok' | 'accent' | 'warn' | 'danger' | 'neutral'> = { active: 'ok', changed: 'accent', new: 'accent', error: 'danger', rejected: 'neutral', missing: 'warn' }
const short = (sha: string) => sha.slice(0, 12)
const editorsText = (e: (string | null)[]) => [...new Set(e.map((x) => x ?? st('sk_editor_unknown')))].join(', ')

export function Skills({ route }: { route: string }) {
  useLocale()
  const m = /^\/skills\/v\/(\d+)$/.exec(route)
  return m ? <VersionPage id={Number(m[1])} /> : <SkillList />
}

function SkillList() {
  const { data, error, reload } = useLoad(() => get<View>('/skills'))
  const libs = new Map((data?.libraries ?? []).map((l) => [l.id, l]))
  const groups = new Map<number, Item[]>()
  for (const s of data?.skills ?? []) groups.set(s.library.id, [...(groups.get(s.library.id) ?? []), s])
  return (
    <Page title={st('sk_title')}>
      <p className="muted">{st('sk_intro')}</p>
      <ErrorLine error={error} />
      {!data ? <Loading /> : <>
        {data.libraries.length === 0 && <p className="card muted">{st(data.can_designate ? 'sk_no_libraries_admin' : 'sk_no_libraries')}</p>}
        {data.libraries.length > 0 && data.skills.length === 0 && <p className="muted">{st('sk_empty')}</p>}
        {[...groups.entries()].map(([id, items]) => {
          const lib = libs.get(id)
          return (
            <section key={id} className="card">
              <h2 className="mono" style={{ fontSize: '1rem', margin: '0 0 .25rem' }}>{lib?.vpath ?? items[0]!.library.vpath}</h2>
              <p className="muted small" style={{ margin: '0 0 .5rem' }}>{lib?.slug}/…{lib?.no_ai && <> · <Badge kind="warn">{st('sk_lib_no_ai')}</Badge></>}</p>
              <ul className="rows">{items.map((s) => <SkillRow key={s.qname} s={s} />)}</ul>
            </section>
          )
        })}
        <p className="muted small">{st('sk_connect')}</p>
        <Libraries data={data} reload={reload} />
      </>}
    </Page>
  )
}

function SkillRow({ s }: { s: Item }) {
  return (
    <li>
      <div className="row-main">
        <strong className="mono">{s.qname}</strong> <Badge kind={STATUS_KIND[s.status]}>{st(`sk_status_${s.status}` as SkKey)}</Badge>
        {(s.approved?.has_scripts || s.pending?.has_scripts) && <> <Badge kind="warn" title={st('sk_scripts')}>{'</>'}</Badge></>}
        {s.description && <div className="small">{s.description}</div>}
        <div className="muted small">
          {s.approved ? <>{st('sk_approved_by', { name: s.approved.decided_by ?? '?', when: fmtDate(s.approved.decided_at) })} · <span className="mono">sha256 {short(s.approved.digest)}</span> · {st('sk_uses', { n: s.uses_7d })}</>
            : st('sk_never_approved')}
        </div>
        {s.pending && <div className="muted small">{st('sk_editors', { names: editorsText(s.pending.editors) })} · {fmtDate(s.pending.proposed_at)}</div>}
        {s.problem && <div className="error small">{st('sk_problem', { error: s.problem })}</div>}
        {s.approved && !s.served_to_ai && s.status !== 'missing' && <div className="muted small">{st('sk_not_served')}</div>}
      </div>
      <div className="row-actions">
        {s.pending && <a className={`btn small${s.pending.can_decide ? ' primary' : ''}`} href={`#/skills/v/${s.pending.id}`}>{st(s.pending.can_decide ? 'sk_review' : 'sk_view')}</a>}
        {s.approved && <a className="btn small" href={`/api/skills/download?name=${encodeURIComponent(s.qname).replace('%2F', '/')}`} download>{st('sk_download')}</a>}
      </div>
    </li>
  )
}

function Libraries({ data, reload }: { data: View; reload: () => void }) {
  const a = useAction()
  const [path, setPath] = useState('')
  const [slug, setSlug] = useState('')
  if (!data.can_designate && data.libraries.length === 0) return null
  return (
    <section className="card">
      <h2>{st('sk_libraries')}</h2>
      {data.libraries.length > 0 && (
        <ul className="rows">
          {data.libraries.map((l) => (
            <li key={l.id}>
              <div className="row-main"><span className="mono">{l.vpath}</span> → <span className="mono">{l.slug}/…</span>
                <div className="muted small">{l.by ? st('sk_lib_by', { name: l.by }) + ' · ' : ''}{fmtDate(l.at)}</div></div>
              {data.can_designate && <div className="row-actions"><button className="btn small danger" disabled={a.busy}
                onClick={() => { if (confirm(st('sk_remove_confirm', { path: l.vpath ?? l.slug }))) a.run(async () => { await api('DELETE', `/skills/libraries/${l.id}`); reload() }) }}>{st('sk_remove')}</button></div>}
            </li>
          ))}
        </ul>
      )}
      {data.can_designate && (
        <form className="promote-form" onSubmit={(e) => { e.preventDefault(); a.run(async () => { await api('PUT', '/skills/libraries', { path, slug: slug || undefined }); setPath(''); setSlug(''); reload() }) }}>
          <h3 style={{ margin: '.5rem 0 0', fontSize: '.95rem' }}>{st('sk_make')}</h3>
          <p className="muted small" style={{ margin: 0 }}>{st('sk_make_help')}</p>
          <label>{st('sk_folder')}<input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/Skills" required /></label>
          <label>{st('sk_slug')}<input value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} placeholder="team" pattern="[a-z0-9]+(-[a-z0-9]+)*" maxLength={63} /></label>
          <ErrorLine error={a.error} />
          <div><button className="btn primary" disabled={a.busy || !path.trim()}>{st('sk_make_go')}</button></div>
        </form>
      )}
    </section>
  )
}

function StepUpNote({ s }: { s: StepUp }) {
  if (s.missing) return <p className="warn">{st(s.missing === 'passkey' ? 'sk_need_passkey' : 'sk_need_totp')} <a href="#/settings">→</a></p>
  if (s.public_url && s.public_url !== window.location.origin) return <p className="warn"><a href={s.public_url + window.location.hash}>{s.public_url}</a></p>
  return null
}

function VersionPage({ id }: { id: number }) {
  const { refresh } = useSession()
  const { data, error, reload } = useLoad(() => get<Detail>(`/skills/versions/${id}`), [id])
  const a = useAction()
  const [code, setCode] = useState('')
  const [reason, setReason] = useState('')
  const [rejecting, setRejecting] = useState(false)
  const [done, setDone] = useState(false)
  const back = <p className="crumbs"><a href="#/skills">← {st('sk_back')}</a></p>
  if (error) return <Page title={st('sk_title')}>{back}<ErrorLine error={error} /></Page>
  if (!data) return <Loading />
  const d = data
  const pending = d.status === 'pending'
  const files = d.files

  const approve = () => a.run(async () => {
    const o = await api<{ method: 'passkey' | 'totp'; options?: unknown }>('POST', `/skills/versions/${id}/step-up/options`, { digest: d.digest })
    const proof = o.method === 'passkey' ? { response: await getPasskey(o.options) } : { code }
    const s = await api<{ assertion: string }>('POST', `/skills/versions/${id}/step-up`, { digest: d.digest, ...proof })
    await api('POST', `/skills/versions/${id}/approve`, { digest: d.digest, assertion: s.assertion })
    setCode(''); setDone(true); reload(); refresh()
  })
  const reject = () => a.run(async () => { await api('POST', `/skills/versions/${id}/reject`, { reason }); setRejecting(false); reload() })

  return (
    <Page title={d.qname} actions={<Badge kind={pending ? 'accent' : d.status === 'approved' ? 'ok' : 'neutral'}>{st(`sk_v_${d.status}` as SkKey)}</Badge>}>
      {back}
      <section className="card">
        <p style={{ marginTop: 0 }}>{d.description}</p>
        <p className="muted small mono" style={{ overflowWrap: 'anywhere' }}>{st('sk_version')} sha256 {d.digest}</p>
        <p className="small">{st('sk_editors', { names: editorsText(d.editors) })} · {fmtDate(d.proposed_at)}</p>
        {d.decided_by && <p className="small">{st('sk_decided', { status: st(`sk_v_${d.status}` as SkKey), name: d.decided_by, when: fmtDate(d.decided_at) })}{d.reason ? ` — ${d.reason}` : ''}</p>}
        <p className="muted small">{d.approved ? st('sk_serving_now', { sha: short(d.approved.digest) }) : st('sk_serving_none')}</p>
        {d.has_scripts && <p><Badge kind="warn">{st('sk_scripts')}</Badge></p>}
        {done && <p className="ok">{st('sk_approved_done')}</p>}
      </section>
      {d.warnings.length > 0 && <section className="card"><h2>{st('sk_warnings')}</h2><ul>{d.warnings.map((w) => <li key={w} className="small">{w}</li>)}</ul></section>}
      <section className="card">
        <h2>{st('sk_files')}</h2>
        {files.map((f) => (
          <details key={f.path} open={f.change !== 'same' && !!f.diff} style={{ marginBottom: '.5rem' }}>
            <summary><span className="mono">{f.path}</span> <Badge kind={f.change === 'same' ? 'neutral' : f.change === 'removed' ? 'danger' : 'accent'}>{st(`sk_change_${f.change}` as SkKey)}</Badge> <span className="muted small">{f.size} B</span></summary>
            {f.binary ? <p className="muted small">{st('sk_binary')}</p> : f.diff ? <pre className="plain-text diff">{f.diff}</pre> : null}
          </details>
        ))}
      </section>
      {pending && d.can_decide && (
        <section className="card highlight">
          <h2>{st('sk_decide')}</h2>
          <p className="small">{st('sk_decide_help')}</p>
          <StepUpNote s={d.step_up} />
          <ErrorLine error={a.error} />
          <div className="row-actions" style={{ justifyContent: 'flex-start' }}>
            {d.step_up.method === 'totp' && <label>{st('sk_code')}<input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} /></label>}
            {d.step_up.method && <button className="btn primary" disabled={a.busy || (d.step_up.method === 'totp' && code.replace(/\s/g, '').length !== 6)} onClick={approve}>{st(d.step_up.method === 'passkey' ? 'sk_approve' : 'sk_approve_code')}</button>}
            <button className="btn danger" disabled={a.busy} onClick={() => setRejecting(!rejecting)}>{st('sk_reject')}</button>
          </div>
          {rejecting && (
            <form className="inline" onSubmit={(e) => { e.preventDefault(); reject() }}>
              <label>{st('sk_reject_reason')}<input value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={2000} /></label>
              <button className="btn small danger" disabled={a.busy || !reason.trim()}>{st('sk_reject')}</button>
            </form>
          )}
        </section>
      )}
      {pending && !d.can_decide && <p className="muted">{d.approvers_exist === false ? st('sk_no_approver') : st('sk_cannot', { why: d.why_not ?? '' })}</p>}
    </Page>
  )
}
