// Notifications: R11 payloads (no names, ever), recipients per role, digest, coalescing and rate limit, channels.
import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db'
import { attachNotify } from '../src/notify'
import { formatMail, SmtpMailer } from '../src/notify/channels'
import { EVENT_KINDS, type EventKind, type ShelfEvent } from '../src/notify/events'
import { resolveRecipients } from '../src/notify/recipients'
import { makeCtx } from '../src/session'
import { addGroup, addMember, addPerson, createToken, folderAt, grantManage, registerFolder, setRule } from '../src/store'
import { setup, type Env } from './helpers'
import { decodeMail, readOutbox, slackSink, smtpSink, withNotify } from './notify-helpers'

const cleanups: (() => void)[] = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })
const env = () => { const e = setup(); cleanups.push(e.cleanup); return e }
const sink = () => { const s = slackSink(); cleanups.push(s.stop); return s }

// ---------- R11 property test ----------
const ALPHA = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ가나다라마바사아자차카타파하경영인사총무재무'
function rng(seed: number) { return () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff } }

describe('R11: channel payloads carry kind, count and link only', () => {
  test('random names of people, groups, folders, files, tokens and drafts never appear in any channel or inbox payload', async () => {
    for (let round = 0; round < 6; round++) {
      const r = rng(1000 + round)
      const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!
      const used = new Set<string>()
      const name = () => { let s: string; do { s = Array.from({ length: 9 }, () => pick([...ALPHA])).join('') } while (used.has(s)); used.add(s); return s }
      const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-r11-')))
      const db = openDb(dir)
      cleanups.push(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }) })
      const ctx = makeCtx(db, dir)
      const slack = sink()
      const people = Array.from({ length: 6 }, (_, i) => { const n = name(); addPerson(db, n, i < 2); return n })
      const groups = Array.from({ length: 2 }, () => { const g = name(); addGroup(db, g); return g })
      for (const p of people) addMember(db, pick(groups), p)
      const folders: string[] = []
      for (let i = 0; i < 4; i++) {
        const top = path.join(dir, 'nas', name())
        const sub = path.join(top, name())
        fs.mkdirSync(sub, { recursive: true })
        fs.writeFileSync(path.join(sub, name() + '.md'), name())
        registerFolder(db, top, { name: name(), nasReaders: i % 2 ? 'all' : [pick(people)] })
        setRule(db, top, '@' + pick(groups), 'read')
        grantManage(db, pick([top, sub]), pick(people))
        folders.push(top, sub)
      }
      const tokens = people.map((p) => createToken(db, p, { name: name() }))
      const rt = attachNotify(ctx, { cfg: { baseUrl: 'https://shelf.example.test', email: { mode: 'outbox', from: 'alerts@example.test', outboxDir: path.join(dir, 'outbox') }, perMinute: 1000, anchor: { intervalMs: 0, email: true } } })
      const ids = people.map((p) => db.query<{ id: number }, [string]>('SELECT id FROM people WHERE name = ?').get(p)!.id)
      ids.forEach((id, i) => rt.notifier.setContact(id, { email: `user${i}@example.test`, slack_webhook: slack.url(`/hook/${i}`), lang: i % 2 ? 'ko' : 'en' }))
      const fid = (p: string) => folderAt(db, p).id
      const secrets = [...used]
      for (let i = 0; i < 40; i++) {
        const kind = pick(EVENT_KINDS)
        const e: ShelfEvent = {
          kind, count: 1 + Math.floor(r() * 5), subjectPersonId: pick(ids), tokenId: pick(tokens).id, folderId: fid(pick(folders)),
          sourceFolderIds: [fid(pick(folders)), fid(pick(folders))], targetFolderId: fid(pick(folders)), weakOnly: r() < 0.3,
          detail: { path: `/${pick(secrets)}/${pick(secrets)}.md`, draft: `/drafts/${pick(secrets)}.md`, person: pick(people), provenance: [pick(secrets)], token: pick(secrets) },
        }
        if (kind === 'audit_anchor') { const a = await rt.anchorNow({ force: true }); expect(a).not.toBeNull(); continue }
        rt.emit(e)
      }
      await rt.flush()
      ctx.now = () => Date.now() + 2 * 86400_000 // past the digest hour
      const late = attachNotify(ctx, { cfg: rt.cfg })
      await late.flush()

      const mails = readOutbox(path.join(dir, 'outbox'))
      const inbox = db.query<Record<string, unknown>, []>('SELECT * FROM notify_inbox').all()
      expect(slack.hits.length).toBeGreaterThan(0)
      expect(mails.length).toBeGreaterThan(0)
      expect(inbox.length).toBeGreaterThan(0)
      const payloads = [
        ...slack.hits.map((h) => h.raw),
        ...mails.map((m) => m.subject + '\n' + m.body + '\n' + m.raw.replace(/^To: .*$/m, '')),
        ...inbox.map((row) => JSON.stringify(row)),
      ]
      for (const p of payloads) for (const s of secrets) expect(p.includes(s)).toBe(false)
      // Slack payload is exactly {text}
      for (const h of slack.hits) expect(Object.keys(h.body as object)).toEqual(['text'])
    }
  })
})

