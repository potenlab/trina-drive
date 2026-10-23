// Client addresses behind a reverse proxy on the main listener (`serve --trusted-proxy`). The per-address sign-in and
// MCP limits, the audit's addresses and the connection records all use the address handleWeb is given; without a
// trusted proxy that is the TCP peer, and behind Caddy (Trina Cloud) every request would share Caddy's address.
//
// A forwarded header is believed only when the TCP peer is one of the trusted proxies (addresses or CIDR ranges).
// X-Forwarded-For is read from the right: the first entry that is not itself a trusted proxy is the client (an entry
// the client wrote at the far left is never preferred over what the proxy appended). CF-Connecting-IP is believed only
// when chosen explicitly (`--client-ip-header cf-connecting-ip`, for cloudflared in front of this listener): a proxy
// such as Caddy passes a client's own CF-Connecting-IP header through unchanged.
import net from 'node:net'

export type ClientIpHeader = 'x-forwarded-for' | 'cf-connecting-ip'

export interface TrustedProxies {
  /** as configured (for the banner and errors) */
  spec: string
  list: net.BlockList
  header: ClientIpHeader
}

/** "::ffff:10.0.0.1" → "10.0.0.1"; "[::1]" → "::1"; anything not an address → null. */
export function normalizeIp(raw: string | undefined | null): string | null {
  if (!raw) return null
  let s = raw.trim()
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1)
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(s)) s = s.slice(7)
  return net.isIP(s) ? s : null
}

/** "127.0.0.1, 172.18.0.0/16, fd00::/8" → a matcher. Throws on anything else (a typo must not trust nothing silently). */
export function parseTrustedProxies(spec: string, header: string = 'x-forwarded-for'): TrustedProxies {
  const h = header.trim().toLowerCase()
  if (h !== 'x-forwarded-for' && h !== 'cf-connecting-ip') throw new Error(`client address header must be x-forwarded-for or cf-connecting-ip, not ${header}`)
  const list = new net.BlockList()
  const parts = spec.split(',').map((p) => p.trim()).filter(Boolean)
  if (!parts.length) throw new Error('--trusted-proxy needs at least one address or CIDR range')
  for (const p of parts) {
    const [addr, bits, extra] = p.split('/')
    const ip = normalizeIp(addr)
    if (!ip || extra !== undefined) throw new Error(`not an address or CIDR range: ${p}`)
    const type = net.isIPv4(ip) ? 'ipv4' : 'ipv6'
    if (bits === undefined) { list.addAddress(ip, type); continue }
    const n = Number(bits)
    if (!/^\d{1,3}$/.test(bits) || n > (type === 'ipv4' ? 32 : 128)) throw new Error(`bad prefix length in ${p}`)
    list.addSubnet(ip, n, type)
  }
  return { spec: parts.join(','), list, header: h }
}

export function isTrusted(t: TrustedProxies, ip: string | null): boolean {
  if (!ip) return false
  return t.list.check(ip, net.isIPv4(ip) ? 'ipv4' : 'ipv6')
}

/** The client's address: the TCP peer (as given, when no proxy is trusted), or what a trusted proxy says. Never throws. */
export function forwardedClient(req: Request, peer: string | undefined, trusted: TrustedProxies | null | undefined): string | undefined {
  if (!trusted) return peer
  const p = normalizeIp(peer)
  const fallback = p ?? peer
  if (!isTrusted(trusted, p)) return fallback
  if (trusted.header === 'cf-connecting-ip') return normalizeIp(req.headers.get('cf-connecting-ip')) ?? fallback
  const hops = (req.headers.get('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  for (let i = hops.length - 1; i >= 0; i--) {
    const ip = normalizeIp(hops[i])
    // garbage in the chain: stop rather than skip past it to something a client wrote further left
    if (!ip) return fallback
    if (!isTrusted(trusted, ip)) return ip
  }
  return fallback
}

/** From `serve` flags, else the environment (<PREFIX>_TRUSTED_PROXY, <PREFIX>_CLIENT_IP_HEADER). null = not configured. */
export function trustedProxiesFrom(flag: string | undefined, header: string | undefined, env: Record<string, string | undefined>, prefix: string): TrustedProxies | null {
  const spec = flag ?? env[`${prefix}_TRUSTED_PROXY`]
  if (!spec || spec === 'none') return null
  return parseTrustedProxies(spec, header ?? env[`${prefix}_CLIENT_IP_HEADER`] ?? 'x-forwarded-for')
}
