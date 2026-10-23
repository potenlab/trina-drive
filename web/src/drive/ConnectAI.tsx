// "Connect your AI" (#/connect, plan 2.4): per client, the shortest way to give a person's own AI their access — never
// more (R1: the AI reads what the person may read, minus "No AI" folders, within the token's folders).
//   Claude Code / Codex: the client's own remote-MCP entry and its browser sign-in (OAuth, no token to copy), or the
//   tdrive command (password sign-in; not offered when the team signs in only through Trina Cloud).
//   Claude.ai / ChatGPT: a custom connector pointed at <server>/mcp, approved on this server's consent page.
//   Cursor: the tdrive command, then turn it on in Cursor.
// Below: access tokens (make one per computer, see last use, revoke) and the apps connected through OAuth.
import { useState } from 'react'
import { useSession } from '../App'
import {
  AI_CLIENT_LABEL, AI_CLIENTS, BRAND_CTX, claudeOAuthCommand, codexOAuthCommands, mcpUrl, recommendedCommand,
  type AiClient, type ConnectCtx,
} from '../connect'
import { t } from '../i18n'
import { TokenManager } from '../pages/Tokens'
import { CopyButton } from '../ui'
import { Icon } from './Icon'

function Cmd({ text }: { text: string }) {
  return <div className="cmd"><code>{text}</code><CopyButton text={text} /></div>
}
// a #fragment would be a route here: scroll instead
const TokensLink = () => <a href="#/connect" onClick={(e) => { e.preventDefault(); document.getElementById('tokens')?.scrollIntoView({ behavior: 'smooth' }) }}>{t('tokens_title')}</a>
function Steps({ items }: { items: React.ReactNode[] }) {
  return <ol className="steps">{items.map((x, i) => <li key={i}><span className="step-n" aria-hidden="true">{i + 1}</span><div>{x}</div></li>)}</ol>
}

export function ConnectAI() {
  const { me } = useSession()
  const [client, setClient] = useState<AiClient>('claude')
  const c: ConnectCtx = { ...BRAND_CTX, origin: window.location.origin, login: me?.name ?? '', admin: !!me?.admin }
  const ssoOnly = !!me?.cloud?.sso_only
  const url = mcpUrl(c.origin)
  const cliAlt = (k: 'claude' | 'codex' | 'cursor') => ssoOnly
    ? <p className="muted small">{t('cai_token_route', { cli: c.cli })} <TokensLink /></p>
    : <><p className="small">{t('cai_cli_route', { cli: c.cli })}</p><Cmd text={recommendedCommand(c, k)} />{c.admin && <p className="muted small">{t('connect_admin_scope')}</p>}</>
  return (
    <section className="page connect-page">
      <header className="page-head"><div><h1>{t('nav_connect')}</h1><p className="muted">{t('cai_intro')}</p></div></header>

      <div className="card cai">
        <div className="tabs" role="tablist" aria-label={t('cai_pick_client')}>
          {AI_CLIENTS.map((x) => <button key={x} type="button" role="tab" aria-selected={x === client} className={x === client ? 'on' : ''} onClick={() => setClient(x)}>{AI_CLIENT_LABEL[x]}</button>)}
        </div>
        <div role="tabpanel" className="cai-panel">
          {client === 'claude' && <>
            <h2>{t('cai_claude_title')}</h2>
            <Steps items={[
              <><p>{t('cai_claude_1')}</p><Cmd text={claudeOAuthCommand(c)} /></>,
              <p>{t('cai_claude_2')}</p>,
              <p>{t('cai_claude_3')}</p>,
            ]} />
            <details className="manual"><summary>{t('cai_other_way', { cli: c.cli })}</summary>{cliAlt('claude')}</details>
          </>}
          {client === 'codex' && <>
            <h2>{t('cai_codex_title')}</h2>
            <Steps items={[
              <><p>{t('cai_codex_1')}</p><Cmd text={codexOAuthCommands(c)[0]!} /></>,
              <><p>{t('cai_codex_2')}</p><Cmd text={codexOAuthCommands(c)[1]!} /></>,
              <p>{t('cai_codex_3')}</p>,
            ]} />
            <details className="manual"><summary>{t('cai_other_way', { cli: c.cli })}</summary>{cliAlt('codex')}<p className="muted small">{t('connect_env')} <code>. ~/.config/{c.cli}/env.sh</code></p></details>
          </>}
          {client === 'claude_ai' && <>
            <h2>{t('cai_claude_ai_title')}</h2>
            <Steps items={[
              <p>{t('cai_claude_ai_1')}</p>,
              <><p>{t('cai_connector_url')}</p><Cmd text={url} /></>,
              <p>{t('cai_claude_ai_3')}</p>,
              <p>{t('cai_consent')}</p>,
            ]} />
          </>}
          {client === 'chatgpt' && <>
            <h2>{t('cai_chatgpt_title')}</h2>
            <Steps items={[
              <p>{t('cai_chatgpt_1')}</p>,
              <><p>{t('cai_connector_url')}</p><Cmd text={url} /></>,
              <p>{t('cai_chatgpt_3')}</p>,
              <p>{t('cai_consent')}</p>,
            ]} />
          </>}
          {client === 'cursor' && <>
            <h2>{t('cai_cursor_title')}</h2>
            {ssoOnly ? <Steps items={[<p>{t('cai_token_route', { cli: c.cli })} <TokensLink /></p>, <p>{t('connect_cursor_enable')}</p>]} />
              : <Steps items={[
                <><p>{t('cai_cli_route', { cli: c.cli })}</p><Cmd text={recommendedCommand(c, 'cursor')} /></>,
                <><p>{t('connect_env')}</p><Cmd text={`. ~/.config/${c.cli}/env.sh`} /></>,
                <p>{t('connect_cursor_enable')}</p>,
              ]} />}
          </>}
        </div>
        <p className="cai-safe small"><Icon name="approvals" size={16} /> {t('cai_safety')}</p>
      </div>

      <div className="card note-card">
        <Icon name="mount" size={18} />
        <p className="small">{t('cai_mount_note')} {me?.storage === 'managed' && <a href="#/mount">{t('nav_mount')}</a>}</p>
      </div>

      <TokenManager />
      <p className="muted small">{t('token_terms')}</p>
    </section>
  )
}
