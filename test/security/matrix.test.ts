// Permission matrix (plan §7.1, review-permissions §7 axes 1–5): entrances × roles × cases.
// Expected values come from plan §4.1 (R0–R4) as written out in fixture.ts, never from what the code does today.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { LIMITS } from '../../src/config'
import { confirmWidened, listEvents, listQuarantine, releaseQuarantine } from '../../src/inplace/events'
import { reconcile } from '../../src/inplace/reconcile'
import type { FsOps } from '../../src/inplace/walk'
import { listWidened } from '../../src/inplace/widened'
import { isWidening } from '../../src/policy'
import { grantManage, person, registerFolder, setFlag, setRule, sha256 } from '../../src/store'
import { MSG } from '../../src/vfs'
import { OutboxMailer } from '../../src/web/mail'
import * as webOps from '../../src/web/ops'
import { makeWebCtx } from '../../src/web/server'
import { textOf } from '../helpers'
import { ALL_CASES, ROLES, securitySetup, type Role, type SecEnv } from './fixture'

let e: SecEnv
let before: Record<string, string>
beforeAll(() => { e = securitySetup(); before = e.snapshot() })
afterAll(() => e.cleanup())

const nx = (vpath: string) => vpath.replace(/[^/]+$/, (b) => 'nx_' + b)
const can = (role: Role, c: { readers: Role[] }) => c.readers.includes(role)
const rec = (env: SecEnv, ops?: FsOps) => reconcile(env.db, { dataDir: env.dir, ops })
const pid = (env: SecEnv, name: string) => person(env.db, name).id
/** `cat` of a path answers exactly like `cat` of a name that is not there (stdout, stderr with the path masked, exit code). */
async function closedFor(env: SecEnv, role: string, vpath: string) {
  const a = await env.sh(role, `cat '${vpath}'`)
  const b = await env.sh(role, `cat '${nx(vpath)}'`)
  return { role, vpath, same: { out: a.stdout, err: a.stderr.replaceAll(vpath, 'P'), code: a.exitCode }, missing: { out: b.stdout, err: b.stderr.replaceAll(nx(vpath), 'P'), code: b.exitCode } }
}
const expectClosed = async (env: SecEnv, roles: readonly string[], vpath: string) => {
  for (const role of roles) { const c = await closedFor(env, role, vpath); expect({ role, vpath, got: c.same }).toEqual({ role, vpath, got: c.missing }) }
}
/** The admin acting through the web layer (R9 steps that notify and audit). */
function adminOp(env: SecEnv) {
  const w = makeWebCtx(env.ctx, { mailer: new OutboxMailer(env.dir, true), webDir: '/nonexistent' })
  return { w, actor: { personId: pid(env, 'dion'), admin: true }, base: 'http://shelf.test' }
}
const noticesOf = (env: SecEnv, name: string, kind: string) =>
  env.db.query<{ kind: string }, [number, string]>('SELECT kind FROM notices WHERE person_id = ? AND kind = ?').all(pid(env, name), kind)
/** Paragraphs long enough to count as a draft's content when they reappear on the NAS (R6). */
const PARAS = Array.from({ length: 4 }, (_, i) => `${i + 1}번 항목: 2026년 3분기 손익 검토 결과 영업이익률은 ${10 + i}.${i}%로 집계되었고 원가 절감 계획 ${i}안을 함께 보고한다.`)

describe.each(ROLES.map((r) => [r]))('reads as %s', (role) => {
  test.each(ALL_CASES.map((c) => [c.key, c]))('%s', async (_k, c) => {
    const canary = e.canary.get(c.key)!
    const ok = can(role, c)
    const missing = nx(c.vpath)
    // MCP bash: cat, and /.raw/ (original bytes)
    const cat = await e.sh(role, `cat '${c.vpath}'`)
    const catNx = await e.sh(role, `cat '${missing}'`)
    if (ok) {
      expect({ why: c.why, has: cat.stdout.includes(canary), code: cat.exitCode }).toEqual({ why: c.why, has: true, code: 0 })
    } else {
      expect({ why: c.why, out: cat.stdout, err: cat.stderr.replaceAll(c.vpath, 'P'), code: cat.exitCode })
        .toEqual({ why: c.why, out: '', err: catNx.stderr.replaceAll(missing, 'P'), code: catNx.exitCode })
    }
    const raw = await e.sh(role, `head -c 100000 '/.raw${c.vpath}' | wc -c; cat '/.raw${c.vpath}' | grep -c CANARY`)
    if (!ok) expect({ why: c.why, raw: raw.stdout }).toEqual({ why: c.why, raw: '0\n0\n' })
    // MCP read
    const rd = await e.tool(role, 'read', { path: c.vpath })
    if (ok) expect(textOf(rd)).toContain(canary)
    else expect({ why: c.why, t: textOf(rd), err: rd.isError }).toEqual({ why: c.why, t: `No such file or directory: ${c.vpath}`, err: true })
    // MCP write / edit: originals are read-only for everyone, admin included (R2)
    const w = await e.tool(role, 'write', { path: c.vpath, content: 'overwrite' })
    expect(w.isError).toBe(true)
    const wNx = await e.tool(role, 'write', { path: missing, content: 'overwrite' })
    expect({ why: c.why, t: textOf(w).replaceAll(c.vpath, 'P') })
      .toEqual({ why: c.why, t: ok ? MSG.readOnly : textOf(wNx).replaceAll(missing, 'P') })
    const ed = await e.tool(role, 'edit', { path: c.vpath, old_string: 'secret', new_string: 'x' })
    expect({ why: c.why, t: textOf(ed), err: ed.isError }).toEqual({ why: c.why, t: ok ? MSG.readOnly : `No such file or directory: ${c.vpath}`, err: true })
    // MCP history: never for originals
    const h = await e.tool(role, 'history', { path: c.vpath, action: 'list' })
    expect({ t: textOf(h), err: h.isError }).toEqual({ t: `No such draft: ${c.vpath}`, err: true })
  })

  test('grep -r / , rg -l / and find / see exactly the readable cases', async () => {
    const g = await e.sh(role, 'grep -r CANARY_ /')
    const found = new Set([...g.stdout.matchAll(/CANARY_\w+?_[0-9a-f]{6}/g)].map((m) => m[0]))
    const want = new Set(e.allowed(role).filter((c) => c.startsWith('CANARY_')))
    expect([...found].sort()).toEqual([...want].sort())
    const rg = await e.sh(role, 'rg -l CANARY_ /')
    const listed = new Set(rg.stdout.trim().split('\n').filter(Boolean))
    for (const c of ALL_CASES.filter((x) => x.key !== 'xsym')) expect({ p: c.vpath, listed: listed.has(c.vpath) }).toEqual({ p: c.vpath, listed: can(role, c) })
    const find = new Set((await e.sh(role, 'find / -type f')).stdout.trim().split('\n'))
    for (const c of ALL_CASES) expect({ p: c.vpath, found: find.has(c.vpath) }).toEqual({ p: c.vpath, found: can(role, c) })
    for (const forbidden of e.forbidden(role)) expect(g.stdout + g.stderr + rg.stdout + rg.stderr).not.toContain(forbidden)
  })
})

