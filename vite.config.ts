import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Сценарии пишут сюда SVG/PNG/видео — dev-страница не должна из-за этого перезагружаться
    watch: { ignored: ['**/examples/**', '**/scripts/**'] },
  },
})
