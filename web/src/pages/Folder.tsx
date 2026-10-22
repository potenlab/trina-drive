// One folder: the two-column "who can see" table (NAS opens / AI reads), flags, managers, subfolders.
import { useEffect, useState } from 'react'
import { api, get, type FolderDetail, type Person, type TableRow } from '../api'
import { go } from '../App'
import { fmtDate, t } from '../i18n'
import { Badge, ErrorLine, Loading, Page, useAction, useLoad, YesNo } from '../ui'
import { FolderBadges } from './Folders'
import { NAS_MODES } from './RegisterForm'

export function Folder({ id }: { id: number }) {
  const { data, error, reload } = useLoad(() => get<FolderDetail>(`/folders/${id}`), [id])
  const [people, setPeople] = useState<Person[]>([])
  const a = useAction()
  useEffect(() => { get<{ people: Person[] }>('/people').then((r) => setPeople(r.people), () => {}) }, [])
  if (error) return <Page title={t('folders_title')}><ErrorLine error={error} /><a href="#/folders">← {t('folders_title')}</a></Page>
  if (!data) return <Loading />
  const f = data.folder
  const can = f.can
  const act = async (fn: () => Promise<unknown>) => { if (await a.run(fn) !== undefined) reload() }
  const setRule = (r: TableRow, on: boolean) => act(() => api('PUT', `/folders/${id}/rules`, { subject_type: r.type, subject_id: r.id, level: on ? 'read' : 'none' }))
  const nasPeople = data.rows.filter((r) => r.type === 'person' && r.nas === true).map((r) => r.id)
  const setNasPerson = (pid: number, on: boolean) => act(() => api('PUT', `/folders/${id}/nas`, { mode: 'chosen', people: on ? [...nasPeople, pid] : nasPeople.filter((x) => x !== pid) }))
  const ownerName = f.personal_owner != null ? people.find((p) => p.id === f.personal_owner)?.name ?? '…' : null
  const groups = data.rows.filter((r) => r.type === 'group')
  const persons = data.rows.filter((r) => r.type === 'person')
  const nasEditable = can.edit_nas && f.nas_mode === 'chosen'

  const row = (r: TableRow) => {
    const checked = r.ai.level >= 1
    const lockedOn = checked && !r.ai.direct
    const note = r.ai.inherited_from ? t('from_folder', { folder: r.ai.inherited_from }) : r.type === 'person' && r.ai.via === 'group' ? t('via_group') : null
    return (
      <tr key={`${r.type}-${r.id}`} className={r.warn ? 'warn-row' : ''}>
        <td>
          <span className="strong">{r.name}</span>
          {r.type === 'group' && <span className="muted small"> · {t('members_n', { n: r.members ?? 0 })}</span>}
          {r.warn && <div><Badge kind="warn" title={t('warn_ai_no_nas_help')}>{t('warn_ai_no_nas')}</Badge> <span className="muted small hide-narrow">{t('warn_ai_no_nas_help')}</span></div>}
        </td>
        <td className="c">
          {nasEditable && r.type === 'person'
            ? <input type="checkbox" aria-label={`${t('col_nas')}: ${r.name}`} checked={r.nas === true} disabled={a.busy} onChange={(e) => setNasPerson(r.id, e.target.checked)} />
            : <YesNo v={r.nas} />}
        </td>
        <td className="c">
          <input type="checkbox" aria-label={`${t('col_ai')}: ${r.name}`} checked={checked} disabled={!can.edit_rules || lockedOn || a.busy} onChange={(e) => setRule(r, e.target.checked)} />
          {note && <div className="muted small">{note}</div>}
        </td>
      </tr>
    )
  }

  return (
    <Page title={f.vpath ?? f.name} actions={<div className="badges"><FolderBadges f={f} /></div>}>
      <p className="crumbs">
        <a href="#/folders">← {t('folders_title')}</a>
        {data.parent && <> · <a href={`#/folders/${data.parent.id}`}>{t('parent')}: {data.parent.vpath}</a></>}
      </p>
      {f.path && <p className="muted small mono">{t('server_path')}: {f.path}</p>}
      {ownerName && <p>{t('owner')}: <strong>{ownerName}</strong></p>}
      <ErrorLine error={a.error} />

      <section className="card">
        <h2>{t('who_can_see')}</h2>
        <p className="muted small">{t('table_help')}</p>
        {f.blocked && <p className="warn">{f.no_ai ? t('no_ai_help') : t('quarantine_help')}</p>}
        {!can.edit_rules && !can.edit_nas && <p className="muted small">{t('read_only_table')}</p>}
        {f.registered && (
          <div className="nas-mode">
            <span>{t('nas_question')}</span>
            {can.edit_nas ? (
              <div className="seg">
                {NAS_MODES.map((m) => (
                  <label key={m.id} className={f.nas_mode === m.id ? 'on' : ''}>
                    <input type="radio" name="nasmode" checked={f.nas_mode === m.id} disabled={a.busy}
                      onChange={() => act(() => api('PUT', `/folders/${id}/nas`, { mode: m.id, people: nasPeople }))} />{t(m.key)}
                  </label>
                ))}
              </div>
            ) : <strong>{t(NAS_MODES.find((m) => m.id === f.nas_mode)?.key ?? 'nas_unknown')}</strong>}
            {!can.edit_nas && <span className="muted small">{t('nas_admin_only')}</span>}
          </div>
        )}
        <div className="table-wrap">
          <table className="matrix">
            <thead><tr><th></th><th className="c">{t('col_nas')}</th><th className="c">{t('col_ai')}</th></tr></thead>
            <tbody>
              {groups.length > 0 && <tr className="section"><td colSpan={3}>{t('groups')}</td></tr>}
              {groups.map(row)}
              <tr className="section"><td colSpan={3}>{t('people')}</td></tr>
              {persons.map(row)}
            </tbody>
          </table>
        </div>
        <p className="muted small">{t('inherit_help')}</p>
      </section>

      <section className="card">
        <label className="check">
          <input type="checkbox" checked={f.no_ai} disabled={a.busy || (f.no_ai ? !can.no_ai_off : !can.no_ai_on)}
            onChange={(e) => act(() => api('PATCH', `/folders/${id}`, { no_ai: e.target.checked }))} />
          <strong>{t('no_ai_label')}</strong>
        </label>
        <p className="muted small">{t('no_ai_help')} {f.no_ai && !can.no_ai_off && t('no_ai_off_admin')}</p>
        {f.registered
          ? <p className="muted small">{t('start_fresh_always')}</p>
          : (
            <label className="check">
              <input type="checkbox" checked={f.inherit_break} disabled={!can.edit_rules || a.busy} onChange={(e) => act(() => api('PATCH', `/folders/${id}`, { inherit_break: e.target.checked }))} />
              <strong>{t('start_fresh')}</strong>
            </label>
          )}
        {(can.admin || f.quarantine) && (
          <label className="check">
            <input type="checkbox" checked={f.quarantine} disabled={!can.admin || a.busy} onChange={(e) => act(() => api('PATCH', `/folders/${id}`, { quarantine: e.target.checked }))} />
            <strong>{t('quarantine_label')}</strong> <span className="muted small">{t('quarantine_help')}</span>
          </label>
        )}
      </section>

      {f.personal_owner == null && (
        <section className="card">
          <h2>{t('managers')}</h2>
          <p className="muted small">{t('managers_help')}</p>
          {data.managers.length === 0 ? <p className="muted">{t('no_managers')}</p> : (
            <ul className="plain">
              {data.managers.map((m) => (
                <li key={m.id}>{m.name} {!m.direct && <span className="muted small">({t('from_folder', { folder: data.parent?.vpath ?? '…' })})</span>}
                  {can.admin && m.direct && <button className="btn small ghost" disabled={a.busy} onClick={() => act(() => api('DELETE', `/folders/${id}/managers/${m.id}`))}>{t('remove')}</button>}
                </li>
              ))}
            </ul>
          )}
          {can.admin && <AddManager people={people.filter((p) => p.active && !data.managers.some((m) => m.id === p.id))} onAdd={(pid) => act(() => api('PUT', `/folders/${id}/managers/${pid}`))} />}
        </section>
      )}

      {(data.subfolders.length > 0 || can.edit_rules) && (
        <section className="card">
          <h2>{t('subfolders')}</h2>
          <ul className="plain">{data.subfolders.map((s) => <li key={s.id}><a href={`#/folders/${s.id}`}>{s.vpath}</a></li>)}</ul>
          {can.edit_rules && <AddSubfolder onAdd={async (rel) => { const r = await a.run(() => api<{ id: number }>('POST', `/folders/${id}/subfolders`, { rel })); if (r) go(`/folders/${r.id}`) }} />}
        </section>
      )}

      {data.nas_history.length > 0 && (
        <section className="card">
          <h2>{t('nas_history')}</h2>
          <ul className="plain small">
            {data.nas_history.map((h, i) => <li key={i}>{fmtDate(h.at)}: {nasLabel(h.old_value, people)} → {nasLabel(h.new_value, people)}</li>)}
          </ul>
        </section>
      )}

      {can.admin && f.registered && (
        <section className="card danger-zone">
          {f.personal_owner != null && <ChangeOwner people={people.filter((p) => p.active)} onPick={(pid) => act(() => api('PUT', `/folders/${id}/owner`, { owner: pid }))} />}
          <button className="btn danger" disabled={a.busy} onClick={() => { if (confirm(t('unregister_confirm'))) a.run(() => api('DELETE', `/folders/${id}`)).then((r) => { if (r) go('/folders') }) }}>{t('unregister')}</button>
        </section>
      )}
    </Page>
  )
}

