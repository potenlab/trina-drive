// Folders you can see: registered folders and subfolders with their own rules, with your own AI / NAS / manage marks.
import { useState } from 'react'
import { get, type FolderSummary } from '../api'
import { fmtSize } from './Files'
import { go, useSession } from '../App'
import { t } from '../i18n'
import { Badge, EmptyState, ErrorLine, Page, Skeleton, useLoad, YesNo } from '../ui'
import { RegisterForm } from './RegisterForm'

export function FolderBadges({ f }: { f: FolderSummary }) {
  return <>
    {f.managed && f.registered && <Badge kind="ok">{t('managed_badge')}</Badge>}
    {f.personal_owner != null && <Badge kind="accent">{t('badge_personal')}</Badge>}
    {f.no_ai && <Badge kind="danger">{t('badge_no_ai')}</Badge>}
    {f.quarantine && <Badge kind="danger">{t('badge_quarantine')}</Badge>}
    {f.widened_pending && <Badge kind="warn">{t('badge_widened')}</Badge>}
    {f.status === 'missing' && <Badge kind="warn">{t('badge_missing')}</Badge>}
    {!f.registered && <Badge>{t('badge_subfolder')}</Badge>}
    {f.mine.manage && <Badge kind="ok">{t('badge_manager')}</Badge>}
  </>
}

export function Folders() {
  const { me } = useSession()
  const { data, error, reload } = useLoad(() => get<{ folders: FolderSummary[] }>('/folders'))
  // the sidebar's "+ New" at the top level opens the form (#/folders?new=1)
  const [adding, setAdding] = useState(() => !!me?.admin && /[?&]new=1/.test(window.location.hash))
  const managedMode = me?.storage === 'managed'
  const showNas = !data || data.folders.some((f) => !f.managed)
  return (
    <Page title={t('folders_title')} actions={me?.admin && <button className="btn" onClick={() => setAdding(!adding)}>{adding ? t('close') : managedMode ? t('new_team_folder') : t('register_folder')}</button>}>
      {me?.admin && (managedMode || data?.folders.some((f) => f.managed)) && <StorageCard />}
      {adding && <div className="card"><RegisterForm managed={managedMode} onDone={(id) => { reload(); setAdding(false); go(`/folders/${id}`) }} /></div>}
      <ErrorLine error={error} />
      {!data ? <Skeleton rows={4} /> : data.folders.length === 0 ? <EmptyState icon="access" text={t('folders_empty')} /> : (
        <table className="list">
          <thead><tr><th>{t('col_folder')}</th><th className="c">{t('you_ai')}</th>{showNas && <th className="c">{t('you_nas')}</th>}</tr></thead>
          <tbody>
            {data.folders.map((f) => (
              <tr key={f.id} className="clickable" onClick={() => go(`/folders/${f.id}`)}>
                <td>
                  <a href={`#/folders/${f.id}`} className="strong">{f.vpath ?? f.name}</a>
                  <div className="badges"><FolderBadges f={f} /></div>
                  {f.path && <div className="muted small mono">{f.path}</div>}
                </td>
                <td className="c"><YesNo v={f.mine.ai} /></td>
                {showNas && <td className="c">{f.managed ? '—' : <YesNo v={f.mine.nas} />}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted small promise">{t('promise')}</p>
    </Page>
  )
}

// ---------- team storage (admin; managed storage): what is used, of what quota ----------
interface Storage {
  mode: string; quota: number | null; usage: { files: number; count: number; trash: number; versions: number; uploads: number; total: number }
  folders: { id: number; name: string; vpath: string | null; bytes: number; files: number }[]
}
function StorageCard() {
  const { data } = useLoad(() => get<Storage>('/storage'))
  if (!data) return null
  const u = data.usage
  const pct = data.quota ? Math.min(100, Math.round((u.total / data.quota) * 100)) : null
  const parts: [string, number][] = [[t('storage_files'), u.files], [t('storage_versions'), u.versions], [t('storage_trash'), u.trash], [t('storage_uploads'), u.uploads]]
  return (
    <section className="card storage-card">
      <div className="storage-head">
        <h2>{t('storage_title')}</h2>
        <strong>{data.quota ? t('storage_of', { used: fmtSize(u.total), quota: fmtSize(data.quota) }) : t('storage_used', { used: fmtSize(u.total) })}</strong>
        {!data.quota && <span className="muted small">({t('storage_no_quota')})</span>}
      </div>
      {pct !== null && <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={t('storage_title')}><span style={{ width: `${pct}%` }} className={pct >= 90 ? 'full' : ''} /></div>}
      {pct !== null && pct >= 90 && <p className="warn small">{t('storage_full')}</p>}
      <dl className="storage-parts">
        {parts.map(([k, v]) => <div key={k}><dt className="muted small">{k}</dt><dd>{fmtSize(v)}</dd></div>)}
        <div><dt className="muted small">{t('storage_count', { n: u.count })}</dt><dd /></div>
      </dl>
      {data.folders.length > 0 && (
        <table className="list small">
          <tbody>{data.folders.map((f) => <tr key={f.id}><td><a href={`#/folders/${f.id}`}>{f.vpath ?? f.name}</a></td><td className="c muted">{t('storage_count', { n: f.files })}</td><td className="c">{fmtSize(f.bytes)}</td></tr>)}</tbody>
        </table>
      )}
      <p className="muted small">{t('storage_quota_help')}</p>
    </section>
  )
}
