// Самопроверка режима «Композиции»: раскладки примеров, смена формата и размера, правила схемы, загрузка.
// Запуск: npm run dev (в соседнем терминале), затем node scripts/verify-compose.mjs
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://localhost:5173'

const browser = await chromium.launch()
const page = await browser.newPage()
page.on('pageerror', (e) => console.error('pageerror:', e.message))
await page.goto(`${BASE}/compose-verify.html`)
await page.waitForFunction(() => document.title === 'verify: done', null, { timeout: 300_000 })
const results = await page.evaluate(() => window.__verify)
await browser.close()

let failed = 0
let group = ''
for (const r of results) {
  if (r.group !== group) {
    group = r.group
    console.log(`\n${group}`)
  }
  if (!r.ok) failed++
  console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : `\n       ${String(r.detail).split('\n').join('\n       ')}`}`)
}
console.log(failed ? `\n${failed} из ${results.length} проверок не прошли` : `\nВсе ${results.length} проверок пройдены`)
process.exit(failed ? 1 : 0)
