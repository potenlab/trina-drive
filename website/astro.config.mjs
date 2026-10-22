// @ts-check
import { defineConfig } from 'astro/config'

// Static site. Every script and stylesheet is emitted as a file under /_astro/ (nothing inlined), so the
// Content-Security-Policy in vercel.json / public/_headers can say script-src 'self'; style-src 'self'.
export default defineConfig({
  site: 'https://drive.trina.app',
  output: 'static',
  trailingSlash: 'ignore',
  build: { format: 'file', inlineStylesheets: 'never' },
  compressHTML: true,
  devToolbar: { enabled: false },
  vite: { build: { assetsInlineLimit: 0 } },
})
