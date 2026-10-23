// Share a folder, like Google Drive (plan 2.4 "공유 대화상자", 3.1–3.2, 10.2-1/8 O1):
//   - add people and groups with a role (Viewer / Editor; Manager only for admins), notify them
//   - people with access: change a direct role or remove it; inherited rows say where they come from
//   - General access: Restricted, or Anyone in <team> as Viewer / Editor; "Restrict access here" below an open folder
//   - "Editors can change permissions and share" (managers), AI access (No AI), copy link
//   - a change that would let more people read AI-draft copies answers 409 "widening": a Manager confirms, an Editor
//     asks for approval; an Editor opening a folder to the whole team confirms with a passkey (or authenticator code)
//   - files (workstream A2): Viewer / Editor only, General access no narrower than the folder, the folder's readers listed
//     as inherited (hidden from a file-only Editor), "People you add will see the folder names on the way", a file that is
//     an AI-draft copy (a manager confirms; an Editor asks one), "Remove me" for one's own direct share
//   - admins add a non-member by mail address (S16): an invitation, and the share once they join (pending until then)
//   - My files is never shared: the dialog says "Move it to a team folder to share it"
// Every change is a request the server decides (the page only offers what the answer says this person may do). A path
// the person cannot see reads exactly like one that does not exist: one generic line, never a name from the request.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { ApiError } from '../api'
import { useSession } from '../App'
import { t, useLocale } from '../i18n'
import { errText, Skeleton } from '../ui'
import { getPasskey, passkeysSupported } from '../webauthn'
import { Icon } from './Icon'
import {
  isPersonal, linkTo, needsStepUp, shareBackend, wideningOf,
  type Directory, type Level, type Role, type ShareBackend, type ShareChange, type ShareEntry, type ShareView, type SubjectRef, type Widening,
} from './share-api'

type Pick = (SubjectRef & { name: string; detail?: string }) | { type: 'email'; email: string; name: string; detail?: string }
type Pending =
  | ({ kind: 'widening'; change: ShareChange } & Widening)
  | { kind: 'stepup'; change: ShareChange; method: 'passkey' | 'totp'; options?: unknown }

const same = (a: { type: string; id?: number; email?: string | null }, b: { type: string; id?: number; email?: string | null }) => a.type === b.type && (a.type === 'email' ? a.email === b.email : a.id === b.id)
const roleLabel = (r: Role) => t(`share_role_${r}`)
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** A refusal as one line of text. Names never come from the request: a hidden path reads like a missing one. */
export function shareErrorText(e: unknown, kind: 'folder' | 'file' = 'folder'): string {
  if (!(e instanceof ApiError)) return errText(e)
  if (e.status === 404) return t('share_not_found')
  switch (e.code) {
    case 'not_manager': case 'editors_cannot_share': return kind === 'file' ? t('share_file_cannot_share') : t('share_only_managers')
    case 'personal': return t('share_personal')
    case 'invite_admin_only': return t('share_invite_admin_only')
    case 'invites_unavailable': case 'invite_unsupported': return t('share_invites_unavailable')
    case 'editors_cannot_confirm': return t('share_cannot_confirm')
    case 'too_many': return t('share_too_many')
    case 'inherited_general': return t('share_inherited_general')
    case 'inherited': return t('share_inherited_role')
    case 'passkey_required': case 'totp_required': return t('share_step_up_missing')
    case 'folders_only': return t('share_folders_only')
    default: return errText(e)
  }
}

