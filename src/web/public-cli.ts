// `public enable | status | disable` (plan 5.2 "공개 주소"). Settings only: `serve` starts the public listener when the
// gate passes. Running cloudflared is the operator's step (docs/CONNECT-CLAUDE-AI.md "Public address").
import { NAME } from '../config'
import type { DB } from '../db'
import { DEFAULT_CLIENT_HOSTS } from '../oauth/config'
import { readPublicSettings, writePublicSettings, type PublicSettings } from '../oauth/settings'
import { StoreError } from '../store'
import { publicGate, publicUrlProblem, SECURITY_GATE_CHECKLIST } from './public'

export const PUBLIC_HELP = `  public enable --url https://HOST [--port 8788] [--host 127.0.0.1] [--trusted-proxy 127.0.0.1]
                [--confirm-admin-2fa] [--confirm-security-gate [--gate-version V]] [--allow-dcr | --no-dcr]
                [--client-host H]… [--any-client] [--default-clients]
                                         public address for claude.ai / ChatGPT through a tunnel (OAuth issuer = URL)
  public status                          settings and the public gate
  public disable                         stop serving the public listener (OAuth connections stay; revoke them on the web)`

function takeAll(args: string[], name: string): string[] {
  const out: string[] = []
  for (let i = args.indexOf(name); i >= 0; i = args.indexOf(name)) {
    const v = args[i + 1]
    if (v === undefined || v.startsWith('--')) throw new StoreError(`${name} needs a value`)
    out.push(v)
    args.splice(i, 2)
  }
  return out
}
const take = (args: string[], name: string) => takeAll(args, name).at(-1)
const flag = (args: string[], name: string) => { const i = args.indexOf(name); if (i >= 0) args.splice(i, 1); return i >= 0 }

export function statusText(db: DB, s: PublicSettings = readPublicSettings(db)): string {
  const g = publicGate(db, s)
  const lines = [
    `public listener: ${s.enabled ? 'enabled' : 'disabled'}${s.url ? `  ${s.url}` : ''}  (listens on ${s.host}:${s.port})`,
    `OAuth: ${s.url ? `issuer ${s.url}, resource ${s.url}/mcp, CIMD clients from ${s.clientHosts === 'any' ? 'any https host' : s.clientHosts.join(', ')}, dynamic registration ${s.dcr ? 'ON' : 'off'}` : 'off (no public URL)'}`,
    `gate: ${g.ok ? 'PASSES — serve starts the public listener' : 'NOT passed — serve does not start the public listener'}`,
    ...g.checks.map((c) => `  [${c.ok ? 'x' : ' '}] ${c.text}${c.required ? '' : ' (advice)'}`),
  ]
  if (s.gateConfirmedAt == null) lines.push('v0.2 security gate (confirm with --confirm-security-gate once all hold):', ...SECURITY_GATE_CHECKLIST.map((x) => `  - ${x}`))
  return lines.join('\n')
}

export function publicCommand(db: DB, sub: string | undefined, rest: string[], out: (s: string) => void = console.log): boolean {
  const s = readPublicSettings(db)
  switch (sub) {
    case 'status': out(statusText(db, s)); return true
    case 'disable': writePublicSettings(db, { ...s, enabled: false }); out('public listener disabled (restart serve); OAuth connections stay until revoked on the web'); return true
    case 'enable': {
      const url = take(rest, '--url') ?? s.url
      const problem = publicUrlProblem(url)
      if (problem) throw new StoreError(problem)
      const origin = new URL(url!).origin
      const port = take(rest, '--port'), host = take(rest, '--host'), proxy = take(rest, '--trusted-proxy'), gateVersion = take(rest, '--gate-version')
      const hosts = takeAll(rest, '--client-host')
      const next: PublicSettings = { ...s, enabled: true, url: origin }
      if (port !== undefined) { const n = Number(port); if (!Number.isInteger(n) || n < 1 || n > 65535) throw new StoreError('--port must be 1–65535'); next.port = n }
      if (host !== undefined) next.host = host
      if (proxy !== undefined) next.trustedProxy = proxy === 'none' ? null : proxy
      if (flag(rest, '--allow-dcr')) next.dcr = true
      if (flag(rest, '--no-dcr')) next.dcr = false
      if (flag(rest, '--any-client')) next.clientHosts = 'any'
      if (flag(rest, '--default-clients')) next.clientHosts = [...DEFAULT_CLIENT_HOSTS]
      if (hosts.length) next.clientHosts = [...new Set([...(next.clientHosts === 'any' ? [] : next.clientHosts), ...hosts.map((h) => h.toLowerCase())])]
      if (flag(rest, '--confirm-admin-2fa')) next.admin2faConfirmedAt = Date.now()
      if (flag(rest, '--confirm-security-gate')) { next.gateConfirmedAt = Date.now(); next.gateVersion = gateVersion ?? null }
      if (rest.length) throw new StoreError(`unknown option ${rest[0]}`)
      if (s.url && s.url !== origin) out(`warning: the public URL changes from ${s.url} to ${origin}; OAuth tokens issued for ${s.url}/mcp stop working (people connect again)`)
      writePublicSettings(db, next)
      out(statusText(db, next))
      out(`\nnext: restart \`${NAME} serve\`, then point a Cloudflare tunnel at http://${next.host}:${next.port} (docs/CONNECT-CLAUDE-AI.md)`)
      return true
    }
    default: return false
  }
}
