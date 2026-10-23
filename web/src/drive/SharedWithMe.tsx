// Shared with me (#/shared, plan 3.3): folders and files someone gave this person or one of their groups directly (not
// the whole team), newest first; a filter picks folders or files. The server re-checks every row on every request, so a
// revoked share is simply gone. A shared file opens picked in its folder (people given a file see the folder names on
// the way to it, nothing else there). On a server without the sharing API the page lists the team folders the person
// can open instead (and says so).
import { useEffect, useState } from 'react'
import { get, type FolderSummary } from '../api'
import { useSession } from '../App'
import { fmtDate, t, useLocale } from '../i18n'
import { fmtSize, iconOf } from '../pages/Files'
import { EmptyState, errText, ErrorLine, Skeleton } from '../ui'
import { FileGlyph } from './FileGlyph'
import { fileHref } from './Recent'
import { shareBackend, type SharedItem } from './share-api'
import { filesHref } from './Tree'

type Kind = 'all' | 'folder' | 'file'

export function SharedWithMe() {
  useLocale()
  const { me } = useSession()
  const [items, setItems] = useState<SharedItem[] | null>(null)
  const [legacy, setLegacy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [kind, setKind] = useState<Kind>('all')
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
  const shown = (items ?? []).filter((x) => kind === 'all' || x.kind === kind)
  const both = !!items && items.some((x) => x.kind === 'file') && items.some((x) => x.kind === 'folder')
  return (
    <section className="page">
      <header className="page-head"><div><h1>{t('swm_title')}</h1><p className="muted small">{legacy ? t('swm_legacy') : t('swm_help')}</p></div></header>
      <ErrorLine error={error} />
      {(both || kind !== 'all') && (
        <div className="seg-btns swm-kinds" role="group" aria-label={t('swm_title')}>
          {(['all', 'folder', 'file'] as const).map((k) => (
            <button key={k} type="button" className={`btn small ${kind === k ? 'on' : ''}`} aria-pressed={kind === k} onClick={() => setKind(k)}>
              {t(k === 'all' ? 'swm_all' : k === 'folder' ? 'swm_folders' : 'swm_files')}</button>
          ))}
        </div>
      )}
      {!items && !error ? <Skeleton rows={5} /> : items && shown.length === 0 ? (
        <EmptyState icon="shared" text={items.length ? t('swm_empty_kind') : t('swm_empty')} />
      ) : items && (
        <div className="table-wrap">
          <table className="list swm">
            <thead><tr><th>{t('swm_col_name')}</th><th className="hide-narrow">{t('swm_col_by')}</th><th className="hide-narrow">{t('swm_col_date')}</th><th>{t('swm_col_role')}</th></tr></thead>
            <tbody>
              {shown.map((x) => (
                <tr key={x.path}>
                  <td><a className="swm-name" href={x.kind === 'folder' ? filesHref(x.path) : fileHref(x.path)}>
                    <FileGlyph type={iconOf({ kind: x.kind, name: x.name }).type} size={20} /><span>{x.name.normalize('NFC')}</span></a>
                    <div className="muted small mono">{x.path.normalize('NFC')}{x.kind === 'file' && x.size != null && <span className="swm-size"> · {fmtSize(x.size)}</span>}</div></td>
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
