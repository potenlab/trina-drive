// Paddle Billing webhooks for the control plane (a second notification destination next to the website's
// /api/paddle-webhook, which keeps alerting and its own log). Same rules as website/api/_lib/paddle-webhook-core.js:
// verify `Paddle-Signature: ts=…;h1=…` (HMAC-SHA256 over `${ts}:${rawBody}`) before parsing, at-least-once delivery
// (dedupe by event_id), no ordering (compare occurred_at), answer 200 within 5 s (provisioning runs as a job).
import crypto from 'node:crypto'

export const PADDLE_IPS = {
  sandbox: ['34.194.127.46', '54.234.237.108', '3.208.120.145', '44.226.236.210', '44.241.183.62', '100.20.172.113'],
  live: ['34.232.58.13', '34.195.105.136', '34.237.3.244', '35.155.119.135', '52.11.166.252', '34.212.5.7'],
}

export function parseSignature(header: string | null): { ts: string | null; h1: string[] } {
  const out = { ts: null as string | null, h1: [] as string[] }
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim()
    if (k === 'ts') out.ts = v
    else if (k === 'h1') out.h1.push(v)
  }
  return out
}

export const signPaddle = (secret: string, ts: number | string, rawBody: string) =>
  crypto.createHmac('sha256', secret).update(`${ts}:${rawBody}`).digest('hex')

/** The header a test (or the dev simulator) sends. */
export const paddleHeader = (secret: string, rawBody: string, tsSec = Math.floor(Date.now() / 1000)) => `ts=${tsSec};h1=${signPaddle(secret, tsSec, rawBody)}`

export function verifyPaddle(o: { rawBody: string; header: string | null; secret: string; nowSec?: number; toleranceSec?: number }): { ok: true } | { ok: false; reason: string } {
  if (!o.secret) return { ok: false, reason: 'no_secret_configured' }
  const { ts, h1 } = parseSignature(o.header)
  if (!ts || !h1.length || !/^\d+$/.test(ts)) return { ok: false, reason: 'malformed_header' }
  if (Math.abs((o.nowSec ?? Date.now() / 1000) - Number(ts)) > (o.toleranceSec ?? 5)) return { ok: false, reason: 'timestamp_out_of_tolerance' }
  const expected = Buffer.from(signPaddle(o.secret, ts, o.rawBody))
  return h1.some((s) => { const b = Buffer.from(s); return b.length === expected.length && crypto.timingSafeEqual(b, expected) }) ? { ok: true } : { ok: false, reason: 'bad_signature' }
}

export interface PaddleEvent {
  event_id: string
  event_type: string
  occurred_at: string
  data: {
    id?: string
    status?: string
    customer_id?: string
    subscription_id?: string
    items?: { price?: { id?: string }; price_id?: string; quantity?: number }[]
    custom_data?: Record<string, unknown> | null
    scheduled_change?: unknown
  }
}

/** What the control plane needs from an event. */
export function summarize(e: PaddleEvent) {
  const d = e.data ?? {}
  const isSub = e.event_type.startsWith('subscription.')
  return {
    eventId: e.event_id,
    type: e.event_type,
    occurredAt: e.occurred_at,
    subscriptionId: (isSub ? d.id : d.subscription_id) ?? null,
    customerId: d.customer_id ?? null,
    status: d.status ?? null,
    priceIds: (d.items ?? []).map((i) => i.price?.id ?? i.price_id).filter((x): x is string => !!x),
    teamPublicId: typeof d.custom_data?.tdcloud_team === 'string' ? d.custom_data.tdcloud_team : null,
  }
}
export type EventSummary = ReturnType<typeof summarize>
