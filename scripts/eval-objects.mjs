// Оценка эвристики логических объектов (src/lib/objects.ts) по эталонной разметке public/sources/objects.json.
// Запуск при работающем dev-сервере: node scripts/eval-objects.mjs [--upload] [--detail 07 11]
//   --upload — файлы проходят тот же путь, что и загрузка пользователем (очистка и нормализация importSvg.ts)
//   клик  — доля площади рисунка, где клик выделяет ровно эталонный объект;
//   IoU   — среднее по эталонным объектам совпадение с лучшим объектом эвристики (по площади фигур).
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const args = process.argv.slice(2)
const detail = args.includes('--detail') ? args.slice(args.indexOf('--detail') + 1) : []
const upload = args.includes('--upload')

const browser = await chromium.launch()
const page = await browser.newPage()
await page.goto(`${BASE}/verify.html?idle`)
await page.waitForFunction(() => document.title === 'verify: done')
const results = await page.evaluate(async ([detail, upload]) => {
  const { analyzeSource } = await import('/src/lib/extract.ts')
  const { detectObjects, shapeAreas } = await import('/src/lib/objects.ts')
  const { parseShapeRanges } = await import('/src/lib/sources.ts')
  const { prepareSvgText } = await import('/src/lib/importSvg.ts')
  const truthAll = await fetch('/sources/objects.json').then((r) => r.json())
  const out = []
  for (const id of Object.keys(truthAll).sort()) {
    const raw = await fetch(`/sources/${id}.svg`).then((r) => r.text())
    const text = upload ? prepareSvgText(raw).svgText : raw
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
    const svg = document.importNode(doc.documentElement, true)
    svg.style.cssText = 'width:400px;height:400px'
    document.getElementById('host').replaceChildren(svg)
    const model = analyzeSource(svg, { id, title: '', originalName: '', kind: upload ? 'user' : 'builtin' })
    if (model.shapes.length !== truthAll[id].shapeCount) throw new Error(`${id}: ${model.shapes.length} фигур вместо ${truthAll[id].shapeCount}`)
    const area = shapeAreas(model).map((a) => Math.max(a, 1))
    const truth = truthAll[id].objects.map((o) => ({ name: o.name, shapes: parseShapeRanges(o.shapes) }))
    const pred = detectObjects(model)
    const tOf = new Map()
    truth.forEach((o, k) => o.shapes.forEach((i) => tOf.set(i, k)))
    const pOf = new Map()
    pred.forEach((c, k) => c.forEach((i) => pOf.set(i, k)))
    const sum = (list) => list.reduce((n, i) => n + area[i], 0)
    const total = sum(model.shapes.map((s) => s.index))
    // клик: фигура i выделит pred[pOf(i)]; верно, если это ровно эталонный объект
    let clickOk = 0
    for (const s of model.shapes) {
      const t = truth[tOf.get(s.index)]?.shapes ?? [s.index]
      const p = pred[pOf.get(s.index)] ?? [s.index]
      if (t.length === p.length && t.every((i) => p.includes(i))) clickOk += area[s.index]
    }
    // IoU: для каждого эталонного объекта — лучший объект эвристики
    const ious = truth.map((o) => {
      const set = new Set(o.shapes)
      let best = 0
      let bestK = -1
      pred.forEach((c, k) => {
        const inter = sum(c.filter((i) => set.has(i)))
        if (!inter) return
        const union = sum([...new Set([...c, ...o.shapes])])
        if (inter / union > best) {
          best = inter / union
          bestK = k
        }
      })
      return { name: o.name, iou: best, bestK }
    })
    const row = { id, objects: truth.length, clusters: pred.length, click: clickOk / total, iou: ious.reduce((n, x) => n + x.iou, 0) / ious.length }
    if (detail.includes(id)) {
      row.detail = ious.map((x) => `${x.iou.toFixed(2)} ${x.name}: эталон [${truth.find((o) => o.name === x.name).shapes.join(',')}] / лучший [${pred[x.bestK]?.join(',') ?? '-'}]`)
      row.pred = pred.map((c) => c.join(','))
    }
    out.push(row)
  }
  return out
}, [detail, upload])
await browser.close()

console.log('src  объекты кластеры   клик    IoU')
for (const r of results) {
  console.log(`${r.id}   ${String(r.objects).padStart(4)} ${String(r.clusters).padStart(8)}   ${(r.click * 100).toFixed(0).padStart(4)}%  ${(r.iou * 100).toFixed(0).padStart(4)}%`)
  if (r.detail) {
    r.detail.forEach((d) => console.log(`      ${d}`))
    console.log(`      эвристика: ${r.pred.map((c) => `[${c}]`).join(' ')}`)
  }
}
const avg = (k) => results.reduce((n, r) => n + r[k], 0) / results.length
console.log(`\nСРЕДНЕЕ: клик ${(avg('click') * 100).toFixed(1)}%, IoU ${(avg('iou') * 100).toFixed(1)}%`)
