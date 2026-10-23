// Recent (#/recent, A2 memo §9.1): the files this person opened or changed themselves, on the web or a mounted drive,
// newest first, grouped by day like Drive's Recent. The server judges every path again on each request (a file renamed,
// moved or no longer visible is simply not there) and leaves agent reads out. A server without GET /api/recent says so.
import { useEffect, useState } from 'react'
import { fmtDate, t, useLocale } from '../i18n'
import { fmtSize, iconOf } from '../pages/Files'
import { EmptyState, ErrorLine, Skeleton, errText } from '../ui'
import { FileGlyph } from './FileGlyph'
import { useSession } from '../App'
import { recentBucket, recentFiles, shownPath, type RecentItem } from './share-api'
import { filesHref } from './Tree'

const typeOf = (name: string) => iconOf({ kind: 'file', name }).type
const parentOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/'
export const fileHref = (path: string) => filesHref(parentOf(path)) + (parentOf(path) === '/' ? '?' : '&') + 's=' + encodeURIComponent(path)

export function Recent() {
  useLocale()
  const { me } = useSession()
  const where = (p: string) => shownPath(parentOf(p), me?.myFilesPath, t('my_title')).normalize('NFC')
  const [data, setData] = useState<{ items: RecentItem[]; partial: boolean } | null | 'none'>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    recentFiles(100).then((r) => live && setData(r ?? 'none'), (e) => live && setError(errText(e)))
    return () => { live = false }
  }, [])
  const groups: [string, RecentItem[]][] = []
  if (data && data !== 'none') for (const x of data.items) {
    const k = recentBucket(x.at)
    const g = groups.at(-1)
    if (g && g[0] === k) g[1].push(x); else groups.push([k, [x]])
  }
  return (
    <section className="page recent">
      <header className="page-head"><div><h1>{t('rc_title')}</h1><p className="muted small">{t('rc_help')}</p></div></header>
      <ErrorLine error={error} />
      {data === null && !error ? <Skeleton rows={6} /> : data === 'none' ? <EmptyState icon="recent" text={t('rc_unavailable')} />
        : data && data.items.length === 0 ? <EmptyState icon="recent" text={t('rc_empty')} />
          : data && <>
            <div className="table-wrap">
              <table className="list rc">
                <thead><tr><th>{t('rc_col_name')}</th><th className="hide-narrow">{t('rc_col_where')}</th><th>{t('rc_col_when')}</th></tr></thead>
                {groups.map(([k, items]) => (
                  <tbody key={k}>
                    <tr className="rc-group"><th colSpan={3} scope="rowgroup">{t(k as 'rc_today')}</th></tr>
                    {items.map((x) => (
                      <tr key={x.path}>
                        <td><a className="swm-name" href={fileHref(x.path)}><FileGlyph type={typeOf(x.name)} size={20} /><span>{x.name.normalize('NFC')}</span></a>
                          <div className="muted small show-narrow">{where(x.path)}</div></td>
                        <td className="hide-narrow muted small"><a href={filesHref(parentOf(x.path))}>{where(x.path)}</a></td>
                        <td className="small"><span>{t(x.action === 'edited' ? 'rc_edited' : 'rc_opened')}</span> <span className="muted">· {fmtDate(x.at)}</span>
                          <div className="muted small">{fmtSize(x.size)}</div></td>
                      </tr>
                    ))}
                  </tbody>
                ))}
              </table>
            </div>
            {data.partial && <p className="muted small">{t('rc_partial')}</p>}
          </>}
    </section>
  )
}
