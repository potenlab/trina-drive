// The drive's frame, laid out like Google Drive (plan 2.4): a top bar (the Star Pillar mark and "Trina Drive", the
// team, search, notices, the account menu with "Back to console" in Trina Cloud) and a left sidebar ("+ New", My files
// in Trina Cloud, Team folders with the folder tree, Shared with me, Recent, Skills, AI drafts, Approvals, Trash,
// Connect your AI, Mount as a drive, the admin pages, and team storage). Below 860px the sidebar is a drawer. The pages render in the main area.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { PRODUCT } from '../../../src/brand'
import { api, get, type Me } from '../api'
import { go, useSession } from '../App'
import { LOCALES, setLocale, t, useLocale } from '../i18n'
import { fmtSize } from '../pages/Files'
import { at } from '../pages/approve-i18n'
import { ft } from '../pages/files-i18n'
import { Icon, type IconName } from './Icon'
import { Mark } from './Mark'
import { openNew, useHere } from './store'
import { setTheme, useTheme, type ThemeChoice } from './theme'
import { st } from './SkillsText'
import { Tree, filesHref } from './Tree'

export type Section = 'files' | 'my' | 'recent' | 'trash' | 'shared' | 'skills' | 'drafts' | 'approvals' | 'connect' | 'mount' | 'people' | 'folders' | 'audit' | 'settings' | 'other'

interface Storage { quota: number | null; usage: { total: number } }
let storageCache: Promise<Storage | null> | null = null

export function Shell({ section, filesPath, children }: { section: Section; filesPath: string | null; children: ReactNode }) {
  useLocale()
  const { me } = useSession()
  const [drawer, setDrawer] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => { setDrawer(false) }, [section, filesPath])
  useEffect(() => { if (err) { const h = setTimeout(() => setErr(null), 4000); return () => clearTimeout(h) } }, [err])
  if (!me) return null
  return (
    <div className={`app ${drawer ? 'drawer-open' : ''}`}>
      <TopBar me={me} onMenu={() => setDrawer(!drawer)} />
      <aside className="sb" aria-label={t('nav_main')}>
        <Sidebar me={me} section={section} filesPath={filesPath} onPick={() => setDrawer(false)} onError={setErr} />
      </aside>
      {drawer && <div className="sb-scrim" onClick={() => setDrawer(false)} />}
      <main className="main" id="main">{children}</main>
      <Fab section={section} />
      {err && <div className="fv-toast error-toast" role="alert">{err}</div>}
    </div>
  )
}

/** On a phone the sidebar is a drawer, so "+ New" also floats at the bottom right (as in the Drive app). */
function Fab({ section }: { section: Section }) {
  const here = useHere()
  if ((section !== 'files' && section !== 'my') || !here.files || !here.writable) return null
  return <button type="button" className="fab btn cta" aria-label={ft('new')} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); openNew(r.left - 160, r.top - 170) }}><Icon name="plus" size={26} /></button>
}

// ---------- top bar ----------
function TopBar({ me, onMenu }: { me: Me; onMenu: () => void }) {
  return (
    <header className="tb">
      <button type="button" className="tb-icon tb-menu" onClick={onMenu} aria-label={t('nav_open_menu')}><Icon name="menu" /></button>
      <a className="tb-brand" href="#/files" aria-label={PRODUCT}><Mark size={26} /><span>{PRODUCT}</span></a>
      {me.cloud?.team_name && (me.cloud.console_url
        ? <a className="tb-team" href={me.cloud.console_url} title={t('console_all_teams')}>{me.cloud.team_name}<Icon name="down" size={14} /></a>
        : <span className="tb-team">{me.cloud.team_name}</span>)}
      <TopSearch />
      <div className="tb-right">
        <ThemeButton />
        <a href="#/settings" className="tb-icon tb-bell" title={t('notices')} aria-label={me.unread_notices ? `${t('notices')} (${me.unread_notices})` : t('notices')}>
          <Icon name="bell" />{me.unread_notices > 0 && <span className="dot-count">{me.unread_notices}</span>}
        </a>
        <AccountMenu me={me} />
      </div>
    </header>
  )
}

