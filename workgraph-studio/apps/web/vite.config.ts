import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  // M100 P1 — single-origin support. When served behind the edge gateway under
  // a path prefix (e.g. /workflow/), the build sets BASE_PATH so all asset and
  // API URLs are namespaced. Defaults to '/' so the standalone :5174 build is
  // unchanged.
  base: process.env.BASE_PATH ?? '/',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      'next/navigation': path.resolve(__dirname, './src/lib/nextNavigationCompat.ts'),
    },
  },
  server: {
    port: 5174,
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
