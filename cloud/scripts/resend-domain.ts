#!/usr/bin/env bun
// The Resend sending domain for Trina Cloud: drive.trina.app (teams send as drive@drive.trina.app, the control plane as
// cloud@drive.trina.app). Its DNS is at Cloudflare (the trina.app zone), where the owner adds the records Resend's
// dashboard shows (Domains → drive.trina.app, region Tokyo ap-northeast-1). This script never needs more than a
// sending-only key and by default changes nothing anywhere:
//
//   bun cloud/scripts/resend-domain.ts                    print the records to add and check public DNS for them
//                                                          (no API key used): DKIM TXT resend._domainkey.<domain>,
//                                                          MX + SPF TXT on send.<domain> (bounces), DMARC TXT
//   … --records                                           also ask Resend for the exact values (GET /domains: needs a
//                                                          full-access key; a sending-only key gets 401/403 and the
//                                                          script says so)
//   … --records --create [--region ap-northeast-1]        create the domain in Resend when it does not exist
//   … --records --route53 [--zone-id Z…] [--profile tdcloud] [--dry-run]
//                                                          upsert the records into a Route 53 zone instead of adding
//                                                          them by hand (only for a domain inside a Route 53 zone)
//   … --records --verify                                  ask Resend to verify the domain now
//
// Options: --domain (default drive.trina.app), --root (the DNS zone the names are relative to; default: --domain
// without its first label, trina.app), --key-file (default ~/.config/trina-drive/resend-api-key, must be 0600; the
// key is never printed).
import dns from 'node:dns/promises'
import { LOCAL_KEY_FILE, RESEND_API, readSecretFile, redact } from '../control/src/resend'

export interface ResendRecord { record?: string; name: string; type: string; value: string; ttl?: string | number; priority?: number; status?: string }
export interface ResendDomain { id: string; name: string; status?: string; region?: string; records?: ResendRecord[] }
export interface Change { Action: 'UPSERT'; ResourceRecordSet: { Name: string; Type: string; TTL: number; ResourceRecords: { Value: string }[] } }

export interface Options {
  domain: string
  root: string
  region: string
  keyFile: string
  endpoint: string
  records: boolean
  create: boolean
  verify: boolean
  route53: boolean
  zoneId: string | null
  profile: string
  dryRun: boolean
}

export interface Resolver {
  resolveTxt(name: string): Promise<string[][]>
  resolveMx(name: string): Promise<{ exchange: string; priority: number }[]>
}

export interface Deps {
  fetch: (url: string, init?: RequestInit) => Promise<Response>
  /** runs the AWS CLI with these arguments (--profile added by the caller); returns stdout, throws on failure */
  aws: (args: string[]) => Promise<string>
  dns: Resolver
  log: (s: string) => void
  key: () => string
}

export function parseArgs(argv: string[], env: Record<string, string | undefined> = process.env): Options {
  const a = [...argv]
  const take = (name: string) => { const i = a.indexOf(name); if (i < 0) return undefined; const v = a[i + 1]; if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value`); a.splice(i, 2); return v }
  const flag = (name: string) => { const i = a.indexOf(name); if (i < 0) return false; a.splice(i, 1); return true }
  const domain = (take('--domain') ?? 'drive.trina.app').toLowerCase().replace(/\.$/, '')
  const o: Options = {
    domain,
    root: (take('--root') ?? domain.split('.').slice(1).join('.')).toLowerCase().replace(/\.$/, ''),
    region: take('--region') ?? 'ap-northeast-1',
    keyFile: take('--key-file') ?? LOCAL_KEY_FILE,
    endpoint: (env.RESEND_API_URL || RESEND_API).replace(/\/$/, ''),
    zoneId: take('--zone-id') ?? null,
    profile: take('--profile') ?? env.AWS_PROFILE ?? 'tdcloud',
    records: flag('--records'),
    create: flag('--create'),
    verify: flag('--verify'),
    route53: flag('--route53'),
    dryRun: flag('--dry-run'),
  }
  if (a.length) throw new Error(`unknown arguments: ${a.join(' ')}`)
  if (!/^([a-z0-9-]+\.)+[a-z0-9-]+$/.test(o.domain) || o.root.split('.').length < 2) throw new Error(`bad --domain / --root: ${o.domain} / ${o.root}`)
  if (o.domain !== o.root && !o.domain.endsWith(`.${o.root}`)) throw new Error(`--domain ${o.domain} is not inside --root ${o.root}`)
  if ((o.create || o.verify || o.route53) && !o.records) throw new Error('--create, --verify and --route53 go with --records')
  return o
}

/**
 * The record's full name. Resend gives names relative to the registered domain (for drive.trina.app:
 * `resend._domainkey.drive`, `send.drive`); one that would fall outside --domain that way is read relative to --domain.
 */
export function fqdn(name: string, domain: string, root: string): string {
  const n = name.toLowerCase().replace(/\.$/, '')
  const inside = (x: string) => x === domain || x.endsWith(`.${domain}`)
  if (inside(n)) return n
  const hit = (n === '' || n === '@' ? [root, domain] : [`${n}.${root}`, `${n}.${domain}`]).find(inside)
  if (!hit) throw new Error(`Resend record ${name} is outside ${domain}`)
  return hit
}

/** a name relative to the zone at --root, as Cloudflare's "Name" field wants it */
export const relative = (full: string, root: string) => (full === root ? '@' : full.slice(0, -(root.length + 1)))

const txtValue = (v: string) => {
  const raw = v.trim().replace(/^"|"$/g, '').replace(/"\s*"/g, '')
  return (raw.match(/.{1,255}/g) ?? ['']).map((p) => `"${p.replace(/(["\\])/g, '\\$1')}"`).join(' ')
}

