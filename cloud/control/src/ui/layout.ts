// The console's page frame and stylesheet, moved unchanged from web.ts (W0 seams) so the console redesign (workstream
// D1: layout, brand tokens from ./tokens.css, fonts) changes ui/** and not web.ts.

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export function page(title: string, body: string, opts: { paddle?: boolean; turnstile?: boolean; wake?: boolean } = {}) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Trina Cloud</title><link rel="stylesheet" href="/static/app.css">${opts.paddle ? '<script src="https://cdn.paddle.com/paddle/v2/paddle.js"></script><script src="/static/checkout.js" defer></script>' : ''}${opts.turnstile ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' : ''}${opts.wake ? '<script src="/static/wake.js" defer></script>' : ''}</head>
<body><main><p class="brand"><a href="/">Trina Cloud</a></p>${body}</main></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
}

export const CSS = `:root{color-scheme:light dark;--ink:#0a0b0d;--paper:#fbfaf7;--accent:#ff5b1f;--muted:#6b6f76;--line:#e3e1dc}
@media (prefers-color-scheme:dark){:root{--ink:#f2f1ee;--paper:#111214;--muted:#a2a5ab;--line:#2a2c30}}
body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 system-ui,sans-serif}main{max-width:640px;margin:0 auto;padding:32px 16px}
.brand a{font-weight:700;color:var(--ink);text-decoration:none}h1{font-size:28px;margin:16px 0}label{display:block;margin:12px 0}
input,select{display:block;width:100%;box-sizing:border-box;padding:10px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit;font:inherit}
button,.btn{display:inline-block;padding:10px 16px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer;text-decoration:none}
button.plain{background:transparent;color:var(--ink);border:1px solid var(--line)}.muted{color:var(--muted)}.err{color:#d12}.card{border:1px solid var(--line);border-radius:12px;padding:16px;margin:16px 0}
code{font-family:ui-monospace,monospace}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}`
