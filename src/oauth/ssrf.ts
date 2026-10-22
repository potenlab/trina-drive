// Fetching a URL someone else chose (a Client ID Metadata Document: the client_id IS the URL the server fetches) without
// letting it reach the office LAN, this machine, or a cloud metadata service (plan 7.1 "OAuth 공격", review-tech 4.1).
//
//   - https only (plain http only when a test guard says so), no user:password@, no redirects (a 3xx is a refusal)
//   - the host name is resolved ONCE by our own lookup; every address it returns must be public, and the connection is
//     made to exactly those addresses (node's `lookup` hook), so a DNS answer that changes between the check and the
//     connect (rebinding) cannot point the socket somewhere else; an IP literal is checked as it is
//   - 3 s for the whole exchange, 8 KB body, application/json
// The guard is injectable (resolver, address rule, http for local fixtures) so tests run a local metadata server.
import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { NAME, VERSION } from '../config'

export interface FetchGuard {
  /** every address of a host name (default: the system resolver, all families) */
  resolve: (host: string) => Promise<{ address: string; family: number }[]>
  /** may a connection go to this address (default: public unicast only) */
  allowAddress: (ip: string) => boolean
  /** plain http (tests with a local fixture only) */
  allowHttp: boolean
  timeoutMs: number
  maxBytes: number
}

export const DEFAULT_GUARD: FetchGuard = {
  resolve: (host) => dns.promises.lookup(host, { all: true, verbatim: true }),
  allowAddress: (ip) => isPublicAddress(ip),
  allowHttp: false,
  timeoutMs: 3000,
  maxBytes: 8 * 1024,
}

export class FetchRefused extends Error {}

// ---------- addresses ----------
function v4(ip: string): number[] | null {
  const p = ip.split('.')
  if (p.length !== 4 || p.some((x) => !/^\d{1,3}$/.test(x) || Number(x) > 255)) return null
  return p.map(Number)
}

/** 16 bytes of an IPv6 address (with an embedded dotted IPv4 tail), or null. */
export function v6Bytes(ip: string): number[] | null {
  if (net.isIPv6(ip) === false) return null
  let s = ip.toLowerCase()
  const zone = s.indexOf('%')
  if (zone >= 0) s = s.slice(0, zone)
  let tail: number[] = []
  const lastColon = s.lastIndexOf(':')
  if (s.slice(lastColon + 1).includes('.')) {
    const q = v4(s.slice(lastColon + 1))
    if (!q) return null
    tail = q
    s = s.slice(0, lastColon + 1) + '0:0'
  }
  const [head, rest] = s.includes('::') ? s.split('::') as [string, string] : [s, null]
  const hx = head ? head.split(':') : []
  const rx = rest === null ? [] : rest ? rest.split(':') : []
  const fill = rest === null ? 0 : 8 - hx.length - rx.length
  if (fill < 0) return null
  const groups = [...hx, ...Array(fill).fill('0'), ...rx]
  if (groups.length !== 8) return null
  const out: number[] = []
  for (const g of groups) { const n = parseInt(g || '0', 16); out.push(n >> 8, n & 255) }
  if (tail.length) out.splice(12, 4, ...tail)
  return out
}

function v4Public(b: number[]): boolean {
  const [a, c] = [b[0]!, b[1]!]
  if (a === 0 || a === 10 || a === 127) return false                 // this network, private, loopback
  if (a === 100 && c >= 64 && c <= 127) return false                  // carrier-grade NAT 100.64/10
  if (a === 169 && c === 254) return false                            // link-local (cloud metadata 169.254.169.254)
  if (a === 172 && c >= 16 && c <= 31) return false                   // private
  if (a === 192 && c === 168) return false                            // private
  if (a === 192 && c === 0 && (b[2] === 0 || b[2] === 2)) return false // IETF protocol assignments, TEST-NET-1
  if (a === 192 && c === 88 && b[2] === 99) return false               // 6to4 relay anycast
  if (a === 198 && (c === 18 || c === 19)) return false               // benchmarking
  if (a === 198 && c === 51 && b[2] === 100) return false              // TEST-NET-2
  if (a === 203 && c === 0 && b[2] === 113) return false               // TEST-NET-3
  if (a >= 224) return false                                          // multicast, reserved, broadcast
  return true
}

