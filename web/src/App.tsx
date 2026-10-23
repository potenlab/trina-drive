// Shell: session state, hash routes (#/folders/3 …; invite and reset secrets live in the #fragment, so they never
// reach a server log or a Referer), header navigation.
import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react'
import { PRODUCT } from '../../src/brand'
import { api, get, setCsrf, whenSignedOut, type Me } from './api'
import { LOCALES, setLocale, t, useLocale } from './i18n'
import { Approvals } from './pages/Approvals'
import { EnrollSecondFactor, SecondFactorSettings } from './pages/SecondFactor'
import { at } from './pages/approve-i18n'
import { Audit } from './pages/Audit'
import { Drafts } from './pages/Drafts'
import { Files } from './pages/Files'
import { ft } from './pages/files-i18n'
import { Folder } from './pages/Folder'
import { Folders } from './pages/Folders'
import { LinkPage, Login, Setup, SsoLanding } from './pages/Auth'
import { Consent, PublicOnly } from './pages/Consent'
import { People } from './pages/People'
import { Settings } from './pages/Settings'
import { Tokens } from './pages/Tokens'
import { takeSetupToken } from './setup-link'
import { Loading } from './ui'

// ---------- routing ----------
const subscribe = (f: () => void) => { window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f) }
export const useRoute = () => useSyncExternalStore(subscribe, () => window.location.hash.replace(/^#/, '') || '/')
export const go = (to: string) => { window.location.hash = to }

// a setup link's token (#token=…): read once before the first render, then dropped from the address bar (setup-link.ts)
const setupToken = takeSetupToken(window.location, window.history)

// ---------- session ----------
interface Session { me: Me | null; setMe: (m: Me | null) => void; refresh: () => void }
const SessionCtx = createContext<Session>({ me: null, setMe: () => {}, refresh: () => {} })
export const useSession = () => useContext(SessionCtx)

export function App() {
  useLocale()
  const route = useRoute()
  const [me, setMe] = useState<Me | null>(null)
  const [ready, setReady] = useState(false)
  const [setupPending, setSetupPending] = useState(false)
  // served on the public address (src/web/public.ts): only sign-in and OAuth consent are there
  const [publicListener, setPublicListener] = useState(false)
  // hosted server: an admin without a second factor enrols first; stays until "Continue" (the recovery codes are shown)
  const [enrolling, setEnrolling] = useState(false)
  useEffect(() => { if (me?.second_factor_required) setEnrolling(true); else if (!me) setEnrolling(false) }, [me])

  const refresh = () => get<{ me: Me; csrf: string }>('/session').then((s) => { setCsrf(s.csrf); setMe(s.me) }, () => setMe(null))
  useEffect(() => {
    whenSignedOut(() => { setMe(null) })
    Promise.all([get<{ setup_pending: boolean; public_listener?: boolean }>('/state').then((s) => { setSetupPending(s.setup_pending); setPublicListener(!!s.public_listener) }, () => {}), refresh()])
      .finally(() => setReady(true))
  }, [])

  if (!ready) return <main className="center"><Loading /></main>
  const ctx = { me, setMe, refresh }

  if (me && (enrolling || me.second_factor_required)) return <SessionCtx.Provider value={ctx}><Bare wide><EnrollSecondFactor onDone={() => setEnrolling(false)} /></Bare></SessionCtx.Provider>
  // OAuth consent (#/oauth/<id>): sign in first if needed, then decide; on both addresses
  const oauthMatch = /^\/oauth\/([A-Za-z0-9_-]{20,64})$/.exec(route)
  if (oauthMatch) return <SessionCtx.Provider value={ctx}><Bare wide>{me ? <Consent rid={oauthMatch[1]!} /> : <Login onDone={() => {}} />}</Bare></SessionCtx.Provider>
  // the public address serves sign-in, consent, the approval inbox and one's own passkeys (RP ID = this host), nothing else
  if (publicListener) {
    const ap = /^\/approvals(?:\/(\d+))?$/.exec(route)
    const page = !me ? <><PublicOnly /><Login onDone={() => {}} /></>
      : ap ? <Approvals id={ap[1] ? Number(ap[1]) : undefined} />
        : route === '/second-factor' ? <SecondFactorSettings />
          : <PublicOnly />
    return <SessionCtx.Provider value={ctx}><Bare wide={!!me && page.type !== PublicOnly}>{page}</Bare></SessionCtx.Provider>
  }
  // Trina Cloud's answer: the drive's second factor after a console pass, or why it failed (workstream B1, pages/Auth.tsx)
  const ssoLanding = /^\/sso-(second|error)\/([^/?#]+)$/.exec(route)
  if (ssoLanding) return <SessionCtx.Provider value={ctx}><Bare><SsoLanding kind={ssoLanding[1] as 'second' | 'error'} value={ssoLanding[2]!} /></Bare></SessionCtx.Provider>
  const linkMatch = /^\/(invite|reset)\/(.+)$/.exec(route)
  if (linkMatch) return <SessionCtx.Provider value={ctx}><Bare><LinkPage kind={linkMatch[1] as 'invite' | 'reset'} token={linkMatch[2]!} /></Bare></SessionCtx.Provider>
  if (route.startsWith('/setup') && (setupPending || me?.admin)) return <SessionCtx.Provider value={ctx}><Bare wide><Setup pending={setupPending} token={setupToken} onDone={() => setSetupPending(false)} /></Bare></SessionCtx.Provider>
  if (!me) {
    if (setupPending) { go('/setup'); return null }
    return <SessionCtx.Provider value={ctx}><Bare><Login /></Bare></SessionCtx.Provider>
  }
  return <SessionCtx.Provider value={ctx}><Shell route={route} /></SessionCtx.Provider>
}

function Bare({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <main className={`bare ${wide ? 'wide' : ''}`}>
      <div className="brand-line"><span className="brand">{PRODUCT}</span><LangSwitch /></div>
      {children}
    </main>
  )
}

function LangSwitch() {
  const l = useLocale()
  return (
    <select className="lang" aria-label={t('language')} value={l} onChange={(e) => setLocale(e.target.value as 'en' | 'ko')}>
      {LOCALES.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
    </select>
  )
}

const NAV: { to: string; key: Parameters<typeof t>[0] }[] = [
  { to: '/folders', key: 'nav_folders' }, { to: '/people', key: 'nav_people' }, { to: '/tokens', key: 'nav_tokens' },
  { to: '/drafts', key: 'nav_drafts' }, { to: '/audit', key: 'nav_audit' }, { to: '/settings', key: 'nav_settings' },
]

function Shell({ route }: { route: string }) {
  const { me, setMe } = useSession()
  const folder = /^\/folders\/(\d+)$/.exec(route)
  const approval = /^\/approvals(?:\/(\d+))?$/.exec(route)
  // the file view is where people land; admins land on folders
  const files = route === '/files' || route.startsWith('/files?') || route === '/trash' || (!me!.admin && !route.startsWith('/approvals') && !NAV.some((n) => route.startsWith(n.to)))
  let page: React.ReactNode
  if (files) page = <Files route={route} />
  else if (folder) page = <Folder id={Number(folder[1])} />
  else if (approval) page = <Approvals id={approval[1] ? Number(approval[1]) : undefined} />
  else if (route === '/people') page = <People />
  else if (route === '/tokens') page = <Tokens />
  else if (route === '/drafts') page = <Drafts />
  else if (route === '/audit') page = <Audit />
  else if (route === '/settings' || route.startsWith('/settings?')) page = <Settings />
  else page = <Folders />
  const active = (to: string) => route === to || route.startsWith(to + '/') || (to === '/folders' && !files && !approval && !NAV.some((n) => route.startsWith(n.to)))
  return (
    <div className="shell">
      <header className="top">
        <a className="brand" href={me!.admin ? '#/folders' : '#/files'}>{PRODUCT}</a>
        <nav className="nav">
          <a href="#/files" className={files ? 'active' : ''}>{ft('nav_files')}</a>
          <a href="#/approvals" className={approval ? 'active' : ''}>{at('nav_approvals')}{(me!.approvals ?? 0) > 0 && <span className="count">{me!.approvals}</span>}</a>
          {NAV.map((n) => <a key={n.to} href={'#' + n.to} className={active(n.to) ? 'active' : ''}>{t(n.key)}</a>)}
        </nav>
        <div className="top-right">
          <a href="#/settings" className="bell" title={t('notices')} aria-label={t('notices')}>
            🔔{me!.unread_notices > 0 && <span className="count">{me!.unread_notices}</span>}
          </a>
          <LangSwitch />
          <button type="button" className="btn small ghost" onClick={() => api('POST', '/logout').finally(() => { setMe(null); go('/login') })}>{t('sign_out')}</button>
        </div>
      </header>
      <main className={`content${files ? ' wide' : ''}`}>{page}</main>
    </div>
  )
}