describe('CLI sh (subprocess, the real entrance)', () => {
  const cli = (secret: string, cmd: string) => {
    const p = Bun.spawnSync(['bun', 'run', path.join(import.meta.dir, '../../src/cli.ts'), '--data', e.dir, 'sh', '--token', secret, '-c', cmd], { stdout: 'pipe', stderr: 'pipe' })
    return { stdout: p.stdout.toString(), stderr: p.stderr.toString(), exitCode: p.exitCode }
  }
  test.each(ROLES.map((r) => [r]))('%s: cat of every case and grep -r / show only readable canaries', (role) => {
    const r = cli(e.secrets[role]!, `for p in ${ALL_CASES.map((c) => `'${c.vpath}'`).join(' ')}; do cat "$p"; done; grep -r CANARY_ /`)
    for (const c of e.forbidden(role)) expect(r.stdout + r.stderr).not.toContain(c)
    for (const c of e.allowed(role).filter((x) => x.startsWith('CANARY_'))) expect(r.stdout).toContain(c)
  })
  test.each([['expired'], ['revoked'], ['garbage']])('%s token is refused', (kind) => {
    const secret = kind === 'expired' ? e.expiredSecret : kind === 'revoked' ? e.revokedSecret : 'shelf_pat_nope'
    const r = cli(secret, 'ls /')
    expect(r.exitCode).toBe(1)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('invalid, expired or revoked token')
  })
})

describe('R2: nothing writes originals', () => {
  test.each(ROLES.map((r) => [r]))('%s: shell write forms are refused and the tree is unchanged', async (role) => {
    const cmds = ['echo x > /프로젝트/c.md', 'echo x >> /프로젝트/c.md', 'echo x > /프로젝트/new.md', 'cp /프로젝트/c.md /프로젝트/c2.md', 'mv /프로젝트/c.md /drafts/m.md',
      'rm /프로젝트/c.md', 'touch /프로젝트/c.md', 'mkdir /프로젝트/d', 'sed -i s/secret/x/ /프로젝트/c.md', 'chmod 777 /프로젝트/c.md',
      'tee /프로젝트/c.md <<< x', 'echo x | tee -a /공용/c.md', 'cp -r /drafts /프로젝트/d2', 'echo x 2> /프로젝트/err.md; ls /nope 2> /프로젝트/err.md',
      'echo x &> /공용/c.md', 'cd /프로젝트 && echo x > c.md', 'tar -xf /drafts/none.tar -C /프로젝트', 'split -l 1 /프로젝트/c.md /프로젝트/part',
      'echo x > /.raw/프로젝트/c.md', 'echo x > /drafts/../프로젝트/c.md', 'ln -s /프로젝트/c.md /drafts/l', 'sqlite3 /프로젝트/x.db "create table t(a)"']
    for (const c of cmds) {
      const r = await e.sh(role, c)
      expect({ c, failed: r.exitCode !== 0 || r.stderr.length > 0 }).toEqual({ c, failed: true })
    }
    // rm -f on a path the token cannot see succeeds quietly, exactly like on a path that does not exist
    expect(await e.sh(role, 'rm -rf /대외비 /공용/잠금 /공용/#recycle; echo $?')).toEqual(await e.sh(role, 'rm -rf /nx1 /공용/nx2 /공용/nx3; echo $?'))
    expect((await e.sh(role, 'rm -rf /drafts/../공용/c.md')).stderr).toContain(role === 'kimScoped' || role === 'bossNarrow' ? '' : MSG.readOnly)
    expect(e.snapshot()).toEqual(before)
  })

  test('read-only token: no draft writes through any entrance', async () => {
    for (const c of ['echo x > /drafts/a.md', 'cp /공용/c.md /drafts/a.md', 'mkdir /drafts/d', 'touch /drafts/t.md']) {
      expect((await e.sh('kimRO', c)).exitCode).not.toBe(0)
    }
    expect((await e.tool('kimRO', 'write', { path: '/drafts/a.md', content: 'x' })).isError).toBe(true)
    expect(e.db.query<{ n: number }, [number]>('SELECT count(*) AS n FROM drafts WHERE token_id = ?').get(e.tok('kimRO').id)!.n).toBe(0)
  })
})

