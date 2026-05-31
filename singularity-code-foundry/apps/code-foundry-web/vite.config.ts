import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// M42.6 — Code Foundry approval UI. Single-page React app served on
// :5181. Proxies /api/codegen/* through to the code-foundry-api so the
// dev flow doesn't need a separate CORS step.
//
// M100 P1 (2026-05-31) — single-origin support. When served behind the edge
// gateway the app is mounted under /foundry/ (BASE_PATH). The dev server keeps
// running under that base and the proxy key is prefix-aware so a browser
// request to /foundry/api/* is rewritten to /api/* before hitting the API.
// Default '/' keeps the standalone :5181 dev flow unchanged.
const BASE = process.env.BASE_PATH ?? '/'
const PREFIX = BASE.replace(/\/$/, '') // '' standalone, '/foundry' behind gateway

export default defineConfig({
  base: BASE,
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5181,
    strictPort: true,
    // M100 P1 — this dev server runs behind the edge gateway, which forwards
    // the gateway's Host header. Allow it so Vite doesn't 403 proxied requests.
    allowedHosts: true,
    proxy: {
      [`${PREFIX}/api`]: {
        target: process.env.VITE_FOUNDRY_API_URL ?? 'http://localhost:3005',
        changeOrigin: true,
        // Strip the single-origin prefix so the API sees /api/* unchanged.
        rewrite: (path) => (PREFIX ? path.replace(new RegExp(`^${PREFIX}`), '') : path),
        // M100 P0 (2026-05-31) — inject the foundry SERVICE TOKEN server-side
        // from FOUNDRY_TOKEN env so it never lands in the browser bundle. The
        // client only sets Authorization when an OPERATOR pasted a token
        // (localStorage); for the default service path the proxy adds it here.
        configure: (proxy) => {
          const token = process.env.FOUNDRY_TOKEN || 'dev-codegen-service-token'
          proxy.on('proxyReq', (proxyReq) => {
            // Don't clobber an operator-supplied Authorization (localStorage path).
            if (!proxyReq.getHeader('authorization')) {
              proxyReq.setHeader('authorization', `Bearer ${token}`)
            }
          })
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
})
