// Events → in-app inbox (at once, coalesced per kind) and channel deliveries (flushed in coalesced groups, rate limited
// per destination, weak-only widenings held for the daily digest). Payloads come only from messages.render (R11).
import path from 'node:path'
import type { DB } from '../db'
import { FileOutbox, type Mailer, postSlack, SmtpMailer } from './channels'
import type { NotifyConfig } from './config'
import type { EventKind, DriveEvent, SignedAnchor } from './events'
import { anchorBlock, type Lang, type Level, linkFor, render } from './messages'
import { resolveRecipients } from './recipients'
import { ensureNotifySchema } from './schema'

/** Sent first when the rate limit forces a choice (R9: "right away"). */
const URGENT = new Set<EventKind>(['password_reset', 'admin_self_grant', 'token_revoked', 'provenance_reset'])
/** Each one is its own message (an anchor must not be merged away). */
const NO_COALESCE = new Set<EventKind>(['audit_anchor'])
const MAX_ATTEMPTS = 5

export interface Contact { email?: string | null; slack_webhook?: string | null; lang?: Lang | null }
export interface InboxRow { id: number; person_id: number; kind: EventKind; level: Level; count: number; link: string; created_at: number; updated_at: number; read_at: number | null }
interface Delivery { id: number; event_id: number; channel: 'email' | 'slack'; dest: string; kind: EventKind; level: Level; count: number; lang: Lang; digest: number; attempts: number }

export interface NotifierDeps { db: DB; dataDir: string; cfg: NotifyConfig; now?: () => number; mailer?: Mailer; fetch?: typeof fetch }

/** Next local `hour`:00 strictly after `at`. */
export function nextDigestAt(at: number, hour: number): number {
  const d = new Date(at)
  d.setHours(hour, 0, 0, 0)
  if (d.getTime() <= at) d.setDate(d.getDate() + 1)
  return d.getTime()
}

export class Notifier {
  readonly db: DB
  readonly cfg: NotifyConfig
  readonly now: () => number
  readonly mailer: Mailer | null
  private readonly fetchImpl: typeof fetch
  private flushing: Promise<FlushResult> | null = null

  constructor(d: NotifierDeps) {
    this.db = d.db
    this.cfg = d.cfg
    this.now = d.now ?? Date.now
    this.fetchImpl = d.fetch ?? fetch
    ensureNotifySchema(d.db)
    this.mailer = d.mailer ?? (d.cfg.email.mode === 'outbox' ? new FileOutbox(d.cfg.email.outboxDir ?? path.join(d.dataDir, 'outbox'))
      : d.cfg.email.mode === 'smtp' && d.cfg.email.smtp ? new SmtpMailer(d.cfg.email.smtp) : null)
  }

  // ---------- contacts ----------
  setContact(personId: number, c: Contact) {
    this.db.query(`INSERT INTO notify_contacts (person_id, email, slack_webhook, lang) VALUES (?, ?, ?, ?)
      ON CONFLICT (person_id) DO UPDATE SET email = coalesce(excluded.email, email), slack_webhook = coalesce(excluded.slack_webhook, slack_webhook), lang = coalesce(excluded.lang, lang)`)
      .run(personId, c.email ?? null, c.slack_webhook ?? null, c.lang ?? null)
  }
  contact(personId: number): Contact | null {
    return this.db.query<Contact, [number]>('SELECT email, slack_webhook, lang FROM notify_contacts WHERE person_id = ?').get(personId)
  }

