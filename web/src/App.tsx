// Shell: session state, hash routes (#/folders/3 …; invite and reset secrets live in the #fragment, so they never
// reach a server log or a Referer), header navigation.
import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react'
import { api, get, setCsrf, whenSignedOut, type Me } from './api'
import { LOCALES, setLocale, t, useLocale } from './i18n'
import { Audit } from './pages/Audit'
import { Drafts } from './pages/Drafts'
import { Folder } from './pages/Folder'
import { Folders } from './pages/Folders'
import { LinkPage, Login, Setup } from './pages/Auth'
import { People } from './pages/People'
import { Settings } from './pages/Settings'
import { Tokens } from './pages/Tokens'
import { Loading } from './ui'

// ---------- routing ----------
const subscribe = (f: () => void) => { window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f) }
export const useRoute = () => useSyncExternalStore(subscribe, () => window.location.hash.replace(/^#/, '') || '/')
export const go = (to: string) => { window.location.hash = to }

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

  const refresh = () => get<{ me: Me; csrf: string }>('/session').then((s) => { setCsrf(s.csrf); setMe(s.me) }, () => setMe(null))
  useEffect(() => {
    whenSignedOut(() => { setMe(null) })
    Promise.all([get<{ setup_pending: boolean; name: string }>('/state').then((s) => { setSetupPending(s.setup_pending); document.title = s.name }, () => {}), refresh()])
      .finally(() => setReady(true))
  }, [])

  if (!ready) return <main className="center"><Loading /></main>
  const ctx = { me, setMe, refresh }

  const linkMatch = /^\/(invite|reset)\/(.+)$/.exec(route)
  if (linkMatch) return <SessionCtx.Provider value={ctx}><Bare><LinkPage kind={linkMatch[1] as 'invite' | 'reset'} token={linkMatch[2]!} /></Bare></SessionCtx.Provider>
  if (route.startsWith('/setup') && (setupPending || me?.admin)) return <SessionCtx.Provider value={ctx}><Bare wide><Setup pending={setupPending} onDone={() => setSetupPending(false)} /></Bare></SessionCtx.Provider>
  if (!me) {
    if (setupPending) { go('/setup'); return null }
    return <SessionCtx.Provider value={ctx}><Bare><Login /></Bare></SessionCtx.Provider>
  }
  return <SessionCtx.Provider value={ctx}><Shell route={route} /></SessionCtx.Provider>
}

function Bare({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <main className={`bare ${wide ? 'wide' : ''}`}>
      <div className="brand-line"><span className="brand">{document.title || 'shelf'}</span><LangSwitch /></div>
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
  let page: React.ReactNode
  if (folder) page = <Folder id={Number(folder[1])} />
  else if (route === '/people') page = <People />
  else if (route === '/tokens') page = <Tokens />
  else if (route === '/drafts') page = <Drafts />
  else if (route === '/audit') page = <Audit />
  else if (route === '/settings') page = <Settings />
  else page = <Folders />
  const active = (to: string) => route === to || route.startsWith(to + '/') || (to === '/folders' && !NAV.some((n) => route.startsWith(n.to)))
  return (
    <div className="shell">
      <header className="top">
        <a className="brand" href="#/folders">{document.title || 'shelf'}</a>
        <nav className="nav">
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
      <main className="content">{page}</main>
    </div>
  )
}
