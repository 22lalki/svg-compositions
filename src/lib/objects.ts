import type { SourceModel, SourceShape } from './extract'
import { listShapes } from './extract'

/**
 * Логические объекты исходника (персонаж, животное, предмет) для выделения одним кликом.
 *
 * 1. Группа верхнего уровня — готовый объект: в unDraw персонажи и животные часто сгруппированы
 *    (девушка, собака и косточка в 02, мужчина в 07, девушка и пес в 04). Группа почти со всеми фигурами
 *    рисунка (≥ 85%, как обертка из Figma) считается контейнером, объекты ищутся внутри нее.
 * 2. Плоские фигуры собираются в прогоны: иллюстрацию рисуют объект за объектом, поэтому фигура
 *    продолжает текущий прогон, если касается его по реальной форме (растровые маски с допуском).
 * 3. Обрывки (до 3 фигур: шапка, ботинки, арка колеса) присоединяются к соседнему по порядку объекту,
 *    которого касаются, — если между ними нет другого полноценного объекта. Деталь, целиком лежащая
 *    на объекте (звезды в окне, глаз собаки), присоединяется к нему на любом расстоянии.
 * 4. Прогоны, нарисованные вперемешку (рука, торс, брюки, снова рука) и касающиеся друг друга, — один объект.
 * 5. Фон (земля во всю ширину, подложка почти на весь рисунок) — всегда отдельный объект.
 */

const MASK_SIZE = 360 // длинная сторона растра для масок
const ALPHA_MIN = 40
/** Допуск касания в пикселях растра (~1,4% рисунка): стекла окна за тонкой рамкой — один объект */
const TOUCH_TOL = 5

type Mask = { x0: number; y0: number; w: number; h: number; data: Uint8Array; count: number }

type Cluster = {
  shapes: number[]
  group: boolean
  background: boolean
  /** Детали, присоединенные как лежащие поверх (звезды в окне, снег на елке): не растягивают объект по порядку */
  overlays: Set<number>
}

function shapePath(el: SVGGeometryElement): Path2D | null {
  const p = new Path2D()
  switch (el.localName) {
    case 'path':
      return new Path2D(el.getAttribute('d') ?? '')
    case 'rect': {
      const r = el as SVGRectElement
      p.rect(r.x.baseVal.value, r.y.baseVal.value, r.width.baseVal.value, r.height.baseVal.value)
      return p
    }
    case 'circle': {
      const c = el as SVGCircleElement
      p.arc(c.cx.baseVal.value, c.cy.baseVal.value, c.r.baseVal.value, 0, Math.PI * 2)
      return p
    }
    case 'ellipse': {
      const e = el as SVGEllipseElement
      p.ellipse(e.cx.baseVal.value, e.cy.baseVal.value, e.rx.baseVal.value, e.ry.baseVal.value, 0, 0, Math.PI * 2)
      return p
    }
    case 'polygon':
    case 'polyline': {
      const pts = Array.from((el as SVGPolygonElement).points)
      pts.forEach((pt, i) => (i ? p.lineTo(pt.x, pt.y) : p.moveTo(pt.x, pt.y)))
      if (el.localName === 'polygon') p.closePath()
      return p
    }
    case 'line': {
      const l = el as SVGLineElement
      p.moveTo(l.x1.baseVal.value, l.y1.baseVal.value)
      p.lineTo(l.x2.baseVal.value, l.y2.baseVal.value)
      return p
    }
  }
  return null
}

/** Растровые маски фигур в общей сетке (координаты корня → пиксели) */
function buildMasks(model: SourceModel): Mask[] {
  const vb = model.viewBox
  const s = MASK_SIZE / Math.max(vb.width, vb.height)
  const W = Math.ceil(vb.width * s) + 2
  const H = Math.ceil(vb.height * s) + 2
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  return model.shapes.map((shape) => {
    const empty: Mask = { x0: 0, y0: 0, w: 0, h: 0, data: new Uint8Array(0), count: 0 }
    const path = shapePath(shape.el)
    if (!path) return empty
    const cs = getComputedStyle(shape.el)
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return empty
    const b = shape.bbox
    const x0 = Math.max(0, Math.floor((b.x - vb.x) * s))
    const y0 = Math.max(0, Math.floor((b.y - vb.y) * s))
    const x1 = Math.min(W, Math.ceil((b.x + b.width - vb.x) * s) + 3)
    const y1 = Math.min(H, Math.ceil((b.y + b.height - vb.y) * s) + 3)
    if (x1 <= x0 || y1 <= y0) return empty
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(x0, y0, x1 - x0, y1 - y0)
    const m = shape.matrix
    ctx.setTransform(s * m[0], s * m[1], s * m[2], s * m[3], s * (m[4] - vb.x) + 1, s * (m[5] - vb.y) + 1)
    ctx.fillStyle = '#000'
    ctx.strokeStyle = '#000'
    if (cs.fill !== 'none' && parseFloat(cs.fillOpacity) !== 0) ctx.fill(path, cs.fillRule === 'evenodd' ? 'evenodd' : 'nonzero')
    const sw = parseFloat(cs.strokeWidth) || 0
    if (cs.stroke !== 'none' && sw > 0) {
      ctx.lineWidth = sw
      ctx.stroke(path)
    }
    const img = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data
    const data = new Uint8Array((x1 - x0) * (y1 - y0))
    let count = 0
    for (let i = 0; i < data.length; i++) {
      if (img[i * 4 + 3]! > ALPHA_MIN) {
        data[i] = 1
        count++
      }
    }
    return { x0, y0, w: x1 - x0, h: y1 - y0, data, count }
  })
}