// ---------- recipients ----------
describe('recipients per role (R11, R9, R10)', () => {
  const setupRoles = () => {
    const e = env()
    const n = withNotify(e)
    const d = (rel: string) => path.join(e.root, rel)
    fs.mkdirSync(d('경영/분기'), { recursive: true })
    grantManage(e.db, d('경영'), 'boss')
    grantManage(e.db, d('프로젝트'), 'park')
    return { e, n, d, f: (rel: string) => folderAt(e.db, d(rel)).id }
  }
  const byPerson = (e: Env, ev: ShelfEvent) => Object.fromEntries(resolveRecipients(e.db, ev).map((r) => [
    e.db.query<{ name: string }, [number]>('SELECT name FROM people WHERE id = ?').get(r.personId)!.name, `${r.level}:${r.count}${r.digest ? ':digest' : ''}`]))

  test('widening: source manage gets detail, target manage gets "1 item" only, admin nothing', () => {
    const { e, f } = setupRoles()
    expect(byPerson(e, { kind: 'widened_draft', count: 3, sourceFolderIds: [f('경영')], targetFolderId: f('프로젝트') })).toEqual({ boss: 'detail:3', park: 'count:1' })
  })
  test('widening from a source without manage: admins get the count only', () => {
    const { e, f } = setupRoles()
    expect(byPerson(e, { kind: 'widened_draft', count: 2, sourceFolderIds: [f('인사')], targetFolderId: f('공용') })).toEqual({ dion: 'count:2' })
  })
  test('manage is inherited down; weak-only widening goes to the digest', () => {
    const { e, f } = setupRoles()
    expect(byPerson(e, { kind: 'widened_draft', sourceFolderIds: [f('경영/분기')], targetFolderId: f('프로젝트'), weakOnly: true })).toEqual({ boss: 'detail:1:digest', park: 'count:1:digest' })
  })
  test('personal folders have no manage holders', () => {
    const { e, d, f } = setupRoles()
    grantManage(e.db, d('개인_kim'), 'boss')
    expect(byPerson(e, { kind: 'widened_draft', sourceFolderIds: [f('개인_kim')], targetFolderId: f('공용') })).toEqual({ dion: 'count:1' })
  })
  test('R9: self-grant → folder manage holders and the person concerned; reset → only the person', () => {
    const { e, n, f } = setupRoles()
    expect(byPerson(e, { kind: 'admin_self_grant', folderId: f('경영'), subjectPersonId: n.pid('dion') })).toEqual({ boss: 'detail:1', dion: 'detail:1' })
    expect(byPerson(e, { kind: 'password_reset', subjectPersonId: n.pid('kim') })).toEqual({ kim: 'detail:1' })
  })
  test('token events go to the owner; write attempts and bulk reads also to admins as a count', () => {
    const { e, n } = setupRoles()
    for (const kind of ['new_client', 'token_revoked'] as EventKind[]) expect(byPerson(e, { kind, subjectPersonId: n.pid('kim') })).toEqual({ kim: 'detail:1' })
    for (const kind of ['bulk_read', 'original_write_attempt'] as EventKind[]) expect(byPerson(e, { kind, subjectPersonId: n.pid('kim') })).toEqual({ kim: 'detail:1', dion: 'count:1' })
  })
  test('quarantine → admins and the folder manage holders; anchors → admins; inactive people never', () => {
    const { e, f } = setupRoles()
    expect(byPerson(e, { kind: 'quarantine', folderId: f('프로젝트') })).toEqual({ dion: 'detail:1', park: 'detail:1' })
    expect(byPerson(e, { kind: 'audit_anchor', count: 10 })).toEqual({ dion: 'detail:10' })
    e.db.query("UPDATE people SET active = 0 WHERE name = 'park'").run()
    expect(byPerson(e, { kind: 'quarantine', folderId: f('프로젝트') })).toEqual({ dion: 'detail:1' })
  })
})