  // ---------- events ----------
  /** Record the event, fill inboxes, queue deliveries. Returns the event id. */
  handle(e: DriveEvent): number {
    const db = this.db
    const at = e.at ?? this.now()
    const count = Math.max(1, e.count ?? 1)
    const detail = { sourceFolderIds: e.sourceFolderIds, targetFolderId: e.targetFolderId, weakOnly: e.weakOnly, anchor: e.anchor, ...e.detail }
    let id = 0
    db.transaction(() => {
      id = Number(db.query('INSERT INTO notify_events (at, kind, count, subject_person_id, token_id, folder_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(at, e.kind, count, e.subjectPersonId ?? null, e.tokenId ?? null, e.folderId ?? e.targetFolderId ?? null, JSON.stringify(detail)).lastInsertRowid)
      for (const r of resolveRecipients(db, { ...e, count })) {
        const link = linkFor(this.cfg.baseUrl, e.kind, r.level)
        const open = db.query<{ id: number }, [number, string, string]>('SELECT id FROM notify_inbox WHERE person_id = ? AND kind = ? AND level = ? AND read_at IS NULL').get(r.personId, e.kind, r.level)
        if (open) db.query('UPDATE notify_inbox SET count = count + ?, updated_at = ? WHERE id = ?').run(r.count, at, open.id)
        else db.query('INSERT INTO notify_inbox (person_id, kind, level, count, link, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(r.personId, e.kind, r.level, r.count, link, at, at)
        const c = this.contact(r.personId)
        const lang: Lang = c?.lang ?? this.cfg.lang
        const due = r.digest ? nextDigestAt(at, this.cfg.digestHour) : at
        const q = db.query('INSERT INTO notify_deliveries (event_id, person_id, channel, dest, kind, level, count, lang, digest, due_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        if (c?.email && this.mailer) q.run(id, r.personId, 'email', c.email, e.kind, r.level, r.count, lang, r.digest ? 1 : 0, due)
        if (c?.slack_webhook) q.run(id, r.personId, 'slack', c.slack_webhook, e.kind, r.level, r.count, lang, r.digest ? 1 : 0, due)
      }
    })()
    return id
  }

  inbox(personId: number, opts: { unreadOnly?: boolean } = {}): InboxRow[] {
    return this.db.query<InboxRow, [number]>(`SELECT * FROM notify_inbox WHERE person_id = ? ${opts.unreadOnly ? 'AND read_at IS NULL' : ''} ORDER BY updated_at DESC, id DESC`).all(personId)
  }
  markRead(personId: number, id?: number) {
    if (id === undefined) this.db.query('UPDATE notify_inbox SET read_at = ? WHERE person_id = ? AND read_at IS NULL').run(this.now(), personId)
    else this.db.query('UPDATE notify_inbox SET read_at = ? WHERE person_id = ? AND id = ?').run(this.now(), personId, id)
  }

  // ---------- delivery ----------
  /** Send what is due. Concurrent calls share one run. */
  flush(): Promise<FlushResult> {
    this.flushing ??= this.doFlush().finally(() => { this.flushing = null })
    return this.flushing
  }

  private async doFlush(): Promise<FlushResult> {
    const db = this.db
    const now = this.now()
    const res: FlushResult = { sent: 0, held: 0, failed: 0 }
    const due = db.query<Delivery, [number]>("SELECT * FROM notify_deliveries WHERE status = 'pending' AND due_at <= ? ORDER BY id").all(now)
    const groups = new Map<string, Delivery[]>()
    for (const d of due) {
      const k = [d.channel, d.dest, d.kind, d.level, d.lang, d.digest, NO_COALESCE.has(d.kind) ? d.event_id : ''].join('\u0000')
      groups.set(k, [...(groups.get(k) ?? []), d])
    }
    const ordered = [...groups.values()].sort((a, b) => Number(URGENT.has(b[0]!.kind)) - Number(URGENT.has(a[0]!.kind)) || a[0]!.id - b[0]!.id)
    for (const g of ordered) {
      const first = g[0]!
      const recent = db.query<{ n: number }, [string, string, number]>('SELECT count(*) AS n FROM notify_messages WHERE channel = ? AND dest = ? AND at > ?').get(first.channel, first.dest, now - 60_000)!.n
      if (recent >= this.cfg.perMinute) { res.held += g.length; continue }
      // one event counts once even if it reached this destination through several recipients
      const perEvent = new Map<number, number>()
      for (const d of g) perEvent.set(d.event_id, Math.max(perEvent.get(d.event_id) ?? 0, d.count))
      const count = [...perEvent.values()].reduce((a, b) => a + b, 0)
      const p = render(first.kind, count, linkFor(this.cfg.baseUrl, first.kind, first.level), first.lang, !!first.digest)
      let error: string | null = null
      try {
        if (first.channel === 'slack') await postSlack(first.dest, p.text, this.fetchImpl)
        else {
          let text = p.text
          if (first.kind === 'audit_anchor') for (const a of this.anchorsOf([...perEvent.keys()])) text += anchorBlock(a)
          await this.mailer!.send({ to: first.dest, from: this.cfg.email.from, subject: p.subject, text })
        }
      } catch (e) { error = (e as Error).message || String(e) }
      const msg = Number(db.query('INSERT INTO notify_messages (at, channel, dest, kind, count, ok, error) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(now, first.channel, first.dest, first.kind, count, error ? 0 : 1, error).lastInsertRowid)
      const ids = g.map((d) => d.id)
      const inIds = `(${ids.map(() => '?').join(',')})`
      if (!error) {
        db.query(`UPDATE notify_deliveries SET status = 'sent', message_id = ? WHERE id IN ${inIds}`).run(msg, ...ids)
        res.sent++
      } else {
        const attempts = first.attempts + 1
        db.query(`UPDATE notify_deliveries SET attempts = attempts + 1, error = ?, due_at = ?, status = ? WHERE id IN ${inIds}`)
          .run(error, now + 30_000 * 2 ** attempts, attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', ...ids)
        res.failed++
      }
    }
    return res
  }

  private anchorsOf(eventIds: number[]): SignedAnchor[] {
    return eventIds.flatMap((id) => {
      const r = this.db.query<{ detail: string | null }, [number]>('SELECT detail FROM notify_events WHERE id = ?').get(id)
      const a = r?.detail ? (JSON.parse(r.detail) as { anchor?: SignedAnchor }).anchor : undefined
      return a ? [a] : []
    })
  }

  pendingCount(): number {
    return this.db.query<{ n: number }, []>("SELECT count(*) AS n FROM notify_deliveries WHERE status = 'pending'").get()!.n
  }
}

export interface FlushResult { sent: number; held: number; failed: number }
