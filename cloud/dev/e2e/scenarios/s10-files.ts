// S10 — a person's file life in team folders: upload (multipart; resumable 50 MB, interrupted and resumed), rename,
// move, copy, a new version and restoring the old one, trash → restore → delete again → empty; a Restricted folder
// stays closed to her; every step is in the audit. The browser part uploads through the drive's own page.
import crypto from 'node:crypto'
import type { Scenario } from '../lib/ctx'
import { ui } from '../lib/ui'

export default {
  id: 'S10', title: 'files: upload (multipart + resumable 50 MB), rename, move, copy, versions, trash, audit', phase: 1, targets: ['local', 'aws'], uses: 'H1 H2',
  async run(t) {
    const fx = t.fx
    const mina = await fx.drive('mina')
    const run = `s10-${Date.now().toString(36)}`
    const dir = `/공용/${run}`
    t.step('a working folder in /공용 (Anyone in the team · Editor)')
    const mk = await mina.mkdir('/공용', run)
    t.check('mina makes a folder in /공용', mk.status === 200, mk.text)
    const restricted = await mina.upload('/재무', `${run}.md`, 'no')
    t.check('…but /재무 (Restricted, not hers) answers 404 like a missing folder', restricted.status === 404, restricted.text)

    t.step('multipart upload')
    const up = await mina.upload(dir, 'a.md', 'version one\n')
    t.check('upload a.md', up.status === 200 && up.json().ok !== false, up.text)
    const fd = new FormData()
    for (const n of ['b.md', 'c.txt']) fd.append('file', new File([`file ${n}\n`], n))
    const body = new Response(fd), type = body.headers.get('content-type')!
    const multi = await mina.api('POST', `/files/upload?path=${encodeURIComponent(dir)}`, undefined, { raw: new Uint8Array(await body.arrayBuffer()), headers: { 'content-type': type } })
    t.check('two files in one request', multi.status === 200 && (multi.json().results as { ok: boolean }[]).every((r) => r.ok), multi.text)

    t.step('resumable upload, 50 MB, interrupted after 2 chunks and resumed')
    const big = crypto.randomBytes(50 * 1024 * 1024)
    const first = await mina.uploadResumable(dir, 'big.bin', big, { stopAfter: 2 })
    const st = await mina.get(`/uploads/${first.id}`)
    t.check('the upload knows how far it got (2 chunks)', st.status === 200 && st.json().received === 2 * st.json().chunk_size, st.text)
    const done = await mina.resumeUpload(first.id, big)
    t.check('resumed and completed', done.status === 200, done.text)
    const stat = await mina.stat(`${dir}/big.bin`)
    t.check('big.bin is 50 MB', stat.status === 200 && stat.json().size === big.length, stat.text)
    const dl = await t.http.req('GET', `${fx.url}/api/files/download?path=${encodeURIComponent(`${dir}/big.bin`)}`, { jar: mina.jar, timeoutMs: 120_000 })
    t.check('download is an attachment, nosniff', /attachment/.test(dl.headers.get('content-disposition') ?? '') && dl.headers.get('x-content-type-options') === 'nosniff', [...dl.headers])

    t.step('rename, move, copy')
    const rn = await mina.api('POST', '/files/rename', { path: `${dir}/c.txt`, name: 'c-renamed.txt' })
    t.check('rename', rn.status === 200 && rn.json().path === `${dir}/c-renamed.txt`, rn.text)
    await mina.mkdir(dir, 'sub')
    const mv = await mina.api('POST', '/files/move', { paths: [`${dir}/b.md`], to: `${dir}/sub` })
    t.check('move', mv.status === 200 && !(mv.json().results as { error?: string }[]).some((r) => r.error), mv.text)
    const cp = await mina.api('POST', '/files/copy', { paths: [`${dir}/sub/b.md`], to: dir })
    t.check('copy', cp.status === 200 && (await mina.stat(`${dir}/b.md`)).status === 200 && (await mina.stat(`${dir}/sub/b.md`)).status === 200, cp.text)

    t.step('versions')
    await mina.upload(dir, 'a.md', 'version two\n', 'replace')
    const vs = await mina.get(`/files/versions?path=${encodeURIComponent(`${dir}/a.md`)}`)
    const versions = vs.status === 200 ? vs.json().versions as { version: number; current: boolean }[] : []
    t.check('two versions of a.md', versions.length === 2, vs.text)
    const old = versions.find((v) => !v.current)
    const rs = await mina.api('POST', '/files/versions/restore', { path: `${dir}/a.md`, version: old?.version })
    t.check('restore the old version', rs.status === 200 && (await mina.download(`${dir}/a.md`)).text === 'version one\n', rs.text)
    const kept = vs.status === 200 ? vs.json().kept as number : 0
    for (let i = 0; i < kept + 2; i++) await mina.upload(dir, 'many.md', `v${i}\n`, 'replace')
    const many = await mina.get(`/files/versions?path=${encodeURIComponent(`${dir}/many.md`)}`)
    t.check(`at most ${kept} earlier versions are kept (plan: 10)`, kept === 10 && many.json().versions.length <= kept + 1, { kept, n: many.json().versions?.length })

    t.step('trash')
    const del = await mina.api('POST', '/files/delete', { paths: [`${dir}/c-renamed.txt`] })
    t.check('delete → trash', del.status === 200 && (await mina.stat(`${dir}/c-renamed.txt`)).status === 404, del.text)
    const tr = await mina.get('/trash')
    const item = (tr.json().items as { id: number; name: string; from: string }[]).find((x) => x.name === 'c-renamed.txt' && x.from === dir)
    t.check(`in the trash (kept ${tr.json().days} days; plan: 30)`, !!item && tr.json().days === 30, tr.text.slice(0, 300))
    const back = await mina.api('POST', `/trash/${item?.id}/restore`, {})
    t.check('restore from the trash', back.status === 200 && (await mina.stat(`${dir}/c-renamed.txt`)).status === 200, back.text)
    await mina.api('POST', '/files/delete', { paths: [`${dir}/c-renamed.txt`] })
    const empty = await mina.api('POST', '/trash/empty', {})
    const left = (await mina.get('/trash')).json().items as { name: string; from: string }[]
    t.check('empty the trash: gone for good', empty.status === 200 && !left.some((x) => x.name === 'c-renamed.txt' && x.from === dir), empty.text)

    t.step('audit')
    const audit = await mina.get('/audit?view=mine')
    const log = audit.text
    for (const a of ['upload', 'upload-start', 'rename', 'move', 'copy', 'restore', 'delete']) t.check(`mina's audit has "${a}"`, log.includes(`files ${a}`) || log.includes(a), a)

    if (await t.has('browser', 'the browser upload (drive page → New → Upload)')) {
      const r = await (await ui()).uploadInBrowser(t, dir)
      if (r.pending) t.pending('the browser upload', r.pending)
      else t.check('browser: mina uploads a file through the page and it is listed', r.ok, r)
    }
  },
} satisfies Scenario
