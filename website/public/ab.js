// A/B measurement with Vercel Web Analytics custom events: one "ab_view" per page view and "cta_click" per primary
// button click, both tagged with the variant (set on <html data-variant> by the page). No cookies of our own beyond
// the variant cookie the middleware sets; no personal data in events.
(function () {
  window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments) }
  var variant = document.documentElement.dataset.variant
  if (!variant) return
  window.va('event', { name: 'ab_view', data: { variant: variant } })
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest && e.target.closest('[data-cta],[data-plan]')
    if (!el) return
    var cta = el.getAttribute('data-cta') || ('checkout-' + el.getAttribute('data-plan'))
    window.va('event', { name: 'cta_click', data: { variant: variant, cta: cta } })
  }, true)
})()