describe('R3 provenance: every way of looking puts the folder into the next draft', () => {
  // Touch in one call, write in the next (the window is per token, across calls).
  const P = '/경영/c.md'
  const looks: [string, boolean][] = [
    [`cat ${P}`, true],
    [`grep -l secret ${P}`, false],
    [`grep -c secret ${P}`, false],
    [`grep -q secret ${P} && echo Y || echo N`, false],
    [`grep -q 김철수 ${P}; echo $?`, false],
    [`grep -r nomatch_zzz /경영`, false],
    [`rg -q secret /경영 && echo Y`, false],
    [`[ -s ${P} ] && echo y`, false],
    [`test -e ${P}; echo $?`, false],
    [`[ -f ${P} ] && echo y || echo n`, false],
    [`sha256sum ${P} | cut -c1-4`, false],
    [`[ "$(sha256sum < ${P})" = "x" ] && echo same`, false],
    [`md5sum ${P}`, false],
    [`wc -c ${P}`, false],
    [`wc -l < ${P}`, false],
    [`sort ${P} | head -1 | wc -c`, false],
    [`diff -q ${P} /프로젝트/c.md`, false],
    [`file ${P}`, false],
    [`stat ${P}`, false],
    [`du ${P}`, false],
    [`ls /경영`, false],
    [`find /경영 -name c.md`, false],
    [`echo /경영/*`, false],
    [`n=0; for f in /경영/*; do n=$((n+1)); done; echo $n`, false],
    [`while read l; do :; done < ${P}; echo done`, false],
    [`x=$(cat ${P}); echo \${#x}`, false],
    [`head -c 1 ${P} > /dev/null`, false],
    [`cat ${P} > /dev/null`, false],
    [`case "$(cat ${P})" in *secret*) echo y;; esac`, false],
  ]
  test.each(looks.map(([c, strong], i) => [c, strong, i]))('%s', async (cmd, strong, i) => {
    const who = `prov${i}`
    e.addToken(who, 'boss', { name: `boss-prov-${i}` })
    await e.sh(who, cmd)
    const w = await e.tool(who, 'write', { path: '/drafts/out.md', content: 'summary\n' })
    expect(w.isError).toBeUndefined()
    const src = e.draftSrc(who, 'out.md')
    expect({ cmd, has: src.has(e.folderId('경영')) }).toEqual({ cmd, has: true })
    if (strong) expect(src.get(e.folderId('경영'))).toBe(true)
    expect(src.has(e.folderId('인사'))).toBe(false)
  })

  test('the read tool and history read are strong touches', async () => {
    e.addToken('provRead', 'boss', { name: 'boss-prov-read' })
    await e.tool('provRead', 'read', { path: P })
    await e.tool('provRead', 'write', { path: '/drafts/r.md', content: 'x' })
    expect(e.draftSrc('provRead', 'r.md').get(e.folderId('경영'))).toBe(true)
  })

  test('reading a draft (bash, read tool, history read) brings its sources into the reader\'s window', async () => {
    e.addToken('provA', 'boss', { name: 'boss-prov-a' })
    e.addToken('provB', 'boss', { name: 'boss-prov-b' })
    e.addToken('provC', 'boss', { name: 'boss-prov-c' })
    e.addToken('provD', 'boss', { name: 'boss-prov-d' })
    await e.sh('provA', `cat ${P} > /drafts/base.md`)
    await e.sh('provB', 'cat /drafts/@boss-prov-a/base.md | wc -l')
    await e.tool('provC', 'read', { path: '/drafts/@boss-prov-a/base.md' })
    await e.tool('provD', 'history', { path: '/drafts/@boss-prov-a/base.md', action: 'read', version: 1 })
    for (const who of ['provB', 'provC', 'provD']) {
      await e.tool(who, 'write', { path: '/drafts/derived.md', content: 'x' })
      expect({ who, has: e.draftSrc(who, 'derived.md').has(e.folderId('경영')) }).toEqual({ who, has: true })
    }
  })

  test.each([['ls /drafts/@boss-name-src'], ['echo /drafts/@boss-name-src/*'], ['find /drafts -name "*감원*"'], ['ls -R /drafts'], ['ls /drafts/@boss-name-src/sub']])('seeing only the name of another token\'s draft (%s) brings its sources (weak)', async (cmd) => {
    if (!e.secrets.provNameSrc) {
      e.addToken('provNameSrc', 'boss', { name: 'boss-name-src' })
      await e.sh('provNameSrc', 'cat /경영/c.md > /dev/null; echo x > /drafts/김철수_감원대상.md; mkdir -p /drafts/sub; echo y > /drafts/sub/명단.md')
    }
    const who = 'provName' + cmd.length + cmd.charCodeAt(1)
    e.addToken(who, 'boss', { name: `boss-${who}` })
    const r = await e.sh(who, cmd)
    expect(r.stdout).toMatch(/감원대상|명단/)
    await e.tool(who, 'write', { path: '/drafts/note.md', content: 'x' })
    expect(e.draftSrc(who, 'note.md').get(e.folderId('경영'))).toBe(false)
  })

  test('listing /drafts itself shows only token names: it does not pull in every draft\'s sources', async () => {
    e.addToken('provRootLs', 'boss', { name: 'boss-root-ls' })
    expect((await e.sh('provRootLs', 'ls /drafts')).stdout).toContain('@boss-')
    await e.tool('provRootLs', 'write', { path: '/drafts/n.md', content: 'x' })
    expect(e.draftSrc('provRootLs', 'n.md').size).toBe(0)
  })

  test('a folder seen only as a bare path is not a source; its readable child is', async () => {
    e.addToken('kimProv', 'kim', { name: 'kim-prov' })
    await e.sh('kimProv', 'ls /경영; cat /경영/공개/c.md')
    await e.tool('kimProv', 'write', { path: '/drafts/b.md', content: 'x' })
    const src = e.draftSrc('kimProv', 'b.md')
    expect(src.has(e.folderId('경영'))).toBe(false)
    expect(src.get(e.folderId('경영/공개'))).toBe(true)
  })
})

