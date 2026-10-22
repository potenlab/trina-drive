// Audit, filtered (R7/R9): my own calls; calls that touched folders I manage; for the admin, counts per person and
// connection only.
import { useState } from 'react'
import { get } from '../api'
import { useSession } from '../App'
import { fmtDate, t } from '../i18n'
import { ErrorLine, Loading, Page, useLoad } from '../ui'

interface Entry { id: number; at: number; person?: string | null; connection: string; tool: string; command: string | null; files: string[]; outcome: string }
interface Summary { rows: { person: string | null; connection: string; count: number; last_at: number }[]; chain: { ok: boolean; rows: number; broken_at: number | null } }
type View = 'mine' | 'folders' | 'summary'

export function Audit() {
  const { me } = useSession()
  const [view, setView] = useState<View>('mine')
  const tabs: View[] = me?.admin ? ['mine', 'folders', 'summary'] : ['mine', 'folders']
  return (
    <Page title={t('audit_title')}>
      <div className="tabs" role="tablist">
        {tabs.map((v) => <button key={v} role="tab" aria-selected={view === v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>{t(`audit_${v}`)}</button>)}
      </div>
      {view === 'summary' ? <SummaryView /> : <EntriesView key={view} view={view} />}
    </Page>
  )
}

function EntriesView({ view }: { view: 'mine' | 'folders' }) {
  const [entries, setEntries] = useState<Entry[]>([])
  const [before, setBefore] = useState<number | null>(null)
  const { data, error } = useLoad(() => get<{ entries: Entry[] }>(`/audit?view=${view}${before ? `&before=${before}` : ''}`).then((r) => { setEntries((e) => before ? [...e, ...r.entries] : r.entries); return r }), [view, before])
  if (!data && !error) return <Loading />
  return <>
    {view === 'folders' && <p className="muted small">{t('audit_folders_help')}</p>}
    <ErrorLine error={error} />
    {entries.length === 0 ? <p className="muted">{t('audit_empty')}</p> : (
      <ul className="rows audit">
        {entries.map((x) => (
          <li key={x.id}>
            <div className="row-main">
              <div className="muted small">{fmtDate(x.at)} · {x.person ? `${x.person} · ` : ''}{x.connection} · {x.tool} · {x.outcome}</div>
              {x.command !== null ? <code className="cmd">{x.command}</code> : <span className="muted small">{t('audit_hidden_command')}</span>}
              {x.files.length > 0 && <div className="small mono files">{x.files.slice(0, 20).join('  ')}{x.files.length > 20 ? ` … +${x.files.length - 20}` : ''}</div>}
            </div>
          </li>
        ))}
      </ul>
    )}
    {data && data.entries.length >= 200 && <button className="btn" onClick={() => setBefore(entries[entries.length - 1]!.id)}>{t('load_more')}</button>}
  </>
}

function SummaryView() {
  const { data, error } = useLoad(() => get<Summary>('/audit?view=summary'))
  if (!data) return <><ErrorLine error={error} />{!error && <Loading />}</>
  return <>
    <p className="muted small">{t('audit_summary_help')}</p>
    <p className={data.chain.ok ? 'ok' : 'error'}>{data.chain.ok ? t('audit_chain_ok', { n: data.chain.rows }) : t('audit_chain_broken', { n: data.chain.broken_at ?? '?' })}</p>
    <table className="list">
      <thead><tr><th>{t('audit_who')}</th><th>{t('audit_connection')}</th><th className="c">{t('audit_count')}</th><th>{t('audit_when')}</th></tr></thead>
      <tbody>{data.rows.map((r, i) => <tr key={i}><td>{r.person ?? '—'}</td><td>{r.connection}</td><td className="c">{r.count}</td><td className="small">{fmtDate(r.last_at)}</td></tr>)}</tbody>
    </table>
  </>
}
