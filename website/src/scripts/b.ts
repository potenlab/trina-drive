// Variant B only: the hero chat demo and the use-case role filter. Everything is in the HTML already; without this
// script the first conversation shows complete and every use case is visible.

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// ---- hero chat demo ----
const chat = document.querySelector<HTMLElement>('[data-chat]')
if (chat) {
  const convos = Array.from(chat.querySelectorAll<HTMLElement>('.cd-convo'))
  const panels = Array.from(chat.querySelectorAll<HTMLElement>('.cd-folders'))
  const users = Array.from(chat.querySelectorAll<HTMLElement>('.cd-user'))
  const tabs = Array.from(chat.querySelectorAll<HTMLButtonElement>('[data-chat-tab]'))
  const input = chat.querySelector<HTMLElement>('[data-chat-input]')!
  const ph = chat.querySelector<HTMLElement>('[data-chat-ph]')!
  const HOLD = 6500
  let run = 0
  let current = 0
  let auto = !reduceMotion
  let visible = false

  const stepsOf = (i: number) =>
    [...convos[i]!.querySelectorAll<HTMLElement>('[data-s]'), ...panels[i]!.querySelectorAll<HTMLElement>('[data-s]')]
  const maxStep = (i: number) => Math.max(...stepsOf(i).map((el) => Number(el.dataset.s)))
  const showStep = (i: number, n: number) => stepsOf(i).forEach((el) => { if (Number(el.dataset.s) <= n) el.classList.add('on') })
  const streams = convos.map((c) => Array.from(c.querySelectorAll<HTMLElement>('[data-stream]')).map((el) => [el, el.textContent ?? ''] as const))

  function select(i: number) {
    current = i
    for (const list of [convos, panels, users]) list.forEach((el, j) => { el.dataset.active = String(j === i) })
    tabs.forEach((b, j) => {
      b.setAttribute('aria-pressed', String(j === i))
      b.classList.remove('run')
    })
  }
  function reset(i: number) {
    stepsOf(i).forEach((el) => el.classList.remove('on'))
    streams[i]!.forEach(([el, text]) => { el.textContent = text })
    input.textContent = ''
    ph.hidden = false
  }
  function complete(i: number) {
    reset(i)
    showStep(i, maxStep(i))
  }

  async function play(i: number) {
    const me = ++run
    select(i)
    reset(i)
    const alive = () => me === run
    // 1. type the question into the input, then "send" it
    await sleep(400)
    const q = convos[i]!.querySelector('.cd-q p')?.textContent ?? ''
    ph.hidden = true
    for (const ch of q) {
      if (!alive()) return
      input.textContent += ch
      await sleep(18 + Math.random() * 26)
    }
    await sleep(350)
    if (!alive()) return
    input.textContent = ''
    ph.hidden = false
    showStep(i, 1)
    // 2. the AI searches the folders (files light up), then 3. streams the first line, then the rest block by block
    await sleep(500)
    if (!alive()) return
    showStep(i, 2)
    await sleep(1100)
    if (!alive()) return
    for (const [el, text] of streams[i]!) {
      el.textContent = ''
      showStep(i, 3)
      const words = text.split(' ')
      for (let w = 0; w < words.length; w++) {
        if (!alive()) return
        el.textContent = words.slice(0, w + 1).join(' ')
        await sleep(45)
      }
    }
    const last = maxStep(i)
    for (let n = 4; n <= last; n++) {
      await sleep(n === last ? 420 : 260)
      if (!alive()) return
      showStep(i, n)
    }
    await holdThenNext(i, me)
  }

  // Hold the finished answer (progress bar on the active tab), then play the next example while the demo is on screen.
  async function holdThenNext(i: number, me: number) {
    if (!auto) return
    tabs[i]?.style.setProperty('--hold', `${HOLD}ms`)
    tabs[i]?.classList.add('run')
    await sleep(HOLD)
    if (me !== run || !auto) return
    if (!visible) { pending = true; return }
    void play((i + 1) % convos.length)
  }

  let pending = false
  tabs.forEach((b, j) => b.addEventListener('click', () => {
    auto = false
    if (reduceMotion) { run++; select(j); complete(j) } else void play(j)
  }))

  if (reduceMotion) {
    select(0)
    complete(0)
  } else {
    // The first answer is already complete in the HTML (no flash, nothing to wait for); animation starts with the next.
    chat.dataset.anim = ''
    select(0)
    complete(0)
    let started = false
    const io = new IntersectionObserver((entries) => {
      visible = entries.some((e) => e.isIntersecting)
      if (visible && !started) { started = true; void holdThenNext(0, run) }
      else if (visible && pending && auto) { pending = false; void play((current + 1) % convos.length) }
    }, { threshold: 0.25 })
    io.observe(chat)
  }
}

// ---- use-case role filter ----
const uc = document.querySelector<HTMLElement>('[data-uc]')
if (uc) {
  const bar = uc.querySelector<HTMLElement>('[data-uc-filter]')
  const chips = Array.from(uc.querySelectorAll<HTMLButtonElement>('[data-uc-role]'))
  const cards = Array.from(uc.querySelectorAll<HTMLElement>('[data-uc-item]'))
  if (bar) bar.hidden = false
  chips.forEach((c) => c.addEventListener('click', () => {
    const role = c.dataset.ucRole
    chips.forEach((x) => x.setAttribute('aria-pressed', String(x === c)))
    cards.forEach((card) => { card.hidden = role !== 'all' && card.dataset.ucItem !== role })
  }))
}
