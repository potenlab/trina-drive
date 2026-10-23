// Files: the people's file view (plan 5.2 "웹 파일 보기", like a drive): folder tree, breadcrumb, list or grid, sort,
// search over names and text, a detail panel with "who can see", extracted text and download. In managed storage
// (plan 2.2 "관리 모드") also: upload (drag and drop files and folders, progress), new folder, rename, move (drag onto a
// folder, or Move to…), copy, delete to the trash, version history, multi-select, context menu and keyboard.
// Everything shown comes from /api/files*, /api/search and the managed-storage endpoints, which decide per person with
// the same policy as agents (R1; changes need write). Nothing a file holds is rendered as HTML here: names, snippets
// and text are React text; downloads are attachments served with a generic type.
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { NAME } from '../../../src/brand'
import { api, ApiError, get } from '../api'
import { go } from '../App'
import { fmtDate, getLocale, useLocale } from '../i18n'
import { Badge } from '../ui'
import { ft } from './files-i18n'
import { ConfirmDialog, errMsg, FolderPicker, Menu, NameDialog, Toast, TrashView, UploadPanel, Versions, type MenuAction, type ToastMsg } from './files-ops'
import { droppedFiles, pickedFiles, uploadInto, uploads } from './files-upload'
import { connectGdrive, GdrivePanel, gdriveJobs, gdriveOutcome, importFromGdrive, loadGdrive, useGdrive } from './GDrive'
import { dt } from './drive-i18n'
import './files.css'

// ---------- shapes (src/web/files.ts) ----------
export interface FileItem { name: string; path: string; kind: 'file' | 'folder'; size: number | null; mtime: number | null; ext: string | null; has_text: boolean; readable: boolean; writable?: boolean; managed?: boolean }
interface Listing { path: string; readable?: boolean; writable?: boolean; managed?: boolean; entries: FileItem[]; drafts?: number }
interface Who {
  path: string; folder: string; restricted: boolean; personal_owner?: string | null; managed?: boolean; can_share?: boolean
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
  return { path: path.startsWith('/') ? path : '/' + path, q: p.get('q') ?? '', sel: p.get('s'), trash: route === '/trash' }
}
/** Dragged items inside the page (a move), as opposed to files from the computer (an upload). */
const DRAG_TYPE = 'application/x-trina-drive-paths'
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
type DialogState =
  | { kind: 'newfolder' } | { kind: 'rename'; item: FileItem } | { kind: 'move' | 'copy'; items: FileItem[] } | { kind: 'delete'; items: FileItem[] }

