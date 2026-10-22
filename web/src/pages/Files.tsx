// Files: the people's read-only file view (plan 5.2 "웹 파일 보기", like a drive): folder tree, breadcrumb, list or
// grid, sort, search over names and text, a detail panel with "who can see", extracted text and download.
// Everything shown comes from /api/files* and /api/search, which decide per person with the same policy as agents
// (R1). Nothing a file holds is rendered as HTML here: names, snippets and text are React text; downloads are
// attachments served with a generic type.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { NAME } from '../../../src/brand'
import { ApiError, get } from '../api'
import { go } from '../App'
import { fmtDate, getLocale, useLocale } from '../i18n'
import { Badge } from '../ui'
import { ft } from './files-i18n'
import './files.css'

// ---------- shapes (src/web/files.ts) ----------
export interface FileItem { name: string; path: string; kind: 'file' | 'folder'; size: number | null; mtime: number | null; ext: string | null; has_text: boolean; readable: boolean }
interface Listing { path: string; readable?: boolean; entries: FileItem[]; drafts?: number }
interface Who {
  path: string; folder: string; restricted: boolean; personal_owner?: string | null
  flags?: { no_ai: boolean; quarantine: boolean; widened_pending: boolean }
  ai?: { blocked: boolean; people: string[]; groups: string[] }; web?: string[]
  nas?: { mode: 'all' | 'unknown' | 'chosen'; people: string[] | null }
}
interface Hit { path: string; name: string; kind: 'file' | 'folder'; size: number | null; mtime: number | null; name_match: boolean; snippets: { line: number; text: string }[] }
interface SearchResult { q: string; path: string; results: Hit[]; more: boolean; partial: boolean }
interface TextResult { path: string; extracted: boolean; text: string; truncated: boolean }

// ---------- routes: #/files?p=<path>&q=<query>&s=<selected path> ----------
export function filesRoute(path: string, extra: { q?: string; s?: string } = {}) {
  const p = new URLSearchParams()
  if (path && path !== '/') p.set('p', path)
  if (extra.q) p.set('q', extra.q)
  if (extra.s) p.set('s', extra.s)
  const qs = p.toString()
  return '/files' + (qs ? '?' + qs : '')
}
function parseRoute(route: string) {
  const i = route.indexOf('?')
  const p = new URLSearchParams(i >= 0 ? route.slice(i + 1) : '')
  const path = (p.get('p') || '/').normalize('NFC')
  return { path: path.startsWith('/') ? path : '/' + path, q: p.get('q') ?? '', sel: p.get('s') }
}
const enc = encodeURIComponent
const parentOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/'
const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1)
const show = (s: string) => s.normalize('NFC')

function errorText(e: unknown) { return e instanceof ApiError && e.status === 404 ? ft('not_found') : e instanceof ApiError && e.status !== 500 ? e.message : ft('error') }

// ---------- presentation helpers ----------
export function fmtSize(n: number | null | undefined): string {
  if (n == null) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n, u = 0
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++ }
  return `${new Intl.NumberFormat(getLocale() === 'ko' ? 'ko-KR' : 'en', { maximumFractionDigits: u === 0 || v >= 100 ? 0 : 1 }).format(v)} ${units[u]}`
}

