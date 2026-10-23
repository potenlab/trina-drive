// "Mount as a drive" (#/mount): the WebDAV address, Mac/Windows steps and app passwords (pages/Mount.tsx), with the
// one thing to know first (plan 10.2-16): a mounted drive is the person, not their AI — it opens what they can open on
// the web, "No AI" folders included, so an agent must not work inside it.
import { t } from '../i18n'
import { dt } from '../pages/drive-i18n'
import { MountSettings } from '../pages/Mount'
import { Icon } from './Icon'

export function MountPage() {
  return (
    <section className="page">
      <header className="page-head"><div><h1>{dt('mt_title')}</h1><p className="muted">{dt('mt_help')}</p></div></header>
      <div className="card note-card warn-card"><Icon name="info" size={18} /><p className="small">{t('mount_no_ai_note')} <a href="#/connect">{t('nav_connect')}</a></p></div>
      <MountSettings bare />
    </section>
  )
}