describe('R4 draft visibility', () => {
  const kinds = ['ls -aR /drafts', 'find /drafts', 'grep -r DRAFTMARK /drafts', 'cat /drafts/@boss-vis/v.md', 'ls /drafts/@boss-vis', 'stat /drafts/@boss-vis/v.md']
  beforeAll(async () => {
    e.addToken('bossVis', 'boss', { name: 'boss-vis' })
    await e.sh('bossVis', 'cat /경영/c.md > /dev/null; echo DRAFTMARK > /drafts/v.md')
  })

  test('same person, token that can read every source: sees it (and it is read-only there)', async () => {
    const r = await e.sh('boss', 'cat /drafts/@boss-vis/v.md')
    expect(r.stdout).toBe('DRAFTMARK\n')
    expect((await e.tool('boss', 'edit', { path: '/drafts/@boss-vis/v.md', old_string: 'DRAFT', new_string: 'x' })).isError).toBe(true)
    const h = await e.tool('boss', 'history', { path: '/drafts/@boss-vis/v.md', action: 'restore', version: 1 })
    expect(textOf(h)).toBe(MSG.otherDraft)
    expect((await e.sh('boss', 'echo x >> /drafts/@boss-vis/v.md')).exitCode).not.toBe(0)
    expect((await e.sh('boss', 'rm /drafts/@boss-vis/v.md')).exitCode).not.toBe(0)
    expect((await e.sh('boss', 'mv /drafts/@boss-vis/v.md /drafts/mine.md')).exitCode).not.toBe(0)
  })

  test.each([['bossNarrow'], ['kim'], ['dion'], ['kimRO'], ['lee'], ['park']])('%s cannot see it anywhere (as if it did not exist)', async (who) => {
    for (const c of kinds) {
      const r = await e.sh(who, c)
      expect({ c, leak: (r.stdout + r.stderr).includes('DRAFTMARK') || r.stdout.includes('@boss-vis') }).toEqual({ c, leak: false })
    }
    const missing = await e.tool(who, 'read', { path: '/drafts/@boss-zzz/v.md' })
    const hidden = await e.tool(who, 'read', { path: '/drafts/@boss-vis/v.md' })
    expect(textOf(hidden).replace('@boss-vis', 'X')).toBe(textOf(missing).replace('@boss-zzz', 'X'))
    expect(textOf(await e.tool(who, 'history', { path: '/drafts/@boss-vis/v.md', action: 'list' }))).toBe('No such draft: /drafts/@boss-vis/v.md')
  })

  test('the draft count a narrow token sees does not move when a hidden draft appears', async () => {
    const a = await e.sh('bossNarrow', 'ls -a /drafts | wc -l; du -s /drafts; stat /drafts')
    e.addToken('bossVis2', 'boss', { name: 'boss-vis2' })
    await e.sh('bossVis2', 'cat /경영/c.md > /drafts/w.md')
    const b = await e.sh('bossNarrow', 'ls -a /drafts | wc -l; du -s /drafts; stat /drafts')
    expect(b).toEqual(a)
  })

  test('a draft with no sources is visible only to the token that wrote it', async () => {
    e.addToken('bossEmpty', 'boss', { name: 'boss-empty' })
    await e.tool('bossEmpty', 'write', { path: '/drafts/empty.md', content: 'EMPTYSRC\n' })
    expect(e.draftSrc('bossEmpty', 'empty.md').size).toBe(0)
    expect((await e.sh('bossEmpty', 'cat /drafts/empty.md')).stdout).toBe('EMPTYSRC\n')
    expect((await e.sh('boss', 'grep -r EMPTYSRC /drafts')).stdout).toBe('')
  })

  test('after a rule shrinks, the writer token itself no longer sees the draft (list, read, grep, history, edit)', async () => {
    e.addToken('leeVis', 'lee', { name: 'lee-vis' })
    await e.sh('leeVis', 'cat /인사/c.csv > /drafts/hr.md')
    expect((await e.sh('leeVis', 'ls /drafts')).stdout).toBe('hr.md\n')
    const lee = e.db.query<{ id: number }, []>("SELECT id FROM people WHERE name = 'lee'").get()!.id
    e.db.query("DELETE FROM memberships WHERE person_id = ? AND group_id = (SELECT id FROM groups WHERE name = '인사')").run(lee)
    try {
      expect((await e.sh('leeVis', 'ls -a /drafts; grep -r CANARY /drafts; find /drafts -type f')).stdout).toBe('.\n..\n')
      expect((await e.tool('leeVis', 'read', { path: '/drafts/hr.md' })).isError).toBe(true)
      expect((await e.tool('leeVis', 'edit', { path: '/drafts/hr.md', old_string: 'secret', new_string: 'x' })).isError).toBe(true)
      expect(textOf(await e.tool('leeVis', 'history', { path: '/drafts/hr.md', action: 'list' }))).toBe('No such draft: /drafts/hr.md')
    } finally { e.db.query("INSERT INTO memberships (group_id, person_id) SELECT id, ? FROM groups WHERE name = '인사'").run(lee) }
  })

  test.todo('writing to the path of an own draft that is now hidden behaves like a new path (today: merged into the hidden draft, whose sources leak in "Draft sources:") [owner: drafts]', () => {})
})

