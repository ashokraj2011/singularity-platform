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
      '/ops-health/iam': {
        target: 'http://localhost:8100',
        changeOrigin: true,
        rewrite: () => '/api/v1/health',
      },
      '/ops-health/workgraph-api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        rewrite: () => '/health',
      },
      '/ops-health/blueprint-workbench': {
        target: 'http://localhost:5176',
        changeOrigin: true,
        rewrite: () => '/health',
      },
      '/ops-health/prompt-composer': {
        target: 'http://localhost:3004',
        changeOrigin: true,
        rewrite: () => '/health',
      },
      '/ops-health/context-api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        rewrite: () => '/health',
      },
      '/ops-health/llm-gateway': {
        target: 'http://localhost:8001',
        changeOrigin: true,
        rewrite: () => '/health',
      },
      '/ops-health/context-memory': {
        target: 'http://localhost:8002',
        changeOrigin: true,
        rewrite: () => '/health',
      },
      '/ops-health/metrics-ledger': {
        target: 'http://localhost:8003',
        changeOrigin: true,
        rewrite: () => '/health',
      },
      '/ops-health/agent-service': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        rewrite: () => '/health',
      },
      '/ops-health/tool-service': {
        target: 'http://localhost:3002',
        changeOrigin: true,
        rewrite: () => '/health',
      },
      '/ops-health/agent-runtime': {
        target: 'http://localhost:3003',
        changeOrigin: true,
        rewrite: () => '/health',
      },
      '/ops-health/mcp-server': {
        target: 'http://localhost:7100',
        changeOrigin: true,
        rewrite: () => '/health',
      },
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
      '/api/mcp': {
        target: 'http://localhost:7100',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/mcp/, ''),
      },
      // Agent-runtime / agent-service / tool-service (rare; mostly for debug)
      '/api/runtime': {
        target: 'http://localhost:3003',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/runtime/, '/api/v1'),
      },
      // Audit & Governance (Singularity Engine)
      '/api/gov': {
        target: 'http://localhost:8500',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/gov/, '/api/v1'),
      },
      '/ops-health/audit-governance': {
        target: 'http://localhost:8500',
        changeOrigin: true,
        rewrite: () => '/health',
      },
    },
  },
})
