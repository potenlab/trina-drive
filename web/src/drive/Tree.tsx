// The sidebar's folder tree under "Team folders" (lazy: a folder's children load when it opens). Folders you may change
// take drops: items dragged from the list are moved there, files from the computer are uploaded there.
import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { api, get } from '../api'
import { getLocale } from '../i18n'
import { errMsg } from '../pages/files-ops'
import { droppedFiles, uploadInto } from '../pages/files-upload'
import { ft } from '../pages/files-i18n'
import { Icon } from './Icon'
import { filesChanged, treeStale } from './store'

interface Entry { name: string; path: string; kind: 'file' | 'folder'; writable?: boolean }
/** Items dragged inside the page (Files.tsx sets it). */
export const DRAG_TYPE = 'application/x-trina-drive-paths'
const enc = encodeURIComponent
const show = (s: string) => s.normalize('NFC')
const parentOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/'
export const filesHref = (p: string) => '#/files' + (p && p !== '/' ? '?p=' + enc(p) : '')

export function Tree({ current, onPick, onError }: { current: string | null; onPick: () => void; onError: (s: string) => void }) {
  const [kids, setKids] = useState<Record<string, Entry[] | 'error'>>({})
  const [open, setOpen] = useState<Set<string>>(() => new Set(['/']))
  const [dropAt, setDropAt] = useState<string | null>(null)
  const loading = useRef(new Set<string>())
  const load = useCallback((p: string, again = false) => {
    if (loading.current.has(p) && !again) return
    loading.current.add(p)
    const c = new Intl.Collator(getLocale() === 'ko' ? 'ko' : 'en', { numeric: true, sensitivity: 'base' })
    get<{ entries: Entry[] }>('/files?path=' + enc(p)).then(
      (l) => setKids((k) => ({ ...k, [p]: l.entries.filter((x) => x.kind === 'folder').sort((a, b) => c.compare(a.name, b.name)) })),
      () => setKids((k) => ({ ...k, [p]: 'error' })))
  }, [])
  // open the way down to the folder on screen
  useEffect(() => {
    if (current == null) { load('/'); return }
    const chain = ['/']
    if (current !== '/') current.slice(1).split('/').forEach((_, i, a) => chain.push('/' + a.slice(0, i + 1).join('/')))
    setOpen((o) => { const n = new Set(o); chain.forEach((c) => n.add(c)); return n })
    chain.forEach((c) => load(c))
  }, [current, load])
  const openRef = useRef(open)
  openRef.current = open
  useEffect(() => treeStale.on(() => openRef.current.forEach((p) => load(p, true))), [load])
  const toggle = (p: string) => setOpen((o) => { const n = new Set(o); if (n.has(p)) n.delete(p); else { n.add(p); load(p) } return n })

  const ours = (dt: DataTransfer) => dt.types.includes(DRAG_TYPE)
  const over = (target: string, ok: boolean) => (e: DragEvent) => {
    if (!ours(e.dataTransfer) && !e.dataTransfer.types.includes('Files')) return
    e.preventDefault(); e.stopPropagation()
    e.dataTransfer.dropEffect = ok ? (ours(e.dataTransfer) ? 'move' : 'copy') : 'none'
    setDropAt(ok ? target : null)
  }
  const drop = (target: string, ok: boolean) => async (e: DragEvent) => {
    e.preventDefault(); e.stopPropagation(); setDropAt(null)
    if (!ok) { onError(ft('cannot_drop_here')); return }
    const dt = e.dataTransfer
    try {
      if (ours(dt)) {
        const paths = (JSON.parse(dt.getData(DRAG_TYPE) || '[]') as string[]).filter((p) => p !== target && parentOf(p) !== target && !target.startsWith(p + '/'))
        if (!paths.length) return
        const r = await api<{ results: { error?: string; message?: string }[] }>('POST', '/files/move', { paths, to: target })
        const bad = r.results.find((x) => x.error)
        if (bad) onError(bad.message ?? bad.error!)
        new Set(paths.map(parentOf)).forEach((f) => filesChanged.send(f))
      } else await uploadInto(target, await droppedFiles(dt))
      filesChanged.send(target)
      openRef.current.forEach((p) => load(p, true))
    } catch (x) { onError(errMsg(x)) }
  }

  const render = (p: string, depth: number): ReactNode => {
    const k = kids[p]
    if (!open.has(p)) return null
    if (k === undefined) return <li className="tr-loading" style={{ paddingLeft: `${depth * 14 + 30}px` }}>…</li>
    if (k === 'error') return null
    return k.map((f) => (
      <li key={f.path}>
        <div className={`tr-row ${f.path === current ? 'here' : ''} ${dropAt === f.path ? 'drop-on' : ''}`} style={{ paddingLeft: `${depth * 14}px` }}
          onDragOver={over(f.path, !!f.writable)} onDragLeave={() => setDropAt((d) => d === f.path ? null : d)} onDrop={drop(f.path, !!f.writable)}>
          <button type="button" className={`tr-caret ${open.has(f.path) ? 'open' : ''}`} aria-label={show(f.name)} aria-expanded={open.has(f.path)} onClick={() => toggle(f.path)}><Icon name="chevron" size={14} /></button>
          <a href={filesHref(f.path)} onClick={onPick} aria-current={f.path === current ? 'page' : undefined} title={show(f.name)}>
            <Icon name="folder" size={18} /><span>{show(f.name)}</span>
          </a>
        </div>
        {open.has(f.path) && <ul>{render(f.path, depth + 1)}</ul>}
      </li>
    ))
  }
  return <ul className="tr" aria-label={ft('folders')}>{render('/', 1)}</ul>
}
