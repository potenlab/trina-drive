// Sign in, first setup (setup token → admin → folders with templates), invite / reset links. In Trina Cloud mode
// (GET /api/state answers `sso`) sign-in is "Sign in with Trina Cloud": GET /api/sso/start with the route the person
// was going to; under SSO-only the password form is folded away (emergency accounts only). The console's answer comes
// back to /#/sso-second/<ticket> (the drive's own second factor) or /#/sso-error/<code> (SsoLanding).
import { useEffect, useState } from 'react'
import { api, ApiError, get, setCsrf, type FolderSummary, type Me } from '../api'
import { go, useRoute, useSession } from '../App'
import { t, type Key } from '../i18n'
import { ErrorLine, useAction } from '../ui'
import { RegisterForm } from './RegisterForm'
import { SecondFactorStep, type SecondFactorChallenge } from './SecondFactor'

/** Trina Cloud sign-in, when this drive has it (GET /api/state `sso`). */
export interface SsoState { only: boolean; console_url: string }
export function useSsoState(): SsoState | null | undefined {
  const [sso, setSso] = useState<SsoState | null | undefined>(undefined)
  useEffect(() => { get<{ sso?: SsoState }>('/state').then((s) => setSso(s.sso ?? null), () => setSso(null)) }, [])
  return sso
}

/** Where /api/sso/start sends the browser back to: the route it is on (sign-in pages themselves → the files). */
export function ssoStartUrl(route: string, reauth = false): string {
  const back = !route || route === '/' || route.startsWith('/login') || route.startsWith('/sso-') ? '/#/files' : '/#' + route
  return `/api/sso/start?return=${encodeURIComponent(back)}${reauth ? '&reauth=1' : ''}`
}

/** `onDone`: where to go after signing in (default: the admin's folders or the person's files). */
export function Login({ onDone }: { onDone?: () => void } = {}) {
  const { setMe } = useSession()
  const route = useRoute()
  const sso = useSsoState()
  const [login, setLogin] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [second, setSecond] = useState<SecondFactorChallenge | null>(null)
  const [showPassword, setShowPassword] = useState(false)
  if (second) return <SecondFactorStep challenge={second} onDone={onDone} />
  // the console's answer came back here while signed out
  const landing = /^\/sso-(second|error)\/([^/?#]+)$/.exec(route)
  if (landing) return <SsoLanding kind={landing[1] as 'second' | 'error'} value={landing[2]!} />
  if (sso === undefined) return null
  const passwordForm = !sso || !sso.only || showPassword
  return (
    <div className="card narrow">
      <h1>{t('login_title')}</h1>
      <p className="muted">{sso ? t('sso_intro') : t('app_tagline')}</p>
      {sso && <a className="btn primary" href={ssoStartUrl(route)} data-testid="sso-start">{t('sso_button')}</a>}
      {sso && sso.only && !showPassword && (
        <button type="button" className="btn small ghost" onClick={() => setShowPassword(true)}>{t('sso_password_toggle')}</button>
      )}
      {sso && passwordForm && <p className="muted small" style={{ textAlign: 'center', margin: 0 }}>{sso.only ? t('sso_password_note') : t('sso_or')}</p>}
      {passwordForm && (
        <form className="narrow" style={{ display: 'grid', gap: '.75rem' }} onSubmit={async (e) => {
          e.preventDefault(); setBusy(true); setError(null)
          try {
            const r = await api<{ me: Me; csrf: string; second_factor?: SecondFactorChallenge }>('POST', '/login', { login, password })
            if (r.second_factor) { setSecond(r.second_factor); return }
            setCsrf(r.csrf); setMe(r.me)
            if (onDone) onDone(); else go(r.me.admin ? '/folders' : '/files')
          } catch (err) {
            setError(err instanceof ApiError && err.code === 'use_sso' ? t('sso_use_console') : err instanceof ApiError && err.status === 429 ? t('login_rate') : t('login_bad'))
          } finally { setBusy(false) }
        }}>
          <label>{t('login_name')}<input autoComplete="username" value={login} onChange={(e) => setLogin(e.target.value)} required autoFocus={!sso} /></label>
          <label>{t('password')}<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
          <ErrorLine error={error} />
          <button className={sso ? 'btn' : 'btn primary'} disabled={busy}>{t('login_submit')}</button>
        </form>
      )}
    </div>
  )
}

const SSO_ERRORS = new Set(['bad_state', 'expired', 'not_yet_valid', 'replayed', 'deactivated', 'people_limit', 'rate_limited'])

/** /#/sso-second/<ticket> (the drive's second factor after a console pass) and /#/sso-error/<code>. */
export function SsoLanding({ kind, value }: { kind: 'second' | 'error'; value: string }) {
  const { me } = useSession()
  const [challenge, setChallenge] = useState<SecondFactorChallenge | null>(null)
  const [failed, setFailed] = useState<string | null>(kind === 'error' ? value : null)
  useEffect(() => {
    if (kind !== 'second') return
    api<{ second_factor: SecondFactorChallenge }>('POST', '/sso/second', { ticket: value }).then((r) => setChallenge(r.second_factor), (e) => setFailed(e instanceof ApiError && e.status === 429 ? 'rate_limited' : 'bad_state'))
  }, [kind, value])
  if (failed) {
    const code = /^[a-z_]{1,40}$/.test(failed) ? failed : 'other'
    return (
      <div className="card narrow" role="alert">
        <h1>{t('sso_error_title')}</h1>
        <p>{SSO_ERRORS.has(code) ? t(`sso_err_${code}` as Key) : t('sso_err_other', { code })}</p>
        <p style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}>
          {code !== 'deactivated' && <a className="btn primary" href={ssoStartUrl('/files')}>{t('sso_error_retry')}</a>}
          <button type="button" className="btn ghost" onClick={() => go(me ? '/files' : '/login')}>{t('sso_error_back')}</button>
        </p>
      </div>
    )
  }
  if (!challenge) return <p className="muted">{t('sso_second_loading')}</p>
  return <SecondFactorStep challenge={challenge} onDone={(r) => { if (r?.return_to) window.location.assign(r.return_to); else go(r?.me.admin ? '/folders' : '/files') }} />
}

/** `token`: from the setup link's #fragment (App.tsx), pre-filled. */
export function Setup({ pending, token = '', onDone }: { pending: boolean; token?: string; onDone: () => void }) {
  const { me, setMe } = useSession()
  const [form, setForm] = useState({ setup_token: token, name: '', email: '', password: '' })
  const a = useAction()
  if (!me) {
    if (!pending) return <div className="card narrow"><h1>{t('setup_title')}</h1><p>{t('setup_none')}</p></div>
    const f = (k: keyof typeof form) => ({ value: form[k], onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value }) })
    return (
      <form className="card narrow" onSubmit={async (e) => {
        e.preventDefault()
        const r = await a.run(() => api<{ me: Me; csrf: string }>('POST', '/setup', form))
        if (r) { setCsrf(r.csrf); setMe(r.me); onDone(); go('/setup/folders') }
      }}>
        <h1>{t('setup_title')}</h1>
        <p className="muted">{t(token ? 'setup_intro_link' : 'setup_intro')}</p>
        <label>{t('setup_token')}<input {...f('setup_token')} required autoComplete="off" spellCheck={false} /></label>
        <label>{t('your_name')}<input {...f('name')} required autoComplete="username" autoFocus={!!token} /></label>
        <label>{t('email')}<input type="email" {...f('email')} required autoComplete="email" /></label>
        <label>{t('new_password')}<input type="password" {...f('password')} required minLength={10} autoComplete="new-password" /></label>
        <ErrorLine error={a.error} />
        <button className="btn primary" disabled={a.busy}>{t('setup_submit')}</button>
      </form>
    )
  }
  return <SetupFolders />
}

