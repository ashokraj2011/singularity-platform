import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

// M100 P1 — single-origin support. Behind the edge gateway this app is mounted
// under /iam/ (BASE_PATH); base namespaces asset + API URLs. The dev proxy keys
// are prefix-aware so standalone `npm run dev` keeps working. Default '/'.
const BASE = process.env.BASE_PATH ?? '/'
const PREFIX = BASE.replace(/\/$/, '') // '' standalone, '/iam' behind gateway

export default defineConfig({
  base: BASE,
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    port: 5175,
    proxy: {
      [`${PREFIX}/api/wg`]: {
        target: 'http://localhost:8080',
        changeOrigin: true,
        rewrite: (p) => p.replace(new RegExp(`^${PREFIX}/api/wg`), '/api'),
      },
      [`${PREFIX}/api/cf`]: {
        target: 'http://localhost:8000',
        changeOrigin: true,
        rewrite: (p) => p.replace(new RegExp(`^${PREFIX}/api/cf`), ''),
      },
      [`${PREFIX}/api`]: {
        target: 'http://localhost:8100',
        changeOrigin: true,
        rewrite: (p) => (PREFIX ? p.replace(new RegExp(`^${PREFIX}`), '') : p),
      },
    },
  },
})
