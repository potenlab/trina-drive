// Shared with me (#/shared, plan 3.3): folders someone gave this person or one of their groups directly (not the
// whole team), newest first. The server re-checks every row on every request, so a revoked share is simply gone.
// On a server without the sharing API the page lists the team folders the person can open instead (and says so).
import { useEffect, useState } from 'react'
import { get, type FolderSummary } from '../api'
import { useSession } from '../App'
import { fmtDate, t, useLocale } from '../i18n'
import { errText, ErrorLine, Loading } from '../ui'
import { Icon } from './Icon'
import { shareBackend, type SharedItem } from './share-api'
import { filesHref } from './Tree'

export function SharedWithMe() {
  useLocale()
  const { me } = useSession()
  const [items, setItems] = useState<SharedItem[] | null>(null)
  const [legacy, setLegacy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    shareBackend(() => ({ id: me?.id ?? -1 })).then(async (b) => {
      try {
        const r = await b.sharedWithMe()
        if (r) { if (live) setItems(r); return }
        const { folders } = await get<{ folders: FolderSummary[] }>('/folders')
        if (!live) return
        setLegacy(true)
        setItems(folders.filter((f) => f.vpath && f.personal_owner == null && (f.mine.ai || f.mine.manage)).map((f) => ({
          path: f.vpath!, kind: 'folder', name: f.vpath!.slice(f.vpath!.lastIndexOf('/') + 1), role: f.mine.manage ? 'manager' : null, shared_by: null, shared_at: null,
        })))
      } catch (e) { if (live) setError(errText(e)) }
    })
    return () => { live = false }
  }, [me?.id])
  return (
    <section className="page">
      <header className="page-head"><div><h1>{t('swm_title')}</h1><p className="muted small">{legacy ? t('swm_legacy') : t('swm_help')}</p></div></header>
      <ErrorLine error={error} />
      {!items && !error ? <Loading /> : items && items.length === 0 ? (
        <div className="empty-state"><Icon name="shared" size={40} /><p>{t('swm_empty')}</p></div>
      ) : items && (
        <div className="table-wrap">
          <table className="list swm">
            <thead><tr><th>{t('swm_col_name')}</th><th className="hide-narrow">{t('swm_col_by')}</th><th className="hide-narrow">{t('swm_col_date')}</th><th>{t('swm_col_role')}</th></tr></thead>
            <tbody>
              {items.map((x) => (
                <tr key={x.path}>
                  <td><a className="swm-name" href={x.kind === 'folder' ? filesHref(x.path) : filesHref(x.path.slice(0, x.path.lastIndexOf('/')) || '/') + '&s=' + encodeURIComponent(x.path)}>
                    <Icon name={x.kind === 'folder' ? 'folder' : 'drafts'} size={18} /><span>{x.name.normalize('NFC')}</span></a>
                    <div className="muted small mono">{x.path.normalize('NFC')}</div></td>
                  <td className="hide-narrow">{x.shared_by?.name ?? '—'}</td>
                  <td className="hide-narrow muted small">{x.shared_at ? fmtDate(x.shared_at) : '—'}</td>
                  <td>{x.role ? t(`share_role_${x.role}`) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