/** Resend's records → Route 53 UPSERTs (one record set per name and type). */
export function planChanges(records: ResendRecord[], domain: string, root: string): Change[] {
  const sets = new Map<string, Change>()
  for (const r of records) {
    const type = r.type.toUpperCase()
    if (!['TXT', 'MX', 'CNAME'].includes(type)) throw new Error(`unexpected record type ${r.type} for ${r.name}`)
    const name = fqdn(r.name, domain, root)
    const value = type === 'TXT' ? txtValue(r.value) : type === 'MX' ? `${r.priority ?? 10} ${r.value.replace(/\.$/, '')}` : r.value.replace(/\.$/, '')
    const ttl = Number.isFinite(Number(r.ttl)) && Number(r.ttl) > 0 ? Number(r.ttl) : 300
    const c = sets.get(`${name} ${type}`)
    if (c) { if (type === 'CNAME') throw new Error(`two CNAMEs for ${name}`); if (!c.ResourceRecordSet.ResourceRecords.some((x) => x.Value === value)) c.ResourceRecordSet.ResourceRecords.push({ Value: value }) }
    else sets.set(`${name} ${type}`, { Action: 'UPSERT', ResourceRecordSet: { Name: name, Type: type, TTL: ttl, ResourceRecords: [{ Value: value }] } })
  }
  return [...sets.values()]
}

export interface Check { name: string; type: 'TXT' | 'MX'; want: string; ok: boolean; found: string }

/** What Resend needs in public DNS (values as far as they are known without the API) and whether it is there. */
export async function checkDns(o: Pick<Options, 'domain' | 'region'>, r: Resolver): Promise<Check[]> {
  const txt = async (n: string) => { try { return (await r.resolveTxt(n)).map((p) => p.join('')) } catch { return [] } }
  const mx = async (n: string) => { try { return await r.resolveMx(n) } catch { return [] } }
  const dkim = await txt(`resend._domainkey.${o.domain}`)
  const spf = await txt(`send.${o.domain}`)
  const bounce = await mx(`send.${o.domain}`)
  const dmarc = await txt(`_dmarc.${o.domain}`)
  const feedback = `feedback-smtp.${o.region}.amazonses.com`
  return [
    { name: `resend._domainkey.${o.domain}`, type: 'TXT', want: 'p=… (DKIM public key from the Resend dashboard)', ok: dkim.some((v) => /^p=[A-Za-z0-9+/=]{100,}/.test(v.replace(/\s/g, ''))), found: dkim.join(' | ') },
    { name: `send.${o.domain}`, type: 'MX', want: `10 ${feedback}`, ok: bounce.some((m) => m.exchange.replace(/\.$/, '').toLowerCase() === feedback), found: bounce.map((m) => `${m.priority} ${m.exchange}`).join(' | ') },
    { name: `send.${o.domain}`, type: 'TXT', want: 'v=spf1 include:amazonses.com ~all', ok: spf.some((v) => /^v=spf1\b.*\binclude:amazonses\.com\b/.test(v)), found: spf.join(' | ') },
    { name: `_dmarc.${o.domain}`, type: 'TXT', want: 'v=DMARC1; p=quarantine; adkim=r; aspf=r; rua=mailto:contact@trina.app (recommended)', ok: dmarc.some((v) => /^v=DMARC1\b/.test(v)), found: dmarc.join(' | ') },
  ]
}

