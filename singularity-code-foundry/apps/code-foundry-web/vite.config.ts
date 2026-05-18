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
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
})