// ---------- digest, coalescing, rate limit ----------
describe('delivery', () => {
  test('weak-only widenings wait for the daily digest and arrive as one message; strong ones go now', async () => {
    const e = env()
    const n = withNotify(e)
    const s = sink()
    grantManage(e.db, path.join(e.root, '경영'), 'boss')
    n.rt.notifier.setContact(n.pid('boss'), { slack_webhook: s.url() })
    const src = [folderAt(e.db, path.join(e.root, '경영')).id], tgt = folderAt(e.db, path.join(e.root, '프로젝트')).id
    for (let i = 0; i < 3; i++) n.rt.emit({ kind: 'widened_draft', sourceFolderIds: src, targetFolderId: tgt, weakOnly: true })
    n.rt.emit({ kind: 'widened_draft', sourceFolderIds: src, targetFolderId: tgt })
    await n.rt.flush()
    expect(s.hits.map((h) => (h.body as { text: string }).text)).toEqual(['[shelf] 1 widened draft to review\nDetails after sign-in: https://shelf.example.test/alerts/widened_draft'])
    n.clock.t = new Date(2026, 9, 23, 8, 59).getTime()
    await n.rt.flush()
    expect(s.hits.length).toBe(1)
    n.clock.t = new Date(2026, 9, 23, 9, 0).getTime()
    await n.rt.flush()
    expect(s.hits.length).toBe(2)
    expect((s.hits[1]!.body as { text: string }).text).toBe('[shelf] Daily summary: 3 widened drafts to review\nDetails after sign-in: https://shelf.example.test/alerts/widened_draft')
    // the inbox has them at once, coalesced
    expect(n.rt.notifier.inbox(n.pid('boss')).map((r) => [r.kind, r.count])).toEqual([['widened_draft', 4]])
  })

  test('same kind coalesces; at most perMinute messages per destination, the rest waits', async () => {
    const e = env()
    const n = withNotify(e, { perMinute: 2 })
    const s = sink()
    const kim = n.pid('kim')
    n.rt.notifier.setContact(kim, { slack_webhook: s.url(), lang: 'ko' })
    for (let i = 0; i < 10; i++) n.rt.emit({ kind: 'new_client', subjectPersonId: kim })
    for (const kind of ['token_revoked', 'bulk_read', 'original_write_attempt'] as EventKind[]) n.rt.emit({ kind, subjectPersonId: kim })
    const r1 = await n.rt.flush()
    expect(r1.sent).toBe(2)
    const texts = () => s.hits.map((h) => (h.body as { text: string }).text.split('\n')[0])
    // urgent first (token_revoked), then the oldest group: ten new_client events in one message
    expect(texts()).toEqual(['[shelf] 액세스 토큰 1개가 끊겼습니다', '[shelf] 액세스 토큰에 새 클라이언트 연결 10건'])
    n.rt.emit({ kind: 'bulk_read', subjectPersonId: kim })
    n.clock.t += 30_000
    expect((await n.rt.flush()).sent).toBe(0)
    n.clock.t += 31_000
    await n.rt.flush()
    expect(texts().slice(2)).toEqual(['[shelf] 대량 읽기 경보 2건', '[shelf] 원본 쓰기 시도 1건 (거부됨)'])
    expect(n.rt.notifier.pendingCount()).toBe(0)
  })

  test('two recipients sharing one webhook: an event counts once', async () => {
    const e = env()
    const n = withNotify(e)
    const s = sink()
    grantManage(e.db, path.join(e.root, '경영'), 'boss')
    grantManage(e.db, path.join(e.root, '경영'), 'lee')
    for (const p of ['boss', 'lee']) n.rt.notifier.setContact(n.pid(p), { slack_webhook: s.url('/team') })
    n.rt.emit({ kind: 'quarantine', folderId: folderAt(e.db, path.join(e.root, '경영')).id })
    await n.rt.flush()
    expect(s.hits.map((h) => (h.body as { text: string }).text.split('\n')[0])).toEqual(['[shelf] 1 folder quarantined'])
  })

  test('Slack sink gets JSON {text}; a failing webhook is retried later', async () => {
    const e = env()
    const n = withNotify(e)
    const s = sink()
    n.rt.notifier.setContact(n.pid('kim'), { slack_webhook: s.url('/services/T/B/x') })
    s.state.status = 500
    n.rt.emit({ kind: 'new_client', subjectPersonId: n.pid('kim') })
    expect((await n.rt.flush()).failed).toBe(1)
    expect(s.hits[0]!.contentType).toBe('application/json')
    expect(s.hits[0]!.path).toBe('/services/T/B/x')
    s.state.status = 200
    expect((await n.rt.flush()).sent).toBe(0) // backing off
    n.clock.t += 61_000
    expect((await n.rt.flush()).sent).toBe(1)
    expect(s.hits[1]!.body).toEqual({ text: '[shelf] 1 new client used your access token\nDetails after sign-in: https://shelf.example.test/alerts/new_client' })
  })

  test('email: file outbox in dev; count-level recipients get the inbox link', async () => {
    const e = env()
    const n = withNotify(e)
    n.rt.notifier.setContact(n.pid('dion'), { email: 'admin@example.test' })
    n.rt.notifier.setContact(n.pid('kim'), { email: 'kim-addr@example.test', lang: 'ko' })
    n.rt.emit({ kind: 'bulk_read', subjectPersonId: n.pid('kim') })
    await n.rt.flush()
    const mails = readOutbox(n.outbox)
    expect(mails.map((m) => [m.to, m.subject, m.body])).toEqual(expect.arrayContaining([
      ['admin@example.test', '[shelf] 1 bulk-read alert', '[shelf] 1 bulk-read alert\nDetails after sign-in: https://shelf.example.test/inbox'],
      ['kim-addr@example.test', '[shelf] 대량 읽기 경보 1건', '[shelf] 대량 읽기 경보 1건\n로그인 뒤 상세 보기: https://shelf.example.test/alerts/bulk_read'],
    ]))
    expect(mails.length).toBe(2)
  })

  test('SMTP client against a local SMTP sink (AUTH PLAIN, dot-stuffing, UTF-8 subject)', async () => {
    const smtp = await smtpSink()
    cleanups.push(smtp.stop)
    const m = new SmtpMailer({ host: '127.0.0.1', port: smtp.port, user: 'u', pass: 'p' })
    await m.send({ to: 'admin@example.test', from: 'shelf@example.test', subject: '[shelf] 감사 기준점: 3행', text: 'line\n.starts with a dot' })
    expect(smtp.messages.length).toBe(1)
    expect(smtp.messages[0]!.to).toBe('<admin@example.test>')
    expect(smtp.messages[0]!.auth).toBe('\0u\0p')
    const d = decodeMail(smtp.messages[0]!.data)
    expect(d.subject).toBe('[shelf] 감사 기준점: 3행')
    expect(d.body).toBe('line\n.starts with a dot')
    expect(formatMail({ to: 'a@b', from: 'c@d', subject: 's', text: 't' })).toContain('Content-Transfer-Encoding: base64')
  })
})