function TopSearch() {
  const route = window.location.hash.replace(/^#/, '')
  const q0 = route.startsWith('/files') ? new URLSearchParams(route.split('?')[1] ?? '').get('q') ?? '' : ''
  const [v, setV] = useState(q0)
  useEffect(() => setV(q0), [q0])
  return (
    <form className="tb-search" role="search" onSubmit={(e) => { e.preventDefault(); const s = v.trim(); go(s ? '/files?q=' + encodeURIComponent(s) : '/files') }}>
      <Icon name="search" size={18} />
      <input type="search" value={v} onChange={(e) => setV(e.target.value)} placeholder={t('nav_search', { product: PRODUCT })} aria-label={ft('search_placeholder')} maxLength={200} />
      {v && <button type="button" className="tb-clear" aria-label={ft('clear')} onClick={() => { setV(''); if (q0) go('/files') }}><Icon name="close" size={16} /></button>}
    </form>
  )
}

const nextTheme: Record<ThemeChoice, ThemeChoice> = { system: 'dark', dark: 'light', light: 'system' }
function ThemeButton() {
  const th = useTheme()
  const label = t(`theme_${th}`)
  return (
    <button type="button" className="tb-icon tb-theme" onClick={() => setTheme(nextTheme[th])} title={`${t('theme')}: ${label}`} aria-label={`${t('theme')}: ${label}`}>
      <Icon name={th === 'dark' ? 'moon' : th === 'light' ? 'sun' : 'contrast'} />
    </button>
  )
}

function AccountMenu({ me }: { me: Me }) {
  const { setMe } = useSession()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const th = useTheme()
  const locale = useLocale()
  useEffect(() => {
    if (!open) return
    const close = (e: Event) => { if (!(e.target instanceof Node && ref.current?.contains(e.target))) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('mousedown', close); window.addEventListener('keydown', esc)
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', esc) }
  }, [open])
  const consoleUrl = me.cloud?.console_url
  return (
    <div className="acct" ref={ref}>
      <button type="button" className="acct-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} aria-label={t('account_menu', { name: me.name })}>
        {(me.name.trim()[0] ?? '?').toLocaleUpperCase()}
      </button>
      {open && (
        <div className="acct-menu" role="menu">
          <div className="acct-who"><span className="acct-big" aria-hidden="true">{(me.name.trim()[0] ?? '?').toLocaleUpperCase()}</span>
            <span><strong>{me.name}</strong>{me.email && <span className="muted small">{me.email}</span>}{me.admin && <span className="badge badge-accent">{t('admin')}</span>}</span></div>
          {consoleUrl && <a role="menuitem" className="acct-item acct-console" href={consoleUrl}><Icon name="back" size={18} /><span><span>{t('console_back')}</span><span className="muted small">{t('console_back_help')}</span></span></a>}
          <a role="menuitem" className="acct-item" href="#/settings" onClick={() => setOpen(false)}><Icon name="settings" size={18} /><span>{t('nav_settings')}</span></a>
          <a role="menuitem" className="acct-item" href="#/connect" onClick={() => setOpen(false)}><Icon name="spark" size={18} /><span>{t('nav_connect')}</span></a>
          <div className="acct-row" role="group" aria-label={t('theme')}>
            <span className="small muted">{t('theme')}</span>
            <span className="seg-mini">{(['system', 'light', 'dark'] as const).map((c) => <button key={c} type="button" className={th === c ? 'on' : ''} aria-pressed={th === c} onClick={() => setTheme(c)}>{t(`theme_${c}`)}</button>)}</span>
          </div>
          <div className="acct-row">
            <span className="small muted">{t('language')}</span>
            <select className="lang" aria-label={t('language')} value={locale} onChange={(e) => setLocale(e.target.value as 'en' | 'ko')}>
              {LOCALES.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
            </select>
          </div>
          <button type="button" role="menuitem" className="acct-item" onClick={() => api('POST', '/logout').finally(() => { setMe(null); go('/login') })}><Icon name="external" size={18} /><span>{t('sign_out')}</span></button>
        </div>
      )}
    </div>
  )
}

// ---------- sidebar ----------
function Item({ href, icon, label, on, count, onPick, strong }: { href: string; icon: IconName; label: string; on: boolean; count?: number; onPick: () => void; strong?: boolean }) {
  return (
    <a href={href} className={`sb-item ${on ? 'on' : ''} ${strong ? 'sb-strong' : ''}`} aria-current={on ? 'page' : undefined} onClick={onPick}>
      <Icon name={icon} /><span className="sb-label">{label}</span>{count ? <span className="sb-count">{count}</span> : null}
    </a>
  )
}

function Sidebar({ me, section, filesPath, onPick, onError }: { me: Me; section: Section; filesPath: string | null; onPick: () => void; onError: (s: string) => void }) {
  const here = useHere()
  const [treeOpen, setTreeOpen] = useState(true)
  const newRef = useRef<HTMLButtonElement>(null)
  const canNew = (section === 'files' || section === 'my') && here.files && here.writable
  const my = me.myFilesPath ?? null
  const adminRootNew = me.admin && section === 'files' && here.files && here.path === '/' && me.storage === 'managed'
  return (
    <nav className="sb-nav">
      <button ref={newRef} type="button" className="btn cta sb-new" disabled={!canNew && !adminRootNew} aria-haspopup="menu"
        title={!canNew && !adminRootNew ? t('nav_new_disabled') : undefined}
        onClick={(e) => {
          if (adminRootNew && !canNew) { go('/folders?new=1'); onPick(); return }
          const r = e.currentTarget.getBoundingClientRect(); openNew(r.left, r.bottom + 6)
        }}><Icon name="plus" /><span>{ft('new')}</span></button>

      <div className="sb-group">
        {/* Trina Cloud: each member's private folder, first like "My Drive" (absent when self-hosted or not made yet) */}
        {my && <Item href="#/my" icon="user" label={t('nav_my_files')} on={section === 'my'} onPick={onPick} />}
        <div className={`sb-item sb-tree-head ${section === 'files' && filesPath === '/' ? 'on' : ''}`}>
          <button type="button" className={`tr-caret ${treeOpen ? 'open' : ''}`} aria-expanded={treeOpen} aria-label={ft('folders')} onClick={() => setTreeOpen(!treeOpen)}><Icon name="chevron" size={14} /></button>
          <a href={filesHref('/')} onClick={onPick} aria-current={section === 'files' && filesPath === '/' ? 'page' : undefined}><Icon name="drive" /><span className="sb-label">{t('nav_team_folders')}</span></a>
        </div>
        {treeOpen && <Tree current={section === 'files' ? filesPath : null} hide={my} onPick={onPick} onError={onError} />}
        <Item href="#/shared" icon="shared" label={t('swm_title')} on={section === 'shared'} onPick={onPick} />
        <Item href="#/recent" icon="recent" label={t('nav_recent')} on={section === 'recent'} onPick={onPick} />
        <Item href="#/skills" icon="skill" label={st('sk_nav')} on={section === 'skills'} onPick={onPick} />
        <Item href="#/drafts" icon="drafts" label={t('nav_ai_drafts')} on={section === 'drafts'} onPick={onPick} />
        <Item href="#/approvals" icon="approvals" label={at('nav_approvals')} on={section === 'approvals'} count={me.approvals} onPick={onPick} />
        <Item href="#/trash" icon="trash" label={ft('trash')} on={section === 'trash'} onPick={onPick} />
      </div>

      <div className="sb-group">
        <Item href="#/connect" icon="spark" label={t('nav_connect')} on={section === 'connect'} onPick={onPick} strong />
        {me.storage === 'managed' && <Item href="#/mount" icon="mount" label={t('nav_mount')} on={section === 'mount'} onPick={onPick} />}
      </div>

      {me.admin && (
        <div className="sb-group">
          <div className="sb-title">{t('nav_admin')}</div>
          <Item href="#/people" icon="people" label={t('nav_members')} on={section === 'people'} onPick={onPick} />
          <Item href="#/folders" icon="access" label={t('nav_folder_access')} on={section === 'folders'} onPick={onPick} />
          <Item href="#/audit" icon="audit" label={t('nav_audit')} on={section === 'audit'} onPick={onPick} />
          <Item href="#/settings" icon="settings" label={t('nav_settings')} on={section === 'settings'} onPick={onPick} />
        </div>
      )}
      {!me.admin && (
        <div className="sb-group">
          <Item href="#/audit" icon="audit" label={t('nav_audit')} on={section === 'audit'} onPick={onPick} />
          <Item href="#/settings" icon="settings" label={t('nav_settings')} on={section === 'settings'} onPick={onPick} />
        </div>
      )}
      {me.admin && me.storage === 'managed' && <StorageMeter />}
    </nav>
  )
}

function StorageMeter() {
  const [s, setS] = useState<Storage | null>(null)
  useEffect(() => {
    storageCache ??= get<Storage>('/storage').catch(() => null)
    let live = true
    storageCache.then((v) => live && setS(v))
    return () => { live = false }
  }, [])
  if (!s) return null
  const pct = s.quota ? Math.min(100, Math.round((s.usage.total / s.quota) * 100)) : null
  return (
    <a className="sb-storage" href="#/folders" title={t('storage_title')}>
      <span className="sb-storage-head"><Icon name="mount" size={18} /><span>{t('storage_title')}</span></span>
      {pct !== null && <span className="meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={t('storage_title')}><span style={{ width: `${Math.max(pct, 2)}%` }} className={pct >= 90 ? 'full' : ''} /></span>}
      <span className="small muted">{s.quota ? t('storage_of', { used: fmtSize(s.usage.total), quota: fmtSize(s.quota) }) : t('storage_used', { used: fmtSize(s.usage.total) })}</span>
    </a>
  )
}
