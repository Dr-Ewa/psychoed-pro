import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api/chat': {
        target: 'https://api.openai.com',
        changeOrigin: true,
        rewrite: () => '/v1/chat/completions',
      },
    },
  },
})
