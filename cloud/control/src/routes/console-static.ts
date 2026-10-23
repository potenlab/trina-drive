// The console's static files: the brand fonts and mark (copies made by `bun run brand:sync` under ui/brand/), the
// theme switch (run before the page paints) and the small console script. The stylesheet itself is /static/app.css,
// served by web.ts from ui/layout.ts.
import fs from 'node:fs'
import path from 'node:path'
import type { ControlRoute } from './types'

const BRAND = path.join(import.meta.dir, '..', 'ui', 'brand')

/** before the stylesheet: the saved light/dark choice (else the system's) */
export const THEME_JS = `(function(){try{var t=localStorage.getItem('trina-theme');if(t==='dark'||t==='light')document.documentElement.setAttribute('data-theme',t)}catch(e){}})()`

export const CONSOLE_JS = `(() => {
  const root = document.documentElement
  for (const b of document.querySelectorAll('[data-theme-toggle]')) b.addEventListener('click', () => {
    const dark = root.getAttribute('data-theme') ? root.getAttribute('data-theme') === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches
    const next = dark ? 'light' : 'dark'
    root.setAttribute('data-theme', next)
    try { localStorage.setItem('trina-theme', next) } catch (e) {}
  })
  // copy buttons
  for (const b of document.querySelectorAll('[data-copy]')) b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(b.getAttribute('data-copy')) } catch (e) { return }
    const old = b.getAttribute('aria-label'); b.setAttribute('aria-label', 'Copied'); b.classList.add('copied')
    const tip = document.createElement('span'); tip.className = 'copied-tip'; tip.textContent = 'Copied'; b.after(tip)
    setTimeout(() => { tip.remove(); b.setAttribute('aria-label', old || 'Copy'); b.classList.remove('copied') }, 1400)
  })
  // the SSO hand-off: post the assertion to the drive right away
  const auto = document.querySelector('form[data-autosubmit]'); if (auto) auto.submit()
  // confirmations
  for (const f of document.querySelectorAll('form[data-confirm]')) f.addEventListener('submit', (e) => { if (!confirm(f.getAttribute('data-confirm'))) e.preventDefault() })
  // a button enabled only when an input matches (type the address to delete)
  for (const i of document.querySelectorAll('input[data-match]')) {
    const btn = i.form && i.form.querySelector('button[type=submit],button:not([type])')
    const sync = () => { if (btn) btn.disabled = i.value.trim() !== i.getAttribute('data-match') }
    i.addEventListener('input', sync); sync()
  }
  // close an open menu when clicking elsewhere
  document.addEventListener('click', (e) => { for (const d of document.querySelectorAll('details[open]')) if (!d.contains(e.target)) d.removeAttribute('open') })
  // new team: the address follows the name until edited, and is checked as you type
  const name = document.querySelector('input[data-slug-source]'), slug = document.querySelector('input[data-slug-check]'), out = document.querySelector('[data-slug-status]')
  if (name && slug && out) {
    let touched = !!slug.value, timer = 0
    const suggest = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '')
    const check = () => { clearTimeout(timer); timer = setTimeout(async () => {
      const v = slug.value.trim(); if (!v) { out.textContent = ''; return }
      try {
        const r = await fetch('/api/slug?slug=' + encodeURIComponent(v), { headers: { accept: 'application/json' } }).then((x) => x.json())
        out.textContent = r.ok ? 'Available' : (r.problem || 'Not available'); out.className = 'hint ' + (r.ok ? 'ok-text' : 'err-text')
      } catch (e) {}
    }, 250) }
    name.addEventListener('input', () => { if (!touched) { slug.value = suggest(name.value); check() } })
    slug.addEventListener('input', () => { touched = true; check() })
  }
})()`

const file = (rel: string, type: string, maxAge = 86400) => {
  const p = path.join(BRAND, rel)
  return () => fs.existsSync(p) ? new Response(Bun.file(p), { headers: { 'content-type': type, 'cache-control': `public, max-age=${maxAge}` } }) : new Response('not found', { status: 404 })
}
const text = (body: string, type: string) => () => new Response(body, { headers: { 'content-type': type, 'cache-control': 'public, max-age=300' } })

export const staticRoutes: ControlRoute[] = [
  { method: 'GET', path: '/static/theme.js', fn: text(THEME_JS, 'text/javascript') },
  { method: 'GET', path: '/static/console.js', fn: text(CONSOLE_JS, 'text/javascript') },
  { method: 'GET', path: '/static/mark.svg', fn: file('mark.svg', 'image/svg+xml') },
  { method: 'GET', path: '/static/mark-dark.svg', fn: file('mark-dark.svg', 'image/svg+xml') },
  { method: 'GET', path: '/favicon.ico', fn: file('mark.svg', 'image/svg+xml') },
  { method: 'GET', path: '/static/fonts/Geist-Variable.woff2', fn: file('fonts/Geist-Variable.woff2', 'font/woff2', 31536000) },
  { method: 'GET', path: '/static/fonts/GeistMono-Variable.woff2', fn: file('fonts/GeistMono-Variable.woff2', 'font/woff2', 31536000) },
]
