// Folders you can see: registered folders and subfolders with their own rules, with your own AI / NAS / manage marks.
import { useState } from 'react'
import { get, type FolderSummary } from '../api'
import { go, useSession } from '../App'
import { t } from '../i18n'
import { Badge, ErrorLine, Loading, Page, useLoad, YesNo } from '../ui'
import { RegisterForm } from './RegisterForm'

export function FolderBadges({ f }: { f: FolderSummary }) {
  return <>
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
  const [adding, setAdding] = useState(false)
  return (
    <Page title={t('folders_title')} actions={me?.admin && <button className="btn" onClick={() => setAdding(!adding)}>{adding ? t('close') : t('register_folder')}</button>}>
      {adding && <div className="card"><RegisterForm onDone={(id) => { reload(); setAdding(false); go(`/folders/${id}`) }} /></div>}
      <ErrorLine error={error} />
      {!data ? <Loading /> : data.folders.length === 0 ? <p className="muted">{t('folders_empty')}</p> : (
        <table className="list">
          <thead><tr><th>{t('col_folder')}</th><th className="c">{t('you_ai')}</th><th className="c">{t('you_nas')}</th></tr></thead>
          <tbody>
            {data.folders.map((f) => (
              <tr key={f.id} className="clickable" onClick={() => go(`/folders/${f.id}`)}>
                <td>
                  <a href={`#/folders/${f.id}`} className="strong">{f.vpath ?? f.name}</a>
                  <div className="badges"><FolderBadges f={f} /></div>
                  {f.path && <div className="muted small mono">{f.path}</div>}
                </td>
                <td className="c"><YesNo v={f.mine.ai} /></td>
                <td className="c"><YesNo v={f.mine.nas} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted small promise">{t('promise')}</p>
    </Page>
  )
}
