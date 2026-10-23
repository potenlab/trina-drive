// People and groups. Everyone sees names and groups; the admin adds people (invite link), resets passwords (the link
// goes only to the person's mail), and manages groups.
import { useState } from 'react'
import { api, get, type Group, type Person } from '../api'
import { useSession } from '../App'
import { t } from '../i18n'
import { Badge, ErrorLine, Loading, Page, Secret, useAction, useLoad } from '../ui'

export function People() {
  const { me } = useSession()
  const { data, error, reload } = useLoad(() => get<{ people: Person[]; groups: Group[]; max_people?: number | null }>('/people'))
  const a = useAction()
  const [invite, setInvite] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  if (!data) return <Page title={t('people_title')}><ErrorLine error={error} /><Loading /></Page>
  const admin = !!me?.admin
  const act = async (fn: () => Promise<unknown>) => { const r = await a.run(fn); if (r !== undefined) reload(); return r }
  const groupName = (id: number) => data.groups.find((g) => g.id === id)?.name ?? '?'
  const status = (p: Person) => !p.active ? t('status_inactive') : p.signed_up === false ? (p.email ? t('status_invited') : t('status_no_account')) : t('status_active')

  return (
    <Page title={t('people_title')}>
      <ErrorLine error={a.error ?? error} />
      {notice && <p className="ok">{notice}</p>}
      {data.max_people != null && (() => {
        // the plan's people limit (TDRIVE_MAX_PEOPLE, e.g. Trina Cloud Free): the server refuses a fourth with the same words
        const n = data.people.filter((p) => p.active).length
        return <p className={n >= data.max_people ? 'err' : 'muted small'}>{n >= data.max_people ? t('people_limit_full', { max: data.max_people }) : t('people_limit', { n, max: data.max_people })}</p>
      })()}
      {admin && <AddPerson groups={data.groups} onAdded={(url) => { setInvite(url); reload() }} run={a.run} busy={a.busy} />}
      {invite && <div className="card"><p>{t('invite_link')}</p><Secret text={invite} /><button className="btn small ghost" onClick={() => setInvite(null)}>{t('close')}</button></div>}

      <section className="card">
        <h2>{t('people')}</h2>
        <ul className="rows">
          {data.people.map((p) => (
            <li key={p.id} className={p.active ? '' : 'dim'}>
              <div className="row-main">
                <strong>{p.name}</strong> {p.admin && <Badge kind="accent">{t('admin')}</Badge>}
                {p.email !== undefined && <span className="muted small"> {p.email ?? ''} · {status(p)}</span>}
                <div className="muted small">{t('in_groups')}: {p.groups.map(groupName).join(', ') || t('none')}</div>
              </div>
              {admin && (
                <div className="row-actions">
                  {p.signed_up === false && <button className="btn small" disabled={a.busy} onClick={async () => {
                    const email = p.email ?? prompt(t('email'))
                    if (!email) return
                    const r = await act(() => api<{ invite_url: string }>('POST', `/people/${p.id}/invite`, { email }))
                    if (r) setInvite((r as { invite_url: string }).invite_url)
                  }}>{t('reinvite')}</button>}
                  {p.signed_up && <button className="btn small" disabled={a.busy} onClick={async () => {
                    if (!confirm(t('reset_confirm', { name: p.name }))) return
                    const r = await act(() => api<{ tokens_revoked: number }>('POST', `/people/${p.id}/reset`, {}))
                    if (r) setNotice(t('reset_done', { n: (r as { tokens_revoked: number }).tokens_revoked }))
                  }}>{t('reset_password')}</button>}
                  <button className="btn small ghost" disabled={a.busy} onClick={() => { const email = prompt(t('change_email_prompt'), p.email ?? ''); if (email) act(() => api('PATCH', `/people/${p.id}`, { email })) }}>{t('change_email')}</button>
                  {p.id !== me?.id && <button className="btn small ghost" disabled={a.busy} onClick={() => act(() => api('PATCH', `/people/${p.id}`, { admin: !p.admin }))}>{p.admin ? t('remove_admin') : t('make_admin')}</button>}
                  {p.id !== me?.id && <button className="btn small ghost" disabled={a.busy} onClick={() => act(() => api('PATCH', `/people/${p.id}`, { active: !p.active }))}>{p.active ? t('deactivate') : t('activate')}</button>}
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>{t('groups')}</h2>
        {admin && <AddGroup onAdd={(name) => act(() => api('POST', '/groups', { name }))} />}
        <ul className="rows">
          {data.groups.map((g) => (
            <li key={g.id}>
              <div className="row-main">
                <strong>{g.name}</strong> <span className="muted small">{t('members_n', { n: g.members.length })}</span>
                <div className="chips">
                  {g.members.map((pid) => {
                    const p = data.people.find((x) => x.id === pid)
                    return <span key={pid} className="chip">{p?.name ?? '?'}{admin && <button className="x" aria-label={t('remove')} disabled={a.busy} onClick={() => act(() => api('DELETE', `/groups/${g.id}/members/${pid}`))}>×</button>}</span>
                  })}
                </div>
              </div>
              {admin && (
                <div className="row-actions">
                  <select aria-label={t('add_member')} value="" disabled={a.busy} onChange={(e) => { const pid = Number(e.target.value); if (pid) act(() => api('PUT', `/groups/${g.id}/members/${pid}`)) }}>
                    <option value="">{t('add_member')}…</option>
                    {data.people.filter((p) => p.active && !g.members.includes(p.id)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  <button className="btn small ghost" disabled={a.busy} onClick={() => { if (confirm(t('delete_group_confirm', { name: g.name }))) act(() => api('DELETE', `/groups/${g.id}`)) }}>{t('delete_group')}</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>
    </Page>
  )
}

function AddPerson({ groups, onAdded, run, busy }: { groups: Group[]; onAdded: (url: string) => void; run: ReturnType<typeof useAction>['run']; busy: boolean }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [admin, setAdmin] = useState(false)
  const [gs, setGs] = useState<number[]>([])
  return (
    <form className="card" onSubmit={async (e) => {
      e.preventDefault()
      const r = await run(() => api<{ invite_url: string }>('POST', '/people', { name, email, admin, groups: gs }))
      if (r) { setName(''); setEmail(''); setAdmin(false); setGs([]); onAdded(r.invite_url) }
    }}>
      <h2>{t('add_person')}</h2>
      <div className="grid2">
        <label>{t('person_name')}<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
        <label>{t('email')}<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
      </div>
      <div className="chips">
        {groups.map((g) => <label key={g.id} className="check chip"><input type="checkbox" checked={gs.includes(g.id)} onChange={(e) => setGs(e.target.checked ? [...gs, g.id] : gs.filter((x) => x !== g.id))} />{g.name}</label>)}
      </div>
      <label className="check"><input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} /> {t('admin')}</label>
      <button className="btn primary" disabled={busy}>{t('add_person')}</button>
    </form>
  )
}

function AddGroup({ onAdd }: { onAdd: (name: string) => Promise<unknown> }) {
  const [name, setName] = useState('')
  return (
    <form className="inline" onSubmit={async (e) => { e.preventDefault(); if (name.trim() && await onAdd(name.trim()) !== undefined) setName('') }}>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('group_name')} aria-label={t('group_name')} />
      <button className="btn small">{t('add_group')}</button>
    </form>
  )
}
