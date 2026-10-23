// A setup link carries the one-time token in the fragment (#token=… ; older mails #/setup/…). Browsers never send a
// fragment to the server, so the token is in no access log or Referer. The app reads it once before the first render,
// then replaces the address (no history entry keeps it) with #/setup, where the form is pre-filled.

/** The token in a location hash, or '' (#/setup/folders is the step after setup, not a token). */
export function setupTokenFromHash(hash: string): string {
  const m = /^#(?:token=|\/setup\/)([^&/?#]+)/.exec(hash)
  if (!m) return ''
  let token = ''
  try { token = decodeURIComponent(m[1]!) } catch { return '' }
  return /^[\x21-\x7e]{16,200}$/.test(token) ? token : ''
}

/** Take the token out of the address bar: returns it ('' when there is none; then nothing is touched). */
export function takeSetupToken(loc: { hash: string; pathname: string; search: string }, history: { replaceState(data: unknown, unused: string, url: string): void }): string {
  const token = setupTokenFromHash(loc.hash)
  if (token) history.replaceState(null, '', loc.pathname + loc.search + '#/setup')
  return token
}
