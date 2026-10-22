import { Database } from 'bun:sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { INNER_MAGIC } from '../src/backup/archive'
import { backupCommand } from '../src/backup/cli'
import { BackupError, CHUNK, decryptFile, Encryptor, generateKey, HEADER_LEN, parsePublic, parseSecret, type SecretKey } from '../src/backup/crypto'
import { restoreArchive, runBackup, verifyArchive } from '../src/backup/index'
import { DirTarget, parseTarget, S3Target } from '../src/backup/target'
import { openDb } from '../src/db'
import { layoutFor, type LayoutKind } from '../src/layout'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-test-'))
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }))
let n = 0
const tmp = (name: string) => { const d = path.join(tmpRoot, `${name}-${n++}`); fs.mkdirSync(d, { recursive: true }); return d }
const sha = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex')

/** A data directory with a database (people, token, drafts, versions, audit) and draft contents. */
function makeData(kind: LayoutKind, opts: { bigDraft?: boolean } = {}) {
  const dir = tmp(`data-${kind}`)
  const l = layoutFor(dir, kind)
  const db = openDb(path.dirname(l.dbFile))
  const now = Date.now()
  db.run('INSERT INTO people (name, admin, created_at) VALUES (?, 1, ?)', ['dion', now])
  db.run("INSERT INTO tokens (person_id, name, hash, hint, created_at) VALUES (1, 't', 'h', 'x', ?)", [now])
  const contents = [new TextEncoder().encode('# 초안 1\n회의록 요약\n'), new TextEncoder().encode('draft two'),
    ...(opts.bigDraft ? [new Uint8Array(crypto.randomBytes(3 * CHUNK + 1234))] : [])]
  contents.forEach((c, i) => {
    db.run('INSERT INTO drafts (token_id, person_id, path, created_at) VALUES (1, 1, ?, ?)', [`d${i}.md`, now])
    db.run('INSERT INTO draft_versions (draft_id, version, sha256, size, created_at) VALUES (?, 1, ?, ?, ?)', [i + 1, sha(c), c.length, now])
    const p = path.join(l.draftsDir, sha(c).slice(0, 2), sha(c))
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, c)
  })
  let prev = '0'.repeat(64)
  for (let i = 0; i < 5; i++) {
    const h = sha(new TextEncoder().encode(prev + i))
    db.run("INSERT INTO audit (at, tool, command, command_sha256, files, outcome, prev_hash, hash) VALUES (?, 'bash', 'ls', 'x', '[]', 'ok', ?, ?)", [now, prev, h])
    prev = h
  }
  db.close()
  return { dir, layout: l, contents, auditHead: prev }
}

function key(): { key: SecretKey; secretText: string; publicText: string } { return generateKey() }

async function backup(kind: LayoutKind = 'flat', opts: { bigDraft?: boolean } = {}) {
  const data = makeData(kind, opts)
  const k = key()
  const target = new DirTarget(tmp('target'), { dataDir: data.dir, allowSameDisk: true })
  const r = await runBackup({ dataDir: data.dir, target, recipient: k.key.publicKey })
  return { data, k, r, target }
}

async function expectBackupError(p: Promise<unknown> | (() => unknown), code?: string) {
  let err: unknown
  try { await (typeof p === 'function' ? p() : p) } catch (e) { err = e }
  expect(err).toBeInstanceOf(BackupError)
  if (code) expect((err as BackupError).code).toBe(code as BackupError['code'])
  return err as BackupError
}

describe('keys', () => {
  test('secret and public keys round-trip and catch typos', () => {
    const k = key()
    const s = parseSecret(k.secretText)
    expect(Buffer.from(s.publicKey).equals(Buffer.from(k.key.publicKey))).toBe(true)
    expect(Buffer.from(parsePublic(k.publicText)).equals(Buffer.from(k.key.publicKey))).toBe(true)
    const i = k.secretText.indexOf('_bksec1_') + 12
    const typo = k.secretText.slice(0, i) + (k.secretText[i] === 'A' ? 'B' : 'A') + k.secretText.slice(i + 1)
    expect(() => parseSecret(typo)).toThrow(/typo/)
    expect(() => parseSecret(k.publicText)).toThrow(BackupError)
  })
})