function nasLabel(v: string | null, people: Person[]) {
  if (v === null) return '—'
  if (v === 'all') return t('nas_all')
  if (v === 'unknown') return t('nas_unknown')
  try { return (JSON.parse(v) as number[]).map((id) => people.find((p) => p.id === id)?.name ?? `#${id}`).join(', ') || t('none') } catch { return v }
}

function AddManager({ people, onAdd }: { people: Person[]; onAdd: (id: number) => void }) {
  const [pid, setPid] = useState<number | ''>('')
  return (
    <form className="inline" onSubmit={(e) => { e.preventDefault(); if (pid !== '') { onAdd(pid); setPid('') } }}>
      <select value={pid} onChange={(e) => setPid(Number(e.target.value))} aria-label={t('add_manager')}>
        <option value="">—</option>
        {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <button className="btn small" disabled={pid === ''}>{t('add_manager')}</button>
    </form>
  )
}

function AddSubfolder({ onAdd }: { onAdd: (rel: string) => void }) {
  const [rel, setRel] = useState('')
  return (
    <form className="inline" onSubmit={(e) => { e.preventDefault(); if (rel.trim()) onAdd(rel.trim()) }}>
      <input value={rel} onChange={(e) => setRel(e.target.value)} placeholder={t('subfolder_path')} aria-label={t('add_subfolder')} />
      <button className="btn small">{t('add_subfolder')}</button>
    </form>
  )
}

function ChangeOwner({ people, onPick }: { people: Person[]; onPick: (id: number) => void }) {
  const [pid, setPid] = useState<number | ''>('')
  return (
    <form className="inline" onSubmit={(e) => { e.preventDefault(); if (pid !== '') onPick(pid) }}>
      <select value={pid} onChange={(e) => setPid(Number(e.target.value))} aria-label={t('change_owner')}>
        <option value="">—</option>
        {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <button className="btn small" disabled={pid === ''}>{t('change_owner')}</button>
    </form>
  )
}