export function Files({ route }: { route: string }) {
  useLocale()
  const { path, q, sel: selParam, trash } = parseRoute(route)
  const [listing, setListing] = useState<Listing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState<SearchResult | null>(null)
  const [searching, setSearching] = useState(false)
  // selection: several paths; the detail panel shows when exactly one is picked
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [anchor, setAnchor] = useState(0)
  const [detailOpen, setDetailOpen] = useState(true)
  const [cursor, setCursor] = useState(0)
  const [view, setView] = useStored<'list' | 'grid'>(`${NAME}.files.view`, 'list', ['list', 'grid'])
  const [sortKey, setSortKey] = useStored<SortKey>(`${NAME}.files.sort`, 'name', ['name', 'date', 'size'])
  const [order, setOrder] = useStored<'asc' | 'desc'>(`${NAME}.files.order`, 'asc', ['asc', 'desc'])
  const [treeOpen, setTreeOpen] = useState(false)
  const [reloadN, setReloadN] = useState(0)
  const [drafts, setDrafts] = useState<number | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; items: FileItem[] } | null>(null)
  const [newMenu, setNewMenu] = useState<{ x: number; y: number } | null>(null)
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [toast, setToast] = useState<ToastMsg | null>(null)
  const [dropAt, setDropAt] = useState<string | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const filesInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)
  const reload = useCallback(() => setReloadN((n) => n + 1), [])

  // a finished upload (or Google Drive import) into the folder on screen refreshes it
  useEffect(() => { uploads.onChanged((folder) => { if (folder === path) reload() }) }, [path, reload])
  useEffect(() => { gdriveJobs.onFinished((folder) => { if (folder === path || folder.startsWith(path === '/' ? '/' : path + '/')) reload() }) }, [path, reload])
  const gd = useGdrive()
  // back from Google's consent page (#/files?p=…&gdrive=connected): say how it went, then drop the marker
  useEffect(() => {
    const o = gdriveOutcome(route)
    if (!o) return
    setToast({ text: o.text, error: o.error })
    void loadGdrive(true)
    go(filesRoute(path))
  }, [route, path])

  // folder listing
  useEffect(() => {
    if (q || trash) return
    let live = true
    setError(null); setMenu(null)
    get<Listing>('/files?path=' + enc(path)).then((l) => {
      if (!live) return
      setListing((old) => {
        // same folder again (after a change): keep what is still there selected
        if (old?.path === l.path) setSel((s) => new Set([...s].filter((p) => l.entries.some((x) => x.path === p))))
        else { setSel(new Set()); setCursor(0) }
        return l
      })
      if (l.drafts != null) setDrafts(l.drafts)
      const s = selParam ? l.entries.find((x) => x.path === selParam) : null
      if (s) { setSel(new Set([s.path])); setDetailOpen(true) }
    }, (e) => { if (live) { setListing(null); setError(errorText(e)) } })
    return () => { live = false }
  }, [path, q, reloadN, selParam, trash])
  useEffect(() => { setListing(null); setSel(new Set()); setCursor(0) }, [path])

  // search
  useEffect(() => {
    if (!q) { setSearch(null); return }
    let live = true
    setSearching(true); setSearch(null); setError(null); setSel(new Set()); setCursor(0)
    get<SearchResult>(`/search?q=${enc(q)}&path=${enc(path)}`).then((r) => live && setSearch(r), (e) => live && setError(errorText(e))).finally(() => live && setSearching(false))
    return () => { live = false }
  }, [path, q, reloadN])

  const items = useMemo(() => listing ? sorted(listing.entries, sortKey, order === 'desc') : [], [listing, sortKey, order])
  const hits = search?.results ?? []
  const writable = !!listing?.writable && !q && !trash
  const chosen = items.filter((x) => sel.has(x.path))
  const selected = chosen.length === 1 && detailOpen ? chosen[0]! : null

  const openItem = useCallback((it: FileItem | Hit) => {
    if (it.kind === 'folder') { go(filesRoute(it.path)); return }
    if (q) { go(filesRoute(parentOf(it.path), { s: it.path })); return }
    setSel(new Set([it.path])); setDetailOpen(true)
  }, [q])

  // ---- selection ----
  const pick = (i: number, how: { toggle?: boolean; range?: boolean } = {}) => {
    const it = items[i]
    if (!it) return
    setCursor(i)
    if (how.range) {
      const [a, b] = [Math.min(anchor, i), Math.max(anchor, i)]
      setSel(new Set(items.slice(a, b + 1).map((x) => x.path)))
    } else if (how.toggle) {
      setSel((s) => { const n = new Set(s); if (n.has(it.path)) n.delete(it.path); else n.add(it.path); return n })
      setAnchor(i)
    } else { setSel(new Set([it.path])); setAnchor(i); setDetailOpen(true) }
  }
  const moveTo = (i: number, n: number, extend = false) => {
    const k = Math.max(0, Math.min(n - 1, i))
    setCursor(k)
    if (!q && items[k]) {
      if (extend) { const [a, b] = [Math.min(anchor, k), Math.max(anchor, k)]; setSel(new Set(items.slice(a, b + 1).map((x) => x.path))) }
      else { setSel(new Set([items[k]!.path])); setAnchor(k) }
    }
    document.getElementById(`fv-item-${k}`)?.scrollIntoView({ block: 'nearest' })
  }

  // ---- actions (the server decides; these only ask) ----
  const report = (r: { results: { error?: string; message?: string }[] }, ok: (n: number) => string) => {
    const bad = r.results.filter((x) => x.error)
    const good = r.results.length - bad.length
    setToast(bad.length ? { text: (good ? ok(good) + ' · ' : '') + ft('errors_n', { n: bad.length, why: bad[0]!.message ?? bad[0]!.error! }), error: true } : { text: ok(good) })
  }
  const doDelete = async (list: FileItem[]) => {
    if (!list.length) return
    try {
      const r = await api<{ results: { trash_id?: number; error?: string; message?: string }[] }>('POST', '/files/delete', { paths: list.map((x) => x.path) })
      const ids = r.results.map((x) => x.trash_id).filter((x): x is number => !!x)
      report(r, (n) => ft('deleted_n', { n }))
      if (ids.length) setToast((t) => t && !t.error ? { ...t, undo: () => { Promise.all(ids.map((id) => api('POST', `/trash/${id}/restore`))).finally(reload) } } : t)
    } catch (e) { setToast({ text: errMsg(e), error: true }) }
    reload()
  }
  const doMove = async (paths: string[], to: string) => {
    try { report(await api('POST', '/files/move', { paths, to }), (n) => ft('moved_n', { n })) } catch (e) { setToast({ text: errMsg(e), error: true }) }
    reload()
  }
  const share = async (p: string) => {
    try { const r = await api<{ folder_id: number }>('POST', '/files/share', { path: p }); go(`/folders/${r.folder_id}`) } catch (e) { setToast({ text: errMsg(e), error: true }) }
  }
  const actionsFor = (list: FileItem[]): MenuAction[] => {
    const one = list.length === 1 ? list[0]! : null
    return [
      { label: ft('open'), icon: '↗', onClick: () => one && openItem(one), hidden: !one },
      { label: ft('download'), icon: '⤓', onClick: () => { if (one) window.location.href = '/api/files/download?path=' + enc(one.path) }, hidden: !one || one.kind !== 'file' },
      { label: ft('rename'), icon: '✎', kbd: 'F2', onClick: () => one && setDialog({ kind: 'rename', item: one }), hidden: !one || !writable },
      { label: ft('move_to'), icon: '→', onClick: () => setDialog({ kind: 'move', items: list }), hidden: !writable },
      { label: ft('copy_to'), icon: '⧉', onClick: () => setDialog({ kind: 'copy', items: list }), hidden: list.some((x) => x.kind !== 'file') || !listing?.managed },
      { label: ft('versions'), icon: '🕘', onClick: () => { setSel(new Set([one!.path])); setDetailOpen(true) }, hidden: !one || one.kind !== 'file' || !listing?.managed },
      { label: ft('who_title'), icon: '👥', onClick: () => { setSel(new Set([one!.path])); setDetailOpen(true) }, hidden: !one },
      { label: ft('delete'), icon: '🗑', kbd: 'Del', danger: true, onClick: () => doDelete(list), hidden: !writable },
    ]
  }
  const openMenu = (x: number, y: number, it: FileItem, i: number) => {
    const list = sel.has(it.path) ? chosen : [it]
    if (!sel.has(it.path)) { setSel(new Set([it.path])); setAnchor(i); setDetailOpen(false) }
    setCursor(i)
    setMenu({ x, y, items: list })
  }

  const onKey = (e: KeyboardEvent<HTMLUListElement>) => {
    const n = q ? hits.length : items.length
    if (!n && e.key !== 'Backspace') return
    const cols = view === 'grid' && !q && listRef.current ? Math.max(1, getComputedStyle(listRef.current).gridTemplateColumns.split(' ').length) : 1
    const mod = e.ctrlKey || e.metaKey
    switch (e.key) {
      case 'ArrowDown': moveTo(cursor + cols, n, e.shiftKey); break
      case 'ArrowUp': moveTo(cursor - cols, n, e.shiftKey); break
      case 'ArrowRight': if (cols > 1) moveTo(cursor + 1, n, e.shiftKey); else return; break
      case 'ArrowLeft': if (cols > 1) moveTo(cursor - 1, n, e.shiftKey); else return; break
      case 'Home': moveTo(0, n, e.shiftKey); break
      case 'End': moveTo(n - 1, n, e.shiftKey); break
      case 'Enter': { const it = q ? hits[cursor] : items[cursor]; if (it) openItem(it); break }
      case ' ': if (!q && items[cursor]) pick(cursor, { toggle: true }); else return; break
      case 'a': case 'A': if (mod && !q) { setSel(new Set(items.map((x) => x.path))); setDetailOpen(false) } else return; break
      case 'F2': if (writable && items[cursor]) setDialog({ kind: 'rename', item: items[cursor]! }); else return; break
      case 'Delete': if (writable && chosen.length) doDelete(chosen); else return; break
      case 'Backspace':
        if (mod && writable && chosen.length) doDelete(chosen) // ⌘⌫ as in Finder
        else if (path !== '/' && !q) go(filesRoute(parentOf(path)))
        else return
        break
      case 'ContextMenu': case 'F10': {
        if (e.key === 'F10' && !e.shiftKey) return
        const it = items[cursor]
        const r = document.getElementById(`fv-item-${cursor}`)?.getBoundingClientRect()
        if (it && r) openMenu(r.left + 40, r.bottom, it, cursor)
        break
      }
      case 'Escape': if (sel.size) setSel(new Set()); else return; break
      default: return
    }
    e.preventDefault()
  }

  // ---- drag and drop: files from the computer (upload) and items inside the page (move) ----
  const isOs = (dt: DataTransfer) => dt.types.includes('Files')
  const isOurs = (dt: DataTransfer) => dt.types.includes(DRAG_TYPE)
  const over = (target: string, ok: boolean) => (e: DragEvent) => {
    if (!isOs(e.dataTransfer) && !isOurs(e.dataTransfer)) return
    e.preventDefault(); e.stopPropagation()
    e.dataTransfer.dropEffect = ok ? (isOurs(e.dataTransfer) ? 'move' : 'copy') : 'none'
    setDropAt(ok ? target : null)
  }
  const drop = (target: string, ok: boolean) => async (e: DragEvent) => {
    e.preventDefault(); e.stopPropagation()
    setDropAt(null)
    if (!ok) { setToast({ text: ft('cannot_drop_here'), error: true }); return }
    const dt = e.dataTransfer
    if (isOurs(dt)) {
      const paths = (JSON.parse(dt.getData(DRAG_TYPE) || '[]') as string[]).filter((p) => p !== target && parentOf(p) !== target)
      if (paths.length) await doMove(paths, target)
      return
    }
    try { await uploadInto(target, await droppedFiles(dt)) } catch (x) { setToast({ text: errMsg(x), error: true }) }
    if (target !== path) reload()
  }
  const dragStart = (it: FileItem) => (e: DragEvent) => {
    if (!writable) { e.preventDefault(); return }
    const list = sel.has(it.path) ? chosen.map((x) => x.path) : [it.path]
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(list))
    e.dataTransfer.setData('text/plain', list.map(show).join('\n'))
    e.dataTransfer.effectAllowed = 'move'
  }

  const crumbs = path === '/' ? [] : path.slice(1).split('/')
  const where = path === '/' ? ft('home') : show(path)
  const newMenuActions: MenuAction[] = [
    { label: ft('new_folder'), icon: '📁', onClick: () => setDialog({ kind: 'newfolder' }) },
    { label: ft('upload_files'), icon: '⤒', onClick: () => filesInput.current?.click() },
    { label: ft('upload_folder'), icon: '🗂', onClick: () => folderInput.current?.click() },
    ...(gd?.enabled ? [{ label: dt('gd_import'), icon: '⇩', onClick: () => {
      const run = gd.connected ? importFromGdrive(path) : connectGdrive(filesRoute(path))
      run.catch((x) => setToast({ text: x instanceof Error && !(x instanceof ApiError) ? x.message : errMsg(x), error: true }))
    } }] : []),
  ]

  return (
    <div className={`fv ${selected && !trash ? 'with-detail' : ''}`}>
      <aside className={`fv-side ${treeOpen ? 'open' : ''}`} aria-label={ft('folders')}>
        <Tree current={trash ? '' : path} drafts={drafts} trash={trash} onPick={() => setTreeOpen(false)} reloadN={reloadN} dropAt={dropAt} over={over} drop={drop} />
      </aside>
      {treeOpen && <div className="fv-scrim" onClick={() => setTreeOpen(false)} />}

      <section className={`fv-main ${dropAt === path && !trash ? 'drop-on' : ''}`}
        onDragOver={!trash && !q ? over(path, writable) : undefined} onDragLeave={(e) => { if (e.currentTarget === e.target) setDropAt(null) }}
        onDrop={!trash && !q ? drop(path, writable) : undefined}>
        <div className="fv-bar">
          <button type="button" className="btn small fv-tree-toggle" aria-expanded={treeOpen} onClick={() => setTreeOpen(!treeOpen)}>☰ {ft('show_folders')}</button>
          {trash ? <nav className="fv-crumbs"><span className="here">{ft('trash')}</span></nav> : (
            <nav className="fv-crumbs" aria-label="breadcrumb">
              <a href={'#' + filesRoute('/')} className={crumbs.length ? '' : 'here'}>{ft('home')}</a>
              {crumbs.map((c, i) => {
                const to = '/' + crumbs.slice(0, i + 1).join('/')
                return <span key={to}><span className="sep" aria-hidden="true">›</span>{i === crumbs.length - 1 ? <span className="here" aria-current="page">{show(c)}</span> : <a href={'#' + filesRoute(to)}>{show(c)}</a>}</span>
              })}
            </nav>
          )}
          {writable && <button type="button" className="btn primary small fv-new" aria-haspopup="menu" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setNewMenu({ x: r.left, y: r.bottom + 4 }) }}>＋ {ft('new')}</button>}
          <input ref={filesInput} type="file" multiple hidden onChange={async (e) => { const f = e.target.files; if (f?.length) { try { await uploadInto(path, pickedFiles(f)) } catch (x) { setToast({ text: errMsg(x), error: true }) } } e.target.value = '' }} />
          <input ref={folderInput} type="file" multiple hidden {...{ webkitdirectory: '', directory: '' }} onChange={async (e) => { const f = e.target.files; if (f?.length) { try { await uploadInto(path, pickedFiles(f)); reload() } catch (x) { setToast({ text: errMsg(x), error: true }) } } e.target.value = '' }} />
        </div>

        {trash ? <TrashView /> : <>
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

        {sel.size > 1 && !q && (
          <div className="fv-selbar" role="toolbar" aria-label={ft('n_selected', { n: sel.size })}>
            <strong>{ft('n_selected', { n: sel.size })}</strong>
            {writable && <button type="button" className="btn small" onClick={() => setDialog({ kind: 'move', items: chosen })}>{ft('move_to')}</button>}
            {listing?.managed && chosen.every((x) => x.kind === 'file') && <button type="button" className="btn small" onClick={() => setDialog({ kind: 'copy', items: chosen })}>{ft('copy_to')}</button>}
            {writable && <button type="button" className="btn small danger" onClick={() => doDelete(chosen)}>{ft('delete')}</button>}
            <button type="button" className="btn small ghost" onClick={() => setSel(new Set())} aria-label={ft('close')}>✕</button>
          </div>
        )}

        {error && <div className="fv-state" role="alert"><p>{error}</p><button type="button" className="btn small" onClick={reload}>{ft('retry')}</button>{path !== '/' && <a className="btn small" href={'#' + filesRoute('/')}>{ft('home')}</a>}</div>}

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
          {path !== '/' && listing.readable !== false && !listing.writable && <p className="muted small fv-note">{listing.managed ? ft('read_only_here') : null}</p>}
          {dropAt === path && <div className="fv-drop-hint" aria-hidden="true">{ft('drop_here', { folder: where })}</div>}
          {items.length === 0 ? <div className={`fv-state ${writable ? 'fv-dropzone' : ''}`}><p>{path === '/' ? ft('empty_root') : writable ? ft('empty_writable') : ft('empty_folder')}</p></div> : <>
            {view === 'list' && <div className="fv-cols muted small" aria-hidden="true"><span>{ft('col_name')}</span><span>{ft('col_modified')}</span><span>{ft('col_size')}</span></div>}
            <ul className={`fv-items ${view}`} role="listbox" aria-multiselectable="true" tabIndex={0} aria-label={where} onKeyDown={onKey} ref={listRef}
              aria-activedescendant={items[cursor] ? `fv-item-${cursor}` : undefined}>
              {items.map((it, i) => {
                const target = it.kind === 'folder' && !!it.writable && !sel.has(it.path)
                return (
                  <li key={it.path} id={`fv-item-${i}`} role="option" aria-selected={sel.has(it.path)}
                    className={`${i === cursor ? 'cursor' : ''} ${sel.has(it.path) ? 'sel' : ''} ${dropAt === it.path ? 'drop-on' : ''}`}
                    draggable={writable} onDragStart={dragStart(it)} onDragEnd={() => setDropAt(null)}
                    onDragOver={it.kind === 'folder' ? over(it.path, target) : undefined} onDrop={it.kind === 'folder' ? drop(it.path, target) : undefined}
                    onDragLeave={() => setDropAt((d) => d === it.path ? null : d)}
                    onClick={(e) => pick(i, { toggle: e.ctrlKey || e.metaKey, range: e.shiftKey })} onDoubleClick={() => openItem(it)}
                    onContextMenu={(e) => { e.preventDefault(); openMenu(e.clientX, e.clientY, it, i) }}>
                    <Icon it={it} big={view === 'grid'} />
                    <span className="fv-name" title={show(it.name)}>
                      {it.kind === 'folder' ? <a href={'#' + filesRoute(it.path)} onClick={(e) => { if (e.ctrlKey || e.metaKey || e.shiftKey) e.preventDefault(); else e.stopPropagation() }} tabIndex={-1} draggable={false}>{show(it.name)}</a> : show(it.name)}
                    </span>
                    <span className="fv-date muted small">{it.mtime != null ? fmtDate(it.mtime) : '—'}</span>
                    <span className="fv-size muted small">{it.kind === 'folder' ? '—' : fmtSize(it.size)}</span>
                    <button type="button" className="fv-more" aria-label={`${ft('more')}: ${show(it.name)}`} tabIndex={-1}
                      onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); openMenu(r.right - 8, r.bottom, it, i) }}>⋮</button>
                  </li>
                )
              })}
            </ul>
            <p className="muted small fv-kbd">{listing.managed ? ft('keyboard_help_edit') : ft('keyboard_help')}</p>
          </>}
        </>}
        </>}
      </section>

      {selected && !trash && <Detail key={selected.path + reloadN} item={selected} managed={!!listing?.managed} writable={writable} onShare={share} onChanged={reload}
        onAction={(a) => a === 'rename' ? setDialog({ kind: 'rename', item: selected }) : a === 'move' ? setDialog({ kind: 'move', items: [selected] }) : doDelete([selected])}
        onClose={() => { setDetailOpen(false); listRef.current?.focus() }} />}

      {menu && <Menu x={menu.x} y={menu.y} actions={actionsFor(menu.items)} onClose={() => setMenu(null)} />}
      {newMenu && <Menu x={newMenu.x} y={newMenu.y} actions={newMenuActions} onClose={() => setNewMenu(null)} />}
      {dialog?.kind === 'newfolder' && <NameDialog title={ft('new_folder')} initial="" action={ft('create')} onClose={() => setDialog(null)}
        onSubmit={async (name) => { const r = await api<{ path: string }>('POST', '/files/folder', { path, name }); reload(); setSel(new Set([r.path])) }} />}
      {dialog?.kind === 'rename' && <NameDialog title={ft('rename')} initial={show(dialog.item.name)} action={ft('save')} onClose={() => setDialog(null)}
        onSubmit={async (name) => { const r = await api<{ path: string }>('POST', '/files/rename', { path: dialog.item.path, name }); reload(); setSel(new Set([r.path])) }} />}
      {(dialog?.kind === 'move' || dialog?.kind === 'copy') && <FolderPicker title={`${dialog.kind === 'move' ? ft('move_to') : ft('copy_to')} — ${dialog.items.length === 1 ? show(dialog.items[0]!.name) : ft('items_n', { n: dialog.items.length })}`}
        action={dialog.kind === 'move' ? ft('move_here') : ft('copy_here')} start={path} exclude={dialog.kind === 'move' ? dialog.items.filter((x) => x.kind === 'folder').map((x) => x.path) : []}
        onClose={() => setDialog(null)}
        onPick={async (to) => {
          const r = await api<{ results: { error?: string; message?: string }[] }>('POST', `/files/${dialog.kind}`, { paths: dialog.items.map((x) => x.path), to })
          report(r, (n) => dialog.kind === 'move' ? ft('moved_n', { n }) : ft('copied_n', { n }))
          reload()
        }} />}
      {dialog?.kind === 'delete' && <ConfirmDialog title={ft('delete')} text={ft('confirm_delete', { n: dialog.items.length })} action={ft('delete')} danger onClose={() => setDialog(null)} onConfirm={() => doDelete(dialog.items)} />}
      {toast && <Toast msg={toast} onClose={() => setToast(null)} />}
      <UploadPanel />
      <GdrivePanel />
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