describe('stream encryption', () => {
  const kp = key()
  for (const len of [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 2 * CHUNK, 2 * CHUNK + 7]) {
    test(`round-trips ${len} bytes`, () => {
      const plain = new Uint8Array(crypto.randomBytes(len))
      const f = path.join(tmp('enc'), 'x')
      const parts: Uint8Array[] = []
      const e = new Encryptor((b) => parts.push(Buffer.from(b)), kp.key.publicKey)
      // uneven write sizes
      for (let o = 0; o < len; o += 1000) e.write(plain.subarray(o, Math.min(len, o + 1000)))
      e.close()
      fs.writeFileSync(f, Buffer.concat(parts))
      const out = Buffer.concat([...decryptFile(f, kp.key)])
      expect(out.equals(Buffer.from(plain))).toBe(true)
      // cut exactly at every chunk boundary: always detected
      const all = fs.readFileSync(f)
      for (let cut = HEADER_LEN; cut < all.length; cut += CHUNK + 16) {
        fs.writeFileSync(f, all.subarray(0, cut))
        expect(() => [...decryptFile(f, kp.key)]).toThrow(BackupError)
      }
    })
  }
})

describe('backup run / verify / restore', () => {
  for (const kind of ['flat', 'installed'] as const) {
    test(`round trip (${kind} layout)`, async () => {
      const { data, k, r } = await backup(kind, { bigDraft: true })
      expect(r.draftFiles).toBe(3)
      expect(r.info.db?.auditRows).toBe(5)
      expect(r.info.excludes[0]).toMatch(/NAS/)
      // no plaintext left behind in staging
      expect(fs.readdirSync(data.layout.stagingDir)).toEqual([])

      const v = await verifyArchive(r.location, parseSecret(k.secretText))
      expect(v.problems).toEqual([])
      expect(v.ok).toBe(true)
      expect(v.db).toMatchObject({ integrity: 'ok', auditRows: 5, auditHead: data.auditHead, drafts: 3, versions: 3 })

      const into = path.join(tmp('restore'), 'data')
      const res = await restoreArchive(r.location, k.key, into)
      expect(res.layout).toBe(kind)
      const l = layoutFor(into, kind)
      const db = new Database(l.dbFile, { readonly: true })
      expect(db.query('SELECT name FROM people').all()).toEqual([{ name: 'dion' }])
      expect(db.query<{ hash: string }, []>('SELECT hash FROM audit ORDER BY id DESC LIMIT 1').get()?.hash).toBe(data.auditHead)
      db.close()
      for (const c of data.contents) expect(Buffer.from(fs.readFileSync(path.join(l.draftsDir, sha(c).slice(0, 2), sha(c)))).equals(Buffer.from(c))).toBe(true)
      expect(fs.statSync(l.dbFile).mode & 0o777).toBe(0o600)
      expect(fs.statSync(l.draftsDir).mode & 0o777).toBe(0o700)
      // nothing else next to the restored folder
      expect(fs.readdirSync(path.dirname(into))).toEqual(['data'])
    })
  }

  test('wrong key fails, even with the key id forged', async () => {
    const { r } = await backup()
    const other = key()
    await expectBackupError(verifyArchive(r.location, other.key), 'wrong-key')
    const forged = fs.readFileSync(r.location)
    forged.set(crypto.createHash('sha256').update(other.key.publicKey).digest().subarray(0, 16), 12)
    const f = r.location + '.forged'
    fs.writeFileSync(f, forged)
    await expectBackupError(verifyArchive(f, other.key), 'wrong-key')
  })

  test('any changed byte is detected', async () => {
    const { r, k } = await backup('flat', { bigDraft: true })
    const orig = fs.readFileSync(r.location)
    for (const at of [3, 9, 40, 100, HEADER_LEN + 5, HEADER_LEN + CHUNK + 20, orig.length - 1]) {
      const t = Buffer.from(orig)
      t[at] = t[at]! ^ 0x01
      fs.writeFileSync(r.location, t)
      await expectBackupError(verifyArchive(r.location, k.key))
    }
  })

  test('truncated, extended and garbage archives are rejected; restore leaves nothing', async () => {
    const { r, k } = await backup('flat', { bigDraft: true })
    const orig = fs.readFileSync(r.location)
    const cases: [string, Buffer][] = [
      ['empty', Buffer.alloc(0)],
      ['header only', orig.subarray(0, HEADER_LEN)],
      ['cut at chunk boundary', orig.subarray(0, HEADER_LEN + CHUNK + 16)],
      ['cut mid chunk', orig.subarray(0, HEADER_LEN + CHUNK + 100)],
      ['one byte short', orig.subarray(0, orig.length - 1)],
      ['extra byte', Buffer.concat([orig, Buffer.from([0])])],
      ['not a backup', Buffer.from('hello world, this is not a backup file at all; '.repeat(10))],
    ]
    for (const [name, bytes] of cases) {
      fs.writeFileSync(r.location, bytes)
      const err = await expectBackupError(verifyArchive(r.location, k.key))
      expect([name, err.code]).not.toEqual([name, 'wrong-key'])
      const parent = tmp('restore-bad')
      await expectBackupError(restoreArchive(r.location, k.key, path.join(parent, 'data')))
      expect(fs.readdirSync(parent)).toEqual([])
    }
  })

  test('restore refuses a folder that is not empty', async () => {
    const { r, k } = await backup()
    const into = tmp('nonempty')
    fs.writeFileSync(path.join(into, 'x'), 'x')
    await expectBackupError(restoreArchive(r.location, k.key, into), 'config')
  })

  test('an archive with an unsafe path (made with the public key) restores nothing', async () => {
    const k = key()
    const f = path.join(tmp('evil'), 'evil.bkp')
    const parts: Uint8Array[] = []
    const e = new Encryptor((b) => parts.push(Buffer.from(b)), k.key.publicKey)
    const rec = (o: object) => { const j = Buffer.from(JSON.stringify(o)); const l = Buffer.alloc(4); l.writeUInt32BE(j.length); e.write(l); e.write(j) }
    e.write(INNER_MAGIC)
    rec({ t: 'info', format: 1, product: 'x', productVersion: '0', createdAt: '', host: '', layout: 'flat', excludes: [], db: null })
    const body = Buffer.from('pwned')
    rec({ t: 'file', path: 'drafts/../../evil', size: body.length, mode: 0o600 })
    e.write(body); e.write(crypto.createHash('sha256').update(body).digest())
    rec({ t: 'end', files: 1, bytes: body.length })
    e.close()
    fs.writeFileSync(f, Buffer.concat(parts))
    const parent = tmp('restore-evil')
    await expectBackupError(restoreArchive(f, k.key, path.join(parent, 'data')), 'unsafe')
    expect(fs.readdirSync(parent)).toEqual([])
    expect(fs.existsSync(path.join(parent, '..', 'evil'))).toBe(false)
  })

  test('a draft version without content is reported by verify and stops restore', async () => {
    const data = makeData('flat')
    const c = data.contents[0]!
    fs.rmSync(path.join(data.layout.draftsDir, sha(c).slice(0, 2), sha(c)))
    const k = key()
    const r = await runBackup({ dataDir: data.dir, target: new DirTarget(tmp('t'), { dataDir: data.dir, allowSameDisk: true }), recipient: k.key.publicKey })
    const v = await verifyArchive(r.location, k.key)
    expect(v.ok).toBe(false)
    expect(v.problems.join()).toMatch(/no content/)
    await expectBackupError(restoreArchive(r.location, k.key, path.join(tmp('r'), 'data')), 'format')
  })
})

