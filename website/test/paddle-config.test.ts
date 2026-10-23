import { describe, expect, test } from 'bun:test'
import { canSellOnline, checkoutItems, extraSeatsFor, readPaddleConfig } from '../src/paddle'
import { checkoutMailto, usesPaddle } from '../src/checkout'
import { CLOUD_LIVE, earlyAccessMailto } from '../src/site'

const full = {
  PUBLIC_PADDLE_CLIENT_TOKEN: 'test_abc123',
  PUBLIC_PADDLE_ENV: 'sandbox',
  PUBLIC_PADDLE_PRICE_TEAM_MONTHLY: 'pri_team_m',
  PUBLIC_PADDLE_PRICE_TEAM_YEARLY: 'pri_team_y',
  PUBLIC_PADDLE_PRICE_BUSINESS_MONTHLY: 'pri_biz_m',
  PUBLIC_PADDLE_PRICE_BUSINESS_YEARLY: 'pri_biz_y',
  PUBLIC_PADDLE_PRICE_EXTRA_SEAT_TEAM: 'pri_seat_team_m',
  PUBLIC_PADDLE_PRICE_EXTRA_SEAT_BUSINESS: 'pri_seat_biz_m',
}

describe('readPaddleConfig', () => {
  test('no token → null (mailto fallback)', () => {
    expect(readPaddleConfig({})).toBeNull()
    expect(readPaddleConfig({ ...full, PUBLIC_PADDLE_CLIENT_TOKEN: '' })).toBeNull()
  })
  test('token but no plan price → null', () => {
    expect(readPaddleConfig({ PUBLIC_PADDLE_CLIENT_TOKEN: 'test_abc' })).toBeNull()
  })
  test('token/environment mismatch → null', () => {
    expect(readPaddleConfig({ ...full, PUBLIC_PADDLE_ENV: 'production' })).toBeNull()
    expect(readPaddleConfig({ ...full, PUBLIC_PADDLE_CLIENT_TOKEN: 'live_abc', PUBLIC_PADDLE_ENV: 'sandbox' })).toBeNull()
  })
  test('live token + production', () => {
    const cfg = readPaddleConfig({ ...full, PUBLIC_PADDLE_CLIENT_TOKEN: 'live_abc', PUBLIC_PADDLE_ENV: 'production' })
    expect(cfg?.environment).toBe('production')
  })
  test('malformed price ids are ignored', () => {
    const cfg = readPaddleConfig({ ...full, PUBLIC_PADDLE_PRICE_TEAM_YEARLY: 'REPLACE_ME' })
    expect(cfg?.prices.team.yearly).toBeUndefined()
    expect(canSellOnline(cfg, 'team')).toBe(true)
  })
})

describe('checkoutItems', () => {
  const cfg = readPaddleConfig(full)
  test('base plan only', () => {
    expect(checkoutItems(cfg, 'team', 'monthly')).toEqual([{ priceId: 'pri_team_m', quantity: 1 }])
    expect(checkoutItems(cfg, 'business', 'yearly')).toEqual([{ priceId: 'pri_biz_y', quantity: 1 }])
  })
  test('extra seats in the same cycle', () => {
    expect(checkoutItems(cfg, 'team', 'monthly', 3)).toEqual([
      { priceId: 'pri_team_m', quantity: 1 },
      { priceId: 'pri_seat_team_m', quantity: 3 },
    ])
  })
  test('extra seats without a seat price for that cycle → null (cannot mix cycles)', () => {
    expect(checkoutItems(cfg, 'team', 'yearly', 2)).toBeNull()
  })
  test('setup and community are never sold online', () => {
    expect(checkoutItems(cfg, 'setup', 'monthly')).toBeNull()
    expect(checkoutItems(cfg, 'community', 'monthly')).toBeNull()
    expect(canSellOnline(cfg, 'setup')).toBe(false)
  })
  test('no config → null', () => {
    expect(checkoutItems(null, 'team', 'monthly')).toBeNull()
  })
})

test('extraSeatsFor counts people beyond the included seats', () => {
  expect(extraSeatsFor('team', 10)).toBe(0)
  expect(extraSeatsFor('team', 13)).toBe(3)
  expect(extraSeatsFor('business', 41)).toBe(1)
  expect(extraSeatsFor('team', Number.NaN)).toBe(0)
  expect(extraSeatsFor('team', -5)).toBe(0)
})

describe('checkoutMailto', () => {
  const body = (url: string) => decodeURIComponent(url.split('body=')[1] ?? '')
  const subject = (url: string) => decodeURIComponent(url.split('subject=')[1]?.split('&')[0] ?? '')
  test('KRW fallback (Paddle not configured) is a plain request, no bank transfer', () => {
    const url = checkoutMailto('team', { currency: 'KRW', lang: 'ko', billing: 'yearly', people: 12 })
    expect(url.startsWith('mailto:contact@trina.app?')).toBe(true)
    expect(subject(url)).toBe('Trina Drive 클라우드 팀 신청')
    expect(body(url)).not.toContain('계좌이체')
    expect(body(url)).toContain('결제 주기: 연 결제')
    expect(body(url)).toContain('인원(AI를 연결할 사람 수): 12')
  })
  test('on-site install stays a plain request and asks about the office hardware', () => {
    const url = checkoutMailto('setup', { currency: 'USD', lang: 'en' })
    expect(subject(url)).toBe('Trina Drive On-site install')
    expect(body(url)).not.toContain('Billing:')
    expect(body(url)).toContain('NAS or Mac mini in the office:')
  })
  test('cloud plans do not ask about a NAS or Mac mini', () => {
    expect(body(checkoutMailto('team', { currency: 'USD', lang: 'en' }))).not.toContain('NAS or Mac mini')
  })
})

describe('Trina Cloud early access (CLOUD_LIVE)', () => {
  test('while the cloud is not live, no plan opens the Paddle checkout', () => {
    if (CLOUD_LIVE) return
    for (const id of ['team', 'business', 'setup', 'community'] as const) {
      expect(usesPaddle(id, { currency: 'USD', lang: 'en' })).toBe(false)
    }
  })
  test('early-access email names the plan when there is one', () => {
    const url = earlyAccessMailto('en', 'Cloud Team')
    expect(url.startsWith('mailto:contact@trina.app?')).toBe(true)
    expect(decodeURIComponent(url.split('subject=')[1]!.split('&')[0]!)).toBe('Trina Cloud early access')
    expect(decodeURIComponent(url.split('body=')[1]!)).toContain('Plan: Cloud Team')
    expect(decodeURIComponent(earlyAccessMailto('en').split('body=')[1]!)).not.toContain('Plan:')
  })
})
