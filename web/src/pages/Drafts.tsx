// My drafts (R4): those whose every source folder I can read right now, with "contains content from …"; the rest
// only as a count and dates.
import { get } from '../api'
import { fmtDate, t } from '../i18n'
import { ErrorLine, Loading, Page, useLoad } from '../ui'

interface Draft { id: number; path: string; token: string; version: number; size: number; updated_at: number; sources: { folder: string; strong: boolean }[] }

const folderName = (vpath: string) => vpath.replace(/^\//, '')

export function Drafts() {
  const { data, error } = useLoad(() => get<{ drafts: Draft[]; locked: { count: number; dates: number[] } }>('/drafts'))
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
                    {d.sources.length === 0 && <span className="muted small">{t('no_sources')}</span>}
                  </div>
                </div>
                <div className="row-actions"><a className="btn small" href={`/api/drafts/${d.id}/download`} download>{t('download')}</a></div>
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
