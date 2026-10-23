// WebDAV on top of managed storage (test/managed-helpers.ts): app passwords made through the real API, and a tiny
// WebDAV client that calls the server's fetch handler directly over https://drive.test.
import { handleWeb } from '../src/web/server'
import { managedSetup } from './managed-helpers'
import { PASSWORD } from './web-helpers'

export const DAV_ORIGIN = 'https://drive.test'

export async function davSetup() {
  const e = await managedSetup()
  type B = InstanceType<typeof e.Browser>
  /** An app password for this browser's person (through POST /api/me/app-passwords). */
  async function appPassword(b: B, name = 'Mac') {
    const r = await b.call('POST', '/api/me/app-passwords', { name, password: PASSWORD })
    if (r.status !== 200) throw new Error(`app password: ${r.status} ${JSON.stringify(r.data)}`)
    return r.data.password as string
  }
  const basic = (user: string, pw: string) => 'Basic ' + Buffer.from(`${user}:${pw}`).toString('base64')

  interface DavOpts { body?: string | Uint8Array | ReadableStream<Uint8Array> | null; headers?: Record<string, string>; origin?: string; addr?: string; auth?: string | null }
  /** A WebDAV client signed in as `user` with `pw`. */
  function client(user: string, pw: string) {
    return async (method: string, path: string, o: DavOpts = {}) => {
      const h: Record<string, string> = { ...(o.headers ?? {}) }
      if (o.auth !== null) h.authorization = o.auth ?? basic(user, pw)
      const url = (o.origin ?? DAV_ORIGIN) + path
      const res = await handleWeb(e.w, new Request(url, { method, headers: h, body: o.body ?? undefined, ...(o.body instanceof ReadableStream ? { duplex: 'half' } : {}) } as RequestInit), o.addr ?? '10.0.0.1')
      const buf = new Uint8Array(await res.arrayBuffer())
      return { status: res.status, headers: res.headers, text: new TextDecoder().decode(buf), bytes: buf }
    }
  }
  /** Signed in as a demo person with a fresh app password. */
  async function dav(name: string) {
    const b = await e.as(name)
    return client(name, await appPassword(b))
  }
  /** hrefs in a multistatus answer */
  const hrefs = (xml: string) => [...xml.matchAll(/<d:href>([^<]*)<\/d:href>/g)].map((m) => decodeURIComponent(m[1]!))
  const propfind = (props: string[] = []) => props.length
    ? `<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop>${props.map((p) => `<D:${p}/>`).join('')}</D:prop></D:propfind>`
    : ''
  return { ...e, appPassword, basic, client, dav, hrefs, propfind }
}
export type DavEnv = Awaited<ReturnType<typeof davSetup>>
export type Dav = ReturnType<DavEnv['client']>
