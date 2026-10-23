// The one entry point for buying a plan. Every pricing button calls startCheckout(planId, options).
//
// Routing (decision: research/trina-drive/payments/README.md):
//   - Team/Business, Paddle configured at build time → Paddle overlay checkout (Paddle.com is Merchant of Record) in
//     both currencies: Korean cards are charged in KRW through the prices' KR overrides. Paddle.js is loaded from
//     cdn.paddle.com only when a price button is clicked.
//   - Setup & migration                                 → email (a human service, quoted; not sold through a MoR).
//   - Anything else, or Paddle not configured / blocked → email (the original mailto flow).
// The CSP in vercel.json and public/_headers allows Paddle's origins.

import { PADDLE } from './paddle-env'
import { PADDLE_JS_URL, checkoutItems, extraSeatsFor, isPaidPlan, type Billing, type PaddleConfig } from './paddle'
import { CONTACT_EMAIL } from './site'

export type PlanId = 'community' | 'team' | 'business' | 'setup'
export type Currency = 'USD' | 'KRW'
export type { Billing }

export interface CheckoutOptions {
  currency: Currency
  lang: 'en' | 'ko'
  /** Default monthly. */
  billing?: Billing
  /** AI-connected people the buyer entered on the card (seats beyond the plan's included ones are added). */
  people?: number
}

export const PLAN_IDS: readonly PlanId[] = ['community', 'team', 'business', 'setup']

export const isPlanId = (v: unknown): v is PlanId => typeof v === 'string' && (PLAN_IDS as readonly string[]).includes(v)

const PLAN_NAMES: Record<PlanId, { en: string; ko: string }> = {
  community: { en: 'Community (self-hosted)', ko: '커뮤니티 (설치형)' },
  team: { en: 'Team (managed)', ko: '팀 (관리형)' },
  business: { en: 'Business (managed)', ko: '비즈니스 (관리형)' },
  setup: { en: 'Setup & migration', ko: '설치·이전' },
}

export function checkoutMailto(planId: PlanId, { currency, lang, billing = 'monthly', people }: CheckoutOptions): string {
  const plan = PLAN_NAMES[planId][lang]
  const managed = isPaidPlan(planId)
  const cycle = lang === 'ko' ? (billing === 'yearly' ? '연 결제' : '월 결제') : billing === 'yearly' ? 'yearly' : 'monthly'
  const n = people && people > 0 ? String(Math.floor(people)) : ''
  const subject = lang === 'ko'
    ? `Trina Drive ${plan} 신청`
    : `Trina Drive ${plan}`
  const lines = lang === 'ko'
    ? [
        `플랜: ${plan}`,
        ...(managed ? [`결제 주기: ${cycle}`] : []),
        `통화: ${currency}`,
        '회사 이름:',
        `인원(AI를 연결할 사람 수): ${n}`,
        'NAS 또는 맥 미니 유무:',
      ]
    : [
        `Plan: ${plan}`,
        ...(managed ? [`Billing: ${cycle}`] : []),
        `Currency: ${currency}`,
        'Company:',
        `AI-connected people: ${n}`,
        'NAS or Mac mini in the office:',
      ]
  return `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join('\n') + '\n')}`
}

// ---- Paddle.js (loaded on demand) ----

interface PaddleEvent { name?: string; data?: unknown }
interface PaddleJs {
  Environment: { set(env: 'sandbox'): void }
  Initialize(opts: object): void
  Checkout: { open(opts: object): void }
}
declare global { interface Window { Paddle?: PaddleJs } }

let paddleReady: Promise<PaddleJs> | null = null

function loadPaddle(cfg: PaddleConfig): Promise<PaddleJs> {
  paddleReady ??= new Promise<PaddleJs>((resolve, reject) => {
    const init = () => {
      const P = window.Paddle
      if (!P) return reject(new Error('Paddle.js did not load'))
      if (cfg.environment === 'sandbox') P.Environment.set('sandbox')
      P.Initialize({
        token: cfg.token,
        checkout: { settings: { displayMode: 'overlay', showAddTaxId: true, allowLogout: false } },
        eventCallback(e: PaddleEvent) {
          // The server webhook is the source of truth for payments; these events are for the page only.
          const map: Record<string, string> = {
            'checkout.completed': 'trina:checkout-completed',
            'checkout.closed': 'trina:checkout-closed',
            'checkout.payment.failed': 'trina:checkout-error',
            'checkout.error': 'trina:checkout-error',
          }
          const name = e?.name && map[e.name]
          if (name) window.dispatchEvent(new CustomEvent(name, { detail: e.data }))
        },
      })
      resolve(P)
    }
    if (window.Paddle) return init()
    const s = document.createElement('script')
    s.src = PADDLE_JS_URL
    s.async = true
    s.onload = init
    s.onerror = () => reject(new Error('Paddle.js blocked or offline'))
    document.head.appendChild(s)
  }).catch((err) => {
    paddleReady = null // let a later click try again
    throw err
  })
  return paddleReady
}

const prefersDark = () =>
  document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : window.matchMedia('(prefers-color-scheme: dark)').matches

/** Whether this click would open the Paddle checkout (vs. email). */
export function usesPaddle(planId: PlanId, { billing = 'monthly', people }: CheckoutOptions): boolean {
  if (!isPaidPlan(planId)) return false
  return !!checkoutItems(PADDLE, planId, billing, extraSeatsFor(planId, people))
}

export async function startCheckout(planId: PlanId, options: CheckoutOptions): Promise<void> {
  const { lang, billing = 'monthly', people } = options
  if (!usesPaddle(planId, options) || !PADDLE || !isPaidPlan(planId)) {
    window.location.href = checkoutMailto(planId, options)
    return
  }
  const extra = extraSeatsFor(planId, people)
  const items = checkoutItems(PADDLE, planId, billing, extra)!
  let paddle: PaddleJs
  try {
    paddle = await loadPaddle(PADDLE)
  } catch {
    window.location.href = checkoutMailto(planId, options)
    return
  }
  const thanks = new URL(lang === 'ko' ? '/ko/thanks' : '/thanks', window.location.origin)
  thanks.searchParams.set('plan', `${planId}-${billing}`)
  paddle.Checkout.open({
    items,
    customData: {
      plan_id: `${planId}-${billing}`,
      extra_seats: String(extra),
      lang,
      source: window.location.hostname,
    },
    settings: {
      displayMode: 'overlay',
      locale: lang,
      theme: prefersDark() ? 'dark' : 'light',
      showAddTaxId: true,
      successUrl: thanks.href,
    },
  })
}

/**
 * Paddle "payment links" (invoices, the dashboard's default payment link) send buyers to this site with
 * ?_ptxn=txn_…; Paddle.js opens that checkout by itself once initialized. Only then is Paddle.js loaded on page view.
 */
export function resumePaymentLink(): void {
  if (!PADDLE || !/^txn_[a-z0-9]+$/i.test(new URLSearchParams(window.location.search).get('_ptxn') ?? '')) return
  void loadPaddle(PADDLE).catch(() => { /* blocked: the buyer can still use the emailed link to pay at paddle.net */ })
}
