// Event bus: whoever notices something (session commit, MCP request, reconciler, admin API, anchor timer) emits a
// typed event; the notifier turns it into inbox rows and channel deliveries. Listeners must not throw into emitters.
export const EVENT_KINDS = [
  'widened_draft', 'original_write_attempt', 'bulk_read', 'quarantine', 'new_client',
  'admin_self_grant', 'password_reset', 'token_revoked', 'audit_anchor',
] as const
export type EventKind = (typeof EVENT_KINDS)[number]

export interface SignedAnchor {
  anchor: { v: 1; product: string; at: number; count: number; head: string; key: string }
  /** SPKI DER, base64 */
  publicKey: string
  /** Ed25519 over the canonical anchor, base64 */
  signature: string
}

/**
 * What happened. Only ids go in here (they decide recipients and feed the logged-in detail screen); names never reach
 * a channel because rendering takes only kind, count and a link (R11).
 */
export interface ShelfEvent {
  kind: EventKind
  at?: number
  /** how many items this event stands for (default 1) */
  count?: number
  /** the person concerned: token owner, reset target, the admin who granted themself something */
  subjectPersonId?: number
  tokenId?: number
  /** quarantine, admin_self_grant: the folder concerned */
  folderId?: number
  /** widened_draft: Src(d) and the folder it widened into */
  sourceFolderIds?: number[]
  targetFolderId?: number
  /** widened_draft: widened only because of weak provenance (→ daily digest) */
  weakOnly?: boolean
  /** audit_anchor */
  anchor?: SignedAnchor
  /** anything else for the detail screen (stored, never rendered into a channel) */
  detail?: Record<string, unknown>
}

export type Listener = (e: ShelfEvent & { id?: number }) => void

export class EventBus {
  private readonly listeners = new Set<Listener>()
  on(l: Listener): () => void { this.listeners.add(l); return () => this.listeners.delete(l) }
  emit(e: ShelfEvent) {
    for (const l of this.listeners) {
      try { l(e) } catch (err) { console.error(`[notify] listener failed for ${e.kind}:`, err) }
    }
  }
}
