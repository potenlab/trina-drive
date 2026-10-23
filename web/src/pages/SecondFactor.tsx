// Second factors: the sign-in second step, and the Settings section (passkeys, authenticator app, recovery codes).
import { useState } from 'react'
import { api, ApiError, get, setCsrf, type Me } from '../api'
import { go, useSession } from '../App'
import { fmtDate, t } from '../i18n'
import { createPasskey, getPasskey, passkeysSupported } from '../webauthn'
import { ErrorLine, Loading, Secret, useAction, useLoad } from '../ui'
import { at } from './approve-i18n'
import './approve.css'

export interface SecondFactorChallenge { ticket: string; methods: ('passkey' | 'totp' | 'recovery')[]; passkey: unknown | null; public_url: string | null; passkeys_elsewhere: string | null }

/** After a correct password (or a reset link) for someone with a second factor. */
/** `onDone`: where to go after the second step (default: the admin's folders or the person's files; OAuth consent stays put). */
export function SecondFactorStep({ challenge, onDone }: { challenge: SecondFactorChallenge; onDone?: () => void }) {
  const { setMe } = useSession()
  const [method, setMethod] = useState<'totp' | 'recovery'>(challenge.methods.includes('totp') ? 'totp' : 'recovery')
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const finish = async (body: Record<string, unknown>) => {
    setBusy(true); setError(null)
    try {
      const r = await api<{ me: Me; csrf: string }>('POST', '/login/second', { ticket: challenge.ticket, ...body })
      setCsrf(r.csrf); setMe(r.me)
      if (onDone) onDone(); else go(r.me.admin ? '/folders' : '/files')
    } catch (e) {
      setError(e instanceof ApiError && e.status === 429 ? t('login_rate') : e instanceof ApiError && e.code === 'bad_ticket' ? t('login_bad') : at('sf_bad'))
    } finally { setBusy(false) }
  }
  const codes = challenge.methods.filter((m) => m !== 'passkey')
  return (
    <div className="card narrow">
      <h1>{at('sf_title')}</h1>
      <p className="muted">{at('sf_intro')}</p>
      {challenge.methods.includes('passkey') && passkeysSupported() && (
        <button className="btn primary" disabled={busy} onClick={async () => {
          try { await finish({ method: 'passkey', response: await getPasskey(challenge.passkey) }) } catch { setError(at('sf_bad')) }
        }}>{at('sf_passkey')}</button>
      )}
      {(challenge.passkeys_elsewhere || (!!challenge.passkey && !!challenge.public_url && challenge.public_url !== window.location.origin)) &&
        <p className="muted small">{at('sf_elsewhere', { url: challenge.passkeys_elsewhere ?? challenge.public_url ?? '' })}</p>}
      {codes.length > 0 && (
        <form className="narrow" onSubmit={(e) => { e.preventDefault(); finish({ method, code }) }}>
          <label>{at(method === 'totp' ? 'sf_code' : 'sf_recovery')}
            <input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" inputMode={method === 'totp' ? 'numeric' : 'text'} required autoFocus={!challenge.methods.includes('passkey')} />
          </label>
          <button className="btn" disabled={busy || !code}>{at('sf_submit')}</button>
          {codes.length > 1 && <button type="button" className="btn small ghost" onClick={() => { setMethod(method === 'totp' ? 'recovery' : 'totp'); setCode('') }}>
            {at(method === 'totp' ? 'sf_use_recovery' : 'sf_use_code')}</button>}
        </form>
      )}
      {!challenge.methods.length && <p className="warn">{at('sf_none')}</p>}
      <ErrorLine error={error} />
    </div>
  )
}

interface Factors {
  passkeys_available: boolean; rp_id: string | null; public_url: string | null
  passkeys: { id: number; name: string; rp_id: string; created_at: number; last_used_at: number | null; usable: boolean }[]
  totp: boolean; recovery_remaining: number; enrolled: boolean
}