// ---------- folder tree (lazy: a folder's children load when it opens; folders you may change take drops) ----------
type DropHandler = (target: string, ok: boolean) => (e: DragEvent) => void
function Tree({ current, drafts, trash, onPick, reloadN, dropAt, over, drop }: {
  current: string; drafts: number | null; trash: boolean; onPick: () => void; reloadN: number; dropAt: string | null; over: DropHandler; drop: DropHandler
}) {
  const [kids, setKids] = useState<Record<string, FileItem[] | 'error'>>({})
  const [open, setOpen] = useState<Set<string>>(() => new Set(['/']))
  const loading = useRef(new Set<string>())
  const load = useCallback((p: string, again = false) => {
    if (loading.current.has(p) && !again) return
    loading.current.add(p)
    get<Listing>('/files?path=' + enc(p)).then(
      (l) => setKids((k) => ({ ...k, [p]: sorted(l.entries.filter((x) => x.kind === 'folder'), 'name', false) })),
      () => setKids((k) => ({ ...k, [p]: 'error' })))
  }, [])
  // open the way down to the current folder
  useEffect(() => {
    if (!current) { load('/'); return } // the trash page: the top level still shows
    const chain = ['/']
    if (current !== '/') current.slice(1).split('/').forEach((_, i, a) => chain.push('/' + a.slice(0, i + 1).join('/')))
    setOpen((o) => { const n = new Set(o); chain.forEach((c) => n.add(c)); return n })
    chain.forEach((c) => load(c))
  }, [current, load])
  // after a change (new folder, move, rename) the open branches load again
  const openRef = useRef(open)
  openRef.current = open
  useEffect(() => { if (reloadN) openRef.current.forEach((p) => load(p, true)) }, [reloadN, load])
  const toggle = (p: string) => setOpen((o) => { const n = new Set(o); if (n.has(p)) n.delete(p); else { n.add(p); load(p) } return n })

  const render = (p: string, depth: number): ReactNode => {
    const k = kids[p]
    if (!open.has(p)) return null
    if (k === undefined) return <li className="muted small" style={{ paddingLeft: `${depth * 0.9 + 1.6}rem` }}>…</li>
    if (k === 'error') return null
    return k.map((f) => (
      <li key={f.path}>
        <div className={`fv-tree-row ${f.path === current ? 'here' : ''} ${dropAt === f.path ? 'drop-on' : ''}`} style={{ paddingLeft: `${depth * 0.9 + 0.2}rem` }}
          onDragOver={over(f.path, !!f.writable)} onDrop={drop(f.path, !!f.writable)}>
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
        <li><div className={`fv-tree-row ${trash ? 'here' : ''}`}><a href="#/trash" onClick={onPick} aria-current={trash ? 'page' : undefined}><span aria-hidden="true">🗑️</span> {ft('trash')}</a></div></li>
      </ul>
    </nav>
  )
}

// ---------- detail panel ----------
function Detail({ item, onClose, managed, writable, onShare, onChanged, onAction }: {
  item: FileItem; onClose: () => void; managed: boolean; writable: boolean; onShare: (path: string) => void; onChanged: () => void
  onAction: (a: 'rename' | 'move' | 'delete') => void
}) {
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
        {writable && <>
          <button type="button" className="btn small" onClick={() => onAction('rename')}>{ft('rename')}</button>
          <button type="button" className="btn small" onClick={() => onAction('move')}>{ft('move_to')}</button>
          <button type="button" className="btn small danger" onClick={() => onAction('delete')}>{ft('delete')}</button>
        </>}
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
        {who?.can_share && <button type="button" className="btn small" onClick={() => onShare(item.kind === 'folder' ? item.path : parentOf(item.path))}>👥 {ft('share_settings')}</button>}
      </section>
      {managed && item.kind === 'file' && <Versions path={item.path} name={item.name} onChanged={onChanged} />}
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
      {(who.managed || (who.flags?.no_ai && !closed)) && <div><div className="fv-who-k">{ft('who_web')}</div><Names names={who.web ?? []} /></div>}
      {/* managed storage has no NAS: the folder's rules are the whole answer */}
      {!who.managed && <div><div className="fv-who-k">{ft('who_nas')}</div>
        {who.nas?.mode === 'all' ? <span className="small">{ft('who_nas_all')}</span> : who.nas?.mode === 'unknown' ? <span className="small muted">{ft('who_nas_unknown')}</span> : <Names names={who.nas?.people ?? []} />}
      </div>}
      <p className="muted small">{who.managed ? ft('who_managed') : ft('who_help')}</p>
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