const ICONS: [string[], string, string][] = [
  [['pdf'], '📕', 'pdf'], [['doc', 'docx', 'hwp', 'hwpx', 'odt', 'rtf', 'pages'], '📘', 'doc'], [['xls', 'xlsx', 'csv', 'tsv', 'ods', 'numbers'], '📗', 'sheet'],
  [['ppt', 'pptx', 'odp', 'key'], '📙', 'slides'], [['md', 'markdown', 'txt', 'log', 'json', 'xml', 'yaml', 'yml', 'ini', 'toml'], '📄', 'text'],
  [['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'bmp', 'tif', 'tiff', 'svg'], '🖼️', 'image'], [['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz'], '🗜️', 'archive'],
  [['mp3', 'wav', 'm4a', 'flac', 'aac', 'ogg'], '🎵', 'audio'], [['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v'], '🎬', 'video'],
  [['js', 'ts', 'py', 'sh', 'sql', 'css', 'html', 'htm'], '🧾', 'code'],
]
function iconOf(it: { kind: string; ext?: string | null; name: string }): { icon: string; type: string } {
  if (it.kind === 'folder') return { icon: '📁', type: 'folder' }
  const ext = (it.ext ?? /\.([^.]+)$/.exec(it.name)?.[1] ?? '').toLowerCase()
  for (const [exts, icon, type] of ICONS) if (exts.includes(ext)) return { icon, type }
  return { icon: '📄', type: 'other' }
}
const Icon = ({ it, big }: { it: { kind: string; ext?: string | null; name: string }; big?: boolean }) => {
  const { icon, type } = iconOf(it)
  return <span className={`fv-icon fv-t-${type} ${big ? 'big' : ''}`} aria-hidden="true">{icon}</span>
}

/** The query marked inside a text, as React text (never HTML). */
function Marked({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>
  const lower = text.toLocaleLowerCase(), ql = q.toLocaleLowerCase()
  const out: ReactNode[] = []
  let i = 0
  for (let at = lower.indexOf(ql); at >= 0 && ql; at = lower.indexOf(ql, i)) {
    if (at > i) out.push(text.slice(i, at))
    out.push(<mark key={at}>{text.slice(at, at + q.length)}</mark>)
    i = at + q.length
  }
  out.push(text.slice(i))
  return <>{out}</>
}

function useStored<T extends string>(key: string, initial: T, allowed: readonly T[]): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => { try { const s = localStorage.getItem(key) as T | null; return s && allowed.includes(s) ? s : initial } catch { return initial } })
  return [v, (n: T) => { setV(n); try { localStorage.setItem(key, n) } catch { /* storage blocked */ } }]
}

type SortKey = 'name' | 'date' | 'size'
const collator = () => new Intl.Collator(getLocale() === 'ko' ? 'ko' : 'en', { numeric: true, sensitivity: 'base' })
function sorted(items: FileItem[], key: SortKey, desc: boolean): FileItem[] {
  const c = collator()
  const dir = desc ? -1 : 1
  return [...items].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1 // folders first, whatever the order
    const byName = c.compare(a.name, b.name)
    if (key === 'date') return ((a.mtime ?? 0) - (b.mtime ?? 0)) * dir || byName
    if (key === 'size') return ((a.size ?? 0) - (b.size ?? 0)) * dir || byName
    return byName * dir
  })
}

