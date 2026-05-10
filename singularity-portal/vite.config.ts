import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

// During dev, the SPA hits same-origin paths under /api/* and Vite proxies to
// the appropriate backend. This avoids CORS while we build v0. Production
// deployments should put nginx/Cloudflare in front with the same path map.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    // Port comes from PORT env var (set by the harness in dev).
    // Falls back to 5180 in normal `npm run dev` via package.json scripts.
    proxy: {
      // Singularity IAM
      '/api/iam': {
        target: 'http://localhost:8100',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/iam/, '/api/v1'),
      },
      // Workgraph studio API
      '/api/wg': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/wg/, '/api'),
      },
      // Prompt composer
      '/api/composer': {
        target: 'http://localhost:3004',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/composer/, '/api/v1'),
      },
      // Context-fabric (no auth, no /api/v1 prefix)
      '/api/cf': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/cf/, ''),
      },
      // Agent-runtime / agent-service / tool-service (rare; mostly for debug)
      '/api/runtime': {
        target: 'http://localhost:3003',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/runtime/, '/api/v1'),
      },
    },
  },
})