describe('identity cases that exist on main', () => {
  test('a scope folder deleted and recreated under the same name is out of scope (scopes are identities)', async () => {
    const env = securitySetup()
    try {
      const dir = env.R('공용/회계')
      expect((await env.sh('kimScoped', 'cat /공용/회계/c.md')).exitCode).toBe(0)
      fs.renameSync(dir, dir + '.old')
      fs.mkdirSync(dir)
      fs.writeFileSync(path.join(dir, 'c.md'), 'NEWCONTENT\n')
      const r = await env.sh('kimScoped', 'cat /공용/회계/c.md; ls -a /; grep -r NEWCONTENT /')
      expect(r.stdout).toBe('.\n..\ndrafts\n')
      expect((await env.sh('kim', 'cat /공용/회계/c.md')).stdout).toBe('NEWCONTENT\n')
    } finally { env.cleanup() }
  })

  test('renaming a sub-folder keeps its rule (rules follow the identity)', async () => {
    const env = securitySetup()
    try {
      fs.renameSync(env.R('공용/kim만'), env.R('공용/이름바꿈'))
      expect((await env.sh('kim', 'cat /공용/이름바꿈/c.md')).stdout).toContain(env.canary.get('kimOnly')!)
      expect((await env.sh('boss', 'cat /공용/이름바꿈/c.md')).exitCode).toBe(1)
      expect((await env.sh('boss', 'ls /공용')).stdout).not.toContain('이름바꿈')
    } finally { env.cleanup() }
  })

  test('a different folder moved into the old name does not inherit the old rule', async () => {
    const env = securitySetup()
    try {
      fs.renameSync(env.R('공용/kim만'), env.R('공용/kim만.old'))
      fs.mkdirSync(env.R('공용/kim만'))
      fs.writeFileSync(env.R('공용/kim만/n.md'), 'NEWFOLDER\n')
      // a new folder inherits from 공용 (@전체 read): everyone reads it, kim's old break rule does not apply by name
      expect((await env.sh('boss', 'cat /공용/kim만/n.md')).stdout).toBe('NEWFOLDER\n')
      expect((await env.sh('boss', 'cat /공용/kim만.old/c.md')).exitCode).toBe(1)
    } finally { env.cleanup() }
  })

  test('renaming a registered folder keeps it open with its rules (R10: same identity); until the reconciler has seen it, it is closed', async () => {
    const env = securitySetup()
    try {
      await rec(env)
      fs.renameSync(env.R('경영'), env.R('경영_2026'))
      fs.renameSync(env.R('개인_kim'), env.R('개인_kim_old'))
      await expectClosed(env, ['boss'], '/경영/c.md') // not judged yet: closed, like a name that is not there
      const r = await rec(env)
      expect([r.renamed, r.quarantined, r.lost]).toEqual([2, 0, 0])
      // same mount names, same rules, the sub-folder rule (경영/공개: @전체 read) and the personal owner came along
      expect((await env.sh('boss', 'cat /경영/c.md /경영/보고.docx')).stdout).toContain(env.canary.get('mgmt')!)
      expect((await env.sh('boss', 'cat /경영/보고.docx')).stdout).toContain(env.canary.get('mgmtDocx')!)
      expect((await env.sh('kim', 'cat /경영/공개/c.md')).stdout).toContain(env.canary.get('mgmtPub')!)
      expect((await env.sh('kim', 'cat /개인_kim/sub/c.md')).stdout).toContain(env.canary.get('personalSub')!)
      for (const role of ['kim', 'dion', 'lee', 'bossNarrow'] as const) await expectClosed(env, [role], '/경영/c.md')
      for (const role of ['boss', 'dion', 'lee'] as const) await expectClosed(env, [role], '/개인_kim/c.md')
      expect(env.db.query<{ path: string }, [string]>('SELECT path FROM folders WHERE mount_name = ?').get('경영')!.path).toBe(env.R('경영_2026'))
      expect(listEvents(env.db, { kind: 'renamed' }).length).toBeGreaterThanOrEqual(2)
    } finally { env.cleanup() }
  })

  test('a folder moved across a rule boundary that widens it is quarantined (R10); one that does not widen keeps its rules', async () => {
    const env = securitySetup()
    try {
      fs.mkdirSync(env.R('인사/면담'))
      fs.writeFileSync(env.R('인사/면담/m.md'), `INTERVIEW_${env.salt}\n`)
      await rec(env)
      expect((await env.sh('lee', 'cat /인사/면담/m.md')).stdout).toBe(`INTERVIEW_${env.salt}\n`)
      fs.renameSync(env.R('인사/면담'), env.R('프로젝트/면담')) // 인사 (lee) -> 프로젝트 (everyone): wider
      fs.renameSync(env.R('프로젝트/비공개'), env.R('경영/비공개')) // boss only, NAS all -> boss only, NAS boss: narrower
      await expectClosed(env, ROLES, '/프로젝트/면담/m.md') // moved since the last walk: closed until judged
      const r = await rec(env)
      expect([r.moved, r.quarantined]).toEqual([2, 1])
      for (const role of ROLES) {
        const x = await env.sh(role, `grep -r INTERVIEW_ /; ls -a /프로젝트; find / -name 'm.md'`)
        expect({ role, leak: x.stdout.includes('INTERVIEW_') || x.stdout.includes('면담') }).toEqual({ role, leak: false })
      }
      await expectClosed(env, ROLES, '/프로젝트/면담/m.md')
      const q = listQuarantine(env.db)
      expect(q.map((x) => [x.kind, x.item, x.path])).toEqual([['moved', 'dir', env.R('프로젝트/면담')]])
      expect(JSON.parse(listEvents(env.db, { kind: 'quarantined' })[0]!.notify).admins).toEqual([pid(env, 'dion')])
      // the narrowing move kept the folder's own rule
      expect((await env.sh('boss', 'cat /경영/비공개/c.md')).stdout).toContain(env.canary.get('projPrivate')!)
      await expectClosed(env, ['kim', 'dion'], '/경영/비공개/c.md')
      // only the admin opens the quarantined folder again
      expect(() => releaseQuarantine(env.db, q[0]!.id, pid(env, 'lee'))).toThrow()
      releaseQuarantine(env.db, q[0]!.id, pid(env, 'dion'))
      expect((await env.sh('kim', 'cat /프로젝트/면담/m.md')).stdout).toBe(`INTERVIEW_${env.salt}\n`)
    } finally { env.cleanup() }
  })

  test('a file whose identity appears at another path in the index is closed (R1 ⑤ file-identity index)', async () => {
    const env = securitySetup()
    try {
      await rec(env)
      // renamed outside since the last walk: the index has its identity at the old path, so the new path is closed until judged
      fs.renameSync(env.R('공용/c.md'), env.R('공용/c2.md'))
      await expectClosed(env, ['kim', 'dion'], '/공용/c2.md')
      expect((await env.sh('kim', 'grep -r CANARY_pub_ /공용')).stdout).toBe('')
      await rec(env)
      expect((await env.sh('kim', 'cat /공용/c2.md')).stdout).toContain(env.canary.get('pub')!) // a rename keeps it open
      // one identity under two paths at once (a bind mount, a NAS-side clone; simulated: APFS has no such thing for files)
      const twin = env.R('프로젝트/twin.md')
      const ops: FsOps = {
        readdir: async (d) => d === env.R('프로젝트') ? [...await fs.promises.readdir(d), 'twin.md'] : fs.promises.readdir(d),
        lstat: (p) => fs.promises.lstat(p === twin ? env.R('공용/c2.md') : p, { bigint: true }),
      }
      await rec(env, ops)
      const ev = listEvents(env.db, { kind: 'closed' }).map((x) => JSON.parse(x.detail)).find((d) => d.reason === 'shared_identity')
      expect(ev.paths.sort()).toEqual([env.R('공용/c2.md'), twin].sort())
      // with the plain listing (no twin to be seen), the file is still closed by its identity
      await expectClosed(env, ['kim', 'dion', 'boss'], '/공용/c2.md')
      expect((await env.sh('kim', 'grep -r CANARY_pub_ /; ls /공용')).stdout).not.toMatch(/CANARY_pub_|c2\.md/)
    } finally { env.cleanup() }
  })

  test('unregister + re-register: old draft sources lock / count as widening (review §7 axis 2)', async () => {
    const env = securitySetup()
    try {
      await rec(env)
      env.addToken('bossD', 'boss', { name: 'boss-d' })
      await env.sh('bossD', 'cat /경영/c.md > /dev/null')
      const content = PARAS.join('\n\n') + '\n'
      await env.tool('bossD', 'write', { path: '/drafts/d.md', content })
      const mgmt = env.folderId('경영')
      const op = adminOp(env)
      const see = async () => (await env.sh('bossD', 'ls /drafts; cat /drafts/d.md')).stdout
      expect(await see()).toBe('d.md\n' + content)

      // unregistered: the source is nowhere, so the draft is locked and putting it anywhere widens
      await webOps.unregisterFolder(op, mgmt)
      expect(await see()).toBe('')
      expect(isWidening(env.db, [mgmt], env.folderId('공용'))).toBe(true)
      expect(isWidening(env.db, [mgmt], env.folderId('인사'))).toBe(true)
      fs.writeFileSync(env.R('공용/d.md'), content) // a copy shows up on the NAS meanwhile
      await rec(env)
      expect(listWidened(env.db).map((w) => [path.basename(w.path), w.status])).toEqual([['d.md', 'pending']])

      // registered again (same identity, its rules kept): the draft is judged by the rules now (R4); the copy stays pending (R6: never erased)
      await webOps.registerFolder(op, { path: env.R('경영'), template: 'custom', nas: { mode: 'chosen', people: [pid(env, 'boss')] } })
      expect(await see()).toBe('d.md\n' + content)
      await rec(env)
      expect(listWidened(env.db).map((w) => w.status)).toEqual(['pending'])
      await expectClosed(env, ['kim', 'boss'], '/공용/d.md')

      // the folder deleted and made again under the same name is another identity: the old source stays locked and widening
      await webOps.unregisterFolder(op, mgmt)
      fs.renameSync(env.R('경영'), env.R('경영.bak'))
      fs.mkdirSync(env.R('경영'))
      fs.writeFileSync(env.R('경영/n.md'), 'NEW\n')
      const again = await webOps.registerFolder(op, { path: env.R('경영'), template: 'custom', nas: { mode: 'chosen', people: [pid(env, 'boss')] } })
      setRule(env.db, env.R('경영'), 'boss', 'read')
      expect(again.id).not.toBe(mgmt)
      expect((await env.sh('bossD', 'cat /경영/n.md')).stdout).toBe('NEW\n')
      expect(await see()).toBe('')
      expect(isWidening(env.db, [mgmt], again.id)).toBe(true)
    } finally { env.cleanup() }
  })

  test('a Mac alias file (bookmark data / FinderInfo "alis") is closed like a link (R1 ⑤), before and after the reconciler sees it', async () => {
    const env = securitySetup()
    try {
      await rec(env)
      const bookmark = Buffer.concat([Buffer.from('book\0\0\0\0mark\0\0\0\0'), Buffer.from(`ALIAS_BOOK_${env.salt} /Volumes/hr/c.csv\n`)])
      fs.writeFileSync(env.R('공용/바로가기.md'), bookmark)
      // plain bytes, but its AppleDouble sidecar (how SMB keeps Mac Finder info) says: alias ('alis', kIsAlias)
      fs.writeFileSync(env.R('공용/별칭.md'), `ALIAS_FINDER_${env.salt}\n`)
      const ad = Buffer.alloc(70)
      ad.writeUInt32BE(0x00051607, 0); ad.writeUInt32BE(0x00020000, 4); ad.writeUInt16BE(1, 24)
      ad.writeUInt32BE(9, 26); ad.writeUInt32BE(38, 30); ad.writeUInt32BE(32, 34)
      ad.write('alisMACS', 38, 'latin1'); ad.writeUInt16BE(0x8000, 46)
      fs.writeFileSync(env.R('공용/._별칭.md'), ad)
      const probe = async () => {
        for (const role of ['kim', 'dion', 'boss'] as const) {
          const x = await env.sh(role, `cat /공용/바로가기.md /공용/별칭.md; cat /.raw/공용/바로가기.md /.raw/공용/별칭.md; grep -r ALIAS_ /; base64 /공용/별칭.md`)
          expect({ role, leak: (x.stdout + x.stderr).includes('ALIAS_') || x.stdout.includes(Buffer.from('ALIAS_FINDER').toString('base64').slice(0, 12)) }).toEqual({ role, leak: false })
          expect((await env.tool(role, 'read', { path: '/공용/별칭.md' })).isError).toBe(true)
        }
        await expectClosed(env, ['kim'], '/공용/별칭.md')
        await expectClosed(env, ['kim'], '/공용/바로가기.md')
      }
      await probe()
      expect((await env.sh('kim', 'ls /공용')).stdout).not.toContain('별칭') // the sidecar is in the listing already: hidden at once
      await rec(env)
      await probe()
      const closed = new Map(listEvents(env.db, { kind: 'closed' }).map((x) => { const d = JSON.parse(x.detail); return [d.reason, d.paths] }))
      expect(closed.get('alias').sort()).toEqual([env.R('공용/바로가기.md'), env.R('공용/별칭.md')].sort())
      expect((await env.sh('kim', 'ls -a /공용; find /공용')).stdout).not.toMatch(/바로가기|별칭/)
    } finally { env.cleanup() }
  })

  test.todo('the text mirror is keyed by (dev, ino, size, mtime): a file rewritten in place with the same size and a reset mtime serves its old text; key by content or re-hash on identity reuse [owner: reconciler / file-identity index]', () => {})
})