export function ShareDialog({ path, name, kind: kindHint = 'folder', onClose }: { path: string; name: string; kind?: 'folder' | 'file'; onClose: () => void }) {
  useLocale()
  const { me } = useSession()
  const [backend, setBackend] = useState<ShareBackend | null>(null)
  const [view, setView] = useState<ShareView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [readOnlyReason, setReadOnlyReason] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [restrictOpen, setRestrictOpen] = useState(false)
  // S16: addresses invited in this dialog that are not members yet (the share is given when they join)
  const [invited, setInvited] = useState<{ email: string; role: Role }[]>([])
  // bumps on every change that went through: the add box clears its picks (also after "Request approval")
  const [done, setDone] = useState(0)
  const boxRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    let live = true
    shareBackend(() => ({ id: me?.id ?? -1 })).then(async (b) => {
      if (!live) return
      setBackend(b)
      try { const v = await b.get(path); if (live) setView(v) } catch (e) {
        if (!live) return
        if (e instanceof ApiError && e.status === 403 && !isPersonal(e)) setReadOnlyReason(t('share_only_managers'))
        else if (b.kind === 'legacy' && e instanceof ApiError && e.status === 404 && kindHint === 'file') setReadOnlyReason(t('share_folders_only'))
        else setError(shareErrorText(e, kindHint))
      }
    })
    return () => { live = false }
  }, [path, me?.id])

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    boxRef.current?.querySelector<HTMLElement>('input, button')?.focus()
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); closeRef.current() }
      if (e.key === 'Tab' && boxRef.current) { // keep the focus inside the dialog
        const els = [...boxRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href]')]
        if (!els.length) return
        const first = els[0]!, last = els[els.length - 1]!
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }
    window.addEventListener('keydown', key)
    return () => { window.removeEventListener('keydown', key); prev?.focus?.() }
  }, [])

  const askStepUp = async (change: ShareChange) => {
    try { const o = await backend!.stepUpOptions(path, change.general); setPending({ kind: 'stepup', change, method: o.method, options: o.options }) } catch (x) { setError(shareErrorText(x, kind)) }
  }
  const kind = view?.item.kind ?? kindHint
  const apply = async (change: ShareChange, okText = t('share_saved')) => {
    if (!backend) return false
    setBusy(true); setError(null); setNote(null)
    // an Editor opening the folder to the whole team confirms with a passkey first (the server would say so too)
    if (change.general?.mode === 'team' && view?.general.editor_step_up && !change.step_up) { await askStepUp(change); setBusy(false); return false }
    try {
      const r = await backend.change(path, change)
      setView(r); setPending(null); setDone((n) => n + 1)
      const waiting = (r.invited ?? []).filter((x) => !x.granted)
      if (waiting.length) {
        const roleOf = (email: string) => (change.add?.find((a) => 'email' in a.subject && a.subject.email.toLowerCase() === email.toLowerCase())?.role ?? 'viewer') as Role
        setInvited((old) => [...old.filter((o) => !waiting.some((w) => w.email.toLowerCase() === o.email.toLowerCase())), ...waiting.map((w) => ({ email: w.email, role: roleOf(w.email) }))])
      }
      if (r.approval_id) setNote(t('share_approval_requested'))
      else if (r.invited?.length) setNote(t('share_invited_n', { n: r.invited.length }))
      else setNote(okText)
      return true
    } catch (e) {
      const w = wideningOf(e, kind)
      if (w) { setPending({ kind: 'widening', change, ...w }); return false }
      if (needsStepUp(e)) { await askStepUp(change); return false }
      setError(shareErrorText(e, kind))
      return false
    } finally { setBusy(false) }
  }

  const canEdit = !!view && view.mode === undefined && (view.can_manage || !!view.can_share)
  const title = t('share_title', { name })
  const file = kind === 'file'
  const leave = async () => {
    if (!window.confirm(t('share_leave_confirm'))) return
    if (await apply({ leave: true }, t('share_left'))) closeRef.current()
  }
  // why the dialog is read-only (said once, at the top)
  const roText = !view ? '' : file
    ? (view.editors_can_share && !view.editors_can_share.value && view.my_role === 'editor' && view.editors_can_share.inherited_from
      ? t('share_file_editors_off', { folder: view.editors_can_share.inherited_from }) : t('share_file_cannot_share'))
    : t('share_only_managers')

  return createPortal(
    <div className="sd-scrim" onMouseDown={onClose}>
      <div className="sd" role="dialog" aria-modal="true" aria-label={title} ref={boxRef} onMouseDown={(e) => e.stopPropagation()}>
        <header className="sd-head">
          <h2>{title}</h2>
          {view?.folder_id != null && me?.admin && <a className="btn ghost small sd-adv" href={`#/folders/${view.folder_id}`} onClick={onClose} title={t('share_advanced_help')}><Icon name="settings" size={16} /><span>{t('share_advanced')}</span></a>}
          <button type="button" className="btn ghost icon" onClick={onClose} aria-label={t('close')}><Icon name="close" size={18} /></button>
        </header>

        {!view && !error && !readOnlyReason && <div className="sd-pad"><Skeleton rows={3} /></div>}
        {readOnlyReason && <p className="sd-pad muted">{readOnlyReason}</p>}
        {view?.mode === 'inplace' && <p className="sd-pad">{t('share_inplace')} {view.folder_id != null && <a href={`#/folders/${view.folder_id}`} onClick={onClose}>{t('share_open_folder_page')}</a>}</p>}
        {view?.mode === 'personal' && <p className="sd-pad sd-personal"><Icon name="lock" size={16} /> {t('share_personal')}</p>}

        {view && view.mode === undefined && <div className="sd-body">
          {canEdit ? <AddPeople view={view} backend={backend!} busy={busy} onAdd={apply} done={done} /> : <p className="sd-ro"><Icon name="lock" size={16} /> {roText}</p>}

          <section aria-labelledby="sd-people">
            <h3 id="sd-people">{t('share_people_with_access')}</h3>
            <ul className="sd-list">
              {view.entries.length === 0 && invited.length === 0 && <li className="muted small">{t('share_nobody')}</li>}
              {view.entries.map((e) => <EntryRow key={`${e.subject.type}${e.subject.id}${e.source}`} e={e} view={view} me={me?.id ?? -1} busy={busy}
                onRole={(role) => apply({ set: [{ subject: { type: e.subject.type, id: e.subject.id }, role }] })} onLeave={leave} />)}
            </ul>
            {file && view.inherited === 'hidden' && <p className="muted small sd-gap">{t('share_file_only_list')}</p>}
          </section>

          {invited.length > 0 && (
            <section aria-labelledby="sd-invited" className="sd-invited">
              <h3 id="sd-invited">{t('share_pending_invites')}</h3>
              <ul className="sd-list">
                {invited.map((x) => (
                  <li key={x.email} className="sd-entry">
                    <span className="sd-avatar pending" aria-hidden="true"><Icon name="bell" size={16} /></span>
                    <span className="sd-who"><span>{x.email}</span><span className="muted small">{t('share_pending_invite_row', { role: roleLabel(x.role) })}</span></span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <GeneralAccess view={view} busy={busy} canEdit={canEdit} onChange={(g) => apply({ general: g })} onRestrict={() => setRestrictOpen(true)} />
          {restrictOpen && <RestrictHere view={view} busy={busy} onCancel={() => setRestrictOpen(false)}
            onConfirm={async (keep) => { if (await apply({ restrict_here: { on: true, keep } }, t('share_restricted_done'))) setRestrictOpen(false) }} />}

          {file ? (view.ai.no_ai && <p className="muted small sd-gap sd-line"><Icon name="lock" size={14} /> {t('share_no_ai_file', { folder: view.ai.inherited_no_ai_from ?? view.item.path })}</p>) : <section aria-labelledby="sd-settings" className="sd-settings">
            <h3 id="sd-settings">{t('share_settings')}</h3>
            {view.editors_can_share && (
              <label className="sd-toggle">
                <input type="checkbox" role="switch" checked={view.editors_can_share.value} disabled={busy || !view.editors_can_share.can_change}
                  onChange={(e) => apply({ editors_can_share: e.target.checked })} />
                <span><span>{t('share_editors_can_share')}</span>
                  <span className="muted small">{!view.editors_can_share.value && view.editors_can_share.inherited_from ? t('share_editors_off_above', { folder: view.editors_can_share.inherited_from })
                    : !view.editors_can_share.value && view.editors_can_share.off_above ? t('share_editors_off_above_any') : t('share_editors_can_share_help')}</span></span>
              </label>
            )}
            <label className="sd-toggle">
              <input type="checkbox" role="switch" checked={!view.ai.no_ai}
                disabled={busy || !!view.ai.inherited_no_ai_from || (view.ai.no_ai ? !view.can_ai_off : !view.can_manage)}
                onChange={(e) => apply({ ai_access: e.target.checked })} />
              <span><span>{t('share_ai_access')}</span>
                <span className="muted small">{view.ai.inherited_no_ai_from ? t('share_no_ai_inherited', { folder: view.ai.inherited_no_ai_from }) : view.ai.no_ai && !view.can_ai_off ? t('share_no_ai_admin_only') : t('share_ai_access_help')}</span></span>
            </label>
          </section>}

          {/* only below the top: a top folder's name is no news */}
          {canEdit && (file
            ? typeof view.path_names_visible === 'string' && <p className="sd-warn small"><Icon name="info" size={16} /> {t('share_path_names_visible_file', { path: view.path_names_visible })}</p>
            : view.path_names_visible && view.item.path.split('/').length > 2 && <p className="sd-warn small"><Icon name="info" size={16} /> {t('share_path_names_visible', { path: view.item.path })}</p>)}
          {(view.warnings ?? []).map((w) => <p key={w.code} className="sd-warn small"><Icon name="info" size={16} /> {w.code === 'draft_copies' ? t('share_warn_draft_copies', { n: w.count ?? 0 }) : w.code === 'draft_copy' ? t('share_warn_draft_copy') : w.code === 'manager_cannot_open' ? t('share_warn_manager_cannot_open', { n: w.count ?? 0 }) : w.code === 'editors_off_above' ? t('share_editors_off_above_any') : w.code}</p>)}
        </div>}

        {pending?.kind === 'widening' && (
          <AlertBox>
            <p><strong>{t('share_widening_title')}</strong></p>
            <p className="small">{t('share_widening_text', { n: pending.count })}{pending.sourcesHidden > 0 && ' ' + t('share_widening_hidden', { n: pending.sourcesHidden })}</p>
            {pending.sources.length > 0 && <p className="small muted">{t('share_widening_sources', { list: pending.sources.join(', ') })}</p>}
            {!pending.canConfirm && !pending.canRequest && <p className="small">{t('share_widening_file_ask')}</p>}
            <div className="sd-actions">
              <button type="button" className="btn" onClick={() => setPending(null)}>{t('cancel')}</button>
              {pending.canConfirm
                ? <button type="button" className="btn primary" disabled={busy} onClick={() => apply({ ...pending.change, confirm_widening: true })}>{t('share_anyway')}</button>
                : pending.canRequest && <button type="button" className="btn primary" disabled={busy} onClick={() => apply({ ...pending.change, confirm_widening: true })}>{t('share_request_approval')}</button>}
            </div>
          </AlertBox>
        )}
        {pending?.kind === 'stepup' && <StepUp pending={pending} busy={busy} onCancel={() => setPending(null)} onProof={async (proof) => {
          setBusy(true)
          try { const assertion = await backend!.stepUp(path, pending.change.general, proof); setBusy(false); await apply({ ...pending.change, step_up: assertion }) } catch (x) { setBusy(false); setError(shareErrorText(x, kind)) }
        }} onError={setError} />}

        {error && <p className="error sd-pad-x" role="alert">{error}</p>}
        <footer className="sd-foot">
          {view?.mode !== 'personal' && <CopyLink path={path} kind={kind} />}
          <span className="sd-note small" role="status" aria-live="polite">{note}</span>
          <button type="button" className="btn primary" onClick={onClose}>{t('share_done')}</button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}

// ---------- add people and groups ----------
function AddPeople({ view, backend, busy, onAdd, done }: { view: ShareView; backend: ShareBackend; busy: boolean; onAdd: (c: ShareChange) => Promise<boolean>; done: number }) {
  const [dir, setDir] = useState<Directory | null>(null)
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState<Pick[]>([])
  const [role, setRole] = useState<Role>('viewer')
  const [notify, setNotify] = useState(true)
  const [cursor, setCursor] = useState(0)
  const [open, setOpen] = useState(false)
  useEffect(() => { if (done) { setPicked([]); setRole('viewer') } }, [done])
  const loadDir = () => { if (!dir) backend.directory().then(setDir, () => setDir({ people: [], groups: [] })) }
  const has = (s: Pick) => picked.some((p) => same(p, s)) || (s.type !== 'email' && view.entries.some((e) => e.source === 'direct' && same(e.subject, s)))
  const options = useMemo<Pick[]>(() => {
    if (!dir) return []
    const ql = q.trim().toLocaleLowerCase()
    const groups = dir.groups.filter((g) => !g.everyone).map((g) => ({ type: 'group' as const, id: g.id, name: g.name, detail: t('share_members_n', { n: g.size }) }))
    const people = dir.people.map((p) => ({ type: 'person' as const, id: p.id, name: p.display_name || p.name, detail: p.email ?? p.name }))
    const found: Pick[] = [...people, ...groups].filter((o) => !has(o) && (!ql || o.name.toLocaleLowerCase().includes(ql) || (o.detail ?? '').toLocaleLowerCase().includes(ql))).slice(0, 8)
    // S16: an admin types a whole address that is nobody in the team → invite it
    const typed = q.trim()
    if (view.can_invite && EMAIL.test(typed) && !dir.people.some((p) => (p.email ?? '').toLowerCase() === ql)) {
      const inv: Pick = { type: 'email', email: typed, name: typed, detail: t('share_invite_option_help') }
      if (!has(inv)) found.push(inv)
    }
    return found
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir, q, picked, view])
  const pick = (o: Pick) => { setPicked([...picked, o]); setQ(''); setCursor(0); setOpen(false) }
  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setCursor((c) => Math.min(options.length - 1, c + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)) }
    else if (e.key === 'Enter' && open && options[cursor]) { e.preventDefault(); pick(options[cursor]!) }
    else if (e.key === 'Backspace' && !q && picked.length) setPicked(picked.slice(0, -1))
    else if (e.key === 'Escape' && open) { e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); setOpen(false) }
  }
  const roles: Role[] = view.can_grant_manager && view.item.kind === 'folder' ? ['viewer', 'editor', 'manager'] : ['viewer', 'editor']
  const hasGroup = picked.some((p) => p.type !== 'person')
  const hasInvite = picked.some((p) => p.type === 'email')
  const send = async () => {
    if (!picked.length) return
    const r: Role = hasGroup && role === 'manager' ? 'editor' : role
    const ok = await onAdd({ add: picked.map((p) => ({ subject: p.type === 'email' ? { email: p.email } : { type: p.type, id: p.id }, role: r })), notify })
    if (ok) { setPicked([]); setRole('viewer') }
  }
  return (
    <section className="sd-add">
      <div className="sd-add-row">
        <div className={`sd-combo ${picked.length ? 'has' : ''}`} onClick={(e) => (e.currentTarget.querySelector('input') as HTMLInputElement | null)?.focus()}>
          {picked.map((p) => (
            <span key={p.type === 'email' ? 'e' + p.email : `${p.type}${p.id}`} className={`sd-chip ${p.type === 'email' ? 'invite' : ''}`}>
              {p.type === 'group' && <Icon name="people" size={14} />}{p.type === 'email' && <Icon name="bell" size={14} />}{p.name}
              <button type="button" aria-label={`${t('remove')} ${p.name}`} onClick={() => setPicked(picked.filter((x) => !same(x, p)))}><Icon name="close" size={12} /></button>
            </span>
          ))}
          <input value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); setCursor(0) }} onFocus={() => { loadDir(); setOpen(true) }} onBlur={() => setTimeout(() => setOpen(false), 150)} onKeyDown={onKey}
            placeholder={picked.length ? '' : t('share_add_placeholder')} aria-label={t('share_add_placeholder')} role="combobox" aria-expanded={open && options.length > 0} aria-controls="sd-options" aria-autocomplete="list"
            aria-activedescendant={open && options[cursor] ? `sd-opt-${cursor}` : undefined} />
        </div>
        {picked.length > 0 && (
          <select className="sd-role" value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label={t('share_role')}>
            {roles.map((r) => <option key={r} value={r} disabled={r === 'manager' && hasGroup}>{roleLabel(r)}</option>)}
          </select>
        )}
      </div>
      {open && options.length > 0 && (
        <ul className="sd-options" id="sd-options" role="listbox">
          {options.map((o, i) => (
            <li key={o.type === 'email' ? 'e' + o.email : `${o.type}${o.id}`} id={`sd-opt-${i}`} role="option" aria-selected={i === cursor} className={`${i === cursor ? 'on' : ''} ${o.type === 'email' ? 'invite' : ''}`} onMouseDown={(e) => { e.preventDefault(); pick(o) }}>
              <Avatar name={o.name} group={o.type === 'group'} invite={o.type === 'email'} /><span className="sd-who"><span>{o.type === 'email' ? t('share_invite_option', { email: o.email }) : o.name}</span><span className="muted small">{o.detail}</span></span>
            </li>
          ))}
        </ul>
      )}
      {hasInvite && <p className="muted small sd-gap">{t('share_invite_note')}</p>}
      {picked.length > 0 && (
        <div className="sd-add-foot">
          <label className="check small"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> {t('share_notify')}</label>
          <span className="sd-actions">
            <button type="button" className="btn" onClick={() => setPicked([])}>{t('cancel')}</button>
            <button type="button" className="btn primary" disabled={busy} onClick={send}>{t('share_send')}</button>
          </span>
        </div>
      )}
    </section>
  )
}

