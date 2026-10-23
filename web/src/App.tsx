// The app: session state and hash routes (#/files?p=…, #/folders/3 …; invite and reset secrets live in the #fragment,
// so they never reach a server log or a Referer). Signed in, every page sits in the drive's frame (drive/Shell.tsx).
import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react'
import { PRODUCT } from '../../src/brand'
import { get, setCsrf, whenSignedOut, type Me } from './api'
import { ConnectAI } from './drive/ConnectAI'
import { Mark } from './drive/Mark'
import { MountPage } from './drive/MountPage'
import { resetShareBackend } from './drive/share-api'
import { SharedWithMe } from './drive/SharedWithMe'
import { Shell, type Section } from './drive/Shell'
import { Skills } from './drive/Skills'
import { LOCALES, setLocale, t, useLocale } from './i18n'
import { Approvals } from './pages/Approvals'
import { EnrollSecondFactor, SecondFactorSettings } from './pages/SecondFactor'
import { Audit } from './pages/Audit'
import { Drafts } from './pages/Drafts'
import { Files } from './pages/Files'
import { Folder } from './pages/Folder'
import { Folders } from './pages/Folders'
import { LinkPage, Login, Setup, SsoLanding } from './pages/Auth'
import { Consent, PublicOnly } from './pages/Consent'
import { People } from './pages/People'
import { Settings } from './pages/Settings'
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
    whenSignedOut(() => { setMe(null); resetShareBackend() })
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
  return <SessionCtx.Provider value={ctx}><DriveShell route={route} /></SessionCtx.Provider>
}

function Bare({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <main className={`bare ${wide ? 'wide' : ''}`}>
      <div className="brand-line"><span className="brand"><Mark size={26} />{PRODUCT}</span><LangSwitch /></div>
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

/** Which page a route shows, and the sidebar entry it lights up. Old addresses (#/tokens, #/admin/…) still work. */
export function routeOf(route: string, admin: boolean): { section: Section; filesPath: string | null } {
  const bare = route.split('?')[0]!
  if (bare === '/files' || bare === '/') {
    const p = new URLSearchParams(route.includes('?') ? route.slice(route.indexOf('?') + 1) : '')
    const path = (p.get('p') || '/').normalize('NFC')
    return { section: 'files', filesPath: p.get('q') ? null : path.startsWith('/') ? path : '/' + path }
  }
  const map: [RegExp, Section][] = [
    [/^\/trash$/, 'trash'], [/^\/shared$/, 'shared'], [/^\/drafts$/, 'drafts'], [/^\/approvals(\/\d+)?$/, 'approvals'],
    [/^\/skills(\/v\/\d+)?$/, 'skills'], [/^\/(connect|tokens)$/, 'connect'], [/^\/mount$/, 'mount'], [/^\/(admin\/)?people$/, 'people'],
    [/^\/(admin\/)?folders(\/\d+)?$/, 'folders'], [/^\/(admin\/)?audit$/, 'audit'], [/^\/settings$/, 'settings'],
  ]
  for (const [re, sec] of map) if (re.test(bare)) return { section: sec, filesPath: null }
  void admin
  return { section: 'files', filesPath: '/' } // anything else: the drive itself
}

function DriveShell({ route }: { route: string }) {
  const { me } = useSession()
  const { section, filesPath } = routeOf(route, !!me?.admin)
  const bare = route.split('?')[0]!
  const folder = /^\/(?:admin\/)?folders\/(\d+)$/.exec(bare)
  const approval = /^\/approvals(?:\/(\d+))?$/.exec(bare)
  let page: React.ReactNode
  switch (section) {
    case 'files': case 'trash': page = <Files route={section === 'files' && !route.startsWith('/files') ? '/files' : route} />; break
    case 'shared': page = <SharedWithMe />; break
    case 'drafts': page = <Drafts />; break
    case 'approvals': page = <Approvals id={approval?.[1] ? Number(approval[1]) : undefined} />; break
    case 'skills': page = <Skills route={bare} />; break
    case 'connect': page = <ConnectAI />; break
    case 'mount': page = <MountPage />; break
    case 'people': page = <People />; break
    case 'folders': page = folder ? <Folder id={Number(folder[1])} /> : <Folders />; break
    case 'audit': page = <Audit />; break
    case 'settings': page = <Settings />; break
    default: page = <Files route="/files" />
  }
  return <Shell section={section} filesPath={filesPath}><div className={section === 'files' || section === 'trash' ? 'content wide' : 'content'}>{page}</div></Shell>
}