const at = (m: Mask, x: number, y: number) =>
  x >= m.x0 && y >= m.y0 && x < m.x0 + m.w && y < m.y0 + m.h && m.data[(y - m.y0) * m.w + (x - m.x0)] === 1

const dilatedCache = new WeakMap<Mask, Mask>()

/** Маска, расширенная на r пикселей во все стороны (раздельный max-фильтр) */
function dilated(m: Mask, r = TOUCH_TOL): Mask {
  const cached = dilatedCache.get(m)
  if (cached) return cached
  const w = m.w + 2 * r
  const h = m.h + 2 * r
  const horiz = new Uint8Array(w * h)
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      if (!m.data[y * m.w + x]) continue
      const row = (y + r) * w
      for (let dx = 0; dx <= 2 * r; dx++) horiz[row + x + dx] = 1
    }
  }
  const data = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!horiz[y * w + x]) continue
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy
        if (yy >= 0 && yy < h) data[yy * w + x] = 1
      }
    }
  }
  const out = { x0: m.x0 - r, y0: m.y0 - r, w, h, data, count: m.count }
  dilatedCache.set(m, out)
  return out
}

/** Касаются ли формы (с допуском TOUCH_TOL пикселей растра) */
function touches(a: Mask, b: Mask): boolean {
  if (!a.count || !b.count) return false
  const da = dilated(a)
  const x0 = Math.max(da.x0, b.x0)
  const y0 = Math.max(da.y0, b.y0)
  const x1 = Math.min(da.x0 + da.w, b.x0 + b.w)
  const y1 = Math.min(da.y0 + da.h, b.y0 + b.h)
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (at(b, x, y) && at(da, x, y)) return true
    }
  }
  return false
}

/** Доля пикселей формы x, закрытых фигурами набора */
function coverage(x: Mask, shapes: Mask[]): number {
  if (!x.count) return 0
  let covered = 0
  for (let yy = 0; yy < x.h; yy++) {
    for (let xx = 0; xx < x.w; xx++) {
      if (!x.data[yy * x.w + xx]) continue
      const px = x.x0 + xx
      const py = x.y0 + yy
      if (shapes.some((m) => at(m, px, py))) covered++
    }
  }
  return covered / x.count
}

function isBackground(shape: SourceShape, model: SourceModel): boolean {
  const { width: W, height: H } = model.viewBox
  const b = shape.bbox
  return (
    (b.width >= 0.9 * W && b.height <= 0.25 * H) ||
    (b.height >= 0.9 * H && b.width <= 0.25 * W) ||
    b.width * b.height >= 0.7 * W * H
  )
}

/** Единицы: атомарные группы и отдельные плоские фигуры, в порядке документа */
function collectUnits(model: SourceModel): Array<{ shapes: number[]; group: boolean }> {
  const total = model.shapes.length
  const units: Array<{ shapes: number[]; group: boolean }> = []
  const walk = (container: Element) => {
    for (const child of Array.from(container.children)) {
      const index = model.shapeIndex.get(child)
      if (index !== undefined) {
        units.push({ shapes: [index], group: false })
        continue
      }
      const inside = listShapes(child)
        .map((el) => model.shapeIndex.get(el))
        .filter((i): i is number => i !== undefined)
      if (inside.length === 0) continue
      if (inside.length >= total * 0.85 && inside.length > 1) walk(child) // контейнер всего рисунка, а не объект
      else if (inside.length === 1) units.push({ shapes: inside, group: false })
      else units.push({ shapes: inside, group: true })
    }
  }
  walk(model.wrapper ?? model.svg)
  return units
}