describe('NAS system folders (R1 ⑥) on the registered path itself', () => {
  test('a folder registered at or under a NAS system folder (snapshot, recycle bin) is closed', async () => {
    const env = securitySetup()
    try {
      for (const [i, rel] of ['#snapshot/daily/경영사본', '@Recently-Snapshot/경영사본2', '#recycle'].entries()) {
        const d = env.R(rel)
        fs.mkdirSync(d, { recursive: true })
        fs.writeFileSync(path.join(d, 'c.md'), `SNAPSHOT_COPY_${i}\n`)
        registerFolder(env.db, d, { name: `snap${i}`, nasReaders: 'all' })
        setRule(env.db, d, '@전체', 'read')
      }
      for (const role of ['kim', 'dion'] as const) {
        const r = await env.sh(role, 'ls -a /; grep -r SNAPSHOT_COPY /; cat /snap0/c.md /snap1/c.md /snap2/c.md')
        expect(r.stdout + r.stderr).not.toContain('SNAPSHOT_COPY')
        expect(r.stdout).not.toContain('snap')
      }
    } finally { env.cleanup() }
  })
})

describe('R0: a personal folder is its owner\'s only, whatever sits inside it', () => {
  test('rules, breaks and registrations made inside before the folder became personal do not reopen it', async () => {
    const env = securitySetup()
    try {
      const box = env.R('프로젝트/개인함')
      for (const sub of ['ruled', 'registered', 'broken']) { fs.mkdirSync(path.join(box, sub), { recursive: true }); fs.writeFileSync(path.join(box, sub, 'p.md'), `PERSONAL_${sub}\n`) }
      fs.writeFileSync(path.join(box, 'top.md'), 'PERSONAL_top\n')
      // while 개인함 is still an ordinary folder inside 프로젝트 (all allowed there)…
      setRule(env.db, path.join(box, 'ruled'), 'boss', 'read', { breakInherit: true })
      registerFolder(env.db, path.join(box, 'registered'), { nasReaders: 'all' })
      setRule(env.db, path.join(box, 'registered'), '@전체', 'read')
      setFlag(env.db, path.join(box, 'broken'), 'inherit_break', true)
      // …then the admin registers it as kim's personal folder
      registerFolder(env.db, box, { personalOwner: 'kim' })
      for (const role of ['boss', 'dion', 'lee', 'bossNarrow'] as const) {
        const r = await env.sh(role, 'grep -r PERSONAL_ /; cat /프로젝트/개인함/ruled/p.md /프로젝트/개인함/registered/p.md; ls /프로젝트')
        expect({ role, out: r.stdout.includes('PERSONAL_') || r.stdout.includes('개인함') }).toEqual({ role, out: false })
      }
      const kim = await env.sh('kim', 'grep -rh PERSONAL_ /프로젝트/개인함 | sort')
      expect(kim.stdout).toBe('PERSONAL_broken\nPERSONAL_registered\nPERSONAL_ruled\nPERSONAL_top\n')
    } finally { env.cleanup() }
  })
  test('re-registering a personal folder as an ordinary one (or for another owner) is refused; releasing it is the admin step that tells the owner and is audited (R9)', async () => {
    const env = securitySetup()
    try {
      const box = env.R('개인_kim')
      const id = env.folderId('개인_kim')
      // the store (CLI) refuses any re-registration of it, even for the same owner (its NAS readers are the owner's to set)
      for (const opts of [{}, { personalOwner: 'boss' }, { nasReaders: 'all' as const, name: '열기' }, { personalOwner: 'kim', nasReaders: 'all' as const }, { personalOwner: 'kim' }]) {
        expect(() => registerFolder(env.db, box, opts)).toThrow(/personal folder/)
      }
      expect(env.db.query('SELECT registered, personal_owner, nas_readers, mount_name FROM folders WHERE id = ?').get(id))
        .toEqual({ registered: 1, personal_owner: pid(env, 'kim'), nas_readers: JSON.stringify([pid(env, 'kim')]), mount_name: '개인_kim' })
      expect((await env.sh('kim', 'cat /개인_kim/c.md')).stdout).toContain(env.canary.get('personal')!)
      await expectClosed(env, ['dion', 'boss'], '/개인_kim/c.md')
      // the web's "unregister" is the release step: the owner hears of it and it is in the audit
      const op = adminOp(env)
      await webOps.unregisterFolder(op, id)
      expect(noticesOf(env, 'kim', 'personal_folder_changed').length).toBe(1)
      expect(env.db.query<{ command: string }, []>("SELECT command FROM audit WHERE tool = 'web' ORDER BY id DESC LIMIT 1").get()!.command).toContain('folder unregister')
      // after it, registering the same identity as an ordinary folder tells the former owner again
      const r = await webOps.registerFolder(op, { path: box, template: 'custom', nas: { mode: 'chosen', people: [pid(env, 'dion')] } })
      expect(r.warnings).toContain('former_personal')
      expect(noticesOf(env, 'kim', 'former_personal_registered').length).toBe(1)
    } finally { env.cleanup() }
  })
})

