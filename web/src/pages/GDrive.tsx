// "Import from Google Drive": connect (Google's consent page, then back here), pick files in Google's Picker, and watch
// the server import them into the folder on screen (src/gdrive). The Picker gets the person's own short-lived access
// token (drive.file: Google grants the app the files picked, nothing else). Shown only when the server has Google
// configured (GET /api/gdrive says enabled).
import { useEffect, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { api, get } from '../api'
import { fmtDate, getLocale } from '../i18n'
import { ErrorLine, errText, useAction } from '../ui'
import './drive.css'
import { dt, type DriveKey } from './drive-i18n'

export interface GdriveStatus { enabled: boolean; readonly?: boolean; folders?: boolean; connected?: boolean; broken?: boolean; email?: string | null; connected_at?: number | null }
interface JobItem { drive_id: string; name: string; folder: string; status: string; path?: string; error?: string; message?: string }
interface Job { id: string; folder: string; state: 'running' | 'done'; total: number; done: number; imported: number; updated: number; unchanged: number; failed: number; items: JobItem[]; error: string | null }

// ---------- status (once per page load; refreshed after connect / disconnect) ----------
let status: GdriveStatus | null = null
let statusP: Promise<GdriveStatus> | null = null
const statusSubs = new Set<() => void>()
export function loadGdrive(force = false): Promise<GdriveStatus> {
  if (!statusP || force) statusP = get<GdriveStatus>('/gdrive').catch(() => ({ enabled: false })).then((s) => { status = s; statusSubs.forEach((f) => f()); return s })
  return statusP
}
export function useGdrive(): GdriveStatus | null {
  const s = useSyncExternalStore((f) => { statusSubs.add(f); return () => statusSubs.delete(f) }, () => status)
  useEffect(() => { void loadGdrive() }, [])
  return s
}

/** Off to Google's consent page; back to `returnPath` (an app route) afterwards. */
export async function connectGdrive(returnPath: string) {
  const r = await api<{ url: string }>('POST', '/gdrive/connect', { return_path: returnPath })
  window.location.href = r.url
}

// ---------- the Picker ----------
declare global { interface Window { gapi?: any; google?: any } }
let pickerLoad: Promise<void> | null = null
function loadPicker(): Promise<void> {
  pickerLoad ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://apis.google.com/js/api.js'
    s.async = true
    s.onload = () => window.gapi.load('picker', { callback: () => resolve(), onerror: () => reject(new Error('picker')) })
    s.onerror = () => { pickerLoad = null; reject(new Error('picker')) }
    document.head.appendChild(s)
  })
  return pickerLoad
}

/** The ids the person picked (null: closed without picking). */
async function pick(): Promise<string[] | null> {
  const t = await get<{ access_token: string; api_key: string; app_id: string; folders: boolean }>('/gdrive/picker')
  await loadPicker()
  const g = window.google.picker
  return new Promise((resolve) => {
    const mine = new g.DocsView(g.ViewId.DOCS).setIncludeFolders(true).setSelectFolderEnabled(t.folders).setMode(g.DocsViewMode.LIST)
    const shared = new g.DocsView(g.ViewId.DOCS).setEnableDrives(true).setIncludeFolders(true).setSelectFolderEnabled(t.folders)
    new g.PickerBuilder()
      .addView(mine).addView(shared)
      .setOAuthToken(t.access_token).setDeveloperKey(t.api_key).setAppId(t.app_id)
      .enableFeature(g.Feature.MULTISELECT_ENABLED).enableFeature(g.Feature.SUPPORT_DRIVES)
      .setLocale(getLocale() === 'ko' ? 'ko' : 'en').setOrigin(window.location.origin)
      .setCallback((d: { action: string; docs?: { id: string }[] }) => {
        if (d.action === g.Action.PICKED) resolve((d.docs ?? []).map((x) => x.id))
        else if (d.action === g.Action.CANCEL) resolve(null)
      })
      .build().setVisible(true)
  })
}

// ---------- jobs: started from the Files page, followed until done ----------
let jobs: Job[] = []
const jobSubs = new Set<() => void>()
let finished: (folder: string) => void = () => {}
const emit = () => { jobs = [...jobs]; jobSubs.forEach((f) => f()) }
export const gdriveJobs = {
  subscribe: (f: () => void) => { jobSubs.add(f); return () => { jobSubs.delete(f) } },
  snapshot: () => jobs,
  /** called when a job ends, with the folder it imported into (the Files page reloads it) */
  onFinished: (f: (folder: string) => void) => { finished = f },
  clear: () => { jobs = jobs.filter((j) => j.state === 'running'); emit() },
}
async function follow(id: string) {
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000))
    let j: Job
    try { j = await get<Job>(`/gdrive/jobs/${id}`) } catch { return }
    jobs = jobs.map((x) => x.id === id ? j : x); emit()
    if (j.state === 'done') { finished(j.folder); return }
  }
}

