import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

function healthPlugin(): Plugin {
  return {
    name: 'blueprint-workbench-health',
    configureServer(server) {
      server.middlewares.use('/health', (_req, res) => {
        res.statusCode = 200
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({
          status: 'ok',
          service: 'blueprint-workbench',
          mode: 'dev',
          timestamp: new Date().toISOString(),
        }))
      })
    },
  }
}

export default defineConfig({
  plugins: [healthPlugin(), react()],
  server: {
    port: 5176,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/health': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      // M69 Loop Theater — proxy audit-gov so the theater view can query
      // /audit-gov/api/v1/audit/search and /audit-gov/api/v1/audit/stream/tail
      // without browser CORS hassle.
      //
      // M100 P0 (2026-05-31) — the proxy injects the audit-gov SERVICE TOKEN
      // server-side from AUDIT_GOV_TOKEN (default = the dev token), so the
      // browser bundle no longer carries any credential. The client sends a
      // same-origin /audit-gov request with no Authorization header; this
      // proxy adds it. Prod nginx does the equivalent (see Dockerfile).
      '/audit-gov': {
        target: 'http://localhost:8500',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/audit-gov/, ''),
        configure: (proxy) => {
          const token = process.env.AUDIT_GOV_TOKEN || 'dev-audit-gov-service-token'
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('authorization', `Bearer ${token}`)
          })
        },
      },
    },
  },
})
