import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'

// The UI lives in ui/, builds to dist/ui, and proxies /api to the backend
// during development.
export default defineConfig({
  root: 'ui',
  plugins: [solid()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4000',
    },
  },
  build: {
    outDir: '../dist/ui',
    emptyOutDir: true,
  },
})
