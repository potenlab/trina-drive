// Small shared pieces: async loading, error line, copy button, badges.
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ApiError } from './api'
import { Icon, type IconName } from './drive/Icon'
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
  if (e instanceof ApiError) return e.status === 404 ? t('not_found_generic') : e.message
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

/** Grey rows where a list is about to appear (the list's shape, not a spinner). */
export function Skeleton({ rows = 6, grid = false }: { rows?: number; grid?: boolean }) {
  return (
    <div className={`skel ${grid ? 'grid' : ''}`} role="status" aria-busy="true" aria-label={t('skeleton_loading')}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skel-row" aria-hidden="true"><span className="skel-ic" /><span className="skel-line" style={{ width: `${48 + ((i * 23) % 40)}%` }} /><span className="skel-line short" /></div>
      ))}
    </div>
  )
}

/** One empty state for every list: a quiet icon, one sentence, maybe an action. */
export function EmptyState({ icon, text, children }: { icon: IconName; text: string; children?: ReactNode }) {
  return <div className="empty-state"><Icon name={icon} size={40} /><p>{text}</p>{children}</div>
}

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
