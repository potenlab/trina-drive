// My tokens: make one per computer/client (shown once, with the `claude mcp add` line), see last use, revoke.
import { useState } from 'react'
import { api, get, type FolderSummary } from '../api'
import { fmtDate, t, type Key } from '../i18n'
import { Badge, ErrorLine, Loading, Page, Secret, useAction, useLoad } from '../ui'

interface Token {
  id: number; name: string; hint: string; read_only: boolean; created_at: number; expires_at: number | null; revoked_at: number | null
  last_used_at: number | null; last_client: string | null; status: 'active' | 'revoked' | 'expired'; scope: { id: number; vpath: string | null }[] | null
}
const TTLS = ['8h', '1d', '7d', '30d', '90d'] as const

export function Tokens() {
  const { data, error, reload } = useLoad(() => get<{ tokens: Token[] }>('/tokens'))
  const folders = useLoad(() => get<{ folders: FolderSummary[] }>('/folders'))
  const a = useAction()
  const [name, setName] = useState('')
  const [ttl, setTtl] = useState<(typeof TTLS)[number]>('7d')
  const [readOnly, setReadOnly] = useState(false)
  const [some, setSome] = useState(false)
  const [scope, setScope] = useState<number[]>([])
  const [made, setMade] = useState<{ token: string; name: string } | null>(null)
  const [resetFor, setResetFor] = useState<number | null>(null)
  const [pw, setPw] = useState('')
  const [resetDone, setResetDone] = useState<string | null>(null)
  const readable = (folders.data?.folders ?? []).filter((f) => f.mine.ai)
  const mcpName = (document.title || 'shelf').toLowerCase().replace(/[^a-z0-9_-]/g, '')
  const snippet = made ? `claude mcp add --scope user --transport http ${mcpName} ${window.location.origin}/mcp --header "Authorization: Bearer ${made.token}"` : ''

  return (
    <Page title={t('tokens_title')}>
      <p className="muted">{t('tokens_intro')}</p>
      {made && (
        <div className="card highlight">
          <h2>{made.name}</h2>
          <p className="warn">{t('token_once')}</p>
          <Secret text={made.token} />
          <p className="small">{t('token_snippet')}</p>
          <Secret text={snippet} />
          <button className="btn small ghost" onClick={() => setMade(null)}>{t('close')}</button>
        </div>
      )}
      <form className="card" onSubmit={async (e) => {
        e.preventDefault()
        const r = await a.run(() => api<{ id: number; token: string }>('POST', '/tokens', { name, ttl, read_only: readOnly, scope: some ? scope : undefined }))
        if (r) { setMade({ token: r.token, name }); setName(''); reload() }
      }}>
        <div className="grid2">
          <label>{t('token_name')}<input value={name} onChange={(e) => setName(e.target.value)} placeholder="claude-code-laptop" required maxLength={64} /></label>
          <label>{t('token_expiry')}
            <select value={ttl} onChange={(e) => setTtl(e.target.value as typeof ttl)}>{TTLS.map((x) => <option key={x} value={x}>{t(`ttl_${x}` as Key)}</option>)}</select>
          </label>
        </div>
        <fieldset>
          <legend>{t('token_scope')}</legend>
          <div className="seg">
            <label className={!some ? 'on' : ''}><input type="radio" checked={!some} onChange={() => setSome(false)} />{t('token_scope_all')}</label>
            <label className={some ? 'on' : ''}><input type="radio" checked={some} onChange={() => setSome(true)} />{t('token_scope_some')}</label>
          </div>
          {some && (
            <div className="chips">
              {readable.map((f) => <label key={f.id} className="check chip"><input type="checkbox" checked={scope.includes(f.id)} onChange={(e) => setScope(e.target.checked ? [...scope, f.id] : scope.filter((x) => x !== f.id))} />{f.vpath}</label>)}
            </div>
          )}
        </fieldset>
        <label className="check"><input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} /> {t('token_read_only')}</label>
        <p className="muted small">{t('token_terms')}</p>
        <ErrorLine error={a.error} />
        <button className="btn primary" disabled={a.busy || (some && scope.length === 0)}>{t('token_create')}</button>
      </form>

      <ErrorLine error={error} />
      {!data ? <Loading /> : (
        <ul className="rows">
          {data.tokens.map((x) => (
            <li key={x.id} className={x.status === 'active' ? '' : 'dim'}>
              <div className="row-main">
                <strong>{x.name}</strong> <code className="small">{x.hint}…</code>{' '}
                <Badge kind={x.status === 'active' ? 'ok' : 'neutral'}>{t(`token_status_${x.status}` as Key)}</Badge>
                {x.read_only && <> <Badge>{t('token_read_only')}</Badge></>}
                <div className="muted small">
                  {t('token_scope')}: {x.scope ? x.scope.map((s) => s.vpath ?? '?').join(', ') : t('all_folders')} · {t('created')} {fmtDate(x.created_at)} · {t('expires')} {x.expires_at ? fmtDate(x.expires_at) : t('never')}
                </div>
                <div className="muted small">{t('token_last_used')}: {x.last_used_at ? `${fmtDate(x.last_used_at)}${x.last_client ? ` · ${x.last_client}` : ''}` : t('token_never_used')}</div>
              </div>
              {x.status === 'active' && (
                <div className="row-actions">
                  <button className="btn small ghost" disabled={a.busy} onClick={() => { setResetFor(resetFor === x.id ? null : x.id); setPw(''); setResetDone(null) }}>{t('token_reset_prov')}</button>
                  <button className="btn small danger" disabled={a.busy} onClick={() => { if (confirm(t('token_revoke_confirm', { name: x.name }))) a.run(() => api('DELETE', `/tokens/${x.id}`)).then((r) => { if (r) reload() }) }}>{t('token_revoke')}</button>
                </div>
              )}
              {resetFor === x.id && (
                <form className="card" onSubmit={async (e) => {
                  e.preventDefault()
                  // a fresh login: the password is typed again for this (plan 5.1 "출처 초기화")
                  const r = await a.run(() => api<{ cleared: number }>('POST', `/tokens/${x.id}/provenance-reset`, { password: pw }))
                  setPw('')
                  if (r) setResetDone(t('token_reset_prov_done', { n: String(r.cleared) }))
                }}>
                  <p className="muted small">{t('token_reset_prov_help')}</p>
                  <label>{t('password')}<input type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} required /></label>
                  {resetDone ? <p className="small">{resetDone}</p> : <button className="btn small primary" disabled={a.busy || !pw}>{t('token_reset_prov_go')}</button>}
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
    </Page>
  )
}
