// The five agent tools. Each call: one Session (policy view + provenance), the work, then one commit with the audit
// row. If the commit (audit) fails the call fails and nothing it wrote is kept.
import { draftVersions, sourcesFor, sourcesLine } from './drafts'
import { promoteByAgent } from './promote-tool'
import { Access } from './policy'
import { type Ctx, Session } from './session'
import { runShell } from './shell'
import { sha256, type TokenRow } from './store'
import { asFsError, MSG, VirtualFs, type Hit } from './vfs'
import { discardKept } from './worker'

export interface ToolResult { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean }
export class AuditFailure extends Error {}

const str = { type: 'string' } as const
export const TOOL_DEFS = [
  { name: 'bash', description: 'Run a read-only bash command over the team folders you may read (originals at /, drafts at /drafts/). grep/rg are ripgrep. Office files (pdf, docx, xlsx, pptx, hwp, hwpx) read as extracted text; original bytes at /.raw/<path>. Writes only to /drafts/.',
    inputSchema: { type: 'object', properties: { command: str }, required: ['command'], additionalProperties: false } },
  { name: 'read', description: 'Read a file as text (office files: extracted text). offset is the first line (1-based), limit the number of lines.',
    inputSchema: { type: 'object', properties: { path: str, offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1 } }, required: ['path'], additionalProperties: false } },
  { name: 'write', description: 'Write a draft under /drafts/ (text: .md, .csv, .txt …). Originals are read-only; a person moves drafts. Pass expected_sha256 to overwrite only the version you read.',
    inputSchema: { type: 'object', properties: { path: str, content: str, expected_sha256: str }, required: ['path', 'content'], additionalProperties: false } },
  { name: 'edit', description: 'Replace text in one of your drafts. old_string must match exactly once unless replace_all. Pass expected_sha256 (from read) to refuse if the draft changed.',
    inputSchema: { type: 'object', properties: { path: str, old_string: str, new_string: str, replace_all: { type: 'boolean' }, expected_sha256: str }, required: ['path', 'old_string', 'new_string'], additionalProperties: false } },
  { name: 'history', description: 'Older versions of a draft: action "list", "read" (with version) or "restore" (with version; your own drafts only).',
    inputSchema: { type: 'object', properties: { path: str, action: { type: 'string', enum: ['list', 'read', 'restore'] }, version: { type: 'integer', minimum: 1 } }, required: ['path', 'action'], additionalProperties: false } },
  { name: 'promote', description: 'Put one of your drafts into a team folder as a NEW file: draft = /drafts/… path, folder = target folder path (e.g. /프로젝트/2026), name = new file name (.md, .txt, .csv …). In managed storage (the server keeps every earlier version) overwrite: true replaces an existing file of that name as a new version; elsewhere a promote never overwrites. The folder must allow promote and your rule there must be write. If the folder\'s readers are wider than the draft\'s sources, nothing is written: a person must approve it on the web with a passkey (this returns the link; you cannot approve). reason is shown to the approver as your claim. Pass expected_sha256 to promote only the version you read.',
    inputSchema: { type: 'object', properties: { draft: str, folder: str, name: str, reason: str, expected_sha256: str, overwrite: { type: 'boolean' } }, required: ['draft', 'folder', 'name'], additionalProperties: false } },
] as const

const text = (t: string, extra?: Partial<ToolResult>): ToolResult => ({ content: [{ type: 'text', text: t }], ...extra })
const fail = (t: string) => text(t, { isError: true })
class Refuse extends Error {}

/** The error a tool shows: an FsError's text, anything else a fixed I/O error (reported server-side; see vfs.ts). */
function fsMessage(e: unknown, p: string): string {
  const f = asFsError(e, 'open', p)
  return f.code === 'ENOENT' ? `No such file or directory: ${p}` : f.code === 'EISDIR' ? `Is a directory: ${p}` : f.message
}

/** Sources of the caller's own draft at `rel`, as this token may be shown them (원칙 2: hidden folders only counted). */
function sourcesOf(ctx: Ctx, token: TokenRow, rel: string): string {
  const src = new Map(ctx.db.query<{ folder_id: number; strong: number }, [number, string]>(
    'SELECT s.folder_id, s.strong FROM draft_src s JOIN drafts d ON d.id = s.draft_id WHERE d.token_id = ? AND d.path = ? AND d.deleted_at IS NULL')
    .all(token.id, rel).map((s) => [s.folder_id, !!s.strong] as const))
  // a fresh view: the commit may have just added folder rows for subfolders this call touched
  return sourcesLine(sourcesFor(Access.forToken(ctx.db, token), src))
}