function Avatar({ name, group, invite }: { name: string; group?: boolean; invite?: boolean }) {
  return <span className={`sd-avatar ${group ? 'group' : ''} ${invite ? 'pending' : ''}`} aria-hidden="true">{invite ? <Icon name="bell" size={16} /> : group ? <Icon name="people" size={16} /> : (name.trim()[0] ?? '?').toLocaleUpperCase()}</span>
}

// ---------- one row of "People with access" ----------
function EntryRow({ e, view, me, busy, onRole, onLeave }: { e: ShareEntry; view: ShareView; me: number; busy: boolean; onRole: (r: Role | 'remove') => void; onLeave: () => void }) {
  const file = view.item.kind === 'file'
  // Manager is given and taken only by those who may grant it (admins); Editors who share change Viewers and Editors
  const editable = e.editable ?? (e.source === 'direct' && (e.role === 'manager' ? view.can_grant_manager : view.can_manage || !!view.can_share))
  const roles: Role[] = view.can_grant_manager && !file && e.subject.type === 'person' ? ['viewer', 'editor', 'manager'] : ['viewer', 'editor']
  if (e.role === 'manager' && !roles.includes('manager')) roles.push('manager')
  const you = e.subject.type === 'person' && e.subject.id === me
  const detail = [e.subject.type === 'group' ? t('share_members_n', { n: e.subject.members ?? 0 }) : e.subject.email ?? '',
    e.inherited_role ? t('share_also_from_folder', { role: roleLabel(e.inherited_role) }) : ''].filter(Boolean).join(' · ')
  return (
    <li className="sd-entry">
      <Avatar name={e.subject.name} group={e.subject.type === 'group'} />
      <span className="sd-who">
        <span>{e.subject.name}{you && <span className="muted"> {t('share_you')}</span>}</span>
        <span className="muted small">{detail}{e.source === 'inherited' && <>{detail && ' · '}{e.from_path ? <>{t('share_inherited_from')} <a href={`#/files?p=${encodeURIComponent(e.from_path)}`}>{e.from_path}</a></> : t('share_inherited')}</>}</span>
      </span>
      {editable ? (
        <select className="sd-role" value={e.role} disabled={busy} aria-label={t('share_role_of', { name: e.subject.name })}
          onChange={(x) => { const v = x.target.value as Role | 'remove'; if (v === 'remove' && !window.confirm(t(file ? 'share_remove_confirm_file' : 'share_remove_confirm', { name: e.subject.name }))) { x.target.value = e.role; return } onRole(v) }}>
          {roles.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
          <option value="remove">{t('share_remove_access')}</option>
        </select>
      ) : <span className="sd-role-ro muted small">{roleLabel(e.role)}{e.cannot_open ? ` · ${t('share_cannot_open')}` : ''}
        {/* a file shared with me directly: I may give it back */}
        {file && you && e.source === 'direct' && <button type="button" className="btn ghost small sd-leave" disabled={busy} onClick={onLeave}>{t('share_leave')}</button>}</span>}
    </li>
  )
}

// ---------- General access ----------
function GeneralAccess({ view, busy, canEdit, onChange, onRestrict }: { view: ShareView; busy: boolean; canEdit: boolean; onChange: (g: { mode: 'restricted' | 'team'; role?: Level }) => void; onRestrict: () => void }) {
  const g = view.general
  const team = view.team_name ? t('share_anyone_in', { team: view.team_name }) : t('share_anyone_in_team')
  const inherited = g.effective && g.effective.from_path && !g.own
  const open = !!g.effective
  const hasInherited = !!inherited || view.entries.some((e) => e.source === 'inherited' && e.role !== 'manager')
  return (
    <section aria-labelledby="sd-general" className="sd-general">
      <h3 id="sd-general">{t('share_general')}</h3>
      <div className="sd-general-row">
        <span className={`sd-gicon ${open ? 'open' : ''}`} aria-hidden="true"><Icon name={open ? 'globe' : 'lock'} size={18} /></span>
        <div className="sd-general-main">
          {!canEdit && !inherited ? (
            <><span className="strong">{open ? `${team} · ${t(`share_role_${g.effective!.level}`)}` : t('share_restricted')}</span>
              <span className="muted small">{open ? t('share_team_help') : t('share_restricted_help')}</span></>
          ) : inherited ? (
            <><span className="strong">{team} · {t(`share_role_${g.effective!.level}`)}</span>
              <span className="muted small">{view.item.kind === 'file' ? t('share_general_file_from_folder', { folder: g.effective!.from_path! }) : t('share_general_inherited', { folder: g.effective!.from_path! })}</span></>
          ) : (
            <>
              <select className="sd-plain" value={open ? 'team' : 'restricted'} disabled={busy || !canEdit} aria-label={t('share_general')}
                onChange={(e) => onChange(e.target.value === 'team' ? { mode: 'team', role: 'viewer' } : { mode: 'restricted' })}>
                <option value="restricted" disabled={g.can_restrict === false}>{t('share_restricted')}</option>
                <option value="team">{team}</option>
              </select>
              <span className="muted small">{open ? t('share_team_help') : t('share_restricted_help')}</span>
            </>
          )}
        </div>
        {open && !inherited && canEdit && (
          <select className="sd-role" value={g.effective!.level} disabled={busy || !canEdit} aria-label={t('share_general_role')}
            onChange={(e) => onChange({ mode: 'team', role: e.target.value as Level })}>
            <option value="viewer">{t('share_role_viewer')}</option><option value="editor">{t('share_role_editor')}</option>
          </select>
        )}
      </div>
      {g.restricted_here && <p className="muted small sd-indent">{t('share_restricted_here_on')}</p>}
      {!g.restricted_here && hasInherited && view.can_restrict_here && view.can_manage && (
        <button type="button" className="btn small sd-indent" disabled={busy} onClick={onRestrict}>{t('share_restrict_here')}</button>
      )}
    </section>
  )
}

// ---------- Restrict access here: who keeps access ----------
function RestrictHere({ view, busy, onCancel, onConfirm }: { view: ShareView; busy: boolean; onCancel: () => void; onConfirm: (keep: SubjectRef[]) => void }) {
  // only what comes from above loses access; managers above always keep it (plan 3.2)
  const losing = view.entries.filter((e) => e.source === 'inherited' && e.role !== 'manager')
  const everyoneLoses = !!view.general.effective && !view.general.own
  const [keep, setKeep] = useState<Set<string>>(() => new Set(losing.filter((e) => e.subject.type === 'person').map((e) => `${e.subject.type}:${e.subject.id}`)))
  const k = (s: SubjectRef) => `${s.type}:${s.id}`
  const toggle = (s: SubjectRef) => setKeep((o) => { const n = new Set(o); if (n.has(k(s))) n.delete(k(s)); else n.add(k(s)); return n })
  const n = losing.filter((e) => !keep.has(k(e.subject))).length + (everyoneLoses ? 1 : 0)
  return (
    <div className="sd-alert">
      <p><strong>{t('share_restrict_title')}</strong></p>
      <p className="small">{n ? t('share_restrict_lose_n', { n }) : t('share_restrict_lose_none')}</p>
      <ul className="sd-keep">
        {everyoneLoses && <li><label className="check small"><input type="checkbox" disabled /> {view.team_name ? t('share_anyone_in', { team: view.team_name }) : t('share_anyone_in_team')}</label></li>}
        {losing.map((e) => <li key={k(e.subject)}><label className="check small"><input type="checkbox" checked={keep.has(k(e.subject))} onChange={() => toggle(e.subject)} /> {t('share_keep', { name: e.subject.name, role: roleLabel(e.role) })}</label></li>)}
      </ul>
      <p className="muted small">{t('share_restrict_managers_stay')}</p>
      <div className="sd-actions">
        <button type="button" className="btn" onClick={onCancel}>{t('cancel')}</button>
        <button type="button" className="btn danger" disabled={busy} onClick={() => onConfirm(losing.filter((e) => keep.has(k(e.subject))).map((e) => ({ type: e.subject.type, id: e.subject.id })))}>{t('share_restrict_here')}</button>
      </div>
    </div>
  )
}

/** A question inside the dialog (widening): scrolled into view, its main button focused. */
function AlertBox({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { ref.current?.scrollIntoView({ block: 'nearest' }); ref.current?.querySelector<HTMLElement>('button.primary')?.focus() }, [])
  return <div className="sd-alert" role="alert" ref={ref}>{children}</div>
}

// ---------- the Editor's step-up (passkey, else authenticator code) ----------
function StepUp({ pending, busy, onCancel, onProof, onError }: { pending: Extract<Pending, { kind: 'stepup' }>; busy: boolean; onCancel: () => void; onProof: (p: { response: unknown } | { code: string }) => void; onError: (s: string) => void }) {
  const [code, setCode] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { ref.current?.scrollIntoView({ block: 'nearest' }); ref.current?.querySelector<HTMLElement>('input, button.primary')?.focus() }, [])
  return (
    <div className="sd-alert" role="alert" ref={ref}>
      <p><strong>{t('share_stepup_title')}</strong></p>
      <p className="small">{t('share_stepup_text')}</p>
      {pending.method === 'totp' && <label className="small">{t('share_stepup_code')}<input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 8))} /></label>}
      <div className="sd-actions">
        <button type="button" className="btn" onClick={onCancel}>{t('cancel')}</button>
        {pending.method === 'passkey'
          ? <button type="button" className="btn primary" disabled={busy || !passkeysSupported()} onClick={async () => { try { onProof({ response: await getPasskey(pending.options) }) } catch { onError(t('share_stepup_cancelled')) } }}>{t('share_stepup_passkey')}</button>
          : <button type="button" className="btn primary" disabled={busy || code.length < 6} onClick={() => onProof({ code })}>{t('share_stepup_confirm')}</button>}
      </div>
    </div>
  )
}

function CopyLink({ path, kind }: { path: string; kind: 'folder' | 'file' }) {
  const [done, setDone] = useState(false)
  return (
    <button type="button" className="btn sd-copy" onClick={() => {
      navigator.clipboard?.writeText(linkTo(window.location.origin, path, kind)).then(() => { setDone(true); setTimeout(() => setDone(false), 1800) }, () => {})
    }}><Icon name={done ? 'check' : 'link'} size={16} /><span>{done ? t('share_link_copied') : t('share_copy_link')}</span></button>
  )
}
