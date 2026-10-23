// Team skills test helpers: skill folders on disk, libraries, approvals at the core level, and MCP calls straight into
// the /mcp handler in both protocol eras (2025-11-25 initialize; 2026-07-28 per-request _meta + headers).
import fs from 'node:fs'
import path from 'node:path'
import { handleRequest } from '../src/mcp'
import type { Ctx } from '../src/session'
import { approveVersion, designate, folderRowAt, libraries, pendingOf, scan } from '../src/skills/core'
import { SKILLS_EXTENSION } from '../src/skills/mcp'

export const MODERN = '2026-07-28', LEGACY = '2025-11-25'

export function skillMd(name: string, description: string, body = `# ${name}\n\nSteps for ${name}.\n`, extra = '') {
  return `---\nname: ${name}\ndescription: ${description}\n${extra}---\n${body}`
}

/** Write <dir>/<name>/SKILL.md (+ files) on disk. */
export function writeSkill(dir: string, name: string, description: string, opts: { body?: string; files?: Record<string, string | Uint8Array>; extra?: string } = {}) {
  const d = path.join(dir, name)
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, 'SKILL.md'), skillMd(name, description, opts.body, opts.extra))
  for (const [rel, c] of Object.entries(opts.files ?? {})) { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), c) }
  return d
}

export function makeLibrary(db: Ctx['db'], real: string, slug: string, by: number | null = null) {
  fs.mkdirSync(real, { recursive: true })
  return designate(db, folderRowAt(db, fs.realpathSync(real)), slug, by)
}

/** Scan, then approve the pending version of slug/name as person `by` (core level: the web step-up is tested apart). */
export function approveNow(ctx: Ctx, qname: string, by: number) {
  scan(ctx.db, ctx.dataDir)
  const [slug, name] = qname.split('/')
  const lib = libraries(ctx.db).find((l) => l.slug === slug)!
  const v = pendingOf(ctx.db, lib.folder_id, name!)
  if (!v) throw new Error(`nothing pending for ${qname}`)
  return approveVersion(ctx.db, ctx.dataDir, v.id, by, v.digest)
}

export type Rpc = { status: number; body: { result?: Record<string, any>; error?: { code: number; message: string } } ; raw: string }

/** One JSON-RPC message to /mcp. era 'modern' adds _meta and the 2026-07-28 headers; `skills` declares the extension. */
export async function rpc(ctx: Ctx, secret: string, method: string, params: Record<string, unknown> = {}, o: { era?: 'legacy' | 'modern'; skills?: boolean; id?: number } = {}): Promise<Rpc> {
  const era = o.era ?? 'legacy'
  const caps = o.skills ? { extensions: { [SKILLS_EXTENSION]: {} } } : {}
  const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${secret}` }
  let p: Record<string, unknown> = params
  if (era === 'modern') {
    headers['mcp-protocol-version'] = MODERN
    headers['mcp-method'] = method
    if (typeof params.name === 'string') headers['mcp-name'] = params.name
    p = { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientCapabilities': caps, 'io.modelcontextprotocol/clientInfo': { name: 'skills-test', version: '1' } } }
  } else {
    if (method === 'initialize') p = { protocolVersion: LEGACY, capabilities: caps, clientInfo: { name: 'skills-test', version: '1' }, ...params }
    else headers['mcp-protocol-version'] = LEGACY
  }
  const res = await handleRequest(ctx, new Request('http://drive.test/mcp', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: o.id ?? 1, method, params: p }) }))
  const raw = await res.text()
  return { status: res.status, body: raw ? JSON.parse(raw) : {}, raw }
}

export const instructionsOf = async (ctx: Ctx, secret: string, era: 'legacy' | 'modern') =>
  (await rpc(ctx, secret, era === 'legacy' ? 'initialize' : 'server/discover', {}, { era })).body.result!.instructions as string

export async function callSkills(ctx: Ctx, secret: string, args: Record<string, unknown>, era: 'legacy' | 'modern' = 'legacy') {
  const r = await rpc(ctx, secret, 'tools/call', { name: 'skills', arguments: args }, { era })
  return r
}
export const textOfCall = (r: Rpc) => (r.body.result?.content ?? []).map((c: { text: string }) => c.text).join('\n')
