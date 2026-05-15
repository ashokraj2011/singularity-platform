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
    },
  },
})
