import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// M42.6 — Code Foundry approval UI. Single-page React app served on
// :5181. Proxies /api/codegen/* through to the code-foundry-api so the
// dev flow doesn't need a separate CORS step (CORS is wired on the API
// side too, but proxying keeps the bearer-token story simple).
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5181,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.VITE_FOUNDRY_API_URL ?? 'http://localhost:3005',
        changeOrigin: true,
        // M100 P0 (2026-05-31) — inject the foundry SERVICE TOKEN server-side
        // from FOUNDRY_TOKEN env so it never lands in the browser bundle.
        // The client only sets Authorization when an OPERATOR pasted a token
        // (localStorage); for the default service path the proxy adds it here.
        // Default keeps the dev token so local flow is unchanged.
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
