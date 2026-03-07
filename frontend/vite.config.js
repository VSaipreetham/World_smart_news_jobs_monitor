import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0', // listen on all interfaces for Docker
    proxy: {
      '/api': {
        target: 'http://localhost:8000', // When running locally
        changeOrigin: true
      }
    }
  }
})
