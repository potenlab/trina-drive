// Notify runtime: one bus, the notifier listening on it, and the producers that live in this module (bulk-read alarm,
// original-write attempts, new MCP clients, audit anchors). attachNotify wires it into a Ctx (ctx.onCommit) and hands
// back the hook for the MCP endpoint (ServerOptions.onRequest). Other producers (reconciler: widened_draft,
// quarantine; admin API: admin_self_grant, password_reset) call runtime.bus.emit(...).
import { verifyAudit } from '../audit'
import type { Ctx, Session } from '../session'
import type { TokenRow } from '../store'
import { MSG } from '../vfs'
import { anchorKey, lastAnchor, makeAnchor, writeAnchorFile } from './anchor'
import { BulkReadMonitor } from './bulk'
import type { Mailer } from './channels'
import { loadNotifyConfig, type NotifyConfig } from './config'
import { type ClientSeen, Connections } from './connections'
import { EventBus, type ShelfEvent, type SignedAnchor } from './events'
import { Notifier } from './notifier'

export { EventBus, type ShelfEvent } from './events'
export { Notifier } from './notifier'

export interface McpRequestInfo extends ClientSeen { method: string }

export interface NotifyRuntime {
  cfg: NotifyConfig
  bus: EventBus
  notifier: Notifier
  bulk: BulkReadMonitor
  connections: Connections
  emit(e: ShelfEvent): void
  /** installed as ctx.onCommit */
  onCommit(s: Session, tool: string, outcome: string): void
  /** for ServerOptions.onRequest */
  onMcpRequest(token: TokenRow, info: McpRequestInfo): void
  flush(): ReturnType<Notifier['flush']>
  /** Sign and send out the chain head now; null when nothing changed since the last anchor (unless force). */
  anchorNow(opts?: { force?: boolean }): Promise<{ anchor: SignedAnchor; file?: string } | null>
  /** Start the flush and anchor timers (server). Returns stop. */
  start(): () => void
}

export interface AttachOptions { cfg?: Partial<NotifyConfig>; mailer?: Mailer; fetch?: typeof fetch; now?: () => number }

export function attachNotify(ctx: Ctx, opts: AttachOptions = {}): NotifyRuntime {
  const cfg = loadNotifyConfig(ctx.dataDir, opts.cfg)
  const now = opts.now ?? ctx.now
  const bus = new EventBus()
  const notifier = new Notifier({ db: ctx.db, dataDir: ctx.dataDir, cfg, now, mailer: opts.mailer, fetch: opts.fetch })
  bus.on((e) => notifier.handle(e))
  const bulk = new BulkReadMonitor(ctx.db, () => cfg.bulkRead, bus, now)
  const connections = new Connections(ctx.db, bus, () => ({ byIp: cfg.newClientByIp }), now)
  anchorKey(ctx.dataDir) // generated at first attach (init)

  const rt: NotifyRuntime = {
    cfg, bus, notifier, bulk, connections,
    emit: (e) => bus.emit(e),
    onCommit(s, _tool, _outcome) {
      const t = s.token
      if (s.notes.has(MSG.readOnly)) bus.emit({ kind: 'original_write_attempt', subjectPersonId: t.person_id, tokenId: t.id })
      let bytes = 0
      const folders = new Set<string>()
      for (const f of s.contentFiles.values()) { bytes += f.size; folders.add(f.folder) }
      bulk.record(t, { files: s.contentFiles.size, bytes, folders })
    },
    onMcpRequest(token, info) { connections.seen(token, info) },
    flush: () => notifier.flush(),
    async anchorNow(o = {}) {
      const last = lastAnchor(ctx.db)
      const v = verifyAudit(ctx.db)
      if (!o.force && v.ok && last && last.count === v.rows && last.head === v.head) return null
      const anchor = makeAnchor(ctx.db, ctx.dataDir, now())
      const file = cfg.anchor.dir ? writeAnchorFile(ctx.db, cfg.anchor.dir, anchor) : undefined
      if (cfg.anchor.email) bus.emit({ kind: 'audit_anchor', count: anchor.anchor.count, anchor, at: anchor.anchor.at })
      await notifier.flush()
      return { anchor, file }
    },
    start() {
      const timers: ReturnType<typeof setInterval>[] = []
      const flush = () => notifier.flush().catch((e) => console.error('[notify] flush failed:', e))
      timers.push(setInterval(flush, cfg.flushMs))
      if (cfg.anchor.intervalMs > 0) {
        const tick = () => {
          const last = lastAnchor(ctx.db)
          if (!last || now() - last.at >= cfg.anchor.intervalMs) rt.anchorNow().catch((e) => console.error('[notify] audit anchor failed:', e))
        }
        tick()
        timers.push(setInterval(tick, Math.min(cfg.anchor.intervalMs, 3600_000)))
      }
      for (const t of timers) (t as { unref?: () => void }).unref?.()
      return () => timers.forEach(clearInterval)
    },
  }
  ctx.onCommit = (s, tool, outcome) => rt.onCommit(s, tool, outcome)
  ctx.emit = rt.emit
  return rt
}
