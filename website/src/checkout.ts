// The one entry point for buying a plan. Every pricing button calls startCheckout(planId, options).
//
// TODO(payments): today this opens an email to contact@trina.app. To wire a payment provider (Toss Payments,
// Stripe, Paddle …), replace the body of startCheckout — keep its signature, the PlanId values and the
// data-plan attributes on the buttons (src/components/Pricing.astro) as they are. Remember to allow the provider's
// origin in the Content-Security-Policy (vercel.json and public/_headers: script-src / connect-src / frame-src).

import { CONTACT_EMAIL } from './site'

export type PlanId = 'community' | 'team' | 'business' | 'setup'
export type Currency = 'USD' | 'KRW'

export interface CheckoutOptions {
  currency: Currency
  lang: 'en' | 'ko'
}

export const PLAN_IDS: readonly PlanId[] = ['community', 'team', 'business', 'setup']

export const isPlanId = (v: unknown): v is PlanId => typeof v === 'string' && (PLAN_IDS as readonly string[]).includes(v)

const PLAN_NAMES: Record<PlanId, { en: string; ko: string }> = {
  community: { en: 'Community (self-hosted)', ko: '커뮤니티 (설치형)' },
  team: { en: 'Team (managed)', ko: '팀 (관리형)' },
  business: { en: 'Business (managed)', ko: '비즈니스 (관리형)' },
  setup: { en: 'Setup & migration', ko: '설치·이전' },
}

export function checkoutMailto(planId: PlanId, { currency, lang }: CheckoutOptions): string {
  const plan = PLAN_NAMES[planId][lang]
  const subject = lang === 'ko' ? `Trina Drive ${plan} 신청` : `Trina Drive ${plan}`
  const body = lang === 'ko'
    ? `플랜: ${plan}\n통화: ${currency}\n회사 이름:\n인원(AI를 연결할 사람 수):\nNAS 또는 맥 미니 유무:\n`
    : `Plan: ${plan}\nCurrency: ${currency}\nCompany:\nAI-connected people:\nNAS or Mac mini in the office:\n`
  return `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}

export function startCheckout(planId: PlanId, options: CheckoutOptions): void {
  window.location.href = checkoutMailto(planId, options)
}
