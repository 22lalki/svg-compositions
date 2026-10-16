import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Заголовки безопасности продакшена (vercel.json) — и для `vite preview`, чтобы проверить сборку с ними локально
const vercel = JSON.parse(readFileSync(new URL('./vercel.json', import.meta.url), 'utf8')) as {
  headers: Array<{ headers: Array<{ key: string; value: string }> }>
}
const securityHeaders = Object.fromEntries(vercel.headers.flatMap((h) => h.headers.map((x) => [x.key, x.value])))

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Сценарии пишут сюда SVG и PNG — dev-страница не должна из-за этого перезагружаться
    watch: { ignored: ['**/examples/**', '**/scripts/**'] },
  },
  preview: { headers: securityHeaders },
})