describe('targets', () => {
  test('refuses the same disk unless allowed, and folders inside the data', () => {
    const data = makeData('flat')
    expect(() => new DirTarget(tmp('same'), { dataDir: data.dir })).toThrow(/same disk/)
    expect(() => new DirTarget(data.dir, { dataDir: data.dir, allowSameDisk: true })).toThrow(/inside the data/)
    expect(() => parseTarget('relative/dir')).toThrow(/absolute/)
    expect(() => parseTarget('/does/not/exist/anywhere')).toThrow(/does not exist/)
  })

  test('S3 is an interface stub in v0.1', async () => {
    const t = parseTarget('s3://my-bucket/office')
    expect(t).toBeInstanceOf(S3Target)
    expect(() => t.create('x')).toThrow(/not available in v0.1/)
  })

  test('keeps the newest N archives, same-second names do not collide', async () => {
    const data = makeData('flat')
    const k = key()
    const target = new DirTarget(tmp('keep'), { dataDir: data.dir, allowSameDisk: true })
    const now = new Date('2026-10-22T03:15:00Z')
    const names: string[] = []
    for (let i = 0; i < 4; i++) names.push((await runBackup({ dataDir: data.dir, target, recipient: k.key.publicKey, keep: 3, now })).name)
    expect(new Set(names).size).toBe(4)
    expect(await target.list()).toEqual(names.slice(1))
  })
})

