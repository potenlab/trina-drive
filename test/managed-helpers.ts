// Managed storage on top of the demo company (test/web-helpers.ts): team folders the server owns, with rules, and a
// browser that can send uploads (multipart and raw chunks) besides JSON.
import { managedIdle } from '../src/managed/ops'
import { createManagedFolder } from '../src/managed/folders'
import { metaSet } from '../src/managed/settings'
import { setRule } from '../src/store'
import { handleWeb } from '../src/web/server'
import { ORIGIN, webSetup } from './web-helpers'

export async function managedSetup() {
  const e = await webSetup()
  metaSet(e.db, 'storage_mode', 'managed')
  const mk = (name: string, personalOwner?: string) => createManagedFolder(e.db, e.dir, { name, personalOwner })
  // 팀: everyone writes. 임원: the 경영 group writes (kim cannot see it). 공지: everyone reads, only boss writes.
  // 내폴더: kim's personal folder. 팀/비밀 (made below): a break inside 팀 that only boss reads and writes.
  const team = mk('팀'), exec = mk('임원'), notice = mk('공지'), mine = mk('내폴더', 'kim')
  setRule(e.db, team.path, '@전체', 'write')
  setRule(e.db, exec.path, '@경영', 'write')
  setRule(e.db, notice.path, '@전체', 'read')
  setRule(e.db, notice.path, 'boss', 'write')
  type B = InstanceType<typeof e.Browser>

  /** Any request with the browser's cookie, CSRF token and Origin, and a body as given. */
  async function send(b: B, method: string, path: string, body?: Uint8Array | string | null, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { origin: ORIGIN, ...headers }
    if (b.cookie) h.cookie = `tdrive_session=${b.cookie}`
    if (b.csrf) h['x-csrf-token'] = b.csrf
    const res = await handleWeb(e.w, new Request(ORIGIN + path, { method, headers: h, body: body ?? undefined }), '10.0.0.1')
    const text = await res.text()
    let data: any = null
    try { data = JSON.parse(text) } catch { data = text }
    return { status: res.status, data, headers: res.headers }
  }
  /** Multipart upload of one or more files into `folder`. */
  async function upload(b: B, folder: string, files: { name: string; content: string | Uint8Array }[] | string, content?: string | Uint8Array, conflict?: string) {
    const list = typeof files === 'string' ? [{ name: files, content: content ?? '' }] : files
    const form = new FormData()
    for (const f of list) form.append('file', new File([f.content], f.name))
    const r = new Response(form)
    const type = r.headers.get('content-type')! // (read before the body: Bun drops it after)
    const buf = new Uint8Array(await r.arrayBuffer())
    const q = `?path=${encodeURIComponent(folder)}${conflict ? `&conflict=${conflict}` : ''}`
    return send(b, 'POST', '/api/files/upload' + q, buf, { 'content-type': type, 'content-length': String(buf.length) })
  }
  const list = async (b: B, p: string) => (await b.call('GET', '/api/files?path=' + encodeURIComponent(p)))
  const names = async (b: B, p: string) => ((await list(b, p)).data.entries ?? []).map((x: { name: string }) => x.name).sort()
  const text = async (b: B, p: string) => (await b.call('GET', '/api/files/text?path=' + encodeURIComponent(p)))
  const auditRows = () => e.db.query<{ person_id: number | null; command: string; files: string; outcome: string }, []>('SELECT person_id, command, files, outcome FROM audit ORDER BY id').all()
  const idle = () => managedIdle(e.db)
  return { ...e, team, exec, notice, mine, send, upload, list, names, text, auditRows, idle }
}
export type ManagedEnv = Awaited<ReturnType<typeof managedSetup>>
