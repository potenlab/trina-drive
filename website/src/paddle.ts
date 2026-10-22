// Paddle Billing configuration and checkout item resolution. Pure functions only (no DOM, no import.meta.env), so
// they run in `bun test` and at build time. The values come from build-time env vars (see src/paddle-env.ts and
// .env.example). Price IDs and the client-side token are public by design; never put an API key here.

export type Billing = 'monthly' | 'yearly'
export type PaidPlan = 'team' | 'business'

export interface PaddleConfig {
  token: string
  environment: 'sandbox' | 'production'
  prices: Record<PaidPlan, Record<Billing, string | undefined>>
  seats: Record<PaidPlan, Record<Billing, string | undefined>>
}

export interface PaddleEnv {
  PUBLIC_PADDLE_CLIENT_TOKEN?: string
  PUBLIC_PADDLE_ENV?: string
  PUBLIC_PADDLE_PRICE_TEAM_MONTHLY?: string
  PUBLIC_PADDLE_PRICE_TEAM_YEARLY?: string
  PUBLIC_PADDLE_PRICE_BUSINESS_MONTHLY?: string
  PUBLIC_PADDLE_PRICE_BUSINESS_YEARLY?: string
  PUBLIC_PADDLE_PRICE_EXTRA_SEAT_TEAM?: string
  PUBLIC_PADDLE_PRICE_EXTRA_SEAT_BUSINESS?: string
  PUBLIC_PADDLE_PRICE_EXTRA_SEAT_TEAM_YEARLY?: string
  PUBLIC_PADDLE_PRICE_EXTRA_SEAT_BUSINESS_YEARLY?: string
}

/** AI-connected people included in each managed plan (PRICING.md). */
export const INCLUDED_SEATS: Record<PaidPlan, number> = { team: 10, business: 40 }

export const PADDLE_JS_URL = 'https://cdn.paddle.com/paddle/v2/paddle.js'

export const isPaidPlan = (v: string): v is PaidPlan => v === 'team' || v === 'business'

const clean = (v: string | undefined): string | undefined => {
  const s = (v ?? '').trim()
  return s ? s : undefined
}
const priceId = (v: string | undefined): string | undefined => {
  const s = clean(v)
  return s && /^pri_[a-z0-9_]+$/i.test(s) ? s : undefined
}

/**
 * Builds the config from env. Returns null (→ mailto fallback everywhere) unless there is a client token and at
 * least one plan price. A missing price for one plan/cycle only disables that one button.
 */
export function readPaddleConfig(env: PaddleEnv): PaddleConfig | null {
  const token = clean(env.PUBLIC_PADDLE_CLIENT_TOKEN)
  if (!token || !/^(test|live)_[A-Za-z0-9]+$/.test(token)) return null
  const environment = clean(env.PUBLIC_PADDLE_ENV) === 'production' ? 'production' : 'sandbox'
  // A live_ token only works in production and a test_ token only in sandbox: refuse a mismatch rather than open a
  // checkout that fails.
  if ((environment === 'production') !== token.startsWith('live_')) return null
  const cfg: PaddleConfig = {
    token,
    environment,
    prices: {
      team: { monthly: priceId(env.PUBLIC_PADDLE_PRICE_TEAM_MONTHLY), yearly: priceId(env.PUBLIC_PADDLE_PRICE_TEAM_YEARLY) },
      business: { monthly: priceId(env.PUBLIC_PADDLE_PRICE_BUSINESS_MONTHLY), yearly: priceId(env.PUBLIC_PADDLE_PRICE_BUSINESS_YEARLY) },
    },
    seats: {
      team: { monthly: priceId(env.PUBLIC_PADDLE_PRICE_EXTRA_SEAT_TEAM), yearly: priceId(env.PUBLIC_PADDLE_PRICE_EXTRA_SEAT_TEAM_YEARLY) },
      business: { monthly: priceId(env.PUBLIC_PADDLE_PRICE_EXTRA_SEAT_BUSINESS), yearly: priceId(env.PUBLIC_PADDLE_PRICE_EXTRA_SEAT_BUSINESS_YEARLY) },
    },
  }
  const anyPlan = Object.values(cfg.prices).some((p) => p.monthly || p.yearly)
  return anyPlan ? cfg : null
}

/** True when this plan can be bought online in at least one billing cycle. */
export const canSellOnline = (cfg: PaddleConfig | null, plan: string): boolean =>
  !!cfg && isPaidPlan(plan) && !!(cfg.prices[plan].monthly || cfg.prices[plan].yearly)

/** Extra seats beyond what the plan includes, from the number of AI-connected people the buyer entered. */
export function extraSeatsFor(plan: PaidPlan, people: number | undefined): number {
  const n = Math.floor(Number(people))
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.max(0, Math.min(n, 10_000) - INCLUDED_SEATS[plan])
}

/**
 * Paddle checkout items for a plan, or null when this combination cannot be sold online (missing price id, or
 * extra seats asked for but no seat price in the same billing cycle — Paddle needs one cycle per checkout).
 */
export function checkoutItems(
  cfg: PaddleConfig | null,
  plan: string,
  billing: Billing,
  extraSeats = 0,
): { priceId: string; quantity: number }[] | null {
  if (!cfg || !isPaidPlan(plan)) return null
  const base = cfg.prices[plan][billing]
  if (!base) return null
  const items = [{ priceId: base, quantity: 1 }]
  const extra = Math.max(0, Math.floor(extraSeats) || 0)
  if (extra > 0) {
    const seat = cfg.seats[plan][billing]
    if (!seat) return null
    items.push({ priceId: seat, quantity: extra })
  }
  return items
}
