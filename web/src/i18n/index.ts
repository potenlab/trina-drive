// Screen text in English and Korean. The browser's language picks the first one; the choice in Settings (or the
// switch in the header) is kept in this browser. Korean must have every English key (TypeScript checks it).
// The text is split by feature (W0 seams), each file owned by one workstream, merged here:
//   core.ts     everything before Trina Cloud v1
//   share.ts    the share dialog, Shared with me, General access (workstream C1)
//   sso.ts      "Sign in with Trina Cloud", SSO errors, re-authentication (workstream B1)
//   console.ts  links and words about the Trina Cloud console inside the drive (workstream C1)
// A key lives in exactly one file (test/i18n-modules.test.ts); add new text to your feature's file, not to core.ts.
import { useSyncExternalStore } from 'react'
import { NAME } from '../../../src/brand'
import * as core from './core'
import * as share from './share'
import * as sso from './sso'
import * as consoleText from './console'

const en = { ...core.en, ...share.en, ...sso.en, ...consoleText.en }

export type Key = keyof typeof en

const ko: Record<Key, string> = { ...core.ko, ...share.ko, ...sso.ko, ...consoleText.ko }

export type Locale = 'en' | 'ko'
export const LOCALES: { id: Locale; label: string }[] = [{ id: 'en', label: 'English' }, { id: 'ko', label: '한국어' }]
const DICTS: Record<Locale, Record<Key, string>> = { en, ko }
const STORE_KEY = `${NAME}.locale`

function initial(): Locale {
  try { const v = localStorage.getItem(STORE_KEY); if (v === 'en' || v === 'ko') return v } catch { /* storage blocked */ }
  return (navigator.languages ?? [navigator.language]).some((l) => l?.toLowerCase().startsWith('ko')) ? 'ko' : 'en'
}

let current: Locale = initial()
const listeners = new Set<() => void>()
document.documentElement.lang = current

export function setLocale(l: Locale) {
  current = l
  document.documentElement.lang = l
  try { localStorage.setItem(STORE_KEY, l) } catch { /* ignore */ }
  listeners.forEach((f) => f())
}
export const getLocale = () => current

export function t(key: Key, params?: Record<string, string | number>): string {
  const s = DICTS[current][key] ?? en[key]
  return params ? s.replace(/\{(\w+)\}/g, (all, k: string) => (params[k] !== undefined ? String(params[k]) : all)) : s
}

/** Re-render on language change. */
export function useLocale(): Locale {
  return useSyncExternalStore((f) => { listeners.add(f); return () => { listeners.delete(f) } }, () => current)
}

export function fmtDate(ms: number | null | undefined): string {
  if (!ms) return '—'
  return new Intl.DateTimeFormat(current === 'ko' ? 'ko-KR' : 'en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms))
}
