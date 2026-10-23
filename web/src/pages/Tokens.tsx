// Access tokens (on the "Connect your AI" page, drive/ConnectAI.tsx): make one per computer/client (shown once, then
// connected with `<cli> mcp add … --token-stdin`: no token on a command line), see last use, revoke. OAuth connections
// that apps made on the consent page are listed here too.
import { useState } from 'react'
import { api, get, type FolderSummary } from '../api'
import { useSession } from '../App'
import { BRAND_CTX, CLIENT_LABEL, CLIENTS, manualConfig, recommendedCommand, tokenStdinCommand, type Client, type ConnectCtx } from '../connect'
import { fmtDate, t, type Key } from '../i18n'
import { Badge, ErrorLine, Loading, Secret, useAction, useLoad } from '../ui'

interface Token {
  id: number; name: string; hint: string; read_only: boolean; created_at: number; expires_at: number | null; revoked_at: number | null
  last_used_at: number | null; last_client: string | null; status: 'active' | 'revoked' | 'expired'; scope: { id: number; vpath: string | null }[] | null
  /** 'oauth': approved on the consent page by an app (claude.ai, ChatGPT …); revoking it cuts the app at once */
  kind?: 'pat' | 'oauth'; client?: { name: string | null; domain: string | null; verified: boolean } | null
}
const TTLS = ['8h', '1d', '7d', '30d', '90d'] as const

export function TokenManager() {
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

  return (
    <section className="tokens" id="tokens" aria-labelledby="tokens-h">
      <h2 id="tokens-h">{t('tokens_title')}</h2>
      <p className="muted small">{t('tokens_intro')}</p>
      {made && (
        <div className="card highlight">
          <h2>{made.name}</h2>
          <p className="warn">{t('token_once')}</p>
          <Secret text={made.token} />
          <Connect token={made.token} />
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
                <strong>{x.name}</strong>{' '}
                {x.kind === 'oauth' ? <Badge kind="accent" title={x.client?.domain ?? ''}>OAuth · {x.client?.domain ?? '?'}</Badge> : <code className="small">{x.hint}…</code>}{' '}
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
    </section>
  )
}

/**
 * How to connect a client, per client (tabs). Without a token: the recommended command (the CLI signs in and makes
 * and stores its own token). With a token just made here: the --token-stdin command (pasted at a hidden prompt) and,
 * collapsed, the manual client configuration that keeps the token in clear text.
 */
export function Connect({ token }: { token?: string }) {
  const { me } = useSession()
  const [client, setClient] = useState<Client>('claude')
  const c: ConnectCtx = { ...BRAND_CTX, origin: window.location.origin, login: me?.name ?? '', admin: !!me?.admin }
  const manual = token ? manualConfig(c, client, token) : null
  return (
    <div className="connect">
      <div className="tabs" role="tablist">
        {CLIENTS.map((x) => <button key={x} type="button" role="tab" aria-selected={x === client} className={x === client ? 'on' : ''} onClick={() => setClient(x)}>{CLIENT_LABEL[x]}</button>)}
      </div>
      {token ? <>
        <p className="small">{t('connect_with_token', { cli: c.cli })}</p>
        <Secret text={tokenStdinCommand(c, client)} />
        <p className="muted small">{t('connect_with_token_help')}</p>
      </> : <>
        <p className="small">{t('connect_recommended', { cli: c.cli })}</p>
        <Secret text={recommendedCommand(c, client)} />
        <p className="muted small">{t('connect_recommended_help')}</p>
        {c.admin && <p className="muted small">{t('connect_admin_scope')}</p>}
      </>}
      {client !== 'claude' && <p className="muted small">{t('connect_env')} <code>. ~/.config/{c.cli}/env.sh</code></p>}
      {client === 'cursor' && <p className="muted small">{t('connect_cursor_enable')}</p>}
      {manual && (
        <details className="manual">
          <summary>{t('connect_manual')}</summary>
          <p className="warn small">{t('connect_manual_warn', { file: manual.file })}</p>
          <Secret text={manual.text} />
        </details>
      )}
    </div>
  )
}