/** Pick in Google Drive, then import into `folder`. Throws with a message to show. */
export async function importFromGdrive(folder: string) {
  let ids: string[] | null
  try { ids = await pick() } catch (e) { throw new Error(e instanceof Error && e.message === 'picker' ? dt('gd_picker_failed') : errText(e)) }
  if (!ids?.length) return
  const j = await api<Job>('POST', '/gdrive/import', { path: folder, items: ids.map((id) => ({ id })) })
  jobs = [j, ...jobs]; emit()
  void follow(j.id)
}

const show = (s: string) => s.normalize('NFC')

export function GdrivePanel() {
  const list = useSyncExternalStore(gdriveJobs.subscribe, gdriveJobs.snapshot)
  const [open, setOpen] = useState(true)
  if (!list.length) return null
  const running = list.filter((j) => j.state === 'running')
  const left = running.reduce((n, j) => n + j.total - j.done, 0)
  return createPortal(
    <section className="fv-uploads gd-panel" aria-label={dt('gd_title')} aria-live="polite">
      <header>
        <strong>{running.length ? dt('gd_importing_n', { n: left || '…' }) : dt('gd_done')}</strong>
        <button type="button" className="btn small ghost" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? '▾' : '▴'}</button>
        {!running.length && <button type="button" className="btn small ghost" onClick={() => gdriveJobs.clear()} aria-label="✕">✕</button>}
      </header>
      {open && <ul>
        {list.map((j) => <li key={j.id}>
          <div className="fv-up-name">{dt('gd_into', { folder: show(j.folder) })}</div>
          <div className="fv-up-state small">
            <progress max={Math.max(1, j.total)} value={j.done} aria-label={show(j.folder)} />
            <span className="muted">{dt('gd_summary', { imported: j.imported, updated: j.updated, unchanged: j.unchanged, failed: j.failed })}</span>
          </div>
          <ul className="gd-items">
            {j.items.map((it, i) => <li key={it.drive_id + i} className={`st-${it.status}`}>
              <span className="fv-up-name" title={it.path ? show(it.path) : show(it.name)}>{show(it.path ? it.path.slice(j.folder.length + 1) || it.name : it.name)}</span>
              <span className="small">{it.status === 'failed' ? <span className="err">{it.message ?? it.error}</span>
                : <span className={it.status === 'imported' || it.status === 'updated' ? 'ok' : 'muted'}>{dt(`gd_st_${it.status}` as DriveKey)}</span>}</span>
            </li>)}
          </ul>
          {j.error && <p className="err small">{j.error}</p>}
        </li>)}
      </ul>}
    </section>,
    document.body,
  )
}

/** What came back from Google's consent page (#/…?gdrive=<outcome>): a line to show. */
export function gdriveOutcome(route: string): { text: string; error: boolean } | null {
  const v = new URLSearchParams(route.slice(route.indexOf('?') + 1)).get('gdrive')
  if (!v || route.indexOf('?') < 0) return null
  if (v === 'connected') return { text: dt('gd_now_connected'), error: false }
  const k = ({ denied: 'gd_back_denied', expired: 'gd_back_expired', no_scope: 'gd_back_no_scope' } as Record<string, DriveKey>)[v] ?? 'gd_back_failed'
  return { text: dt(k), error: true }
}

// ---------- Settings: the connection ----------
export function GdriveSettings({ route }: { route: string }) {
  const s = useGdrive()
  const a = useAction()
  const [msg, setMsg] = useState<string | null>(null)
  const back = gdriveOutcome(route)
  if (!s?.enabled) return null
  return (
    <section className="card" id="gdrive">
      <h2>{dt('gd_title')}</h2>
      {back && <p className={back.error ? 'error' : 'ok'} role="status">{back.text}</p>}
      <p className="muted small">{dt('gd_help')} {dt('gd_help_files')}{s.readonly ? ' ' + dt('gd_help_folders') : ''}</p>
      {s.connected ? <>
        <p><strong>{s.email ? dt('gd_connected_as', { email: s.email }) : dt('gd_connected')}</strong>{s.connected_at ? <span className="muted small"> · {fmtDate(s.connected_at)}</span> : null}</p>
        <p className="muted small">{dt('gd_disconnect_help')}</p>
        <button type="button" className="btn danger" disabled={a.busy} onClick={async () => {
          if (!window.confirm(dt('gd_confirm_disconnect'))) return
          if (await a.run(() => api('DELETE', '/gdrive'))) { setMsg(dt('gd_disconnected')); void loadGdrive(true) }
        }}>{dt('gd_disconnect')}</button>
      </> : <>
        {s.broken && <p className="error">{dt('gd_broken')}</p>}
        <button type="button" className="btn primary" disabled={a.busy} onClick={() => a.run(() => connectGdrive('/settings'))}>{dt('gd_connect')}</button>
      </>}
      {msg && <p className="ok">{msg}</p>}
      <ErrorLine error={a.error} />
    </section>
  )
}
