// My drafts (R4): those whose every source folder I can read right now, with "contains content from …"; the rest
// only as a count and dates.
import { useState } from 'react'
import { api, get } from '../api'
import { fmtDate, t } from '../i18n'
import { ErrorLine, Loading, Page, useAction, useLoad } from '../ui'
import { at } from './approve-i18n'
import './approve.css'

interface Draft { id: number; path: string; token: string; version: number; size: number; updated_at: number; sha256: string; sources: { folder: string; strong: boolean }[]; hidden_sources?: number }

const folderName = (vpath: string) => vpath.replace(/^\//, '')

export function Drafts() {
  const { data, error } = useLoad(() => get<{ drafts: Draft[]; locked: { count: number; dates: number[] } }>('/drafts'))
  const targets = useLoad(() => get<{ targets: { id: number; vpath: string }[] }>('/promote/targets'))
  const [open, setOpen] = useState<number | null>(null)
  return (
    <Page title={t('drafts_title')}>
      <p className="muted">{t('drafts_intro')}</p>
      <ErrorLine error={error} />
      {!data ? <Loading /> : <>
        {data.drafts.length === 0 && <p className="muted">{t('drafts_empty')}</p>}
        <ul className="rows">
          {data.drafts.map((d) => {
            const strong = d.sources.filter((s) => s.strong).map((s) => folderName(s.folder))
            const weak = d.sources.filter((s) => !s.strong).map((s) => folderName(s.folder))
            return (
              <li key={d.id}>
                <div className="row-main">
                  <strong className="mono">/drafts/{d.path}</strong> <span className="muted small">{t('version', { n: d.version })} · {d.size} B · {fmtDate(d.updated_at)} · {t('via_token', { token: d.token })}</span>
                  <div className="prov">
                    {strong.length > 0 && <span className="prov-strong">{t('contains_from', { folders: strong.join(', ') })}</span>}
                    {weak.length > 0 && <span className="muted small"> {t('looked_at', { folders: weak.join(', ') })}</span>}
                    {(d.hidden_sources ?? 0) > 0 && <span className="muted small"> {t('hidden_sources', { n: d.hidden_sources ?? 0 })}</span>}
                    {d.sources.length === 0 && !d.hidden_sources && <span className="muted small">{t('no_sources')}</span>}
                  </div>
                </div>
                <div className="row-actions">
                  <button className="btn small" onClick={() => setOpen(open === d.id ? null : d.id)}>{at('promote')}</button>
                  <a className="btn small" href={`/api/drafts/${d.id}/download`} download>{t('download')}</a>
                </div>
                {open === d.id && <PromoteForm d={d} targets={targets.data?.targets ?? []} />}
              </li>
            )
          })}
        </ul>
        {data.locked.count > 0 && (
          <div className="card muted">
            <p>{t('drafts_locked', { n: data.locked.count })}</p>
            <p className="small">{data.locked.dates.map(fmtDate).join(' · ')}</p>
          </div>
        )}
      </>}
    </Page>
  )
}

/** Promote one draft: a target folder this person may promote into, an optional subfolder, a new name (plan 5.2). */
function PromoteForm({ d, targets }: { d: Draft; targets: { id: number; vpath: string }[] }) {
  const a = useAction()
  const [folder, setFolder] = useState(targets[0]?.vpath ?? '')
  const [sub, setSub] = useState('')
  const [name, setName] = useState(d.path.slice(d.path.lastIndexOf('/') + 1))
  const [note, setNote] = useState('')
  const [overwrite, setOverwrite] = useState(false)
  const [result, setResult] = useState<{ status: string; path?: string; approval_id?: number; gain?: number } | null>(null)
  if (!targets.length) return <p className="muted small">{at('promote_no_targets')}</p>
  return (
    <form className="card promote-form" onSubmit={async (e) => {
      e.preventDefault()
      const target = sub.trim() ? `${folder}/${sub.trim().replace(/^\/+|\/+$/g, '')}` : folder
      const r = await a.run(() => api('POST', `/drafts/${d.id}/promote`, { folder: target, name, expected_sha256: d.sha256, note: note || undefined, ...(overwrite ? { overwrite: true } : {}) }))
      if (r) setResult(r)
    }}>
      <strong>{at('promote_title')}</strong>
      <p className="muted small">{at('promote_help')}</p>
      <label>{at('promote_folder')}<select value={folder} onChange={(e) => setFolder(e.target.value)}>{targets.map((x) => <option key={x.id} value={x.vpath}>{x.vpath}</option>)}</select></label>
      <label>{at('promote_sub')}<input value={sub} onChange={(e) => setSub(e.target.value)} /></label>
      <label>{at('promote_name')}<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={255} /></label>
      <label>{at('promote_note')}<input value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} /></label>
      <label className="check"><input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} /> {at('promote_overwrite')}</label>
      <ErrorLine error={a.error} />
      {result?.status === 'written' && <p className="ok">{at('promote_written', { path: result.path ?? '' })}</p>}
      {result?.status === 'pending' && <p>{at('promote_pending', { n: result.gain ?? 0 })} <a href={`#/approvals/${result.approval_id}`}>{at('promote_open')}</a></p>}
      {result?.status === 'closed' && <p className="warn">{at('promote_closed')}</p>}
      {!result && <button className="btn small primary" disabled={a.busy || !name}>{at('promote_go')}</button>}
    </form>
  )
}
