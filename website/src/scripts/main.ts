// Client behaviour for every page: theme toggle, mobile menu, copy button, currency/billing toggles and checkout buttons.
// No dependencies; everything degrades to static HTML without JS.
import { isPlanId, resumePaymentLink, startCheckout, type Billing, type Currency } from '../checkout'

const root = document.documentElement
const lang = root.lang === 'ko' ? 'ko' : 'en'

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

resumePaymentLink()

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
