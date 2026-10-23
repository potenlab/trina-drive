// Settings → "Mount as a drive": the WebDAV address (src/dav), how to connect from a Mac or Windows, and the person's
// app passwords (made here, shown once, revocable). Shown only in managed storage.
import { useState } from 'react'
import { api, get } from '../api'
import { fmtDate } from '../i18n'
import { CopyButton, ErrorLine, Loading, Secret, useAction, useLoad } from '../ui'
import './drive.css'
import { dt } from './drive-i18n'

interface AppPw { id: number; name: string; hint: string; created_at: number; last_used_at: number | null }
interface MountInfo { enabled: boolean; url: string; https: boolean; username: string; passwords: AppPw[] }

const localHost = (u: string) => { try { return /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(new URL(u).hostname) } catch { return false } }

export function MountSettings() {
  const info = useLoad(() => get<MountInfo>('/me/app-passwords'))
  const a = useAction()
  const [name, setName] = useState('')
  const [pw, setPw] = useState('')
  const [made, setMade] = useState<{ name: string; password: string } | null>(null)
  if (!info.data) return <section className="card"><h2>{dt('mt_title')}</h2>{info.error ? <ErrorLine error={info.error} /> : <Loading />}</section>
  const d = info.data
  if (!d.enabled) return null
  const steps = (s: string) => <ol className="small">{s.split('|').map((x) => <li key={x}>{x}</li>)}</ol>
  return (
    <section className="card mount" id="mount">
      <h2>{dt('mt_title')}</h2>
      <p className="muted small">{dt('mt_help')}</p>
      <dl className="mount-facts">
        <dt>{dt('mt_address')}</dt><dd><code>{d.url}</code> <CopyButton text={d.url} /></dd>
        <dt>{dt('mt_user')}</dt><dd><code>{d.username}</code></dd>
        <dt>{dt('mt_password')}</dt><dd>{dt('mt_use_app_password')}</dd>
      </dl>
      {!d.https && !localHost(d.url) && <p className="error small">{dt('mt_not_https')}</p>}
      <div className="mount-os">
        <div><h3>{dt('mt_mac')}</h3>{steps(dt('mt_mac_steps'))}</div>
        <div><h3>{dt('mt_win')}</h3>{steps(dt('mt_win_steps'))}<p className="muted small">{dt('mt_win_note')}</p></div>
      </div>
      <p className="muted small">{dt('mt_notes')}</p>

      <h3>{dt('mt_app_passwords')}</h3>
      <p className="muted small">{dt('mt_app_help')}</p>
      {made && <div className="mount-made"><p className="small"><strong>{made.name}</strong> — {dt('mt_shown_once')}</p><Secret text={made.password} /></div>}
      {d.passwords.length === 0 ? <p className="muted small">{dt('mt_none')}</p> : (
        <ul className="rows">
          {d.passwords.map((p) => <li key={p.id}>
            <div className="row-main"><strong>{p.name}</strong> <span className="muted small">…{p.hint} · {dt('mt_created', { date: fmtDate(p.created_at) })} · {p.last_used_at ? dt('mt_last_used', { date: fmtDate(p.last_used_at) }) : dt('mt_never_used')}</span></div>
            <button type="button" className="btn small danger" onClick={async () => {
              if (!window.confirm(dt('mt_confirm_revoke', { name: p.name }))) return
              if (await a.run(() => api('DELETE', `/me/app-passwords/${p.id}`))) { if (made?.name === p.name) setMade(null); info.reload() }
            }}>{dt('mt_revoke')}</button>
          </li>)}
        </ul>
      )}
      <form className="mount-new" onSubmit={async (e) => {
        e.preventDefault()
        const r = await a.run(() => api<{ name: string; password: string }>('POST', '/me/app-passwords', { name, password: pw }))
        if (r) { setMade(r); setName(''); setPw(''); info.reload() }
      }}>
        <h4>{dt('mt_new')}</h4>
        <label>{dt('mt_name')}<input value={name} onChange={(e) => setName(e.target.value)} placeholder={dt('mt_name_ph')} required maxLength={64} /></label>
        <label>{dt('mt_confirm_pw')}<input type="password" value={pw} onChange={(e) => setPw(e.target.value)} required autoComplete="current-password" /></label>
        <ErrorLine error={a.error} />
        <button className="btn primary" disabled={a.busy}>{dt('mt_create')}</button>
      </form>
    </section>
  )
}
