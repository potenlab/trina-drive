// The web admin app: built to web/dist and served by the same Bun server at / (src/web/server.ts).
// Dev: `bun run dev:web` proxies /api and /mcp to a running `serve` on 127.0.0.1:8787 (the Host header is kept, so the
// server's same-origin check sees the dev origin).
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { PRODUCT } from '../src/brand'

const target = process.env.TDRIVE_API ?? 'http://127.0.0.1:8787'

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), { name: 'product-name', transformIndexHtml: (html) => html.replaceAll('%PRODUCT%', PRODUCT) }],
  server: { proxy: { '/api': { target, changeOrigin: false }, '/mcp': { target, changeOrigin: false } } },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, modulePreload: { polyfill: false } },
})
