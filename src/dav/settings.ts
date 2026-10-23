// When the WebDAV mount is on: managed storage only (it exposes managed team folders and nothing else), unless the
// operator turns it off (<PREFIX>_WEBDAV=off, or WebOptions.webdav = false).
import { ENV_PREFIX } from '../config'
import { storageSettings } from '../managed/settings'
import type { WebCtx } from '../web/http'

export function davEnabled(w: Pick<WebCtx, 'db' | 'dataDir' | 'opts'>): boolean {
  if (w.opts.webdav === false) return false
  if (/^(0|off|false|no)$/i.test(process.env[`${ENV_PREFIX}_WEBDAV`] ?? '')) return false
  return storageSettings(w.db, w.dataDir).mode === 'managed'
}

/** The address people mount (the public https address when there is one). */
export const davSecureBase = (base: string) => base.replace(/\/$/, '')

/** Loopback: a client on this very machine may speak plain http (nothing crosses a network). */
export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase()
  return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h)
}
export const isLoopbackAddr = (addr: string) => addr === '::1' || /^(::ffff:)?127\.\d+\.\d+\.\d+$/.test(addr)
