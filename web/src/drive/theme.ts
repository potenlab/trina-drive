// Light / dark: the system preference unless the person picked one here (kept in this browser). Sets
// data-theme="light" | "dark" on <html>, which brand tokens.css reads (the website's theme.js does the same).
import { useSyncExternalStore } from 'react'
import { NAME } from '../../../src/brand'

export type ThemeChoice = 'system' | 'light' | 'dark'
const KEY = `${NAME}.theme`
const listeners = new Set<() => void>()

function stored(): ThemeChoice {
  try { const v = localStorage.getItem(KEY); if (v === 'light' || v === 'dark') return v } catch { /* storage blocked */ }
  return 'system'
}
let current: ThemeChoice = stored()

function apply(c: ThemeChoice) {
  const el = document.documentElement
  if (c === 'system') el.removeAttribute('data-theme')
  else el.setAttribute('data-theme', c)
}

/** Called once before the first render (main.tsx), so the page does not flash the other theme. */
export function initTheme() { apply(current) }

export function setTheme(c: ThemeChoice) {
  current = c
  try { if (c === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, c) } catch { /* ignore */ }
  apply(c)
  listeners.forEach((f) => f())
}

/** What is on screen now: the choice, or the system's when the choice is "system". */
export function effectiveTheme(c: ThemeChoice = current): 'light' | 'dark' {
  if (c !== 'system') return c
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function useTheme(): ThemeChoice {
  return useSyncExternalStore((f) => { listeners.add(f); return () => { listeners.delete(f) } }, () => current)
}
