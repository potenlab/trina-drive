// Runs in <head> before paint: apply the visitor's saved theme ("light" | "dark"); otherwise CSS follows the system.
try {
  var t = localStorage.getItem('theme')
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t)
} catch (e) {}
