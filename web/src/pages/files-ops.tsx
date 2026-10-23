// Changing files in managed storage, the pieces Files.tsx puts together: upload panel, context menu, small dialogs,
// folder picker (move / copy), version history, trash, toasts. Every action is an /api call that the server decides
// with the one policy; the page only offers what the listing says is writable (and shows the server's answer).
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { api, ApiError, get } from '../api'
import { fmtDate } from '../i18n'
import { Badge } from '../ui'
import { FileGlyph } from '../drive/FileGlyph'
import { ft } from './files-i18n'
import { uploads, type UploadItem } from './files-upload'

const enc = encodeURIComponent
const show = (s: string) => s.normalize('NFC')
export function errMsg(e: unknown) { return e instanceof ApiError ? (e.status === 404 ? ft('not_found') : e.message) : ft('error') }
const pct = (it: UploadItem) => it.size ? Math.round((it.loaded / it.size) * 100) : 100
function bytes(n: number) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n, i = 0
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`
}

// ---------- upload panel (bottom right, like a drive) ----------
export function UploadPanel() {
  const items = useSyncExternalStore(uploads.subscribe, uploads.snapshot)
  const [open, setOpen] = useState(true)
  if (!items.length) return null
  const active = items.filter((i) => i.status === 'uploading' || i.status === 'queued').length
  const conflicts = items.filter((i) => i.status === 'conflict')
  return createPortal(
    <section className="fv-uploads" aria-label={ft('uploads_title')} aria-live="polite">
      <header>
        <strong>{active ? ft('uploading_n', { n: active }) : conflicts.length ? ft('exists_n', { n: conflicts.length }) : ft('uploads_done')}</strong>
        <button type="button" className="btn small ghost" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? '▾' : '▴'}</button>
        {!active && <button type="button" className="btn small ghost" onClick={() => uploads.clearFinished()} aria-label={ft('clear_done')}>✕</button>}
      </header>
      {open && <>
        {conflicts.length > 1 && (
          <div className="fv-up-conflicts">
            <span>{ft('exists_n', { n: conflicts.length })}</span>
            <button type="button" className="btn small" onClick={() => uploads.resolve('replace')}>{ft('replace')}</button>
            <button type="button" className="btn small" onClick={() => uploads.resolve('rename')}>{ft('keep_both')}</button>
            <button type="button" className="btn small ghost" onClick={() => uploads.resolve('skip')}>{ft('skip')}</button>
          </div>
        )}
        <ul>
          {items.map((it) => (
            <li key={it.id} className={`st-${it.status}`}>
              <div className="fv-up-name" title={`${show(it.folder)}/${show(it.name)}`}>{show(it.name)}</div>
              <div className="fv-up-state small">
                {it.status === 'uploading' && <><progress max={100} value={pct(it)} aria-label={show(it.name)} /> <span className="muted">{pct(it)}% · {bytes(it.size)}</span>
                  <button type="button" className="linkish" onClick={() => uploads.cancel(it.id)}>{ft('cancel')}</button></>}
                {it.status === 'queued' && <span className="muted">… <button type="button" className="linkish" onClick={() => uploads.cancel(it.id)}>{ft('cancel')}</button></span>}
                {it.status === 'done' && <span className="ok">✓ {bytes(it.size)}</span>}
                {it.status === 'cancelled' && <span className="muted">{ft('cancel')}</span>}
                {it.status === 'error' && <><span className="err">{it.error}</span> <button type="button" className="linkish" onClick={() => uploads.retry(it.id)}>{ft('retry_up')}</button></>}
                {it.status === 'conflict' && <>
                  <span className="warn-text">{ft('up_exists')}</span>
                  <button type="button" className="linkish" onClick={() => uploads.resolve('replace', it.id)}>{ft('replace')}</button>
                  <button type="button" className="linkish" onClick={() => uploads.resolve('rename', it.id)}>{ft('keep_both')}</button>
                  <button type="button" className="linkish" onClick={() => uploads.resolve('skip', it.id)}>{ft('skip')}</button>
                </>}
              </div>
            </li>
          ))}
        </ul>
      </>}
    </section>,
    document.body,
  )
}

// ---------- context menu ----------
export interface MenuAction { label: string; icon?: ReactNode; onClick: () => void; danger?: boolean; hidden?: boolean; kbd?: string }
export function Menu({ x, y, actions, onClose }: { x: number; y: number; actions: MenuAction[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  useEffect(() => {
    const el = ref.current
    if (el) {
      const r = el.getBoundingClientRect()
      setPos({ x: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)), y: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) })
      el.querySelector<HTMLButtonElement>('button')?.focus()
    }
    const close = (e: Event) => { if (!(e.target instanceof Node && el?.contains(e.target))) onClose() }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const bs = [...(el?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
        const i = bs.indexOf(document.activeElement as HTMLButtonElement)
        bs[(i + (e.key === 'ArrowDown' ? 1 : -1) + bs.length) % bs.length]?.focus()
      }
    }
    window.addEventListener('mousedown', close, true)
    window.addEventListener('scroll', onClose, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('resize', onClose)
    return () => { window.removeEventListener('mousedown', close, true); window.removeEventListener('scroll', onClose, true); window.removeEventListener('keydown', key, true); window.removeEventListener('resize', onClose) }
  }, [x, y, onClose])
  return createPortal(
    <div className="fv-menu" role="menu" ref={ref} style={{ left: pos.x, top: pos.y }}>
      {actions.filter((a) => !a.hidden).map((a) => (
        <button key={a.label} type="button" role="menuitem" className={a.danger ? 'danger' : ''} onClick={() => { onClose(); a.onClick() }}>
          <span className="fv-menu-icon" aria-hidden="true">{a.icon}</span><span>{a.label}</span>{a.kbd && <kbd>{a.kbd}</kbd>}
        </button>
      ))}
    </div>,
    document.body,
  )
}

// ---------- dialogs ----------
export function Dialog({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); closeRef.current() } }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [])
  return createPortal(
    <div className="fv-modal" role="dialog" aria-modal="true" aria-label={title} onMouseDown={onClose}>
      <div className={`fv-modal-box fv-dialog ${wide ? 'wide' : ''}`} onMouseDown={(e) => e.stopPropagation()}>
        <header><h2>{title}</h2><button type="button" className="btn small ghost" onClick={onClose} aria-label={ft('close')}>✕</button></header>
        {children}
      </div>
    </div>,
    document.body,
  )
}

/** One name (new folder, rename). The extension stays selected-out when renaming a file. */
export function NameDialog({ title, initial, action, onSubmit, onClose }: { title: string; initial: string; action: string; onSubmit: (name: string) => Promise<void>; onClose: () => void }) {
  const [v, setV] = useState(initial)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    const dot = initial.lastIndexOf('.')
    el.setSelectionRange(0, dot > 0 ? dot : initial.length)
  }, [initial])
  return (
    <Dialog title={title} onClose={onClose}>
      <form onSubmit={async (e) => {
        e.preventDefault()
        if (!v.trim()) return
        setBusy(true); setErr(null)
        try { await onSubmit(v.trim()); onClose() } catch (x) { setErr(errMsg(x)) } finally { setBusy(false) }
      }}>
        <label>{ft('name')}<input ref={ref} value={v} onChange={(e) => setV(e.target.value)} maxLength={255} spellCheck={false} /></label>
        {err && <p className="error" role="alert">{err}</p>}
        <div className="fv-dialog-actions">
          <button type="button" className="btn" onClick={onClose}>{ft('cancel')}</button>
          <button type="submit" className="btn primary" disabled={busy || !v.trim()}>{action}</button>
        </div>
      </form>
    </Dialog>
  )
}

export function ConfirmDialog({ title, text, action, danger, onConfirm, onClose }: { title: string; text: string; action: string; danger?: boolean; onConfirm: () => Promise<void>; onClose: () => void }) {
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  return (
    <Dialog title={title} onClose={onClose}>
      <p>{text}</p>
      {err && <p className="error" role="alert">{err}</p>}
      <div className="fv-dialog-actions">
        <button type="button" className="btn" onClick={onClose} autoFocus>{ft('cancel')}</button>
        <button type="button" className={`btn ${danger ? 'danger' : 'primary'}`} disabled={busy} onClick={async () => {
          setBusy(true); setErr(null)
          try { await onConfirm(); onClose() } catch (x) { setErr(errMsg(x)) } finally { setBusy(false) }
        }}>{action}</button>
      </div>
    </Dialog>
  )
}

// ---------- folder picker (move / copy) ----------
interface PickEntry { name: string; path: string; kind: string; writable?: boolean }
export function FolderPicker({ title, action, start, exclude, onPick, onClose }: { title: string; action: string; start: string; exclude: string[]; onPick: (to: string) => Promise<void>; onClose: () => void }) {
  const [at, setAt] = useState(start)
  const [list, setList] = useState<{ path: string; writable: boolean; entries: PickEntry[] } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    setList(null)
    get<{ path: string; writable: boolean; entries: PickEntry[] }>('/files?path=' + enc(at)).then((l) => live && setList(l), (e) => live && setErr(errMsg(e)))
    return () => { live = false }
  }, [at])
  const inside = (p: string) => exclude.some((x) => p === x || p.startsWith(x + '/'))
  const crumbs = at === '/' ? [] : at.slice(1).split('/')
  return (
    <Dialog title={title} onClose={onClose} wide>
      <nav className="fv-crumbs small">
        <button type="button" className="linkish" onClick={() => setAt('/')}>{ft('home')}</button>
        {crumbs.map((c, i) => <span key={i}><span className="sep">›</span><button type="button" className="linkish" onClick={() => setAt('/' + crumbs.slice(0, i + 1).join('/'))}>{show(c)}</button></span>)}
      </nav>
      <ul className="fv-pick">
        {!list ? <li className="muted">…</li> : list.entries.filter((x) => x.kind === 'folder').length === 0 ? <li className="muted small">{ft('empty_folder')}</li>
          : list.entries.filter((x) => x.kind === 'folder').map((x) => (
            <li key={x.path}>
              <button type="button" disabled={inside(x.path)} onClick={() => setAt(x.path)} className={x.writable ? '' : 'ro'}>
                <FileGlyph type="folder" size={20} /> {show(x.name)} {!x.writable && <span className="muted small">· {ft('read_only_here')}</span>}
              </button>
            </li>
          ))}
      </ul>
      {err && <p className="error" role="alert">{err}</p>}
      <div className="fv-dialog-actions">
        <span className="muted small fv-pick-where">{show(at)}</span>
        <button type="button" className="btn" onClick={onClose}>{ft('cancel')}</button>
        <button type="button" className="btn primary" disabled={busy || !list?.writable || inside(at)} title={list && !list.writable ? ft('cannot_drop_here') : undefined}
          onClick={async () => { setBusy(true); setErr(null); try { await onPick(at); onClose() } catch (e) { setErr(errMsg(e)) } finally { setBusy(false) } }}>{action}</button>
      </div>
    </Dialog>
  )
}

// ---------- version history (detail panel) ----------
interface Version { version: number; size: number; at: number; by: string | null; current: boolean }
/** `onChanged(note)`: the file changed; the page reloads it (and may remount this panel, so it shows the note). */
export function Versions({ path, name, onChanged }: { path: string; name: string; onChanged: (note?: string) => void }) {
  const [v, setV] = useState<{ versions: Version[]; writable: boolean; kept: number } | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [n, setN] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    let live = true
    get<{ versions: Version[]; writable: boolean; kept: number }>('/files/versions?path=' + enc(path)).then((r) => live && setV(r), (e) => live && setMsg(errMsg(e)))
    return () => { live = false }
  }, [path, n])
  return (
    <section className="fv-versions">
      <h3>{ft('versions')}</h3>
      {!v ? <p className="muted small">{msg ?? '…'}</p> : <>
        <ul>
          {v.versions.map((x) => (
            <li key={x.version}>
              <div><strong>{ft('version_n', { n: x.version })}</strong> {x.current && <Badge kind="ok">{ft('version_current')}</Badge>}</div>
              <div className="muted small">{fmtDate(x.at)}{x.by ? ` · ${x.by}` : ''} · {bytes(x.size)}</div>
              {!x.current && <div className="fv-version-actions">
                <a className="linkish" href={`/api/files/versions/download?path=${enc(path)}&v=${x.version}`} download>{ft('download')}</a>
                {v.writable && <button type="button" className="linkish" onClick={async () => {
                  try { const r = await api<{ version: number }>('POST', '/files/versions/restore', { path, version: x.version }); setMsg(ft('version_restored', { n: r.version })); setN(n + 1); onChanged(ft('version_restored', { n: r.version })) } catch (e) { setMsg(errMsg(e)) }
                }}>{ft('restore_version')}</button>}
              </div>}
            </li>
          ))}
        </ul>
        <p className="muted small">{ft('versions_kept', { n: v.kept })}</p>
        {v.writable && <>
          <button type="button" className="btn small" onClick={() => input.current?.click()}>⤒ {ft('new_version')}</button>
          <input ref={input} type="file" hidden onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (!f) return
            const folder = path.slice(0, path.lastIndexOf('/')) || '/'
            uploads.add([{ file: new File([f], name, { type: f.type }), folder }], 'replace')
            const off = uploads.subscribe(() => { if (!uploads.active) { off(); setN((k) => k + 1); onChanged() } })
          }} />
        </>}
        {msg && v && <p className="small ok" role="status">{msg}</p>}
      </>}
    </section>
  )
}

// ---------- trash ----------
interface TrashItem { id: number; name: string; kind: 'file' | 'folder'; from: string; size: number; files: number; deleted_at: number; deleted_by: string | null; purge_after: number; can_restore: boolean }
export function TrashView() {
  const [d, setD] = useState<{ items: TrashItem[]; days: number } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<null | { title: string; text: string; run: () => Promise<void> }>(null)
  const load = () => get<{ items: TrashItem[]; days: number }>('/trash').then(setD, (e) => setErr(errMsg(e)))
  useEffect(() => { load() }, [])
  // f answers the note to show ("Restored to …"), or nothing
  const act = async (f: () => Promise<string | void>) => { try { const m = await f(); setMsg(m || null); setErr(null); await load() } catch (e) { setErr(errMsg(e)) } }
  return (
    <div className="fv-trash">
      <div className="fv-trash-head">
        <h2>{ft('trash')}</h2>
        {d && d.items.some((x) => x.can_restore) && <button type="button" className="btn small danger" onClick={() => setConfirm({ title: ft('empty_trash'), text: ft('confirm_empty'), run: () => api('POST', '/trash/empty').then(load) })}>{ft('empty_trash')}</button>}
      </div>
      {d && <p className="muted small">{ft('trash_help', { days: d.days })}</p>}
      {err && <p className="error" role="alert">{err}</p>}
      {msg && <p className="ok small" role="status">{msg}</p>}
      {!d ? <p className="muted">…</p> : d.items.length === 0 ? <div className="fv-state"><p>{ft('trash_empty')}</p></div> : (
        <ul className="fv-items list fv-trash-list">
          {d.items.map((x) => (
            <li key={x.id}>
              <span className="fv-icon" aria-hidden="true"><FileGlyph type={x.kind === 'folder' ? 'folder' : 'other'} /></span>
              <span className="fv-trash-main">
                <span className="fv-name">{show(x.name)}</span>
                <span className="muted small">{ft('from_folder', { folder: show(x.from) })} · {fmtDate(x.deleted_at)}{x.deleted_by ? ` · ${ft('deleted_by', { name: x.deleted_by })}` : ''} · {x.kind === 'folder' ? ft('items_n', { n: x.files }) : bytes(x.size)} · {ft('gone_after', { date: fmtDate(x.purge_after) })}</span>
              </span>
              <span className="fv-trash-actions">
                {x.can_restore ? <>
                  <button type="button" className="btn small" onClick={() => act(() => api<{ path: string }>('POST', `/trash/${x.id}/restore`).then((r) => ft('restored_to', { path: show(r.path) })))}>{ft('restore')}</button>
                  <button type="button" className="btn small ghost danger-text" onClick={() => setConfirm({ title: ft('delete_forever'), text: ft('confirm_forever', { name: show(x.name) }), run: () => api('DELETE', `/trash/${x.id}`).then(load) })}>{ft('delete_forever')}</button>
                </> : <span className="muted small">{ft('read_only_here')}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {confirm && <ConfirmDialog title={confirm.title} text={confirm.text} action={ft('delete_forever')} danger onConfirm={confirm.run} onClose={() => setConfirm(null)} />}
    </div>
  )
}

// ---------- toast ----------
export interface ToastMsg { text: string; undo?: () => void; error?: boolean }
export function Toast({ msg, onClose }: { msg: ToastMsg; onClose: () => void }) {
  useEffect(() => { const t = setTimeout(onClose, msg.undo ? 8000 : 5000); return () => clearTimeout(t) }, [msg, onClose])
  return createPortal(
    <div className={`fv-toast ${msg.error ? 'error-toast' : ''}`} role="status">
      <span>{msg.text}</span>
      {msg.undo && <button type="button" className="linkish" onClick={() => { msg.undo!(); onClose() }}>{ft('undo')}</button>}
      <button type="button" className="linkish" onClick={onClose} aria-label={ft('close')}>✕</button>
    </div>,
    document.body,
  )
}
