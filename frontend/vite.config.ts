import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: true,
    proxy: {
      // OAuth endpoints are served by the Go backend; /oauth/authorize is the React SPA
      '/.well-known': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        bypass: (req) => req.url?.includes('com.chrome.devtools') ? req.url : undefined,
      },
      '/oauth/register': { target: 'http://localhost:8080', changeOrigin: true },
      '/oauth/token': { target: 'http://localhost:8080', changeOrigin: true },
    },
  },
})
