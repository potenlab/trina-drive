// Settings: language, own password, notices (kind, count and a link only — details are on the linked page).
import { useState } from 'react'
import { api, get } from '../api'
import { useSession } from '../App'
import { fmtDate, LOCALES, setLocale, t, useLocale, type Key } from '../i18n'
import { ErrorLine, Loading, Page, useAction, useLoad } from '../ui'
import { SecondFactorSettings } from './SecondFactor'

interface Notice { id: number; kind: string; count: number; link: string; created_at: number; read_at: number | null }

export function Settings() {
  const { me, refresh } = useSession()
  const locale = useLocale()
  const notices = useLoad(() => get<{ notices: Notice[] }>('/notices'))
  const a = useAction()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [done, setDone] = useState(false)
  return (
    <Page title={t('settings_title')}>
      <section className="card">
        <h2>{t('notices_title')}</h2>
        {!notices.data ? <Loading /> : notices.data.notices.length === 0 ? <p className="muted">{t('notices_empty')}</p> : <>
          <ul className="rows">
            {notices.data.notices.map((n) => (
              <li key={n.id} className={n.read_at ? 'dim' : ''}>
                <div className="row-main"><a href={n.link}>{t(`kind_${n.kind}` as Key)}</a>{n.count > 1 && <span className="muted"> ×{n.count}</span>} <span className="muted small">{fmtDate(n.created_at)}</span></div>
              </li>
            ))}
          </ul>
          {(me?.unread_notices ?? 0) > 0 && <button className="btn small" onClick={() => api('POST', '/notices/read').then(() => { notices.reload(); refresh() })}>{t('mark_read')}</button>}
        </>}
      </section>
      <SecondFactorSettings />
      <section className="card">
        <h2>{t('language')}</h2>
        <select value={locale} onChange={(e) => setLocale(e.target.value as 'en' | 'ko')}>{LOCALES.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}</select>
        <p className="muted small">{t('about_me')}: <strong>{me?.name}</strong> {me?.email && `· ${me.email}`}</p>
      </section>
      <form className="card" onSubmit={async (e) => {
        e.preventDefault(); setDone(false)
        if (await a.run(() => api('POST', '/me/password', { current, password: next }))) { setDone(true); setCurrent(''); setNext('') }
      }}>
        <h2>{t('change_password')}</h2>
        <input type="text" hidden readOnly autoComplete="username" value={me?.name ?? ''} />
        <label>{t('current_password')}<input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required autoComplete="current-password" /></label>
        <label>{t('new_password')}<input type="password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={10} autoComplete="new-password" /></label>
        <ErrorLine error={a.error} />
        {done && <p className="ok">{t('password_changed')}</p>}
        <button className="btn primary" disabled={a.busy}>{t('save')}</button>
      </form>
      <p className="muted small promise">{t('promise')}</p>
    </Page>
  )
}
