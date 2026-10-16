// Самопроверка извлечения компонентов: пиксельное сравнение компонента с оригиналом.
// Запуск: npm run dev (в соседнем терминале), затем node scripts/verify-extraction.mjs
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const MAX_DIFF_RATIO = 0.002 // допустимая доля отличающихся пикселей (сглаживание краев)

const browser = await chromium.launch()
const page = await browser.newPage()
page.on('pageerror', (e) => console.error('pageerror:', e.message))
await page.goto(`${BASE}/verify.html`)
await page.waitForFunction(() => document.title === 'verify: done', null, { timeout: 120_000 })
const results = await page.evaluate(() => window.__verify)
await browser.close()

let failed = 0
console.log('source          mode      shapes defs  size          diff px   ratio  clip  ids')
for (const r of results) {
  const ok = r.diffRatio <= MAX_DIFF_RATIO && r.outside === 0 && r.idsOk
  if (!ok) failed++
  console.log(
    `${r.source.padEnd(15)} ${r.mode.padEnd(9)} ${String(r.shapes).padStart(5)} ${String(r.defs).padStart(4)}  ` +
      `${`${r.width}×${r.height}`.padEnd(13)} ${String(r.diffPixels).padStart(7)}  ${r.diffRatio.toFixed(5)}  ${String(r.outside).padStart(4)}  ` +
      `${r.idsOk ? 'ok' : 'FAIL'}${ok ? '' : '   <-- FAIL'}`,
  )
}
console.log(failed ? `\n${failed} проверок не прошли` : `\nВсе ${results.length} проверок пройдены`)
process.exit(failed ? 1 : 0)
