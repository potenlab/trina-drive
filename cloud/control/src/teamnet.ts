// Fixed addresses for every team network (both drivers). Each team gets one /28 out of TDCLOUD_TEAM_SUBNETS, chosen by
// its number (never reused), so the same team always has the same addresses on any host:
//
//   .1  the bridge's gateway (the host: the host's mail relay listens here, cloud/control/src/relay.ts)
//   .2  Caddy, joined to the team network with this fixed address — the team's only trusted proxy
//       (TDRIVE_TRUSTED_PROXY=<.2>/32): X-Forwarded-For is believed from Caddy and from nothing else
//   .3  the team's container
//   .8–.15  the --ip-range for anything Docker would place dynamically (nothing should; it can never take .2 or .3)
//
// The relay maps a sender's address back to its team (teamOfAddress) and accepts mail only from a team's .3.
import net from 'node:net'

export const TEAM_PREFIX = 28
const SIZE = 2 ** (32 - TEAM_PREFIX)

export interface TeamNet {
  /** e.g. 10.128.0.48/28 */
  subnet: string
  gateway: string
  caddyIp: string
  teamIp: string
  ipRange: string
}

const toInt = (ip: string) => ip.split('.').reduce((a, o) => a * 256 + Number(o), 0)
const toIp = (n: number) => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join('.')

/** "10.128.0.0/11" → base and size; throws on anything that is not an IPv4 block big enough for one team. */
export function parsePool(spec: string): { base: number; prefix: number; teams: number } {
  const [ip, bits, extra] = spec.trim().split('/')
  const prefix = Number(bits)
  if (!ip || !net.isIPv4(ip) || extra !== undefined || !/^\d{1,2}$/.test(bits ?? '') || prefix < 8 || prefix > TEAM_PREFIX) {
    throw new Error(`TDCLOUD_TEAM_SUBNETS must be an IPv4 block between /8 and /${TEAM_PREFIX}, not ${spec}`)
  }
  const base = toInt(ip)
  if (base % 2 ** (32 - prefix) !== 0) throw new Error(`TDCLOUD_TEAM_SUBNETS: ${spec} is not aligned (host bits set)`)
  return { base, prefix, teams: 2 ** (TEAM_PREFIX - prefix) }
}

/** The addresses of team number `n` (1, 2, …) in the pool. Block 0 is never used. */
export function teamNet(pool: string, n: number): TeamNet {
  const p = parsePool(pool)
  if (!Number.isSafeInteger(n) || n < 1 || n >= p.teams) throw new Error(`team number ${n} does not fit in ${pool} (${p.teams - 1} teams); use a larger TDCLOUD_TEAM_SUBNETS`)
  const start = p.base + n * SIZE
  return { subnet: `${toIp(start)}/${TEAM_PREFIX}`, gateway: toIp(start + 1), caddyIp: toIp(start + 2), teamIp: toIp(start + 3), ipRange: `${toIp(start + 8)}/29` }
}

/** The team whose container has this address, or null (any other address in the pool, or outside it). */
export function teamOfAddress(pool: string, address: string | null | undefined): number | null {
  if (!address) return null
  const ip = address.startsWith('::ffff:') ? address.slice(7) : address
  if (!net.isIPv4(ip)) return null
  const p = parsePool(pool)
  const off = toInt(ip) - p.base
  if (off < SIZE || off >= p.teams * SIZE || off % SIZE !== 3) return null
  return Math.floor(off / SIZE)
}
