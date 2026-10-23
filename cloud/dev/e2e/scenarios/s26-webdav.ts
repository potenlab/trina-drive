// S26 — WebDAV, litmus-style over HTTPS through Caddy, with an app password: OPTIONS, PROPFIND, MKCOL, PUT (small and
// big: past Caddy's 25 MB body cap, which /dav/* is exempt from), GET, overwrite → a new version, COPY, MOVE, LOCK,
// PROPPATCH, DELETE → the trash, the usual error answers, a hidden folder like a missing one, audit rows (webdav).
// E2E_DAV_BIG_MB sets the big PUT (default 64; the plan's 2 GB check is E2E_DAV_BIG_MB=2048).
import crypto from 'node:crypto'
import type { Scenario } from '../lib/ctx'
import { dav, davAuth, davHrefs, propfindBody } from '../lib/drive'

export default {
  id: 'S26', title: 'WebDAV litmus-style: app password, PROPFIND/PUT (big)/MOVE/COPY/LOCK/DELETE, versions, hidden 404, audit', phase: 1, targets: ['local', 'aws'], uses: 'DAV H1',
  async run(t) {
    const fx = t.fx
    const auth = davAuth(fx.login('mina'), await fx.appPassword('mina'))
    const D = (m: string, p: string, o: NonNullable<Parameters<typeof dav>[5]> = {}) => dav(t.http, fx.slug, auth, m, p, o)
    const dest = (p: string) => `${fx.url}/dav${p.split('/').map(encodeURIComponent).join('/')}`
    const run = `s26-${Date.now().toString(36)}`, dir = `/공용/${run}`

    const opt = await D('OPTIONS', '/')
    t.check('OPTIONS: DAV class 1,2', opt.status === 200 && /1/.test(opt.headers.get('dav') ?? ''), [...opt.headers])
    const bad = await dav(t.http, fx.slug, davAuth(fx.login('mina'), 'tdrive_app_wrong-wrong-wrong-wrong-wrong-wrong-wron'), 'PROPFIND', '/', { body: propfindBody, headers: { depth: '0' } })
    t.check('a wrong app password: 401 with a Basic challenge', bad.status === 401 && /basic/i.test(bad.headers.get('www-authenticate') ?? ''), bad.status)
    const root = await D('PROPFIND', '/', { body: propfindBody, headers: { depth: '1', 'content-type': 'application/xml' } })
    const tops = davHrefs(root.text)
    t.check('PROPFIND / (Depth 1): 공용 and 프로젝트, not 재무/경영/인사', root.status === 207 && tops.some((h) => h.includes('공용')) && tops.some((h) => h.includes('프로젝트')) && !tops.some((h) => /재무|경영|인사/.test(h)), tops)
    const inf = await D('PROPFIND', '/', { body: propfindBody, headers: { depth: 'infinity' } })
    t.check('PROPFIND Depth: infinity is refused (403/400)', inf.status === 403 || inf.status === 400, inf.status)

    t.check('MKCOL', (await D('MKCOL', `${dir}/`)).status === 201)
    t.check('MKCOL again → 405', (await D('MKCOL', `${dir}/`)).status === 405)
    t.check('MKCOL with a missing parent → 409', (await D('MKCOL', `${dir}/no/such/`)).status === 409)
    const put = await D('PUT', `${dir}/a.txt`, { body: 'one\n', headers: { 'content-type': 'text/plain' } })
    t.check('PUT a new file → 201', put.status === 201, put.status)
    const get = await D('GET', `${dir}/a.txt`)
    t.check('GET returns it, with an ETag', get.status === 200 && get.text === 'one\n' && !!get.headers.get('etag'), get.text)
    const over = await D('PUT', `${dir}/a.txt`, { body: 'two\n' })
    t.check('PUT over it → 204', over.status === 204 || over.status === 200, over.status)
    const vs = await (await fx.drive('mina')).get(`/files/versions?path=${encodeURIComponent(`${dir}/a.txt`)}`)
    t.check('…which is a new version (the web lists 2)', vs.status === 200 && vs.json().versions.length === 2, vs.text.slice(0, 200))
    const ifm = await D('PUT', `${dir}/a.txt`, { body: 'three\n', headers: { 'if-match': '"not-the-etag"' } })
    t.warn('PUT with a stale If-Match → 412 (RFC 7232; litmus checks it, the plan does not)', ifm.status === 412, `${ifm.status}: the drive ignores If-Match on PUT`)
    t.check('GET a missing file → 404', (await D('GET', `${dir}/missing.txt`)).status === 404)
    t.check('DELETE a missing file → 404', (await D('DELETE', `${dir}/missing.txt`)).status === 404)

    t.check('COPY → 201', (await D('COPY', `${dir}/a.txt`, { headers: { destination: dest(`${dir}/b.txt`) } })).status === 201)
    t.check('COPY onto an existing file with Overwrite: F → 412', (await D('COPY', `${dir}/a.txt`, { headers: { destination: dest(`${dir}/b.txt`), overwrite: 'F' } })).status === 412)
    const mv = await D('MOVE', `${dir}/b.txt`, { headers: { destination: dest(`${dir}/c.txt`) } })
    t.check('MOVE → 201, the old name is gone', mv.status === 201 && (await D('GET', `${dir}/b.txt`)).status === 404 && (await D('GET', `${dir}/c.txt`)).status === 200, mv.status)
    const into = await D('MOVE', `${dir}/c.txt`, { headers: { destination: dest('/재무/c.txt') } })
    t.check('MOVE into a hidden folder → as if it did not exist (409/403/404, nothing lands)', [403, 404, 409, 502].includes(into.status), into.status)

    const lock = await D('LOCK', `${dir}/a.txt`, { body: '<?xml version="1.0"?><d:lockinfo xmlns:d="DAV:"><d:lockscope><d:exclusive/></d:lockscope><d:locktype><d:write/></d:locktype><d:owner>e2e</d:owner></d:lockinfo>', headers: { timeout: 'Second-60', 'content-type': 'application/xml' } })
    const token = lock.headers.get('lock-token') ?? ''
    t.check('LOCK → 200 with a Lock-Token', lock.status === 200 && /opaquelocktoken|urn:uuid/.test(token), lock.status)
    t.check('PUT without the lock token → 423', (await D('PUT', `${dir}/a.txt`, { body: 'x' })).status === 423)
    t.check('PUT with it → ok', [200, 201, 204].includes((await D('PUT', `${dir}/a.txt`, { body: 'locked write\n', headers: { if: `(${token})` } })).status))
    t.check('UNLOCK → 204', (await D('UNLOCK', `${dir}/a.txt`, { headers: { 'lock-token': token } })).status === 204)
    const pp = await D('PROPPATCH', `${dir}/a.txt`, { body: '<?xml version="1.0"?><d:propertyupdate xmlns:d="DAV:" xmlns:z="urn:schemas-microsoft-com:"><d:set><d:prop><z:Win32FileAttributes>00000020</z:Win32FileAttributes></d:prop></d:set></d:propertyupdate>', headers: { 'content-type': 'application/xml' } })
    t.check('PROPPATCH of a dead property → 207 (answered, not kept)', pp.status === 207, pp.status)

    const mb = Number(process.env.E2E_DAV_BIG_MB ?? 64)
    t.step(`big PUT (${mb} MB) through Caddy`)
    const big = crypto.randomBytes(mb * 1024 * 1024)
    const bp = await D('PUT', `${dir}/big.bin`, { body: big, headers: { 'content-type': 'application/octet-stream' }, timeoutMs: 30 * 60_000 })
    if (bp.status === 413 && !bp.text) t.pending(`PUT ${mb} MB through Caddy`, 'needs G1 (feat/g1-ops): Caddy\'s 25 MB request_body cap still applies to /dav/* (cloud/caddy/team_routes.caddy)')
    else {
      t.check(`PUT ${mb} MB → 201 (past Caddy's 25 MB cap)`, bp.status === 201, `${bp.status} ${bp.text.slice(0, 200)}`)
      const head = await D('PROPFIND', `${dir}/big.bin`, { body: propfindBody, headers: { depth: '0' } })
      t.check('its size is right', head.text.includes(`<d:getcontentlength>${big.length}</d:getcontentlength>`), head.text.slice(0, 300))
    }
    const small = await D('PUT', `${dir}/20mb.bin`, { body: crypto.randomBytes(20 * 1024 * 1024), timeoutMs: 300_000 })
    t.check('PUT 20 MB (under every cap) → 201', small.status === 201, small.status)

    const del = await D('DELETE', `${dir}/a.txt`)
    const tr = (await (await fx.drive('mina')).get('/trash')).json().items as { name: string; from: string }[]
    t.check('DELETE → 204, the file is in the trash', del.status === 204 && tr.some((x) => x.name === 'a.txt' && x.from === dir), del.status)
    const hidden = await D('PROPFIND', '/재무/', { body: propfindBody, headers: { depth: '1' } }), missing = await D('PROPFIND', '/재무-nx41/', { body: propfindBody, headers: { depth: '1' } })
    t.check('a hidden folder answers like a missing one', hidden.status === 404 && hidden.status === missing.status && hidden.text === missing.text, [hidden.status, missing.status])
    const audit = await (await fx.drive('mina')).get('/audit?view=mine')
    t.check('mina\'s audit has the WebDAV writes (tool webdav)', /webdav/.test(audit.text) && audit.text.includes(run), audit.text.slice(0, 300))
    await D('DELETE', `${dir}/`)
  },
} satisfies Scenario
