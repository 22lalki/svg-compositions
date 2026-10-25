// Примеры композиций режима «Композиции» через настоящий интерфейс: сценарий, формат, схема → SVG и PNG в examples/.
// Запуск: npm run dev (в соседнем терминале), затем node scripts/compose-examples.mjs
import { chromium } from 'playwright'
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const OUT = path.resolve(process.env.EXAMPLES_DIR ?? 'examples')
mkdirSync(OUT, { recursive: true })

const EXAMPLES = [
  { file: 'compose-1-finance', tab: 'metaphor', text: 'Финансовая грамотность', format: 'square', size: 'L', scheme: 'violet' },
  { file: 'compose-2-startup', tab: 'metaphor', text: 'Идея для стартапа', format: 'wide', size: 'L', scheme: 'orange' },
  { file: 'compose-3-music', tab: 'names', text: 'наушники, телефон', format: 'tall', size: 'L', scheme: 'teal' },
]

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1600, height: 950 }, acceptDownloads: true })
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.goto(BASE)
await page.waitForSelector('[data-testid=compose]')

for (const ex of EXAMPLES) {
  // Сначала формат и размер: раскладка подбирается под них
  await page.click(`[data-testid=size] [data-value=${ex.size}]`)
  await page.click(`[data-testid=format] [data-value=${ex.format}]`)
  await page.click(`[role=tab]:has-text("${ex.tab === 'metaphor' ? 'По метафоре' : 'По объектам'}")`)
  await page.fill(`[data-testid=${ex.tab === 'metaphor' ? 'metaphor-input' : 'names-input'}]`, ex.text)
  await page.click('[data-testid=compose]')
  await page.click(`[data-scheme=${ex.scheme}]`)
  await page.waitForTimeout(400)
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-testid=export]')])
  const target = path.join(OUT, `${ex.file}.svg`)
  await download.saveAs(target)
  const svg = readFileSync(target, 'utf8')
  const why = await page.textContent('[data-testid=explanation]')
  const p = await browser.newPage({ viewport: { width: 1200, height: 1200 } })
  await p.setContent(`<body style="margin:0">${svg}</body>`)
  await p.locator('svg').first().screenshot({ path: path.join(OUT, `${ex.file}.png`) })
  await p.close()
  console.log(`${ex.file}: «${ex.text}» → ${why}`)
}
console.log(errors.length ? `Ошибки: ${errors.join('; ')}` : 'Без ошибок')
await browser.close()
process.exit(errors.length ? 1 : 0)