const draftRelOf = (vfs: VirtualFs, p: string) => {
  const n = vfs.resolvePath('/', p)
  return n.startsWith('/drafts/') ? n.slice(8).normalize('NFC') : null
}

export async function callTool(ctx: Ctx, token: TokenRow, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const s = new Session(ctx, token)
  const vfs = new VirtualFs(s)
  const arg = (k: string) => { const v = args[k]; if (typeof v !== 'string') throw new Refuse(`missing string argument "${k}"`); return v }
  let result: ToolResult
  let audit = name
  let outcome = 'ok'
  let wrote: string | null = null
  let finish: (() => void) | undefined
  try {
    switch (name) {
      case 'bash': {
        const command = arg('command')
        audit = command
        const r = await runShell(s, command)
        outcome = `exit ${r.exitCode}`
        const body = r.stdout + (r.stderr ? (r.stdout && !r.stdout.endsWith('\n') ? '\n' : '') + '[stderr]\n' + r.stderr : '') + `[exit code ${r.exitCode}]`
        result = text(body, { structuredContent: { ...r } })
        break
      }
      case 'read': {
        const p = vfs.resolvePath('/', arg('path'))
        const offset = Number(args.offset ?? 1), limit = Number(args.limit ?? 2000)
        audit = `read ${p} offset=${offset} limit=${limit}`
        const h = vfs.resolve(p)
        if (!h) { result = fail(`No such file or directory: ${p}`); outcome = 'not found'; break }
        if (h.t !== 'file' && h.t !== 'draft' && h.t !== 'sys') { result = fail(`Is a directory: ${p} (use bash ls)`); outcome = 'directory'; break }
        let bytes: Uint8Array
        try { bytes = await vfs.bytesOf(h, p) } catch (e) { result = fail(fsMessage(e, p)); outcome = 'error'; break }
        if (bytes.subarray(0, 8000).includes(0)) { result = fail(`Binary file: ${p} (use bash, e.g. od or sha256sum)`); outcome = 'binary'; break }
        const lines = new TextDecoder().decode(bytes).split('\n')
        if (lines.at(-1) === '') lines.pop()
        const slice = lines.slice(offset - 1, offset - 1 + limit)
        const more = lines.length - (offset - 1 + slice.length)
        const sha = h.t === 'draft' ? sha256(bytes) : undefined
        result = text(slice.join('\n') + (more > 0 ? `\n[${more} more lines: read with offset=${offset + slice.length}]` : ''),
          { structuredContent: { path: p, totalLines: lines.length, ...(sha ? { sha256: sha } : {}), ...(s.extracted.size ? { extractedText: true } : {}) } })
        if (sha) result.content.push({ type: 'text', text: `[draft sha256: ${sha}]` })
        break
      }
      case 'write': {
        const p = vfs.resolvePath('/', arg('path'))
        const content = new TextEncoder().encode(arg('content'))
        audit = `write ${p} (${content.length} bytes, sha256 ${sha256(content)})`
        const h = vfs.resolve(p)
        if (typeof args.expected_sha256 === 'string' && h?.t === 'draft' && sha256(s.draftContent(h.item)) !== args.expected_sha256) {
          throw new Refuse(`The draft changed since you read it (sha256 is now ${sha256(s.draftContent(h.item))}); read it again.`)
        }
        try { vfs.write(p, content, false) } catch (e) { result = fail(fsMessage(e, p)); outcome = 'refused'; break }
        wrote = draftRelOf(vfs, p)
        result = text(`Wrote ${p} (${content.length} bytes, sha256 ${sha256(content)}).`)
        break
      }
      case 'edit': {
        const p = vfs.resolvePath('/', arg('path'))
        const oldS = arg('old_string'), newS = arg('new_string')
        audit = `edit ${p}`
        const h = vfs.resolve(p)
        if (!h) { result = fail(`No such file or directory: ${p}`); outcome = 'not found'; break }
        if (h.t === 'file') s.notes.add(MSG.readOnly) // an attempt to write an original (notify)
        if (h.t !== 'draft') { result = fail(h.t === 'file' ? MSG.readOnly : `Not a file: ${p}`); outcome = 'refused'; break }
        if (!h.item.own) { result = fail(MSG.otherDraft); outcome = 'refused'; break }
        const cur = await vfs.bytesOf(h, p)
        if (typeof args.expected_sha256 === 'string' && sha256(cur) !== args.expected_sha256) throw new Refuse(`The draft changed since you read it (sha256 is now ${sha256(cur)}); read it again.`)
        const t = new TextDecoder().decode(cur)
        const n = t.split(oldS).length - 1
        if (!oldS || n === 0) throw new Refuse('old_string was not found in the draft.')
        if (n > 1 && !args.replace_all) throw new Refuse(`old_string occurs ${n} times; add more context or set replace_all.`)
        const next = new TextEncoder().encode(args.replace_all ? t.split(oldS).join(newS) : t.replace(oldS, () => newS))
        try { vfs.write(p, next, false) } catch (e) { result = fail(fsMessage(e, p)); outcome = 'refused'; break }
        wrote = draftRelOf(vfs, p)
        result = text(`Edited ${p} (sha256 ${sha256(next)}).`)
        break
      }
      case 'history': {
        const p = vfs.resolvePath('/', arg('path'))
        const action = arg('action')
        audit = `history ${action} ${p}${args.version ? ' v' + args.version : ''}`
        const h: Hit | null = vfs.resolve(p)
        if (!h || h.t !== 'draft' || !h.item.draft) { result = fail(`No such draft: ${p}`); outcome = 'not found'; break }
        const versions = draftVersions(ctx.db, h.item.draft.id)
        if (action === 'list') {
          s.touchDraft(h.item, false)
          result = text(versions.map((v) => `v${v.version}\t${new Date(v.created_at).toISOString()}\t${v.size} bytes\t${v.sha256}`).join('\n'), { structuredContent: { versions } })
          break
        }
        const v = versions.find((x) => x.version === Number(args.version))
        if (!v) throw new Refuse(`No version ${args.version} (have ${versions.map((x) => x.version).join(', ')})`)
        s.touchDraft(h.item, true)
        const bytes = ctx.blobs.get(v.sha256)
        if (action === 'read') { result = text(new TextDecoder().decode(bytes)); break }
        if (action !== 'restore') throw new Refuse('action must be list, read or restore')
        if (!h.item.own) { result = fail(MSG.otherDraft); outcome = 'refused'; break }
        vfs.write(p, bytes, false)
        wrote = draftRelOf(vfs, p)
        result = text(`Restored ${p} to v${v.version} as a new version.`)
        break
      }
      case 'promote': {
        const dp = vfs.resolvePath('/', arg('draft'))
        const folder = arg('folder'), target = arg('name')
        audit = `promote ${dp} -> ${folder.replace(/\/+$/, '')}/${target}`
        if (token.read_only) throw new Refuse(MSG.tokenReadOnly)
        const h = vfs.resolve(dp)
        if (!h || h.t !== 'draft' || !h.item.draft || h.item.pending) { result = fail(`No such draft: ${dp}`); outcome = 'not found'; break }
        if (!h.item.own) { result = fail('Only drafts this token wrote can be promoted.'); outcome = 'refused'; break }
        const r = promoteByAgent(ctx, s, h.item.draft, folder, target, args.reason, args.expected_sha256, args.overwrite)
        result = text(r.text, { isError: r.isError || undefined, structuredContent: r.structured })
        outcome = r.outcome
        if (r.finish) {
          const res = result
          finish = () => { r.finish!(); res.content = [{ type: 'text', text: r.text }]; res.structuredContent = r.structured; if (r.isError) res.isError = true; else delete res.isError }
        }
        break
      }
      default:
        throw new Refuse(`unknown tool ${name}`)
    }
  } catch (e) {
    if (!(e instanceof Refuse)) throw e
    result = fail(e.message)
    outcome = 'refused'
  }
  try { s.commit(name, audit, outcome) } catch (e) {
    for (const undo of s.onAbort) { try { undo() } catch (u) { console.error('[tools] undo failed:', u) } }
    // nothing of this call is recorded (touches included), so no worker that saw it may serve this token again
    await discardKept(String(token.id), String(token.person_id))
    throw new AuditFailure(`The call could not be recorded in the audit log, so it was not completed (${(e as Error).message}).`)
  }
  finish?.()
  if (wrote !== null) {
    result.content.push({ type: 'text', text: sourcesOf(ctx, token, wrote) })
  }
  return result
}