describe('more rule computation (review §7 axis 1) and window edges (axis 4)', () => {
  test('no registration or rule can be placed inside a personal folder', () => {
    fs.mkdirSync(e.R('개인_kim/in'), { recursive: true })
    expect(() => registerFolder(e.db, e.R('개인_kim/in'))).toThrow()
    expect(() => setRule(e.db, e.R('개인_kim/in'), 'boss', 'read')).toThrow()
  })

  test('a registered folder below a no-AI or quarantined folder stays closed', async () => {
    const env = securitySetup()
    try {
      for (const [parent, flag] of [['공용/잠금', 'no_ai'], ['공용/격리', 'quarantine']] as const) {
        const d = env.R(`${parent}/등록`)
        fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'r.md'), `REGISTERED_BELOW_${flag}\n`)
        registerFolder(env.db, d, { nasReaders: 'all' })
        setRule(env.db, d, '@전체', 'read')
      }
      for (const role of ['kim', 'boss', 'dion'] as const) {
        const r = await env.sh(role, 'grep -r REGISTERED_BELOW /; ls -a /공용')
        expect(r.stdout).not.toContain('REGISTERED_BELOW')
        expect(r.stdout).not.toMatch(/잠금|격리/)
      }
    } finally { env.cleanup() }
  })

  test('manage on a folder is not read access (R7)', async () => {
    const env = securitySetup()
    try {
      grantManage(env.db, env.R('경영'), 'kim')
      expect((await env.sh('kim', 'cat /경영/c.md')).exitCode).toBe(1)
      expect((await env.sh('kim', 'grep -r CANARY_mgmt_ /')).stdout).toBe('')
    } finally { env.cleanup() }
  })

  test('the 8-hour window: a touch 1 minute inside counts, 1 minute outside does not (R3)', async () => {
    const env = securitySetup()
    try {
      let now = Date.UTC(2026, 9, 22, 9, 0, 0)
      env.ctx.now = () => now
      env.addToken('w', 'boss', { name: 'boss-window' })
      await env.sh('w', 'cat /경영/c.md > /dev/null')
      now += LIMITS.windowMs - 60_000
      await env.tool('w', 'write', { path: '/drafts/inside.md', content: 'x' })
      expect(env.draftSrc('w', 'inside.md').has(env.folderId('경영'))).toBe(true)
      now += 120_000
      await env.tool('w', 'write', { path: '/drafts/outside.md', content: 'x' })
      expect(env.draftSrc('w', 'outside.md').has(env.folderId('경영'))).toBe(false)
      // an older draft keeps its sources when edited after the window (they never shrink)
      await env.tool('w', 'edit', { path: '/drafts/inside.md', old_string: 'x', new_string: 'y' })
      expect(env.draftSrc('w', 'inside.md').has(env.folderId('경영'))).toBe(true)
    } finally { env.cleanup() }
  })

  test.todo('"출처 초기화" (provenance reset) needs a fresh login, is audited and notifies the admin (5.1) [owner: admin REST / notifications]', () => {})
  test('after a widened copy is confirmed, reading it brings Src(d) into the reader\'s window (R6); while pending, nobody reads it', async () => {
    const env = securitySetup()
    try {
      await rec(env)
      env.addToken('bossW', 'boss', { name: 'boss-w' })
      await env.sh('bossW', 'cat /경영/c.md > /dev/null')
      const content = '# 메모\n\n' + PARAS.join('\n\n') + '\n'
      await env.tool('bossW', 'write', { path: '/drafts/memo.md', content })
      fs.writeFileSync(env.R('공용/memo.md'), content) // a person puts it where everyone reads
      expect((await rec(env)).widened).toBe(1)
      const [w] = listWidened(env.db)
      expect(w!.status).toBe('pending')
      await expectClosed(env, ROLES, '/공용/memo.md')
      for (const role of ROLES) expect({ role, out: (await env.sh(role, 'grep -r 영업이익률 /공용')).stdout }).toEqual({ role, out: '' })
      expect(() => confirmWidened(env.db, w!.id, pid(env, 'kim'))).toThrow()
      confirmWidened(env.db, w!.id, pid(env, 'dion'))

      const mgmt = env.folderId('경영'), pub = env.folderId('공용')
      // content out (cat, read tool): strong; only its name or a match count (grep -l): weak
      env.addToken('kimCat', 'kim', { name: 'kim-cat' })
      expect((await env.sh('kimCat', 'cat /공용/memo.md')).stdout).toBe(content)
      await env.tool('kimCat', 'write', { path: '/drafts/a.md', content: 'x' })
      expect(env.draftSrc('kimCat', 'a.md')).toEqual(new Map([[mgmt, true], [pub, true]]))
      env.addToken('kimRead', 'kim', { name: 'kim-read' })
      expect(textOf(await env.tool('kimRead', 'read', { path: '/공용/memo.md' }))).toContain('영업이익률')
      await env.tool('kimRead', 'write', { path: '/drafts/b.md', content: 'x' })
      expect(env.draftSrc('kimRead', 'b.md').get(mgmt)).toBe(true)
      env.addToken('kimGrep', 'kim', { name: 'kim-grep' })
      expect((await env.sh('kimGrep', 'grep -l 영업이익률 /공용/memo.md')).stdout).toBe('/공용/memo.md\n')
      await env.tool('kimGrep', 'write', { path: '/drafts/c.md', content: 'x' })
      expect(env.draftSrc('kimGrep', 'c.md').get(mgmt)).toBe(false)
      // kim cannot read 경영, so these drafts are locked for every kim token, the writer included (R4)
      for (const t of ['kimCat', 'kimRead', 'kimGrep', 'kim']) expect({ t, ls: (await env.sh(t, 'ls -a /drafts')).stdout }).toEqual({ t, ls: '.\n..\n' })
      // a token that never read the copy keeps a clean window
      env.addToken('kimClean', 'kim', { name: 'kim-clean' })
      await env.sh('kimClean', 'cat /공용/c.md > /dev/null')
      await env.tool('kimClean', 'write', { path: '/drafts/d.md', content: 'x' })
      expect(env.draftSrc('kimClean', 'd.md').has(mgmt)).toBe(false)
    } finally { env.cleanup() }
  })
})
