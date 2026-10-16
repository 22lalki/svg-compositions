import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * В dev /api/annotate обслуживает та же функция, что на Vercel (api/annotate.ts),
 * чтобы ИИ-разметка своих SVG работала локально с ключом из .env.local.
 */
function apiInDev(): Plugin {
  return {
    name: 'api-in-dev',
    configureServer(server) {
      server.middlewares.use('/api/annotate', async (req, res) => {
        try {
          const mod = (await server.ssrLoadModule('/api/annotate.ts')) as { POST: (r: Request) => Promise<Response> }
          const chunks: Buffer[] = []
          for await (const chunk of req) chunks.push(chunk as Buffer)
          const request = new Request('http://localhost/api/annotate', {
            method: req.method,
            headers: { 'content-type': req.headers['content-type'] ?? 'application/json' },
            body: req.method === 'POST' ? Buffer.concat(chunks) : undefined,
          })
          const response = await mod.POST(request)
          res.statusCode = response.status
          response.headers.forEach((value, key) => res.setHeader(key, value))
          res.end(Buffer.from(await response.arrayBuffer()))
        } catch (error) {
          console.error(error)
          res.statusCode = 500
          res.end(JSON.stringify({ error: 'internal' }))
        }
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  // Ключ для локальной ИИ-разметки: ANTHROPIC_API_KEY в .env.local (в репозиторий не попадает)
  const env = loadEnv(mode, process.cwd(), '')
  if (env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY
  return {
    plugins: [react(), tailwindcss(), apiInDev()],
    server: {
      // Сценарии пишут сюда SVG/PNG/видео — dev-страница не должна из-за этого перезагружаться
      watch: { ignored: ['**/examples/**', '**/scripts/**'] },
    },
  }
})
