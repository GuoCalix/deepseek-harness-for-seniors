import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react(), {
    name: 'desktop-content-security-policy',
    apply: 'build',
    transformIndexHtml() { return [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'" }, injectTo: 'head' }] },
  }],
  base: './',
  server: {
    host: '127.0.0.1',
    port: 4178,
    proxy: { '/api': 'http://127.0.0.1:4179' },
  },
})
