// Register a folder with one of the four templates (plan 4.1: 공용 / 팀 / 경영·인사 / 개인) and the one NAS question.
import { useEffect, useState } from 'react'
import { api, get, type Group, type Person } from '../api'
import { t, type Key } from '../i18n'
import { ErrorLine, useAction } from '../ui'

type Template = 'public' | 'team' | 'management' | 'personal' | 'custom'
type NasMode = 'all' | 'same-as-ai' | 'chosen' | 'unknown'
const TEMPLATES: { id: Template; name: Key; desc: Key }[] = [
  { id: 'public', name: 'tpl_public', desc: 'tpl_public_d' },
  { id: 'team', name: 'tpl_team', desc: 'tpl_team_d' },
  { id: 'management', name: 'tpl_management', desc: 'tpl_management_d' },
  { id: 'personal', name: 'tpl_personal', desc: 'tpl_personal_d' },
  { id: 'custom', name: 'tpl_custom', desc: 'tpl_custom_d' },
]
const NAS_DEFAULT: Record<Template, NasMode> = { public: 'all', team: 'same-as-ai', management: 'unknown', personal: 'chosen', custom: 'unknown' }
export const NAS_MODES: { id: NasMode; key: Key }[] = [
  { id: 'all', key: 'nas_all' }, { id: 'same-as-ai', key: 'nas_same' }, { id: 'chosen', key: 'nas_chosen' }, { id: 'unknown', key: 'nas_unknown' },
]

export function RegisterForm({ onDone }: { onDone: (id: number) => void }) {
  const [people, setPeople] = useState<Person[]>([])
  const [groups, setGroups] = useState<Group[]>([])
  const [path, setPath] = useState('')
  const [name, setName] = useState('')
  const [template, setTemplate] = useState<Template>('team')
  const [group, setGroup] = useState<number | ''>('')
  const [owner, setOwner] = useState<number | ''>('')
  const [noAi, setNoAi] = useState(false)
  const [nas, setNas] = useState<NasMode>('same-as-ai')
  const [chosen, setChosen] = useState<number[]>([])
  const [warnings, setWarnings] = useState<string[]>([])
  const a = useAction()
  useEffect(() => { get<{ people: Person[]; groups: Group[] }>('/people').then((r) => { setPeople(r.people.filter((p) => p.active)); setGroups(r.groups) }, () => {}) }, [])
  const pick = (tp: Template) => { setTemplate(tp); setNas(NAS_DEFAULT[tp]); setNoAi(tp === 'management') }

  return (
    <form className="register" onSubmit={async (e) => {
      e.preventDefault()
      const body = {
        path, name: name || undefined, template, no_ai: noAi,
        ...(template === 'team' || template === 'management' ? { group } : {}),
        ...(template === 'personal' ? { owner } : { nas: { mode: nas, people: chosen } }),
      }
      const r = await a.run(() => api<{ id: number; warnings: string[] }>('POST', '/folders', body))
      if (r) { setWarnings(r.warnings); setPath(''); setName(''); onDone(r.id) }
    }}>
      <label>{t('reg_path')}<input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/Volumes/office/경영" required spellCheck={false} /></label>
      <label>{t('reg_name')}<input value={name} onChange={(e) => setName(e.target.value)} /></label>
      <fieldset>
        <legend>{t('reg_template')}</legend>
        <div className="templates">
          {TEMPLATES.map((x) => (
            <label key={x.id} className={`tpl ${template === x.id ? 'on' : ''}`}>
              <input type="radio" name="tpl" checked={template === x.id} onChange={() => pick(x.id)} />
              <strong>{t(x.name)}</strong><span className="muted">{t(x.desc)}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {(template === 'team' || template === 'management') && (
        <label>{t('reg_group')}
          <select value={group} onChange={(e) => setGroup(Number(e.target.value))} required>
            <option value="" disabled>—</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </label>
      )}
      {template === 'personal' && (
        <label>{t('reg_owner')}
          <select value={owner} onChange={(e) => setOwner(Number(e.target.value))} required>
            <option value="" disabled>—</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
      )}
      {template !== 'personal' && <>
        <label className="check"><input type="checkbox" checked={noAi} onChange={(e) => setNoAi(e.target.checked)} /> {t('reg_no_ai')}</label>
        <fieldset>
          <legend>{t('nas_question')}</legend>
          <div className="seg">
            {NAS_MODES.map((m) => <label key={m.id} className={nas === m.id ? 'on' : ''}><input type="radio" name="nas" checked={nas === m.id} onChange={() => setNas(m.id)} />{t(m.key)}</label>)}
          </div>
          {nas === 'unknown' && <p className="muted small">{t('nas_unknown_help')}</p>}
          {nas === 'chosen' && (
            <div className="chips">
              {people.map((p) => (
                <label key={p.id} className="check chip">
                  <input type="checkbox" checked={chosen.includes(p.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, p.id] : chosen.filter((x) => x !== p.id))} />{p.name}
                </label>
              ))}
            </div>
          )}
        </fieldset>
      </>}
      <ErrorLine error={a.error} />
      {warnings.includes('former_personal') && <p className="warn">{t('reg_warn_former_personal')}</p>}
      {warnings.includes('looks_like_home') && <p className="warn">{t('reg_warn_home')}</p>}
      <button className="btn primary" disabled={a.busy}>{t('reg_submit')}</button>
    </form>
  )
}