describe('cli', () => {
  const capture = () => { const out: string[] = [], err: string[] = []; return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } } }

  test('keygen --set, target set, run, list, verify, restore', async () => {
    const data = makeData('installed')
    const t = tmp('cli-target')
    let c = capture()
    expect(await backupCommand(['run', '--if-configured'], { dataDir: data.dir, io: c.io })).toBe(0)
    expect(c.out.join()).toMatch(/skipped/)

    c = capture()
    expect(await backupCommand(['keygen', '--set'], { dataDir: data.dir, io: c.io })).toBe(0)
    const secret = c.out[0]!
    expect(secret).toMatch(/_bksec1_/)
    // the secret is never written into the data folder
    const all = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? all(path.join(d, e.name)) : [path.join(d, e.name)])
    for (const f of all(data.dir)) expect(fs.readFileSync(f).includes(Buffer.from(secret.slice(-20)))).toBe(false)
    expect(fs.readFileSync(data.layout.backupRecipient, 'utf8')).toMatch(/_bkpub1_/)

    c = capture()
    expect(await backupCommand(['target', 'set', t], { dataDir: data.dir, io: c.io })).toBe(2)
    expect(c.err.join()).toMatch(/same disk/)
    expect(await backupCommand(['target', 'set', t, '--keep', '5', '--allow-same-disk'], { dataDir: data.dir, io: capture().io })).toBe(0)

    c = capture()
    expect(await backupCommand(['run', '--if-configured'], { dataDir: data.dir, io: c.io })).toBe(0)
    expect(c.out.join('\n')).toMatch(/backup written: .*\.bkp/)
    expect(c.out.join('\n')).toMatch(/NOT backed up: the original files/)
    const archive = c.out[0]!.replace(/^backup written: /, '').replace(/ \(\d+ bytes\)$/, '')

    c = capture()
    expect(await backupCommand(['list'], { dataDir: data.dir, io: c.io })).toBe(0)
    expect(c.out).toEqual([path.basename(archive)])

    const keyFile = path.join(tmp('key'), 'k.txt')
    fs.writeFileSync(keyFile, secret + '\n', { mode: 0o600 })
    c = capture()
    expect(await backupCommand(['verify', archive, '--key-file', keyFile], { dataDir: data.dir, io: c.io })).toBe(0)
    expect(c.out.join('\n')).toMatch(/verify: ok/)

    c = capture()
    expect(await backupCommand(['verify', archive], { dataDir: data.dir, io: { ...c.io } })).toBe(2)

    const other = key()
    fs.writeFileSync(keyFile, other.secretText)
    c = capture()
    expect(await backupCommand(['verify', archive, '--key-file', keyFile], { dataDir: data.dir, io: c.io })).toBe(1)
    expect(c.err.join()).toMatch(/made for key/)

    c = capture()
    const into = path.join(tmp('cli-restore'), 'new')
    expect(await backupCommand(['restore', archive, '--into', into, '--key-file', '-'], { dataDir: data.dir, io: { ...c.io, stdin: async () => secret + '\n' } })).toBe(0)
    expect(fs.existsSync(path.join(into, 'db', 'store.db'))).toBe(true)
    expect(c.out.join('\n')).toMatch(/restored into/)
  })
})
