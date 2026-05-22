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
      // without browser CORS hassle. In dev the bearer token defaults to
      // the dev-audit-gov-service-token used by every other service.
      // Production deployments should replace this proxy with a thin
      // workgraph-api passthrough that holds the token server-side.
      '/audit-gov': {
        target: 'http://localhost:8500',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/audit-gov/, ''),
      },
    },
  },
})
