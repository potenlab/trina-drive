import { describe, expect, test } from 'bun:test'
import { canSellOnline, checkoutItems, extraSeatsFor, readPaddleConfig } from '../src/paddle'
import { checkoutMailto } from '../src/checkout'

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
    expect(subject(url)).toBe('Trina Drive 팀 (관리형) 신청')
    expect(body(url)).not.toContain('계좌이체')
    expect(body(url)).toContain('결제 주기: 연 결제')
    expect(body(url)).toContain('인원(AI를 연결할 사람 수): 12')
  })
  test('setup stays a plain request', () => {
    const url = checkoutMailto('setup', { currency: 'USD', lang: 'en' })
    expect(subject(url)).toBe('Trina Drive Setup & migration')
    expect(body(url)).not.toContain('Billing:')
  })
})
