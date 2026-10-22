// Sign in, first setup (setup token → admin → folders with templates), invite / reset links.
import { useEffect, useState } from 'react'
import { api, ApiError, get, setCsrf, type FolderSummary, type Me } from '../api'
import { go, useSession } from '../App'
import { t } from '../i18n'
import { ErrorLine, useAction } from '../ui'
import { RegisterForm } from './RegisterForm'
import { SecondFactorStep, type SecondFactorChallenge } from './SecondFactor'

export function Login() {
  const { setMe } = useSession()
  const [login, setLogin] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [second, setSecond] = useState<SecondFactorChallenge | null>(null)
  if (second) return <SecondFactorStep challenge={second} />
  return (
    <form className="card narrow" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setError(null)
      try {
        const r = await api<{ me: Me; csrf: string; second_factor?: SecondFactorChallenge }>('POST', '/login', { login, password })
        if (r.second_factor) { setSecond(r.second_factor); return }
        setCsrf(r.csrf); setMe(r.me); go(r.me.admin ? '/folders' : '/files')
      } catch (err) {
        setError(err instanceof ApiError && err.status === 429 ? t('login_rate') : t('login_bad'))
      } finally { setBusy(false) }
    }}>
      <h1>{t('login_title')}</h1>
      <p className="muted">{t('app_tagline')}</p>
      <label>{t('login_name')}<input autoComplete="username" value={login} onChange={(e) => setLogin(e.target.value)} required autoFocus /></label>
      <label>{t('password')}<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
      <ErrorLine error={error} />
      <button className="btn primary" disabled={busy}>{t('login_submit')}</button>
    </form>
  )
}

export function Setup({ pending, onDone }: { pending: boolean; onDone: () => void }) {
  const { me, setMe } = useSession()
  const [form, setForm] = useState({ setup_token: '', name: '', email: '', password: '' })
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
        <p className="muted">{t('setup_intro')}</p>
        <label>{t('setup_token')}<input {...f('setup_token')} required autoComplete="off" spellCheck={false} /></label>
        <label>{t('your_name')}<input {...f('name')} required autoComplete="username" /></label>
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
  const [folders, setFolders] = useState<FolderSummary[]>([])
  const load = () => get<{ folders: FolderSummary[] }>('/folders').then((r) => setFolders(r.folders.filter((f) => f.registered)), () => {})
  useEffect(() => { load() }, [])
  return (
    <div className="card">
      <h1>{t('setup_step_folders')}</h1>
      <p className="muted">{t('setup_folders_intro')}</p>
      <RegisterForm onDone={load} />
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