export function detectObjects(model: SourceModel): number[][] {
  const masks = buildMasks(model)
  const clusters: Cluster[] = []
  let current: Cluster | null = null

  // 1–2, 5: группы, фон и прогоны в порядке документа
  for (const unit of collectUnits(model)) {
    if (unit.group) {
      clusters.push({ shapes: unit.shapes, group: true, background: false, overlays: new Set() })
      current = null
      continue
    }
    const i = unit.shapes[0]!
    if (isBackground(model.shapes[i]!, model)) {
      clusters.push({ shapes: [i], group: false, background: true, overlays: new Set() })
      continue
    }
    if (current && current.shapes.some((j) => touches(masks[j]!, masks[i]!))) {
      current.shapes.push(i)
      continue
    }
    current = { shapes: [i], group: false, background: false, overlays: new Set() }
    clusters.push(current)
  }

  const alive = (c: Cluster) => clusters.includes(c)
  const area = (c: Cluster) => c.shapes.reduce((sum, i) => sum + masks[i]!.count, 0)
  /** Фигуры объекта без далеких по порядку деталей «поверх» (снег на елке не растягивает елку до человека) */
  const own = (c: Cluster) => {
    const core = c.shapes.filter((i) => !c.overlays.has(i))
    const [lo, hi] = [Math.min(...core), Math.max(...core)]
    return c.shapes.filter((i) => !c.overlays.has(i) || (i >= lo - 8 && i <= hi + 8))
  }
  const span = (c: Cluster) => {
    const core = own(c)
    return [Math.min(...core), Math.max(...core)] as const
  }
  const touching = (a: Cluster, b: Cluster) => a.shapes.some((i) => b.shapes.some((j) => touches(masks[j]!, masks[i]!)))
  const gap = (a: Cluster, b: Cluster) => Math.min(...own(a).flatMap((i) => own(b).map((j) => Math.abs(i - j))))
  const merge = (into: Cluster, from: Cluster, asOverlay: boolean) => {
    into.shapes.push(...from.shapes)
    for (const i of from.shapes) if (asOverlay || from.overlays.has(i)) into.overlays.add(i)
    clusters.splice(clusters.indexOf(from), 1)
  }
  /** Между a и b по порядку нет другого полноценного (2+ фигуры) объекта */
  const neighbors = (a: Cluster, b: Cluster) => {
    const [lo, hi] = span(a)[0] < span(b)[0] ? [span(a)[1], span(b)[0]] : [span(b)[1], span(a)[0]]
    return !clusters.some((c) => c !== a && c !== b && !c.background && own(c).length >= 2 && span(c)[0] > lo && span(c)[1] < hi)
  }

  const interleaved = (a: Cluster, b: Cluster) => {
    const [lo, hi] = span(a)
    return own(b).some((j) => j > lo && j < hi)
  }

  // 3–4 повторяем, пока что-то склеивается: после слияния торса и брюк к ним может прилипнуть ботинок
  for (let merged = true; merged; ) {
    merged = false
    // 3: обрывки — по одному, от меньших к большим
    const pieces = clusters.filter((c) => !c.group && !c.background && c.shapes.length <= 3).sort((a, b) => area(a) - area(b))
    for (const piece of pieces) {
      const mid = (span(piece)[0] + span(piece)[1]) / 2
      let best: { target: Cluster; gap: number; overlay: boolean } | null = null
      for (const target of clusters) {
        if (target === piece || target.background || !alive(target)) continue
        // Деталь целиком на объекте — к нему, на любом расстоянии
        if (area(piece) <= area(target) && coverage(masks[piece.shapes[0]!]!, target.shapes.map((j) => masks[j]!)) >= 0.8) {
          const g = gap(piece, target)
          if (!best || (best.overlay && g < best.gap)) best = { target, gap: g, overlay: true }
          continue
        }
        if (best?.overlay || area(piece) > 2 * area(target)) continue
        const g = gap(piece, target)
        if (g > 12 || !neighbors(piece, target) || !touching(piece, target)) continue
        // При равном расстоянии — объект, нарисованный после: unDraw рисует снизу вверх (ботинки, ноги, туловище)
        const later = (c: Cluster) => (span(c)[0] + span(c)[1]) / 2 > mid
        if (!best || g < best.gap || (g === best.gap && later(target) && !later(best.target))) best = { target, gap: g, overlay: false }
      }
      if (best) {
        merge(best.target, piece, best.overlay)
        merged = true
        break
      }
    }
    if (merged) continue
    // 4: прогоны вперемешку
    const runs = clusters.filter((c) => !c.group && !c.background)
    outer: for (const a of runs) {
      for (const b of runs) {
        if (a === b || !(interleaved(a, b) || interleaved(b, a)) || !touching(a, b)) continue
        merge(a, b, false)
        merged = true
        break outer
      }
    }
  }

  return clusters.map((c) => [...c.shapes].sort((a, b) => a - b))
}
