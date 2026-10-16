// Инструмент разметки логических объектов встроенных исходников (dev-сервер должен работать).
//
//   node scripts/annotate.mjs render 02 07     — картинки для разметчика: номера фигур и текущая эвристика
//                                               (scripts/.out/ann/<id>-shapes.png, -heuristic.png, -shapes.txt)
//   node scripts/annotate.mjs check 02 07      — проверить разметку из public/sources/objects.json:
//                                               каждая фигура ровно в одном объекте; картинка <id>-final.png
//   node scripts/annotate.mjs check-draft 02   — то же для черновика scripts/.out/ann/<id>.json
import { chromium } from 'playwright'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT = path.join(ROOT, 'scripts', '.out', 'ann')
const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
mkdirSync(OUT, { recursive: true })

const [cmd, ...ids] = process.argv.slice(2)
if (!['render', 'check', 'check-draft'].includes(cmd) || ids.length === 0) {
  console.log('usage: node scripts/annotate.mjs render|check|check-draft <id...>')
  process.exit(1)
}

/** "9-22,25" → [9..22, 25] */
export function parseShapes(spec) {
  if (Array.isArray(spec)) return spec
  return String(spec)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((part) => {
      const [a, b] = part.split('-').map(Number)
      return b === undefined ? [a] : Array.from({ length: b - a + 1 }, (_, k) => a + k)
    })
}

const PALETTE = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#bfef45', '#469990', '#9A6324', '#800000', '#808000', '#000075', '#ffe119', '#fabed4', '#dcbeff', '#aaffc3', '#ffd8b1', '#a9a9a9', '#000000']

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1900, height: 1500 } })
await page.goto(`${BASE}/verify.html?idle`)
await page.waitForFunction(() => document.title === 'verify: done', null, { timeout: 180_000 })

