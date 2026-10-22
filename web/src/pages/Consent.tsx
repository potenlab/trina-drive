// OAuth consent (#/oauth/<request id>, reached from /oauth/authorize): which app (its name, and big, the domain its
// metadata document was fetched from), where the answer goes, which folders, read-only by default, how long. The
// server re-checks everything on approve (src/oauth/consent.ts); this page only shows and asks.
import { useState } from 'react'
import { api, get } from '../api'
import { useSession } from '../App'
import { Badge, ErrorLine, Loading, useAction, useLoad } from '../ui'
import { ct, type ConsentKey } from './consent-i18n'
import './consent.css'

interface Details {
  client: { name: string; domain: string; client_id: string; kind: 'cimd' | 'dcr'; verified: boolean; redirect_host: string; loopback: boolean; loopback_only: boolean }
  server: string; resource: string; scopes: string[]; can_write: boolean; admin: boolean
  folders: { id: number; vpath: string | null }[]; ttl_options: string[]; default_ttl: string
}

export function Consent({ rid }: { rid: string }) {
  const { me } = useSession()
  const { data, error } = useLoad(() => get<Details>(`/oauth/requests/${rid}`), [rid])
  const a = useAction()
  const [all, setAll] = useState(false)
  const [picked, setPicked] = useState<number[]>([])
  const [readOnly, setReadOnly] = useState(true)
  const [ttl, setTtl] = useState('30d')
  const [leaving, setLeaving] = useState(false)

  if (error) return <div className="card"><p className="error" role="alert">{ct('gone')}</p></div>
  if (!data) return <Loading />
  if (leaving) return <div className="card"><p>{ct('redirecting')}</p></div>
  const c = data.client
  const decide = async (action: 'approve' | 'deny') => {
    const r = await a.run(() => api<{ redirect_to: string }>('POST', `/oauth/requests/${rid}/${action}`,
      action === 'approve' ? { ...(all && !data.admin ? { all: true } : { folders: picked }), read_only: readOnly, ttl } : undefined))
    if (r) { setLeaving(true); window.location.assign(r.redirect_to) }
  }
  const chooseAll = all && !data.admin
  const ready = chooseAll || picked.length > 0

  return (
    <div className="card consent">
      <h1>{ct('title', { name: c.name })}</h1>
      <div className="consent-domain">
        <span className="muted small">{ct('domain_label')}</span>
        <strong className="domain">{c.domain}</strong>
        {c.verified ? <Badge kind="ok">✓</Badge> : <Badge kind="warn">!</Badge>}
      </div>
      <p className={c.verified ? 'muted small' : 'warn small'}>{ct(c.verified ? 'domain_checked' : 'domain_unverified')}</p>
      <p className="small">{ct('answer_to')}: <code>{c.redirect_host}</code></p>
      {(c.loopback || c.loopback_only) && <p className="warn small">{ct('loopback_warn')}</p>}
      <p className="muted small">{ct('signed_in_as', { name: me?.name ?? '' })}</p>
      <p className="small">{ct('only_if_you')}</p>

      <h2>{ct('what_it_gets')}</h2>
      <fieldset>
        <legend>{ct('folders')}</legend>
        {data.folders.length === 0 ? <p className="muted">{ct('folders_none')}</p> : <>
          {data.admin ? <p className="muted small">{ct('folders_admin')}</p> : (
            <div className="seg">
              <label className={!all ? 'on' : ''}><input type="radio" checked={!all} onChange={() => setAll(false)} />{ct('folders_some')}</label>
              <label className={all ? 'on' : ''}><input type="radio" checked={all} onChange={() => setAll(true)} />{ct('folders_all')}</label>
            </div>
          )}
          {!chooseAll && (
            <div className="chips">
              {data.folders.map((f) => (
                <label key={f.id} className="check chip">
                  <input type="checkbox" checked={picked.includes(f.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, f.id] : picked.filter((x) => x !== f.id))} />{f.vpath}
                </label>
              ))}
            </div>
          )}
        </>}
      </fieldset>
      {data.can_write ? (
        <label className="check"><input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} /> {ct(readOnly ? 'read_only' : 'read_only_off')}</label>
      ) : <p className="muted small">{ct('write_not_asked')}</p>}
      <label>{ct('expiry')}
        <select value={ttl} onChange={(e) => setTtl(e.target.value)}>{data.ttl_options.map((x) => <option key={x} value={x}>{ct(`ttl_${x}` as ConsentKey)}</option>)}</select>
      </label>
      <p className="muted small">{ct('notes', { domain: c.domain })}</p>
      <ErrorLine error={a.error} />
      <div className="row-actions">
        <button className="btn primary" disabled={a.busy || !ready} onClick={() => decide('approve')}>{ct('approve')}</button>
        <button className="btn" disabled={a.busy} onClick={() => decide('deny')}>{ct('deny')}</button>
      </div>
    </div>
  )
}

/** What a signed-in person sees on the public address outside a consent request. */
export function PublicOnly() {
  const { me } = useSession()
  return (
    <div className="card narrow">
      <h1>{ct('public_title')}</h1>
      <p>{ct('public_text')}</p>
      {me && <>
        <p className="muted small">{ct('public_signed_in', { name: me.name })}</p>
        <div className="row-actions">
          <a className="btn" href="#/approvals">{ct('public_approvals')}</a>
          <a className="btn" href="#/second-factor">{ct('public_passkeys')}</a>
          <button type="button" className="btn ghost" onClick={() => api('POST', '/logout').finally(() => window.location.reload())}>{ct('public_sign_out')}</button>
        </div>
      </>}
    </div>
  )
}
