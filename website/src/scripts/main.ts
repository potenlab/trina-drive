// Client behaviour for every page: theme toggle, mobile menu, copy button, currency/billing toggles, checkout buttons,
// and the hero terminal replay. No dependencies; everything degrades to static HTML without JS.
import { isPlanId, startCheckout, type Billing, type Currency } from '../checkout'

const root = document.documentElement
const lang = root.lang === 'ko' ? 'ko' : 'en'
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

// ---- theme ----
const isDark = () =>
  root.dataset.theme ? root.dataset.theme === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches
document.querySelectorAll<HTMLButtonElement>('[data-theme-toggle]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const next = isDark() ? 'light' : 'dark'
    root.dataset.theme = next
    try { localStorage.setItem('theme', next) } catch { /* private mode */ }
  })
})

// ---- mobile menu ----
const menuBtn = document.querySelector<HTMLButtonElement>('[data-menu-toggle]')
const menu = document.getElementById('mobile-menu')
if (menuBtn && menu) {
  const set = (open: boolean) => { menu.dataset.open = String(open); menuBtn.setAttribute('aria-expanded', String(open)) }
  menuBtn.addEventListener('click', () => set(menu.dataset.open !== 'true'))
  menu.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('a')) set(false) })
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menu.dataset.open === 'true') { set(false); menuBtn.focus() } })
}

// ---- copy ----
document.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((btn) => {
  const label = btn.textContent ?? ''
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(btn.dataset.copy ?? '')
      btn.textContent = btn.dataset.copied ?? label
      setTimeout(() => { btn.textContent = label }, 1600)
    } catch { /* clipboard blocked: the text is visible next to the button */ }
  })
})

// ---- pricing currency / billing + checkout ----
const pricing = document.querySelector<HTMLElement>('[data-pricing]')
const currency = (): Currency => (pricing?.dataset.currency === 'KRW' ? 'KRW' : 'USD')
const billing = (): Billing => (pricing?.dataset.billing === 'yearly' ? 'yearly' : 'monthly')
// One segmented toggle → one data-* attribute on the pricing section, remembered per browser.
function toggle(attr: 'currency' | 'billing', values: readonly string[]) {
  if (!pricing) return
  const btnAttr = attr === 'currency' ? 'currencyBtn' : 'billingBtn'
  const buttons = pricing.querySelectorAll<HTMLButtonElement>(`[data-${attr}-btn]`)
  const apply = (v: string) => {
    pricing.dataset[attr] = v
    buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset[btnAttr] === v)))
  }
  try {
    const saved = localStorage.getItem(attr)
    if (saved && values.includes(saved)) apply(saved)
  } catch { /* ignore */ }
  buttons.forEach((b) => b.addEventListener('click', () => {
    const v = b.dataset[btnAttr] ?? ''
    if (!values.includes(v)) return
    apply(v)
    try { localStorage.setItem(attr, v) } catch { /* ignore */ }
  }))
}
toggle('currency', ['USD', 'KRW'])
toggle('billing', ['monthly', 'yearly'])

document.querySelectorAll<HTMLButtonElement>('[data-plan]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const id = btn.dataset.plan
    if (!isPlanId(id) || btn.getAttribute('aria-busy') === 'true') return
    const seats = document.querySelector<HTMLInputElement>(`[data-seats="${id}"]`)
    const people = seats ? Number(seats.value) : undefined
    btn.setAttribute('aria-busy', 'true')
    try {
      await startCheckout(id, { currency: currency(), billing: billing(), lang, people })
    } finally {
      btn.removeAttribute('aria-busy')
    }
  })
})

// ---- hero terminal ----
const term = document.querySelector<HTMLElement>('[data-term]')
if (term) {
  const lines = Array.from(term.querySelectorAll<HTMLElement>('.tl'))
  const tabs = term.querySelectorAll<HTMLElement>('[data-tab]')
  const replay = term.querySelector<HTMLButtonElement>('[data-term-replay]')
  const full = lines.map((l) => l.querySelector('.tl-text')?.textContent ?? '')
  const caret = document.createElement('span')
  caret.className = 'caret'
  let run = 0
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const setTab = (who?: string) => {
    if (who) tabs.forEach((t) => { t.dataset.active = String(t.dataset.tab === who) })
  }
  const showAll = () => {
    lines.forEach((l, i) => { l.dataset.hidden = 'false'; const x = l.querySelector('.tl-text'); if (x) x.textContent = full[i] ?? '' })
    caret.remove()
  }

  async function play() {
    const me = ++run
    if (replay) replay.hidden = true
    lines.forEach((l) => { l.dataset.hidden = 'true' })
    setTab('kim')
    for (let i = 0; i < lines.length; i++) {
      if (me !== run) return
      const line = lines[i]!
      const text = line.querySelector<HTMLElement>('.tl-text')!
      const kind = line.dataset.k
      setTab(line.dataset.who)
      line.dataset.hidden = 'false'
      if (kind === 'cmd') {
        text.textContent = ''
        text.after(caret)
        await sleep(350)
        for (const ch of full[i] ?? '') {
          if (me !== run) return
          text.textContent += ch
          await sleep(22 + Math.random() * 30)
        }
        await sleep(380)
        caret.remove()
      } else {
        text.textContent = full[i] ?? ''
        await sleep(kind === 'comment' ? 500 : 260)
      }
    }
    if (replay) replay.hidden = false
  }

  if (reduceMotion) {
    showAll()
    setTab('boss')
  } else {
    // Start when the terminal is on screen (it is, on desktop; on phones it is below the fold).
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { io.disconnect(); void play() }
    }, { threshold: 0.3 })
    io.observe(term)
    replay?.addEventListener('click', () => { void play() })
  }
}