async function api<T>(d: Deps, o: Options, method: string, p: string, body?: unknown): Promise<T> {
  const key = d.key()
  const res = await d.fetch(`${o.endpoint}${p}`, {
    method, signal: AbortSignal.timeout(20_000),
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'user-agent': 'trina-cloud-resend-domain/0.1' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  if (res.status === 401 || res.status === 403) throw new Error(`resend ${method} ${p}: ${res.status} — the key cannot manage domains (a sending-only key can't). Read the records in the Resend dashboard instead, or use a full-access key with --key-file.`)
  if (!res.ok) throw new Error(redact(`resend ${method} ${p}: ${res.status} ${text.slice(0, 300)}`, key))
  return (text ? JSON.parse(text) : {}) as T
}

export async function run(o: Options, d: Deps): Promise<{ checks: Check[]; domain?: ResendDomain; changes: Change[] }> {
  d.log(`Sending domain ${o.domain} (Resend region ${o.region}); names below are relative to the ${o.root} zone (Cloudflare: proxy status "DNS only").`)
  let domain: ResendDomain | undefined
  let changes: Change[] = []
  if (o.records) {
    const list = await api<{ data?: ResendDomain[] }>(d, o, 'GET', '/domains')
    const found = (list.data ?? []).find((x) => x.name.toLowerCase() === o.domain)
    if (found) {
      domain = await api<ResendDomain>(d, o, 'GET', `/domains/${encodeURIComponent(found.id)}`)
      if (domain.region && domain.region !== o.region) d.log(`note: the domain is in ${domain.region}, not ${o.region} (a domain's region cannot change)`)
    } else if (o.create) {
      domain = await api<ResendDomain>(d, o, 'POST', '/domains', { name: o.domain, region: o.region })
      d.log(`created the domain in Resend (${domain.id})`)
    } else throw new Error(`no domain ${o.domain} in Resend: add it in the dashboard (region ${o.region}) or pass --create`)
    changes = planChanges(domain.records ?? [], o.domain, o.root)
    d.log(`Resend: ${o.domain} is ${domain.status ?? '?'}. Its records:`)
    for (const c of changes) for (const v of c.ResourceRecordSet.ResourceRecords) d.log(`  ${relative(c.ResourceRecordSet.Name, o.root).padEnd(28)} ${c.ResourceRecordSet.Type.padEnd(5)} ${v.Value}`)
  } else {
    d.log('Add at Cloudflare the records the Resend dashboard shows for the domain (no API call made: run with --records and a full-access key to print them here):')
    d.log(`  ${relative(`resend._domainkey.${o.domain}`, o.root).padEnd(28)} TXT   p=…  (DKIM)`)
    d.log(`  ${relative(`send.${o.domain}`, o.root).padEnd(28)} MX    10 feedback-smtp.${o.region}.amazonses.com`)
    d.log(`  ${relative(`send.${o.domain}`, o.root).padEnd(28)} TXT   v=spf1 include:amazonses.com ~all`)
  }
  d.log(`  ${relative(`_dmarc.${o.domain}`, o.root).padEnd(28)} TXT   v=DMARC1; p=quarantine; adkim=r; aspf=r; rua=mailto:contact@trina.app  (recommended)`)

  if (o.route53) {
    let zoneId = o.zoneId
    if (!zoneId) {
      const z = JSON.parse(await d.aws(['route53', 'list-hosted-zones-by-name', '--dns-name', o.root, '--max-items', '1', '--output', 'json'])) as { HostedZones?: { Id: string; Name: string; Config?: { PrivateZone?: boolean } }[] }
      const hit = (z.HostedZones ?? []).find((h) => h.Name.replace(/\.$/, '') === o.root && !h.Config?.PrivateZone)
      if (!hit) throw new Error(`no public Route 53 zone ${o.root}; pass --zone-id (drive.trina.app is at Cloudflare: add the records there)`)
      zoneId = hit.Id.replace(/^\/hostedzone\//, '')
    }
    const batch = JSON.stringify({ Comment: `Resend sending domain ${o.domain}`, Changes: changes })
    if (o.dryRun) d.log(`--dry-run: would upsert ${changes.length} record set(s) in Route 53 zone ${zoneId}:\n${JSON.stringify(JSON.parse(batch), null, 2)}`)
    else {
      await d.aws(['route53', 'change-resource-record-sets', '--hosted-zone-id', zoneId, '--change-batch', batch, '--output', 'json'])
      d.log(`Route 53 zone ${zoneId}: ${changes.length} record set(s) upserted`)
    }
  }
  if (o.verify && domain) {
    await api(d, o, 'POST', `/domains/${encodeURIComponent(domain.id)}/verify`)
    d.log('Resend: verification started (the dashboard shows "Verified" once DNS has propagated)')
  }

  const checks = await checkDns(o, d.dns)
  d.log('Public DNS now:')
  for (const c of checks) d.log(`  ${c.ok ? 'ok     ' : 'MISSING'} ${c.name} ${c.type}${c.ok ? '' : `  want: ${c.want}`}${c.found ? `  (found: ${c.found.slice(0, 80)})` : ''}`)
  return { checks, domain, changes }
}

if (import.meta.main) {
  try {
    const o = parseArgs(process.argv.slice(2))
    let key: string | null = null
    const { checks } = await run(o, {
      fetch: (u, i) => fetch(u, i),
      key: () => (key ??= readSecretFile(o.keyFile)),
      log: (s) => console.log(s),
      dns,
      aws: async (args) => {
        const p = Bun.spawn(['aws', ...args, '--profile', o.profile], { stdout: 'pipe', stderr: 'pipe' })
        const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
        if (code !== 0) throw new Error(`aws ${args.slice(0, 2).join(' ')}: ${err.trim() || `exit ${code}`}`)
        return out
      },
    })
    process.exit(checks.slice(0, 3).every((c) => c.ok) ? 0 : 2)
  } catch (e) {
    console.error(`resend-domain: ${(e as Error).message}`)
    process.exit(1)
  }
}