/** Settings → Second factor. Changes need the password typed within the last 5 minutes (asked here when needed). */
export function SecondFactorSettings() {
  const { me, refresh } = useSession()
  const f = useLoad(() => get<Factors>('/me/2fa'))
  const a = useAction()
  const [needPw, setNeedPw] = useState<null | (() => Promise<unknown>)>(null)
  const [pw, setPw] = useState('')
  const [pkName, setPkName] = useState('')
  const [totp, setTotp] = useState<{ secret: string; uri: string } | null>(null)
  const [code, setCode] = useState('')
  const [codes, setCodes] = useState<string[] | null>(null)
  const [warn, setWarn] = useState<string | null>(null)

  /** Run a change; if the server wants the password again, ask for it and run the change after. */
  const change = async (fn: () => Promise<unknown>) => {
    setWarn(null)
    const r = await a.run(async () => {
      try { return await fn() } catch (e) {
        if (e instanceof ApiError && e.code === 'reauth_required') { setNeedPw(() => fn); return null }
        throw e
      }
    })
    if (r && typeof r === 'object') {
      const x = r as { recovery_codes?: string[] | null; warning?: string }
      if (x.recovery_codes) setCodes(x.recovery_codes)
      if (x.warning === 'admin_without_2fa') setWarn(at('mfa_warn_admin_none'))
    }
    f.reload(); refresh()
    return r
  }

  if (!f.data) return <section className="card"><h2>{at('mfa_title')}</h2>{f.error ? <ErrorLine error={f.error} /> : <Loading />}</section>
  const d = f.data
  return (
    <section className="card">
      <h2>{at('mfa_title')}</h2>
      <p className="muted small">{at('mfa_intro')}</p>
      <p className={d.enrolled ? 'ok' : 'warn'}>{at(d.enrolled ? 'mfa_enrolled' : 'mfa_off')} {me?.admin && !d.enrolled && at('mfa_admin_needed')}</p>
      {warn && <p className="warn">{warn}</p>}
      <ErrorLine error={a.error} />

      {needPw && (
        <form className="card" onSubmit={async (e) => {
          e.preventDefault()
          const ok = await a.run(() => api('POST', '/me/reauth', { password: pw }))
          setPw('')
          if (ok) { const fn = needPw; setNeedPw(null); await change(fn) }
        }}>
          <p className="small">{at('mfa_reauth')}</p>
          <input type="text" hidden readOnly autoComplete="username" value={me?.name ?? ''} />
          <label>{t('password')}<input type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} required autoFocus /></label>
          <button className="btn small primary" disabled={a.busy || !pw}>{at('mfa_reauth_go')}</button>
        </form>
      )}

      {codes && (
        <div className="card highlight">
          <p className="small">{at('mfa_recovery_show')}</p>
          <Secret text={codes.join('\n')} />
          <button className="btn small" onClick={() => setCodes(null)}>{t('close')}</button>
        </div>
      )}

      <h3>{at('mfa_passkeys')}</h3>
      {!d.passkeys_available && <p className="muted small">{at('mfa_passkeys_unavailable')}</p>}
      {d.passkeys.length === 0 ? <p className="muted small">{at('mfa_no_passkeys')}</p> : (
        <ul className="rows">
          {d.passkeys.map((p) => (
            <li key={p.id}>
              <div className="row-main">{p.name} <span className="muted small">· {fmtDate(p.created_at)}{p.last_used_at ? ` · ${at('mfa_last_used', { when: fmtDate(p.last_used_at) })}` : ''}{!p.usable ? ` · ${at('mfa_passkey_other_host', { host: p.rp_id })}` : ''}</span></div>
              <div className="row-actions"><button className="btn small ghost" disabled={a.busy} onClick={() => { if (confirm(at('mfa_remove_confirm'))) change(() => api('DELETE', `/me/passkeys/${p.id}`)) }}>{t('remove')}</button></div>
            </li>
          ))}
        </ul>
      )}
      {d.passkeys_available && passkeysSupported() && (
        <form className="inline" onSubmit={(e) => {
          e.preventDefault()
          change(async () => {
            const o = await api('POST', '/me/passkeys/options')
            const response = await createPasskey(o)
            return api('POST', '/me/passkeys', { response, name: pkName || 'Passkey' })
          }).then((r) => { if (r) setPkName('') })
        }}>
          <label>{at('mfa_passkey_name')}<input value={pkName} onChange={(e) => setPkName(e.target.value)} maxLength={64} /></label>
          <button className="btn small primary" disabled={a.busy}>{at('mfa_add_passkey')}</button>
        </form>
      )}

      <h3>{at('mfa_totp')}</h3>
      {d.totp ? (
        <p className="small">{at('mfa_totp_on')} <button className="btn small ghost" disabled={a.busy} onClick={() => { if (confirm(at('mfa_remove_confirm'))) change(() => api('DELETE', '/me/totp')) }}>{at('mfa_totp_remove')}</button></p>
      ) : totp ? (
        <form onSubmit={(e) => { e.preventDefault(); change(() => api('POST', '/me/totp/confirm', { code })).then((r) => { if (r) { setTotp(null); setCode('') } }) }}>
          <p className="small">{at('mfa_totp_secret')}</p>
          <Secret text={totp.secret.replace(/(.{4})/g, '$1 ').trim()} />
          <p className="small mono"><a href={totp.uri}>{totp.uri.slice(0, 48)}…</a></p>
          <label>{at('mfa_totp_confirm')}<input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required /></label>
          <button className="btn small primary" disabled={a.busy || !code}>{t('save')}</button>
        </form>
      ) : (
        <button className="btn small" disabled={a.busy} onClick={() => change(() => api<{ secret: string; uri: string }>('POST', '/me/totp/setup').then((r) => { setTotp(r); return r }))}>{at('mfa_totp_setup')}</button>
      )}

      {d.enrolled && <>
        <h3>{at('mfa_recovery')}</h3>
        <p className="small">{at('mfa_recovery_left', { n: d.recovery_remaining })} <button className="btn small ghost" disabled={a.busy} onClick={() => change(() => api('POST', '/me/recovery-codes'))}>{at('mfa_recovery_new')}</button></p>
      </>}
    </section>
  )
}

/** Hosted servers: an admin without a second factor sees only this (the server refuses everything else). */
export function EnrollSecondFactor({ onDone }: { onDone: () => void }) {
  const { me, setMe } = useSession()
  return (
    <div className="card">
      <h1>{at('mfa_enroll_title')}</h1>
      <p className="muted">{at('mfa_enroll_intro')}</p>
      <SecondFactorSettings />
      <p>
        <button type="button" className="btn primary" disabled={!me?.second_factor} onClick={onDone}>{at('mfa_enroll_continue')}</button>{' '}
        <button type="button" className="btn ghost" onClick={() => api('POST', '/logout').finally(() => { setMe(null); go('/login') })}>{t('sign_out')}</button>
      </p>
    </div>
  )
}