/** Public unicast only: no private, loopback, link-local, CGNAT, ULA, multicast, documentation or transition ranges. */
export function isPublicAddress(ip: string): boolean {
  const a = v4(ip)
  if (a) return v4Public(a)
  const b = v6Bytes(ip)
  if (!b) return false
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d: judge the IPv4 address
  if (b.slice(0, 10).every((x) => x === 0) && ((b[10] === 0xff && b[11] === 0xff) || (b[10] === 0 && b[11] === 0))) {
    return b.slice(12).some((x) => x !== 0) && v4Public(b.slice(12))
  }
  // only global unicast 2000::/3 …
  if ((b[0]! & 0xe0) !== 0x20) return false
  // … minus 2001::/23 (Teredo, ORCHID, benchmarking …), 2001:db8::/32 (documentation), 2002::/16 (6to4: embeds any IPv4)
  if (b[0] === 0x20 && b[1] === 0x01 && b[2]! < 0x02) return false
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return false
  if (b[0] === 0x20 && b[1] === 0x02) return false
  return true
}

// ---------- fetch ----------
export interface Fetched { body: unknown; maxAgeS: number | null }

/** GET a JSON document under the guard. Throws FetchRefused with a reason a person can read. */
export async function guardedGetJson(rawUrl: string, guard: FetchGuard = DEFAULT_GUARD): Promise<Fetched> {
  let url: URL
  try { url = new URL(rawUrl) } catch { throw new FetchRefused('not a URL') }
  if (url.protocol !== 'https:' && !(guard.allowHttp && url.protocol === 'http:')) throw new FetchRefused('only https URLs are fetched')
  if (url.username || url.password) throw new FetchRefused('a URL with a user name or password is not fetched')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!host) throw new FetchRefused('no host')

  let lookup: net.LookupFunction | undefined
  if (net.isIP(host)) {
    if (!guard.allowAddress(host)) throw new FetchRefused('address is not public')
  } else {
    let addrs: { address: string; family: number }[]
    try { addrs = await withTimeout(guard.resolve(host), guard.timeoutMs, 'name lookup timed out') } catch (e) {
      throw e instanceof FetchRefused ? e : new FetchRefused('the host name does not resolve')
    }
    if (!addrs.length) throw new FetchRefused('the host name does not resolve')
    // every address must be allowed: one private answer among public ones refuses the lot
    if (addrs.some((a) => !guard.allowAddress(a.address))) throw new FetchRefused('the host name resolves to an address that is not public')
    // the socket connects only to these, resolved above (no second lookup that could answer differently)
    lookup = ((_h: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => {
      if (opts && opts.all) cb(null, addrs)
      else cb(null, addrs[0]!.address, addrs[0]!.family)
    }) as unknown as net.LookupFunction
  }

  const mod = url.protocol === 'https:' ? https : http
  return new Promise<Fetched>((resolve, reject) => {
    let settled = false
    const done = (err: Error | null, v?: Fetched) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) { req.destroy(); reject(err instanceof FetchRefused ? err : new FetchRefused(err.message || 'fetch failed')) } else resolve(v!)
    }
    const req = mod.request({
      protocol: url.protocol, hostname: host, port: url.port || undefined, path: url.pathname + url.search, method: 'GET', agent: false,
      headers: { accept: 'application/json', 'user-agent': `${NAME}/${VERSION} (client metadata)` },
      ...(lookup ? { lookup } : {}),
      ...(url.protocol === 'https:' && !net.isIP(host) ? { servername: host } : {}),
    }, (res) => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400) return done(new FetchRefused('redirects are not followed'))
      if (status !== 200) return done(new FetchRefused(`the document answered HTTP ${status}`))
      const ct = String(res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
      if (ct !== 'application/json' && !ct.endsWith('+json')) return done(new FetchRefused('the document is not application/json'))
      if (Number(res.headers['content-length'] ?? 0) > guard.maxBytes) return done(new FetchRefused(`the document is larger than ${guard.maxBytes} bytes`))
      const chunks: Buffer[] = []
      let n = 0
      res.on('data', (c: Buffer) => {
        n += c.length
        if (n > guard.maxBytes) return done(new FetchRefused(`the document is larger than ${guard.maxBytes} bytes`))
        chunks.push(c)
      })
      res.on('error', (e) => done(e))
      res.on('end', () => {
        let body: unknown
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return done(new FetchRefused('the document is not valid JSON')) }
        done(null, { body, maxAgeS: maxAge(String(res.headers['cache-control'] ?? '')) })
      })
    })
    const timer = setTimeout(() => done(new FetchRefused('the document took too long')), guard.timeoutMs)
    req.on('error', (e) => done(e))
    req.end()
  })
}

function maxAge(cc: string): number | null {
  if (/\b(no-store|no-cache)\b/i.test(cc)) return 0
  const m = /\bmax-age=(\d+)/i.exec(cc)
  return m ? Number(m[1]) : null
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new FetchRefused(msg)), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
  })
}