function SetupFolders() {
  const { me } = useSession()
  const [folders, setFolders] = useState<FolderSummary[]>([])
  const load = () => get<{ folders: FolderSummary[] }>('/folders').then((r) => setFolders(r.folders.filter((f) => f.registered)), () => {})
  useEffect(() => { load() }, [])
  return (
    <div className="card">
      <h1>{t('setup_step_folders')}</h1>
      <p className="muted">{t('setup_folders_intro')}</p>
      <RegisterForm onDone={load} managed={me?.storage === 'managed'} />
      {folders.length > 0 && <>
        <h2>{t('setup_registered')}</h2>
        <ul className="plain">{folders.map((f) => <li key={f.id}><strong>{f.vpath}</strong> <span className="muted">{f.path}</span></li>)}</ul>
      </>}
      <p><button type="button" className="btn primary" onClick={() => go('/folders')}>{t('setup_done')}</button></p>
    </div>
  )
}

export function LinkPage({ kind, token }: { kind: 'invite' | 'reset'; token: string }) {
  const { setMe } = useSession()
  const [name, setName] = useState<string | null | false>(null)
  const [password, setPassword] = useState('')
  const [second, setSecond] = useState<SecondFactorChallenge | null>(null)
  const a = useAction()
  useEffect(() => { api<{ name: string }>('POST', '/links/check', { kind, token }).then((r) => setName(r.name), () => setName(false)) }, [kind, token])
  if (second) return <SecondFactorStep challenge={second} />
  if (name === null) return null
  if (name === false) return <div className="card narrow"><p className="error">{t('link_bad')}</p><a href="#/login">{t('login_title')}</a></div>
  return (
    <form className="card narrow" onSubmit={async (e) => {
      e.preventDefault()
      const r = await a.run(() => api<{ me?: Me; csrf?: string; second_factor?: SecondFactorChallenge }>('POST', '/links/accept', { kind, token, password }))
      if (r?.second_factor) setSecond(r.second_factor)
      else if (r?.me && r.csrf) { setCsrf(r.csrf); setMe(r.me); go(kind === 'reset' ? '/tokens' : r.me.admin ? '/folders' : '/files') }
      else if (r) go('/login')
    }}>
      <h1>{t(kind === 'invite' ? 'link_invite_title' : 'link_reset_title', { name })}</h1>
      <p className="muted">{t(kind === 'invite' ? 'link_invite_intro' : 'link_reset_intro')}</p>
      <input type="text" hidden readOnly autoComplete="username" value={name} />
      <label>{t('new_password')}<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} autoComplete="new-password" autoFocus /></label>
      <ErrorLine error={a.error} />
      <button className="btn primary" disabled={a.busy}>{t('link_submit')}</button>
    </form>
  )
}
