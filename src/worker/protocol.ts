// Wire protocol between the server (parent) and an isolated worker process.
// Transport: the worker's stdin (parent -> worker) and stdout (worker -> parent). The worker sends its own logs to stderr.
// Frame: [u32 BE header length][u32 BE body length][header: UTF-8 JSON][body: raw bytes]. The body carries binary payloads
// (file bytes, stdin of a parent-run command, extracted text) so they never go through JSON/base64.
// The parent treats everything the worker sends as untrusted: sizes are checked before buffering, shapes are validated.

export const PROTOCOL_VERSION = 1

/** Error as it crosses the wire: errno-style code plus the message the shell prints. */
export interface WireError { code: string; message: string; path?: string }

export interface WireStat { isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean; mode: number; size: number; mtimeMs: number }
export interface WireDirent { name: string; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }

/** Filesystem operations the worker may ask for. Content for write/append travels in the frame body; read returns it in the body. */
export const FS_OPS = ['stat', 'lstat', 'exists', 'readdir', 'read', 'write', 'append', 'mkdir', 'rm', 'cp', 'mv', 'chmod', 'utimes', 'symlink', 'link', 'readlink', 'realpath'] as const
export type FsOp = (typeof FS_OPS)[number]

export interface ShellJob {
  kind: 'shell'
  command: string
  cwd?: string
  env?: Record<string, string>
  /** Commands the worker wraps so that filesystem calls made inside them carry the command line (parent decides read modes). */
  wrap?: string[]
  /** Commands the parent runs itself (e.g. grep/rg on real ripgrep over the text mirror). */
  parentCommands?: string[]
  /** Passed to just-bash (JSON-safe subset). */
  bash?: { executionLimitProfile?: string; executionLimits?: Record<string, number> }
  /** Worker truncates stdout/stderr to these sizes before replying. */
  maxStdoutBytes?: number
  maxStderrBytes?: number
}

export interface ExtractJob {
  kind: 'extract'
  /** Absolute path of the extractor module (trusted server code), and the export to call as fn(name, bytes) => string. */
  module: string
  fn?: string
  /** File name (the extension picks the parser). */
  name: string
  /** Read this path inside the worker (it must be read-granted); otherwise the bytes are the frame body. */
  path?: string
}

export type JobSpec = ShellJob | ExtractJob

// parent -> worker
export type ToWorker =
  | { t: 'job'; v: number; job: JobSpec }
  | { t: 'reply'; id: number; ok: true; value?: unknown }
  | { t: 'reply'; id: number; ok: false; error: WireError }

// worker -> parent
export type FromWorker =
  | { t: 'ready'; v: number }
  | { t: 'fs'; id: number; op: FsOp; args: unknown[]; cmd?: string[] }
  | { t: 'cmd'; id: number; name: string; args: string[]; cwd: string; cmd?: string[] }
  | { t: 'done'; ok: true; result: unknown }
  | { t: 'done'; ok: false; error: WireError }

export interface Frame<H> { h: H; body?: Uint8Array }

export class ProtocolError extends Error {}

const enc = new TextEncoder()
const dec = new TextDecoder()

export function encodeFrame(h: unknown, body?: Uint8Array): Uint8Array {
  const hb = enc.encode(JSON.stringify(h))
  const blen = body?.byteLength ?? 0
  const out = new Uint8Array(8 + hb.byteLength + blen)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, hb.byteLength)
  dv.setUint32(4, blen)
  out.set(hb, 8)
  if (body && blen) out.set(body, 8 + hb.byteLength)
  return out
}

/** Incremental frame parser with hard size limits (checked from the length prefix, before buffering the frame). */
export class FrameDecoder<H = unknown> {
  private chunks: Uint8Array[] = []
  private size = 0
  constructor(public maxHeader: number, public maxBody: number) {}

  push(chunk: Uint8Array): Frame<H>[] {
    if (chunk.byteLength) { this.chunks.push(chunk); this.size += chunk.byteLength }
    const out: Frame<H>[] = []
    for (;;) {
      if (this.size < 8) break
      const head = this.peek(8)
      const dv = new DataView(head.buffer, head.byteOffset, 8)
      const hlen = dv.getUint32(0), blen = dv.getUint32(4)
      if (hlen > this.maxHeader) throw new ProtocolError(`frame header too large (${hlen} bytes)`)
      if (blen > this.maxBody) throw new ProtocolError(`frame body too large (${blen} bytes)`)
      if (this.size < 8 + hlen + blen) break
      const all = this.take(8 + hlen + blen)
      let h: H
      try { h = JSON.parse(dec.decode(all.subarray(8, 8 + hlen))) as H } catch { throw new ProtocolError('frame header is not JSON') }
      out.push(blen ? { h, body: all.slice(8 + hlen) } : { h })
    }
    return out
  }

  private peek(n: number): Uint8Array {
    if (this.chunks[0]!.byteLength >= n) return this.chunks[0]!
    this.chunks = [this.concat()]
    return this.chunks[0]!
  }
  private take(n: number): Uint8Array {
    const all = this.chunks.length === 1 ? this.chunks[0]! : this.concat()
    const rest = all.subarray(n)
    this.chunks = rest.byteLength ? [rest] : []
    this.size = rest.byteLength
    return all.subarray(0, n)
  }
  private concat(): Uint8Array {
    const out = new Uint8Array(this.size)
    let o = 0
    for (const c of this.chunks) { out.set(c, o); o += c.byteLength }
    return out
  }
}

const isStr = (x: unknown): x is string => typeof x === 'string'
const isStrArr = (x: unknown): x is string[] => Array.isArray(x) && x.every(isStr)
const isId = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0

/** Validates a message from the (untrusted) worker. Returns an error string, or null when the shape is acceptable. */
export function checkFromWorker(h: unknown): string | null {
  if (!h || typeof h !== 'object') return 'message is not an object'
  const m = h as Record<string, unknown>
  switch (m.t) {
    case 'ready': return typeof m.v === 'number' ? null : 'ready without version'
    case 'fs':
      if (!isId(m.id)) return 'fs: bad id'
      if (!(FS_OPS as readonly string[]).includes(m.op as string)) return `fs: unknown op ${String(m.op).slice(0, 40)}`
      if (!Array.isArray(m.args) || m.args.length > 4) return 'fs: bad args'
      if (m.cmd !== undefined && !isStrArr(m.cmd)) return 'fs: bad cmd'
      return null
    case 'cmd':
      if (!isId(m.id) || !isStr(m.name) || !isStrArr(m.args) || !isStr(m.cwd)) return 'cmd: bad shape'
      if (m.cmd !== undefined && !isStrArr(m.cmd)) return 'cmd: bad cmd'
      return null
    case 'done':
      if (m.ok === true) return null
      if (m.ok === false && m.error && typeof m.error === 'object') return null
      return 'done: bad shape'
    default: return `unknown message type ${String(m.t).slice(0, 40)}`
  }
}
