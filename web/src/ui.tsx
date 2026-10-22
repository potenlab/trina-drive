// Small shared pieces: async loading, error line, copy button, badges.
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ApiError } from './api'
import { t } from './i18n'

export function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(() => {
    load().then((d) => { setData(d); setError(null) }, (e) => setError(errText(e)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  useEffect(reload, [reload])
  return { data, error, reload, setData }
}

export function errText(e: unknown): string {
  if (e instanceof ApiError) return e.status === 404 ? 'Not found.' : e.message
  return t('error_generic')
}

/** Runs an action, shows its error, and reports busy state. */
export function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async <T,>(f: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true); setError(null)
    try { return await f() } catch (e) { setError(errText(e)); return undefined } finally { setBusy(false) }
  }
  return { busy, error, setError, run }
}

export const ErrorLine = ({ error }: { error: string | null }) => error ? <p className="error" role="alert">{error}</p> : null
export const Loading = () => <p className="muted">{t('loading')}</p>

export function Badge({ kind = 'neutral', children, title }: { kind?: 'neutral' | 'warn' | 'danger' | 'ok' | 'accent'; children: ReactNode; title?: string }) {
  return <span className={`badge badge-${kind}`} title={title}>{children}</span>
}

export function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <button type="button" className="btn small" onClick={() => {
      navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500) }, () => {})
    }}>{done ? t('copied') : t('copy')}</button>
  )
}

export function Secret({ text }: { text: string }) {
  return <div className="secret"><code>{text}</code><CopyButton text={text} /></div>
}

export const Page = ({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) => (
  <section className="page">
    <header className="page-head"><h1>{title}</h1>{actions}</header>
    {children}
  </section>
)

export const YesNo = ({ v }: { v: boolean | null | 'some' }) =>
  v === null ? <span className="mark unknown" title={t('unknown')}>?</span>
    : v === 'some' ? <span className="mark some">{t('nas_some')}</span>
      : v ? <span className="mark yes" aria-label={t('yes')}>✓</span> : <span className="mark no" aria-label={t('no')}>✗</span>