for (const id of ids) {
  let objects = null
  if (cmd === 'check') {
    const all = JSON.parse(readFileSync(path.join(ROOT, 'public', 'sources', 'objects.json'), 'utf8'))
    objects = all[id]?.objects
  } else if (cmd === 'check-draft') {
    const file = path.join(OUT, `${id}.json`)
    if (!existsSync(file)) {
      console.log(`${id}: нет черновика ${file}`)
      continue
    }
    objects = JSON.parse(readFileSync(file, 'utf8')).objects
  }
  const parsed = objects?.map((o) => ({ name: o.name, shapes: parseShapes(o.shapes) })) ?? null

  const result = await page.evaluate(
    async ({ id, parsed, palette }) => {
      const { analyzeSource } = await import('/src/lib/extract.ts')
      const { detectObjects } = await import('/src/lib/objects.ts')
      const text = await fetch(`/sources/${id}.svg`).then((r) => r.text())
      const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
      const svg = document.importNode(doc.documentElement, true)
      const vb0 = svg.viewBox.baseVal
      const k = Math.min(1800 / vb0.width, 1400 / vb0.height)
      const W = Math.round(vb0.width * k)
      const H = Math.round(vb0.height * k)
      svg.setAttribute('width', W)
      svg.setAttribute('height', H)
      const host = document.getElementById('host')
      host.style.cssText = `position:relative;width:${W}px;height:${H}px;background:#fff`
      host.replaceChildren(svg)
      const model = analyzeSource(svg, { id, title: '', originalName: '', kind: 'builtin' })
      const vb = model.viewBox
      const toPx = (p) => ({ x: ((p.x - vb.x) / vb.width) * W, y: ((p.y - vb.y) / vb.height) * H })
      const NS = 'http://www.w3.org/2000/svg'
      const groups = parsed ?? detectObjects(model).map((shapes, n) => ({ name: String(n), shapes }))

      // Проверка разбиения
      const seen = new Map()
      const problems = []
      groups.forEach((g, n) =>
        g.shapes.forEach((i) => {
          if (i < 0 || i >= model.shapes.length) problems.push(`объект «${g.name}»: нет фигуры ${i}`)
          else if (seen.has(i)) problems.push(`фигура ${i} в двух объектах: «${groups[seen.get(i)].name}» и «${g.name}»`)
          else seen.set(i, n)
        }),
      )
      const missing = model.shapes.map((s) => s.index).filter((i) => !seen.has(i))
      if (missing.length) problems.push(`без объекта: ${missing.join(',')}`)

      const overlay = document.createElementNS(NS, 'svg')
      overlay.setAttribute('width', W)
      overlay.setAttribute('height', H)
      overlay.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;font:600 13px Segoe UI,sans-serif'
      host.appendChild(overlay)
      const label = (x, y, text, color) => {
        const t = document.createElementNS(NS, 'text')
        t.setAttribute('x', x)
        t.setAttribute('y', y)
        t.setAttribute('text-anchor', 'middle')
        t.setAttribute('dominant-baseline', 'middle')
        t.setAttribute('fill', color)
        t.setAttribute('stroke', '#fff')
        t.setAttribute('stroke-width', '3')
        t.setAttribute('paint-order', 'stroke')
        t.textContent = text
        overlay.appendChild(t)
      }
      const shots = {}

      if (!parsed) {
        // 1) номера фигур поверх оригинала
        for (const s of model.shapes) {
          const pts = s.outline.map(toPx)
          const poly = document.createElementNS(NS, 'polygon')
          poly.setAttribute('points', pts.map((p) => `${p.x},${p.y}`).join(' '))
          poly.setAttribute('fill', 'none')
          poly.setAttribute('stroke', 'rgba(220,0,0,.35)')
          overlay.appendChild(poly)
          const c = toPx({ x: s.bbox.x + s.bbox.width / 2, y: s.bbox.y + s.bbox.height / 2 })
          label(c.x, c.y, String(s.index), '#c00')
        }
        shots.shapes = true
      }
      return { W, H, problems, count: model.shapes.length, groups: groups.map((g) => ({ name: g.name, shapes: g.shapes })),
        rows: model.shapes.map((s) => {
          let top = s.el.parentElement
          const chain = []
          while (top && top !== svg && top !== model.wrapper) { chain.push(top.getAttribute('transform')?.slice(0, 24) ?? 'g'); top = top.parentElement }
          const b = s.bbox
          return `${s.index}\t${s.el.localName}\t${s.el.getAttribute('fill') ?? s.el.getAttribute('style') ?? ''}\t${[b.x, b.y, b.x + b.width, b.y + b.height].map((v) => Math.round(v)).join(',')}\t${chain.length ? 'group:' + chain.reverse().join(' > ') : ''}`
        }) }
    },
    { id, parsed, palette: PALETTE },
  )

  if (!parsed) {
    await page.locator('#host').screenshot({ path: path.join(OUT, `${id}-shapes.png`) })
    writeFileSync(path.join(OUT, `${id}-shapes.txt`), `# ${id}: ${result.count} фигур (index, tag, fill, bbox x0,y0,x1,y1 в координатах viewBox, группа в исходнике)\n${result.rows.join('\n')}\n`)
  }

  // Картинка объектов: перекраска фигур по объектам + подписи
  await page.evaluate(
    async ({ id, groups, palette }) => {
      const { analyzeSource } = await import('/src/lib/extract.ts')
      const text = await fetch(`/sources/${id}.svg`).then((r) => r.text())
      const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
      const svg = document.importNode(doc.documentElement, true)
      const host = document.getElementById('host')
      const W = parseFloat(host.style.width)
      const H = parseFloat(host.style.height)
      svg.setAttribute('width', W)
      svg.setAttribute('height', H)
      host.replaceChildren(svg)
      const model = analyzeSource(svg, { id, title: '', originalName: '', kind: 'builtin' })
      const vb = model.viewBox
      const toPx = (p) => ({ x: ((p.x - vb.x) / vb.width) * W, y: ((p.y - vb.y) / vb.height) * H })
      groups.forEach((g, n) => {
        const color = palette[n % palette.length]
        for (const i of g.shapes) {
          const el = model.shapes[i]?.el
          if (!el) continue
          if (el.getAttribute('fill') !== 'none') el.setAttribute('fill', color)
          if (el.getAttribute('stroke')) el.setAttribute('stroke', color)
          el.setAttribute('fill-opacity', '0.8')
        }
      })
      const NS = 'http://www.w3.org/2000/svg'
      const overlay = document.createElementNS(NS, 'svg')
      overlay.setAttribute('width', W)
      overlay.setAttribute('height', H)
      overlay.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;font:700 15px Segoe UI,sans-serif'
      host.appendChild(overlay)
      groups.forEach((g, n) => {
        const boxes = g.shapes.map((i) => model.shapes[i]?.bbox).filter(Boolean)
        if (!boxes.length) return
        const x0 = Math.min(...boxes.map((b) => b.x))
        const y0 = Math.min(...boxes.map((b) => b.y))
        const x1 = Math.max(...boxes.map((b) => b.x + b.width))
        const y1 = Math.max(...boxes.map((b) => b.y + b.height))
        const a = toPx({ x: x0, y: y0 })
        const b = toPx({ x: x1, y: y1 })
        const color = palette[n % palette.length]
        const r = document.createElementNS(NS, 'rect')
        r.setAttribute('x', a.x)
        r.setAttribute('y', a.y)
        r.setAttribute('width', b.x - a.x)
        r.setAttribute('height', b.y - a.y)
        r.setAttribute('fill', 'none')
        r.setAttribute('stroke', color)
        r.setAttribute('stroke-dasharray', '6 4')
        overlay.appendChild(r)
        const t = document.createElementNS(NS, 'text')
        t.setAttribute('x', a.x + 4)
        t.setAttribute('y', a.y + 16)
        t.setAttribute('fill', color)
        t.setAttribute('stroke', '#fff')
        t.setAttribute('stroke-width', '4')
        t.setAttribute('paint-order', 'stroke')
        t.textContent = `${n}: ${g.name}`
        overlay.appendChild(t)
      })
    },
    { id, groups: result.groups, palette: PALETTE },
  )
  const suffix = cmd === 'render' ? 'heuristic' : cmd === 'check' ? 'final' : 'draft'
  await page.locator('#host').screenshot({ path: path.join(OUT, `${id}-${suffix}.png`) })
  console.log(`${id}: ${result.count} фигур, объектов ${result.groups.length}${result.problems.length ? ' — ПРОБЛЕМЫ: ' + result.problems.join('; ') : ''}`)
}
await browser.close()