// ---------- the page ----------
export function Files({ route }: { route: string }) {
  useLocale()
  const { path, q, sel } = parseRoute(route)
  const [listing, setListing] = useState<Listing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState<SearchResult | null>(null)
  const [searching, setSearching] = useState(false)
  const [selected, setSelected] = useState<FileItem | null>(null)
  const [cursor, setCursor] = useState(0)
  const [view, setView] = useStored<'list' | 'grid'>(`${NAME}.files.view`, 'list', ['list', 'grid'])
  const [sortKey, setSortKey] = useStored<SortKey>(`${NAME}.files.sort`, 'name', ['name', 'date', 'size'])
  const [order, setOrder] = useStored<'asc' | 'desc'>(`${NAME}.files.order`, 'asc', ['asc', 'desc'])
  const [treeOpen, setTreeOpen] = useState(false)
  const [reloadN, setReloadN] = useState(0)
  const [drafts, setDrafts] = useState<number | null>(null)
  const listRef = useRef<HTMLUListElement>(null)

  // folder listing
  useEffect(() => {
    if (q) return
    let live = true
    setListing(null); setError(null); setSelected(null); setCursor(0)
    get<Listing>('/files?path=' + enc(path)).then((l) => {
      if (!live) return
      setListing(l)
      if (l.drafts != null) setDrafts(l.drafts)
      const s = sel ? l.entries.find((x) => x.path === sel) : null
      if (s) setSelected(s)
    }, (e) => live && setError(errorText(e)))
    return () => { live = false }
  }, [path, q, reloadN, sel])

  // search
  useEffect(() => {
    if (!q) { setSearch(null); return }
    let live = true
    setSearching(true); setSearch(null); setError(null); setSelected(null); setCursor(0)
    get<SearchResult>(`/search?q=${enc(q)}&path=${enc(path)}`).then((r) => live && setSearch(r), (e) => live && setError(errorText(e))).finally(() => live && setSearching(false))
    return () => { live = false }
  }, [path, q, reloadN])

  const items = useMemo(() => listing ? sorted(listing.entries, sortKey, order === 'desc') : [], [listing, sortKey, order])
  const hits = search?.results ?? []
  // keep the keyboard cursor on the selected item (a search result opens its folder with the file selected)
  useEffect(() => {
    const i = selected ? items.findIndex((x) => x.path === selected.path) : -1
    if (i >= 0) setCursor(i)
  }, [selected, items])

  const openItem = useCallback((it: FileItem | Hit) => {
    if (it.kind === 'folder') { go(filesRoute(it.path)); return }
    if (q) { go(filesRoute(parentOf(it.path), { s: it.path })); return }
    setSelected(it as FileItem)
  }, [q])

  const moveTo = (i: number, n: number) => {
    const k = Math.max(0, Math.min(n - 1, i))
    setCursor(k)
    if (!q && items[k]) setSelected(items[k]!)
    document.getElementById(`fv-item-${k}`)?.scrollIntoView({ block: 'nearest' })
  }
  const onKey = (e: KeyboardEvent<HTMLUListElement>) => {
    const n = q ? hits.length : items.length
    if (!n && e.key !== 'Backspace') return
    const cols = view === 'grid' && !q && listRef.current ? Math.max(1, getComputedStyle(listRef.current).gridTemplateColumns.split(' ').length) : 1
    switch (e.key) {
      case 'ArrowDown': moveTo(cursor + cols, n); break
      case 'ArrowUp': moveTo(cursor - cols, n); break
      case 'ArrowRight': if (cols > 1) moveTo(cursor + 1, n); else return; break
      case 'ArrowLeft': if (cols > 1) moveTo(cursor - 1, n); else return; break
      case 'Home': moveTo(0, n); break
      case 'End': moveTo(n - 1, n); break
      case 'Enter': { const it = q ? hits[cursor] : items[cursor]; if (it) openItem(it); break }
      case 'Backspace': if (path !== '/' && !q) go(filesRoute(parentOf(path))); else return; break
      case 'Escape': if (selected) setSelected(null); else return; break
      default: return
    }
    e.preventDefault()
  }

  const crumbs = path === '/' ? [] : path.slice(1).split('/')
  const where = path === '/' ? ft('home') : show(path)

  return (
    <div className={`fv ${selected ? 'with-detail' : ''}`}>
      <aside className={`fv-side ${treeOpen ? 'open' : ''}`} aria-label={ft('folders')}>
        <Tree current={path} drafts={drafts} onPick={() => setTreeOpen(false)} />
      </aside>
      {treeOpen && <div className="fv-scrim" onClick={() => setTreeOpen(false)} />}

      <section className="fv-main">
        <div className="fv-bar">
          <button type="button" className="btn small fv-tree-toggle" aria-expanded={treeOpen} onClick={() => setTreeOpen(!treeOpen)}>☰ {ft('show_folders')}</button>
          <nav className="fv-crumbs" aria-label="breadcrumb">
            <a href={'#' + filesRoute('/')} className={crumbs.length ? '' : 'here'}>{ft('home')}</a>
            {crumbs.map((c, i) => {
              const to = '/' + crumbs.slice(0, i + 1).join('/')
              return <span key={to}><span className="sep" aria-hidden="true">›</span>{i === crumbs.length - 1 ? <span className="here" aria-current="page">{show(c)}</span> : <a href={'#' + filesRoute(to)}>{show(c)}</a>}</span>
            })}
          </nav>
        </div>

        <div className="fv-tools">
          <SearchBox key={path + '|' + q} path={path} q={q} />
          {!q && <div className="fv-view">
            <label className="fv-sort"><span className="sr">{ft('sort_by')}</span>
              <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)} aria-label={ft('sort_by')}>
                <option value="name">{ft('sort_name')}</option><option value="date">{ft('sort_date')}</option><option value="size">{ft('sort_size')}</option>
              </select>
            </label>
            <button type="button" className="btn small" onClick={() => setOrder(order === 'asc' ? 'desc' : 'asc')} title={order === 'asc' ? ft('sort_asc') : ft('sort_desc')} aria-label={order === 'asc' ? ft('sort_asc') : ft('sort_desc')}>{order === 'asc' ? '↑' : '↓'}</button>
            <div className="seg-btns" role="group">
              <button type="button" className={`btn small ${view === 'list' ? 'on' : ''}`} aria-pressed={view === 'list'} onClick={() => setView('list')} title={ft('view_list')}>☰<span className="sr">{ft('view_list')}</span></button>
              <button type="button" className={`btn small ${view === 'grid' ? 'on' : ''}`} aria-pressed={view === 'grid'} onClick={() => setView('grid')} title={ft('view_grid')}>▦<span className="sr">{ft('view_grid')}</span></button>
            </div>
          </div>}
        </div>

        {error && <div className="fv-state" role="alert"><p>{error}</p><button type="button" className="btn small" onClick={() => setReloadN(reloadN + 1)}>{ft('retry')}</button>{path !== '/' && <a className="btn small" href={'#' + filesRoute('/')}>{ft('home')}</a>}</div>}

        {q ? (
          searching ? <p className="muted">{ft('search')}…</p> : search && <>
            <p className="fv-results-head">{ft('results_for', { q, folder: where })} {path !== '/' && <a href={'#' + filesRoute('/', { q })}>{ft('search_everywhere')}</a>}</p>
            {search.partial && <p className="warn small">{ft('results_partial')}</p>}
            {hits.length === 0 ? <div className="fv-state"><p>{ft('results_none')}</p></div> : (
              <ul className="fv-hits" role="listbox" tabIndex={0} aria-label={ft('results_for', { q, folder: where })} onKeyDown={onKey} ref={listRef}
                aria-activedescendant={hits[cursor] ? `fv-item-${cursor}` : undefined}>
                {hits.map((h, i) => (
                  <li key={h.path} id={`fv-item-${i}`} role="option" aria-selected={i === cursor} className={i === cursor ? 'cursor' : ''}
                    onClick={() => { setCursor(i); openItem(h) }}>
                    <Icon it={{ kind: h.kind, name: h.name }} />
                    <div className="fv-hit-main">
                      <div className="fv-name"><Marked text={show(h.name)} q={h.name_match ? q : ''} />{h.name_match && <Badge>{ft('name_match')}</Badge>}</div>
                      <div className="muted small fv-path">{ft('in_folder', { folder: show(parentOf(h.path)) })}{h.mtime != null && <> · {fmtDate(h.mtime)}</>}{h.size != null && <> · {fmtSize(h.size)}</>}</div>
                      {h.snippets.map((s) => <div key={s.line} className="fv-snippet"><span className="muted">{ft('line_n', { n: s.line })}</span> <Marked text={s.text} q={q} /></div>)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {search.more && <p className="muted small">{ft('results_more', { n: hits.length })}</p>}
          </>
        ) : !listing && !error ? <p className="muted">…</p> : listing && <>
          {path === '/' && (
            <a className="fv-drafts" href="#/drafts" title={ft('my_drafts_help')}>
              <span className="fv-icon" aria-hidden="true">🗂️</span>
              <span><span className="fv-name">{drafts ? ft('my_drafts_n', { n: drafts }) : ft('my_drafts')}</span><span className="muted small"> · {ft('my_drafts_help')}</span></span>
            </a>
          )}
          {listing.readable === false && <p className="muted small fv-note">{ft('bare_folder')}</p>}
          {items.length === 0 ? <div className="fv-state"><p>{path === '/' ? ft('empty_root') : ft('empty_folder')}</p></div> : <>
            {view === 'list' && <div className="fv-cols muted small" aria-hidden="true"><span>{ft('col_name')}</span><span>{ft('col_modified')}</span><span>{ft('col_size')}</span></div>}
            <ul className={`fv-items ${view}`} role="listbox" tabIndex={0} aria-label={where} onKeyDown={onKey} ref={listRef}
              aria-activedescendant={items[cursor] ? `fv-item-${cursor}` : undefined}>
              {items.map((it, i) => (
                <li key={it.path} id={`fv-item-${i}`} role="option" aria-selected={selected?.path === it.path}
                  className={`${i === cursor ? 'cursor' : ''} ${selected?.path === it.path ? 'sel' : ''}`}
                  onClick={() => { setCursor(i); setSelected(it) }} onDoubleClick={() => openItem(it)}>
                  <Icon it={it} big={view === 'grid'} />
                  <span className="fv-name" title={show(it.name)}>
                    {it.kind === 'folder' ? <a href={'#' + filesRoute(it.path)} onClick={(e) => e.stopPropagation()} tabIndex={-1}>{show(it.name)}</a> : show(it.name)}
                  </span>
                  <span className="fv-date muted small">{it.mtime != null ? fmtDate(it.mtime) : '—'}</span>
                  <span className="fv-size muted small">{it.kind === 'folder' ? '—' : fmtSize(it.size)}</span>
                </li>
              ))}
            </ul>
            <p className="muted small fv-kbd">{ft('keyboard_help')}</p>
          </>}
        </>}
      </section>

      {selected && <Detail key={selected.path} item={selected} onClose={() => { setSelected(null); listRef.current?.focus() }} />}
    </div>
  )
}

// ---------- search box ----------
function SearchBox({ path, q }: { path: string; q: string }) {
  const [v, setV] = useState(q)
  return (
    <form className="fv-search" role="search" onSubmit={(e) => { e.preventDefault(); const s = v.trim(); go(filesRoute(path, s ? { q: s } : {})) }}>
      <input type="search" value={v} onChange={(e) => setV(e.target.value)} placeholder={path === '/' ? ft('search_placeholder') : ft('search_in', { folder: show(baseName(path)) })}
        aria-label={ft('search_placeholder')} maxLength={200} />
      <button type="submit" className="btn small primary">{ft('search')}</button>
      {q && <button type="button" className="btn small ghost" onClick={() => go(filesRoute(path))}>{ft('clear')}</button>}
    </form>
  )
}

// ---------- folder tree (lazy: a folder's children load when it opens) ----------
function Tree({ current, drafts, onPick }: { current: string; drafts: number | null; onPick: () => void }) {
  const [kids, setKids] = useState<Record<string, FileItem[] | 'error'>>({})
  const [open, setOpen] = useState<Set<string>>(() => new Set(['/']))
  const loading = useRef(new Set<string>())
  const load = useCallback((p: string) => {
    if (loading.current.has(p)) return
    loading.current.add(p)
    get<Listing>('/files?path=' + enc(p)).then(
      (l) => setKids((k) => ({ ...k, [p]: sorted(l.entries.filter((x) => x.kind === 'folder'), 'name', false) })),
      () => setKids((k) => ({ ...k, [p]: 'error' })))
  }, [])
  // open the way down to the current folder
  useEffect(() => {
    const chain = ['/']
    if (current !== '/') current.slice(1).split('/').forEach((_, i, a) => chain.push('/' + a.slice(0, i + 1).join('/')))
    setOpen((o) => { const n = new Set(o); chain.forEach((c) => n.add(c)); return n })
    chain.forEach(load)
  }, [current, load])
  const toggle = (p: string) => setOpen((o) => { const n = new Set(o); if (n.has(p)) n.delete(p); else { n.add(p); load(p) } return n })

  const render = (p: string, depth: number): ReactNode => {
    const k = kids[p]
    if (!open.has(p)) return null
    if (k === undefined) return <li className="muted small" style={{ paddingLeft: `${depth * 0.9 + 1.6}rem` }}>…</li>
    if (k === 'error') return null
    return k.map((f) => (
      <li key={f.path}>
        <div className={`fv-tree-row ${f.path === current ? 'here' : ''}`} style={{ paddingLeft: `${depth * 0.9 + 0.2}rem` }}>
          <button type="button" className="fv-caret" aria-label={open.has(f.path) ? '−' : '+'} aria-expanded={open.has(f.path)} onClick={() => toggle(f.path)}>{open.has(f.path) ? '▾' : '▸'}</button>
          <a href={'#' + filesRoute(f.path)} onClick={onPick} aria-current={f.path === current ? 'page' : undefined}>
            <span aria-hidden="true">📁</span> {show(f.name)}
          </a>
        </div>
        {open.has(f.path) && <ul>{render(f.path, depth + 1)}</ul>}
      </li>
    ))
  }
  return (
    <nav className="fv-tree">
      <ul>
        <li><div className={`fv-tree-row ${current === '/' ? 'here' : ''}`}><a href={'#' + filesRoute('/')} onClick={onPick}><span aria-hidden="true">🏠</span> {ft('home')}</a></div>
          <ul>{render('/', 1)}</ul>
        </li>
        <li className="fv-tree-drafts"><div className="fv-tree-row"><a href="#/drafts" onClick={onPick}><span aria-hidden="true">🗂️</span> {drafts ? ft('my_drafts_n', { n: drafts }) : ft('my_drafts')}</a></div></li>
      </ul>
    </nav>
  )
}

// ---------- detail panel ----------
function Detail({ item, onClose }: { item: FileItem; onClose: () => void }) {
  const [who, setWho] = useState<Who | null>(null)
  const [whoErr, setWhoErr] = useState<string | null>(null)
  const [textOpen, setTextOpen] = useState(false)
  useEffect(() => {
    let live = true
    get<Who>('/files/who?path=' + enc(item.path)).then((w) => live && setWho(w), (e) => live && setWhoErr(errorText(e)))
    return () => { live = false }
  }, [item.path])
  return (
    <aside className="fv-detail" aria-label={show(item.name)}>
      <header>
        <Icon it={item} big />
        <h2 title={show(item.name)}>{show(item.name)}</h2>
        <button type="button" className="btn small ghost" onClick={onClose} aria-label={ft('close')}>✕</button>
      </header>
      <div className="fv-actions">
        {item.kind === 'file'
          ? <>
            <a className="btn primary" href={'/api/files/download?path=' + enc(item.path)} download>{ft('download')}</a>
            {item.has_text && <button type="button" className="btn" onClick={() => setTextOpen(true)}>{ft('view_text')}</button>}
          </>
          : <a className="btn primary" href={'#' + filesRoute(item.path)}>{ft('open')}</a>}
      </div>
      <dl className="fv-facts">
        <dt>{ft('kind')}</dt><dd>{item.kind === 'folder' ? ft('folder') : `${ft('file')}${item.ext ? ' · ' + item.ext.toUpperCase() : ''}`}</dd>
        {item.kind === 'file' && <><dt>{ft('size')}</dt><dd>{fmtSize(item.size)} <span className="muted small">({(item.size ?? 0).toLocaleString()} B)</span></dd></>}
        {item.mtime != null && <><dt>{ft('modified')}</dt><dd>{fmtDate(item.mtime)}</dd></>}
        <dt>{ft('location')}</dt><dd className="mono small fv-path"><a href={'#' + filesRoute(parentOf(item.path))}>{show(parentOf(item.path))}</a></dd>
        {item.kind === 'file' && <><dt>{ft('contains_text')}</dt><dd>{item.has_text ? <Badge kind="ok">{ft('contains_text')}</Badge> : <span className="muted">{ft('no_text')}</span>}</dd></>}
      </dl>
      <section className="fv-who">
        <h3>{ft('who_title')}</h3>
        {whoErr ? <p className="muted small">{whoErr}</p> : !who ? <p className="muted small">…</p> : <WhoView who={who} />}
      </section>
      {textOpen && <TextViewer item={item} onClose={() => setTextOpen(false)} />}
    </aside>
  )
}

const Names = ({ names }: { names: string[] }) => names.length ? <div className="chips">{names.map((n) => <span key={n} className="chip">{n}</span>)}</div> : <span className="muted small">{ft('who_none')}</span>

function WhoView({ who }: { who: Who }) {
  if (who.restricted) return <p className="muted small">{ft('who_restricted')}</p>
  const closed = !!(who.flags?.quarantine || who.flags?.widened_pending)
  return (
    <div className="fv-who-body">
      {who.personal_owner && <p><Badge kind="accent">{ft('who_owner', { name: who.personal_owner })}</Badge></p>}
      <div><div className="fv-who-k">{ft('who_ai')}</div>
        {who.ai?.blocked ? <p className="small warn">{closed ? ft('who_blocked_closed') : ft('who_blocked_no_ai')}</p>
          : <>{who.ai && who.ai.groups.length > 0 && <div className="chips">{who.ai.groups.map((g) => <span key={g} className="chip group">@{g}</span>)}</div>}<Names names={who.ai?.people ?? []} /></>}
      </div>
      {who.flags?.no_ai && !closed && <div><div className="fv-who-k">{ft('who_web')}</div><Names names={who.web ?? []} /></div>}
      <div><div className="fv-who-k">{ft('who_nas')}</div>
        {who.nas?.mode === 'all' ? <span className="small">{ft('who_nas_all')}</span> : who.nas?.mode === 'unknown' ? <span className="small muted">{ft('who_nas_unknown')}</span> : <Names names={who.nas?.people ?? []} />}
      </div>
      <p className="muted small">{ft('who_help')}</p>
    </div>
  )
}

// ---------- extracted text (plain text in a <pre>, never HTML) ----------
function TextViewer({ item, onClose }: { item: FileItem; onClose: () => void }) {
  const [res, setRes] = useState<TextResult | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    let live = true
    get<TextResult>('/files/text?path=' + enc(item.path)).then((r) => live && setRes(r), (e) => {
      if (!live) return
      setErr(e instanceof ApiError && e.code === 'no_text' ? ft('text_none') : e instanceof ApiError && e.code === 'cannot_extract' ? ft('text_failed') : errorText(e))
    })
    closeRef.current?.focus()
    const esc = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onCloseRef.current() } }
    window.addEventListener('keydown', esc)
    return () => { live = false; window.removeEventListener('keydown', esc) }
  }, [item.path])
  // on <body>: the detail panel is its own stacking context on narrow screens
  return createPortal(
    <div className="fv-modal" role="dialog" aria-modal="true" aria-label={ft('text_title', { name: show(item.name) })} onClick={onClose}>
      <div className="fv-modal-box" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>{ft('text_title', { name: show(item.name) })}</h2>
          <a className="btn small" href={'/api/files/download?path=' + enc(item.path)} download>{ft('download')}</a>
          <button type="button" ref={closeRef} className="btn small" onClick={onClose}>{ft('close')}</button>
        </header>
        {res?.extracted && <p className="muted small">{ft('text_extracted')}</p>}
        {res?.truncated && <p className="warn small">{ft('text_truncated')}</p>}
        {err ? <p className="error">{err}</p> : !res ? <p className="muted">…</p> : <pre className="fv-text" tabIndex={0}>{res.text || ft('text_empty')}</pre>}
      </div>
    </div>,
    document.body,
  )
}
